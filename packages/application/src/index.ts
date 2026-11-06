import { auditRecordId, defineAudit, type AuditEvent } from "@pegma/audit";
import { hasPermission, type AccessContext } from "@pegma/authorization-core";
import { defineMail, maxMailAttempts, type MailJob } from "@pegma/mail";
import type { Clock, IsoTimestamp, Logger, PrincipalId } from "@pegma/spine";
import { noopLogger } from "@pegma/spine";
import {
  defineCollection,
  MAX_SCAN_PAGE_SIZE,
  type Codec,
  type CollectionStore,
  type EntityKey,
  type Store,
  type StoredRecord,
} from "@pegma/storage-core";
import type {
  InboundSenderAuthentication,
  MessageFormat,
  MessageId,
  RequesterAssociation,
  Ticket,
  TicketChannel,
  TicketId,
  TicketMessage,
  TicketPriority,
  TicketStatus,
} from "@pegma/support-desk-contracts";
import { applyTicketEvent, createTicket } from "@pegma/support-desk-core";

export type { InboundSenderAuthentication };

export const supportPermissions = Object.freeze({
  create: "support.ticket.create",
  readOwn: "support.ticket.read.own",
  replyOwn: "support.ticket.reply.own",
  queueRead: "support.queue.read",
  replyAny: "support.ticket.reply.any",
  note: "support.ticket.note",
  assign: "support.ticket.assign",
  manage: "support.ticket.manage",
  auditRead: "support.audit.read",
} as const);

export interface SupportDeskLimits {
  readonly maxSubjectCharacters: number;
  readonly maxMessageCharacters: number;
  readonly maxTicketsPerPrincipal: number;
  readonly maxMessagesPerTicket: number;
  /**
   * Hard cap on physical records in one ticket partition (ticket, messages,
   * audit, commands, delivery jobs, quota, reservation). Reads and mutations
   * fail closed when the partition would exceed this bound.
   */
  readonly maxRecordsPerTicket: number;
}

export const defaultSupportDeskLimits: SupportDeskLimits = Object.freeze({
  maxSubjectCharacters: 200,
  maxMessageCharacters: 20_000,
  maxTicketsPerPrincipal: 100,
  maxMessagesPerTicket: 100,
  maxRecordsPerTicket: 512,
});

export class SupportDeskAuthorizationError extends Error {
  constructor(readonly permission: string) {
    super(`Permission required: ${permission}`);
    this.name = "SupportDeskAuthorizationError";
  }
}

export class SupportDeskNotFoundError extends Error {
  constructor() {
    super("Ticket not found");
    this.name = "SupportDeskNotFoundError";
  }
}

export class SupportDeskConflictError extends Error {
  constructor(message = "The ticket changed before the command could commit") {
    super(message);
    this.name = "SupportDeskConflictError";
  }
}

/** Content-safe collision hint, available only after staff authorization. */
export class SupportDeskStaleRevisionError extends SupportDeskConflictError {
  constructor(
    readonly currentRevision: number,
    readonly updatedAt: IsoTimestamp,
  ) {
    super("The ticket changed since it was loaded");
    this.name = "SupportDeskStaleRevisionError";
  }
}

export interface ResponseTargets {
  readonly firstResponseDueAt?: IsoTimestamp;
  readonly resolutionDueAt?: IsoTimestamp;
}

/** Content-free facts; hosts own calendars, presence, and target calculation. */
export interface ResponseTargetContext extends ResponseTargets {
  readonly reason: "created" | "customer_replied" | "priority_changed";
  readonly ticketId: TicketId;
  readonly revision: number;
  readonly priority: TicketPriority;
  readonly category?: string;
  readonly channel: TicketChannel;
  readonly createdAt: IsoTimestamp;
  readonly occurredAt: IsoTimestamp;
  readonly firstStaffRespondedAt?: IsoTimestamp;
  readonly resolvedAt?: IsoTimestamp;
}

export interface ResponseTargetPolicy {
  /** Complete replacement of due timestamps. Must be safe to retry on conflicts. */
  computeTargets(
    context: ResponseTargetContext,
  ): ResponseTargets | Promise<ResponseTargets>;
}

export class SupportDeskLimitError extends Error {
  constructor(
    readonly field:
      | "subject"
      | "body"
      | "customer_tickets"
      | "ticket_messages"
      | "ticket_partition",
    readonly maximum: number,
  ) {
    super(`${field} exceeds the configured limit of ${maximum}`);
    this.name = "SupportDeskLimitError";
  }
}

/**
 * Staff queue online scan hit a configured materialization budget before the
 * projection scan cycle completed. Hosts map this to HTTP 503; never return a
 * partial queue page for this outcome.
 */
export class SupportDeskQueueCapacityError extends Error {
  constructor(
    readonly budget: "physical_rows" | "scan_pages" | "active_results",
    readonly maximum: number,
  ) {
    super(
      `Staff queue scan exhausted the ${budget} budget of ${maximum} before a complete cycle`,
    );
    this.name = "SupportDeskQueueCapacityError";
  }
}

export interface DeliveryJob {
  readonly kind: "delivery_job";
  readonly partition: TicketId;
  readonly id: string;
  readonly ticketId: TicketId;
  readonly messageId: MessageId;
  readonly job: MailJob;
}

export interface DeliveryContent {
  readonly templateId: string;
  readonly templateVersion: number;
  readonly variables: Readonly<Record<string, string>>;
  readonly subject: string;
  readonly outboundMessageId: string;
  /**
   * Optional host-minted opaque reply-routing token rendered into the reply
   * address. Indexed by SHA-256 in `support-desk.thread-index.v1`; never a
   * read capability and never logged.
   */
  readonly replyRoutingToken?: string;
}

function encodeIdempotencyPart(value: string): string {
  return encodeURIComponent(value).replaceAll(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

interface TicketRecord {
  readonly kind: "ticket";
  readonly partition: TicketId;
  readonly id: "ticket";
  readonly ticket: Ticket;
}

interface MessageRecord {
  readonly kind: "message";
  readonly partition: TicketId;
  readonly id: string;
  /**
   * The ticket revision committed by the same transaction as this message.
   * Legacy rows without one must be migrated before they can be returned.
   */
  readonly ordinal: number;
  readonly message: TicketMessage;
  /** Immutable Support-owned content resolved by the generic mail adapter. */
  readonly deliveryContent?: DeliveryContent | undefined;
}

interface AuditMemberRecord {
  readonly kind: "audit";
  readonly partition: TicketId;
  readonly id: string;
  readonly event: AuditEvent;
}

type SupportCommandType =
  | "create_customer_ticket"
  | "reply_customer_ticket"
  | "staff_reply"
  | "add_note"
  | "assign_ticket"
  | "change_priority"
  | "set_tags"
  | "resolve_ticket"
  | "close_ticket"
  | "reopen_ticket"
  | "inbound_email_create"
  | "inbound_email_reply";

interface CommandRecord {
  readonly kind: "command";
  readonly partition: TicketId;
  readonly id: string;
  readonly commandId: string;
  readonly commandType: SupportCommandType;
  /**
   * Present for message-producing commands. Absent for assign, priority, and
   * lifecycle commands that only mutate ticket state.
   */
  readonly messageId?: MessageId;
  readonly requestFingerprint: string;
  readonly completedAt: IsoTimestamp;
  /** New staff commands retain their result; messages are selected by revision. */
  readonly resultTicket?: Ticket;
}

interface InboundReplyRerouteFenceRecord {
  readonly kind: "inbound_reply_reroute_fence";
  readonly partition: TicketId;
  readonly id: string;
  readonly commandId: string;
  readonly messageId: MessageId;
  readonly requestFingerprint: string;
  readonly recordedAt: IsoTimestamp;
}

interface InboundCreateRerouteFenceRecord {
  readonly kind: "inbound_create_reroute_fence";
  readonly partition: TicketId;
  readonly id: string;
  readonly commandId: string;
  readonly messageId: MessageId;
  readonly requestFingerprint: string;
  readonly recordedAt: IsoTimestamp;
}

interface TicketQuotaRecord {
  readonly kind: "ticket_quota";
  readonly partition: TicketId;
  readonly id: "quota";
  readonly messageCount: number;
}

interface TicketReservationRecord {
  readonly kind: "ticket_reservation";
  readonly partition: TicketId;
  readonly id: "reservation";
  readonly token: string;
  readonly generation: number;
  readonly state: "committed" | "cancelled";
}

export type SupportRecord =
  | TicketRecord
  | TicketQuotaRecord
  | TicketReservationRecord
  | MessageRecord
  | AuditMemberRecord
  | CommandRecord
  | InboundReplyRerouteFenceRecord
  | InboundCreateRerouteFenceRecord
  | DeliveryJob;

/** Closed MVP registry of durable accepted-change audit action names. */
export const supportTicketAuditActions = Object.freeze({
  created: "support.ticket.created",
  customerReplied: "support.ticket.customer_replied",
  staffReplied: "support.ticket.staff_replied",
  noteAdded: "support.ticket.note_added",
  assigned: "support.ticket.assigned",
  unassigned: "support.ticket.unassigned",
  priorityChanged: "support.ticket.priority_changed",
  tagsChanged: "support.ticket.tags_changed",
  resolved: "support.ticket.resolved",
  closed: "support.ticket.closed",
  reopened: "support.ticket.reopened",
} as const);

export interface CustomerTicketIndexEntry {
  readonly ticketId: TicketId;
  readonly reservationToken: string;
  readonly reservationGeneration: number;
  readonly reservedAt: IsoTimestamp;
  readonly state: "reserved" | "confirmed";
}

export interface CustomerTicketIndexRecord {
  readonly principalId: PrincipalId;
  readonly entries: readonly CustomerTicketIndexEntry[];
}

export interface InboundReceipt {
  readonly bucket: string;
  /** Two-hex-digit slot derived with the bucket from a 128-bit digest. */
  readonly slot: string;
  readonly channelId: string;
  readonly providerEventId: string;
  readonly externalMessageId?: string;
  readonly payloadFingerprint: string;
  /** `rerouting` is a resumable claim used only to normalize an older route. */
  readonly status: "processing" | "rerouting" | "processed" | "rejected";
  /** Trusted host time at which processing first reserved this receipt. */
  readonly receivedAt: IsoTimestamp;
  /** Trusted host time at which processing reached a terminal status. */
  readonly processedAt?: IsoTimestamp;
  /** Resulting ticket; present only on a terminal receipt that names one. */
  readonly ticketId?: TicketId;
  /** Resulting message; present only on a terminal receipt that names one. */
  readonly messageId?: MessageId;
  readonly diagnostic?: string;
  /**
   * Host-minted ticket ID reserved by the first delivery. Every retry of the
   * same provider event reuses it instead of the retry's own identifiers.
   */
  readonly reservedTicketId?: TicketId;
  /** Host-minted message ID reserved by the first delivery. */
  readonly reservedMessageId?: MessageId;
  readonly correlationId?: string;
  /**
   * First routing decision. Ordinary replays retain it; processing receipts
   * written by older versions may be normalized before ticket work resumes.
   */
  readonly route?: InboundReceiptRoute;
  readonly outcome?: InboundEmailOutcome;
}

/** How inbound mail was associated with an existing ticket, if at all. */
export type InboundMatchMethod =
  "routing_token" | "message_id" | "subject_marker" | "none";

/** Coarse, content-free reason an inbound message created no message. */
export type InboundSuppressionReason =
  | "auto_submitted"
  | "precedence"
  | "auto_reply_header"
  | "bounce"
  | "delivery_report"
  | "support_address_loop";

export type InboundEmailOutcome =
  "created" | "replied" | "duplicate_message" | "suppressed" | "rejected";

/** Routing decision persisted on the receipt before any ticket work. */
export type InboundReceiptRoute =
  | {
      readonly kind: "suppressed";
      readonly reason: InboundSuppressionReason;
    }
  | {
      readonly kind: "duplicate_message";
      readonly ticketId: TicketId;
      readonly messageId: MessageId;
    }
  | {
      readonly kind: "reply";
      readonly ticketId: TicketId;
      readonly matchMethod: Exclude<InboundMatchMethod, "none">;
    }
  | {
      readonly kind: "new_conversation";
      readonly ticketId: TicketId;
      readonly matchMethod: InboundMatchMethod;
      readonly association: "matched_email" | "unverified";
      readonly principalId?: PrincipalId;
      readonly priority: InboundRoutingPriority;
      readonly category?: string;
      readonly relatedTicketId?: TicketId;
    };

function sameInboundReceiptRoute(
  left: InboundReceiptRoute | undefined,
  right: InboundReceiptRoute,
): boolean {
  if (left?.kind !== right.kind) {
    return false;
  }
  switch (right.kind) {
    case "suppressed":
      return left.kind === "suppressed" && left.reason === right.reason;
    case "duplicate_message":
      return (
        left.kind === "duplicate_message" &&
        left.ticketId === right.ticketId &&
        left.messageId === right.messageId
      );
    case "reply":
      return (
        left.kind === "reply" &&
        left.ticketId === right.ticketId &&
        left.matchMethod === right.matchMethod
      );
    case "new_conversation":
      return (
        left.kind === "new_conversation" &&
        left.ticketId === right.ticketId &&
        left.matchMethod === right.matchMethod &&
        left.association === right.association &&
        left.principalId === right.principalId &&
        left.priority === right.priority &&
        left.category === right.category &&
        left.relatedTicketId === right.relatedTicketId
      );
  }
}

export interface DeliveryCallbackInput {
  readonly provider: string;
  readonly providerEventId: string;
  readonly ticketId: TicketId;
  readonly deliveryJobId: string;
  readonly submissionGeneration: number;
  readonly providerMessageRef?: string | undefined;
  readonly status: "delivered" | "failed";
  readonly occurredAt: IsoTimestamp;
  readonly failureCategory?: string | undefined;
}

export interface DeliveryCallbackReceipt extends DeliveryCallbackInput {
  readonly bucket: string;
  /** Two-hex-digit slot derived with the bucket from a 128-bit digest. */
  readonly slot: string;
  readonly processedAt?: IsoTimestamp;
}

export const deliveryCallbackDedupeDays = 30;
export const maxDeliveryCallbacksPerBucket = 256;
export const inboundReceiptDedupeDays = 30;
export const maxInboundReceiptsPerBucket = 256;

function receiptSlotId(slot: string, field: string): string {
  if (!/^[0-9a-f]{2}$/.test(slot)) {
    throw new TypeError(`${field} must be exactly two lowercase hex digits`);
  }
  return `slot:${slot}`;
}

function jsonCodec<T>(key: (value: T) => EntityKey): Codec<T> {
  return {
    encode(value) {
      const location = key(value);
      return {
        partition: location.partition,
        id: location.id,
        payload: JSON.stringify(value),
      };
    },
    decode(record: StoredRecord) {
      if (typeof record.payload !== "string") {
        throw new TypeError("stored Support Desk record has no JSON payload");
      }
      return JSON.parse(record.payload) as T;
    },
  };
}

const supportRecordKey = (record: SupportRecord): EntityKey => ({
  partition: record.partition,
  id: record.id,
});

export const supportRecords = defineCollection<SupportRecord>({
  name: "support-desk.records.v1",
  key: supportRecordKey,
  codec: jsonCodec(supportRecordKey),
});

function requireSupportMailJob(job: MailJob): void {
  requireIdentifier(job.partition, "mail job.partition");
  requireIdentifier(job.id, "mail job.id");
  requireIdentifier(job.contentRef, "mail job.contentRef");
}

function requireDeliveryWrapper(record: DeliveryJob): void {
  requireSupportMailJob(record.job);
  if (
    record.partition !== record.job.partition ||
    record.id !== `delivery:${record.job.id}` ||
    record.ticketId !== record.job.partition ||
    record.messageId !== record.job.contentRef
  ) {
    throw new TypeError(
      "stored delivery wrapper does not match its nested mail job",
    );
  }
}

/**
 * Project generic mail state into Support Desk's durable record union.
 *
 * Physical identity stays Support-owned (`delivery:*`), while the nested job
 * round-trips exactly for authoritative collection-wide discovery.
 */
export const supportMail = defineMail<SupportRecord>({
  collection: supportRecords,
  key: ({ partition, jobId }) => {
    requireIdentifier(partition, "mail candidate.partition");
    requireIdentifier(jobId, "mail candidate.jobId");
    return {
      partition,
      id: `delivery:${jobId}`,
    };
  },
  toRecord(job, previous) {
    requireSupportMailJob(job);
    if (previous !== null && previous.kind !== "delivery_job") {
      throw new TypeError("mail projection collided with a non-mail record");
    }
    if (
      previous !== null &&
      (previous.ticketId !== job.partition ||
        previous.messageId !== job.contentRef)
    ) {
      throw new TypeError(
        "mail transition does not match the delivery wrapper's causal binding",
      );
    }
    return {
      kind: "delivery_job",
      partition: job.partition,
      id: `delivery:${job.id}`,
      ticketId: job.partition,
      messageId: previous?.messageId ?? job.contentRef,
      job,
    };
  },
  toJob(record) {
    if (record.kind !== "delivery_job") return null;
    requireDeliveryWrapper(record);
    return record.job;
  },
});

function requireAuditMember(record: AuditMemberRecord): void {
  if (
    record.partition !== record.event.subject ||
    record.id !== auditRecordId(record.event.id)
  ) {
    throw new TypeError(
      "stored audit member does not match its nested AuditEvent",
    );
  }
}

/**
 * Project generic audit events into Support Desk's durable record union.
 *
 * Physical identity is `auditRecordId(event.id)`; the event itself is the
 * accepted-change record. Domain `TicketEvent` values stay pure workflow input.
 */
export const supportAudit = defineAudit<SupportRecord>({
  collection: supportRecords,
  toRecord(event) {
    const record: AuditMemberRecord = {
      kind: "audit",
      partition: event.subject,
      id: auditRecordId(event.id),
      event,
    };
    requireAuditMember(record);
    return record;
  },
  toEvent(record) {
    if (record.kind !== "audit") {
      return null;
    }
    requireAuditMember(record);
    return record.event;
  },
});

function ticketAuditAction(input: {
  readonly commandId: string;
  readonly correlationId: string;
  readonly ticketId: TicketId;
  readonly revision: number;
  readonly actorId: PrincipalId;
  readonly occurredAt: IsoTimestamp;
  readonly action: (typeof supportTicketAuditActions)[keyof typeof supportTicketAuditActions];
  readonly details?: Readonly<Record<string, string>>;
}): ReturnType<typeof supportAudit.action> {
  return supportAudit.action({
    id: input.commandId,
    occurredAt: input.occurredAt,
    actor: { kind: "principal", principalId: input.actorId },
    action: input.action,
    subject: input.ticketId,
    sequence: input.revision,
    details: {
      commandId: input.commandId,
      correlationId: input.correlationId,
      ...(input.details ?? {}),
    },
  });
}

const customerTicketIndexKey = (
  record: CustomerTicketIndexRecord,
): EntityKey => ({
  partition: record.principalId,
  id: "tickets",
});

export const customerTicketIndex = defineCollection<CustomerTicketIndexRecord>({
  name: "support-desk.customer-ticket-index.v1",
  key: customerTicketIndexKey,
  codec: jsonCodec(customerTicketIndexKey),
});

const ticketNumberKey = (_record: TicketNumberRecord): EntityKey => ({
  partition: ticketNumberPartition,
  id: ticketNumberRecordId,
});

/**
 * One counter per Support Desk instance. Reservation is outside the ticket
 * transaction; gaps are accepted when a later create step fails.
 */
export const ticketNumbers = defineCollection<TicketNumberRecord>({
  name: "support-desk.ticket-numbers.v1",
  key: ticketNumberKey,
  codec: jsonCodec(ticketNumberKey),
});

const inboundReceiptKey = (record: InboundReceipt): EntityKey => ({
  partition: record.bucket,
  id: receiptSlotId(record.slot, "inbound receipt slot"),
});

export const inboundReceipts = defineCollection<InboundReceipt>({
  name: "support-desk.inbound-receipts.v1",
  key: inboundReceiptKey,
  codec: jsonCodec(inboundReceiptKey),
});

const deliveryCallbackReceiptKey = (
  record: DeliveryCallbackReceipt,
): EntityKey => ({
  partition: record.bucket,
  id: receiptSlotId(record.slot, "delivery callback slot"),
});

export const deliveryCallbackReceipts =
  defineCollection<DeliveryCallbackReceipt>({
    name: "support-desk.delivery-callback-receipts.v1",
    key: deliveryCallbackReceiptKey,
    codec: jsonCodec(deliveryCallbackReceiptKey),
  });

/**
 * Staff queue projection row. One record per ticket, partitioned by ticket ID
 * so no queue partition grows without bound. Never stores message bodies,
 * email addresses, or permission decisions.
 */
export interface QueueIndexRecord {
  readonly ticketId: TicketId;
  readonly id: "queue";
  readonly projectedRevision: number;
  readonly state: "active" | "inactive";
  readonly status: TicketStatus;
  readonly priority: TicketPriority;
  readonly category?: string;
  readonly tags?: readonly string[];
  readonly firstResponseDueAt?: IsoTimestamp;
  readonly resolutionDueAt?: IsoTimestamp;
  readonly firstStaffRespondedAt?: IsoTimestamp;
  readonly resolvedAt?: IsoTimestamp;
  readonly requesterAssociation: RequesterAssociation;
  readonly channel: TicketChannel;
  readonly assignedTo?: PrincipalId;
  readonly updatedAt: IsoTimestamp;
}

const queueIndexKey = (record: QueueIndexRecord): EntityKey => ({
  partition: record.ticketId,
  id: record.id,
});

export const queueIndex = defineCollection<QueueIndexRecord>({
  name: "support-desk.queue-index.v1",
  key: queueIndexKey,
  codec: jsonCodec(queueIndexKey),
});

/** Default terminal-retention cutoff shared by projection, repair, and sweep. */
export const defaultQueueTerminalRetentionMilliseconds = 30 * 86_400_000;

export interface QueueScanBudgets {
  /** Every adapter-returned physical projection row before confirmation. */
  readonly maxPhysicalRows: number;
  /** Complete scan pages attempted by one online queue request. */
  readonly maxScanPages: number;
  /** Confirmed active tickets materialized before filter/sort. */
  readonly maxActiveResults: number;
  /** Page size passed to `scan` (at most {@link MAX_SCAN_PAGE_SIZE}). */
  readonly scanPageSize: number;
}

export const defaultQueueScanBudgets: QueueScanBudgets = Object.freeze({
  maxPhysicalRows: 10_000,
  maxScanPages: 100,
  maxActiveResults: 1_000,
  scanPageSize: 100,
});

export interface QueueProjectionHealth {
  readonly consecutiveFailures: number;
  readonly lastFailureAt?: IsoTimestamp;
  readonly lastFailureTicketId?: TicketId;
  readonly lastFailureMessage?: string;
}

export interface NotificationInput {
  readonly id: string;
  readonly recipientRef: string;
  readonly templateId: string;
  readonly templateVersion: number;
  readonly variables: Readonly<Record<string, string>>;
  readonly subject: string;
  readonly outboundMessageId: string;
  readonly maxAttempts?: number;
  /**
   * Optional opaque reply-routing token the host renders into this
   * notification's reply address: 22 to 128 URL-safe base64 characters from
   * a cryptographically random source (at least 128 bits). Support Desk
   * indexes it so an inbound reply can be matched by key lookup.
   */
  readonly replyRoutingToken?: string;
}

const replyRoutingTokenPattern = /^[A-Za-z0-9_-]{22,128}$/;

export interface CreateCustomerTicketCommand {
  readonly commandId: string;
  readonly correlationId: string;
  readonly ticketId: TicketId;
  readonly messageId: MessageId;
  readonly subject: string;
  readonly body: string;
  /** Optional host-configured opaque category from the application allowlist. */
  readonly category?: string;
  readonly requesterEmail?: string;
  readonly notification?: NotificationInput;
}

/**
 * Instance-scoped positive ticket-number counter.
 * Partition and id are fixed: `instance` / `ticket-number`.
 */
export interface TicketNumberRecord {
  readonly lastIssued: number;
}

export const ticketNumberPartition = "instance";
export const ticketNumberRecordId = "ticket-number";

export interface ReplyToCustomerTicketCommand {
  readonly commandId: string;
  readonly correlationId: string;
  readonly ticketId: TicketId;
  readonly messageId: MessageId;
  readonly body: string;
  readonly notification?: NotificationInput;
}

const maxNotificationVariables = 32;
const maxNotificationVariableBytes = 8_192;
const maxNotificationVariableTotalBytes = 8_192;
const maxAllowedCategories = 32;
const categoryPattern = /^[a-z][a-z0-9_]{0,31}$/;

/**
 * Customer-safe ticket fields. Omits requester evidence, priority, assignee,
 * staff-facing `updatedAt`, revision, and every other staff-only field.
 */
export interface CustomerTicketSummary {
  readonly id: TicketId;
  readonly number: number;
  readonly subject: string;
  readonly category?: string;
  readonly status: Ticket["status"];
  readonly channel: Ticket["channel"];
  readonly createdAt: Ticket["createdAt"];
  readonly customerUpdatedAt: Ticket["customerUpdatedAt"];
}

/**
 * Customer-safe conversation fields. Omits principal IDs and provider
 * threading metadata that belong on the authoritative message record.
 */
export interface CustomerMessage {
  readonly id: TicketMessage["id"];
  readonly ticketId: TicketMessage["ticketId"];
  readonly authorKind: TicketMessage["authorKind"];
  readonly channel: TicketMessage["channel"];
  readonly visibility: TicketMessage["visibility"];
  readonly format: TicketMessage["format"];
  readonly body: TicketMessage["body"];
  readonly createdAt: TicketMessage["createdAt"];
}

export interface CustomerTicketView {
  readonly ticket: CustomerTicketSummary;
  readonly messages: readonly CustomerMessage[];
}

/**
 * Staff-facing ticket detail. Includes the authoritative ticket (requester,
 * priority, assignee, revision, staff timestamps) and every message, including
 * internal notes. Audit history is a separate permission-gated read.
 */
export interface StaffTicketView {
  readonly ticket: Ticket;
  readonly messages: readonly TicketMessage[];
}

export interface StaffRevisionHint {
  /** Omit to retain automatic conflict retries; supplied values must match. */
  readonly expectedRevision?: number;
}

export interface SetTagsCommand extends StaffRevisionHint {
  readonly commandId: string;
  readonly correlationId: string;
  readonly ticketId: TicketId;
  readonly tags: readonly string[];
}

export interface StaffReplyCommand extends StaffRevisionHint {
  readonly commandId: string;
  readonly correlationId: string;
  readonly ticketId: TicketId;
  readonly messageId: MessageId;
  readonly body: string;
  readonly notification?: NotificationInput;
}

export interface AddNoteCommand extends StaffRevisionHint {
  readonly commandId: string;
  readonly correlationId: string;
  readonly ticketId: TicketId;
  readonly messageId: MessageId;
  readonly body: string;
}

export interface AssignTicketCommand extends StaffRevisionHint {
  readonly commandId: string;
  readonly correlationId: string;
  readonly ticketId: TicketId;
  /** Principal to assign, or null to unassign. */
  readonly assigneeId: PrincipalId | null;
  /**
   * Optional assignment notification (for example to the new assignee),
   * committed in the same ticket transaction. When any of these is set,
   * `messageId` and `body` are required so mail binds to a real message.
   */
  readonly messageId?: MessageId;
  readonly body?: string;
  readonly notification?: NotificationInput;
}

export interface ChangePriorityCommand extends StaffRevisionHint {
  readonly commandId: string;
  readonly correlationId: string;
  readonly ticketId: TicketId;
  readonly priority: TicketPriority;
}

export interface LifecycleTicketCommand extends StaffRevisionHint {
  readonly commandId: string;
  readonly correlationId: string;
  readonly ticketId: TicketId;
  /**
   * Optional customer-visible system message and mail, committed in the same
   * ticket transaction as the lifecycle change (for example a resolution
   * notification). When any of these is set, `messageId` and `body` are
   * required so mail content binds to a real message record.
   */
  readonly messageId?: MessageId;
  readonly body?: string;
  readonly notification?: NotificationInput;
}

/**
 * Staff queue filters applied in application memory after authoritative
 * confirmation. Storage never filters or sorts projection rows.
 */
export interface StaffQueueQuery {
  readonly tag?: string;
  /** Target filters and due sorting default to resolution. */
  readonly target?: "first_response" | "resolution";
  readonly targetState?: "overdue" | "due_soon";
  /** Required for due_soon; inclusive horizon, at most 30 days. */
  readonly dueSoonMilliseconds?: number;
  readonly status?: TicketStatus | readonly TicketStatus[];
  readonly priority?: TicketPriority | readonly TicketPriority[];
  readonly association?: RequesterAssociation | readonly RequesterAssociation[];
  readonly channel?: TicketChannel | readonly TicketChannel[];
  /** Exact assignee principal; use with `unassignedOnly` for null assignee. */
  readonly assignedTo?: PrincipalId;
  readonly unassignedOnly?: boolean;
  /** Newest updates first is the default staff presentation. */
  readonly sort?:
    "updated_newest" | "updated_oldest" | "due_soonest" | "due_latest";
}

/** Confirmed active ticket summary for the staff queue surface. */
export interface StaffQueueItem {
  readonly ticketId: TicketId;
  readonly revision: number;
  readonly status: TicketStatus;
  readonly priority: TicketPriority;
  readonly category?: string;
  readonly tags?: readonly string[];
  readonly firstResponseDueAt?: IsoTimestamp;
  readonly resolutionDueAt?: IsoTimestamp;
  readonly firstStaffRespondedAt?: IsoTimestamp;
  readonly resolvedAt?: IsoTimestamp;
  readonly requesterAssociation: RequesterAssociation;
  readonly channel: TicketChannel;
  readonly assignedTo?: PrincipalId;
  readonly updatedAt: IsoTimestamp;
}

export interface StaffQueueResult {
  readonly items: readonly StaffQueueItem[];
}

export interface QueueRepairPageOptions {
  /** Opaque adapter-issued continuation; omit to begin a new repair cycle. */
  readonly cursor?: string;
  /** Physical records per authoritative page; at most {@link MAX_SCAN_PAGE_SIZE}. */
  readonly limit?: number;
}

export interface QueueRepairPageResult {
  /** Host-persisted only after this whole page succeeds. */
  readonly nextCursor: string | null;
  readonly physicalRows: number;
  readonly projected: number;
}

export interface QueueInactiveSweepOptions {
  readonly cursor?: string;
  readonly limit?: number;
}

export interface QueueInactiveSweepResult {
  readonly nextCursor: string | null;
  readonly physicalRows: number;
  readonly deleted: number;
}

export interface SupportDeskApplication {
  createCustomerTicket(
    access: AccessContext,
    command: CreateCustomerTicketCommand,
  ): Promise<CustomerTicketView>;
  replyToCustomerTicket(
    access: AccessContext,
    command: ReplyToCustomerTicketCommand,
  ): Promise<CustomerTicketView>;
  listCustomerTickets(
    access: AccessContext,
  ): Promise<readonly CustomerTicketSummary[]>;
  readCustomerTicket(
    access: AccessContext,
    ticketId: TicketId,
  ): Promise<CustomerTicketView>;
  readStaffTicket(
    access: AccessContext,
    ticketId: TicketId,
  ): Promise<StaffTicketView>;
  /**
   * Bounded staff queue over `support-desk.queue-index.v1`. Scans the
   * projection from a null cursor for one complete cycle, confirms every
   * candidate against the authoritative ticket, then filters and sorts in
   * memory. Exhausting any budget returns {@link SupportDeskQueueCapacityError}
   * with no partial result.
   */
  listStaffQueue(
    access: AccessContext,
    query?: StaffQueueQuery,
  ): Promise<StaffQueueResult>;
  /** In-process projection health for host metrics/dashboards. */
  queueProjectionHealth(): QueueProjectionHealth;
  replyAsStaff(
    access: AccessContext,
    command: StaffReplyCommand,
  ): Promise<StaffTicketView>;
  addNote(
    access: AccessContext,
    command: AddNoteCommand,
  ): Promise<StaffTicketView>;
  assignTicket(
    access: AccessContext,
    command: AssignTicketCommand,
  ): Promise<StaffTicketView>;
  changePriority(
    access: AccessContext,
    command: ChangePriorityCommand,
  ): Promise<StaffTicketView>;
  setTags(
    access: AccessContext,
    command: SetTagsCommand,
  ): Promise<StaffTicketView>;
  resolveTicket(
    access: AccessContext,
    command: LifecycleTicketCommand,
  ): Promise<StaffTicketView>;
  closeTicket(
    access: AccessContext,
    command: LifecycleTicketCommand,
  ): Promise<StaffTicketView>;
  reopenTicket(
    access: AccessContext,
    command: LifecycleTicketCommand,
  ): Promise<StaffTicketView>;
  readTicketAuditHistory(
    access: AccessContext,
    ticketId: TicketId,
  ): Promise<readonly AuditEvent[]>;
}

function requirePermission(access: AccessContext, permission: string): void {
  if (!hasPermission(access, permission)) {
    throw new SupportDeskAuthorizationError(permission);
  }
}

function requireNonempty(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
}

function requireIdentifier(value: string, field: string): void {
  requireNonempty(value, field);
  if (value.length > 200 || /[\u0000-\u001F\u007F]/.test(value)) {
    throw new TypeError(
      `${field} must be at most 200 characters with no controls`,
    );
  }
}

const outboundMessageIdLocalPart = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+$/;
const outboundMessageIdDomain =
  /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

export function validateOutboundMessageId(
  value: string,
  field = "outboundMessageId",
): string {
  if (typeof value !== "string") {
    throw new TypeError(`${field} must be a header-safe ASCII Message-ID`);
  }
  const match = /^<([^<>@\s]+)@([^<>@\s]+)>$/.exec(value);
  const local = match?.[1] ?? "";
  const domain = match?.[2] ?? "";
  if (
    value.length > 254 ||
    /[\u0000-\u001F\u007F]/.test(value) ||
    !outboundMessageIdLocalPart.test(local) ||
    local.startsWith(".") ||
    local.endsWith(".") ||
    local.includes("..") ||
    !outboundMessageIdDomain.test(domain)
  ) {
    throw new TypeError(`${field} must be a header-safe ASCII Message-ID`);
  }
  return value;
}

function enforceLimit(
  value: string,
  field: "subject" | "body",
  maximum: number,
): void {
  requireNonempty(value, field);
  if ([...value].length > maximum) {
    throw new SupportDeskLimitError(field, maximum);
  }
}

function ticketKey(ticketId: TicketId): EntityKey {
  return { partition: ticketId, id: "ticket" };
}

function ticketQuotaKey(ticketId: TicketId): EntityKey {
  return { partition: ticketId, id: "quota" };
}

function ticketReservationKey(ticketId: TicketId): EntityKey {
  return { partition: ticketId, id: "reservation" };
}

function commandKey(ticketId: TicketId, commandId: string): EntityKey {
  return { partition: ticketId, id: `command:${commandId}` };
}

function ownDataProperty(
  source: object,
  key: PropertyKey,
  field: string,
  optional = false,
  rejectInherited = false,
): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(source, key);
  if (descriptor === undefined) {
    if (rejectInherited && Reflect.has(source, key)) {
      throw new TypeError(`${field} must be an own data property`);
    }
    if (optional) {
      return undefined;
    }
    throw new TypeError(`${field} must be an own data property`);
  }
  if (!Object.hasOwn(descriptor, "value")) {
    throw new TypeError(
      `${field} must be an own data property, not an accessor`,
    );
  }
  return descriptor.value;
}

function snapshotNotificationVariables(
  input: unknown,
): Readonly<Record<string, string>> {
  if (
    input === null ||
    (typeof input !== "object" && typeof input !== "function")
  ) {
    throw new TypeError("notification.variables must be an object");
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const names = Reflect.ownKeys(descriptors);
  if (names.length > maxNotificationVariables) {
    throw new TypeError(
      `notification.variables may contain at most ${maxNotificationVariables} values`,
    );
  }
  const values = new Map<string, string>();
  const encoder = new TextEncoder();
  let totalBytes = 0;
  for (const name of names) {
    if (typeof name !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(name)) {
      throw new TypeError("notification.variables must use safe names");
    }
    const descriptor = descriptors[name];
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !Object.hasOwn(descriptor, "value") ||
      typeof descriptor.value !== "string"
    ) {
      throw new TypeError(
        "notification.variables must use enumerable own string values",
      );
    }
    const valueBytes = encoder.encode(descriptor.value).byteLength;
    if (valueBytes > maxNotificationVariableBytes) {
      throw new TypeError(
        `notification variable values may contain at most ${maxNotificationVariableBytes} bytes`,
      );
    }
    totalBytes += valueBytes;
    if (totalBytes > maxNotificationVariableTotalBytes) {
      throw new TypeError(
        `notification.variables exceed the ${maxNotificationVariableTotalBytes} byte limit`,
      );
    }
    values.set(name, descriptor.value);
  }
  const sorted: Record<string, string> = {};
  for (const name of [...values.keys()].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  )) {
    sorted[name] = values.get(name) as string;
  }
  return Object.freeze(sorted);
}

function snapshotNotification(input: unknown): NotificationInput {
  if (
    input === null ||
    (typeof input !== "object" && typeof input !== "function")
  ) {
    throw new TypeError("notification must be an object");
  }
  const readString = (key: keyof NotificationInput): string => {
    const value = ownDataProperty(input, key, `notification.${key}`);
    if (typeof value !== "string") {
      throw new TypeError(`notification.${key} must be a string`);
    }
    return value;
  };
  const id = readString("id");
  const recipientRef = readString("recipientRef");
  const templateId = readString("templateId");
  const templateVersion = ownDataProperty(
    input,
    "templateVersion",
    "notification.templateVersion",
  );
  const variables = snapshotNotificationVariables(
    ownDataProperty(input, "variables", "notification.variables"),
  );
  const subject = readString("subject");
  const outboundMessageId = readString("outboundMessageId");
  const maxAttempts = ownDataProperty(
    input,
    "maxAttempts",
    "notification.maxAttempts",
    true,
  );
  const replyRoutingToken = ownDataProperty(
    input,
    "replyRoutingToken",
    "notification.replyRoutingToken",
    true,
  );
  if (
    replyRoutingToken !== undefined &&
    (typeof replyRoutingToken !== "string" ||
      !replyRoutingTokenPattern.test(replyRoutingToken))
  ) {
    throw new TypeError(
      "notification.replyRoutingToken must be 22 to 128 URL-safe base64 characters",
    );
  }

  requireIdentifier(id, "notification.id");
  requireIdentifier(recipientRef, "notification.recipientRef");
  requireIdentifier(templateId, "notification.templateId");
  if (
    !Number.isSafeInteger(templateVersion) ||
    (templateVersion as number) <= 0
  ) {
    throw new TypeError(
      "notification.templateVersion must be a positive safe integer",
    );
  }
  if (
    subject.trim().length === 0 ||
    subject.length > 500 ||
    /[\u0000-\u001F\u007F]/.test(subject)
  ) {
    throw new TypeError(
      "notification.subject must be at most 500 characters with no controls",
    );
  }
  validateOutboundMessageId(
    outboundMessageId,
    "notification.outboundMessageId",
  );
  if (
    maxAttempts !== undefined &&
    (!Number.isSafeInteger(maxAttempts) ||
      (maxAttempts as number) <= 0 ||
      (maxAttempts as number) > maxMailAttempts)
  ) {
    throw new TypeError(
      `notification.maxAttempts must be between 1 and ${maxMailAttempts}`,
    );
  }
  return Object.freeze({
    id,
    recipientRef,
    templateId,
    templateVersion: templateVersion as number,
    variables,
    subject,
    outboundMessageId,
    ...(maxAttempts === undefined
      ? {}
      : { maxAttempts: maxAttempts as number }),
    ...(replyRoutingToken === undefined
      ? {}
      : { replyRoutingToken: replyRoutingToken as string }),
  });
}

function boundaryObject(input: unknown, field: string): object {
  if (
    input === null ||
    (typeof input !== "object" && typeof input !== "function")
  ) {
    throw new TypeError(`${field} must be an object`);
  }
  return input;
}

function boundaryString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`${field} must be a string`);
  }
  return value;
}

const requesterEmailMaximumCharacters = 254;
const requesterEmailLocalPart = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/;
const requesterEmailDomain =
  /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

function normalizeRequesterEmail(
  value: unknown,
  field = "requesterEmail",
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new TypeError(`${field} must be a string`);
  }
  if (
    value.length > requesterEmailMaximumCharacters ||
    /[\u0000-\u001F\u007F<>&"\\]/.test(value)
  ) {
    throw new TypeError(
      `${field} must be a plain email address of at most ${requesterEmailMaximumCharacters} characters`,
    );
  }
  const normalized = value.trim();
  const separator = normalized.indexOf("@");
  const local = normalized.slice(0, separator);
  const domain = normalized.slice(separator + 1);
  if (
    normalized.length === 0 ||
    /\s/.test(normalized) ||
    separator <= 0 ||
    separator !== normalized.lastIndexOf("@") ||
    local.length > 64 ||
    local.startsWith(".") ||
    local.endsWith(".") ||
    local.includes("..") ||
    !requesterEmailLocalPart.test(local) ||
    domain.length > 253 ||
    !requesterEmailDomain.test(domain)
  ) {
    throw new TypeError(
      `${field} must be a plain email address of at most ${requesterEmailMaximumCharacters} characters`,
    );
  }
  return `${local}@${domain.toLowerCase()}`;
}

function snapshotCategory(value: unknown, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new TypeError(`${field} must be a string`);
  }
  if (!categoryPattern.test(value)) {
    throw new TypeError(
      `${field} must match ${categoryPattern.source} and contain no controls`,
    );
  }
  return value;
}

function normalizedTag(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 64 ||
    /[\u0000-\u001F\u007F]/.test(value)
  ) {
    throw new TypeError("tag must be a bounded safe identifier");
  }
  const tag = value.trim().toLowerCase();
  if (!categoryPattern.test(tag))
    throw new TypeError("tag must match the category identifier discipline");
  return tag;
}

function snapshotTags(input: unknown): readonly string[] {
  if (!Array.isArray(input) || input.length > 32) {
    throw new TypeError("tags must be an array of at most 32 values");
  }
  const tags = new Set<string>();
  for (let index = 0; index < input.length; index += 1) {
    tags.add(normalizedTag(ownDataProperty(input, index, `tags[${index}]`)));
  }
  return Object.freeze([...tags].sort());
}

function snapshotRevisionHint(source: object): StaffRevisionHint {
  const value = ownDataProperty(
    source,
    "expectedRevision",
    "expectedRevision",
    true,
  );
  if (value === undefined) return {};
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new TypeError("expectedRevision must be a positive safe integer");
  }
  return { expectedRevision: value };
}

function requireExpectedRevision(
  ticket: Ticket,
  command: StaffRevisionHint,
): void {
  if (
    command.expectedRevision !== undefined &&
    ticket.revision !== command.expectedRevision
  ) {
    throw new SupportDeskStaleRevisionError(ticket.revision, ticket.updatedAt);
  }
}

function parseResponseTargetPolicy(
  input: unknown,
): ResponseTargetPolicy | undefined {
  if (input === undefined) return undefined;
  const source = boundaryObject(input, "responseTargetPolicy");
  const method = ownDataProperty(
    source,
    "computeTargets",
    "responseTargetPolicy.computeTargets",
  );
  if (typeof method !== "function")
    throw new TypeError("responseTargetPolicy must provide computeTargets()");
  return Object.freeze({
    computeTargets: (context: ResponseTargetContext) =>
      method.call(source, context) as ReturnType<
        ResponseTargetPolicy["computeTargets"]
      >,
  });
}

function staffLifecycleFields(
  ticket: Ticket,
): Pick<
  Ticket,
  | "tags"
  | "firstResponseDueAt"
  | "resolutionDueAt"
  | "firstStaffRespondedAt"
  | "resolvedAt"
> {
  return {
    ...(ticket.tags === undefined
      ? {}
      : { tags: Object.freeze([...ticket.tags]) }),
    ...(ticket.firstResponseDueAt === undefined
      ? {}
      : { firstResponseDueAt: ticket.firstResponseDueAt }),
    ...(ticket.resolutionDueAt === undefined
      ? {}
      : { resolutionDueAt: ticket.resolutionDueAt }),
    ...(ticket.firstStaffRespondedAt === undefined
      ? {}
      : { firstStaffRespondedAt: ticket.firstStaffRespondedAt }),
    ...(ticket.resolvedAt === undefined
      ? {}
      : { resolvedAt: ticket.resolvedAt }),
  };
}

async function applyResponseTargets(
  ticket: Ticket,
  policy: ResponseTargetPolicy | undefined,
  reason: ResponseTargetContext["reason"],
): Promise<Ticket> {
  if (policy === undefined) return ticket;
  const context: ResponseTargetContext = Object.freeze({
    reason,
    ticketId: ticket.id,
    revision: ticket.revision,
    priority: ticket.priority,
    channel: ticket.channel,
    createdAt: ticket.createdAt,
    occurredAt: ticket.updatedAt,
    ...(ticket.category === undefined ? {} : { category: ticket.category }),
    ...(ticket.firstResponseDueAt === undefined
      ? {}
      : { firstResponseDueAt: ticket.firstResponseDueAt }),
    ...(ticket.resolutionDueAt === undefined
      ? {}
      : { resolutionDueAt: ticket.resolutionDueAt }),
    ...(ticket.firstStaffRespondedAt === undefined
      ? {}
      : { firstStaffRespondedAt: ticket.firstStaffRespondedAt }),
    ...(ticket.resolvedAt === undefined
      ? {}
      : { resolvedAt: ticket.resolvedAt }),
  });
  const result = boundaryObject(
    await policy.computeTargets(context),
    "response targets",
  );
  const targets: {
    firstResponseDueAt?: IsoTimestamp;
    resolutionDueAt?: IsoTimestamp;
  } = {};
  for (const field of ["firstResponseDueAt", "resolutionDueAt"] as const) {
    const value = ownDataProperty(
      result,
      field,
      `response targets.${field}`,
      true,
    );
    if (value !== undefined) {
      if (typeof value !== "string")
        throw new TypeError("response target must be an ISO timestamp");
      canonicalTimestamp(value, `response targets.${field}`);
      targets[field] = value;
    }
  }
  const {
    firstResponseDueAt: _first,
    resolutionDueAt: _resolution,
    ...rest
  } = ticket;
  return Object.freeze({ ...rest, ...targets });
}

function snapshotCreateCustomerTicketCommand(
  input: CreateCustomerTicketCommand,
): CreateCustomerTicketCommand {
  const source = boundaryObject(input, "create command");
  const raw = {
    commandId: ownDataProperty(source, "commandId", "create command.commandId"),
    correlationId: ownDataProperty(
      source,
      "correlationId",
      "create command.correlationId",
    ),
    ticketId: ownDataProperty(source, "ticketId", "create command.ticketId"),
    messageId: ownDataProperty(source, "messageId", "create command.messageId"),
    subject: ownDataProperty(source, "subject", "create command.subject"),
    body: ownDataProperty(source, "body", "create command.body"),
    category: ownDataProperty(
      source,
      "category",
      "create command.category",
      true,
    ),
    requesterEmail: ownDataProperty(
      source,
      "requesterEmail",
      "create command.requesterEmail",
      true,
    ),
    notification: ownDataProperty(
      source,
      "notification",
      "create command.notification",
      true,
    ),
  };
  const category = snapshotCategory(raw.category, "create command.category");
  const requesterEmail = normalizeRequesterEmail(raw.requesterEmail);
  const notification =
    raw.notification === undefined
      ? undefined
      : snapshotNotification(raw.notification);
  return Object.freeze({
    commandId: boundaryString(raw.commandId, "create command.commandId"),
    correlationId: boundaryString(
      raw.correlationId,
      "create command.correlationId",
    ),
    ticketId: boundaryString(raw.ticketId, "create command.ticketId"),
    messageId: boundaryString(raw.messageId, "create command.messageId"),
    subject: boundaryString(raw.subject, "create command.subject"),
    body: boundaryString(raw.body, "create command.body"),
    ...(category === undefined ? {} : { category }),
    ...(requesterEmail === undefined ? {} : { requesterEmail }),
    ...(notification === undefined ? {} : { notification }),
  });
}

function snapshotReplyToCustomerTicketCommand(
  input: ReplyToCustomerTicketCommand,
): ReplyToCustomerTicketCommand {
  const source = boundaryObject(input, "reply command");
  const raw = {
    commandId: ownDataProperty(source, "commandId", "reply command.commandId"),
    correlationId: ownDataProperty(
      source,
      "correlationId",
      "reply command.correlationId",
    ),
    ticketId: ownDataProperty(source, "ticketId", "reply command.ticketId"),
    messageId: ownDataProperty(source, "messageId", "reply command.messageId"),
    body: ownDataProperty(source, "body", "reply command.body"),
    notification: ownDataProperty(
      source,
      "notification",
      "reply command.notification",
      true,
    ),
  };
  const notification =
    raw.notification === undefined
      ? undefined
      : snapshotNotification(raw.notification);
  return Object.freeze({
    commandId: boundaryString(raw.commandId, "reply command.commandId"),
    correlationId: boundaryString(
      raw.correlationId,
      "reply command.correlationId",
    ),
    ticketId: boundaryString(raw.ticketId, "reply command.ticketId"),
    messageId: boundaryString(raw.messageId, "reply command.messageId"),
    body: boundaryString(raw.body, "reply command.body"),
    ...(notification === undefined ? {} : { notification }),
  });
}

function deliveryJobAction(
  ticketId: TicketId,
  messageId: MessageId,
  now: IsoTimestamp,
  input: NotificationInput,
): ReturnType<typeof supportMail.action> {
  return supportMail.action({
    partition: ticketId,
    id: input.id,
    recipientRef: input.recipientRef,
    contentRef: messageId,
    createdAt: now,
    ...(input.maxAttempts === undefined
      ? {}
      : { maxAttempts: input.maxAttempts }),
  });
}

function deliveryContent(
  input: NotificationInput | undefined,
): DeliveryContent | undefined {
  return input === undefined
    ? undefined
    : {
        templateId: input.templateId,
        templateVersion: input.templateVersion,
        variables: input.variables,
        subject: input.subject,
        outboundMessageId: input.outboundMessageId,
        ...(input.replyRoutingToken === undefined
          ? {}
          : { replyRoutingToken: input.replyRoutingToken }),
      };
}

function bindNotificationTicketNumber(
  input: NotificationInput,
  ticketNumber: number,
): NotificationInput {
  const ticketNumberText = String(ticketNumber);
  const names = Object.keys(input.variables);
  if (
    !Object.hasOwn(input.variables, "ticket_number") &&
    names.length >= maxNotificationVariables
  ) {
    throw new TypeError(
      `notification.variables may contain at most ${maxNotificationVariables} values`,
    );
  }
  const variables: Record<string, string> = {
    ...input.variables,
    ticket_number: ticketNumberText,
  };
  // Re-validate the final map so injection cannot exceed count/byte limits.
  const frozenVariables = snapshotNotificationVariables(variables);
  return Object.freeze({
    ...input,
    subject: input.subject.replaceAll("{{ticket_number}}", ticketNumberText),
    variables: frozenVariables,
  });
}

function toCustomerMessage(message: TicketMessage): CustomerMessage {
  return Object.freeze({
    id: message.id,
    ticketId: message.ticketId,
    authorKind: message.authorKind,
    channel: message.channel,
    visibility: message.visibility,
    format: message.format,
    body: message.body,
    createdAt: message.createdAt,
  });
}

function customerMessages(
  records: readonly SupportRecord[],
): CustomerMessage[] {
  const messages = records.filter(
    (record): record is MessageRecord =>
      record.kind === "message" && record.message.visibility === "customer",
  );
  const ordinals = new Set<number>();
  for (const record of messages) {
    if (!Number.isSafeInteger(record.ordinal) || record.ordinal <= 0) {
      throw new TypeError(
        "stored customer message has no valid explicit ordinal; migrate the record before reading it",
      );
    }
    if (ordinals.has(record.ordinal)) {
      throw new TypeError(
        "stored customer messages contain a duplicate explicit ordinal",
      );
    }
    ordinals.add(record.ordinal);
  }
  return messages
    .sort((left, right) => left.ordinal - right.ordinal)
    .map((record) => toCustomerMessage(record.message));
}

function toCustomerTicketSummary(ticket: Ticket): CustomerTicketSummary {
  // Pre-Task-2 durable tickets lack customerUpdatedAt. Fall back to createdAt
  // (never staff-only updatedAt) so list/detail stay ordered and DTO-complete
  // without leaking note/assignment/priority activity.
  const customerUpdatedAt = ticket.customerUpdatedAt ?? ticket.createdAt;
  return Object.freeze({
    id: ticket.id,
    number: ticket.number,
    subject: ticket.subject,
    ...(ticket.category === undefined ? {} : { category: ticket.category }),
    status: ticket.status,
    channel: ticket.channel,
    createdAt: ticket.createdAt,
    customerUpdatedAt,
  });
}

async function authoritativeView(
  records: CollectionStore<SupportRecord>,
  principalId: PrincipalId,
  ticketId: TicketId,
  maxRecordsPerTicket: number,
): Promise<CustomerTicketView> {
  const all = await records.list(ticketId);
  const ticketRecord = all.find(
    (record): record is TicketRecord => record.kind === "ticket",
  );
  // Ownership before partition errors so foreign ticket IDs never leak capacity.
  if (
    ticketRecord === undefined ||
    ticketRecord.ticket.requester.association !== "authenticated" ||
    ticketRecord.ticket.requester.principalId !== principalId
  ) {
    throw new SupportDeskNotFoundError();
  }
  enforcePartitionRecordLimit(all.length, maxRecordsPerTicket);
  return {
    ticket: toCustomerTicketSummary(ticketRecord.ticket),
    messages: customerMessages(all),
  };
}

/**
 * Validate and copy host-supplied category allowlist into a private Set.
 * The host array is not retained; the Set is application-owned state.
 */
function parseAllowedCategories(
  input: unknown,
  name = "application options.allowedCategories",
): ReadonlySet<string> | undefined {
  if (input === undefined) {
    return undefined;
  }
  if (!Array.isArray(input)) {
    throw new TypeError(`${name} must be an array`);
  }
  if (input.length > maxAllowedCategories) {
    throw new TypeError(
      `${name} may contain at most ${maxAllowedCategories} values`,
    );
  }
  const values = new Set<string>();
  for (let index = 0; index < input.length; index += 1) {
    const field = `${name}[${index}]`;
    const value = ownDataProperty(input, index, field);
    if (typeof value !== "string") {
      throw new TypeError(`${field} must be a string`);
    }
    if (!categoryPattern.test(value)) {
      throw new TypeError(
        `${field} must match ${categoryPattern.source} and contain no controls`,
      );
    }
    if (values.has(value)) {
      throw new TypeError(`${name} must not contain duplicates`);
    }
    values.add(value);
  }
  return values;
}

function duplicateMatches(
  existing: SupportRecord | null,
  commandType: CommandRecord["commandType"],
  messageId: MessageId | undefined,
  requestFingerprint: string,
): boolean {
  return (
    existing?.kind === "command" &&
    existing.commandType === commandType &&
    existing.messageId === messageId &&
    existing.requestFingerprint === requestFingerprint
  );
}

function inboundReplyRerouteFenceMatches(
  existing: SupportRecord | null,
  commandId: string,
  messageId: MessageId,
  requestFingerprint: string,
): existing is InboundReplyRerouteFenceRecord {
  return (
    existing?.kind === "inbound_reply_reroute_fence" &&
    existing.commandId === commandId &&
    existing.messageId === messageId &&
    existing.requestFingerprint === requestFingerprint
  );
}

function inboundCreateRerouteFenceMatches(
  existing: SupportRecord | null,
  commandId: string,
  messageId: MessageId,
  requestFingerprint: string,
): existing is InboundCreateRerouteFenceRecord {
  return (
    existing?.kind === "inbound_create_reroute_fence" &&
    existing.commandId === commandId &&
    existing.messageId === messageId &&
    existing.requestFingerprint === requestFingerprint
  );
}

const TICKET_PRIORITIES: readonly TicketPriority[] = [
  "low",
  "normal",
  "high",
  "urgent",
];

function staffMessages(records: readonly SupportRecord[]): TicketMessage[] {
  const messages = records.filter(
    (record): record is MessageRecord => record.kind === "message",
  );
  const ordinals = new Set<number>();
  for (const record of messages) {
    if (!Number.isSafeInteger(record.ordinal) || record.ordinal <= 0) {
      throw new TypeError(
        "stored message has no valid explicit ordinal; migrate the record before reading it",
      );
    }
    if (ordinals.has(record.ordinal)) {
      throw new TypeError(
        "stored messages contain a duplicate explicit ordinal",
      );
    }
    ordinals.add(record.ordinal);
  }
  return messages
    .sort((left, right) => left.ordinal - right.ordinal)
    .map((record) => Object.freeze({ ...record.message }));
}

function enforcePartitionRecordLimit(
  recordCount: number,
  maximum: number,
  additional = 0,
): void {
  if (recordCount + additional > maximum) {
    throw new SupportDeskLimitError("ticket_partition", maximum);
  }
}

async function staffAuthoritativeView(
  records: CollectionStore<SupportRecord>,
  ticketId: TicketId,
  maxRecordsPerTicket: number,
): Promise<StaffTicketView> {
  const all = await records.list(ticketId);
  enforcePartitionRecordLimit(all.length, maxRecordsPerTicket);
  const ticketRecord = all.find(
    (record): record is TicketRecord => record.kind === "ticket",
  );
  if (ticketRecord === undefined) {
    throw new SupportDeskNotFoundError();
  }
  return {
    ticket: ticketRecord.ticket,
    messages: staffMessages(all),
  };
}

/** Staff mutations that return full ticket detail also require queue read. */
function requireStaffMutationAccess(
  access: AccessContext,
  permission: string,
): void {
  requirePermission(access, supportPermissions.queueRead);
  requirePermission(access, permission);
}

function clampTicketTime(
  sampledNow: IsoTimestamp,
  ticketUpdatedAt: IsoTimestamp,
): IsoTimestamp {
  const sampledEpoch = canonicalTimestamp(sampledNow, "clock.now()");
  const storedEpoch = canonicalTimestamp(ticketUpdatedAt, "ticket.updatedAt");
  return sampledEpoch < storedEpoch ? ticketUpdatedAt : sampledNow;
}

function snapshotStaffReplyCommand(
  input: StaffReplyCommand,
): StaffReplyCommand {
  const source = boundaryObject(input, "staff reply command");
  const raw = {
    commandId: ownDataProperty(
      source,
      "commandId",
      "staff reply command.commandId",
    ),
    correlationId: ownDataProperty(
      source,
      "correlationId",
      "staff reply command.correlationId",
    ),
    ticketId: ownDataProperty(
      source,
      "ticketId",
      "staff reply command.ticketId",
    ),
    messageId: ownDataProperty(
      source,
      "messageId",
      "staff reply command.messageId",
    ),
    body: ownDataProperty(source, "body", "staff reply command.body"),
    notification: ownDataProperty(
      source,
      "notification",
      "staff reply command.notification",
      true,
    ),
  };
  const notification =
    raw.notification === undefined
      ? undefined
      : snapshotNotification(raw.notification);
  return Object.freeze({
    ...snapshotRevisionHint(source),
    commandId: boundaryString(raw.commandId, "staff reply command.commandId"),
    correlationId: boundaryString(
      raw.correlationId,
      "staff reply command.correlationId",
    ),
    ticketId: boundaryString(raw.ticketId, "staff reply command.ticketId"),
    messageId: boundaryString(raw.messageId, "staff reply command.messageId"),
    body: boundaryString(raw.body, "staff reply command.body"),
    ...(notification === undefined ? {} : { notification }),
  });
}

function snapshotAddNoteCommand(input: AddNoteCommand): AddNoteCommand {
  const source = boundaryObject(input, "add note command");
  const raw = {
    commandId: ownDataProperty(
      source,
      "commandId",
      "add note command.commandId",
    ),
    correlationId: ownDataProperty(
      source,
      "correlationId",
      "add note command.correlationId",
    ),
    ticketId: ownDataProperty(source, "ticketId", "add note command.ticketId"),
    messageId: ownDataProperty(
      source,
      "messageId",
      "add note command.messageId",
    ),
    body: ownDataProperty(source, "body", "add note command.body"),
  };
  return Object.freeze({
    ...snapshotRevisionHint(source),
    commandId: boundaryString(raw.commandId, "add note command.commandId"),
    correlationId: boundaryString(
      raw.correlationId,
      "add note command.correlationId",
    ),
    ticketId: boundaryString(raw.ticketId, "add note command.ticketId"),
    messageId: boundaryString(raw.messageId, "add note command.messageId"),
    body: boundaryString(raw.body, "add note command.body"),
  });
}

function snapshotAssignTicketCommand(
  input: AssignTicketCommand,
): AssignTicketCommand {
  const source = boundaryObject(input, "assign command");
  const raw = {
    commandId: ownDataProperty(source, "commandId", "assign command.commandId"),
    correlationId: ownDataProperty(
      source,
      "correlationId",
      "assign command.correlationId",
    ),
    ticketId: ownDataProperty(source, "ticketId", "assign command.ticketId"),
    assigneeId: ownDataProperty(
      source,
      "assigneeId",
      "assign command.assigneeId",
    ),
    messageId: ownDataProperty(
      source,
      "messageId",
      "assign command.messageId",
      true,
    ),
    body: ownDataProperty(source, "body", "assign command.body", true),
    notification: ownDataProperty(
      source,
      "notification",
      "assign command.notification",
      true,
    ),
  };
  if (raw.assigneeId !== null && typeof raw.assigneeId !== "string") {
    throw new TypeError("assign command.assigneeId must be a string or null");
  }
  const notification =
    raw.notification === undefined
      ? undefined
      : snapshotNotification(raw.notification);
  const messageId =
    raw.messageId === undefined
      ? undefined
      : boundaryString(raw.messageId, "assign command.messageId");
  const body =
    raw.body === undefined
      ? undefined
      : boundaryString(raw.body, "assign command.body");
  if (
    notification !== undefined ||
    messageId !== undefined ||
    body !== undefined
  ) {
    if (messageId === undefined || body === undefined) {
      throw new TypeError(
        "assign command requires messageId and body when recording a notification message",
      );
    }
  }
  return Object.freeze({
    ...snapshotRevisionHint(source),
    commandId: boundaryString(raw.commandId, "assign command.commandId"),
    correlationId: boundaryString(
      raw.correlationId,
      "assign command.correlationId",
    ),
    ticketId: boundaryString(raw.ticketId, "assign command.ticketId"),
    assigneeId:
      raw.assigneeId === null
        ? null
        : boundaryString(raw.assigneeId, "assign command.assigneeId"),
    ...(messageId === undefined ? {} : { messageId }),
    ...(body === undefined ? {} : { body }),
    ...(notification === undefined ? {} : { notification }),
  });
}

function snapshotChangePriorityCommand(
  input: ChangePriorityCommand,
): ChangePriorityCommand {
  const source = boundaryObject(input, "change priority command");
  const raw = {
    commandId: ownDataProperty(
      source,
      "commandId",
      "change priority command.commandId",
    ),
    correlationId: ownDataProperty(
      source,
      "correlationId",
      "change priority command.correlationId",
    ),
    ticketId: ownDataProperty(
      source,
      "ticketId",
      "change priority command.ticketId",
    ),
    priority: ownDataProperty(
      source,
      "priority",
      "change priority command.priority",
    ),
  };
  if (
    typeof raw.priority !== "string" ||
    !TICKET_PRIORITIES.includes(raw.priority as TicketPriority)
  ) {
    throw new TypeError(
      `change priority command.priority must be one of: ${TICKET_PRIORITIES.join(", ")}`,
    );
  }
  return Object.freeze({
    ...snapshotRevisionHint(source),
    commandId: boundaryString(
      raw.commandId,
      "change priority command.commandId",
    ),
    correlationId: boundaryString(
      raw.correlationId,
      "change priority command.correlationId",
    ),
    ticketId: boundaryString(raw.ticketId, "change priority command.ticketId"),
    priority: raw.priority as TicketPriority,
  });
}

function snapshotLifecycleTicketCommand(
  input: LifecycleTicketCommand,
  field: string,
): LifecycleTicketCommand {
  const source = boundaryObject(input, field);
  const raw = {
    commandId: ownDataProperty(source, "commandId", `${field}.commandId`),
    correlationId: ownDataProperty(
      source,
      "correlationId",
      `${field}.correlationId`,
    ),
    ticketId: ownDataProperty(source, "ticketId", `${field}.ticketId`),
    messageId: ownDataProperty(source, "messageId", `${field}.messageId`, true),
    body: ownDataProperty(source, "body", `${field}.body`, true),
    notification: ownDataProperty(
      source,
      "notification",
      `${field}.notification`,
      true,
    ),
  };
  const notification =
    raw.notification === undefined
      ? undefined
      : snapshotNotification(raw.notification);
  const messageId =
    raw.messageId === undefined
      ? undefined
      : boundaryString(raw.messageId, `${field}.messageId`);
  const body =
    raw.body === undefined
      ? undefined
      : boundaryString(raw.body, `${field}.body`);
  if (
    notification !== undefined ||
    messageId !== undefined ||
    body !== undefined
  ) {
    if (messageId === undefined || body === undefined) {
      throw new TypeError(
        `${field} requires messageId and body when recording a lifecycle message or notification`,
      );
    }
  }
  return Object.freeze({
    ...snapshotRevisionHint(source),
    commandId: boundaryString(raw.commandId, `${field}.commandId`),
    correlationId: boundaryString(raw.correlationId, `${field}.correlationId`),
    ticketId: boundaryString(raw.ticketId, `${field}.ticketId`),
    ...(messageId === undefined ? {} : { messageId }),
    ...(body === undefined ? {} : { body }),
    ...(notification === undefined ? {} : { notification }),
  });
}

function stableNotification(
  notification: NotificationInput | undefined,
): unknown {
  return notification ?? null;
}

async function requestFingerprint(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function isTerminalTicketStatus(status: TicketStatus): boolean {
  return status === "resolved" || status === "closed";
}

function terminalTimestamp(ticket: Ticket): IsoTimestamp {
  if (ticket.status === "resolved") {
    return ticket.resolvedAt ?? ticket.updatedAt;
  }
  if (ticket.status === "closed") {
    return ticket.closedAt ?? ticket.resolvedAt ?? ticket.updatedAt;
  }
  return ticket.updatedAt;
}

function ticketBeyondTerminalCutoff(
  ticket: Ticket,
  now: IsoTimestamp,
  terminalRetentionMilliseconds: number,
): boolean {
  if (!isTerminalTicketStatus(ticket.status)) {
    return false;
  }
  const nowEpoch = canonicalTimestamp(now, "clock.now()");
  const terminalEpoch = canonicalTimestamp(
    terminalTimestamp(ticket),
    "ticket terminal time",
  );
  return nowEpoch - terminalEpoch >= terminalRetentionMilliseconds;
}

function deriveQueueIndexRecord(ticket: Ticket): QueueIndexRecord {
  return {
    ticketId: ticket.id,
    ...staffLifecycleFields(ticket),
    id: "queue",
    projectedRevision: ticket.revision,
    state: isTerminalTicketStatus(ticket.status) ? "inactive" : "active",
    status: ticket.status,
    priority: ticket.priority,
    ...(ticket.category === undefined ? {} : { category: ticket.category }),
    requesterAssociation: ticket.requester.association,
    channel: ticket.channel,
    ...(ticket.assignedTo === undefined
      ? {}
      : { assignedTo: ticket.assignedTo }),
    updatedAt: ticket.updatedAt,
  };
}

function queueIndexContentEqual(
  left: QueueIndexRecord,
  right: QueueIndexRecord,
): boolean {
  return (
    left.ticketId === right.ticketId &&
    left.id === right.id &&
    left.projectedRevision === right.projectedRevision &&
    left.state === right.state &&
    left.status === right.status &&
    left.priority === right.priority &&
    left.category === right.category &&
    JSON.stringify(left.tags ?? []) === JSON.stringify(right.tags ?? []) &&
    left.firstResponseDueAt === right.firstResponseDueAt &&
    left.resolutionDueAt === right.resolutionDueAt &&
    left.firstStaffRespondedAt === right.firstStaffRespondedAt &&
    left.resolvedAt === right.resolvedAt &&
    left.requesterAssociation === right.requesterAssociation &&
    left.channel === right.channel &&
    left.assignedTo === right.assignedTo &&
    left.updatedAt === right.updatedAt
  );
}

function queueProjectionKey(ticketId: TicketId): EntityKey {
  return { partition: ticketId, id: "queue" };
}

export interface ProjectTicketToQueueOptions {
  readonly store: Store;
  readonly clock: Clock;
  /**
   * Shared terminal-retention cutoff used by projection, repair, and sweep.
   * Hosts must pass the same value to every worker invocation that they
   * configured on the application (no silent per-worker default).
   */
  readonly terminalRetentionMilliseconds: number;
  readonly maxConflictAttempts?: number;
}

/**
 * Load the authoritative ticket and project the entire queue row from it.
 *
 * Never accepts a caller-supplied `Ticket` snapshot. Accepts only a newer
 * revision or an identical equal-revision replay. Authoritative terminal
 * tickets beyond the shared retention cutoff keep the projection absent or
 * are conditionally deleted — they never recreate an inactive row.
 */
export async function projectTicketToQueue(
  ticketId: TicketId,
  options: ProjectTicketToQueueOptions,
): Promise<"written" | "kept" | "deleted" | "absent"> {
  requireIdentifier(ticketId, "ticketId");
  const source = boundaryObject(options, "projectTicketToQueue options");
  const store = ownDataProperty(
    source,
    "store",
    "projectTicketToQueue options.store",
  ) as Store;
  const clock = ownDataProperty(
    source,
    "clock",
    "projectTicketToQueue options.clock",
  ) as Clock;
  const rawRetention = ownDataProperty(
    source,
    "terminalRetentionMilliseconds",
    "projectTicketToQueue options.terminalRetentionMilliseconds",
  );
  const rawAttempts = ownDataProperty(
    source,
    "maxConflictAttempts",
    "projectTicketToQueue options.maxConflictAttempts",
    true,
  );
  if (typeof rawRetention !== "number") {
    throw new TypeError(
      "projectTicketToQueue options.terminalRetentionMilliseconds must be a number",
    );
  }
  const terminalRetentionMilliseconds = rawRetention;
  if (
    !Number.isSafeInteger(terminalRetentionMilliseconds) ||
    terminalRetentionMilliseconds < 0
  ) {
    throw new TypeError(
      "terminalRetentionMilliseconds must be a non-negative safe integer",
    );
  }
  const maxConflictAttempts =
    rawAttempts === undefined ? 4 : (rawAttempts as number);
  if (
    !Number.isSafeInteger(maxConflictAttempts) ||
    maxConflictAttempts <= 0 ||
    maxConflictAttempts > 20
  ) {
    throw new TypeError("maxConflictAttempts must be between 1 and 20");
  }

  const records = store.collection(supportRecords);
  const projections = store.collection(queueIndex);
  const ticketRecord = await records.get(ticketKey(ticketId));
  if (ticketRecord?.kind !== "ticket") {
    const existing = await projections.getVersioned(
      queueProjectionKey(ticketId),
    );
    if (existing === null) {
      return "absent";
    }
    const removed = await projections.deleteIfUnchanged(
      queueProjectionKey(ticketId),
      existing.version,
    );
    return removed ? "deleted" : "kept";
  }

  const ticket = ticketRecord.ticket;
  if (ticket.id !== ticketId) {
    throw new TypeError("stored ticket id does not match its partition");
  }

  // Sample the host clock only for terminal retention. Active tickets never
  // consult wall time, so post-commit projection does not consume sequence
  // clocks used by ticket mutations.
  if (isTerminalTicketStatus(ticket.status)) {
    const now = clock.now();
    if (
      ticketBeyondTerminalCutoff(ticket, now, terminalRetentionMilliseconds)
    ) {
      const existing = await projections.getVersioned(
        queueProjectionKey(ticketId),
      );
      if (existing === null) {
        return "absent";
      }
      // Only prune a projection that still matches this terminal revision.
      // A concurrent reopen can land a newer active row between the ticket
      // read and this delete; that row must be preserved for repair to see.
      if (existing.value.projectedRevision !== ticket.revision) {
        return "kept";
      }
      const removed = await projections.deleteIfUnchanged(
        queueProjectionKey(ticketId),
        existing.version,
      );
      return removed ? "deleted" : "kept";
    }
  }

  const derived = deriveQueueIndexRecord(ticket);
  const result = await projections.update(
    queueProjectionKey(ticketId),
    (current) => {
      if (current === null) {
        return { action: "write", value: derived };
      }
      if (current.ticketId !== ticketId || current.id !== "queue") {
        throw new TypeError("queue projection key does not match its payload");
      }
      if (current.projectedRevision > derived.projectedRevision) {
        return { action: "keep" };
      }
      if (current.projectedRevision < derived.projectedRevision) {
        return { action: "write", value: derived };
      }
      if (queueIndexContentEqual(current, derived)) {
        return { action: "keep" };
      }
      // Pre-Task-13 rows have none of these additive staff fields. Enrich
      // only that exact legacy shape from freshly loaded authoritative state.
      const {
        tags: _tags,
        firstResponseDueAt: _first,
        resolutionDueAt: _due,
        firstStaffRespondedAt: _responded,
        resolvedAt: _resolved,
        ...legacy
      } = derived;
      if (queueIndexContentEqual(current, legacy))
        return { action: "write", value: derived };
      throw new SupportDeskConflictError(
        "Queue projection revision collision with divergent content",
      );
    },
    { maxAttempts: maxConflictAttempts },
  );
  return result.written ? "written" : "kept";
}

function toStaffQueueItem(ticket: Ticket): StaffQueueItem {
  return Object.freeze({
    ticketId: ticket.id,
    ...staffLifecycleFields(ticket),
    revision: ticket.revision,
    status: ticket.status,
    priority: ticket.priority,
    ...(ticket.category === undefined ? {} : { category: ticket.category }),
    requesterAssociation: ticket.requester.association,
    channel: ticket.channel,
    ...(ticket.assignedTo === undefined
      ? {}
      : { assignedTo: ticket.assignedTo }),
    updatedAt: ticket.updatedAt,
  });
}

function normalizeFilterList<T extends string>(
  value: T | readonly T[] | undefined,
): ReadonlySet<T> | undefined {
  if (value === undefined) {
    return undefined;
  }
  return new Set(Array.isArray(value) ? value : [value as T]);
}

function staffQueueItemMatches(
  item: StaffQueueItem,
  query: StaffQueueQuery,
  now: number | undefined,
): boolean {
  if (query.tag !== undefined && !(item.tags ?? []).includes(query.tag))
    return false;
  if (query.targetState !== undefined) {
    const due = pendingTargetDue(item, query.target);
    if (due === undefined || now === undefined) return false;
    const epoch = canonicalTimestamp(due, "ticket target");
    if (
      query.targetState === "overdue"
        ? epoch >= now
        : epoch < now || epoch - now > query.dueSoonMilliseconds!
    )
      return false;
  }
  const statuses = normalizeFilterList(query.status);
  if (statuses !== undefined && !statuses.has(item.status)) {
    return false;
  }
  const priorities = normalizeFilterList(query.priority);
  if (priorities !== undefined && !priorities.has(item.priority)) {
    return false;
  }
  const associations = normalizeFilterList(query.association);
  if (
    associations !== undefined &&
    !associations.has(item.requesterAssociation)
  ) {
    return false;
  }
  const channels = normalizeFilterList(query.channel);
  if (channels !== undefined && !channels.has(item.channel)) {
    return false;
  }
  if (query.unassignedOnly === true && item.assignedTo !== undefined) {
    return false;
  }
  if (
    query.assignedTo !== undefined &&
    (item.assignedTo === undefined || item.assignedTo !== query.assignedTo)
  ) {
    return false;
  }
  return true;
}

function pendingTargetDue(
  item: StaffQueueItem,
  target: StaffQueueQuery["target"],
): IsoTimestamp | undefined {
  return target === "first_response"
    ? item.firstStaffRespondedAt === undefined
      ? item.firstResponseDueAt
      : undefined
    : item.resolvedAt === undefined
      ? item.resolutionDueAt
      : undefined;
}

const QUEUE_FILTER_STATUSES: readonly Ticket["status"][] = [
  "open",
  "waiting_on_support",
  "waiting_on_customer",
  "resolved",
  "closed",
];
const QUEUE_FILTER_PRIORITIES: readonly TicketPriority[] = [
  "low",
  "normal",
  "high",
  "urgent",
];
const QUEUE_FILTER_ASSOCIATIONS = [
  "authenticated",
  "matched_email",
  "unverified",
] as const;
const QUEUE_FILTER_CHANNELS = ["web", "email", "api"] as const;

function snapshotEnumOrEnumArray<T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[],
): T | readonly T[] {
  const allow = (candidate: string): T => {
    if (!(allowed as readonly string[]).includes(candidate)) {
      throw new TypeError(`${field} must be one of: ${allowed.join(", ")}`);
    }
    return candidate as T;
  };
  if (typeof value === "string") {
    return allow(value);
  }
  if (Array.isArray(value)) {
    const items: T[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const item = ownDataProperty(value, index, `${field}[${index}]`);
      if (typeof item !== "string") {
        throw new TypeError(`${field} must be a string or an array of strings`);
      }
      items.push(allow(item));
    }
    return items;
  }
  throw new TypeError(`${field} must be a string or an array of strings`);
}

function snapshotStaffQueueQuery(input: unknown): StaffQueueQuery {
  if (input === undefined) {
    return Object.freeze({});
  }
  const source = boundaryObject(input, "staff queue query");
  const readOptional = (key: keyof StaffQueueQuery): unknown =>
    ownDataProperty(source, key, `staff queue query.${key}`, true);

  const status = readOptional("status");
  const priority = readOptional("priority");
  const association = readOptional("association");
  const channel = readOptional("channel");
  const assignedTo = readOptional("assignedTo");
  const unassignedOnly = readOptional("unassignedOnly");
  const sort = readOptional("sort");
  const rawTag = readOptional("tag");
  const tag = rawTag === undefined ? undefined : normalizedTag(rawTag);
  const target = readOptional("target");
  const targetState = readOptional("targetState");
  const dueSoonMilliseconds = readOptional("dueSoonMilliseconds");
  if (
    target !== undefined &&
    target !== "first_response" &&
    target !== "resolution"
  )
    throw new TypeError("invalid queue target");
  if (
    targetState !== undefined &&
    targetState !== "overdue" &&
    targetState !== "due_soon"
  )
    throw new TypeError("invalid queue targetState");
  if (
    dueSoonMilliseconds !== undefined &&
    (typeof dueSoonMilliseconds !== "number" ||
      !Number.isSafeInteger(dueSoonMilliseconds) ||
      dueSoonMilliseconds < 0 ||
      dueSoonMilliseconds > 30 * 86_400_000)
  )
    throw new TypeError("dueSoonMilliseconds must be between 0 and 30 days");
  if (targetState === "due_soon" && dueSoonMilliseconds === undefined)
    throw new TypeError("due_soon requires dueSoonMilliseconds");
  if (targetState !== "due_soon" && dueSoonMilliseconds !== undefined)
    throw new TypeError("dueSoonMilliseconds requires targetState due_soon");

  if (assignedTo !== undefined) {
    if (typeof assignedTo !== "string") {
      throw new TypeError("staff queue query.assignedTo must be a string");
    }
    requireIdentifier(assignedTo, "staff queue query.assignedTo");
  }
  if (unassignedOnly !== undefined && typeof unassignedOnly !== "boolean") {
    throw new TypeError("staff queue query.unassignedOnly must be a boolean");
  }
  if (
    sort !== undefined &&
    sort !== "updated_newest" &&
    sort !== "updated_oldest" &&
    sort !== "due_soonest" &&
    sort !== "due_latest"
  ) {
    throw new TypeError("invalid staff queue query.sort");
  }

  const query: StaffQueueQuery = {
    ...(tag === undefined ? {} : { tag }),
    ...(target === undefined ? {} : { target }),
    ...(targetState === undefined ? {} : { targetState }),
    ...(dueSoonMilliseconds === undefined
      ? {}
      : { dueSoonMilliseconds: dueSoonMilliseconds as number }),
  };
  if (status !== undefined) {
    (query as { status?: StaffQueueQuery["status"] }).status =
      snapshotEnumOrEnumArray(
        status,
        "staff queue query.status",
        QUEUE_FILTER_STATUSES,
      );
  }
  if (priority !== undefined) {
    (query as { priority?: StaffQueueQuery["priority"] }).priority =
      snapshotEnumOrEnumArray(
        priority,
        "staff queue query.priority",
        QUEUE_FILTER_PRIORITIES,
      );
  }
  if (association !== undefined) {
    (query as { association?: StaffQueueQuery["association"] }).association =
      snapshotEnumOrEnumArray(
        association,
        "staff queue query.association",
        QUEUE_FILTER_ASSOCIATIONS,
      );
  }
  if (channel !== undefined) {
    (query as { channel?: StaffQueueQuery["channel"] }).channel =
      snapshotEnumOrEnumArray(
        channel,
        "staff queue query.channel",
        QUEUE_FILTER_CHANNELS,
      );
  }
  if (assignedTo !== undefined) {
    (query as { assignedTo?: PrincipalId }).assignedTo =
      assignedTo as PrincipalId;
  }
  if (unassignedOnly !== undefined) {
    (query as { unassignedOnly?: boolean }).unassignedOnly =
      unassignedOnly as boolean;
  }
  if (sort !== undefined) {
    (query as { sort?: StaffQueueQuery["sort"] }).sort =
      sort as StaffQueueQuery["sort"];
  }
  return Object.freeze(query);
}

/**
 * Scan one page of authoritative `support-desk.records.v1` rows and project
 * every ticket found. Hosts persist `nextCursor` only after this call returns
 * successfully for the whole page.
 */
export async function repairQueueProjectionPage(
  options: ProjectTicketToQueueOptions & QueueRepairPageOptions,
): Promise<QueueRepairPageResult> {
  const source = boundaryObject(options, "queue repair page options");
  const store = ownDataProperty(
    source,
    "store",
    "queue repair page options.store",
  ) as Store;
  const clock = ownDataProperty(
    source,
    "clock",
    "queue repair page options.clock",
  ) as Clock;
  const rawCursor = ownDataProperty(
    source,
    "cursor",
    "queue repair page options.cursor",
    true,
  );
  const rawLimit = ownDataProperty(
    source,
    "limit",
    "queue repair page options.limit",
    true,
  );
  const rawRetention = ownDataProperty(
    source,
    "terminalRetentionMilliseconds",
    "queue repair page options.terminalRetentionMilliseconds",
  );
  const rawAttempts = ownDataProperty(
    source,
    "maxConflictAttempts",
    "queue repair page options.maxConflictAttempts",
    true,
  );
  if (rawCursor !== undefined && typeof rawCursor !== "string") {
    throw new TypeError("queue repair page options.cursor must be a string");
  }
  if (typeof rawRetention !== "number") {
    throw new TypeError(
      "queue repair page options.terminalRetentionMilliseconds must be a number",
    );
  }
  const limit = rawLimit === undefined ? 100 : (rawLimit as number);
  if (
    !Number.isSafeInteger(limit) ||
    limit <= 0 ||
    limit > MAX_SCAN_PAGE_SIZE
  ) {
    throw new TypeError(
      `queue repair page options.limit must be between 1 and ${MAX_SCAN_PAGE_SIZE}`,
    );
  }

  const records = store.collection(supportRecords);
  const page = await records.scan({
    limit,
    ...(rawCursor === undefined ? {} : { cursor: rawCursor as string }),
  });
  let projected = 0;
  for (const entry of page.records) {
    if (entry.value.kind !== "ticket") {
      continue;
    }
    if (
      entry.key.id !== "ticket" ||
      entry.key.partition !== entry.value.partition
    ) {
      continue;
    }
    await projectTicketToQueue(entry.value.ticket.id, {
      store,
      clock,
      terminalRetentionMilliseconds: rawRetention,
      ...(rawAttempts === undefined
        ? {}
        : { maxConflictAttempts: rawAttempts as number }),
    });
    projected += 1;
  }
  return {
    nextCursor: page.nextCursor,
    physicalRows: page.records.length,
    projected,
  };
}

/**
 * Sweep inactive queue rows only after reloading the authoritative ticket and
 * confirming it is still terminal beyond the shared retention cutoff, then
 * `deleteIfUnchanged`.
 */
export async function sweepInactiveQueueProjections(
  options: ProjectTicketToQueueOptions & QueueInactiveSweepOptions,
): Promise<QueueInactiveSweepResult> {
  const source = boundaryObject(options, "queue inactive sweep options");
  const store = ownDataProperty(
    source,
    "store",
    "queue inactive sweep options.store",
  ) as Store;
  const clock = ownDataProperty(
    source,
    "clock",
    "queue inactive sweep options.clock",
  ) as Clock;
  const rawCursor = ownDataProperty(
    source,
    "cursor",
    "queue inactive sweep options.cursor",
    true,
  );
  const rawLimit = ownDataProperty(
    source,
    "limit",
    "queue inactive sweep options.limit",
    true,
  );
  const rawRetention = ownDataProperty(
    source,
    "terminalRetentionMilliseconds",
    "queue inactive sweep options.terminalRetentionMilliseconds",
  );
  if (rawCursor !== undefined && typeof rawCursor !== "string") {
    throw new TypeError("queue inactive sweep options.cursor must be a string");
  }
  if (typeof rawRetention !== "number") {
    throw new TypeError(
      "queue inactive sweep options.terminalRetentionMilliseconds must be a number",
    );
  }
  const limit = rawLimit === undefined ? 100 : (rawLimit as number);
  if (
    !Number.isSafeInteger(limit) ||
    limit <= 0 ||
    limit > MAX_SCAN_PAGE_SIZE
  ) {
    throw new TypeError(
      `queue inactive sweep options.limit must be between 1 and ${MAX_SCAN_PAGE_SIZE}`,
    );
  }
  const terminalRetentionMilliseconds = rawRetention;
  if (
    !Number.isSafeInteger(terminalRetentionMilliseconds) ||
    terminalRetentionMilliseconds < 0
  ) {
    throw new TypeError(
      "terminalRetentionMilliseconds must be a non-negative safe integer",
    );
  }

  const projections = store.collection(queueIndex);
  const records = store.collection(supportRecords);
  const page = await projections.scan({
    limit,
    ...(rawCursor === undefined ? {} : { cursor: rawCursor as string }),
  });
  const now = clock.now();
  let deleted = 0;
  for (const entry of page.records) {
    if (entry.value.state !== "inactive") {
      continue;
    }
    if (
      entry.key.partition !== entry.value.ticketId ||
      entry.key.id !== "queue"
    ) {
      continue;
    }
    const ticketRecord = await records.get(ticketKey(entry.value.ticketId));
    if (ticketRecord?.kind !== "ticket") {
      if (
        await projections.deleteIfUnchanged(
          queueProjectionKey(entry.value.ticketId),
          entry.version,
        )
      ) {
        deleted += 1;
      }
      continue;
    }
    if (
      !ticketBeyondTerminalCutoff(
        ticketRecord.ticket,
        now,
        terminalRetentionMilliseconds,
      )
    ) {
      continue;
    }
    if (
      await projections.deleteIfUnchanged(
        queueProjectionKey(entry.value.ticketId),
        entry.version,
      )
    ) {
      deleted += 1;
    }
  }
  return {
    nextCursor: page.nextCursor,
    physicalRows: page.records.length,
    deleted,
  };
}

const supportDeskLimitMaximums: Readonly<
  Record<keyof SupportDeskLimits, number>
> = Object.freeze({
  maxSubjectCharacters: 1_000,
  maxMessageCharacters: 20_000,
  maxTicketsPerPrincipal: 1_000,
  maxMessagesPerTicket: 100,
  maxRecordsPerTicket: 2_000,
});

/** Merge validated host overrides onto the defaults and enforce maxima. */
function resolveSupportDeskLimits(
  rawLimits: unknown,
  field: string,
): SupportDeskLimits {
  const limitOverrides: {
    -readonly [Field in keyof SupportDeskLimits]?: number;
  } = {};
  if (rawLimits !== undefined) {
    const limitSource = boundaryObject(rawLimits, field);
    for (const name of [
      "maxSubjectCharacters",
      "maxMessageCharacters",
      "maxTicketsPerPrincipal",
      "maxMessagesPerTicket",
      "maxRecordsPerTicket",
    ] as const) {
      const value = ownDataProperty(
        limitSource,
        name,
        `${field}.${name}`,
        true,
      );
      if (value !== undefined) {
        if (typeof value !== "number") {
          throw new TypeError(`${field}.${name} must be a number`);
        }
        limitOverrides[name] = value;
      }
    }
  }
  const limits = { ...defaultSupportDeskLimits, ...limitOverrides };
  for (const name of Object.keys(limits) as (keyof SupportDeskLimits)[]) {
    const value = limits[name];
    if (
      !Number.isSafeInteger(value) ||
      value <= 0 ||
      value > supportDeskLimitMaximums[name]
    ) {
      throw new TypeError(
        `${name} must be a positive safe integer no greater than ${supportDeskLimitMaximums[name]}`,
      );
    }
  }
  return Object.freeze(limits);
}

/**
 * Reserve the next instance-scoped ticket number outside any ticket
 * transaction. A later failure leaves a gap; a duplicate is impossible.
 */
async function reserveNextTicketNumber(
  numbers: CollectionStore<TicketNumberRecord>,
  maxConflictAttempts: number,
): Promise<number> {
  const result = await numbers.update(
    { partition: ticketNumberPartition, id: ticketNumberRecordId },
    (current) => {
      const lastIssued = current?.lastIssued ?? 0;
      if (!Number.isSafeInteger(lastIssued) || lastIssued < 0) {
        throw new SupportDeskConflictError("Ticket number counter is corrupt");
      }
      if (lastIssued >= Number.MAX_SAFE_INTEGER) {
        throw new SupportDeskConflictError(
          "Ticket number sequence is exhausted",
        );
      }
      return {
        action: "write",
        value: { lastIssued: lastIssued + 1 },
      };
    },
    { maxAttempts: maxConflictAttempts },
  );
  const issued = result.value?.lastIssued;
  if (issued === undefined || !Number.isSafeInteger(issued) || issued <= 0) {
    throw new SupportDeskConflictError("Ticket number was not reserved");
  }
  return issued;
}

export function createSupportDeskApplication(options: {
  readonly store: Store;
  readonly clock: Clock;
  readonly logger?: Logger;
  readonly limits?: Partial<SupportDeskLimits>;
  readonly maxConflictAttempts?: number;
  /**
   * Shared terminal-retention cutoff for queue projection, repair, and
   * inactive-row sweeping (milliseconds). Defaults to 30 days.
   */
  readonly queueTerminalRetentionMilliseconds?: number;
  /** Online staff queue scan budgets. */
  readonly queueScanBudgets?: Partial<QueueScanBudgets>;
  /**
   * Frozen, deduplicated host allowlist for optional ticket categories.
   * At most 32 values matching `^[a-z][a-z0-9_]{0,31}$`.
   */
  readonly allowedCategories?: readonly string[];
  /** At most 32 normalized, deduplicated staff labels; absent disables adding tags. */
  readonly allowedTags?: readonly string[];
  /** Default 8, hard maximum 32. Empty tags always clear the ticket. */
  readonly maxTagsPerTicket?: number;
  readonly responseTargetPolicy?: ResponseTargetPolicy;
}): SupportDeskApplication {
  const source = boundaryObject(options, "application options");
  const store = ownDataProperty(
    source,
    "store",
    "application options.store",
  ) as Store;
  const clock = ownDataProperty(
    source,
    "clock",
    "application options.clock",
  ) as Clock;
  const rawLogger = ownDataProperty(
    source,
    "logger",
    "application options.logger",
    true,
  );
  const logger = rawLogger === undefined ? noopLogger : (rawLogger as Logger);
  const rawLimits = ownDataProperty(
    source,
    "limits",
    "application options.limits",
    true,
  );
  const rawMaxConflictAttempts = ownDataProperty(
    source,
    "maxConflictAttempts",
    "application options.maxConflictAttempts",
    true,
  );
  const rawTerminalRetention = ownDataProperty(
    source,
    "queueTerminalRetentionMilliseconds",
    "application options.queueTerminalRetentionMilliseconds",
    true,
  );
  const rawQueueBudgets = ownDataProperty(
    source,
    "queueScanBudgets",
    "application options.queueScanBudgets",
    true,
  );
  const allowedCategories = parseAllowedCategories(
    ownDataProperty(
      source,
      "allowedCategories",
      "application options.allowedCategories",
      true,
    ),
  );
  const rawTags = ownDataProperty(source, "allowedTags", "allowedTags", true);
  const allowedTags = new Set(
    rawTags === undefined ? [] : snapshotTags(rawTags),
  );
  const rawMaxTags = ownDataProperty(
    source,
    "maxTagsPerTicket",
    "maxTagsPerTicket",
    true,
  );
  const maxTagsPerTicket = rawMaxTags === undefined ? 8 : rawMaxTags;
  if (
    typeof maxTagsPerTicket !== "number" ||
    !Number.isSafeInteger(maxTagsPerTicket) ||
    maxTagsPerTicket < 1 ||
    maxTagsPerTicket > 32
  ) {
    throw new TypeError("maxTagsPerTicket must be between 1 and 32");
  }
  const responseTargetPolicy = parseResponseTargetPolicy(
    ownDataProperty(
      source,
      "responseTargetPolicy",
      "responseTargetPolicy",
      true,
    ),
  );
  if (
    rawMaxConflictAttempts !== undefined &&
    typeof rawMaxConflictAttempts !== "number"
  ) {
    throw new TypeError(
      "application options.maxConflictAttempts must be a number",
    );
  }
  const records = store.collection(supportRecords);
  const index = store.collection(customerTicketIndex);
  const numbers = store.collection(ticketNumbers);
  const projections = store.collection(queueIndex);
  const limits = resolveSupportDeskLimits(
    rawLimits,
    "application options.limits",
  );
  const maxConflictAttempts = rawMaxConflictAttempts ?? 4;
  if (
    !Number.isSafeInteger(maxConflictAttempts) ||
    maxConflictAttempts <= 0 ||
    maxConflictAttempts > 20
  ) {
    throw new TypeError("maxConflictAttempts must be between 1 and 20");
  }
  const terminalRetentionMilliseconds =
    rawTerminalRetention === undefined
      ? defaultQueueTerminalRetentionMilliseconds
      : (rawTerminalRetention as number);
  if (
    !Number.isSafeInteger(terminalRetentionMilliseconds) ||
    terminalRetentionMilliseconds < 0
  ) {
    throw new TypeError(
      "queueTerminalRetentionMilliseconds must be a non-negative safe integer",
    );
  }
  const queueBudgetOverrides: {
    -readonly [Field in keyof QueueScanBudgets]?: number;
  } = {};
  if (rawQueueBudgets !== undefined) {
    const budgetSource = boundaryObject(
      rawQueueBudgets,
      "application options.queueScanBudgets",
    );
    for (const field of [
      "maxPhysicalRows",
      "maxScanPages",
      "maxActiveResults",
      "scanPageSize",
    ] as const) {
      const value = ownDataProperty(
        budgetSource,
        field,
        `application options.queueScanBudgets.${field}`,
        true,
      );
      if (value !== undefined) {
        if (typeof value !== "number") {
          throw new TypeError(
            `application options.queueScanBudgets.${field} must be a number`,
          );
        }
        queueBudgetOverrides[field] = value;
      }
    }
  }
  const queueBudgets: QueueScanBudgets = {
    ...defaultQueueScanBudgets,
    ...queueBudgetOverrides,
  };
  if (
    !Number.isSafeInteger(queueBudgets.scanPageSize) ||
    queueBudgets.scanPageSize <= 0 ||
    queueBudgets.scanPageSize > MAX_SCAN_PAGE_SIZE
  ) {
    throw new TypeError(
      `queueScanBudgets.scanPageSize must be between 1 and ${MAX_SCAN_PAGE_SIZE}`,
    );
  }
  for (const field of [
    "maxPhysicalRows",
    "maxScanPages",
    "maxActiveResults",
  ] as const) {
    const value = queueBudgets[field];
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(
        `queueScanBudgets.${field} must be a positive safe integer`,
      );
    }
  }

  let projectionHealth: QueueProjectionHealth = Object.freeze({
    consecutiveFailures: 0,
  });

  async function safeProjectQueue(ticketId: TicketId): Promise<void> {
    try {
      await projectTicketToQueue(ticketId, {
        store,
        clock,
        terminalRetentionMilliseconds,
        maxConflictAttempts,
      });
      // Health success does not sample the host clock: ticket mutations and
      // sequence-clock tests must not observe projection bookkeeping as time.
      projectionHealth = Object.freeze({
        consecutiveFailures: 0,
        ...(projectionHealth.lastFailureAt === undefined
          ? {}
          : {
              lastFailureAt: projectionHealth.lastFailureAt,
              lastFailureTicketId: projectionHealth.lastFailureTicketId,
              lastFailureMessage: projectionHealth.lastFailureMessage,
            }),
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "queue projection failed";
      // Failure diagnostics must never fail a committed command response.
      let lastFailureAt: IsoTimestamp | undefined;
      try {
        lastFailureAt = clock.now();
      } catch {
        lastFailureAt = undefined;
      }
      projectionHealth = Object.freeze({
        consecutiveFailures: projectionHealth.consecutiveFailures + 1,
        ...(lastFailureAt === undefined ? {} : { lastFailureAt }),
        lastFailureTicketId: ticketId,
        lastFailureMessage: message,
      });
      try {
        logger.log("error", "support-desk.queue.projection_failed", {
          ticketId,
          message,
        });
      } catch {
        // ignore logger transport failures
      }
    }
  }

  /**
   * Best-effort post-commit threading index writes. Never fails a committed
   * command; `repairThreadIndexPage` converges anything missed. Does not
   * sample the host clock.
   */
  async function safeIndexThreading(
    ticketId: TicketId,
    threading: ThreadingHint | undefined,
  ): Promise<void> {
    if (
      threading === undefined ||
      (threading.messageId === undefined && threading.ticketNumber !== true)
    ) {
      return;
    }
    await indexThreadingAfterCommit(store, ticketId, threading, logger);
  }

  async function customerViewAfterChange(
    principalId: PrincipalId,
    ticketId: TicketId,
    threading?: ThreadingHint,
  ): Promise<CustomerTicketView> {
    await safeProjectQueue(ticketId);
    await safeIndexThreading(ticketId, threading);
    return authoritativeView(
      records,
      principalId,
      ticketId,
      limits.maxRecordsPerTicket,
    );
  }

  async function staffCommandResult(
    ticketId: TicketId,
    commandId: string,
    threading?: ThreadingHint,
  ): Promise<StaffTicketView> {
    await safeProjectQueue(ticketId);
    await safeIndexThreading(ticketId, threading);
    const receipt = await records.get(commandKey(ticketId, commandId));
    if (receipt?.kind !== "command" || receipt.resultTicket === undefined) {
      // Pre-Task-13 receipts retain their existing replay behavior.
      return staffAuthoritativeView(
        records,
        ticketId,
        limits.maxRecordsPerTicket,
      );
    }
    const rows = await records.list(ticketId);
    enforcePartitionRecordLimit(rows.length, limits.maxRecordsPerTicket);
    return {
      ticket: receipt.resultTicket,
      messages: staffMessages(
        rows.filter(
          (row) =>
            row.kind !== "message" ||
            row.ordinal <= receipt.resultTicket!.revision,
        ),
      ),
    };
  }

  async function checkStaffRevision(
    ticket: Ticket,
    command: StaffRevisionHint & {
      readonly ticketId: TicketId;
      readonly commandId: string;
    },
    fingerprint: string,
  ): Promise<boolean> {
    if (
      command.expectedRevision === undefined ||
      command.expectedRevision === ticket.revision
    )
      return false;
    // A commit may race the first receipt read. Replay wins over a stale hint.
    const receipt = await records.get(
      commandKey(command.ticketId, command.commandId),
    );
    if (
      receipt?.kind === "command" &&
      receipt.requestFingerprint === fingerprint
    )
      return true;
    if (receipt !== null)
      throw new SupportDeskConflictError(
        "Command ID reused with different input",
      );
    requireExpectedRevision(ticket, command);
    return false;
  }

  async function staffConflictResult(
    command: StaffRevisionHint & {
      readonly ticketId: TicketId;
      readonly commandId: string;
      readonly messageId?: MessageId;
      readonly notification?: NotificationInput;
    },
    fingerprint: string,
  ): Promise<StaffTicketView> {
    const receipt = await records.get(
      commandKey(command.ticketId, command.commandId),
    );
    if (
      receipt?.kind === "command" &&
      receipt.requestFingerprint === fingerprint
    )
      return staffCommandResult(
        command.ticketId,
        command.commandId,
        notificationThreading(command),
      );
    if (receipt !== null)
      throw new SupportDeskConflictError(
        "Command ID reused with different input",
      );
    const current = await records.get(ticketKey(command.ticketId));
    if (
      current?.kind === "ticket" &&
      (await checkStaffRevision(current.ticket, command, fingerprint))
    )
      return staffCommandResult(
        command.ticketId,
        command.commandId,
        notificationThreading(command),
      );
    throw new SupportDeskConflictError();
  }

  async function reserveCustomerTicket(
    principalId: PrincipalId,
    ticketId: TicketId,
    reservedAt: IsoTimestamp,
  ): Promise<CustomerTicketIndexEntry> {
    requireIdentifier(principalId, "principalId");
    requireIdentifier(ticketId, "ticketId");
    canonicalTimestamp(reservedAt, "reservedAt");
    const observedFence = await records.get(ticketReservationKey(ticketId));
    const nextGeneration =
      observedFence?.kind === "ticket_reservation"
        ? observedFence.generation + 1
        : 1;
    if (!Number.isSafeInteger(nextGeneration)) {
      throw new SupportDeskConflictError(
        "Customer ticket reservation generation is exhausted",
      );
    }
    const newToken = crypto.randomUUID();
    const result = await index.update(
      { partition: principalId, id: "tickets" },
      (current) => {
        if (current === null) {
          return {
            action: "write",
            value: {
              principalId,
              entries: [
                {
                  ticketId,
                  reservationToken: newToken,
                  reservationGeneration: nextGeneration,
                  reservedAt,
                  state: "reserved",
                },
              ],
            },
          };
        }
        if (current.entries.some((entry) => entry.ticketId === ticketId)) {
          return { action: "keep" };
        }
        if (current.entries.length >= limits.maxTicketsPerPrincipal) {
          throw new SupportDeskLimitError(
            "customer_tickets",
            limits.maxTicketsPerPrincipal,
          );
        }
        return {
          action: "write",
          value: {
            ...current,
            entries: [
              ...current.entries,
              {
                ticketId,
                reservationToken: newToken,
                reservationGeneration: nextGeneration,
                reservedAt,
                state: "reserved",
              },
            ],
          },
        };
      },
      { maxAttempts: maxConflictAttempts },
    );
    const reservation = result.value?.entries.find(
      (entry) => entry.ticketId === ticketId,
    );
    if (reservation === undefined) {
      throw new SupportDeskConflictError(
        "Customer ticket reservation was not stored",
      );
    }
    const fence = await records.get(ticketReservationKey(ticketId));
    if (
      reservation.state === "reserved" &&
      fence?.kind === "ticket_reservation" &&
      fence.state === "cancelled" &&
      fence.generation >= reservation.reservationGeneration
    ) {
      throw new SupportDeskConflictError(
        "Customer ticket reservation cancellation is still being finalized",
      );
    }
    return reservation;
  }

  async function confirmCustomerTicket(
    principalId: PrincipalId,
    ticketId: TicketId,
    reservationToken: string,
    reservationGeneration: number,
  ): Promise<void> {
    const result = await index.update(
      { partition: principalId, id: "tickets" },
      (current) => {
        if (current === null) {
          return { action: "keep" };
        }
        const entry = current.entries.find(
          (candidate) => candidate.ticketId === ticketId,
        );
        if (
          entry === undefined ||
          entry.reservationToken !== reservationToken ||
          entry.reservationGeneration !== reservationGeneration
        ) {
          return { action: "keep" };
        }
        if (entry.state === "confirmed") {
          return { action: "keep" };
        }
        return {
          action: "write",
          value: {
            ...current,
            entries: current.entries.map((candidate) =>
              candidate.ticketId === ticketId
                ? { ...candidate, state: "confirmed" as const }
                : candidate,
            ),
          },
        };
      },
      { maxAttempts: maxConflictAttempts },
    );
    const confirmed = result.value?.entries.find(
      (entry) =>
        entry.ticketId === ticketId &&
        entry.reservationToken === reservationToken &&
        entry.reservationGeneration === reservationGeneration &&
        entry.state === "confirmed",
    );
    if (confirmed === undefined) {
      throw new SupportDeskConflictError(
        "Committed ticket reservation could not be confirmed",
      );
    }
  }

  async function reserveTicketNumber(): Promise<number> {
    return reserveNextTicketNumber(numbers, maxConflictAttempts);
  }

  return {
    async createCustomerTicket(access, input) {
      requirePermission(access, supportPermissions.create);
      requireIdentifier(access.principalId, "principalId");
      const command = snapshotCreateCustomerTicketCommand(input);
      requireIdentifier(command.ticketId, "ticketId");
      requireIdentifier(command.messageId, "messageId");
      requireIdentifier(command.commandId, "commandId");
      requireIdentifier(command.correlationId, "correlationId");
      enforceLimit(command.subject, "subject", limits.maxSubjectCharacters);
      enforceLimit(command.body, "body", limits.maxMessageCharacters);
      const fingerprintPayload = {
        type: "create_customer_ticket" as const,
        ticketId: command.ticketId,
        messageId: command.messageId,
        subject: command.subject,
        body: command.body,
        // Omit absent category so pre-category receipts still match retries.
        ...(command.category === undefined
          ? {}
          : { category: command.category }),
        requesterEmail: command.requesterEmail ?? null,
        notification: stableNotification(command.notification),
      };
      const fingerprint = await requestFingerprint(fingerprintPayload);
      const createThreading: ThreadingHint = {
        ticketNumber: true,
        ...(command.notification === undefined
          ? {}
          : { messageId: command.messageId }),
      };
      // Replay an already committed create before host allowlist checks so a
      // later config change cannot break idempotent retries of the same command.
      // Replay never reserves another instance ticket number.
      const existingCreate = await records.get(
        commandKey(command.ticketId, command.commandId),
      );
      let createIsReplay = duplicateMatches(
        existingCreate,
        "create_customer_ticket",
        command.messageId,
        fingerprint,
      );
      if (
        !createIsReplay &&
        existingCreate?.kind === "command" &&
        existingCreate.commandType === "create_customer_ticket" &&
        existingCreate.messageId === command.messageId
      ) {
        // Pre-Task-3 receipts included ticketNumber in the fingerprint.
        const existingTicket = await records.get(ticketKey(command.ticketId));
        if (existingTicket?.kind === "ticket") {
          // Pre-Task-3 hashed ticketNumber immediately after ticketId.
          const legacyFingerprint = await requestFingerprint({
            type: fingerprintPayload.type,
            ticketId: fingerprintPayload.ticketId,
            ticketNumber: existingTicket.ticket.number,
            messageId: fingerprintPayload.messageId,
            subject: fingerprintPayload.subject,
            body: fingerprintPayload.body,
            ...(command.category === undefined
              ? {}
              : { category: command.category }),
            requesterEmail: fingerprintPayload.requesterEmail,
            notification: fingerprintPayload.notification,
          });
          createIsReplay = duplicateMatches(
            existingCreate,
            "create_customer_ticket",
            command.messageId,
            legacyFingerprint,
          );
        }
      }
      if (createIsReplay) {
        // A crash after ticket commit and before index confirmation must still
        // converge the principal hint on retry.
        const fence = await records.get(ticketReservationKey(command.ticketId));
        if (
          fence?.kind === "ticket_reservation" &&
          fence.state === "committed"
        ) {
          await confirmCustomerTicket(
            access.principalId,
            command.ticketId,
            fence.token,
            fence.generation,
          );
        }
        return customerViewAfterChange(
          access.principalId,
          command.ticketId,
          createThreading,
        );
      }
      if (command.category !== undefined) {
        if (
          allowedCategories === undefined ||
          !allowedCategories.has(command.category)
        ) {
          throw new TypeError(
            "create command.category is not configured for this Support Desk instance",
          );
        }
      }

      // Fail closed before durable number/index reservation so a too-small
      // partition budget cannot exhaust the principal ticket index with
      // reserved-but-never-created tickets.
      const estimatedCreateRows =
        6 + // ticket, quota, reservation, message, audit, command
        (command.notification === undefined ? 0 : 1);
      enforcePartitionRecordLimit(
        0,
        limits.maxRecordsPerTicket,
        estimatedCreateRows,
      );

      // Reserve outside the ticket transaction; gaps are accepted if create fails.
      const ticketNumber = await reserveTicketNumber();
      // Bind host-supplied notification content to the reserved number so mail
      // cannot advertise a guessed ticket number.
      const notification =
        command.notification === undefined
          ? undefined
          : bindNotificationTicketNumber(command.notification, ticketNumber);
      const now = clock.now();
      const ticket = await applyResponseTargets(
        createTicket({
          id: command.ticketId,
          number: ticketNumber,
          subject: command.subject,
          channel: "web",
          ...(command.category === undefined
            ? {}
            : { category: command.category }),
          requester: {
            association: "authenticated",
            principalId: access.principalId,
            ...(command.requesterEmail === undefined
              ? {}
              : { email: command.requesterEmail }),
          },
          createdAt: now,
        }),
        responseTargetPolicy,
        "created",
      );
      const message: TicketMessage = {
        id: command.messageId,
        ticketId: command.ticketId,
        authorKind: "customer",
        authorPrincipalId: access.principalId,
        channel: "web",
        visibility: "customer",
        format: "plain_text",
        body: command.body,
        createdAt: now,
      };
      const notificationJob =
        notification === undefined
          ? undefined
          : deliveryJobAction(
              command.ticketId,
              command.messageId,
              now,
              notification,
            );
      const notificationContent = deliveryContent(notification);
      const reservation = await reserveCustomerTicket(
        access.principalId,
        command.ticketId,
        now,
      );
      const existingReservation = await records.getVersioned(
        ticketReservationKey(command.ticketId),
      );
      if (
        existingReservation?.value.kind === "ticket_reservation" &&
        existingReservation.value.state === "committed" &&
        (existingReservation.value.token !== reservation.reservationToken ||
          existingReservation.value.generation !==
            reservation.reservationGeneration)
      ) {
        throw new SupportDeskConflictError(
          "Ticket reservation belongs to a different create attempt",
        );
      }
      if (
        existingReservation?.value.kind === "ticket_reservation" &&
        existingReservation.value.state === "cancelled" &&
        existingReservation.value.generation >=
          reservation.reservationGeneration
      ) {
        throw new SupportDeskConflictError(
          "Customer ticket reservation was cancelled before commit",
        );
      }
      const committedReservation: TicketReservationRecord = {
        kind: "ticket_reservation",
        partition: command.ticketId,
        id: "reservation",
        token: reservation.reservationToken,
        generation: reservation.reservationGeneration,
        state: "committed",
      };
      const reservationActions: Parameters<typeof records.transact>[1] =
        existingReservation === null
          ? [{ action: "insert", value: committedReservation }]
          : existingReservation.value.kind === "ticket_reservation" &&
              existingReservation.value.state === "cancelled" &&
              existingReservation.value.generation <
                reservation.reservationGeneration
            ? [
                {
                  action: "putIfUnchanged",
                  value: committedReservation,
                  version: existingReservation.version,
                },
              ]
            : [];
      const actions: Parameters<typeof records.transact>[1] = [
        {
          action: "insert",
          value: {
            kind: "ticket",
            partition: command.ticketId,
            id: "ticket",
            ticket,
          },
        },
        {
          action: "insert",
          value: {
            kind: "ticket_quota",
            partition: command.ticketId,
            id: "quota",
            messageCount: 1,
          },
        },
        ...reservationActions,
        {
          action: "insert",
          value: {
            kind: "message",
            partition: command.ticketId,
            id: `message:${command.messageId}`,
            ordinal: ticket.revision,
            message,
            ...(notificationContent === undefined
              ? {}
              : { deliveryContent: notificationContent }),
          },
        },
        ticketAuditAction({
          commandId: command.commandId,
          correlationId: command.correlationId,
          ticketId: command.ticketId,
          revision: ticket.revision,
          actorId: access.principalId,
          occurredAt: now,
          action: supportTicketAuditActions.created,
        }),
        {
          action: "insert",
          value: {
            kind: "command",
            partition: command.ticketId,
            id: `command:${command.commandId}`,
            commandId: command.commandId,
            commandType: "create_customer_ticket",
            messageId: command.messageId,
            requestFingerprint: fingerprint,
            completedAt: now,
          },
        },
        ...(notificationJob === undefined ? [] : [notificationJob]),
      ];
      // Create starts an empty partition; fail closed if the first write would
      // exceed the configured physical-record budget.
      enforcePartitionRecordLimit(
        0,
        limits.maxRecordsPerTicket,
        actions.length,
      );
      const outcome = await records.transact(command.ticketId, actions);
      if (!outcome.committed) {
        const existing = await records.get(
          commandKey(command.ticketId, command.commandId),
        );
        if (
          !duplicateMatches(
            existing,
            "create_customer_ticket",
            command.messageId,
            fingerprint,
          )
        ) {
          throw new SupportDeskConflictError();
        }
      }

      await confirmCustomerTicket(
        access.principalId,
        command.ticketId,
        reservation.reservationToken,
        reservation.reservationGeneration,
      );
      return customerViewAfterChange(
        access.principalId,
        command.ticketId,
        createThreading,
      );
    },

    async replyToCustomerTicket(access, input) {
      requirePermission(access, supportPermissions.replyOwn);
      requireIdentifier(access.principalId, "principalId");
      const command = snapshotReplyToCustomerTicketCommand(input);
      requireIdentifier(command.ticketId, "ticketId");
      requireIdentifier(command.messageId, "messageId");
      requireIdentifier(command.commandId, "commandId");
      requireIdentifier(command.correlationId, "correlationId");
      enforceLimit(command.body, "body", limits.maxMessageCharacters);
      const fingerprint = await requestFingerprint({
        type: "reply_customer_ticket",
        ticketId: command.ticketId,
        messageId: command.messageId,
        body: command.body,
        notification: stableNotification(command.notification),
      });

      for (let attempt = 1; attempt <= maxConflictAttempts; attempt += 1) {
        const duplicate = await records.get(
          commandKey(command.ticketId, command.commandId),
        );
        if (
          duplicateMatches(
            duplicate,
            "reply_customer_ticket",
            command.messageId,
            fingerprint,
          )
        ) {
          return customerViewAfterChange(
            access.principalId,
            command.ticketId,
            notificationThreading(command),
          );
        }

        const versioned = await records.getVersioned(
          ticketKey(command.ticketId),
        );
        if (
          versioned?.value.kind !== "ticket" ||
          versioned.value.ticket.requester.association !== "authenticated" ||
          versioned.value.ticket.requester.principalId !== access.principalId
        ) {
          throw new SupportDeskNotFoundError();
        }
        const partitionRows = await records.list(command.ticketId);
        enforcePartitionRecordLimit(
          partitionRows.length,
          limits.maxRecordsPerTicket,
          command.notification === undefined ? 3 : 4,
        );
        const quota = await records.getVersioned(
          ticketQuotaKey(command.ticketId),
        );
        if (quota?.value.kind !== "ticket_quota") {
          throw new SupportDeskConflictError(
            "Ticket partition quota metadata is missing",
          );
        }
        if (quota.value.messageCount >= limits.maxMessagesPerTicket) {
          throw new SupportDeskLimitError(
            "ticket_messages",
            limits.maxMessagesPerTicket,
          );
        }

        const sampledNow = clock.now();
        const sampledEpoch = canonicalTimestamp(sampledNow, "clock.now()");
        const storedEpoch = canonicalTimestamp(
          versioned.value.ticket.updatedAt,
          "ticket.updatedAt",
        );
        const now =
          sampledEpoch < storedEpoch
            ? versioned.value.ticket.updatedAt
            : sampledNow;
        const updated = await applyResponseTargets(
          applyTicketEvent(versioned.value.ticket, {
            type: "customer_replied",
            actorId: access.principalId,
            occurredAt: now,
          }),
          responseTargetPolicy,
          "customer_replied",
        );
        const message: TicketMessage = {
          id: command.messageId,
          ticketId: command.ticketId,
          authorKind: "customer",
          authorPrincipalId: access.principalId,
          channel: "web",
          visibility: "customer",
          format: "plain_text",
          body: command.body,
          createdAt: now,
        };
        const notificationContent = deliveryContent(command.notification);
        const notificationJob =
          command.notification === undefined
            ? undefined
            : deliveryJobAction(
                command.ticketId,
                command.messageId,
                now,
                command.notification,
              );
        const outcome = await records.transact(command.ticketId, [
          {
            action: "putIfUnchanged",
            version: versioned.version,
            value: { ...versioned.value, ticket: updated },
          },
          {
            action: "putIfUnchanged",
            version: quota.version,
            value: {
              ...quota.value,
              messageCount: quota.value.messageCount + 1,
            },
          },
          {
            action: "insert",
            value: {
              kind: "message",
              partition: command.ticketId,
              id: `message:${command.messageId}`,
              ordinal: updated.revision,
              message,
              ...(notificationContent === undefined
                ? {}
                : { deliveryContent: notificationContent }),
            },
          },
          ticketAuditAction({
            commandId: command.commandId,
            correlationId: command.correlationId,
            ticketId: command.ticketId,
            revision: updated.revision,
            actorId: access.principalId,
            occurredAt: now,
            action: supportTicketAuditActions.customerReplied,
          }),
          {
            action: "insert",
            value: {
              kind: "command",
              partition: command.ticketId,
              id: `command:${command.commandId}`,
              commandId: command.commandId,
              commandType: "reply_customer_ticket",
              messageId: command.messageId,
              requestFingerprint: fingerprint,
              completedAt: now,
            },
          },
          ...(notificationJob === undefined ? [] : [notificationJob]),
        ]);
        if (outcome.committed) {
          return customerViewAfterChange(
            access.principalId,
            command.ticketId,
            notificationThreading(command),
          );
        }
        const nowDuplicate = await records.get(
          commandKey(command.ticketId, command.commandId),
        );
        if (
          duplicateMatches(
            nowDuplicate,
            "reply_customer_ticket",
            command.messageId,
            fingerprint,
          )
        ) {
          return customerViewAfterChange(
            access.principalId,
            command.ticketId,
            notificationThreading(command),
          );
        }
      }
      throw new SupportDeskConflictError();
    },

    async listCustomerTickets(access) {
      requirePermission(access, supportPermissions.readOwn);
      requireIdentifier(access.principalId, "principalId");
      const hints = await index.get({
        partition: access.principalId,
        id: "tickets",
      });
      const tickets: CustomerTicketSummary[] = [];
      for (const hint of hints?.entries ?? []) {
        try {
          tickets.push(
            (
              await authoritativeView(
                records,
                access.principalId,
                hint.ticketId,
                limits.maxRecordsPerTicket,
              )
            ).ticket,
          );
        } catch (error) {
          if (!(error instanceof SupportDeskNotFoundError)) {
            throw error;
          }
        }
      }
      return tickets.sort((left, right) =>
        right.customerUpdatedAt.localeCompare(left.customerUpdatedAt),
      );
    },

    async readCustomerTicket(access, ticketId) {
      requirePermission(access, supportPermissions.readOwn);
      requireIdentifier(access.principalId, "principalId");
      requireIdentifier(ticketId, "ticketId");
      return authoritativeView(
        records,
        access.principalId,
        ticketId,
        limits.maxRecordsPerTicket,
      );
    },

    async readStaffTicket(access, ticketId) {
      requirePermission(access, supportPermissions.queueRead);
      requireIdentifier(access.principalId, "principalId");
      requireIdentifier(ticketId, "ticketId");
      return staffAuthoritativeView(
        records,
        ticketId,
        limits.maxRecordsPerTicket,
      );
    },

    async listStaffQueue(access, input) {
      requirePermission(access, supportPermissions.queueRead);
      requireIdentifier(access.principalId, "principalId");
      const query = snapshotStaffQueueQuery(input);
      // One trusted instant for the entire bounded request; no clock read for old queries.
      const targetNow =
        query.targetState === undefined
          ? undefined
          : canonicalTimestamp(clock.now(), "clock.now()");
      // Request-local cursor only: every online queue read starts without one
      // and consumes a single complete projection scan cycle.
      let cursor: string | undefined;
      let physicalRows = 0;
      let pages = 0;
      const confirmed: StaffQueueItem[] = [];
      const seenTicketIds = new Set<TicketId>();

      const capacityExhausted = (
        budget: SupportDeskQueueCapacityError["budget"],
        maximum: number,
      ): never => {
        try {
          logger.log("warn", "support-desk.queue.capacity_exhausted", {
            budget,
            maximum,
            physicalRows,
            pages,
            activeResults: confirmed.length,
          });
        } catch {
          // ignore logger transport failures
        }
        throw new SupportDeskQueueCapacityError(budget, maximum);
      };

      for (;;) {
        if (pages >= queueBudgets.maxScanPages) {
          capacityExhausted("scan_pages", queueBudgets.maxScanPages);
        }
        const remainingPhysical = queueBudgets.maxPhysicalRows - physicalRows;
        if (remainingPhysical <= 0) {
          capacityExhausted("physical_rows", queueBudgets.maxPhysicalRows);
        }
        pages += 1;
        // Request only what the remaining physical-row budget allows so the
        // configured maximum actually bounds adapter work.
        const pageLimit = Math.min(
          queueBudgets.scanPageSize,
          remainingPhysical,
        );
        // Codec failures abort the scan page; do not return a partial queue.
        const page = await projections.scan({
          limit: pageLimit,
          ...(cursor === undefined ? {} : { cursor }),
        });
        physicalRows += page.records.length;
        if (physicalRows > queueBudgets.maxPhysicalRows) {
          capacityExhausted("physical_rows", queueBudgets.maxPhysicalRows);
        }

        for (const entry of page.records) {
          const projection = entry.value;
          if (
            projection.id !== "queue" ||
            entry.key.partition !== projection.ticketId ||
            entry.key.id !== "queue"
          ) {
            continue;
          }
          if (projection.state !== "active") {
            continue;
          }
          // Confirm every candidate against the authoritative ticket.
          const ticketRecord = await records.get(
            ticketKey(projection.ticketId),
          );
          if (ticketRecord?.kind !== "ticket") {
            continue;
          }
          const ticket = ticketRecord.ticket;
          if (
            ticket.id !== projection.ticketId ||
            ticket.revision !== projection.projectedRevision ||
            isTerminalTicketStatus(ticket.status)
          ) {
            continue;
          }
          if (seenTicketIds.has(ticket.id)) {
            // Scan pages may repeat rows; de-duplicate after confirmation.
            continue;
          }
          if (confirmed.length >= queueBudgets.maxActiveResults) {
            capacityExhausted("active_results", queueBudgets.maxActiveResults);
          }
          seenTicketIds.add(ticket.id);
          confirmed.push(toStaffQueueItem(ticket));
        }

        if (page.nextCursor === null) {
          break;
        }
        cursor = page.nextCursor;
      }

      const filtered = confirmed.filter((item) =>
        staffQueueItemMatches(item, query, targetNow),
      );
      const sort = query.sort ?? "updated_newest";
      // Parse each pending due date once per read, not once per comparison.
      const dueEpochs = new Map<StaffQueueItem, number>();
      if (sort === "due_soonest" || sort === "due_latest") {
        for (const item of filtered) {
          const due = pendingTargetDue(item, query.target);
          if (due !== undefined)
            dueEpochs.set(item, canonicalTimestamp(due, "ticket target"));
        }
      }
      filtered.sort((left, right) => {
        if (sort === "due_soonest" || sort === "due_latest") {
          const leftDue = dueEpochs.get(left);
          const rightDue = dueEpochs.get(right);
          // Completed and missing targets sort last in both directions.
          if (leftDue === undefined && rightDue !== undefined) return 1;
          if (rightDue === undefined && leftDue !== undefined) return -1;
          const difference =
            leftDue === undefined || rightDue === undefined
              ? 0
              : sort === "due_soonest"
                ? leftDue - rightDue
                : rightDue - leftDue;
          return difference || left.ticketId.localeCompare(right.ticketId);
        }
        const byTime =
          sort === "updated_oldest"
            ? left.updatedAt.localeCompare(right.updatedAt)
            : right.updatedAt.localeCompare(left.updatedAt);
        if (byTime !== 0) {
          return byTime;
        }
        return left.ticketId.localeCompare(right.ticketId);
      });
      return { items: filtered.map((item) => Object.freeze({ ...item })) };
    },

    queueProjectionHealth() {
      return projectionHealth;
    },

    async replyAsStaff(access, input) {
      requireStaffMutationAccess(access, supportPermissions.replyAny);
      requireIdentifier(access.principalId, "principalId");
      const command = snapshotStaffReplyCommand(input);
      requireIdentifier(command.ticketId, "ticketId");
      requireIdentifier(command.messageId, "messageId");
      requireIdentifier(command.commandId, "commandId");
      requireIdentifier(command.correlationId, "correlationId");
      enforceLimit(command.body, "body", limits.maxMessageCharacters);
      const fingerprint = await requestFingerprint({
        ...snapshotRevisionHint(command),
        type: "staff_reply",
        ticketId: command.ticketId,
        messageId: command.messageId,
        body: command.body,
        notification: stableNotification(command.notification),
      });

      for (let attempt = 1; attempt <= maxConflictAttempts; attempt += 1) {
        const duplicate = await records.get(
          commandKey(command.ticketId, command.commandId),
        );
        if (
          duplicateMatches(
            duplicate,
            "staff_reply",
            command.messageId,
            fingerprint,
          )
        ) {
          return staffCommandResult(
            command.ticketId,
            command.commandId,
            notificationThreading(command),
          );
        }

        if (duplicate !== null)
          throw new SupportDeskConflictError(
            "Command ID reused with different input",
          );
        const versioned = await records.getVersioned(
          ticketKey(command.ticketId),
        );
        if (versioned?.value.kind !== "ticket") {
          throw new SupportDeskNotFoundError();
        }
        if (
          await checkStaffRevision(versioned.value.ticket, command, fingerprint)
        )
          return staffCommandResult(
            command.ticketId,
            command.commandId,
            notificationThreading(command),
          );
        const partitionRows = await records.list(command.ticketId);
        enforcePartitionRecordLimit(
          partitionRows.length,
          limits.maxRecordsPerTicket,
          command.notification === undefined ? 3 : 4,
        );
        const quota = await records.getVersioned(
          ticketQuotaKey(command.ticketId),
        );
        if (quota?.value.kind !== "ticket_quota") {
          throw new SupportDeskConflictError(
            "Ticket partition quota metadata is missing",
          );
        }
        if (quota.value.messageCount >= limits.maxMessagesPerTicket) {
          throw new SupportDeskLimitError(
            "ticket_messages",
            limits.maxMessagesPerTicket,
          );
        }

        const now = clampTicketTime(
          clock.now(),
          versioned.value.ticket.updatedAt,
        );
        const updated = applyTicketEvent(versioned.value.ticket, {
          type: "support_replied",
          actorId: access.principalId,
          occurredAt: now,
        });
        const message: TicketMessage = {
          id: command.messageId,
          ticketId: command.ticketId,
          authorKind: "staff",
          authorPrincipalId: access.principalId,
          channel: "web",
          visibility: "customer",
          format: "plain_text",
          body: command.body,
          createdAt: now,
        };
        const notificationContent = deliveryContent(command.notification);
        const notificationJob =
          command.notification === undefined
            ? undefined
            : deliveryJobAction(
                command.ticketId,
                command.messageId,
                now,
                command.notification,
              );
        const outcome = await records.transact(command.ticketId, [
          {
            action: "putIfUnchanged",
            version: versioned.version,
            value: { ...versioned.value, ticket: updated },
          },
          {
            action: "putIfUnchanged",
            version: quota.version,
            value: {
              ...quota.value,
              messageCount: quota.value.messageCount + 1,
            },
          },
          {
            action: "insert",
            value: {
              kind: "message",
              partition: command.ticketId,
              id: `message:${command.messageId}`,
              ordinal: updated.revision,
              message,
              ...(notificationContent === undefined
                ? {}
                : { deliveryContent: notificationContent }),
            },
          },
          ticketAuditAction({
            commandId: command.commandId,
            correlationId: command.correlationId,
            ticketId: command.ticketId,
            revision: updated.revision,
            actorId: access.principalId,
            occurredAt: now,
            action: supportTicketAuditActions.staffReplied,
          }),
          {
            action: "insert",
            value: {
              kind: "command",
              partition: command.ticketId,
              id: `command:${command.commandId}`,
              commandId: command.commandId,
              commandType: "staff_reply",
              messageId: command.messageId,
              requestFingerprint: fingerprint,
              completedAt: now,
              resultTicket: updated,
            },
          },
          ...(notificationJob === undefined ? [] : [notificationJob]),
        ]);
        if (outcome.committed) {
          return staffCommandResult(
            command.ticketId,
            command.commandId,
            notificationThreading(command),
          );
        }
        const nowDuplicate = await records.get(
          commandKey(command.ticketId, command.commandId),
        );
        if (
          duplicateMatches(
            nowDuplicate,
            "staff_reply",
            command.messageId,
            fingerprint,
          )
        ) {
          return staffCommandResult(
            command.ticketId,
            command.commandId,
            notificationThreading(command),
          );
        }
      }
      return staffConflictResult(command, fingerprint);
    },

    async addNote(access, input) {
      requireStaffMutationAccess(access, supportPermissions.note);
      requireIdentifier(access.principalId, "principalId");
      const command = snapshotAddNoteCommand(input);
      requireIdentifier(command.ticketId, "ticketId");
      requireIdentifier(command.messageId, "messageId");
      requireIdentifier(command.commandId, "commandId");
      requireIdentifier(command.correlationId, "correlationId");
      enforceLimit(command.body, "body", limits.maxMessageCharacters);
      const fingerprint = await requestFingerprint({
        ...snapshotRevisionHint(command),
        type: "add_note",
        ticketId: command.ticketId,
        messageId: command.messageId,
        body: command.body,
      });

      for (let attempt = 1; attempt <= maxConflictAttempts; attempt += 1) {
        const duplicate = await records.get(
          commandKey(command.ticketId, command.commandId),
        );
        if (
          duplicateMatches(
            duplicate,
            "add_note",
            command.messageId,
            fingerprint,
          )
        ) {
          return staffCommandResult(command.ticketId, command.commandId);
        }

        if (duplicate !== null)
          throw new SupportDeskConflictError(
            "Command ID reused with different input",
          );
        const versioned = await records.getVersioned(
          ticketKey(command.ticketId),
        );
        if (versioned?.value.kind !== "ticket") {
          throw new SupportDeskNotFoundError();
        }
        if (
          await checkStaffRevision(versioned.value.ticket, command, fingerprint)
        )
          return staffCommandResult(
            command.ticketId,
            command.commandId,
            notificationThreading(command),
          );
        const partitionRows = await records.list(command.ticketId);
        enforcePartitionRecordLimit(
          partitionRows.length,
          limits.maxRecordsPerTicket,
          3,
        );
        const quota = await records.getVersioned(
          ticketQuotaKey(command.ticketId),
        );
        if (quota?.value.kind !== "ticket_quota") {
          throw new SupportDeskConflictError(
            "Ticket partition quota metadata is missing",
          );
        }
        if (quota.value.messageCount >= limits.maxMessagesPerTicket) {
          throw new SupportDeskLimitError(
            "ticket_messages",
            limits.maxMessagesPerTicket,
          );
        }

        const statusBefore = versioned.value.ticket.status;
        const customerUpdatedBefore = versioned.value.ticket.customerUpdatedAt;
        const now = clampTicketTime(
          clock.now(),
          versioned.value.ticket.updatedAt,
        );
        const updated = applyTicketEvent(versioned.value.ticket, {
          type: "note_added",
          actorId: access.principalId,
          occurredAt: now,
        });
        // Notes must never change lifecycle or customer-visible timestamps.
        if (
          updated.status !== statusBefore ||
          updated.customerUpdatedAt !== customerUpdatedBefore
        ) {
          throw new SupportDeskConflictError(
            "Internal note unexpectedly changed customer-visible ticket state",
          );
        }
        const message: TicketMessage = {
          id: command.messageId,
          ticketId: command.ticketId,
          authorKind: "staff",
          authorPrincipalId: access.principalId,
          channel: "web",
          visibility: "internal",
          format: "plain_text",
          body: command.body,
          createdAt: now,
        };
        const outcome = await records.transact(command.ticketId, [
          {
            action: "putIfUnchanged",
            version: versioned.version,
            value: { ...versioned.value, ticket: updated },
          },
          {
            action: "putIfUnchanged",
            version: quota.version,
            value: {
              ...quota.value,
              messageCount: quota.value.messageCount + 1,
            },
          },
          {
            action: "insert",
            value: {
              kind: "message",
              partition: command.ticketId,
              id: `message:${command.messageId}`,
              ordinal: updated.revision,
              message,
            },
          },
          ticketAuditAction({
            commandId: command.commandId,
            correlationId: command.correlationId,
            ticketId: command.ticketId,
            revision: updated.revision,
            actorId: access.principalId,
            occurredAt: now,
            action: supportTicketAuditActions.noteAdded,
          }),
          {
            action: "insert",
            value: {
              kind: "command",
              partition: command.ticketId,
              id: `command:${command.commandId}`,
              commandId: command.commandId,
              commandType: "add_note",
              messageId: command.messageId,
              requestFingerprint: fingerprint,
              completedAt: now,
              resultTicket: updated,
            },
          },
        ]);
        if (outcome.committed) {
          return staffCommandResult(command.ticketId, command.commandId);
        }
        const nowDuplicate = await records.get(
          commandKey(command.ticketId, command.commandId),
        );
        if (
          duplicateMatches(
            nowDuplicate,
            "add_note",
            command.messageId,
            fingerprint,
          )
        ) {
          return staffCommandResult(command.ticketId, command.commandId);
        }
      }
      return staffConflictResult(command, fingerprint);
    },

    async assignTicket(access, input) {
      requireStaffMutationAccess(access, supportPermissions.assign);
      requireIdentifier(access.principalId, "principalId");
      const command = snapshotAssignTicketCommand(input);
      requireIdentifier(command.ticketId, "ticketId");
      requireIdentifier(command.commandId, "commandId");
      requireIdentifier(command.correlationId, "correlationId");
      if (command.assigneeId !== null) {
        requireIdentifier(command.assigneeId, "assigneeId");
      }
      if (command.messageId !== undefined) {
        requireIdentifier(command.messageId, "messageId");
      }
      if (command.body !== undefined) {
        enforceLimit(command.body, "body", limits.maxMessageCharacters);
      }
      const fingerprint = await requestFingerprint({
        ...snapshotRevisionHint(command),
        type: "assign_ticket",
        ticketId: command.ticketId,
        assigneeId: command.assigneeId,
        messageId: command.messageId ?? null,
        body: command.body ?? null,
        notification: stableNotification(command.notification),
      });

      for (let attempt = 1; attempt <= maxConflictAttempts; attempt += 1) {
        const duplicate = await records.get(
          commandKey(command.ticketId, command.commandId),
        );
        if (
          duplicateMatches(
            duplicate,
            "assign_ticket",
            command.messageId,
            fingerprint,
          )
        ) {
          return staffCommandResult(
            command.ticketId,
            command.commandId,
            notificationThreading(command),
          );
        }

        if (duplicate !== null)
          throw new SupportDeskConflictError(
            "Command ID reused with different input",
          );
        const versioned = await records.getVersioned(
          ticketKey(command.ticketId),
        );
        if (versioned?.value.kind !== "ticket") {
          throw new SupportDeskNotFoundError();
        }
        const addedRecords =
          command.messageId === undefined
            ? 2
            : command.notification === undefined
              ? 3
              : 4;
        if (
          await checkStaffRevision(versioned.value.ticket, command, fingerprint)
        )
          return staffCommandResult(
            command.ticketId,
            command.commandId,
            notificationThreading(command),
          );
        const partitionRows = await records.list(command.ticketId);
        enforcePartitionRecordLimit(
          partitionRows.length,
          limits.maxRecordsPerTicket,
          addedRecords,
        );
        let quotaVersion: Awaited<
          ReturnType<CollectionStore<SupportRecord>["getVersioned"]>
        > = null;
        if (command.messageId !== undefined) {
          quotaVersion = await records.getVersioned(
            ticketQuotaKey(command.ticketId),
          );
          if (quotaVersion?.value.kind !== "ticket_quota") {
            throw new SupportDeskConflictError(
              "Ticket partition quota metadata is missing",
            );
          }
          if (quotaVersion.value.messageCount >= limits.maxMessagesPerTicket) {
            throw new SupportDeskLimitError(
              "ticket_messages",
              limits.maxMessagesPerTicket,
            );
          }
        }
        const statusBefore = versioned.value.ticket.status;
        const customerUpdatedBefore = versioned.value.ticket.customerUpdatedAt;
        const now = clampTicketTime(
          clock.now(),
          versioned.value.ticket.updatedAt,
        );
        const updated = applyTicketEvent(versioned.value.ticket, {
          type: "assigned",
          actorId: access.principalId,
          assigneeId: command.assigneeId,
          occurredAt: now,
        });
        if (
          updated.status !== statusBefore ||
          updated.customerUpdatedAt !== customerUpdatedBefore
        ) {
          throw new SupportDeskConflictError(
            "Assignment unexpectedly changed customer-visible ticket state",
          );
        }
        // Optional system message + mail so assignment notifications share the
        // ticket transaction with the assignment itself.
        const systemMessage: TicketMessage | undefined =
          command.messageId === undefined || command.body === undefined
            ? undefined
            : {
                id: command.messageId,
                ticketId: command.ticketId,
                authorKind: "system",
                channel: "web",
                visibility: "internal",
                format: "plain_text",
                body: command.body,
                createdAt: now,
              };
        const notificationContent = deliveryContent(command.notification);
        const notificationJob =
          command.notification === undefined || command.messageId === undefined
            ? undefined
            : deliveryJobAction(
                command.ticketId,
                command.messageId,
                now,
                command.notification,
              );
        const outcome = await records.transact(command.ticketId, [
          {
            action: "putIfUnchanged",
            version: versioned.version,
            value: { ...versioned.value, ticket: updated },
          },
          ...(quotaVersion === null ||
          systemMessage === undefined ||
          quotaVersion.value.kind !== "ticket_quota"
            ? []
            : [
                {
                  action: "putIfUnchanged" as const,
                  version: quotaVersion.version,
                  value: {
                    kind: "ticket_quota" as const,
                    partition: command.ticketId,
                    id: "quota" as const,
                    messageCount: quotaVersion.value.messageCount + 1,
                  },
                },
              ]),
          ...(systemMessage === undefined
            ? []
            : [
                {
                  action: "insert" as const,
                  value: {
                    kind: "message" as const,
                    partition: command.ticketId,
                    id: `message:${command.messageId}`,
                    ordinal: updated.revision,
                    message: systemMessage,
                    ...(notificationContent === undefined
                      ? {}
                      : { deliveryContent: notificationContent }),
                  },
                },
              ]),
          ticketAuditAction({
            commandId: command.commandId,
            correlationId: command.correlationId,
            ticketId: command.ticketId,
            revision: updated.revision,
            actorId: access.principalId,
            occurredAt: now,
            action:
              command.assigneeId === null
                ? supportTicketAuditActions.unassigned
                : supportTicketAuditActions.assigned,
            details:
              command.assigneeId === null
                ? {}
                : { assigneeId: command.assigneeId },
          }),
          {
            action: "insert",
            value: {
              kind: "command",
              partition: command.ticketId,
              id: `command:${command.commandId}`,
              commandId: command.commandId,
              commandType: "assign_ticket",
              ...(command.messageId === undefined
                ? {}
                : { messageId: command.messageId }),
              requestFingerprint: fingerprint,
              completedAt: now,
              resultTicket: updated,
            },
          },
          ...(notificationJob === undefined ? [] : [notificationJob]),
        ]);
        if (outcome.committed) {
          return staffCommandResult(
            command.ticketId,
            command.commandId,
            notificationThreading(command),
          );
        }
        const nowDuplicate = await records.get(
          commandKey(command.ticketId, command.commandId),
        );
        if (
          duplicateMatches(
            nowDuplicate,
            "assign_ticket",
            command.messageId,
            fingerprint,
          )
        ) {
          return staffCommandResult(
            command.ticketId,
            command.commandId,
            notificationThreading(command),
          );
        }
      }
      return staffConflictResult(command, fingerprint);
    },

    async changePriority(access, input) {
      requireStaffMutationAccess(access, supportPermissions.manage);
      requireIdentifier(access.principalId, "principalId");
      const command = snapshotChangePriorityCommand(input);
      requireIdentifier(command.ticketId, "ticketId");
      requireIdentifier(command.commandId, "commandId");
      requireIdentifier(command.correlationId, "correlationId");
      const fingerprint = await requestFingerprint({
        ...snapshotRevisionHint(command),
        type: "change_priority",
        ticketId: command.ticketId,
        priority: command.priority,
      });

      for (let attempt = 1; attempt <= maxConflictAttempts; attempt += 1) {
        const duplicate = await records.get(
          commandKey(command.ticketId, command.commandId),
        );
        if (
          duplicateMatches(duplicate, "change_priority", undefined, fingerprint)
        ) {
          return staffCommandResult(command.ticketId, command.commandId);
        }

        if (duplicate !== null)
          throw new SupportDeskConflictError(
            "Command ID reused with different input",
          );
        const versioned = await records.getVersioned(
          ticketKey(command.ticketId),
        );
        if (versioned?.value.kind !== "ticket") {
          throw new SupportDeskNotFoundError();
        }
        if (
          await checkStaffRevision(versioned.value.ticket, command, fingerprint)
        )
          return staffCommandResult(command.ticketId, command.commandId);
        const partitionRows = await records.list(command.ticketId);
        enforcePartitionRecordLimit(
          partitionRows.length,
          limits.maxRecordsPerTicket,
          2,
        );
        const statusBefore = versioned.value.ticket.status;
        const customerUpdatedBefore = versioned.value.ticket.customerUpdatedAt;
        const now = clampTicketTime(
          clock.now(),
          versioned.value.ticket.updatedAt,
        );
        const updated = await applyResponseTargets(
          applyTicketEvent(versioned.value.ticket, {
            type: "priority_changed",
            actorId: access.principalId,
            priority: command.priority,
            occurredAt: now,
          }),
          responseTargetPolicy,
          "priority_changed",
        );
        if (
          updated.status !== statusBefore ||
          updated.customerUpdatedAt !== customerUpdatedBefore
        ) {
          throw new SupportDeskConflictError(
            "Priority change unexpectedly changed customer-visible ticket state",
          );
        }
        const outcome = await records.transact(command.ticketId, [
          {
            action: "putIfUnchanged",
            version: versioned.version,
            value: { ...versioned.value, ticket: updated },
          },
          ticketAuditAction({
            commandId: command.commandId,
            correlationId: command.correlationId,
            ticketId: command.ticketId,
            revision: updated.revision,
            actorId: access.principalId,
            occurredAt: now,
            action: supportTicketAuditActions.priorityChanged,
            details: { priority: command.priority },
          }),
          {
            action: "insert",
            value: {
              kind: "command",
              partition: command.ticketId,
              id: `command:${command.commandId}`,
              commandId: command.commandId,
              commandType: "change_priority",
              requestFingerprint: fingerprint,
              completedAt: now,
              resultTicket: updated,
            },
          },
        ]);
        if (outcome.committed) {
          return staffCommandResult(command.ticketId, command.commandId);
        }
        const nowDuplicate = await records.get(
          commandKey(command.ticketId, command.commandId),
        );
        if (
          duplicateMatches(
            nowDuplicate,
            "change_priority",
            undefined,
            fingerprint,
          )
        ) {
          return staffCommandResult(command.ticketId, command.commandId);
        }
      }
      return staffConflictResult(command, fingerprint);
    },

    async setTags(access, input) {
      requireStaffMutationAccess(access, supportPermissions.manage);
      requireIdentifier(access.principalId, "principalId");
      const source = boundaryObject(input, "set tags command");
      const command: SetTagsCommand = Object.freeze({
        ...snapshotRevisionHint(source),
        commandId: boundaryString(
          ownDataProperty(source, "commandId", "commandId"),
          "commandId",
        ),
        correlationId: boundaryString(
          ownDataProperty(source, "correlationId", "correlationId"),
          "correlationId",
        ),
        ticketId: boundaryString(
          ownDataProperty(source, "ticketId", "ticketId"),
          "ticketId",
        ),
        tags: snapshotTags(ownDataProperty(source, "tags", "tags")),
      });
      requireIdentifier(command.ticketId, "ticketId");
      requireIdentifier(command.commandId, "commandId");
      requireIdentifier(command.correlationId, "correlationId");
      const fingerprint = await requestFingerprint({
        type: "set_tags",
        ticketId: command.ticketId,
        tags: command.tags,
        ...snapshotRevisionHint(command),
      });
      for (let attempt = 1; attempt <= maxConflictAttempts; attempt += 1) {
        const duplicate = await records.get(
          commandKey(command.ticketId, command.commandId),
        );
        if (duplicateMatches(duplicate, "set_tags", undefined, fingerprint))
          return staffCommandResult(command.ticketId, command.commandId);
        if (duplicate !== null)
          throw new SupportDeskConflictError(
            "Command ID reused with different input",
          );
        const versioned = await records.getVersioned(
          ticketKey(command.ticketId),
        );
        if (versioned?.value.kind !== "ticket")
          throw new SupportDeskNotFoundError();
        if (
          await checkStaffRevision(versioned.value.ticket, command, fingerprint)
        )
          return staffCommandResult(command.ticketId, command.commandId);
        if (command.tags.length > maxTagsPerTicket)
          throw new TypeError("tags exceed maxTagsPerTicket");
        if (command.tags.some((tag) => !allowedTags.has(tag)))
          throw new TypeError("tags must be on the host allowlist");
        const rows = await records.list(command.ticketId);
        enforcePartitionRecordLimit(rows.length, limits.maxRecordsPerTicket, 2);
        const now = clampTicketTime(
          clock.now(),
          versioned.value.ticket.updatedAt,
        );
        const updated = applyTicketEvent(versioned.value.ticket, {
          type: "tags_changed",
          actorId: access.principalId,
          occurredAt: now,
          tags: command.tags,
        });
        const outcome = await records.transact(command.ticketId, [
          {
            action: "putIfUnchanged",
            version: versioned.version,
            value: { ...versioned.value, ticket: updated },
          },
          ticketAuditAction({
            commandId: command.commandId,
            correlationId: command.correlationId,
            ticketId: command.ticketId,
            revision: updated.revision,
            actorId: access.principalId,
            occurredAt: now,
            action: supportTicketAuditActions.tagsChanged,
          }),
          {
            action: "insert",
            value: {
              kind: "command",
              partition: command.ticketId,
              id: `command:${command.commandId}`,
              commandId: command.commandId,
              commandType: "set_tags",
              requestFingerprint: fingerprint,
              completedAt: now,
              resultTicket: updated,
            },
          },
        ]);
        if (outcome.committed)
          return staffCommandResult(command.ticketId, command.commandId);
      }
      return staffConflictResult(command, fingerprint);
    },

    async resolveTicket(access, input) {
      return mutateLifecycle(access, input, {
        commandType: "resolve_ticket",
        eventType: "resolved",
        auditAction: supportTicketAuditActions.resolved,
        field: "resolve command",
      });
    },

    async closeTicket(access, input) {
      return mutateLifecycle(access, input, {
        commandType: "close_ticket",
        eventType: "closed",
        auditAction: supportTicketAuditActions.closed,
        field: "close command",
      });
    },

    async reopenTicket(access, input) {
      return mutateLifecycle(access, input, {
        commandType: "reopen_ticket",
        eventType: "reopened",
        auditAction: supportTicketAuditActions.reopened,
        field: "reopen command",
      });
    },

    async readTicketAuditHistory(access, ticketId) {
      requirePermission(access, supportPermissions.auditRead);
      requireIdentifier(access.principalId, "principalId");
      requireIdentifier(ticketId, "ticketId");
      const partitionRows = await records.list(ticketId);
      enforcePartitionRecordLimit(
        partitionRows.length,
        limits.maxRecordsPerTicket,
      );
      const ticket = partitionRows.find(
        (record): record is TicketRecord => record.kind === "ticket",
      );
      if (ticket === undefined) {
        throw new SupportDeskNotFoundError();
      }
      return supportAudit.history(records, ticketId);
    },
  };

  async function mutateLifecycle(
    access: AccessContext,
    input: LifecycleTicketCommand,
    spec: {
      readonly commandType: "resolve_ticket" | "close_ticket" | "reopen_ticket";
      readonly eventType: "resolved" | "closed" | "reopened";
      readonly auditAction:
        | typeof supportTicketAuditActions.resolved
        | typeof supportTicketAuditActions.closed
        | typeof supportTicketAuditActions.reopened;
      readonly field: string;
    },
  ): Promise<StaffTicketView> {
    requireStaffMutationAccess(access, supportPermissions.manage);
    requireIdentifier(access.principalId, "principalId");
    const command = snapshotLifecycleTicketCommand(input, spec.field);
    requireIdentifier(command.ticketId, "ticketId");
    requireIdentifier(command.commandId, "commandId");
    requireIdentifier(command.correlationId, "correlationId");
    if (command.messageId !== undefined) {
      requireIdentifier(command.messageId, "messageId");
    }
    if (command.body !== undefined) {
      enforceLimit(command.body, "body", limits.maxMessageCharacters);
    }
    const fingerprint = await requestFingerprint({
      ...snapshotRevisionHint(command),
      type: spec.commandType,
      ticketId: command.ticketId,
      messageId: command.messageId ?? null,
      body: command.body ?? null,
      notification: stableNotification(command.notification),
    });

    for (let attempt = 1; attempt <= maxConflictAttempts; attempt += 1) {
      const duplicate = await records.get(
        commandKey(command.ticketId, command.commandId),
      );
      if (
        duplicateMatches(
          duplicate,
          spec.commandType,
          command.messageId,
          fingerprint,
        )
      ) {
        return staffCommandResult(
          command.ticketId,
          command.commandId,
          notificationThreading(command),
        );
      }

      if (duplicate !== null)
        throw new SupportDeskConflictError(
          "Command ID reused with different input",
        );
      const versioned = await records.getVersioned(ticketKey(command.ticketId));
      if (versioned?.value.kind !== "ticket") {
        throw new SupportDeskNotFoundError();
      }
      if (
        await checkStaffRevision(versioned.value.ticket, command, fingerprint)
      )
        return staffCommandResult(
          command.ticketId,
          command.commandId,
          notificationThreading(command),
        );
      const partitionRows = await records.list(command.ticketId);
      const addedRecords =
        command.messageId === undefined
          ? 2 // audit + command
          : command.notification === undefined
            ? 3 // message + audit + command
            : 4; // message + audit + command + delivery
      enforcePartitionRecordLimit(
        partitionRows.length,
        limits.maxRecordsPerTicket,
        addedRecords,
      );

      let quotaVersion: Awaited<
        ReturnType<CollectionStore<SupportRecord>["getVersioned"]>
      > = null;
      if (command.messageId !== undefined) {
        quotaVersion = await records.getVersioned(
          ticketQuotaKey(command.ticketId),
        );
        if (quotaVersion?.value.kind !== "ticket_quota") {
          throw new SupportDeskConflictError(
            "Ticket partition quota metadata is missing",
          );
        }
        if (quotaVersion.value.messageCount >= limits.maxMessagesPerTicket) {
          throw new SupportDeskLimitError(
            "ticket_messages",
            limits.maxMessagesPerTicket,
          );
        }
      }

      const now = clampTicketTime(
        clock.now(),
        versioned.value.ticket.updatedAt,
      );
      const updated = applyTicketEvent(versioned.value.ticket, {
        type: spec.eventType,
        actorId: access.principalId,
        occurredAt: now,
      });
      // Optional system message + mail commit with the lifecycle change so a
      // resolution notification cannot be lost after the ticket is resolved.
      const systemMessage: TicketMessage | undefined =
        command.messageId === undefined || command.body === undefined
          ? undefined
          : {
              id: command.messageId,
              ticketId: command.ticketId,
              authorKind: "system",
              channel: "web",
              visibility: "customer",
              format: "plain_text",
              body: command.body,
              createdAt: now,
            };
      const notificationContent = deliveryContent(command.notification);
      const notificationJob =
        command.notification === undefined || command.messageId === undefined
          ? undefined
          : deliveryJobAction(
              command.ticketId,
              command.messageId,
              now,
              command.notification,
            );
      const outcome = await records.transact(command.ticketId, [
        {
          action: "putIfUnchanged",
          version: versioned.version,
          value: { ...versioned.value, ticket: updated },
        },
        ...(quotaVersion === null ||
        systemMessage === undefined ||
        quotaVersion.value.kind !== "ticket_quota"
          ? []
          : [
              {
                action: "putIfUnchanged" as const,
                version: quotaVersion.version,
                value: {
                  kind: "ticket_quota" as const,
                  partition: command.ticketId,
                  id: "quota" as const,
                  messageCount: quotaVersion.value.messageCount + 1,
                },
              },
            ]),
        ...(systemMessage === undefined
          ? []
          : [
              {
                action: "insert" as const,
                value: {
                  kind: "message" as const,
                  partition: command.ticketId,
                  id: `message:${command.messageId}`,
                  ordinal: updated.revision,
                  message: systemMessage,
                  ...(notificationContent === undefined
                    ? {}
                    : { deliveryContent: notificationContent }),
                },
              },
            ]),
        ticketAuditAction({
          commandId: command.commandId,
          correlationId: command.correlationId,
          ticketId: command.ticketId,
          revision: updated.revision,
          actorId: access.principalId,
          occurredAt: now,
          action: spec.auditAction,
        }),
        {
          action: "insert",
          value: {
            kind: "command",
            partition: command.ticketId,
            id: `command:${command.commandId}`,
            commandId: command.commandId,
            commandType: spec.commandType,
            ...(command.messageId === undefined
              ? {}
              : { messageId: command.messageId }),
            requestFingerprint: fingerprint,
            completedAt: now,
            resultTicket: updated,
          },
        },
        ...(notificationJob === undefined ? [] : [notificationJob]),
      ]);
      if (outcome.committed) {
        return staffCommandResult(
          command.ticketId,
          command.commandId,
          notificationThreading(command),
        );
      }
      const nowDuplicate = await records.get(
        commandKey(command.ticketId, command.commandId),
      );
      if (
        duplicateMatches(
          nowDuplicate,
          spec.commandType,
          command.messageId,
          fingerprint,
        )
      ) {
        return staffCommandResult(
          command.ticketId,
          command.commandId,
          notificationThreading(command),
        );
      }
    }
    return staffConflictResult(command, fingerprint);
  }
}

function canonicalTimestamp(value: IsoTimestamp, field: string): number {
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== value) {
    throw new TypeError(`${field} must be a canonical ISO timestamp`);
  }
  return epoch;
}

async function receiptHash(
  owner: string,
  providerEventId: string,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${owner}\u0000${providerEventId}`),
  );
  return [...new Uint8Array(digest).slice(0, 16)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function inboundReceiptLocation(
  channelId: string,
  providerEventId: string,
): Promise<{ readonly bucket: string; readonly slot: string }> {
  requireIdentifier(channelId, "channelId");
  requireIdentifier(providerEventId, "providerEventId");
  const hash = await receiptHash(channelId, providerEventId);
  const bucket = `${encodeIdempotencyPart(channelId)}:${hash.slice(0, 30)}`;
  if (bucket.length > 300) {
    throw new TypeError("inbound receipt bucket exceeds the safe key length");
  }
  return { bucket, slot: hash.slice(30) };
}

export async function inboundReceiptBucket(
  channelId: string,
  providerEventId: string,
): Promise<string> {
  return (await inboundReceiptLocation(channelId, providerEventId)).bucket;
}

async function deliveryCallbackLocation(
  provider: string,
  providerEventId: string,
): Promise<{ readonly bucket: string; readonly slot: string }> {
  requireIdentifier(provider, "provider");
  requireIdentifier(providerEventId, "providerEventId");
  const hash = await receiptHash(provider, providerEventId);
  const bucket = `${encodeIdempotencyPart(provider)}:${hash.slice(0, 30)}`;
  if (bucket.length > 300) {
    throw new TypeError("delivery callback bucket exceeds the safe key length");
  }
  return { bucket, slot: hash.slice(30) };
}

export async function deliveryCallbackBucket(
  provider: string,
  providerEventId: string,
): Promise<string> {
  return (await deliveryCallbackLocation(provider, providerEventId)).bucket;
}

function callbackReceiptKey(location: {
  readonly bucket: string;
  readonly slot: string;
}): EntityKey {
  return { partition: location.bucket, id: `slot:${location.slot}` };
}

function callbackMatches(
  stored: DeliveryCallbackReceipt,
  receipt: DeliveryCallbackInput,
): boolean {
  return (
    stored.provider === receipt.provider &&
    stored.providerEventId === receipt.providerEventId &&
    stored.ticketId === receipt.ticketId &&
    stored.deliveryJobId === receipt.deliveryJobId &&
    stored.submissionGeneration === receipt.submissionGeneration &&
    stored.providerMessageRef === receipt.providerMessageRef &&
    stored.status === receipt.status &&
    stored.occurredAt === receipt.occurredAt &&
    stored.failureCategory === receipt.failureCategory
  );
}

const CALLBACK_FAILURE_CATEGORY = /^[a-z][a-z0-9_]{0,63}$/;
const DEFAULT_CALLBACK_FAILURE_CATEGORY = "provider_callback_failure";

function snapshotDeliveryCallback(
  input: DeliveryCallbackInput,
): DeliveryCallbackInput {
  if (
    input === null ||
    (typeof input !== "object" && typeof input !== "function")
  ) {
    throw new TypeError("delivery callback must be an object");
  }
  const readString = (key: keyof DeliveryCallbackInput): string => {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) {
      throw new TypeError(
        `delivery callback ${key} must be an own data property`,
      );
    }
    if (typeof descriptor.value !== "string") {
      throw new TypeError(`delivery callback ${key} must be a string`);
    }
    return descriptor.value;
  };
  const readOptionalString = (
    key: "providerMessageRef" | "failureCategory",
  ): string | undefined => {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (descriptor === undefined) return undefined;
    if (!Object.hasOwn(descriptor, "value")) {
      throw new TypeError(`delivery callback ${key} must be a string`);
    }
    if (descriptor.value === undefined) return undefined;
    if (typeof descriptor.value !== "string") {
      throw new TypeError(`delivery callback ${key} must be a string`);
    }
    return descriptor.value;
  };
  const generation = Object.getOwnPropertyDescriptor(
    input,
    "submissionGeneration",
  );
  if (
    generation === undefined ||
    !Object.hasOwn(generation, "value") ||
    typeof generation.value !== "number"
  ) {
    throw new TypeError(
      "delivery callback submissionGeneration must be an own numeric data property",
    );
  }
  if (
    !Number.isSafeInteger(generation.value) ||
    generation.value < 1 ||
    generation.value > maxMailAttempts
  ) {
    throw new TypeError(
      `delivery callback submissionGeneration must be between 1 and ${maxMailAttempts}`,
    );
  }
  const status = readString("status");
  if (status !== "delivered" && status !== "failed") {
    throw new TypeError("callback status must be delivered or failed");
  }
  const providerMessageRef = readOptionalString("providerMessageRef");
  if (
    providerMessageRef !== undefined &&
    (providerMessageRef.trim().length === 0 ||
      providerMessageRef.length > 512 ||
      /[\u0000-\u001F\u007F]/.test(providerMessageRef))
  ) {
    throw new TypeError(
      "delivery callback providerMessageRef must be non-empty, at most 512 characters, and contain no controls",
    );
  }
  const suppliedFailureCategory = readOptionalString("failureCategory");
  if (status === "delivered" && suppliedFailureCategory !== undefined) {
    throw new TypeError(
      "a delivered callback cannot include a failureCategory",
    );
  }
  const failureCategory =
    status === "failed"
      ? (suppliedFailureCategory ?? DEFAULT_CALLBACK_FAILURE_CATEGORY)
      : undefined;
  if (
    failureCategory !== undefined &&
    !CALLBACK_FAILURE_CATEGORY.test(failureCategory)
  ) {
    throw new TypeError(
      "delivery callback failureCategory must be a coarse safe token",
    );
  }
  return Object.freeze({
    provider: readString("provider"),
    providerEventId: readString("providerEventId"),
    ticketId: readString("ticketId"),
    deliveryJobId: readString("deliveryJobId"),
    submissionGeneration: generation.value,
    ...(providerMessageRef === undefined ? {} : { providerMessageRef }),
    status,
    occurredAt: readString("occurredAt"),
    ...(failureCategory === undefined ? {} : { failureCategory }),
  });
}

export async function recordDeliveryCallback(
  store: Store,
  input: DeliveryCallbackInput,
  clock: Clock,
): Promise<{ readonly duplicate: boolean; readonly job: DeliveryJob | null }> {
  const receipt = snapshotDeliveryCallback(input);
  requireIdentifier(receipt.provider, "provider");
  requireIdentifier(receipt.providerEventId, "providerEventId");
  requireIdentifier(receipt.ticketId, "ticketId");
  requireIdentifier(receipt.deliveryJobId, "deliveryJobId");
  canonicalTimestamp(receipt.occurredAt, "occurredAt");
  const callbackFailureCategory =
    receipt.status === "failed"
      ? (receipt.failureCategory ?? DEFAULT_CALLBACK_FAILURE_CATEGORY)
      : undefined;
  const processedAt = clock.now();
  canonicalTimestamp(processedAt, "clock.now()");
  const receipts = store.collection(deliveryCallbackReceipts);
  const location = await deliveryCallbackLocation(
    receipt.provider,
    receipt.providerEventId,
  );
  const inserted = await receipts.insertIfAbsent({
    ...receipt,
    ...location,
  });
  if (!callbackMatches(inserted.value, receipt)) {
    throw new SupportDeskConflictError(
      "A delivery callback idempotency key was reused for different input or its bounded hash slot collided",
    );
  }
  if (!inserted.inserted && inserted.value.processedAt !== undefined) {
    return { duplicate: true, job: null };
  }
  const records = store.collection(supportRecords);
  const result = await supportMail.applyAuthenticatedCallback(
    records,
    {
      partition: receipt.ticketId,
      jobId: receipt.deliveryJobId,
      submissionGeneration: receipt.submissionGeneration,
      ...(receipt.providerMessageRef === undefined
        ? {}
        : { providerMessageRef: receipt.providerMessageRef }),
      status: receipt.status,
      occurredAt: receipt.occurredAt,
      ...(callbackFailureCategory === undefined
        ? {}
        : { failureCategory: callbackFailureCategory }),
    },
    clock,
  );
  await receipts.update(callbackReceiptKey(location), (current) =>
    current === null || current.processedAt !== undefined
      ? { action: "keep" }
      : {
          action: "write",
          value: { ...current, processedAt },
        },
  );
  return {
    duplicate: !inserted.inserted,
    job:
      result === null
        ? null
        : {
            kind: "delivery_job",
            partition: result.partition,
            id: `delivery:${result.id}`,
            ticketId: result.partition,
            messageId: result.contentRef,
            job: result,
          },
  };
}

interface ReceiptSweepInput {
  readonly bucket: string;
  readonly processedBefore: IsoTimestamp;
  readonly maxDeletes?: number;
}

function snapshotReceiptSweepInput(
  input: ReceiptSweepInput,
  field: string,
): ReceiptSweepInput {
  const source = boundaryObject(input, field);
  const raw = {
    bucket: ownDataProperty(source, "bucket", `${field}.bucket`),
    processedBefore: ownDataProperty(
      source,
      "processedBefore",
      `${field}.processedBefore`,
    ),
    maxDeletes: ownDataProperty(
      source,
      "maxDeletes",
      `${field}.maxDeletes`,
      true,
    ),
  };
  if (raw.maxDeletes !== undefined && typeof raw.maxDeletes !== "number") {
    throw new TypeError(`${field}.maxDeletes must be a number`);
  }
  return Object.freeze({
    bucket: boundaryString(raw.bucket, `${field}.bucket`),
    processedBefore: boundaryString(
      raw.processedBefore,
      `${field}.processedBefore`,
    ),
    ...(raw.maxDeletes === undefined ? {} : { maxDeletes: raw.maxDeletes }),
  });
}

export async function sweepInboundReceipts(
  store: Store,
  clock: Clock,
  input: ReceiptSweepInput,
): Promise<number> {
  const request = snapshotReceiptSweepInput(input, "inbound receipt sweep");
  const { bucket, processedBefore } = request;
  if (
    bucket.length === 0 ||
    bucket.length > 300 ||
    /[\u0000-\u001F\u007F]/.test(bucket)
  ) {
    throw new TypeError(
      "bucket must be at most 300 characters with no controls",
    );
  }
  const now = canonicalTimestamp(clock.now(), "clock.now()");
  const horizonBefore = new Date(
    now - inboundReceiptDedupeDays * 86_400_000,
  ).toISOString();
  canonicalTimestamp(processedBefore, "processedBefore");
  const maxDeletes = request.maxDeletes ?? 100;
  if (
    !Number.isSafeInteger(maxDeletes) ||
    maxDeletes <= 0 ||
    maxDeletes > 1_000
  ) {
    throw new TypeError("maxDeletes must be between 1 and 1000");
  }
  const receipts = store.collection(inboundReceipts);
  const candidates = (await receipts.listVersioned(bucket))
    .filter(
      (versioned) =>
        (versioned.value.status === "processed" ||
          versioned.value.status === "rejected") &&
        versioned.value.processedAt !== undefined &&
        versioned.value.processedAt <= processedBefore &&
        versioned.value.processedAt < horizonBefore,
    )
    .slice(0, maxDeletes);
  let deleted = 0;
  for (const candidate of candidates) {
    if (
      await receipts.deleteIfUnchanged(
        {
          partition: bucket,
          id: receiptSlotId(candidate.value.slot, "inbound receipt slot"),
        },
        candidate.version,
      )
    ) {
      deleted += 1;
    }
  }
  return deleted;
}

export async function sweepDeliveryCallbackReceipts(
  store: Store,
  clock: Clock,
  input: ReceiptSweepInput,
): Promise<number> {
  const request = snapshotReceiptSweepInput(
    input,
    "delivery callback receipt sweep",
  );
  const { bucket, processedBefore } = request;
  if (
    bucket.length === 0 ||
    bucket.length > 300 ||
    /[\u0000-\u001F\u007F]/.test(bucket)
  ) {
    throw new TypeError(
      "bucket must be at most 300 characters with no controls",
    );
  }
  const now = canonicalTimestamp(clock.now(), "clock.now()");
  const horizonBefore = new Date(
    now - deliveryCallbackDedupeDays * 86_400_000,
  ).toISOString();
  canonicalTimestamp(processedBefore, "processedBefore");
  const maxDeletes = request.maxDeletes ?? 100;
  if (
    !Number.isSafeInteger(maxDeletes) ||
    maxDeletes <= 0 ||
    maxDeletes > 1_000
  ) {
    throw new TypeError("maxDeletes must be between 1 and 1000");
  }
  const receipts = store.collection(deliveryCallbackReceipts);
  const candidates = (await receipts.listVersioned(bucket))
    .filter(
      (versioned) =>
        versioned.value.processedAt !== undefined &&
        versioned.value.processedAt <= processedBefore &&
        versioned.value.processedAt < horizonBefore,
    )
    .slice(0, maxDeletes);
  let deleted = 0;
  for (const candidate of candidates) {
    if (
      await receipts.deleteIfUnchanged(
        {
          partition: bucket,
          id: receiptSlotId(candidate.value.slot, "delivery callback slot"),
        },
        candidate.version,
      )
    ) {
      deleted += 1;
    }
  }
  return deleted;
}

/**
 * Remove stale ticket hints from one bounded principal index record.
 *
 * The index is never an authorization answer. A reserved hint may remain
 * after a process stops before creating its ticket; this sweep confirms every
 * hint against authoritative ticket state before retaining it.
 */
export async function pruneCustomerTicketIndex(
  store: Store,
  principalId: PrincipalId,
  input: { readonly reservedBefore: IsoTimestamp },
): Promise<readonly TicketId[]> {
  requireIdentifier(principalId, "principalId");
  const source = boundaryObject(input, "customer ticket index prune");
  const reservedBefore = boundaryString(
    ownDataProperty(
      source,
      "reservedBefore",
      "customer ticket index prune.reservedBefore",
    ),
    "customer ticket index prune.reservedBefore",
  );
  canonicalTimestamp(reservedBefore, "reservedBefore");
  const index = store.collection(customerTicketIndex);
  const records = store.collection(supportRecords);
  const result = await index.update(
    { partition: principalId, id: "tickets" },
    async (current) => {
      if (current === null) {
        return { action: "keep" };
      }
      const retained: CustomerTicketIndexEntry[] = [];
      for (const entry of current.entries) {
        const ticket = await records.get(ticketKey(entry.ticketId));
        if (
          ticket?.kind === "ticket" &&
          ticket.ticket.requester.association === "authenticated" &&
          ticket.ticket.requester.principalId === principalId
        ) {
          retained.push({ ...entry, state: "confirmed" });
          continue;
        }
        if (entry.state === "confirmed") {
          continue;
        }
        if (entry.reservedAt >= reservedBefore) {
          retained.push(entry);
          continue;
        }

        const fence = await records.update(
          ticketReservationKey(entry.ticketId),
          (current) => {
            if (
              current?.kind === "ticket_reservation" &&
              current.state === "committed"
            ) {
              return { action: "keep" };
            }
            if (
              current?.kind === "ticket_reservation" &&
              current.state === "cancelled" &&
              current.generation >= entry.reservationGeneration
            ) {
              return { action: "keep" };
            }
            return {
              action: "write",
              value: {
                kind: "ticket_reservation",
                partition: entry.ticketId,
                id: "reservation",
                token: entry.reservationToken,
                generation: entry.reservationGeneration,
                state: "cancelled",
              },
            };
          },
        );
        if (
          fence.value?.kind === "ticket_reservation" &&
          fence.value.state === "committed" &&
          fence.value.token === entry.reservationToken &&
          fence.value.generation === entry.reservationGeneration
        ) {
          retained.push({ ...entry, state: "confirmed" });
        }
      }
      return retained.length === current.entries.length &&
        retained.every((entry, position) => entry === current.entries[position])
        ? { action: "keep" }
        : {
            action: "write",
            value: { ...current, entries: retained },
          };
    },
  );
  return result.value?.entries.map((entry) => entry.ticketId) ?? [];
}

// ---------------------------------------------------------------------------
// Inbound threading index (Buildout Task 11)
// ---------------------------------------------------------------------------

/** Which looked-up identifier a thread-index row resolves. */
export type ThreadIndexKind = "message_id" | "reply_token" | "ticket_number";

/**
 * One key-lookup hint from an external identifier to a ticket.
 *
 * Partitions are `mid:<sha256>` for a `Message-ID`, `rt:<sha256>` for an
 * opaque reply-routing token, and `number:<n>` for an instance ticket number,
 * so every partition holds exactly one row and nothing grows without bound.
 * A row is never authorization evidence: every lookup reloads the causal
 * authoritative ticket or message and re-derives the row before trusting it.
 * The reply token itself is never stored here, only its hash.
 */
export interface ThreadIndexRecord {
  /** Physical partition (see above). */
  readonly key: string;
  readonly id: "thread";
  readonly kind: ThreadIndexKind;
  readonly ticketId: TicketId;
  /** Causal message for `message_id` and `reply_token` rows. */
  readonly messageId?: MessageId;
  /** Who generated an indexed `Message-ID`. */
  readonly source?: "outbound" | "inbound";
  /** Authoritative creation time of the causal message or ticket. */
  readonly issuedAt: IsoTimestamp;
}

const threadIndexKey = (record: ThreadIndexRecord): EntityKey => ({
  partition: record.key,
  id: record.id,
});

export const threadIndex = defineCollection<ThreadIndexRecord>({
  name: "support-desk.thread-index.v1",
  key: threadIndexKey,
  codec: jsonCodec(threadIndexKey),
});

/**
 * Default lifetime of `Message-ID` and reply-token threading rows. Lookups,
 * repair, and sweeping all treat older rows as absent; ticket-number rows
 * live as long as their ticket.
 */
export const defaultThreadIndexRetentionMilliseconds = 365 * 86_400_000;

/** Actor recorded on Audit events accepted from verified inbound mail. */
export const inboundEmailSystemActorId = "support-desk.inbound-email";

interface ThreadingHint {
  readonly messageId?: MessageId;
  readonly ticketNumber?: boolean;
}

function notificationThreading(command: {
  readonly messageId?: MessageId;
  readonly notification?: NotificationInput;
}): ThreadingHint | undefined {
  return command.notification === undefined || command.messageId === undefined
    ? undefined
    : { messageId: command.messageId };
}

function messageKey(ticketId: TicketId, messageId: MessageId): EntityKey {
  return { partition: ticketId, id: `message:${messageId}` };
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function messageIdIndexKey(value: string): Promise<string> {
  return `mid:${await sha256Hex(`message-id\u0000${value}`)}`;
}

async function replyTokenIndexKey(token: string): Promise<string> {
  return `rt:${await sha256Hex(`reply-token\u0000${token}`)}`;
}

function ticketNumberIndexKey(ticketNumber: number): string {
  return `number:${ticketNumber}`;
}

const inboundMessageIdPattern = /^<[^<>\s@]+@[^<>\s@]+>$/;
const maxInboundMessageIdCharacters = 512;

/**
 * Accept a header-shaped `<local@domain>` identifier or nothing. Malformed
 * sender-controlled identifiers are dropped rather than stored or matched.
 */
function normalizeInboundMessageId(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > maxInboundMessageIdCharacters ||
    /[\u0000-\u001F\u007F]/.test(trimmed) ||
    !inboundMessageIdPattern.test(trimmed)
  ) {
    return undefined;
  }
  return trimmed;
}

/** Derive every thread-index row an authoritative record implies. */
async function threadIndexEntriesFor(
  record: SupportRecord,
): Promise<ThreadIndexRecord[]> {
  if (record.kind === "ticket") {
    const ticket = record.ticket;
    if (
      ticket.id !== record.partition ||
      !Number.isSafeInteger(ticket.number) ||
      ticket.number <= 0
    ) {
      return [];
    }
    return [
      {
        key: ticketNumberIndexKey(ticket.number),
        id: "thread",
        kind: "ticket_number",
        ticketId: ticket.id,
        issuedAt: ticket.createdAt,
      },
    ];
  }
  if (record.kind !== "message") {
    return [];
  }
  const message = record.message;
  if (
    message.ticketId !== record.partition ||
    record.id !== `message:${message.id}`
  ) {
    return [];
  }
  const entries: ThreadIndexRecord[] = [];
  const content = record.deliveryContent;
  if (content !== undefined) {
    entries.push({
      key: await messageIdIndexKey(content.outboundMessageId),
      id: "thread",
      kind: "message_id",
      ticketId: message.ticketId,
      messageId: message.id,
      source: "outbound",
      issuedAt: message.createdAt,
    });
    if (content.replyRoutingToken !== undefined) {
      entries.push({
        key: await replyTokenIndexKey(content.replyRoutingToken),
        id: "thread",
        kind: "reply_token",
        ticketId: message.ticketId,
        messageId: message.id,
        issuedAt: message.createdAt,
      });
    }
  }
  if (
    message.channel === "email" &&
    message.authorKind === "customer" &&
    message.externalMessageId !== undefined &&
    message.externalMessageId !== content?.outboundMessageId &&
    normalizeInboundMessageId(message.externalMessageId) ===
      message.externalMessageId
  ) {
    entries.push({
      key: await messageIdIndexKey(message.externalMessageId),
      id: "thread",
      kind: "message_id",
      ticketId: message.ticketId,
      messageId: message.id,
      source: "inbound",
      issuedAt: message.createdAt,
    });
  }
  return entries;
}

/** First writer wins; a different mapping for the same key is a collision. */
async function putThreadIndexEntry(
  index: CollectionStore<ThreadIndexRecord>,
  entry: ThreadIndexRecord,
): Promise<"written" | "kept" | "collision"> {
  const result = await index.insertIfAbsent(entry);
  if (result.inserted) {
    return "written";
  }
  const existing = result.value;
  return existing.kind === entry.kind &&
    existing.ticketId === entry.ticketId &&
    existing.messageId === entry.messageId &&
    existing.source === entry.source
    ? "kept"
    : "collision";
}

function safeLog(
  logger: Logger,
  level: "warn" | "error",
  event: string,
  fields: Readonly<Record<string, unknown>>,
): void {
  try {
    logger.log(level, event, fields);
  } catch {
    // ignore logger transport failures
  }
}

/**
 * Best-effort post-commit threading writes for one ticket. Failures are
 * logged and later converged by {@link repairThreadIndexPage}; they never
 * fail the command that already committed. Does not sample the clock.
 */
async function indexThreadingAfterCommit(
  store: Store,
  ticketId: TicketId,
  hint: ThreadingHint,
  logger: Logger,
): Promise<void> {
  try {
    const records = store.collection(supportRecords);
    const index = store.collection(threadIndex);
    const sources: SupportRecord[] = [];
    if (hint.ticketNumber === true) {
      const ticket = await records.get(ticketKey(ticketId));
      if (ticket !== null) {
        sources.push(ticket);
      }
    }
    if (hint.messageId !== undefined) {
      const message = await records.get(messageKey(ticketId, hint.messageId));
      if (message !== null) {
        sources.push(message);
      }
    }
    for (const source of sources) {
      for (const entry of await threadIndexEntriesFor(source)) {
        if ((await putThreadIndexEntry(index, entry)) === "collision") {
          safeLog(logger, "warn", "support-desk.thread_index.collision", {
            ticketId,
            kind: entry.kind,
          });
        }
      }
    }
  } catch (error) {
    safeLog(logger, "error", "support-desk.thread_index.write_failed", {
      ticketId,
      message:
        error instanceof Error ? error.message : "thread index write failed",
    });
  }
}

/**
 * Re-derive a row from its authoritative ticket or message. Returns the
 * current ticket only when the row still describes that record and, for
 * message rows, is inside the retention window.
 */
async function confirmThreadEntry(
  records: CollectionStore<SupportRecord>,
  entry: ThreadIndexRecord,
  nowEpoch: number,
  retentionMilliseconds: number,
): Promise<Ticket | null> {
  const ticketRecord = await records.get(ticketKey(entry.ticketId));
  if (
    ticketRecord?.kind !== "ticket" ||
    ticketRecord.ticket.id !== entry.ticketId
  ) {
    return null;
  }
  let authoritative: SupportRecord = ticketRecord;
  if (entry.kind !== "ticket_number") {
    if (entry.messageId === undefined) {
      return null;
    }
    const message = await records.get(
      messageKey(entry.ticketId, entry.messageId),
    );
    if (message === null) {
      return null;
    }
    authoritative = message;
  }
  const derived = (await threadIndexEntriesFor(authoritative)).find(
    (candidate) => candidate.key === entry.key && candidate.kind === entry.kind,
  );
  if (
    derived === undefined ||
    derived.ticketId !== entry.ticketId ||
    derived.messageId !== entry.messageId ||
    derived.source !== entry.source
  ) {
    return null;
  }
  if (
    derived.kind !== "ticket_number" &&
    nowEpoch - canonicalTimestamp(derived.issuedAt, "thread index issuedAt") >=
      retentionMilliseconds
  ) {
    return null;
  }
  return ticketRecord.ticket;
}

async function lookupThreadEntry(
  records: CollectionStore<SupportRecord>,
  index: CollectionStore<ThreadIndexRecord>,
  kind: ThreadIndexKind,
  key: string,
  nowEpoch: number,
  retentionMilliseconds: number,
): Promise<{
  readonly ticket: Ticket;
  readonly entry: ThreadIndexRecord;
} | null> {
  const entry = await index.get({ partition: key, id: "thread" });
  if (entry === null || entry.key !== key || entry.kind !== kind) {
    return null;
  }
  const ticket = await confirmThreadEntry(
    records,
    entry,
    nowEpoch,
    retentionMilliseconds,
  );
  return ticket === null ? null : { ticket, entry };
}

export interface ThreadIndexWorkerOptions {
  readonly store: Store;
  readonly clock: Clock;
  /**
   * Shared lifetime for `Message-ID` and reply-token rows. Hosts pass the
   * value configured on the inbound processor to every repair and sweep
   * invocation (no silent per-worker default).
   */
  readonly threadIndexRetentionMilliseconds: number;
  /** Opaque adapter-issued continuation; omit to begin a new cycle. */
  readonly cursor?: string;
  /** Physical records per page; at most {@link MAX_SCAN_PAGE_SIZE}. */
  readonly limit?: number;
}

export interface ThreadIndexRepairPageResult {
  /** Host-persisted only after this whole page succeeds. */
  readonly nextCursor: string | null;
  readonly physicalRows: number;
  readonly indexed: number;
  readonly collisions: number;
}

export interface ThreadIndexSweepPageResult {
  readonly nextCursor: string | null;
  readonly physicalRows: number;
  readonly deleted: number;
}

function parseRetentionMilliseconds(value: unknown, field: string): number {
  if (typeof value !== "number") {
    throw new TypeError(`${field} must be a number`);
  }
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${field} must be a positive safe integer`);
  }
  return value;
}

function parseThreadIndexWorkerOptions(
  options: unknown,
  field: string,
): {
  readonly store: Store;
  readonly clock: Clock;
  readonly retentionMilliseconds: number;
  readonly cursor?: string;
  readonly limit: number;
} {
  const source = boundaryObject(options, field);
  const store = ownDataProperty(source, "store", `${field}.store`) as Store;
  const clock = ownDataProperty(source, "clock", `${field}.clock`) as Clock;
  const retentionMilliseconds = parseRetentionMilliseconds(
    ownDataProperty(
      source,
      "threadIndexRetentionMilliseconds",
      `${field}.threadIndexRetentionMilliseconds`,
    ),
    `${field}.threadIndexRetentionMilliseconds`,
  );
  const rawCursor = ownDataProperty(source, "cursor", `${field}.cursor`, true);
  const rawLimit = ownDataProperty(source, "limit", `${field}.limit`, true);
  if (rawCursor !== undefined && typeof rawCursor !== "string") {
    throw new TypeError(`${field}.cursor must be a string`);
  }
  if (rawLimit !== undefined && typeof rawLimit !== "number") {
    throw new TypeError(
      `${field}.limit must be between 1 and ${MAX_SCAN_PAGE_SIZE}`,
    );
  }
  const limit = (rawLimit as number | undefined) ?? 100;
  if (
    !Number.isSafeInteger(limit) ||
    limit <= 0 ||
    limit > MAX_SCAN_PAGE_SIZE
  ) {
    throw new TypeError(
      `${field}.limit must be between 1 and ${MAX_SCAN_PAGE_SIZE}`,
    );
  }
  return {
    store,
    clock,
    retentionMilliseconds,
    ...(rawCursor === undefined ? {} : { cursor: rawCursor }),
    limit,
  };
}

/**
 * Scan one page of authoritative `support-desk.records.v1` rows and insert
 * every thread-index row they imply (ticket numbers, outbound `Message-ID`s,
 * reply tokens, and inbound `Message-ID`s). Rows past retention are not
 * recreated. Hosts persist `nextCursor` only after the whole page succeeds
 * and repeat complete cycles.
 */
export async function repairThreadIndexPage(
  options: ThreadIndexWorkerOptions,
): Promise<ThreadIndexRepairPageResult> {
  const { store, clock, retentionMilliseconds, cursor, limit } =
    parseThreadIndexWorkerOptions(options, "thread index repair options");
  const records = store.collection(supportRecords);
  const index = store.collection(threadIndex);
  const page = await records.scan({
    limit,
    ...(cursor === undefined ? {} : { cursor }),
  });
  const nowEpoch = canonicalTimestamp(clock.now(), "clock.now()");
  let indexed = 0;
  let collisions = 0;
  for (const entry of page.records) {
    if (
      entry.key.partition !== entry.value.partition ||
      entry.key.id !== entry.value.id
    ) {
      continue;
    }
    for (const candidate of await threadIndexEntriesFor(entry.value)) {
      if (
        candidate.kind !== "ticket_number" &&
        nowEpoch -
          canonicalTimestamp(candidate.issuedAt, "thread index issuedAt") >=
          retentionMilliseconds
      ) {
        continue;
      }
      const outcome = await putThreadIndexEntry(index, candidate);
      if (outcome === "written") {
        indexed += 1;
      } else if (outcome === "collision") {
        collisions += 1;
      }
    }
  }
  return {
    nextCursor: page.nextCursor,
    physicalRows: page.records.length,
    indexed,
    collisions,
  };
}

/**
 * Scan one page of thread-index rows and conditionally delete every row whose
 * authoritative target is gone, no longer derives it, or is past retention.
 * Uses `deleteIfUnchanged` with the scanned version.
 */
export async function sweepThreadIndexPage(
  options: ThreadIndexWorkerOptions,
): Promise<ThreadIndexSweepPageResult> {
  const { store, clock, retentionMilliseconds, cursor, limit } =
    parseThreadIndexWorkerOptions(options, "thread index sweep options");
  const records = store.collection(supportRecords);
  const index = store.collection(threadIndex);
  const page = await index.scan({
    limit,
    ...(cursor === undefined ? {} : { cursor }),
  });
  const nowEpoch = canonicalTimestamp(clock.now(), "clock.now()");
  let deleted = 0;
  for (const entry of page.records) {
    if (entry.key.partition !== entry.value.key || entry.key.id !== "thread") {
      continue;
    }
    if (
      (await confirmThreadEntry(
        records,
        entry.value,
        nowEpoch,
        retentionMilliseconds,
      )) !== null
    ) {
      continue;
    }
    if (await index.deleteIfUnchanged(entry.key, entry.version)) {
      deleted += 1;
    }
  }
  return {
    nextCursor: page.nextCursor,
    physicalRows: page.records.length,
    deleted,
  };
}

// ---------------------------------------------------------------------------
// Inbound mail processing (Buildout Task 11)
// ---------------------------------------------------------------------------

/**
 * Loop and bounce signals the host adapter copies from verified headers or
 * the SMTP envelope. Support Desk only inspects them; it never stores them.
 */
export interface InboundLoopSignals {
  /** RFC 3834 `Auto-Submitted`; any value other than `no` suppresses. */
  readonly autoSubmitted?: string;
  /** `Precedence`; `bulk`, `junk`, `list`, or `auto_reply` suppresses. */
  readonly precedence?: string;
  /**
   * `X-Auto-Response-Suppress`; `All`, `OOF`, or `AutoReply` keeps the message
   * but forbids an automatic acknowledgement to the sender.
   */
  readonly autoResponseSuppress?: string;
  /** True when `X-Autoreply`, `X-Autorespond`, or a similar header exists. */
  readonly autoReplyHeaderPresent?: boolean;
  /** `List-Id`; keeps the message but forbids an acknowledgement. */
  readonly listId?: string;
  /** Top-level `Content-Type`; `multipart/report` and delivery-status suppress. */
  readonly contentType?: string;
  /** SMTP envelope sender (`Return-Path`); empty or `<>` is a bounce. */
  readonly envelopeSender?: string;
}

/**
 * Provider-neutral inbound message, produced by a host adapter only after it
 * verified the provider webhook or delivery mechanism, bounded MIME parsing,
 * and reduced the content to safe plain text or constrained Markdown.
 *
 * Sender and content fields are hostile sender-controlled data. Identifiers
 * are host-minted, and `senderAuthentication` is a host-evaluated result from
 * trusted post-verification evidence. Raw MIME and HTML never belong here.
 * There is deliberately no principal, role, plan, priority, or session field:
 * sender authentication permits an email reply join but never establishes web
 * identity or access.
 */
export interface InboundEmailInput {
  /** Host mailbox or channel identifier (an opaque name, not an address). */
  readonly channelId: string;
  /** Provider's stable event or delivery identifier for deduplication. */
  readonly providerEventId: string;
  /** Server-minted ID used only if this event creates a new ticket. */
  readonly ticketId: TicketId;
  /** Server-minted ID for the message this event may create. */
  readonly messageId: MessageId;
  readonly correlationId: string;
  /** Sender address chosen by the host adapter; routing input only. */
  readonly from: string;
  /** Host-evaluated sender result bound to the normalized `from` address. */
  readonly senderAuthentication?: InboundSenderAuthentication;
  /** Untrusted display name; stored for staff context only. */
  readonly fromName?: string;
  /** Decoded subject; controls collapse and it is cut to the subject limit. */
  readonly subject: string;
  /** Normalized safe text with quoted history already bounded by the host. */
  readonly body: string;
  readonly format?: MessageFormat;
  /** The inbound message's own `Message-ID`. */
  readonly externalMessageId?: string;
  readonly inReplyTo?: string;
  /** `References`, oldest first; only the newest entries are consulted. */
  readonly references?: readonly string[];
  /** Candidate opaque token the host extracted from the reply address. */
  readonly replyRoutingToken?: string;
  readonly loopSignals?: InboundLoopSignals;
}

/** Host account-email lookup result. Only `one` yields `matched_email`. */
export type InboundSenderMatch =
  | { readonly matches: "none" }
  | { readonly matches: "one"; readonly principalId: PrincipalId }
  | { readonly matches: "many" };

/**
 * Host port that compares a sender address with known accounts. The answer
 * routes a ticket; it never authenticates the sender, never grants web
 * access, and is never used to choose an `AccessContext`.
 */
export interface InboundAccountMatcher {
  matchSenderEmail(input: {
    readonly channelId: string;
    readonly email: string;
  }): Promise<InboundSenderMatch>;
}

/** Inbound mail may never be automatically assigned `urgent`. */
export type InboundRoutingPriority = Exclude<TicketPriority, "urgent">;

/** Content-free routing facts. Subject and body are deliberately absent. */
export interface InboundRoutingInput {
  readonly channelId: string;
  readonly association: "matched_email" | "unverified";
  /** Present only for `matched_email`; routing context, not identity. */
  readonly principalId?: PrincipalId;
  readonly relatedTicketId?: TicketId;
}

export interface InboundRoutingDecision {
  readonly priority: InboundRoutingPriority;
  /** Optional category from the processor's configured allowlist. */
  readonly category?: string;
}

/** Host policy for a new inbound conversation (paid/unpaid tables live here). */
export interface InboundRoutingPolicy {
  routeNewConversation(
    input: InboundRoutingInput,
  ): InboundRoutingDecision | Promise<InboundRoutingDecision>;
}

export interface InboundNotificationContext {
  readonly outcome: "created" | "replied";
  readonly channelId: string;
  readonly ticketId: TicketId;
  readonly ticketNumber: number;
  readonly messageId: MessageId;
  readonly association: RequesterAssociation;
  readonly matchMethod: InboundMatchMethod;
  readonly assignedTo?: PrincipalId;
  /**
   * False when the sender asked for no automatic responses or the message
   * came through a list. Hosts must then not acknowledge the sender; a staff
   * notification is still allowed.
   */
  readonly senderAcknowledgementAllowed: boolean;
}

/**
 * Optional host port returning one notification to commit in the same ticket
 * transaction as the inbound message (for example a staff alert). Never
 * called for suppressed, duplicate, or rejected mail.
 */
export interface InboundNotificationPolicy {
  notificationFor(
    context: InboundNotificationContext,
  ): NotificationInput | undefined | Promise<NotificationInput | undefined>;
}

export interface InboundEmailResult {
  /** True when this provider event already had a receipt. */
  readonly duplicateDelivery: boolean;
  readonly outcome: InboundEmailOutcome;
  readonly ticketId?: TicketId;
  readonly messageId?: MessageId;
  readonly matchMethod?: InboundMatchMethod;
  /** Requester association of a newly created ticket. */
  readonly association?: RequesterAssociation;
  readonly relatedTicketId?: TicketId;
  /** Coarse content-free reason for `suppressed` or `rejected`. */
  readonly reason?: string;
}

export interface InboundMailProcessorOptions {
  readonly store: Store;
  readonly clock: Clock;
  readonly logger?: Logger;
  readonly accountMatcher: InboundAccountMatcher;
  readonly routingPolicy: InboundRoutingPolicy;
  readonly notificationPolicy?: InboundNotificationPolicy;
  /** Same limits as the application; subject and body bounds apply here. */
  readonly limits?: Partial<SupportDeskLimits>;
  readonly maxConflictAttempts?: number;
  /** Must equal the application's queue terminal-retention cutoff. */
  readonly queueTerminalRetentionMilliseconds?: number;
  /** Lifetime of `Message-ID` and reply-token rows; defaults to 365 days. */
  readonly threadIndexRetentionMilliseconds?: number;
  /** Frozen category allowlist for host routing decisions. */
  readonly allowedCategories?: readonly string[];
  readonly responseTargetPolicy?: ResponseTargetPolicy;
  /**
   * Instance subject-marker prefix, for example `SD` for `[SD-1042]`. Without
   * one, subject-marker fallback is disabled.
   */
  readonly subjectMarkerPrefix?: string;
  /** This instance's own support addresses; mail from them is a loop. */
  readonly supportAddresses?: readonly string[];
}

export interface InboundMailProcessor {
  /**
   * Deduplicate, route, and record one verified inbound message. Safe to
   * retry with the same provider event: a retry resumes the first delivery's
   * reserved identifiers and routing decision and returns its result.
   */
  processInboundEmail(input: InboundEmailInput): Promise<InboundEmailResult>;
}

interface InboundEmailSnapshot {
  readonly channelId: string;
  readonly providerEventId: string;
  readonly ticketId: TicketId;
  readonly messageId: MessageId;
  readonly correlationId: string;
  readonly from: string;
  readonly senderAuthentication?: InboundSenderAuthentication;
  readonly fromName?: string;
  readonly subject: string;
  readonly body: string;
  readonly format: MessageFormat;
  readonly externalMessageId?: string;
  readonly inReplyTo?: string;
  readonly references: readonly string[];
  readonly replyRoutingToken?: string;
  readonly loopSignals: InboundLoopSignals;
}

const maxInboundReferences = 100;
const maxThreadingLookups = 20;
const maxLoopSignalCharacters = 998;
const maxInboundDisplayNameCharacters = 200;
const maxSupportAddresses = 32;
const subjectMarkerPrefixPattern = /^[A-Z][A-Z0-9]{0,15}$/;
const inboundSuppressingPrecedence = new Set([
  "bulk",
  "junk",
  "list",
  "auto_reply",
  "auto-reply",
]);

function collapseHeaderText(value: string): string {
  return value
    .replace(/[\u0000-\u001F\u007F]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeInboundSubject(value: string, maximum: number): string {
  const collapsed = collapseHeaderText(value);
  const text = collapsed.length === 0 ? "(no subject)" : collapsed;
  const points = [...text];
  return points.length > maximum
    ? points.slice(0, maximum).join("").trimEnd()
    : text;
}

function normalizeInboundBody(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

function normalizeInboundDisplayName(value: string): string | undefined {
  const collapsed = collapseHeaderText(value);
  if (collapsed.length === 0) {
    return undefined;
  }
  return [...collapsed].slice(0, maxInboundDisplayNameCharacters).join("");
}

function snapshotLoopSignals(input: unknown): InboundLoopSignals {
  if (input === undefined) {
    return Object.freeze({});
  }
  const source = boundaryObject(input, "inbound email.loopSignals");
  const signals: Record<string, string | boolean> = {};
  for (const key of [
    "autoSubmitted",
    "precedence",
    "autoResponseSuppress",
    "listId",
    "contentType",
    "envelopeSender",
  ] as const) {
    const value = ownDataProperty(
      source,
      key,
      `inbound email.loopSignals.${key}`,
      true,
    );
    if (value === undefined) {
      continue;
    }
    if (typeof value !== "string") {
      throw new TypeError(`inbound email.loopSignals.${key} must be a string`);
    }
    signals[key] = value.slice(0, maxLoopSignalCharacters);
  }
  const autoReply = ownDataProperty(
    source,
    "autoReplyHeaderPresent",
    "inbound email.loopSignals.autoReplyHeaderPresent",
    true,
  );
  if (autoReply !== undefined) {
    if (typeof autoReply !== "boolean") {
      throw new TypeError(
        "inbound email.loopSignals.autoReplyHeaderPresent must be a boolean",
      );
    }
    signals.autoReplyHeaderPresent = autoReply;
  }
  return Object.freeze(signals) as InboundLoopSignals;
}

function snapshotInboundSenderAuthentication(
  input: unknown,
): InboundSenderAuthentication | undefined {
  if (input === undefined) {
    return undefined;
  }
  const field = "inbound email.senderAuthentication";
  const source = boundaryObject(input, field);
  const method = ownDataProperty(source, "method", `${field}.method`);
  if (method !== "dmarc" && method !== "host_identity") {
    throw new TypeError(`${field}.method must be dmarc or host_identity`);
  }
  const result = ownDataProperty(source, "result", `${field}.result`);
  if (result !== "pass" && result !== "fail") {
    throw new TypeError(`${field}.result must be pass or fail`);
  }
  const email = normalizeRequesterEmail(
    boundaryString(
      ownDataProperty(source, "email", `${field}.email`),
      `${field}.email`,
    ),
    `${field}.email`,
  ) as string;
  if (method === "host_identity") {
    for (const key of ["dkimAligned", "spfAligned"] as const) {
      ownDataProperty(source, key, `${field}.${key}`, true, true);
      if (Object.hasOwn(source, key)) {
        throw new TypeError(
          `${field}.${key} is not valid when method is host_identity`,
        );
      }
    }
    return Object.freeze({ method, result, email });
  }
  const dkimAligned = ownDataProperty(
    source,
    "dkimAligned",
    `${field}.dkimAligned`,
  );
  if (typeof dkimAligned !== "boolean") {
    throw new TypeError(`${field}.dkimAligned must be a boolean`);
  }
  const spfAligned = ownDataProperty(
    source,
    "spfAligned",
    `${field}.spfAligned`,
  );
  if (typeof spfAligned !== "boolean") {
    throw new TypeError(`${field}.spfAligned must be a boolean`);
  }
  return Object.freeze({
    method,
    result,
    email,
    dkimAligned,
    spfAligned,
  });
}

function snapshotInboundEmailInput(
  input: unknown,
  limits: SupportDeskLimits,
): InboundEmailSnapshot {
  const source = boundaryObject(input, "inbound email");
  const field = (key: string): string => `inbound email.${key}`;
  const readString = (key: string): string =>
    boundaryString(ownDataProperty(source, key, field(key)), field(key));
  const readIdentifier = (key: string): string => {
    const value = readString(key);
    requireIdentifier(value, field(key));
    return value;
  };
  const readOptional = (key: string): unknown =>
    ownDataProperty(source, key, field(key), true);

  const channelId = readIdentifier("channelId");
  const providerEventId = readIdentifier("providerEventId");
  const ticketId = readIdentifier("ticketId");
  const messageId = readIdentifier("messageId");
  const correlationId = readIdentifier("correlationId");
  const from = normalizeRequesterEmail(
    readString("from"),
    field("from"),
  ) as string;
  const rawSenderAuthentication = ownDataProperty(
    source,
    "senderAuthentication",
    field("senderAuthentication"),
    true,
    true,
  );
  const senderAuthentication = snapshotInboundSenderAuthentication(
    rawSenderAuthentication,
  );
  const rawName = readOptional("fromName");
  const fromName =
    rawName === undefined
      ? undefined
      : normalizeInboundDisplayName(boundaryString(rawName, field("fromName")));
  const subject = normalizeInboundSubject(
    readString("subject"),
    limits.maxSubjectCharacters,
  );
  const body = normalizeInboundBody(readString("body"));
  enforceLimit(body, "body", limits.maxMessageCharacters);
  const rawFormat = readOptional("format");
  if (
    rawFormat !== undefined &&
    rawFormat !== "plain_text" &&
    rawFormat !== "markdown"
  ) {
    throw new TypeError(`${field("format")} must be plain_text or markdown`);
  }
  const format: MessageFormat = rawFormat ?? "plain_text";
  const externalMessageId = normalizeInboundMessageId(
    readOptional("externalMessageId"),
  );
  const inReplyTo = normalizeInboundMessageId(readOptional("inReplyTo"));
  const rawReferences = readOptional("references");
  const references: string[] = [];
  if (rawReferences !== undefined) {
    if (!Array.isArray(rawReferences)) {
      throw new TypeError(`${field("references")} must be an array`);
    }
    const start = Math.max(0, rawReferences.length - maxInboundReferences);
    for (let position = start; position < rawReferences.length; position += 1) {
      const normalized = normalizeInboundMessageId(
        ownDataProperty(
          rawReferences,
          position,
          `${field("references")}[${position}]`,
        ),
      );
      if (normalized !== undefined && !references.includes(normalized)) {
        references.push(normalized);
      }
    }
  }
  const rawToken = readOptional("replyRoutingToken");
  if (rawToken !== undefined && typeof rawToken !== "string") {
    throw new TypeError(`${field("replyRoutingToken")} must be a string`);
  }
  const token = rawToken?.trim();
  const replyRoutingToken =
    token !== undefined && replyRoutingTokenPattern.test(token)
      ? token
      : undefined;
  const loopSignals = snapshotLoopSignals(readOptional("loopSignals"));
  return Object.freeze({
    channelId,
    providerEventId,
    ticketId,
    messageId,
    correlationId,
    from,
    ...(senderAuthentication === undefined ? {} : { senderAuthentication }),
    ...(fromName === undefined ? {} : { fromName }),
    subject,
    body,
    format,
    ...(externalMessageId === undefined ? {} : { externalMessageId }),
    ...(inReplyTo === undefined ? {} : { inReplyTo }),
    references: Object.freeze(references),
    ...(replyRoutingToken === undefined ? {} : { replyRoutingToken }),
    loopSignals,
  });
}

/** Content fingerprint for one provider event; excludes host-minted IDs. */
function inboundFingerprintPayload(input: InboundEmailSnapshot): unknown {
  return {
    type: "inbound_email",
    channelId: input.channelId,
    providerEventId: input.providerEventId,
    from: input.from.toLowerCase(),
    ...(input.senderAuthentication === undefined
      ? {}
      : {
          senderAuthentication: {
            ...input.senderAuthentication,
            email: input.senderAuthentication.email.toLowerCase(),
          },
        }),
    fromName: input.fromName ?? null,
    subject: input.subject,
    body: input.body,
    format: input.format,
    externalMessageId: input.externalMessageId ?? null,
    inReplyTo: input.inReplyTo ?? null,
    references: input.references,
    replyRoutingToken: input.replyRoutingToken ?? null,
    loopSignals: input.loopSignals,
  };
}

function inboundSuppressionReason(
  input: InboundEmailSnapshot,
  supportAddresses: ReadonlySet<string>,
): InboundSuppressionReason | undefined {
  const signals = input.loopSignals;
  const autoSubmitted = signals.autoSubmitted
    ?.split(";")[0]
    ?.trim()
    .toLowerCase();
  if (
    autoSubmitted !== undefined &&
    autoSubmitted.length > 0 &&
    autoSubmitted !== "no"
  ) {
    return "auto_submitted";
  }
  const precedence = signals.precedence?.trim().toLowerCase();
  if (
    precedence !== undefined &&
    inboundSuppressingPrecedence.has(precedence)
  ) {
    return "precedence";
  }
  if (signals.autoReplyHeaderPresent === true) {
    return "auto_reply_header";
  }
  if (signals.envelopeSender !== undefined) {
    const envelope = signals.envelopeSender.trim();
    if (envelope.length === 0 || envelope === "<>") {
      return "bounce";
    }
  }
  const localPart = input.from.slice(0, input.from.indexOf("@")).toLowerCase();
  if (localPart === "mailer-daemon") {
    return "bounce";
  }
  const contentType = signals.contentType?.trim().toLowerCase();
  if (
    contentType !== undefined &&
    (contentType.startsWith("multipart/report") ||
      contentType.startsWith("message/delivery-status") ||
      contentType.startsWith("message/disposition-notification"))
  ) {
    return "delivery_report";
  }
  if (supportAddresses.has(input.from.toLowerCase())) {
    return "support_address_loop";
  }
  return undefined;
}

function inboundSenderAcknowledgementAllowed(
  input: InboundEmailSnapshot,
): boolean {
  const suppress = (input.loopSignals.autoResponseSuppress ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase());
  if (
    suppress.some(
      (value) => value === "all" || value === "oof" || value === "autoreply",
    )
  ) {
    return false;
  }
  return (input.loopSignals.listId ?? "").trim().length === 0;
}

function subjectMarkerNumbers(subject: string, prefix: string): number[] {
  const pattern = new RegExp(`\\[${prefix}-([1-9][0-9]{0,15})\\]`, "g");
  const found: number[] = [];
  for (const match of subject.matchAll(pattern)) {
    const value = Number(match[1]);
    if (Number.isSafeInteger(value) && !found.includes(value)) {
      found.push(value);
    }
  }
  return found;
}

function threadingHeaderCandidates(input: InboundEmailSnapshot): string[] {
  const ordered = [
    ...(input.inReplyTo === undefined ? [] : [input.inReplyTo]),
    ...[...input.references].reverse(),
  ];
  const unique: string[] = [];
  for (const candidate of ordered) {
    if (candidate !== input.externalMessageId && !unique.includes(candidate)) {
      unique.push(candidate);
    }
    if (unique.length >= maxThreadingLookups) {
      break;
    }
  }
  return unique;
}

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

/**
 * A thread match with a recorded requester address requires both exact
 * case-insensitive address equality and a passing host-evaluated sender result
 * bound to that normalized address. Without a recorded address, only an
 * opaque routing token can join; a `Message-ID` or subject marker alone is
 * never enough.
 */
function threadJoinIsSafe(
  ticket: Ticket,
  method: Exclude<InboundMatchMethod, "none">,
  input: InboundEmailSnapshot,
): boolean {
  const email = ticket.requester.email;
  if (email === undefined) {
    return method === "routing_token";
  }
  const authentication = input.senderAuthentication;
  if (
    authentication === undefined ||
    authentication.result !== "pass" ||
    !sameAddress(email, input.from) ||
    !sameAddress(authentication.email, input.from)
  ) {
    return false;
  }
  return (
    authentication.method === "host_identity" ||
    authentication.dkimAligned ||
    authentication.spfAligned
  );
}

function snapshotSenderMatch(value: unknown): InboundSenderMatch {
  const source = boundaryObject(value, "account matcher result");
  const matches = ownDataProperty(
    source,
    "matches",
    "account matcher result.matches",
  );
  if (matches === "none" || matches === "many") {
    return Object.freeze({ matches });
  }
  if (matches === "one") {
    const principalId = boundaryString(
      ownDataProperty(
        source,
        "principalId",
        "account matcher result.principalId",
      ),
      "account matcher result.principalId",
    );
    requireIdentifier(principalId, "account matcher result.principalId");
    return Object.freeze({ matches, principalId });
  }
  throw new TypeError(
    "account matcher result.matches must be none, one, or many",
  );
}

function snapshotRoutingDecision(
  value: unknown,
  allowedCategories: ReadonlySet<string> | undefined,
): InboundRoutingDecision {
  const source = boundaryObject(value, "inbound routing decision");
  const priority = ownDataProperty(
    source,
    "priority",
    "inbound routing decision.priority",
  );
  if (priority !== "low" && priority !== "normal" && priority !== "high") {
    throw new TypeError(
      "inbound routing decision.priority must be low, normal, or high; inbound mail is never automatically urgent",
    );
  }
  const category = snapshotCategory(
    ownDataProperty(
      source,
      "category",
      "inbound routing decision.category",
      true,
    ),
    "inbound routing decision.category",
  );
  if (
    category !== undefined &&
    (allowedCategories === undefined || !allowedCategories.has(category))
  ) {
    throw new TypeError(
      "inbound routing decision.category is not configured for this Support Desk instance",
    );
  }
  return Object.freeze({
    priority,
    ...(category === undefined ? {} : { category }),
  });
}

function inboundAuditAction(input: {
  readonly commandId: string;
  readonly correlationId: string;
  readonly ticketId: TicketId;
  readonly revision: number;
  readonly occurredAt: IsoTimestamp;
  readonly action:
    | typeof supportTicketAuditActions.created
    | typeof supportTicketAuditActions.customerReplied;
  readonly matchMethod: InboundMatchMethod;
  readonly association?: RequesterAssociation;
}): ReturnType<typeof supportAudit.action> {
  return supportAudit.action({
    id: input.commandId,
    occurredAt: input.occurredAt,
    actor: { kind: "system", systemId: inboundEmailSystemActorId },
    action: input.action,
    subject: input.ticketId,
    sequence: input.revision,
    details: {
      commandId: input.commandId,
      correlationId: input.correlationId,
      channel: "email",
      matchMethod: input.matchMethod,
      ...(input.association === undefined
        ? {}
        : { association: input.association }),
    },
  });
}

function inboundMessage(
  input: InboundEmailSnapshot,
  ticketId: TicketId,
  messageId: MessageId,
  now: IsoTimestamp,
): TicketMessage {
  // No authorPrincipalId: a sender address never authenticates authorship.
  return {
    id: messageId,
    ticketId,
    authorKind: "customer",
    channel: "email",
    visibility: "customer",
    format: input.format,
    body: input.body,
    createdAt: now,
    ...(input.externalMessageId === undefined
      ? {}
      : { externalMessageId: input.externalMessageId }),
    ...(input.inReplyTo === undefined
      ? {}
      : { inReplyToExternalMessageId: input.inReplyTo }),
  };
}

function inboundResult(
  receipt: InboundReceipt,
  duplicateDelivery: boolean,
): InboundEmailResult {
  const route = receipt.route;
  return Object.freeze({
    duplicateDelivery,
    outcome: receipt.outcome ?? "rejected",
    ...(receipt.ticketId === undefined ? {} : { ticketId: receipt.ticketId }),
    ...(receipt.messageId === undefined
      ? {}
      : { messageId: receipt.messageId }),
    ...(route?.kind === "reply" || route?.kind === "new_conversation"
      ? { matchMethod: route.matchMethod }
      : {}),
    ...(route?.kind === "new_conversation"
      ? {
          association: route.association,
          ...(route.relatedTicketId === undefined
            ? {}
            : { relatedTicketId: route.relatedTicketId }),
        }
      : {}),
    ...(receipt.diagnostic === undefined ? {} : { reason: receipt.diagnostic }),
  });
}

function parseSupportAddresses(input: unknown): ReadonlySet<string> {
  const field = "inbound mail processor options.supportAddresses";
  if (input === undefined) {
    return new Set();
  }
  if (!Array.isArray(input)) {
    throw new TypeError(`${field} must be an array`);
  }
  if (input.length > maxSupportAddresses) {
    throw new TypeError(
      `${field} may contain at most ${maxSupportAddresses} values`,
    );
  }
  const addresses = new Set<string>();
  for (let position = 0; position < input.length; position += 1) {
    const entry = `${field}[${position}]`;
    const value = normalizeRequesterEmail(
      boundaryString(ownDataProperty(input, position, entry), entry),
      entry,
    ) as string;
    addresses.add(value.toLowerCase());
  }
  return addresses;
}

type NewConversationRoute = Extract<
  InboundReceiptRoute,
  { readonly kind: "new_conversation" }
>;
type ReplyRoute = Extract<InboundReceiptRoute, { readonly kind: "reply" }>;

interface InboundWork {
  readonly key: EntityKey;
  readonly input: InboundEmailSnapshot;
  readonly route: InboundReceiptRoute;
  readonly messageId: MessageId;
  readonly correlationId: string;
  readonly commandId: string;
  readonly fingerprint: string;
  readonly duplicateDelivery: boolean;
}

/**
 * Create the inbound mail processor a host's mail worker calls after it has
 * verified provider authenticity and normalized bounded MIME content.
 *
 * Processing order: reserve the provider-event receipt with `insertIfAbsent`
 * before any ticket work; suppress bounce and auto-reply loops; persist one
 * routing decision on the receipt (routing token, then `In-Reply-To` /
 * `References`, then subject marker, each confirmed against authoritative
 * records); then create or reply in one ticket-partition transaction with
 * its Audit event, command receipt, and optional notification; finally mark
 * the receipt terminal and refresh the queue and threading projections.
 */
export function createInboundMailProcessor(
  options: InboundMailProcessorOptions,
): InboundMailProcessor {
  const field = "inbound mail processor options";
  const source = boundaryObject(options, field);
  const read = (key: string, optional = false): unknown =>
    ownDataProperty(source, key, `${field}.${key}`, optional);
  const store = read("store") as Store;
  const clock = read("clock") as Clock;
  const rawLogger = read("logger", true);
  const logger = rawLogger === undefined ? noopLogger : (rawLogger as Logger);
  const accountMatcher = read("accountMatcher") as
    InboundAccountMatcher | undefined;
  const routingPolicy = read("routingPolicy") as
    InboundRoutingPolicy | undefined;
  const notificationPolicy = read("notificationPolicy", true) as
    InboundNotificationPolicy | undefined;
  if (
    accountMatcher === undefined ||
    accountMatcher === null ||
    typeof accountMatcher.matchSenderEmail !== "function"
  ) {
    throw new TypeError(
      `${field}.accountMatcher must provide matchSenderEmail()`,
    );
  }
  if (
    routingPolicy === undefined ||
    routingPolicy === null ||
    typeof routingPolicy.routeNewConversation !== "function"
  ) {
    throw new TypeError(
      `${field}.routingPolicy must provide routeNewConversation()`,
    );
  }
  if (
    notificationPolicy !== undefined &&
    (notificationPolicy === null ||
      typeof notificationPolicy.notificationFor !== "function")
  ) {
    throw new TypeError(
      `${field}.notificationPolicy must provide notificationFor()`,
    );
  }
  const limits = resolveSupportDeskLimits(
    read("limits", true),
    `${field}.limits`,
  );
  const rawAttempts = read("maxConflictAttempts", true);
  if (rawAttempts !== undefined && typeof rawAttempts !== "number") {
    throw new TypeError("maxConflictAttempts must be between 1 and 20");
  }
  const maxConflictAttempts = (rawAttempts as number | undefined) ?? 4;
  if (
    !Number.isSafeInteger(maxConflictAttempts) ||
    maxConflictAttempts <= 0 ||
    maxConflictAttempts > 20
  ) {
    throw new TypeError("maxConflictAttempts must be between 1 and 20");
  }
  const rawTerminalRetention = read("queueTerminalRetentionMilliseconds", true);
  if (
    rawTerminalRetention !== undefined &&
    typeof rawTerminalRetention !== "number"
  ) {
    throw new TypeError(
      "queueTerminalRetentionMilliseconds must be a non-negative safe integer",
    );
  }
  const terminalRetentionMilliseconds =
    (rawTerminalRetention as number | undefined) ??
    defaultQueueTerminalRetentionMilliseconds;
  if (
    !Number.isSafeInteger(terminalRetentionMilliseconds) ||
    terminalRetentionMilliseconds < 0
  ) {
    throw new TypeError(
      "queueTerminalRetentionMilliseconds must be a non-negative safe integer",
    );
  }
  const rawThreadRetention = read("threadIndexRetentionMilliseconds", true);
  const threadIndexRetentionMilliseconds =
    rawThreadRetention === undefined
      ? defaultThreadIndexRetentionMilliseconds
      : parseRetentionMilliseconds(
          rawThreadRetention,
          `${field}.threadIndexRetentionMilliseconds`,
        );
  const responseTargetPolicy = parseResponseTargetPolicy(
    read("responseTargetPolicy", true),
  );
  const allowedCategories = parseAllowedCategories(
    read("allowedCategories", true),
    `${field}.allowedCategories`,
  );
  const rawPrefix = read("subjectMarkerPrefix", true);
  if (
    rawPrefix !== undefined &&
    (typeof rawPrefix !== "string" ||
      !subjectMarkerPrefixPattern.test(rawPrefix))
  ) {
    throw new TypeError(
      `${field}.subjectMarkerPrefix must match ${subjectMarkerPrefixPattern.source}`,
    );
  }
  const subjectMarkerPrefix = rawPrefix as string | undefined;
  const supportAddresses = parseSupportAddresses(
    read("supportAddresses", true),
  );

  const records = store.collection(supportRecords);
  const receipts = store.collection(inboundReceipts);
  const numbers = store.collection(ticketNumbers);
  const index = store.collection(threadIndex);

  async function finishReceipt(
    work: InboundWork,
    terminal: {
      readonly status: "processed" | "rejected";
      readonly outcome: InboundEmailOutcome;
      readonly ticketId?: TicketId;
      readonly messageId?: MessageId;
      readonly diagnostic?: string;
    },
  ): Promise<InboundEmailResult> {
    const processedAt = clock.now();
    canonicalTimestamp(processedAt, "clock.now()");
    const result = await receipts.update(
      work.key,
      (current) => {
        if (current === null) {
          throw new SupportDeskConflictError(
            "Inbound receipt disappeared before it was finalized",
          );
        }
        if (current.status !== "processing" && current.status !== "rerouting") {
          return { action: "keep" };
        }
        if (!sameInboundReceiptRoute(current.route, work.route)) {
          throw new SupportDeskConflictError(
            "Inbound route changed before the receipt was finalized",
          );
        }
        return {
          action: "write",
          value: {
            ...current,
            status: terminal.status,
            outcome: terminal.outcome,
            processedAt,
            ...(terminal.ticketId === undefined
              ? {}
              : { ticketId: terminal.ticketId }),
            ...(terminal.messageId === undefined
              ? {}
              : { messageId: terminal.messageId }),
            ...(terminal.diagnostic === undefined
              ? {}
              : { diagnostic: terminal.diagnostic }),
          },
        };
      },
      { maxAttempts: maxConflictAttempts },
    );
    if (result.value === null) {
      throw new SupportDeskConflictError(
        "Inbound receipt disappeared before it was finalized",
      );
    }
    return inboundResult(result.value, work.duplicateDelivery);
  }

  async function afterInboundCommit(
    ticketId: TicketId,
    messageId: MessageId,
    ticketNumber: boolean,
  ): Promise<void> {
    try {
      await projectTicketToQueue(ticketId, {
        store,
        clock,
        terminalRetentionMilliseconds,
        maxConflictAttempts,
      });
    } catch (error) {
      safeLog(logger, "error", "support-desk.queue.projection_failed", {
        ticketId,
        message:
          error instanceof Error ? error.message : "queue projection failed",
      });
    }
    await indexThreadingAfterCommit(
      store,
      ticketId,
      { messageId, ticketNumber },
      logger,
    );
  }

  async function inboundNotification(
    context: InboundNotificationContext,
  ): Promise<NotificationInput | undefined> {
    if (notificationPolicy === undefined) {
      return undefined;
    }
    const proposed = await notificationPolicy.notificationFor(
      Object.freeze({ ...context }),
    );
    if (proposed === undefined) {
      return undefined;
    }
    return bindNotificationTicketNumber(
      snapshotNotification(proposed),
      context.ticketNumber,
    );
  }

  async function proposeNewConversation(
    input: InboundEmailSnapshot,
    reservedTicketId: TicketId,
    matchMethod: InboundMatchMethod,
    relatedTicketId?: TicketId,
    forceUnverified = false,
  ): Promise<NewConversationRoute> {
    const match =
      relatedTicketId === undefined && !forceUnverified
        ? snapshotSenderMatch(
            await accountMatcher!.matchSenderEmail(
              Object.freeze({ channelId: input.channelId, email: input.from }),
            ),
          )
        : ({ matches: "none" } as const);
    const association =
      match.matches === "one" ? "matched_email" : "unverified";
    const decision = snapshotRoutingDecision(
      await routingPolicy!.routeNewConversation(
        Object.freeze({
          channelId: input.channelId,
          association,
          ...(match.matches === "one"
            ? { principalId: match.principalId }
            : {}),
          ...(relatedTicketId === undefined ? {} : { relatedTicketId }),
        }),
      ),
      allowedCategories,
    );
    return {
      kind: "new_conversation",
      ticketId: reservedTicketId,
      matchMethod,
      association,
      ...(match.matches === "one" ? { principalId: match.principalId } : {}),
      priority: decision.priority,
      ...(decision.category === undefined
        ? {}
        : { category: decision.category }),
      ...(relatedTicketId === undefined ? {} : { relatedTicketId }),
    };
  }

  async function claimRouteForRerouting(
    key: EntityKey,
    expected: InboundReceiptRoute,
  ): Promise<InboundReceipt> {
    const claimed = await receipts.update(
      key,
      (current) => {
        if (current === null) {
          throw new SupportDeskConflictError(
            "Inbound receipt disappeared before routing",
          );
        }
        if (
          current.status !== "processing" ||
          !sameInboundReceiptRoute(current.route, expected)
        ) {
          return { action: "keep" };
        }
        return {
          action: "write",
          value: { ...current, status: "rerouting" },
        };
      },
      { maxAttempts: maxConflictAttempts },
    );
    if (claimed.value === null) {
      throw new SupportDeskConflictError(
        "Inbound receipt disappeared before routing",
      );
    }
    return claimed.value;
  }

  async function replaceReroutingRoute(
    key: EntityKey,
    expected: InboundReceiptRoute,
    proposed: InboundReceiptRoute,
  ): Promise<InboundReceipt> {
    const replaced = await receipts.update(
      key,
      (current) => {
        if (current === null) {
          throw new SupportDeskConflictError(
            "Inbound receipt disappeared before routing",
          );
        }
        if (
          current.status !== "rerouting" ||
          !sameInboundReceiptRoute(current.route, expected)
        ) {
          return { action: "keep" };
        }
        return { action: "write", value: { ...current, route: proposed } };
      },
      { maxAttempts: maxConflictAttempts },
    );
    if (replaced.value === null) {
      throw new SupportDeskConflictError(
        "Inbound receipt disappeared before routing",
      );
    }
    return replaced.value;
  }

  async function reserveReplyRerouteFence(input: {
    readonly ticketId: TicketId;
    readonly commandId: string;
    readonly messageId: MessageId;
    readonly fingerprint: string;
    readonly recordedAt: IsoTimestamp;
  }): Promise<boolean> {
    const location = commandKey(input.ticketId, input.commandId);
    for (let attempt = 1; attempt <= maxConflictAttempts; attempt += 1) {
      const existing = await records.get(location);
      if (
        inboundReplyRerouteFenceMatches(
          existing,
          input.commandId,
          input.messageId,
          input.fingerprint,
        )
      ) {
        return true;
      }
      if (existing !== null) {
        return false;
      }
      const ticket = await records.getVersioned(ticketKey(input.ticketId));
      if (ticket?.value.kind !== "ticket") {
        return false;
      }
      const quota = await records.getVersioned(ticketQuotaKey(input.ticketId));
      if (quota?.value.kind !== "ticket_quota") {
        throw new SupportDeskConflictError(
          "Ticket partition quota metadata is missing",
        );
      }
      const partitionRows = await records.list(input.ticketId);
      enforcePartitionRecordLimit(
        partitionRows.length,
        limits.maxRecordsPerTicket,
        1,
      );
      const outcome = await records.transact(input.ticketId, [
        {
          action: "putIfUnchanged",
          version: ticket.version,
          value: ticket.value,
        },
        {
          action: "putIfUnchanged",
          version: quota.version,
          value: quota.value,
        },
        {
          action: "insert",
          value: {
            kind: "inbound_reply_reroute_fence",
            partition: input.ticketId,
            id: location.id,
            commandId: input.commandId,
            messageId: input.messageId,
            requestFingerprint: input.fingerprint,
            recordedAt: input.recordedAt,
          },
        },
      ]);
      if (outcome.committed) {
        return true;
      }
    }
    const existing = await records.get(location);
    if (
      inboundReplyRerouteFenceMatches(
        existing,
        input.commandId,
        input.messageId,
        input.fingerprint,
      )
    ) {
      return true;
    }
    if (existing !== null) {
      return false;
    }
    throw new SupportDeskConflictError(
      "Concurrent ticket updates exhausted retries; the provider may retry the same event. The inbound receipt remains processing and is safe to resume.",
    );
  }

  async function reserveCreateRerouteFence(input: {
    readonly ticketId: TicketId;
    readonly commandId: string;
    readonly messageId: MessageId;
    readonly fingerprint: string;
    readonly recordedAt: IsoTimestamp;
  }): Promise<boolean> {
    const location = commandKey(input.ticketId, input.commandId);
    const existing = await records.get(location);
    if (
      inboundCreateRerouteFenceMatches(
        existing,
        input.commandId,
        input.messageId,
        input.fingerprint,
      )
    ) {
      return true;
    }
    if (
      existing !== null ||
      (await records.get(ticketKey(input.ticketId))) !== null
    ) {
      return false;
    }
    enforcePartitionRecordLimit(0, limits.maxRecordsPerTicket, 1);
    const inserted = await records.insertIfAbsent({
      kind: "inbound_create_reroute_fence",
      partition: input.ticketId,
      id: location.id,
      commandId: input.commandId,
      messageId: input.messageId,
      requestFingerprint: input.fingerprint,
      recordedAt: input.recordedAt,
    });
    return (
      inserted.inserted ||
      inboundCreateRerouteFenceMatches(
        inserted.value,
        input.commandId,
        input.messageId,
        input.fingerprint,
      )
    );
  }

  async function proposeRoute(
    input: InboundEmailSnapshot,
    reservedTicketId: TicketId,
  ): Promise<InboundReceiptRoute> {
    const reason = inboundSuppressionReason(input, supportAddresses);
    if (reason !== undefined) {
      return { kind: "suppressed", reason };
    }
    const nowEpoch = canonicalTimestamp(clock.now(), "clock.now()");
    const lookup = (kind: ThreadIndexKind, key: string) =>
      lookupThreadEntry(
        records,
        index,
        kind,
        key,
        nowEpoch,
        threadIndexRetentionMilliseconds,
      );

    // The same Message-ID delivered under another provider event is the same
    // message only when the sender satisfies the existing-ticket join rule.
    let repeatedMessageTicket: Ticket | undefined;
    if (input.externalMessageId !== undefined) {
      const own = await lookup(
        "message_id",
        await messageIdIndexKey(input.externalMessageId),
      );
      if (
        own !== null &&
        own.entry.source === "inbound" &&
        own.entry.messageId !== undefined
      ) {
        if (threadJoinIsSafe(own.ticket, "message_id", input)) {
          return {
            kind: "duplicate_message",
            ticketId: own.ticket.id,
            messageId: own.entry.messageId,
          };
        }
        repeatedMessageTicket = own.ticket;
      }
    }

    let candidate:
      | {
          readonly ticket: Ticket;
          readonly method: Exclude<InboundMatchMethod, "none">;
        }
      | undefined;
    let ambiguous = false;
    if (input.replyRoutingToken !== undefined) {
      const hit = await lookup(
        "reply_token",
        await replyTokenIndexKey(input.replyRoutingToken),
      );
      if (hit !== null) {
        candidate = { ticket: hit.ticket, method: "routing_token" };
      }
    }
    if (candidate === undefined) {
      const found: Ticket[] = [];
      for (const header of threadingHeaderCandidates(input)) {
        const hit = await lookup("message_id", await messageIdIndexKey(header));
        if (
          hit !== null &&
          !found.some((ticket) => ticket.id === hit.ticket.id)
        ) {
          found.push(hit.ticket);
        }
      }
      const first = found[0];
      if (first !== undefined) {
        candidate = { ticket: first, method: "message_id" };
        ambiguous = found.length > 1;
      }
    }
    // Keep a repeated inbound Message-ID ahead of the display-only subject
    // marker when a stronger token or threading-header locator did not match.
    if (candidate === undefined && repeatedMessageTicket !== undefined) {
      candidate = {
        ticket: repeatedMessageTicket,
        method: "message_id",
      };
    }
    if (candidate === undefined && subjectMarkerPrefix !== undefined) {
      const markers = subjectMarkerNumbers(input.subject, subjectMarkerPrefix);
      ambiguous = markers.length > 1;
      for (const marker of markers) {
        const hit = await lookup("ticket_number", ticketNumberIndexKey(marker));
        if (hit !== null && candidate === undefined) {
          candidate = { ticket: hit.ticket, method: "subject_marker" };
        }
      }
    }
    if (
      candidate !== undefined &&
      !ambiguous &&
      candidate.ticket.id !== reservedTicketId &&
      threadJoinIsSafe(candidate.ticket, candidate.method, input)
    ) {
      return {
        kind: "reply",
        ticketId: candidate.ticket.id,
        matchMethod: candidate.method,
      };
    }

    const relatedTicketId =
      candidate !== undefined && candidate.ticket.id !== reservedTicketId
        ? candidate.ticket.id
        : undefined;
    return proposeNewConversation(
      input,
      reservedTicketId,
      candidate?.method ?? "none",
      relatedTicketId,
      ambiguous,
    );
  }

  async function decideRoute(
    key: EntityKey,
    stored: InboundReceipt,
    input: InboundEmailSnapshot,
    reservedTicketId: TicketId,
    commandId: string,
    messageId: MessageId,
    fingerprint: string,
  ): Promise<InboundReceipt> {
    if (stored.status !== "processing" && stored.status !== "rerouting") {
      return stored;
    }
    if (stored.route !== undefined) {
      const route = stored.route;
      if (route.kind === "suppressed") {
        return stored;
      }
      if (route.kind === "duplicate_message") {
        const target = await records.get(ticketKey(route.ticketId));
        if (
          target?.kind === "ticket" &&
          threadJoinIsSafe(target.ticket, "message_id", input)
        ) {
          return stored;
        }
        if (stored.status === "processing") {
          return decideRoute(
            key,
            await claimRouteForRerouting(key, route),
            input,
            reservedTicketId,
            commandId,
            messageId,
            fingerprint,
          );
        }
        return replaceReroutingRoute(
          key,
          route,
          await proposeNewConversation(
            input,
            reservedTicketId,
            "message_id",
            route.ticketId,
            true,
          ),
        );
      }
      if (route.kind === "new_conversation") {
        if (
          route.relatedTicketId === undefined ||
          (route.association === "unverified" &&
            route.principalId === undefined)
        ) {
          return stored;
        }
        const existing = await records.get(
          commandKey(route.ticketId, commandId),
        );
        const alreadyFenced = inboundCreateRerouteFenceMatches(
          existing,
          commandId,
          messageId,
          fingerprint,
        );
        // A committed create remains authoritative for receipt replay.
        if (existing !== null && !alreadyFenced) {
          return stored;
        }
        if (stored.status === "processing") {
          return decideRoute(
            key,
            await claimRouteForRerouting(key, route),
            input,
            reservedTicketId,
            commandId,
            messageId,
            fingerprint,
          );
        }
        if (
          !alreadyFenced &&
          !(await reserveCreateRerouteFence({
            ticketId: route.ticketId,
            commandId,
            messageId,
            fingerprint,
            recordedAt: stored.receivedAt,
          }))
        ) {
          return stored;
        }
        return replaceReroutingRoute(
          key,
          route,
          await proposeNewConversation(
            input,
            reservedTicketId,
            route.matchMethod,
            route.relatedTicketId,
            true,
          ),
        );
      }

      const commandLocation = commandKey(route.ticketId, commandId);
      const existing = await records.get(commandLocation);
      const alreadyFenced = inboundReplyRerouteFenceMatches(
        existing,
        commandId,
        messageId,
        fingerprint,
      );
      if (existing !== null && !alreadyFenced) {
        return stored;
      }
      const target = await records.get(ticketKey(route.ticketId));
      if (
        !alreadyFenced &&
        (target?.kind !== "ticket" ||
          threadJoinIsSafe(target.ticket, route.matchMethod, input))
      ) {
        return stored;
      }
      if (stored.status === "processing") {
        return decideRoute(
          key,
          await claimRouteForRerouting(key, route),
          input,
          reservedTicketId,
          commandId,
          messageId,
          fingerprint,
        );
      }
      if (!alreadyFenced) {
        const fenced = await reserveReplyRerouteFence({
          ticketId: route.ticketId,
          commandId,
          messageId,
          fingerprint,
          recordedAt: stored.receivedAt,
        });
        if (!fenced) {
          return stored;
        }
      }
      return replaceReroutingRoute(
        key,
        route,
        await proposeNewConversation(
          input,
          reservedTicketId,
          route.matchMethod,
          route.ticketId,
          true,
        ),
      );
    }
    const proposed = await proposeRoute(input, reservedTicketId);
    const result = await receipts.update(
      key,
      (current) => {
        if (current === null) {
          throw new SupportDeskConflictError(
            "Inbound receipt disappeared before routing",
          );
        }
        if (current.status !== "processing" || current.route !== undefined) {
          return { action: "keep" };
        }
        return { action: "write", value: { ...current, route: proposed } };
      },
      { maxAttempts: maxConflictAttempts },
    );
    if (
      result.value === null ||
      ((result.value.status === "processing" ||
        result.value.status === "rerouting") &&
        result.value.route === undefined)
    ) {
      throw new SupportDeskConflictError(
        "Inbound routing decision was not stored",
      );
    }
    return result.value;
  }

  async function createConversation(
    work: InboundWork,
    route: NewConversationRoute,
  ): Promise<InboundEmailResult> {
    const { input, messageId, commandId, fingerprint } = work;
    const ticketId = route.ticketId;
    const commandLocation = commandKey(ticketId, commandId);
    const existingVersioned = await records.getVersioned(commandLocation);
    const existing = existingVersioned?.value ?? null;
    const createFence =
      existingVersioned !== null &&
      inboundCreateRerouteFenceMatches(
        existingVersioned.value,
        commandId,
        messageId,
        fingerprint,
      )
        ? existingVersioned
        : null;
    if (existing !== null && createFence === null) {
      if (
        !duplicateMatches(
          existing,
          "inbound_email_create",
          messageId,
          fingerprint,
        )
      ) {
        throw new SupportDeskConflictError(
          "An inbound ticket command ID was reused for different content",
        );
      }
    } else {
      // ticket, quota, message, audit, command, and an optional delivery job.
      enforcePartitionRecordLimit(0, limits.maxRecordsPerTicket, 6);
      // Reserved outside the ticket transaction; a failed create leaves a gap.
      const ticketNumber = await reserveNextTicketNumber(
        numbers,
        maxConflictAttempts,
      );
      const now = clock.now();
      const displayName =
        input.fromName === undefined ? {} : { displayName: input.fromName };
      const ticket = await applyResponseTargets(
        createTicket({
          id: ticketId,
          number: ticketNumber,
          subject: input.subject,
          channel: "email",
          priority: route.priority,
          ...(route.category === undefined ? {} : { category: route.category }),
          requester:
            route.association === "matched_email"
              ? {
                  association: "matched_email",
                  principalId: route.principalId as PrincipalId,
                  email: input.from,
                  ...displayName,
                }
              : {
                  association: "unverified",
                  email: input.from,
                  ...displayName,
                },
          createdAt: now,
          ...(route.relatedTicketId === undefined
            ? {}
            : { relatedTicketId: route.relatedTicketId }),
        }),
        responseTargetPolicy,
        "created",
      );
      const notification = await inboundNotification({
        outcome: "created",
        channelId: input.channelId,
        ticketId,
        ticketNumber,
        messageId,
        association: route.association,
        matchMethod: route.matchMethod,
        senderAcknowledgementAllowed:
          inboundSenderAcknowledgementAllowed(input),
      });
      const notificationContent = deliveryContent(notification);
      const commandRecord: CommandRecord = {
        kind: "command",
        partition: ticketId,
        id: commandLocation.id,
        commandId,
        commandType: "inbound_email_create",
        messageId,
        requestFingerprint: fingerprint,
        completedAt: now,
      };
      const actions: Parameters<typeof records.transact>[1] = [
        {
          action: "insert",
          value: { kind: "ticket", partition: ticketId, id: "ticket", ticket },
        },
        {
          action: "insert",
          value: {
            kind: "ticket_quota",
            partition: ticketId,
            id: "quota",
            messageCount: 1,
          },
        },
        {
          action: "insert",
          value: {
            kind: "message",
            partition: ticketId,
            id: `message:${messageId}`,
            ordinal: ticket.revision,
            message: inboundMessage(input, ticketId, messageId, now),
            ...(notificationContent === undefined
              ? {}
              : { deliveryContent: notificationContent }),
          },
        },
        inboundAuditAction({
          commandId,
          correlationId: work.correlationId,
          ticketId,
          revision: ticket.revision,
          occurredAt: now,
          action: supportTicketAuditActions.created,
          matchMethod: route.matchMethod,
          association: route.association,
        }),
        ...(createFence === null
          ? [{ action: "insert" as const, value: commandRecord }]
          : [
              {
                action: "putIfUnchanged" as const,
                version: createFence.version,
                value: commandRecord,
              },
            ]),
        ...(notification === undefined
          ? []
          : [deliveryJobAction(ticketId, messageId, now, notification)]),
      ];
      enforcePartitionRecordLimit(
        0,
        limits.maxRecordsPerTicket,
        actions.length,
      );
      const outcome = await records.transact(ticketId, actions);
      if (!outcome.committed) {
        const raced = await records.get(commandKey(ticketId, commandId));
        if (
          !duplicateMatches(
            raced,
            "inbound_email_create",
            messageId,
            fingerprint,
          )
        ) {
          if (
            raced !== null &&
            !inboundCreateRerouteFenceMatches(
              raced,
              commandId,
              messageId,
              fingerprint,
            )
          ) {
            throw new SupportDeskConflictError(
              "An inbound ticket command ID was reused for different content",
            );
          }
          throw new SupportDeskConflictError(
            "Concurrent ticket updates exhausted retries; the provider may retry the same event. The inbound receipt remains processing and is safe to resume.",
          );
        }
      }
    }
    const result = await finishReceipt(work, {
      status: "processed",
      outcome: "created",
      ticketId,
      messageId,
    });
    await afterInboundCommit(ticketId, messageId, true);
    return result;
  }

  async function appendReply(
    work: InboundWork,
    route: ReplyRoute,
  ): Promise<InboundEmailResult> {
    const { input, messageId, commandId, fingerprint } = work;
    const ticketId = route.ticketId;
    const completed = async (): Promise<InboundEmailResult> => {
      const result = await finishReceipt(work, {
        status: "processed",
        outcome: "replied",
        ticketId,
        messageId,
      });
      await afterInboundCommit(ticketId, messageId, false);
      return result;
    };
    const rejected = (diagnostic: string): Promise<InboundEmailResult> =>
      finishReceipt(work, {
        status: "rejected",
        outcome: "rejected",
        diagnostic,
      });

    for (let attempt = 1; attempt <= maxConflictAttempts; attempt += 1) {
      const duplicate = await records.get(commandKey(ticketId, commandId));
      if (duplicate !== null) {
        if (
          !duplicateMatches(
            duplicate,
            "inbound_email_reply",
            messageId,
            fingerprint,
          )
        ) {
          throw new SupportDeskConflictError(
            "An inbound ticket command ID was reused for different content",
          );
        }
        return completed();
      }
      const versioned = await records.getVersioned(ticketKey(ticketId));
      if (versioned?.value.kind !== "ticket") {
        return rejected("ticket_unavailable");
      }
      const ticket = versioned.value.ticket;
      const partitionRows = await records.list(ticketId);
      if (input.externalMessageId !== undefined) {
        const prior = partitionRows.find(
          (row): row is MessageRecord =>
            row.kind === "message" &&
            row.message.channel === "email" &&
            row.message.authorKind === "customer" &&
            row.message.externalMessageId === input.externalMessageId,
        );
        if (prior !== undefined) {
          return finishReceipt(work, {
            status: "processed",
            outcome: "duplicate_message",
            ticketId,
            messageId: prior.message.id,
          });
        }
      }
      const quota = await records.getVersioned(ticketQuotaKey(ticketId));
      if (quota?.value.kind !== "ticket_quota") {
        throw new SupportDeskConflictError(
          "Ticket partition quota metadata is missing",
        );
      }
      if (quota.value.messageCount >= limits.maxMessagesPerTicket) {
        return rejected("ticket_messages_limit");
      }
      const notification = await inboundNotification({
        outcome: "replied",
        channelId: input.channelId,
        ticketId,
        ticketNumber: ticket.number,
        messageId,
        association: ticket.requester.association,
        matchMethod: route.matchMethod,
        ...(ticket.assignedTo === undefined
          ? {}
          : { assignedTo: ticket.assignedTo }),
        senderAcknowledgementAllowed:
          inboundSenderAcknowledgementAllowed(input),
      });
      if (
        partitionRows.length + (notification === undefined ? 3 : 4) >
        limits.maxRecordsPerTicket
      ) {
        return rejected("ticket_partition_limit");
      }
      const now = clampTicketTime(clock.now(), ticket.updatedAt);
      // Customer-reply semantics: any status, including resolved or closed,
      // moves to waiting_on_support. No actor: email is not authentication.
      const updated = await applyResponseTargets(
        applyTicketEvent(ticket, {
          type: "customer_replied",
          occurredAt: now,
        }),
        responseTargetPolicy,
        "customer_replied",
      );
      const notificationContent = deliveryContent(notification);
      const outcome = await records.transact(ticketId, [
        {
          action: "putIfUnchanged",
          version: versioned.version,
          value: { ...versioned.value, ticket: updated },
        },
        {
          action: "putIfUnchanged",
          version: quota.version,
          value: {
            ...quota.value,
            messageCount: quota.value.messageCount + 1,
          },
        },
        {
          action: "insert",
          value: {
            kind: "message",
            partition: ticketId,
            id: `message:${messageId}`,
            ordinal: updated.revision,
            message: inboundMessage(input, ticketId, messageId, now),
            ...(notificationContent === undefined
              ? {}
              : { deliveryContent: notificationContent }),
          },
        },
        inboundAuditAction({
          commandId,
          correlationId: work.correlationId,
          ticketId,
          revision: updated.revision,
          occurredAt: now,
          action: supportTicketAuditActions.customerReplied,
          matchMethod: route.matchMethod,
        }),
        {
          action: "insert",
          value: {
            kind: "command",
            partition: ticketId,
            id: `command:${commandId}`,
            commandId,
            commandType: "inbound_email_reply",
            messageId,
            requestFingerprint: fingerprint,
            completedAt: now,
          },
        },
        ...(notification === undefined
          ? []
          : [deliveryJobAction(ticketId, messageId, now, notification)]),
      ]);
      if (outcome.committed) {
        return completed();
      }
    }
    const last = await records.get(commandKey(ticketId, commandId));
    if (duplicateMatches(last, "inbound_email_reply", messageId, fingerprint)) {
      return completed();
    }
    if (last !== null) {
      throw new SupportDeskConflictError(
        "An inbound ticket command ID was reused for different content",
      );
    }
    throw new SupportDeskConflictError(
      "Concurrent ticket updates exhausted retries; the provider may retry the same event. The inbound receipt remains processing and is safe to resume.",
    );
  }

  return Object.freeze({
    async processInboundEmail(
      rawInput: InboundEmailInput,
    ): Promise<InboundEmailResult> {
      const input = snapshotInboundEmailInput(rawInput, limits);
      const fingerprint = await requestFingerprint(
        inboundFingerprintPayload(input),
      );
      const location = await inboundReceiptLocation(
        input.channelId,
        input.providerEventId,
      );
      const key: EntityKey = {
        partition: location.bucket,
        id: receiptSlotId(location.slot, "inbound receipt slot"),
      };
      const receivedAt = new Date(
        canonicalTimestamp(clock.now(), "clock.now()"),
      ).toISOString();
      const inserted = await receipts.insertIfAbsent({
        bucket: location.bucket,
        slot: location.slot,
        channelId: input.channelId,
        providerEventId: input.providerEventId,
        ...(input.externalMessageId === undefined
          ? {}
          : { externalMessageId: input.externalMessageId }),
        payloadFingerprint: fingerprint,
        status: "processing",
        receivedAt,
        reservedTicketId: input.ticketId,
        reservedMessageId: input.messageId,
        correlationId: input.correlationId,
      });
      const stored = inserted.value;
      if (
        stored.channelId !== input.channelId ||
        stored.providerEventId !== input.providerEventId
      ) {
        throw new SupportDeskConflictError(
          "An inbound receipt hash slot collided with a different provider event",
        );
      }
      if (stored.payloadFingerprint !== fingerprint) {
        throw new SupportDeskConflictError(
          "An inbound provider event ID was reused for different content",
        );
      }
      const duplicateDelivery = !inserted.inserted;
      if (stored.status !== "processing" && stored.status !== "rerouting") {
        return inboundResult(stored, duplicateDelivery);
      }
      const reservedTicketId = stored.reservedTicketId;
      const reservedMessageId = stored.reservedMessageId;
      const correlationId = stored.correlationId;
      if (
        reservedTicketId === undefined ||
        reservedMessageId === undefined ||
        correlationId === undefined
      ) {
        throw new SupportDeskConflictError(
          "Inbound receipt is missing its reserved identifiers",
        );
      }
      // Stable per provider event and independent of retry identifiers.
      const commandId = `inbound:${location.bucket.slice(-30)}${location.slot}`;
      const decided = await decideRoute(
        key,
        stored,
        input,
        reservedTicketId,
        commandId,
        reservedMessageId,
        fingerprint,
      );
      if (decided.status !== "processing" && decided.status !== "rerouting") {
        return inboundResult(decided, duplicateDelivery);
      }
      const route = decided.route as InboundReceiptRoute;
      const work: InboundWork = {
        key,
        input,
        route,
        messageId: reservedMessageId,
        correlationId,
        commandId,
        fingerprint,
        duplicateDelivery,
      };
      switch (route.kind) {
        case "suppressed":
          return finishReceipt(work, {
            status: "rejected",
            outcome: "suppressed",
            diagnostic: route.reason,
          });
        case "duplicate_message":
          return finishReceipt(work, {
            status: "processed",
            outcome: "duplicate_message",
            ticketId: route.ticketId,
            messageId: route.messageId,
          });
        case "new_conversation":
          return createConversation(work, route);
        case "reply":
          return appendReply(work, route);
      }
    },
  });
}
