import { hasPermission, type AccessContext } from "@pegma/authorization-core";
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

export type DeliveryStatus =
  | "pending"
  | "leased"
  | "retrying"
  | "accepted"
  | "delivered"
  | "dead_letter"
  | "terminal_unknown";

export interface DeliveryJob {
  readonly kind: "delivery_job";
  readonly partition: TicketId;
  readonly id: string;
  readonly ticketId: TicketId;
  readonly messageId: MessageId;
  readonly idempotencyKey: string;
  readonly recipientRef: string;
  readonly templateId: string;
  readonly templateVersion: number;
  readonly variables: Readonly<Record<string, string>>;
  readonly subject: string;
  readonly outboundMessageId: string;
  readonly status: DeliveryStatus;
  readonly attemptCount: number;
  /**
   * Read-only provider status calls are bounded separately from send attempts.
   * Missing on legacy rows means zero completed reconciliation failures.
   */
  readonly reconciliationAttemptCount?: number;
  readonly maxAttempts: number;
  readonly availableAt: IsoTimestamp;
  readonly createdAt: IsoTimestamp;
  readonly leaseOwner?: string;
  readonly leaseExpiresAt?: IsoTimestamp;
  readonly claimToken?: string;
  readonly leasePurpose?: "send" | "reconcile";
  readonly acceptedAt?: IsoTimestamp;
  readonly acceptedDeadlineAt?: IsoTimestamp;
  readonly deliveredAt?: IsoTimestamp;
  readonly terminalAt?: IsoTimestamp;
  readonly providerMessageRef?: string;
  readonly failureCategory?: string;
}

export const maxDeliveryAttempts = 20;

const FAILURE_CATEGORY = /^[a-z][a-z0-9_]{0,63}$/;
const MAX_IDEMPOTENCY_KEY_LENGTH = 255;

function encodeIdempotencyPart(value: string): string {
  return encodeURIComponent(value).replaceAll(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * Build one provider-safe key that is unique across ticket partitions.
 *
 * Length-prefixing is unnecessary because URI encoding escapes the colon
 * separator in both components.
 */
export function deliveryIdempotencyKey(
  ticketId: TicketId,
  deliveryJobId: string,
): string {
  requireNonempty(ticketId, "ticketId");
  requireNonempty(deliveryJobId, "deliveryJobId");
  const key = `support-mail:v1:${encodeIdempotencyPart(ticketId)}:${encodeIdempotencyPart(deliveryJobId)}`;
  if (
    key.length > MAX_IDEMPOTENCY_KEY_LENGTH ||
    !/^[A-Za-z0-9._~%:-]+$/.test(key)
  ) {
    throw new TypeError(
      "delivery idempotency key exceeds the safe provider format",
    );
  }
  return key;
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
}

interface AuditRecord {
  readonly kind: "audit";
  readonly partition: TicketId;
  readonly id: string;
  readonly eventType: "ticket_created" | "customer_replied";
  readonly resultingRevision: number;
  readonly actorId: PrincipalId;
  readonly occurredAt: IsoTimestamp;
  readonly correlationId: string;
  readonly commandId: string;
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
  | AuditRecord
  | CommandRecord
  | DeliveryJob;

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
  readonly status: "delivered" | "failed";
  readonly occurredAt: IsoTimestamp;
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
  readonly ticketNumber: number;
  readonly messageId: MessageId;
  readonly subject: string;
  readonly body: string;
  readonly requesterEmail?: string;
  readonly notification?: NotificationInput;
}

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

export interface CustomerTicketView {
  readonly ticket: Ticket;
  readonly messages: readonly TicketMessage[];
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
  listCustomerTickets(access: AccessContext): Promise<readonly Ticket[]>;
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

export function validateProviderMessageRef(
  value: string,
  field = "providerMessageRef",
): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > 512 ||
    /[\u0000-\u001F\u007F]/.test(value)
  ) {
    throw new TypeError(
      `${field} must be a non-empty provider reference of at most 512 characters with no controls`,
    );
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
      (maxAttempts as number) > maxDeliveryAttempts)
  ) {
    throw new TypeError(
      `notification.maxAttempts must be between 1 and ${maxDeliveryAttempts}`,
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
    ticketNumber: ownDataProperty(
      source,
      "ticketNumber",
      "create command.ticketNumber",
    ),
    messageId: ownDataProperty(source, "messageId", "create command.messageId"),
    subject: ownDataProperty(source, "subject", "create command.subject"),
    body: ownDataProperty(source, "body", "create command.body"),
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
  if (typeof raw.ticketNumber !== "number") {
    throw new TypeError("create command.ticketNumber must be a number");
  }
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
    ticketNumber: raw.ticketNumber,
    messageId: boundaryString(raw.messageId, "create command.messageId"),
    subject: boundaryString(raw.subject, "create command.subject"),
    body: boundaryString(raw.body, "create command.body"),
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

function deliveryJob(
  ticketId: TicketId,
  messageId: MessageId,
  now: IsoTimestamp,
  input: NotificationInput,
): DeliveryJob {
  const id = `delivery:${input.id}`;
  return {
    kind: "delivery_job",
    partition: ticketId,
    id,
    ticketId,
    messageId,
    idempotencyKey: deliveryIdempotencyKey(ticketId, id),
    recipientRef: input.recipientRef,
    templateId: input.templateId,
    templateVersion: input.templateVersion,
    variables: input.variables,
    subject: input.subject,
    outboundMessageId: input.outboundMessageId,
    status: "pending",
    attemptCount: 0,
    reconciliationAttemptCount: 0,
    maxAttempts: input.maxAttempts ?? 5,
    availableAt: now,
    createdAt: now,
  };
}

function customerMessages(records: readonly SupportRecord[]): TicketMessage[] {
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
    .map((record) => record.message);
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
    ticket: ticketRecord.ticket,
    messages: customerMessages(all),
  };
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
        ticketNumber: command.ticketNumber,
        messageId: command.messageId,
        subject: command.subject,
        body: command.body,
        requesterEmail: command.requesterEmail ?? null,
        notification: stableNotification(command.notification),
      });

      const now = clock.now();
      const ticket = createTicket({
        id: command.ticketId,
        number: command.ticketNumber,
        subject: command.subject,
        channel: "web",
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
        command.notification === undefined
          ? undefined
          : deliveryJob(
              command.ticketId,
              command.messageId,
              now,
              command.notification,
            );
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
          },
        },
        {
          action: "insert",
          value: {
            kind: "audit",
            partition: command.ticketId,
            id: `event:00000001:${command.commandId}`,
            eventType: "ticket_created",
            resultingRevision: ticket.revision,
            actorId: access.principalId,
            occurredAt: now,
            correlationId: command.correlationId,
            commandId: command.commandId,
          },
        },
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
        ...(notificationJob === undefined
          ? []
          : [
              {
                action: "insert" as const,
                value: notificationJob,
              },
            ]),
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
          {
            action: "insert",
            value: {
              kind: "audit",
              partition: command.ticketId,
              id: `event:${String(updated.revision).padStart(8, "0")}:${command.commandId}`,
              eventType: "customer_replied",
              resultingRevision: updated.revision,
              actorId: access.principalId,
              occurredAt: now,
              correlationId: command.correlationId,
              commandId: command.commandId,
            },
          },
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
          ...(command.notification === undefined
            ? []
            : [
                {
                  action: "insert" as const,
                  value: deliveryJob(
                    command.ticketId,
                    command.messageId,
                    now,
                    command.notification,
                  ),
                },
              ]),
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
      const tickets: Ticket[] = [];
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
        right.updatedAt.localeCompare(left.updatedAt),
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

export interface ClaimDeliveryJobInput {
  readonly ticketId: TicketId;
  readonly deliveryJobId: string;
  readonly workerId: string;
  readonly now: IsoTimestamp;
  readonly leaseExpiresAt: IsoTimestamp;
}

function canonicalTimestamp(value: IsoTimestamp, field: string): number {
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== value) {
    throw new TypeError(`${field} must be a canonical ISO timestamp`);
  }
  return epoch;
}

function snapshotClaimDeliveryJobInput(
  input: ClaimDeliveryJobInput,
): ClaimDeliveryJobInput {
  const source = boundaryObject(input, "delivery claim");
  const raw = {
    ticketId: ownDataProperty(source, "ticketId", "delivery claim.ticketId"),
    deliveryJobId: ownDataProperty(
      source,
      "deliveryJobId",
      "delivery claim.deliveryJobId",
    ),
    workerId: ownDataProperty(source, "workerId", "delivery claim.workerId"),
    now: ownDataProperty(source, "now", "delivery claim.now"),
    leaseExpiresAt: ownDataProperty(
      source,
      "leaseExpiresAt",
      "delivery claim.leaseExpiresAt",
    ),
  };
  return Object.freeze({
    ticketId: boundaryString(raw.ticketId, "delivery claim.ticketId"),
    deliveryJobId: boundaryString(
      raw.deliveryJobId,
      "delivery claim.deliveryJobId",
    ),
    workerId: boundaryString(raw.workerId, "delivery claim.workerId"),
    now: boundaryString(raw.now, "delivery claim.now"),
    leaseExpiresAt: boundaryString(
      raw.leaseExpiresAt,
      "delivery claim.leaseExpiresAt",
    ),
  });
}

export async function claimDeliveryJob(
  store: Store,
  input: ClaimDeliveryJobInput,
): Promise<DeliveryJob | null> {
  const request = snapshotClaimDeliveryJobInput(input);
  requireIdentifier(request.ticketId, "ticketId");
  requireIdentifier(request.deliveryJobId, "deliveryJobId");
  requireIdentifier(request.workerId, "workerId");
  const now = canonicalTimestamp(request.now, "now");
  const leaseExpiresAt = canonicalTimestamp(
    request.leaseExpiresAt,
    "leaseExpiresAt",
  );
  if (leaseExpiresAt <= now) {
    throw new TypeError("leaseExpiresAt must be later than now");
  }
  const claimToken = crypto.randomUUID();
  const records = store.collection(supportRecords);
  const result = await records.update(
    {
      partition: request.ticketId,
      id: `delivery:${request.deliveryJobId}`,
    },
    (current) => {
      if (current?.kind !== "delivery_job") {
        return { action: "keep" };
      }
      if (
        current.status === "delivered" ||
        current.status === "dead_letter" ||
        current.status === "terminal_unknown" ||
        current.status === "accepted" ||
        (current.status === "leased" && current.leasePurpose === "reconcile") ||
        current.availableAt > request.now ||
        (current.status === "leased" &&
          current.leaseExpiresAt !== undefined &&
          current.leaseExpiresAt > request.now)
      ) {
        return { action: "keep" };
      }
      return {
        action: "write",
        value: {
          ...current,
          status: "leased",
          leaseOwner: request.workerId,
          leaseExpiresAt: request.leaseExpiresAt,
          claimToken,
          leasePurpose: "send",
        },
      };
    },
  );
  return result.written && result.value?.kind === "delivery_job"
    ? result.value
    : null;
}

export interface CompleteDeliveryAttemptInput {
  readonly ticketId: TicketId;
  readonly deliveryJobId: string;
  readonly workerId: string;
  readonly claimToken: string;
  readonly now: IsoTimestamp;
  readonly outcome:
    | {
        readonly accepted: true;
        readonly providerMessageRef: string;
        readonly acceptedDeadlineAt: IsoTimestamp;
      }
    | {
        readonly accepted: false;
        readonly failureCategory: string;
        readonly retryAt: IsoTimestamp;
      };
}

function snapshotCompleteDeliveryAttemptInput(
  input: CompleteDeliveryAttemptInput,
): CompleteDeliveryAttemptInput {
  const source = boundaryObject(input, "delivery completion");
  const raw = {
    ticketId: ownDataProperty(
      source,
      "ticketId",
      "delivery completion.ticketId",
    ),
    deliveryJobId: ownDataProperty(
      source,
      "deliveryJobId",
      "delivery completion.deliveryJobId",
    ),
    workerId: ownDataProperty(
      source,
      "workerId",
      "delivery completion.workerId",
    ),
    claimToken: ownDataProperty(
      source,
      "claimToken",
      "delivery completion.claimToken",
    ),
    now: ownDataProperty(source, "now", "delivery completion.now"),
    outcome: ownDataProperty(source, "outcome", "delivery completion.outcome"),
  };
  const outcomeSource = boundaryObject(
    raw.outcome,
    "delivery completion.outcome",
  );
  const accepted = ownDataProperty(
    outcomeSource,
    "accepted",
    "delivery completion.outcome.accepted",
  );
  if (typeof accepted !== "boolean") {
    throw new TypeError(
      "delivery completion.outcome.accepted must be a boolean",
    );
  }
  const outcome: CompleteDeliveryAttemptInput["outcome"] = accepted
    ? Object.freeze({
        accepted: true,
        acceptedDeadlineAt: boundaryString(
          ownDataProperty(
            outcomeSource,
            "acceptedDeadlineAt",
            "delivery completion.outcome.acceptedDeadlineAt",
          ),
          "delivery completion.outcome.acceptedDeadlineAt",
        ),
        providerMessageRef: validateProviderMessageRef(
          boundaryString(
            ownDataProperty(
              outcomeSource,
              "providerMessageRef",
              "delivery completion.outcome.providerMessageRef",
            ),
            "delivery completion.outcome.providerMessageRef",
          ),
          "delivery completion.outcome.providerMessageRef",
        ),
      })
    : Object.freeze({
        accepted: false,
        failureCategory: boundaryString(
          ownDataProperty(
            outcomeSource,
            "failureCategory",
            "delivery completion.outcome.failureCategory",
          ),
          "delivery completion.outcome.failureCategory",
        ),
        retryAt: boundaryString(
          ownDataProperty(
            outcomeSource,
            "retryAt",
            "delivery completion.outcome.retryAt",
          ),
          "delivery completion.outcome.retryAt",
        ),
      });
  return Object.freeze({
    ticketId: boundaryString(raw.ticketId, "delivery completion.ticketId"),
    deliveryJobId: boundaryString(
      raw.deliveryJobId,
      "delivery completion.deliveryJobId",
    ),
    workerId: boundaryString(raw.workerId, "delivery completion.workerId"),
    claimToken: boundaryString(
      raw.claimToken,
      "delivery completion.claimToken",
    ),
    now: boundaryString(raw.now, "delivery completion.now"),
    outcome,
  });
}

export async function completeDeliveryAttempt(
  store: Store,
  input: CompleteDeliveryAttemptInput,
): Promise<DeliveryJob | null> {
  const request = snapshotCompleteDeliveryAttemptInput(input);
  requireIdentifier(request.ticketId, "ticketId");
  requireIdentifier(request.deliveryJobId, "deliveryJobId");
  requireIdentifier(request.workerId, "workerId");
  requireIdentifier(request.claimToken, "claimToken");
  const now = canonicalTimestamp(request.now, "now");
  if (request.outcome.accepted) {
    const acceptedDeadlineAt = canonicalTimestamp(
      request.outcome.acceptedDeadlineAt,
      "acceptedDeadlineAt",
    );
    if (acceptedDeadlineAt <= now) {
      throw new TypeError("acceptedDeadlineAt must be later than now");
    }
  } else {
    const retryAt = canonicalTimestamp(request.outcome.retryAt, "retryAt");
    if (retryAt < now) {
      throw new TypeError("retryAt must not be earlier than now");
    }
    if (!FAILURE_CATEGORY.test(request.outcome.failureCategory)) {
      throw new TypeError("failureCategory must be a coarse safe token");
    }
  }
  const records = store.collection(supportRecords);
  const result = await records.update(
    {
      partition: request.ticketId,
      id: `delivery:${request.deliveryJobId}`,
    },
    (current) => {
      if (
        current?.kind !== "delivery_job" ||
        current.status !== "leased" ||
        current.leaseOwner !== request.workerId ||
        current.claimToken !== request.claimToken ||
        current.leasePurpose !== "send"
      ) {
        return { action: "keep" };
      }
      const attemptCount = current.attemptCount + 1;
      const {
        leaseOwner: _leaseOwner,
        leaseExpiresAt: _leaseExpiresAt,
        claimToken: _claimToken,
        leasePurpose: _leasePurpose,
        ...unleased
      } = current;
      const common = {
        ...unleased,
        attemptCount,
      };
      if (request.outcome.accepted) {
        return {
          action: "write",
          value: {
            ...common,
            status: "accepted",
            acceptedAt: request.now,
            acceptedDeadlineAt: request.outcome.acceptedDeadlineAt,
            reconciliationAttemptCount: 0,
            providerMessageRef: request.outcome.providerMessageRef,
          },
        };
      }
      return {
        action: "write",
        value: {
          ...common,
          status:
            attemptCount >= current.maxAttempts ? "dead_letter" : "retrying",
          availableAt: request.outcome.retryAt,
          failureCategory: request.outcome.failureCategory,
          ...(attemptCount >= current.maxAttempts
            ? { terminalAt: request.now }
            : {}),
        },
      };
    },
  );
  return result.written && result.value?.kind === "delivery_job"
    ? result.value
    : null;
}

export async function claimAcceptedDeliveryJob(
  store: Store,
  input: ClaimDeliveryJobInput,
): Promise<DeliveryJob | null> {
  const request = snapshotClaimDeliveryJobInput(input);
  requireIdentifier(request.ticketId, "ticketId");
  requireIdentifier(request.deliveryJobId, "deliveryJobId");
  requireIdentifier(request.workerId, "workerId");
  const now = canonicalTimestamp(request.now, "now");
  const leaseExpiresAt = canonicalTimestamp(
    request.leaseExpiresAt,
    "leaseExpiresAt",
  );
  if (leaseExpiresAt <= now) {
    throw new TypeError("leaseExpiresAt must be later than now");
  }
  const claimToken = crypto.randomUUID();
  const records = store.collection(supportRecords);
  const result = await records.update(
    {
      partition: request.ticketId,
      id: `delivery:${request.deliveryJobId}`,
    },
    (current) => {
      if (current?.kind !== "delivery_job") {
        return { action: "keep" };
      }
      const acceptedExpired =
        current.status === "accepted" &&
        (current.acceptedDeadlineAt === undefined ||
          current.acceptedDeadlineAt <= request.now);
      const reconcileLeaseExpired =
        current.status === "leased" &&
        current.leasePurpose === "reconcile" &&
        current.leaseExpiresAt !== undefined &&
        current.leaseExpiresAt <= request.now;
      if (!acceptedExpired && !reconcileLeaseExpired) {
        return { action: "keep" };
      }
      return {
        action: "write",
        value: {
          ...current,
          status: "leased",
          leaseOwner: request.workerId,
          leaseExpiresAt: request.leaseExpiresAt,
          claimToken,
          leasePurpose: "reconcile",
        },
      };
    },
  );
  return result.written && result.value?.kind === "delivery_job"
    ? result.value
    : null;
}

export interface CompleteDeliveryReconciliationInput {
  readonly ticketId: TicketId;
  readonly deliveryJobId: string;
  readonly workerId: string;
  readonly claimToken: string;
  readonly now: IsoTimestamp;
  readonly outcome:
    | { readonly status: "delivered" }
    | { readonly status: "failed"; readonly failureCategory: string }
    | { readonly status: "invalid"; readonly failureCategory: string }
    | {
        readonly status: "unavailable";
        readonly failureCategory: string;
        readonly retryAt: IsoTimestamp;
      }
    | { readonly status: "unknown" };
}

function snapshotCompleteDeliveryReconciliationInput(
  input: CompleteDeliveryReconciliationInput,
): CompleteDeliveryReconciliationInput {
  const source = boundaryObject(input, "delivery reconciliation");
  const raw = {
    ticketId: ownDataProperty(
      source,
      "ticketId",
      "delivery reconciliation.ticketId",
    ),
    deliveryJobId: ownDataProperty(
      source,
      "deliveryJobId",
      "delivery reconciliation.deliveryJobId",
    ),
    workerId: ownDataProperty(
      source,
      "workerId",
      "delivery reconciliation.workerId",
    ),
    claimToken: ownDataProperty(
      source,
      "claimToken",
      "delivery reconciliation.claimToken",
    ),
    now: ownDataProperty(source, "now", "delivery reconciliation.now"),
    outcome: ownDataProperty(
      source,
      "outcome",
      "delivery reconciliation.outcome",
    ),
  };
  const outcomeSource = boundaryObject(
    raw.outcome,
    "delivery reconciliation.outcome",
  );
  const status = boundaryString(
    ownDataProperty(
      outcomeSource,
      "status",
      "delivery reconciliation.outcome.status",
    ),
    "delivery reconciliation.outcome.status",
  );
  if (
    status !== "delivered" &&
    status !== "failed" &&
    status !== "invalid" &&
    status !== "unavailable" &&
    status !== "unknown"
  ) {
    throw new TypeError(
      "delivery reconciliation.outcome.status must be delivered, failed, invalid, unavailable, or unknown",
    );
  }
  let outcome: CompleteDeliveryReconciliationInput["outcome"];
  if (status === "unavailable") {
    outcome = Object.freeze({
      status,
      failureCategory: boundaryString(
        ownDataProperty(
          outcomeSource,
          "failureCategory",
          "delivery reconciliation.outcome.failureCategory",
        ),
        "delivery reconciliation.outcome.failureCategory",
      ),
      retryAt: boundaryString(
        ownDataProperty(
          outcomeSource,
          "retryAt",
          "delivery reconciliation.outcome.retryAt",
        ),
        "delivery reconciliation.outcome.retryAt",
      ),
    });
  } else if (status === "failed" || status === "invalid") {
    outcome = Object.freeze({
      status,
      failureCategory: boundaryString(
        ownDataProperty(
          outcomeSource,
          "failureCategory",
          "delivery reconciliation.outcome.failureCategory",
        ),
        "delivery reconciliation.outcome.failureCategory",
      ),
    });
  } else {
    outcome = Object.freeze({ status });
  }
  return Object.freeze({
    ticketId: boundaryString(raw.ticketId, "delivery reconciliation.ticketId"),
    deliveryJobId: boundaryString(
      raw.deliveryJobId,
      "delivery reconciliation.deliveryJobId",
    ),
    workerId: boundaryString(raw.workerId, "delivery reconciliation.workerId"),
    claimToken: boundaryString(
      raw.claimToken,
      "delivery reconciliation.claimToken",
    ),
    now: boundaryString(raw.now, "delivery reconciliation.now"),
    outcome,
  });
}

export async function completeDeliveryReconciliation(
  store: Store,
  input: CompleteDeliveryReconciliationInput,
): Promise<DeliveryJob | null> {
  const request = snapshotCompleteDeliveryReconciliationInput(input);
  requireIdentifier(request.ticketId, "ticketId");
  requireIdentifier(request.deliveryJobId, "deliveryJobId");
  requireIdentifier(request.workerId, "workerId");
  requireIdentifier(request.claimToken, "claimToken");
  const now = canonicalTimestamp(request.now, "now");
  if (
    (request.outcome.status === "failed" ||
      request.outcome.status === "invalid" ||
      request.outcome.status === "unavailable") &&
    !FAILURE_CATEGORY.test(request.outcome.failureCategory)
  ) {
    throw new TypeError("failureCategory must be a coarse safe token");
  }
  if (
    request.outcome.status === "unavailable" &&
    canonicalTimestamp(request.outcome.retryAt, "retryAt") < now
  ) {
    throw new TypeError("retryAt must not be earlier than now");
  }
  const records = store.collection(supportRecords);
  const result = await records.update(
    {
      partition: request.ticketId,
      id: `delivery:${request.deliveryJobId}`,
    },
    (current) => {
      if (
        current?.kind !== "delivery_job" ||
        current.status !== "leased" ||
        current.leaseOwner !== request.workerId ||
        current.claimToken !== request.claimToken ||
        current.leasePurpose !== "reconcile"
      ) {
        return { action: "keep" };
      }
      const {
        leaseOwner: _leaseOwner,
        leaseExpiresAt: _leaseExpiresAt,
        claimToken: _claimToken,
        leasePurpose: _leasePurpose,
        ...unleased
      } = current;
      if (request.outcome.status === "delivered") {
        return {
          action: "write",
          value: {
            ...unleased,
            status: "delivered",
            deliveredAt: request.now,
            terminalAt: request.now,
          },
        };
      }
      if (request.outcome.status === "failed") {
        const exhausted = current.attemptCount >= current.maxAttempts;
        return {
          action: "write",
          value: {
            ...unleased,
            status: exhausted ? "dead_letter" : "retrying",
            availableAt: request.now,
            failureCategory: request.outcome.failureCategory,
            ...(exhausted ? { terminalAt: request.now } : {}),
          },
        };
      }
      if (request.outcome.status === "invalid") {
        return {
          action: "write",
          value: {
            ...unleased,
            status: "dead_letter",
            failureCategory: request.outcome.failureCategory,
            terminalAt: request.now,
          },
        };
      }
      if (request.outcome.status === "unavailable") {
        const reconciliationAttemptCount =
          (current.reconciliationAttemptCount ?? 0) + 1;
        const exhausted = reconciliationAttemptCount >= current.maxAttempts;
        return {
          action: "write",
          value: {
            ...unleased,
            reconciliationAttemptCount,
            status: exhausted ? "dead_letter" : "accepted",
            failureCategory: request.outcome.failureCategory,
            ...(exhausted
              ? { terminalAt: request.now }
              : { acceptedDeadlineAt: request.outcome.retryAt }),
          },
        };
      }
      return {
        action: "write",
        value: {
          ...unleased,
          status: "terminal_unknown",
          failureCategory: "delivery_status_unknown",
          terminalAt: request.now,
        },
      };
    },
  );
  return result.written && result.value?.kind === "delivery_job"
    ? result.value
    : null;
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
    stored.status === receipt.status &&
    stored.occurredAt === receipt.occurredAt
  );
}

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
  return Object.freeze({
    provider: readString("provider"),
    providerEventId: readString("providerEventId"),
    ticketId: readString("ticketId"),
    deliveryJobId: readString("deliveryJobId"),
    status: readString("status") as DeliveryCallbackInput["status"],
    occurredAt: readString("occurredAt"),
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
  if (receipt.status !== "delivered" && receipt.status !== "failed") {
    throw new TypeError("callback status must be delivered or failed");
  }
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
  const result = await records.update(
    {
      partition: receipt.ticketId,
      id: `delivery:${receipt.deliveryJobId}`,
    },
    (current) => {
      if (
        current?.kind !== "delivery_job" ||
        current.status === "dead_letter" ||
        current.status === "delivered"
      ) {
        return { action: "keep" };
      }
      const {
        leaseOwner: _leaseOwner,
        leaseExpiresAt: _leaseExpiresAt,
        claimToken: _claimToken,
        leasePurpose: _leasePurpose,
        ...unleased
      } = current;
      const attemptCount =
        receipt.status === "failed" &&
        current.status === "leased" &&
        current.leasePurpose === "send"
          ? current.attemptCount + 1
          : current.attemptCount;
      return receipt.status === "delivered"
        ? {
            action: "write",
            value: {
              ...unleased,
              status: "delivered",
              deliveredAt: processedAt,
              terminalAt: processedAt,
            },
          }
        : {
            action: "write",
            value: {
              ...unleased,
              attemptCount,
              status:
                attemptCount >= current.maxAttempts
                  ? "dead_letter"
                  : "retrying",
              availableAt: processedAt,
              failureCategory: "provider_callback_failure",
              ...(attemptCount >= current.maxAttempts
                ? { terminalAt: processedAt }
                : {}),
            },
          };
    },
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
    job: result.value?.kind === "delivery_job" ? result.value : null,
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

/**
 * Reclaim terminal outbox rows without racing a callback or newer state.
 *
 * Ticket conversation records remain subject to the hard message cap; this
 * sweep only removes delivery jobs whose terminal version is old enough.
 */
export async function sweepTerminalDeliveryJobs(
  store: Store,
  input: {
    readonly ticketId: TicketId;
    readonly terminalBefore: IsoTimestamp;
    readonly maxDeletes?: number;
  },
): Promise<number> {
  const source = boundaryObject(input, "terminal delivery sweep");
  const raw = {
    ticketId: ownDataProperty(
      source,
      "ticketId",
      "terminal delivery sweep.ticketId",
    ),
    terminalBefore: ownDataProperty(
      source,
      "terminalBefore",
      "terminal delivery sweep.terminalBefore",
    ),
    maxDeletes: ownDataProperty(
      source,
      "maxDeletes",
      "terminal delivery sweep.maxDeletes",
      true,
    ),
  };
  const ticketId = boundaryString(
    raw.ticketId,
    "terminal delivery sweep.ticketId",
  );
  const terminalBefore = boundaryString(
    raw.terminalBefore,
    "terminal delivery sweep.terminalBefore",
  );
  if (raw.maxDeletes !== undefined && typeof raw.maxDeletes !== "number") {
    throw new TypeError("terminal delivery sweep.maxDeletes must be a number");
  }
  requireIdentifier(ticketId, "ticketId");
  canonicalTimestamp(terminalBefore, "terminalBefore");
  const maxDeletes = raw.maxDeletes ?? 100;
  if (!Number.isSafeInteger(maxDeletes) || maxDeletes <= 0) {
    throw new TypeError("maxDeletes must be a positive safe integer");
  }
  const records = store.collection(supportRecords);
  const candidates = (await records.listVersioned(ticketId))
    .filter(
      (versioned) =>
        versioned.value.kind === "delivery_job" &&
        (versioned.value.status === "delivered" ||
          versioned.value.status === "dead_letter" ||
          versioned.value.status === "terminal_unknown") &&
        versioned.value.terminalAt !== undefined &&
        versioned.value.terminalAt <= terminalBefore,
    )
    .slice(0, maxDeletes);
  let deleted = 0;
  for (const candidate of candidates) {
    if (
      await records.deleteIfUnchanged(
        {
          partition: ticketId,
          id: candidate.value.id,
        },
        candidate.version,
      )
    ) {
      deleted += 1;
    }
  }
  return deleted;
}
