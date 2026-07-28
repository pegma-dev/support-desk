import type { Store } from "@pegma/storage-core";
import type { Clock } from "@pegma/spine";
import {
  claimAcceptedDeliveryJob,
  claimDeliveryJob,
  completeDeliveryAttempt,
  completeDeliveryReconciliation,
  type DeliveryCallbackInput,
  type DeliveryJob,
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
  /**
   * Durable host-owned discovery of pending candidates. Storage Core cannot
   * enumerate collection partitions; this seam is intentionally external.
   * Candidates are hints and may repeat because claiming is authoritative.
   */
  readonly candidates: DeliveryCandidateSource;
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

export interface DeliveryCandidate {
  readonly ticketId: string;
  readonly deliveryJobId: string;
}

export interface DeliveryCandidateSource {
  next(now: string): Promise<DeliveryCandidate | null>;
}

export type DeliverJobResult =
  | { readonly status: "not_claimed" }
  | { readonly status: "accepted"; readonly job: DeliveryJob }
  | {
      readonly status: "retrying" | "dead_letter";
      readonly job: DeliveryJob;
    };

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
  const providerMessageRef = descriptor.value;
  if (
    providerMessageRef.trim().length === 0 ||
    providerMessageRef.length > 512 ||
    HEADER_CONTROL.test(providerMessageRef)
  ) {
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
  if (messageId.length > 254 || !/^<[^<>\s@]+@[^<>\s@]+>$/.test(messageId)) {
    throw new TypeError("generated Message-ID exceeds the safe header format");
  }
  return messageId;
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

export function createDeliveryWorker(options: DeliveryWorkerOptions): {
  deliver(input: DeliverJobInput): Promise<DeliverJobResult>;
  reconcile(input: DeliverJobInput): Promise<ReconcileJobResult>;
  runOnce(now: string): Promise<DeliverJobResult | null>;
} {
  const leaseMilliseconds = positiveSafeInteger(
    options.leaseMilliseconds ?? 30_000,
    "leaseMilliseconds",
    MAX_LEASE_MILLISECONDS,
  );
  const baseRetryMilliseconds = positiveSafeInteger(
    options.baseRetryMilliseconds ?? 1_000,
    "baseRetryMilliseconds",
    MAX_BASE_RETRY_MILLISECONDS,
  );
  const acceptedCallbackMilliseconds = positiveSafeInteger(
    options.acceptedCallbackMilliseconds ?? 86_400_000,
    "acceptedCallbackMilliseconds",
    MAX_ACCEPTED_CALLBACK_MILLISECONDS,
  );
  const classifyFailure =
    options.classifyFailure ?? (() => "provider_unavailable");

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
    const value = options.clock.now();
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
    const nowEpoch = requireTimestamp(input.now);
    if (
      nowEpoch >
      MAX_DATE_EPOCH_MILLISECONDS -
        Math.max(leaseMilliseconds, MAX_RETRY_DELAY_MILLISECONDS)
    ) {
      throw new TypeError(
        "now is too late to represent the bounded delivery schedule",
      );
    }
    const claimed = await claimDeliveryJob(options.store, {
      ticketId: input.ticketId,
      deliveryJobId: input.deliveryJobId,
      workerId: options.workerId,
      now: input.now,
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
      const job = await completeDeliveryAttempt(options.store, {
        ticketId: claimedJob.ticketId,
        deliveryJobId: input.deliveryJobId,
        workerId: options.workerId,
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
        template = options.templates.get(
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
      sendResult = normalizeMailSendResult(
        await options.delivery.send({
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
    const job = await completeDeliveryAttempt(options.store, {
      ticketId: claimed.ticketId,
      deliveryJobId: input.deliveryJobId,
      workerId: options.workerId,
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
    const nowEpoch = requireTimestamp(input.now);
    const claimed = await claimAcceptedDeliveryJob(options.store, {
      ticketId: input.ticketId,
      deliveryJobId: input.deliveryJobId,
      workerId: options.workerId,
      now: input.now,
      leaseExpiresAt: at(nowEpoch + leaseMilliseconds),
    });
    if (
      claimed === null ||
      claimed.claimToken === undefined ||
      claimed.providerMessageRef === undefined
    ) {
      return { status: "not_claimed" };
    }

    let outcome: MailReconciliationResult;
    try {
      outcome = normalizeReconciliationResult(
        await options.reconciliation.reconcile({
          idempotencyKey: claimed.idempotencyKey,
          providerMessageRef: claimed.providerMessageRef,
        }),
      );
    } catch {
      outcome = { status: "unknown" };
    }
    const completed = trustedCompletionTime(nowEpoch, 0);
    const job = await completeDeliveryReconciliation(options.store, {
      ticketId: claimed.ticketId,
      deliveryJobId: input.deliveryJobId,
      workerId: options.workerId,
      claimToken: claimed.claimToken,
      now: completed.value,
      outcome,
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
            : job.status === "retrying"
              ? "retrying"
              : "terminal_unknown",
      job,
    };
  }

  return {
    deliver,
    reconcile,
    async runOnce(now) {
      requireTimestamp(now);
      const candidate = await options.candidates.next(now);
      return candidate === null ? null : deliver({ ...candidate, now });
    },
  };
}
