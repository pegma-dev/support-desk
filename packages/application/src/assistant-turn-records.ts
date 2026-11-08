import type { IsoTimestamp } from "@pegma/spine";
import type { EntityKey } from "@pegma/storage-core";
import type { Ticket, TicketMessage } from "@pegma/support-desk-contracts";
import type { HandlingCommandResult } from "./index.js";
import type {
  AssistantAttemptBinding,
  AssistantPreparedAttempt,
  AssistantTurnClaimFence,
  AssistantTurnFinishResult,
  AssistantTurnOptions,
  AssistantTurnProcessingMetadata,
} from "./assistant-turn-types.js";

export interface ResolvedAssistantTurnOptions {
  readonly maxAttempts: number;
  readonly maxTurnMilliseconds: number;
  readonly maxLeaseMilliseconds: number;
}

/** One bounded row per causal message; attempts never append physical rows. */
export interface AssistantTurnRecord {
  readonly kind: "assistant_turn";
  readonly partition: string;
  readonly id: string;
  readonly ticketId: string;
  readonly turnId: string;
  readonly triggerMessageId: string;
  readonly triggerRevision: number;
  readonly triggerHandlingGeneration: number;
  readonly correlationId: string;
  readonly createdAt: IsoTimestamp;
  readonly turnDeadline: IsoTimestamp;
  readonly maxAttempts: number;
  readonly status:
    "pending" | "claimed" | "retry" | "completed" | "escalated" | "superseded";
  readonly attempt: number;
  readonly claimGeneration: number;
  readonly claim?: AssistantTurnClaimFence;
  readonly leaseUntil?: IsoTimestamp;
  readonly nextAttemptAt?: IsoTimestamp;
  readonly preparedAttempts: readonly AssistantPreparedAttempt[];
  readonly processing?: AssistantTurnProcessingMetadata;
  readonly terminalResult?: HandlingCommandResult;
  readonly lastFinish?: {
    readonly fingerprint: string;
    readonly result: AssistantTurnFinishResult;
  };
}

const identifierMaximum = 200;
const hardRecordBytes = 60_000;
/** Leave room for failure/accounting/terminal state even after four preparations. */
export const preparedRecordBytes = 52_000;
export const maximumBindingBytes = 12_000;

export function dataObject(
  value: unknown,
  name: string,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError(`${name} must be a data object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    throw new TypeError(`${name} must be a plain data object`);
  if (Object.getOwnPropertySymbols(value).length !== 0)
    throw new TypeError(`${name} cannot contain symbol fields`);
  for (const descriptor of Object.values(
    Object.getOwnPropertyDescriptors(value),
  ))
    if (!("value" in descriptor) || !descriptor.enumerable)
      throw new TypeError(`${name} must contain enumerable data fields`);
  return value as Record<string, unknown>;
}

export function fields(
  value: unknown,
  name: string,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  const source = dataObject(value, name);
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.getOwnPropertyNames(source))
    if (!allowed.has(key)) throw new TypeError(`${name} has an unknown field`);
  for (const key of required)
    if (!Object.hasOwn(source, key) || source[key] === undefined)
      throw new TypeError(`${name}.${key} is required`);
  return source;
}

export function dataArray(
  value: unknown,
  name: string,
  maximum: number,
): readonly unknown[] {
  if (
    !Array.isArray(value) ||
    value.length > maximum ||
    Object.getOwnPropertySymbols(value).length !== 0
  )
    throw new TypeError(`${name} must be a bounded data array`);
  for (const key of Object.getOwnPropertyNames(value)) {
    if (key === "length") continue;
    if (
      !/^(0|[1-9][0-9]*)$/.test(key) ||
      Number(key) >= value.length ||
      !("value" in Object.getOwnPropertyDescriptor(value, key)!)
    )
      throw new TypeError(`${name} must contain only data elements`);
  }
  for (let index = 0; index < value.length; index += 1)
    if (!Object.hasOwn(value, index))
      throw new TypeError(`${name} cannot contain sparse elements`);
  return value;
}

export function text(
  value: unknown,
  name: string,
  maximum = identifierMaximum,
): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maximum ||
    /[\u0000-\u001F\u007F]/.test(value)
  )
    throw new TypeError(
      `${name} must be bounded nonempty text without controls`,
    );
  return value;
}

export function integer(
  value: unknown,
  name: string,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  )
    throw new TypeError(`${name} must be a bounded safe integer`);
  return value;
}

export function timestamp(value: unknown, name: string): number {
  if (typeof value !== "string")
    throw new TypeError(`${name} must be a timestamp`);
  const result = Date.parse(value);
  if (!Number.isFinite(result) || new Date(result).toISOString() !== value)
    throw new TypeError(`${name} must be a canonical ISO timestamp`);
  return result;
}

export function encodedBytes(value: unknown): number {
  // This is the same conservative UTF-16 JSON-string bound used by Support's
  // Azure-compatible record codec. JSON.stringify accounts for escaping too.
  return JSON.stringify(value).length * 2;
}

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .filter((key) => object[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
      .join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined)
    throw new TypeError("Cannot fingerprint non-JSON data");
  return encoded;
}

export async function fingerprint(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical(value)),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function snapshot<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function resolveAssistantTurnOptions(
  input: AssistantTurnOptions | undefined,
): ResolvedAssistantTurnOptions | undefined {
  if (input === undefined) return undefined;
  const source = fields(
    input,
    "assistantTurns",
    [],
    ["maxAttempts", "maxTurnMilliseconds", "maxLeaseMilliseconds"],
  );
  return Object.freeze({
    maxAttempts: integer(
      source.maxAttempts ?? 2,
      "assistantTurns.maxAttempts",
      1,
      4,
    ),
    maxTurnMilliseconds: integer(
      source.maxTurnMilliseconds ?? 300_000,
      "assistantTurns.maxTurnMilliseconds",
      1,
      3_600_000,
    ),
    maxLeaseMilliseconds: integer(
      source.maxLeaseMilliseconds ?? 60_000,
      "assistantTurns.maxLeaseMilliseconds",
      1,
      300_000,
    ),
  });
}

export function assistantTurnKey(ticketId: string, turnId: string): EntityKey {
  return { partition: ticketId, id: "assistant-turn:" + turnId };
}

export function terminalTurn(record: AssistantTurnRecord): boolean {
  return (
    record.status === "completed" ||
    record.status === "escalated" ||
    record.status === "superseded"
  );
}

export async function createAssistantTurnRecord(
  ticket: Ticket,
  message: TicketMessage,
  correlationId: string,
  options: ResolvedAssistantTurnOptions,
): Promise<AssistantTurnRecord> {
  const turnId = await fingerprint({ messageId: message.id });
  const row: AssistantTurnRecord = {
    kind: "assistant_turn",
    partition: ticket.id,
    id: assistantTurnKey(ticket.id, turnId).id,
    ticketId: ticket.id,
    turnId,
    triggerMessageId: message.id,
    triggerRevision: ticket.revision,
    triggerHandlingGeneration: ticket.handling!.generation,
    correlationId,
    createdAt: message.createdAt,
    turnDeadline: new Date(
      timestamp(message.createdAt, "message.createdAt") +
        options.maxTurnMilliseconds,
    ).toISOString(),
    maxAttempts: options.maxAttempts,
    status: "pending",
    attempt: 0,
    claimGeneration: 0,
    preparedAttempts: [],
  };
  assertAssistantTurnRecord(row);
  return row;
}

const fenceFields = [
  "ticketId",
  "turnId",
  "workerId",
  "claimId",
  "claimGeneration",
  "attempt",
  "attemptId",
  "commandId",
  "correlationId",
  "expectedRevision",
  "expectedHandlingGeneration",
  "triggerMessageId",
] as const;
export const assistantTurnFenceFields: readonly string[] = fenceFields;

export function validateFence(
  input: unknown,
  extraRequired: readonly string[] = [],
  extraOptional: readonly string[] = [],
): AssistantTurnClaimFence & Record<string, unknown> {
  const source = fields(
    input,
    "assistant turn command",
    [...fenceFields, ...extraRequired],
    extraOptional,
  );
  for (const field of [
    "ticketId",
    "turnId",
    "workerId",
    "claimId",
    "attemptId",
    "commandId",
    "correlationId",
    "triggerMessageId",
  ])
    text(source[field], field);
  for (const field of [
    "claimGeneration",
    "attempt",
    "expectedRevision",
    "expectedHandlingGeneration",
  ])
    integer(source[field], field, 1);
  return source as AssistantTurnClaimFence & Record<string, unknown>;
}

export function validateProcessing(
  input: unknown,
): AssistantTurnProcessingMetadata | undefined {
  if (input === undefined) return undefined;
  const source = fields(
    input,
    "processing",
    [],
    [
      "provider",
      "model",
      "requestId",
      "inputTokens",
      "outputTokens",
      "costMicros",
      "currency",
      "failureCategory",
    ],
  );
  for (const key of [
    "provider",
    "model",
    "requestId",
    "currency",
    "failureCategory",
  ])
    if (source[key] !== undefined)
      text(
        source[key],
        `processing.${key}`,
        key === "failureCategory" ? 80 : 200,
      );
  for (const key of ["inputTokens", "outputTokens", "costMicros"])
    if (source[key] !== undefined) integer(source[key], `processing.${key}`);
  return snapshot(source) as AssistantTurnProcessingMetadata;
}

export function validateBinding(input: unknown): AssistantAttemptBinding {
  const source = fields(input, "binding", [
    "inputFingerprint",
    "versions",
    "references",
    "contextBinding",
    "deadline",
    "usageReservationId",
  ]);
  text(source.inputFingerprint, "binding.inputFingerprint");
  text(source.contextBinding, "binding.contextBinding", 2_000);
  text(source.usageReservationId, "binding.usageReservationId");
  timestamp(source.deadline, "binding.deadline");
  const versions = dataObject(source.versions, "binding.versions");
  if (Object.getOwnPropertyNames(versions).length > 16)
    throw new TypeError("binding.versions has too many entries");
  for (const key of Object.getOwnPropertyNames(versions)) {
    const value = versions[key];
    text(key, "binding version name", 80);
    text(value, "binding version");
  }
  for (const reference of dataArray(
    source.references,
    "binding.references",
    32,
  )) {
    const item = fields(reference, "binding reference", [
      "namespace",
      "resourceId",
      "revision",
      "binding",
    ]);
    for (const key of ["namespace", "resourceId", "revision"])
      text(item[key], `reference.${key}`);
    text(item.binding, "reference.binding", 6_000);
  }
  if (encodedBytes(source) > maximumBindingBytes)
    throw new TypeError("Assistant attempt binding exceeds its encoded bound");
  return snapshot(source) as unknown as AssistantAttemptBinding;
}

export function assertAssistantTurnRecord(
  value: AssistantTurnRecord,
  physical?: EntityKey,
): void {
  const row = fields(
    value,
    "assistant turn record",
    [
      "kind",
      "partition",
      "id",
      "ticketId",
      "turnId",
      "triggerMessageId",
      "triggerRevision",
      "triggerHandlingGeneration",
      "correlationId",
      "createdAt",
      "turnDeadline",
      "maxAttempts",
      "status",
      "attempt",
      "claimGeneration",
      "preparedAttempts",
    ],
    [
      "claim",
      "leaseUntil",
      "nextAttemptAt",
      "processing",
      "terminalResult",
      "lastFinish",
    ],
  );
  if (
    row.kind !== "assistant_turn" ||
    !/^[0-9a-f]{64}$/.test(text(row.turnId, "turnId"))
  )
    throw new TypeError("Invalid assistant turn identity");
  for (const key of [
    "partition",
    "ticketId",
    "triggerMessageId",
    "correlationId",
  ])
    text(row[key], key);
  if (
    row.partition !== row.ticketId ||
    row.id !== assistantTurnKey(value.ticketId, value.turnId).id ||
    (physical !== undefined &&
      (physical.partition !== row.partition || physical.id !== row.id))
  )
    throw new TypeError(
      "Assistant turn physical key disagrees with its identity",
    );
  integer(row.triggerRevision, "triggerRevision", 1);
  integer(row.triggerHandlingGeneration, "triggerHandlingGeneration", 1);
  integer(row.maxAttempts, "maxAttempts", 1, 4);
  integer(row.attempt, "attempt", 0, value.maxAttempts);
  integer(row.claimGeneration, "claimGeneration");
  if (row.claimGeneration !== row.attempt)
    throw new TypeError(
      "Assistant claim generation disagrees with its bounded attempt",
    );
  if (
    timestamp(row.turnDeadline, "turnDeadline") <=
    timestamp(row.createdAt, "createdAt")
  )
    throw new TypeError("Invalid assistant turn deadline");
  if (
    typeof row.status !== "string" ||
    ![
      "pending",
      "claimed",
      "retry",
      "completed",
      "escalated",
      "superseded",
    ].includes(row.status)
  )
    throw new TypeError("Invalid assistant turn status");
  if (row.claim !== undefined) {
    const claim = validateFence(row.claim);
    if (
      claim.ticketId !== row.ticketId ||
      claim.turnId !== row.turnId ||
      claim.triggerMessageId !== row.triggerMessageId ||
      claim.correlationId !== row.correlationId ||
      claim.attempt !== row.attempt ||
      claim.claimGeneration !== row.claimGeneration ||
      claim.expectedHandlingGeneration !== row.triggerHandlingGeneration ||
      claim.expectedRevision < value.triggerRevision ||
      claim.attemptId !== `${value.turnId}:${value.attempt}` ||
      claim.commandId !== `assistant-complete:${claim.attemptId}`
    )
      throw new TypeError("Invalid assistant turn claim identity");
  }
  if (
    row.leaseUntil !== undefined &&
    timestamp(row.leaseUntil, "leaseUntil") >
      timestamp(row.turnDeadline, "turnDeadline")
  )
    throw new TypeError("Assistant lease exceeds its turn deadline");
  if (row.nextAttemptAt !== undefined)
    timestamp(row.nextAttemptAt, "nextAttemptAt");
  if (
    row.status === "claimed" &&
    (row.claim === undefined || row.leaseUntil === undefined)
  )
    throw new TypeError("Claimed assistant turn has no lease");
  if (
    row.status !== "claimed" &&
    (row.claim !== undefined || row.leaseUntil !== undefined)
  )
    throw new TypeError("Unclaimed assistant turn retains a live claim");
  if (row.status === "retry" && row.nextAttemptAt === undefined)
    throw new TypeError("Retrying assistant turn has no next attempt time");
  if (row.status !== "retry" && row.nextAttemptAt !== undefined)
    throw new TypeError("Assistant retry time disagrees with its status");
  if (
    row.status === "pending" &&
    (row.attempt !== 0 || value.preparedAttempts.length !== 0)
  )
    throw new TypeError("Pending assistant turn already contains an attempt");
  dataArray(row.preparedAttempts, "preparedAttempts", value.maxAttempts);
  const seen = new Set<string>();
  for (const prepared of value.preparedAttempts) {
    const item = fields(
      prepared,
      "prepared attempt",
      ["attempt", "attemptId", "inputFingerprint", "binding", "accounting"],
      ["processing"],
    );
    integer(item.attempt, "prepared attempt", 1, value.attempt);
    const binding = validateBinding(item.binding);
    if (
      timestamp(binding.deadline, "prepared deadline") >
      timestamp(row.turnDeadline, "turnDeadline")
    )
      throw new TypeError("Prepared request exceeds its turn deadline");
    if (
      item.attemptId !== `${value.turnId}:${prepared.attempt}` ||
      item.inputFingerprint !== binding.inputFingerprint ||
      seen.has(prepared.attemptId) ||
      typeof item.accounting !== "string" ||
      !["not_called", "accounted", "unknown"].includes(item.accounting)
    )
      throw new TypeError("Invalid prepared assistant attempt");
    seen.add(prepared.attemptId);
    validateProcessing(item.processing);
  }
  validateProcessing(row.processing);
  if (row.terminalResult !== undefined)
    validateHandlingResult(row.terminalResult, value.ticketId);
  if (
    (row.status === "completed" || row.status === "escalated") !==
    (row.terminalResult !== undefined)
  )
    throw new TypeError("Assistant terminal result disagrees with its status");
  if (row.lastFinish !== undefined) {
    const last = fields(row.lastFinish, "lastFinish", [
      "fingerprint",
      "result",
    ]);
    text(last.fingerprint, "finish fingerprint");
    const result = fields(
      last.result,
      "finish result",
      ["ticketId", "turnId", "outcome"],
      ["nextAttemptAt", "result"],
    );
    if (
      result.ticketId !== value.ticketId ||
      result.turnId !== value.turnId ||
      typeof result.outcome !== "string" ||
      ![
        "retry_scheduled",
        "superseded",
        "escalated",
        "already_terminal",
      ].includes(result.outcome)
    )
      throw new TypeError("Invalid finish result identity");
    if (result.nextAttemptAt !== undefined)
      timestamp(result.nextAttemptAt, "nextAttemptAt");
    if (result.result !== undefined)
      validateHandlingResult(result.result, value.ticketId);
    if (
      (result.outcome === "retry_scheduled") !==
        (result.nextAttemptAt !== undefined) ||
      (result.outcome === "escalated" && result.result === undefined)
    )
      throw new TypeError("Assistant finish result is incomplete");
  }
  if (encodedBytes(row) > hardRecordBytes)
    throw new TypeError("Assistant turn exceeds its encoded record bound");
}

function validateHandlingResult(input: unknown, ticketId: string): void {
  const result = fields(
    input,
    "assistant terminal result",
    ["ticketId", "revision", "handlingGeneration"],
    ["messageId"],
  );
  if (result.ticketId !== ticketId)
    throw new TypeError("Assistant terminal ticket disagrees");
  integer(result.revision, "terminal revision", 1);
  integer(result.handlingGeneration, "terminal handlingGeneration", 1);
  if (result.messageId !== undefined)
    text(result.messageId, "terminal messageId");
}
