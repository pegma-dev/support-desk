import { auditRecordId, defineAudit, type AuditEvent } from "@pegma/audit";
import { hasPermission, type AccessContext } from "@pegma/authorization-core";
import { defineMail, maxMailAttempts, type MailJob } from "@pegma/mail";
import type { Clock, IsoTimestamp, PrincipalId } from "@pegma/spine";
import {
  defineCollection,
  type Codec,
  type CollectionStore,
  type EntityKey,
  type Store,
  type StoredRecord,
} from "@pegma/storage-core";
import type {
  MessageId,
  Ticket,
  TicketId,
  TicketMessage,
} from "@pegma/support-desk-contracts";
import { applyTicketEvent, createTicket } from "@pegma/support-desk-core";

export const supportPermissions = Object.freeze({
  create: "support.ticket.create",
  readOwn: "support.ticket.read.own",
  replyOwn: "support.ticket.reply.own",
} as const);

export interface SupportDeskLimits {
  readonly maxSubjectCharacters: number;
  readonly maxMessageCharacters: number;
  readonly maxTicketsPerPrincipal: number;
  readonly maxMessagesPerTicket: number;
}

export const defaultSupportDeskLimits: SupportDeskLimits = Object.freeze({
  maxSubjectCharacters: 200,
  maxMessageCharacters: 20_000,
  maxTicketsPerPrincipal: 100,
  maxMessagesPerTicket: 100,
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

export class SupportDeskLimitError extends Error {
  constructor(
    readonly field: "subject" | "body" | "customer_tickets" | "ticket_messages",
    readonly maximum: number,
  ) {
    super(`${field} exceeds the configured limit of ${maximum}`);
    this.name = "SupportDeskLimitError";
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

interface CommandRecord {
  readonly kind: "command";
  readonly partition: TicketId;
  readonly id: string;
  readonly commandId: string;
  readonly commandType: "create_customer_ticket" | "reply_customer_ticket";
  readonly messageId: MessageId;
  readonly requestFingerprint: string;
  readonly completedAt: IsoTimestamp;
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
  readonly status: "processing" | "processed" | "rejected";
  /** Trusted host time at which processing first reserved this receipt. */
  readonly receivedAt: IsoTimestamp;
  /** Trusted host time at which processing reached a terminal status. */
  readonly processedAt?: IsoTimestamp;
  readonly ticketId?: TicketId;
  readonly messageId?: MessageId;
  readonly diagnostic?: string;
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

function customerTicketAuditAction(input: {
  readonly commandId: string;
  readonly correlationId: string;
  readonly ticketId: TicketId;
  readonly revision: number;
  readonly actorId: PrincipalId;
  readonly occurredAt: IsoTimestamp;
  readonly action:
    | typeof supportTicketAuditActions.created
    | typeof supportTicketAuditActions.customerReplied;
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

export interface NotificationInput {
  readonly id: string;
  readonly recipientRef: string;
  readonly templateId: string;
  readonly templateVersion: number;
  readonly variables: Readonly<Record<string, string>>;
  readonly subject: string;
  readonly outboundMessageId: string;
  readonly maxAttempts?: number;
}

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
): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(source, key);
  if (descriptor === undefined) {
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

function normalizeRequesterEmail(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new TypeError("requesterEmail must be a string");
  }
  if (
    value.length > requesterEmailMaximumCharacters ||
    /[\u0000-\u001F\u007F<>&"\\]/.test(value)
  ) {
    throw new TypeError(
      `requesterEmail must be a plain email address of at most ${requesterEmailMaximumCharacters} characters`,
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
      `requesterEmail must be a plain email address of at most ${requesterEmailMaximumCharacters} characters`,
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
      };
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
): Promise<CustomerTicketView> {
  const all = await records.list(ticketId);
  const ticketRecord = all.find(
    (record): record is TicketRecord => record.kind === "ticket",
  );
  if (
    ticketRecord === undefined ||
    ticketRecord.ticket.requester.association !== "authenticated" ||
    ticketRecord.ticket.requester.principalId !== principalId
  ) {
    throw new SupportDeskNotFoundError();
  }
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
): ReadonlySet<string> | undefined {
  if (input === undefined) {
    return undefined;
  }
  if (!Array.isArray(input)) {
    throw new TypeError(
      "application options.allowedCategories must be an array",
    );
  }
  if (input.length > maxAllowedCategories) {
    throw new TypeError(
      `application options.allowedCategories may contain at most ${maxAllowedCategories} values`,
    );
  }
  const values = new Set<string>();
  for (let index = 0; index < input.length; index += 1) {
    const field = `application options.allowedCategories[${index}]`;
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
      throw new TypeError(
        "application options.allowedCategories must not contain duplicates",
      );
    }
    values.add(value);
  }
  return values;
}

function duplicateMatches(
  existing: SupportRecord | null,
  commandType: CommandRecord["commandType"],
  messageId: string,
  requestFingerprint: string,
): boolean {
  return (
    existing?.kind === "command" &&
    existing.commandType === commandType &&
    existing.messageId === messageId &&
    existing.requestFingerprint === requestFingerprint
  );
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

export function createSupportDeskApplication(options: {
  readonly store: Store;
  readonly clock: Clock;
  readonly limits?: Partial<SupportDeskLimits>;
  readonly maxConflictAttempts?: number;
  /**
   * Frozen, deduplicated host allowlist for optional ticket categories.
   * At most 32 values matching `^[a-z][a-z0-9_]{0,31}$`.
   */
  readonly allowedCategories?: readonly string[];
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
  const allowedCategories = parseAllowedCategories(
    ownDataProperty(
      source,
      "allowedCategories",
      "application options.allowedCategories",
      true,
    ),
  );
  const limitOverrides: {
    -readonly [Field in keyof SupportDeskLimits]?: number;
  } = {};
  if (rawLimits !== undefined) {
    const limitSource = boundaryObject(rawLimits, "application options.limits");
    for (const field of [
      "maxSubjectCharacters",
      "maxMessageCharacters",
      "maxTicketsPerPrincipal",
      "maxMessagesPerTicket",
    ] as const) {
      const value = ownDataProperty(
        limitSource,
        field,
        `application options.limits.${field}`,
        true,
      );
      if (value !== undefined) {
        if (typeof value !== "number") {
          throw new TypeError(
            `application options.limits.${field} must be a number`,
          );
        }
        limitOverrides[field] = value;
      }
    }
  }
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
  const limits = { ...defaultSupportDeskLimits, ...limitOverrides };
  const maxConflictAttempts = rawMaxConflictAttempts ?? 4;
  if (
    !Number.isSafeInteger(maxConflictAttempts) ||
    maxConflictAttempts <= 0 ||
    maxConflictAttempts > 20
  ) {
    throw new TypeError("maxConflictAttempts must be between 1 and 20");
  }
  const limitMaximums: Readonly<Record<keyof SupportDeskLimits, number>> = {
    maxSubjectCharacters: 1_000,
    maxMessageCharacters: 20_000,
    maxTicketsPerPrincipal: 1_000,
    maxMessagesPerTicket: 100,
  };
  for (const field of Object.keys(limits) as (keyof SupportDeskLimits)[]) {
    const value = limits[field];
    if (
      !Number.isSafeInteger(value) ||
      value <= 0 ||
      value > limitMaximums[field]
    ) {
      throw new TypeError(
        `${field} must be a positive safe integer no greater than ${limitMaximums[field]}`,
      );
    }
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
    const result = await numbers.update(
      { partition: ticketNumberPartition, id: ticketNumberRecordId },
      (current) => {
        const lastIssued = current?.lastIssued ?? 0;
        if (!Number.isSafeInteger(lastIssued) || lastIssued < 0) {
          throw new SupportDeskConflictError(
            "Ticket number counter is corrupt",
          );
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
      const fingerprint = await requestFingerprint({
        type: "create_customer_ticket",
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
      });
      // Replay an already committed create before host allowlist checks so a
      // later config change cannot break idempotent retries of the same command.
      // Replay never reserves another instance ticket number.
      const existingCreate = await records.get(
        commandKey(command.ticketId, command.commandId),
      );
      if (
        duplicateMatches(
          existingCreate,
          "create_customer_ticket",
          command.messageId,
          fingerprint,
        )
      ) {
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
        return authoritativeView(records, access.principalId, command.ticketId);
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

      // Reserve outside the ticket transaction; gaps are accepted if create fails.
      const ticketNumber = await reserveTicketNumber();
      // Bind host-supplied notification content to the reserved number so mail
      // cannot advertise a guessed ticket number.
      const notification =
        command.notification === undefined
          ? undefined
          : Object.freeze({
              ...command.notification,
              subject: command.notification.subject.replaceAll(
                "{{ticket_number}}",
                String(ticketNumber),
              ),
              variables: Object.freeze({
                ...command.notification.variables,
                ticket_number: String(ticketNumber),
              }),
            });
      const now = clock.now();
      const ticket = createTicket({
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
      });
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
        customerTicketAuditAction({
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
      return authoritativeView(records, access.principalId, command.ticketId);
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
          return authoritativeView(
            records,
            access.principalId,
            command.ticketId,
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
        const updated = applyTicketEvent(versioned.value.ticket, {
          type: "customer_replied",
          actorId: access.principalId,
          occurredAt: now,
        });
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
          customerTicketAuditAction({
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
          return authoritativeView(
            records,
            access.principalId,
            command.ticketId,
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
          return authoritativeView(
            records,
            access.principalId,
            command.ticketId,
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
      return authoritativeView(records, access.principalId, ticketId);
    },
  };
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
        versioned.value.status !== "processing" &&
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
