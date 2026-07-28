import type {
  CollectionDefinition,
  CollectionStore,
  Store,
} from "@pegma/storage-core";
import { MAX_SCAN_PAGE_SIZE } from "@pegma/storage-core";
import type { Clock } from "@pegma/spine";
import {
  claimAcceptedDeliveryJob,
  claimDeliveryJob,
  completeDeliveryAttempt,
  completeDeliveryReconciliation,
  supportRecords,
  type DeliveryCallbackInput,
  type DeliveryJob,
  validateOutboundMessageId,
  validateProviderMessageRef,
} from "@pegma/support-desk-application";
import {
  renderTemplate,
  type TemplateDefinition,
} from "@pegma/support-desk-templates";

export interface OutboundMail {
  readonly recipientRef: string;
  readonly subject: string;
  readonly messageId: string;
  readonly plainText: string;
  readonly html: string;
}

export interface MailSendRequest {
  /**
   * Adapters must make repeated sends with this key return the same logical
   * provider result without creating a second message.
   */
  readonly idempotencyKey: string;
  readonly mail: OutboundMail;
}

export interface MailSendResult {
  readonly providerMessageRef: string;
}

export interface MailDeliveryPort {
  send(request: MailSendRequest): Promise<MailSendResult>;
}

export interface MailReconciliationRequest {
  readonly idempotencyKey: string;
  readonly providerMessageRef: string;
}

export type MailReconciliationResult =
  | { readonly status: "delivered" }
  | { readonly status: "failed"; readonly failureCategory: string }
  | { readonly status: "unknown" };

export interface MailReconciliationPort {
  reconcile(
    request: MailReconciliationRequest,
  ): Promise<MailReconciliationResult>;
}

/** Provider adapters call this host/application port with normalized events. */
export interface MailDeliveryCallbackPort {
  record(callback: DeliveryCallbackInput): Promise<void>;
}

export interface TemplateCatalog {
  get(id: string, version: number): TemplateDefinition | null;
}

export type FailureClassifier = (error: unknown) => string;

export interface DeliveryWorkerOptions {
  readonly store: Store;
  /** Trusted host time used after provider calls complete. */
  readonly clock: Clock;
  readonly delivery: MailDeliveryPort;
  readonly reconciliation: MailReconciliationPort;
  readonly templates: TemplateCatalog;
  readonly workerId: string;
  readonly leaseMilliseconds?: number;
  readonly baseRetryMilliseconds?: number;
  readonly acceptedCallbackMilliseconds?: number;
  readonly classifyFailure?: FailureClassifier;
}

export interface DeliverJobInput {
  readonly ticketId: string;
  readonly deliveryJobId: string;
  readonly now: string;
}

export interface DeliveryScanInput {
  readonly now: string;
  /** Opaque adapter cursor from the preceding page in this scan cycle. */
  readonly cursor?: string;
  /** Defaults to 100 and cannot exceed Storage Core's bounded page maximum. */
  readonly limit?: number;
}

export type DeliverJobResult =
  | { readonly status: "not_claimed" }
  | { readonly status: "accepted"; readonly job: DeliveryJob }
  | {
      readonly status: "retrying" | "dead_letter";
      readonly job: DeliveryJob;
    };

export interface DeliveryScanOutcome {
  /** Derived from the authoritative physical record key. */
  readonly ticketId: string;
  /** Derived from the authoritative physical record key. */
  readonly deliveryJobId: string;
  readonly result: DeliverJobResult;
}

export interface DeliveryScanPage {
  readonly outcomes: readonly DeliveryScanOutcome[];
  /** Persist this opaque value only after every outcome has been handled. */
  readonly nextCursor: string | null;
}

export type ReconcileJobResult =
  | { readonly status: "not_claimed" }
  | {
      readonly status:
        "delivered" | "retrying" | "dead_letter" | "terminal_unknown";
      readonly job: DeliveryJob;
    };

const HEADER_CONTROL = /[\u0000-\u001F\u007F]/;
const FAILURE_CATEGORY = /^[a-z][a-z0-9_]{0,63}$/;
const MAX_LEASE_MILLISECONDS = 86_400_000;
const MAX_BASE_RETRY_MILLISECONDS = 86_400_000;
const MAX_RETRY_DELAY_MILLISECONDS = 2_592_000_000;

function normalizeReconciliationResult(
  value: unknown,
): MailReconciliationResult {
  if (
    value === null ||
    (typeof value !== "object" && typeof value !== "function")
  ) {
    return { status: "unknown" };
  }
  const status = Object.getOwnPropertyDescriptor(value, "status");
  if (status === undefined || !Object.hasOwn(status, "value")) {
    return { status: "unknown" };
  }
  if (status.value === "delivered") {
    return { status: "delivered" };
  }
  if (status.value === "unknown") {
    return { status: "unknown" };
  }
  if (status.value !== "failed") {
    return { status: "unknown" };
  }
  const failure = Object.getOwnPropertyDescriptor(value, "failureCategory");
  return failure !== undefined &&
    Object.hasOwn(failure, "value") &&
    typeof failure.value === "string" &&
    FAILURE_CATEGORY.test(failure.value)
    ? { status: "failed", failureCategory: failure.value }
    : { status: "unknown" };
}

function normalizeMailSendResult(value: unknown): MailSendResult {
  if (
    value === null ||
    (typeof value !== "object" && typeof value !== "function")
  ) {
    throw new DeliveryWorkError("provider_response_invalid");
  }
  const descriptor = Object.getOwnPropertyDescriptor(
    value,
    "providerMessageRef",
  );
  if (
    descriptor === undefined ||
    !Object.hasOwn(descriptor, "value") ||
    typeof descriptor.value !== "string"
  ) {
    throw new DeliveryWorkError("provider_response_invalid");
  }
  let providerMessageRef: string;
  try {
    providerMessageRef = validateProviderMessageRef(
      descriptor.value,
      "providerMessageRef",
    );
  } catch {
    throw new DeliveryWorkError("provider_response_invalid");
  }
  return Object.freeze({ providerMessageRef });
}
const MAX_ACCEPTED_CALLBACK_MILLISECONDS = 604_800_000;
const MAX_DATE_EPOCH_MILLISECONDS = 8_640_000_000_000_000;

class DeliveryWorkError extends Error {
  constructor(readonly category: string) {
    super("Delivery work could not be prepared");
    this.name = "DeliveryWorkError";
  }
}

export function ticketSubject(ticketNumber: number, subject: string): string {
  if (!Number.isSafeInteger(ticketNumber) || ticketNumber <= 0) {
    throw new TypeError("ticketNumber must be a positive safe integer");
  }
  const normalized = subject.replaceAll(/\s+/g, " ").trim();
  if (normalized.length === 0 || HEADER_CONTROL.test(subject)) {
    throw new TypeError("subject must be non-empty and contain no controls");
  }
  return `[Ticket #${ticketNumber}] ${normalized}`;
}

export function outboundMessageId(
  notificationId: string,
  domain: string,
): string {
  if (!/^[A-Za-z0-9._-]+$/.test(notificationId)) {
    throw new TypeError("notificationId contains unsafe Message-ID characters");
  }
  if (
    !/^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(
      domain,
    )
  ) {
    throw new TypeError("domain must be a valid DNS name");
  }
  const messageId = `<support.${notificationId}@${domain.toLowerCase()}>`;
  try {
    return validateOutboundMessageId(messageId, "generated Message-ID");
  } catch {
    throw new TypeError("generated Message-ID exceeds the safe header format");
  }
}

function at(epochMs: number): string {
  if (
    !Number.isFinite(epochMs) ||
    Math.abs(epochMs) > MAX_DATE_EPOCH_MILLISECONDS
  ) {
    throw new TypeError("delivery timestamp is outside the supported range");
  }
  return new Date(epochMs).toISOString();
}

function requireTimestamp(value: string): number {
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== value) {
    throw new TypeError("now must be a canonical ISO timestamp");
  }
  return epoch;
}

function positiveSafeInteger(
  value: number,
  field: string,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new TypeError(
      `${field} must be a positive safe integer no greater than ${maximum}`,
    );
  }
  return value;
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

function boundaryString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`${field} must be a string`);
  }
  return value;
}

function snapshotDeliveryWorkerOptions(
  input: DeliveryWorkerOptions,
): DeliveryWorkerOptions {
  const source = boundaryObject(input, "delivery worker options");
  const raw = {
    store: ownDataProperty(source, "store", "delivery worker options.store"),
    clock: ownDataProperty(source, "clock", "delivery worker options.clock"),
    delivery: ownDataProperty(
      source,
      "delivery",
      "delivery worker options.delivery",
    ),
    reconciliation: ownDataProperty(
      source,
      "reconciliation",
      "delivery worker options.reconciliation",
    ),
    templates: ownDataProperty(
      source,
      "templates",
      "delivery worker options.templates",
    ),
    workerId: ownDataProperty(
      source,
      "workerId",
      "delivery worker options.workerId",
    ),
    leaseMilliseconds: ownDataProperty(
      source,
      "leaseMilliseconds",
      "delivery worker options.leaseMilliseconds",
      true,
    ),
    baseRetryMilliseconds: ownDataProperty(
      source,
      "baseRetryMilliseconds",
      "delivery worker options.baseRetryMilliseconds",
      true,
    ),
    acceptedCallbackMilliseconds: ownDataProperty(
      source,
      "acceptedCallbackMilliseconds",
      "delivery worker options.acceptedCallbackMilliseconds",
      true,
    ),
    classifyFailure: ownDataProperty(
      source,
      "classifyFailure",
      "delivery worker options.classifyFailure",
      true,
    ),
  };
  for (const [field, value] of [
    ["leaseMilliseconds", raw.leaseMilliseconds],
    ["baseRetryMilliseconds", raw.baseRetryMilliseconds],
    ["acceptedCallbackMilliseconds", raw.acceptedCallbackMilliseconds],
  ] as const) {
    if (value !== undefined && typeof value !== "number") {
      throw new TypeError(`delivery worker options.${field} must be a number`);
    }
  }
  if (
    raw.classifyFailure !== undefined &&
    typeof raw.classifyFailure !== "function"
  ) {
    throw new TypeError(
      "delivery worker options.classifyFailure must be a function",
    );
  }
  const storeSource = boundaryObject(
    raw.store,
    "delivery worker options.store",
  );
  const collection = ownDataProperty(
    storeSource,
    "collection",
    "delivery worker options.store.collection",
  );
  if (typeof collection !== "function") {
    throw new TypeError(
      "delivery worker options.store.collection must be a function",
    );
  }
  const store: Store = Object.freeze({
    collection<T>(definition: CollectionDefinition<T>): CollectionStore<T> {
      return Reflect.apply(collection, storeSource, [
        definition,
      ]) as CollectionStore<T>;
    },
  });
  return Object.freeze({
    store,
    clock: raw.clock as Clock,
    delivery: raw.delivery as MailDeliveryPort,
    reconciliation: raw.reconciliation as MailReconciliationPort,
    templates: raw.templates as TemplateCatalog,
    workerId: boundaryString(raw.workerId, "delivery worker options.workerId"),
    ...(raw.leaseMilliseconds === undefined
      ? {}
      : { leaseMilliseconds: raw.leaseMilliseconds as number }),
    ...(raw.baseRetryMilliseconds === undefined
      ? {}
      : { baseRetryMilliseconds: raw.baseRetryMilliseconds as number }),
    ...(raw.acceptedCallbackMilliseconds === undefined
      ? {}
      : {
          acceptedCallbackMilliseconds:
            raw.acceptedCallbackMilliseconds as number,
        }),
    ...(raw.classifyFailure === undefined
      ? {}
      : { classifyFailure: raw.classifyFailure as FailureClassifier }),
  });
}

function snapshotDeliverJobInput(
  input: DeliverJobInput,
  field: string,
): DeliverJobInput {
  const source = boundaryObject(input, field);
  const raw = {
    ticketId: ownDataProperty(source, "ticketId", `${field}.ticketId`),
    deliveryJobId: ownDataProperty(
      source,
      "deliveryJobId",
      `${field}.deliveryJobId`,
    ),
    now: ownDataProperty(source, "now", `${field}.now`),
  };
  return Object.freeze({
    ticketId: boundaryString(raw.ticketId, `${field}.ticketId`),
    deliveryJobId: boundaryString(raw.deliveryJobId, `${field}.deliveryJobId`),
    now: boundaryString(raw.now, `${field}.now`),
  });
}

function snapshotDeliveryScanInput(input: DeliveryScanInput): {
  readonly now: string;
  readonly cursor?: string;
  readonly limit: number;
} {
  const source = boundaryObject(input, "delivery scan input");
  const raw = {
    now: ownDataProperty(source, "now", "delivery scan input.now"),
    cursor: ownDataProperty(
      source,
      "cursor",
      "delivery scan input.cursor",
      true,
    ),
    limit: ownDataProperty(source, "limit", "delivery scan input.limit", true),
  };
  if (raw.cursor !== undefined && typeof raw.cursor !== "string") {
    throw new TypeError("delivery scan input.cursor must be a string");
  }
  if (raw.limit !== undefined && typeof raw.limit !== "number") {
    throw new TypeError("delivery scan input.limit must be a number");
  }
  return Object.freeze({
    now: boundaryString(raw.now, "delivery scan input.now"),
    ...(raw.cursor === undefined ? {} : { cursor: raw.cursor }),
    limit: positiveSafeInteger(
      raw.limit ?? 100,
      "delivery scan input.limit",
      MAX_SCAN_PAGE_SIZE,
    ),
  });
}

function isEligibleSendJob(job: DeliveryJob, now: string): boolean {
  return (
    ((job.status === "pending" || job.status === "retrying") &&
      job.availableAt <= now) ||
    (job.status === "leased" &&
      job.leasePurpose === "send" &&
      job.leaseExpiresAt !== undefined &&
      job.leaseExpiresAt <= now)
  );
}

export function createDeliveryWorker(options: DeliveryWorkerOptions): {
  deliver(input: DeliverJobInput): Promise<DeliverJobResult>;
  reconcile(input: DeliverJobInput): Promise<ReconcileJobResult>;
  runPage(input: DeliveryScanInput): Promise<DeliveryScanPage>;
} {
  const worker = snapshotDeliveryWorkerOptions(options);
  const leaseMilliseconds = positiveSafeInteger(
    worker.leaseMilliseconds ?? 30_000,
    "leaseMilliseconds",
    MAX_LEASE_MILLISECONDS,
  );
  const baseRetryMilliseconds = positiveSafeInteger(
    worker.baseRetryMilliseconds ?? 1_000,
    "baseRetryMilliseconds",
    MAX_BASE_RETRY_MILLISECONDS,
  );
  const acceptedCallbackMilliseconds = positiveSafeInteger(
    worker.acceptedCallbackMilliseconds ?? 86_400_000,
    "acceptedCallbackMilliseconds",
    MAX_ACCEPTED_CALLBACK_MILLISECONDS,
  );
  const classifyFailure =
    worker.classifyFailure ?? (() => "provider_unavailable");

  function safeFailureCategory(error: unknown): string {
    try {
      const category = classifyFailure(error);
      return FAILURE_CATEGORY.test(category)
        ? category
        : "provider_unavailable";
    } catch {
      return "provider_unavailable";
    }
  }

  function trustedCompletionTime(
    claimEpoch: number,
    maximumOffset: number,
  ): {
    readonly value: string;
    readonly epoch: number;
  } {
    const value = worker.clock.now();
    const epoch = requireTimestamp(value);
    if (epoch < claimEpoch) {
      throw new TypeError(
        "trusted completion time must not precede claim time",
      );
    }
    if (epoch > MAX_DATE_EPOCH_MILLISECONDS - maximumOffset) {
      throw new TypeError(
        "trusted completion time is too late for the delivery schedule",
      );
    }
    return { value, epoch };
  }

  async function deliver(input: DeliverJobInput): Promise<DeliverJobResult> {
    const request = snapshotDeliverJobInput(input, "delivery input");
    const nowEpoch = requireTimestamp(request.now);
    if (
      nowEpoch >
      MAX_DATE_EPOCH_MILLISECONDS -
        Math.max(leaseMilliseconds, MAX_RETRY_DELAY_MILLISECONDS)
    ) {
      throw new TypeError(
        "now is too late to represent the bounded delivery schedule",
      );
    }
    const claimed = await claimDeliveryJob(worker.store, {
      ticketId: request.ticketId,
      deliveryJobId: request.deliveryJobId,
      workerId: worker.workerId,
      now: request.now,
      leaseExpiresAt: at(nowEpoch + leaseMilliseconds),
    });
    if (claimed === null) {
      return { status: "not_claimed" };
    }
    const claimedJob = claimed;
    const storedClaimToken = claimedJob.claimToken;
    if (storedClaimToken === undefined) {
      throw new TypeError("claimed delivery job has no fencing token");
    }
    const claimToken: string = storedClaimToken;

    const exponent = Math.min(Math.max(0, claimedJob.attemptCount), 19);
    const retryDelay = Math.min(
      MAX_RETRY_DELAY_MILLISECONDS,
      baseRetryMilliseconds * 2 ** exponent,
    );
    async function failClaim(
      failureCategory: string,
    ): Promise<DeliverJobResult> {
      const completed = trustedCompletionTime(nowEpoch, retryDelay);
      const job = await completeDeliveryAttempt(worker.store, {
        ticketId: claimedJob.ticketId,
        deliveryJobId: request.deliveryJobId,
        workerId: worker.workerId,
        claimToken,
        now: completed.value,
        outcome: {
          accepted: false,
          failureCategory,
          retryAt: at(completed.epoch + retryDelay),
        },
      });
      if (job === null) {
        return { status: "not_claimed" };
      }
      return {
        status: job.status === "dead_letter" ? "dead_letter" : "retrying",
        job,
      };
    }

    let sendResult: MailSendResult;
    try {
      let template: TemplateDefinition | null;
      try {
        template = worker.templates.get(
          claimed.templateId,
          claimed.templateVersion,
        );
      } catch {
        throw new DeliveryWorkError("template_catalog_failure");
      }
      if (template === null) {
        throw new DeliveryWorkError("template_not_found");
      }
      let rendered;
      try {
        rendered = renderTemplate(template, claimed.variables);
      } catch {
        throw new DeliveryWorkError("template_render_failure");
      }
      if (
        rendered.templateId !== claimed.templateId ||
        rendered.templateVersion !== claimed.templateVersion
      ) {
        throw new DeliveryWorkError("template_identity_mismatch");
      }
      sendResult = normalizeMailSendResult(
        await worker.delivery.send({
          idempotencyKey: claimed.idempotencyKey,
          mail: {
            recipientRef: claimed.recipientRef,
            subject: claimed.subject,
            messageId: claimed.outboundMessageId,
            plainText: rendered.plainText,
            html: rendered.html,
          },
        }),
      );
    } catch (error) {
      return failClaim(
        error instanceof DeliveryWorkError
          ? error.category
          : safeFailureCategory(error),
      );
    }

    const completed = trustedCompletionTime(
      nowEpoch,
      acceptedCallbackMilliseconds,
    );
    const job = await completeDeliveryAttempt(worker.store, {
      ticketId: claimed.ticketId,
      deliveryJobId: request.deliveryJobId,
      workerId: worker.workerId,
      claimToken,
      now: completed.value,
      outcome: {
        accepted: true,
        providerMessageRef: sendResult.providerMessageRef,
        acceptedDeadlineAt: at(completed.epoch + acceptedCallbackMilliseconds),
      },
    });
    return job === null
      ? { status: "not_claimed" }
      : { status: "accepted", job };
  }

  async function reconcile(
    input: DeliverJobInput,
  ): Promise<ReconcileJobResult> {
    const request = snapshotDeliverJobInput(input, "reconciliation input");
    const nowEpoch = requireTimestamp(request.now);
    if (
      nowEpoch >
      MAX_DATE_EPOCH_MILLISECONDS -
        Math.max(leaseMilliseconds, MAX_RETRY_DELAY_MILLISECONDS)
    ) {
      throw new TypeError(
        "now is too late to represent the bounded reconciliation schedule",
      );
    }
    const claimed = await claimAcceptedDeliveryJob(worker.store, {
      ticketId: request.ticketId,
      deliveryJobId: request.deliveryJobId,
      workerId: worker.workerId,
      now: request.now,
      leaseExpiresAt: at(nowEpoch + leaseMilliseconds),
    });
    if (claimed === null || claimed.claimToken === undefined) {
      return { status: "not_claimed" };
    }

    const exponent = Math.min(
      Math.max(0, claimed.reconciliationAttemptCount ?? 0),
      19,
    );
    const retryDelay = Math.min(
      MAX_RETRY_DELAY_MILLISECONDS,
      baseRetryMilliseconds * 2 ** exponent,
    );
    let outcome: MailReconciliationResult = { status: "unknown" };
    let transportFailure: string | undefined;
    let invalidProviderReference = false;
    let providerMessageRef: string | null = null;
    try {
      providerMessageRef = validateProviderMessageRef(
        claimed.providerMessageRef as string,
        "stored providerMessageRef",
      );
    } catch {
      invalidProviderReference = true;
    }
    if (providerMessageRef !== null) {
      let response: unknown;
      let receivedResponse = false;
      try {
        response = await worker.reconciliation.reconcile({
          idempotencyKey: claimed.idempotencyKey,
          providerMessageRef,
        });
        receivedResponse = true;
      } catch (error) {
        transportFailure = safeFailureCategory(error);
      }
      if (receivedResponse) {
        try {
          outcome = normalizeReconciliationResult(response);
        } catch {
          outcome = { status: "unknown" };
        }
      }
    }
    const completed = trustedCompletionTime(
      nowEpoch,
      transportFailure === undefined ? 0 : retryDelay,
    );
    const job = await completeDeliveryReconciliation(worker.store, {
      ticketId: claimed.ticketId,
      deliveryJobId: request.deliveryJobId,
      workerId: worker.workerId,
      claimToken: claimed.claimToken,
      now: completed.value,
      outcome: invalidProviderReference
        ? {
            status: "invalid",
            failureCategory: "provider_reference_invalid",
          }
        : transportFailure === undefined
          ? outcome
          : {
              status: "unavailable",
              failureCategory: transportFailure,
              retryAt: at(completed.epoch + retryDelay),
            },
    });
    if (job === null) {
      return { status: "not_claimed" };
    }
    return {
      status:
        job.status === "delivered"
          ? "delivered"
          : job.status === "dead_letter"
            ? "dead_letter"
            : job.status === "retrying" || job.status === "accepted"
              ? "retrying"
              : "terminal_unknown",
      job,
    };
  }

  return {
    deliver,
    reconcile,
    async runPage(input) {
      const request = snapshotDeliveryScanInput(input);
      requireTimestamp(request.now);
      const page = await worker.store.collection(supportRecords).scan({
        limit: request.limit,
        ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
      });
      const outcomes: DeliveryScanOutcome[] = [];
      for (const record of page.records) {
        if (
          record.value.kind !== "delivery_job" ||
          !record.key.id.startsWith("delivery:") ||
          !isEligibleSendJob(record.value, request.now)
        ) {
          continue;
        }
        const ticketId = record.key.partition;
        const deliveryJobId = record.key.id.slice("delivery:".length);
        if (ticketId.length === 0 || deliveryJobId.length === 0) {
          continue;
        }
        outcomes.push(
          Object.freeze({
            ticketId,
            deliveryJobId,
            result: await deliver({
              ticketId,
              deliveryJobId,
              now: request.now,
            }),
          }),
        );
      }
      return Object.freeze({
        outcomes: Object.freeze(outcomes),
        nextCursor: page.nextCursor,
      });
    },
  };
}
