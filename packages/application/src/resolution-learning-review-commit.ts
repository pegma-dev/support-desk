import { assertResolutionLearningReviewAttempt } from "./resolution-learning-staged-records.js";
import { hasPermission, type AccessContext } from "@pegma/authorization-core";
import {
  SupportDeskAuthorizationError,
  SupportDeskConflictError,
  SupportDeskLimitError,
  SupportDeskNotFoundError,
  supportPermissions,
  type SupportRecord,
} from "./index.js";
import {
  assertResolutionLearningRecord,
  maximumResolutionLearningSourceBytes,
  resolutionLearningReviewKey,
  resolutionLearningWorkKey,
  type ResolutionLearningReviewRecord,
  type ResolutionLearningSourceRecord,
  type ResolutionLearningWorkRecord,
} from "./resolution-learning-records.js";
import { encodedBytes, text, timestamp } from "./assistant-turn-records.js";
import {
  resolutionLearningReviewIdentity,
  readResolutionLearningReviewSlot,
  resolutionLearningReviewReceiptAction,
} from "./resolution-learning-review-identity.js";
import type {
  ResolutionLearningDependencies,
  SourceVersion,
  TicketVersion,
} from "./resolution-learning.js";
import type {
  ReviewResolutionLearningProposalCommand,
  ResolutionLearningSourceResult,
} from "./resolution-learning-types.js";
import type { ResolutionLearningReviewAttemptRecord } from "./resolution-learning-staged-records.js";
import type { ResolutionLearningStagedReviewGuard } from "./resolution-learning-staged-types.js";
type Loaded = {
  ticket: TicketVersion;
  source: SourceVersion;
  rows: readonly SupportRecord[];
};
function permission(access: AccessContext, _review: true): void {
  text(access.principalId, "principalId");
  for (const name of [
    supportPermissions.learningReview,
    supportPermissions.queueRead,
  ])
    if (!hasPermission(access, name))
      throw new SupportDeskAuthorizationError(name);
}
function current(loaded: Loaded, work: ResolutionLearningWorkRecord): boolean {
  return (
    loaded.source.value.state === "eligible" &&
    (loaded.ticket.value.ticket.status === "resolved" ||
      loaded.ticket.value.ticket.status === "closed") &&
    loaded.source.value.resolvedAt === loaded.ticket.value.ticket.resolvedAt &&
    loaded.source.value.sourceGeneration === work.sourceGeneration &&
    loaded.source.value.resolutionCycle === work.resolutionCycle &&
    loaded.source.value.sourceBindingHash === work.sourceBindingHash
  );
}
function checkRow(row: ResolutionLearningSourceRecord): void {
  if (
    encodedBytes(row) > 60_000 ||
    maximumResolutionLearningSourceBytes(row) > 60_000
  )
    throw new SupportDeskLimitError("serialized_record", 60_000);
  assertResolutionLearningRecord(row, { partition: row.partition, id: row.id });
}
export async function commitResolutionLearningReview(
  deps: ResolutionLearningDependencies,
  load: (ticketId: string) => Promise<Loaded>,
  access: AccessContext,
  input: ReviewResolutionLearningProposalCommand,
  guard: ResolutionLearningStagedReviewGuard,
  stage?: {
    readonly version: string;
    readonly value: ResolutionLearningReviewAttemptRecord;
    readonly ensure: () => void;
  },
): Promise<ResolutionLearningSourceResult> {
  const { records, clock, options } = deps;
  const reviewIdentity = resolutionLearningReviewIdentity;

  const workAt = async (key: {
    ticketId: string;
    sourceGeneration: number;
  }) => {
    const stored = await records.getVersioned(
      resolutionLearningWorkKey(key.ticketId, key.sourceGeneration),
    );
    if (stored?.value.kind !== "resolution_learning_work")
      throw new SupportDeskNotFoundError();
    return { value: stored.value, version: stored.version };
  };
  permission(access, true);
  if (typeof guard !== "function")
    throw new TypeError(
      "KB target review requires a read-only current-target guard",
    );
  const identity = await reviewIdentity(input, access.principalId);
  const { command, hash, key } = identity;
  const once = async (): Promise<ResolutionLearningSourceResult | null> => {
    const loaded = await load(command.ticketId);
    const work = await workAt(command);
    const slot = await readResolutionLearningReviewSlot(records, identity);
    const prior = slot.receipt;
    if (prior?.outcome === "accepted") return prior.result;
    if (prior?.outcome === "cancelled")
      throw new SupportDeskConflictError("Review command cancelled");
    let finalStage = stage;
    if (finalStage === undefined) {
      const pending = loaded.rows.find(
        (row) =>
          row.kind === "resolution_learning_review_attempt" &&
          row.command.commandId === command.commandId,
      );
      if (pending !== undefined) {
        const stored = await records.getVersioned({
          partition: command.ticketId,
          id: pending.id,
        });
        if (stored === null)
          throw new SupportDeskConflictError("Review attempt disappeared");
        assertResolutionLearningReviewAttempt(stored.value, {
          partition: command.ticketId,
          id: pending.id,
        });
        const original = stored.value;
        if (
          original.fingerprint !== hash ||
          original.reviewerId !== access.principalId
        )
          throw new SupportDeskConflictError("Review command reused");
        const { claim: _claim, leaseUntil: _lease, ...rest } = original;
        finalStage = {
          version: stored.version,
          value: { ...rest, state: "accepted", completionRows: 0 },
          ensure: () => {
            if (
              original.state !== "pending" ||
              timestamp(original.expiresAt, "expiresAt") <=
                timestamp(clock.now(), "now")
            )
              throw new SupportDeskConflictError(
                "Review attempt held or expired",
              );
          },
        };
      }
    }
    if ((finalStage === undefined) !== (slot.reservation === null))
      throw new SupportDeskConflictError(
        "Review canonical reservation/attempt is unavailable",
      );
    finalStage?.ensure();
    if (
      !current(loaded, work.value) ||
      work.value.workGeneration !== command.expectedWorkGeneration ||
      !loaded.source.value.destinations.some(
        (entry) => entry.articleId === command.target.articleId,
      )
    )
      throw new SupportDeskConflictError("Review source/work/target changed");
    const reviewKey = await resolutionLearningReviewKey(
      loaded.source.value,
      command.target,
      command.policyVersion,
    );
    const previousReview = await records.getVersioned(reviewKey);
    if (
      previousReview !== null &&
      previousReview.value.kind !== "resolution_learning_review"
    )
      throw new SupportDeskConflictError("Review binding key collision");
    if (
      previousReview === null &&
      loaded.source.value.reviewBindingCount >= options.maxReviewBindings
    )
      throw new SupportDeskLimitError(
        "ticket_partition",
        deps.limits.maxRecordsPerTicket,
      );
    deps.admission(
      loaded.ticket.value.ticket,
      finalStage === undefined
        ? loaded.rows
        : loaded.rows.map((row) =>
            row.id === finalStage.value.id ? finalStage.value : row,
          ),
      (previousReview === null ? 3 : 2) - (slot.reservation === null ? 0 : 1),
    );
    const now = clock.now();
    const review: ResolutionLearningReviewRecord = {
      kind: "resolution_learning_review",
      partition: command.ticketId,
      id: reviewKey.id,
      ticketId: command.ticketId,
      sourceGeneration: loaded.source.value.sourceGeneration,
      sourceBindingHash: loaded.source.value.sourceBindingHash!,
      target: command.target,
      decision: command.decision,
      policyVersion: command.policyVersion,
      reviewerId: access.principalId,
      reviewedAt: now,
      ...(command.reason === undefined ? {} : { reason: command.reason }),
    };
    assertResolutionLearningRecord(review, reviewKey);
    const source: ResolutionLearningSourceRecord = {
      ...loaded.source.value,
      workGeneration: loaded.source.value.workGeneration + 1,
      reviewBindingCount:
        loaded.source.value.reviewBindingCount +
        (previousReview === null ? 1 : 0),
    };
    checkRow(source);
    const outcome = {
      ticketId: source.ticketId,
      sourceGeneration: source.sourceGeneration,
      resolutionCycle: source.resolutionCycle,
      state: source.state,
    };
    const assertion = await guard();
    if (
      stage !== undefined &&
      assertion !== undefined &&
      (typeof assertion !== "function" || assertion() !== true)
    )
      throw new SupportDeskConflictError("Review guard refused commit");
    finalStage?.ensure();
    if (
      (
        await records.transact(command.ticketId, [
          {
            action: "putIfUnchanged",
            version: loaded.ticket.version,
            value: loaded.ticket.value,
          },
          {
            action: "putIfUnchanged",
            version: loaded.source.version,
            value: source,
          },
          {
            action: "putIfUnchanged",
            version: work.version,
            value: work.value,
          },
          ...(finalStage === undefined
            ? []
            : [
                {
                  action: "putIfUnchanged" as const,
                  version: finalStage.version,
                  value: finalStage.value,
                },
              ]),
          previousReview === null
            ? { action: "insert", value: review }
            : {
                action: "putIfUnchanged",
                version: previousReview.version,
                value: review,
              },
          deps.audit(
            command,
            loaded.ticket.value.ticket,
            access.principalId,
            now,
            "support.learning.reviewed",
          ),
          resolutionLearningReviewReceiptAction(slot, {
            kind: "resolution_learning_receipt",
            partition: command.ticketId,
            id: key.id,
            fingerprint: hash,
            result: outcome,
          }),
        ])
      ).committed
    )
      return outcome;
    return null;
  };
  // A staged delivery performs one transaction and yields any conflict to
  // a different physical invocation. Legacy inline retries retain their cap.
  if (stage !== undefined) {
    const result = await once();
    if (result !== null) return result;
  } else {
    for (let attempt = 0; attempt < deps.maxConflictAttempts; attempt += 1) {
      const result = await once();
      if (result !== null) return result;
    }
  }
  throw new SupportDeskConflictError();
}
