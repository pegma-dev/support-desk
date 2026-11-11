import { hasPermission, type AccessContext } from "@pegma/authorization-core";
import { MAX_SCAN_PAGE_SIZE, type VersionedRecord } from "@pegma/storage-core";
import {
  SupportDeskAuthorizationError,
  SupportDeskConflictError,
  SupportDeskLimitError,
  SupportDeskNotFoundError,
  supportPermissions,
  type SupportRecord,
} from "./index.js";
import {
  canonical,
  fields,
  fingerprint,
  integer,
  text,
  timestamp,
} from "./assistant-turn-records.js";
import {
  safeLearningSnapshot as snapshot,
  resolutionLearningWorkKey,
} from "./resolution-learning-records.js";
import {
  assertResolutionLearningReviewAttempt,
  maximumResolutionLearningReviewAttemptBytes,
  resolutionLearningReviewAttemptKey,
  validateStagedReviewFence,
  validateStagedReviewIntent,
  validateStagedReviewProof,
  type ResolutionLearningReviewAttemptRecord,
} from "./resolution-learning-staged-records.js";
import {
  resolutionLearningReviewIdentity,
  requireResolutionLearningReviewTicket,
  observeResolutionLearningReview,
  type ResolutionLearningReviewIdentity,
} from "./resolution-learning-review-identity.js";
import { commitResolutionLearningReview } from "./resolution-learning-review-commit.js";
import type {
  ResolutionLearningDependencies,
  SourceVersion,
  TicketVersion,
} from "./resolution-learning.js";
import type {
  ResolutionLearningStagedReviewApplication,
  ResolutionLearningStagedReviewFence,
  ResolutionLearningStagedReviewGuard,
  ResolutionLearningStagedReviewHint,
  ResolutionLearningStagedReviewStatus,
} from "./resolution-learning-staged-types.js";

type Attempt = VersionedRecord<ResolutionLearningReviewAttemptRecord>;
type Loaded = {
  ticket: TicketVersion;
  source: SourceVersion;
  rows: readonly SupportRecord[];
};
function permission(access: AccessContext, process = false): void {
  text(access.principalId, "principalId");
  const names = process
    ? [supportPermissions.learningProcess]
    : [supportPermissions.learningReview, supportPermissions.queueRead];
  for (const name of names)
    if (!hasPermission(access, name))
      throw new SupportDeskAuthorizationError(name);
}
function unclaim(
  row: ResolutionLearningReviewAttemptRecord,
): ResolutionLearningReviewAttemptRecord {
  const { claim: _claim, leaseUntil: _lease, ...rest } = row;
  return rest;
}
function check(row: ResolutionLearningReviewAttemptRecord): void {
  assertResolutionLearningReviewAttempt(row, {
    partition: row.partition,
    id: row.id,
  });
  if (maximumResolutionLearningReviewAttemptBytes(row) > 60_000)
    throw new SupportDeskLimitError("serialized_record", 60_000);
}
function guardRequired(guard: ResolutionLearningStagedReviewGuard): void {
  if (typeof guard !== "function")
    throw new TypeError(
      "Staged review requires a current-authority proof guard",
    );
}
async function checkedGuard(
  guard: ResolutionLearningStagedReviewGuard,
): Promise<() => void> {
  const assertion = await guard();
  return () => {
    if (
      assertion !== undefined &&
      (typeof assertion !== "function" || assertion() !== true)
    )
      throw new SupportDeskConflictError("Review guard refused commit");
  };
}
/** Every mutation performs one conditional transaction; uncertain/conflict callers resume in another invocation. */
export function createResolutionLearningStagedReviewServices(
  deps: ResolutionLearningDependencies,
  load: (ticketId: string) => Promise<Loaded>,
): ResolutionLearningStagedReviewApplication {
  const { records, clock, options } = deps;
  const now = () => timestamp(clock.now(), "now");
  async function at(
    ticketId: string,
    commandId: string,
  ): Promise<Attempt | null> {
    const value = await records.getVersioned(
      resolutionLearningReviewAttemptKey(ticketId, commandId),
    );
    if (value === null) return null;
    assertResolutionLearningReviewAttempt(value.value, {
      partition: ticketId,
      id: resolutionLearningReviewAttemptKey(ticketId, commandId).id,
    });
    return { value: value.value, version: value.version };
  }
  function owner(
    access: AccessContext,
    row: ResolutionLearningReviewAttemptRecord,
  ): void {
    if (access.principalId !== row.reviewerId)
      throw new SupportDeskAuthorizationError(
        supportPermissions.learningReview,
      );
  }
  function exact(
    identity: ResolutionLearningReviewIdentity,
    row: ResolutionLearningReviewAttemptRecord,
  ): void {
    if (identity.hash !== row.fingerprint)
      throw new SupportDeskConflictError("Review command reused");
  }
  function pending(
    row: ResolutionLearningReviewAttemptRecord,
  ): ResolutionLearningStagedReviewStatus {
    return snapshot({
      outcome: "pending" as const,
      ticketId: row.ticketId,
      commandId: row.command.commandId,
      phase: row.phase,
      claimed:
        row.claim !== undefined &&
        timestamp(row.leaseUntil, "leaseUntil") > now(),
      held:
        row.state === "held" || timestamp(row.expiresAt, "expiresAt") <= now(),
      expiresAt: row.expiresAt,
    });
  }
  function hint(
    row: ResolutionLearningReviewAttemptRecord,
  ): ResolutionLearningStagedReviewHint | null {
    if (row.state === "accepted" || row.state === "cancelled") return null;
    return snapshot({
      ticketId: row.ticketId,
      commandId: row.command.commandId,
      reviewerId: row.reviewerId,
      phase: row.phase,
      expiresAt: row.expiresAt,
      ...(row.leaseUntil === undefined ? {} : { leaseUntil: row.leaseUntil }),
      held:
        row.state === "held" || timestamp(row.expiresAt, "expiresAt") <= now(),
    });
  }
  function live(
    row: ResolutionLearningReviewAttemptRecord,
    fence: ResolutionLearningStagedReviewFence,
    phase: "proof" | "commit",
  ): void {
    validateStagedReviewFence(fence);
    if (
      row.state !== "pending" ||
      row.phase !== phase ||
      row.claim === undefined ||
      row.leaseUntil === undefined ||
      canonical(row.claim) !== canonical(fence) ||
      timestamp(row.leaseUntil, "leaseUntil") <= now() ||
      timestamp(row.expiresAt, "expiresAt") <= now() ||
      (phase === "commit" &&
        (row.proof === undefined ||
          timestamp(row.proof.validUntil, "proof.validUntil") <= now()))
    )
      throw new SupportDeskConflictError(
        "Review claim or proof expired/changed",
      );
  }
  async function retainedIdentity(
    row: ResolutionLearningReviewAttemptRecord,
  ): Promise<ResolutionLearningReviewIdentity> {
    const identity = await resolutionLearningReviewIdentity(
      row.command,
      row.reviewerId,
    );
    if (row.state === "pending" && identity.hash !== row.fingerprint)
      throw new SupportDeskConflictError("Review attempt fingerprint differs");
    // Privacy withdrawal may scrub reason text. Recovery uses its original
    // retained fingerprint, never a new mutation reconstructed from redacted data.
    return {
      ...identity,
      hash: row.fingerprint,
      cancellationHash: await fingerprint({
        operation: "cancel_resolution_learning_review",
        reviewFingerprint: row.fingerprint,
      }),
    };
  }
  async function terminal(identity: ResolutionLearningReviewIdentity) {
    await requireResolutionLearningReviewTicket(records, identity);
    return observeResolutionLearningReview(records, identity);
  }
  async function currentWork(
    loaded: Loaded,
    row: ResolutionLearningReviewAttemptRecord,
  ) {
    const work = await records.getVersioned(
      resolutionLearningWorkKey(row.ticketId, row.command.sourceGeneration),
    );
    if (
      work?.value.kind !== "resolution_learning_work" ||
      loaded.source.value.state !== "eligible" ||
      !["resolved", "closed"].includes(loaded.ticket.value.ticket.status) ||
      loaded.ticket.value.ticket.resolvedAt !==
        loaded.source.value.resolvedAt ||
      loaded.source.value.sourceGeneration !== row.command.sourceGeneration ||
      loaded.source.value.resolutionCycle !== work.value.resolutionCycle ||
      loaded.source.value.sourceBindingHash !== work.value.sourceBindingHash ||
      work.value.workGeneration !== row.command.expectedWorkGeneration ||
      !loaded.source.value.destinations.some(
        (entry) => entry.articleId === row.command.target.articleId,
      )
    )
      throw new SupportDeskConflictError("Review source/work/target changed");
    return work;
  }
  return {
    async admit(access, input, rawIntent, guard) {
      permission(access);
      guardRequired(guard);
      const identity = await resolutionLearningReviewIdentity(
        input,
        access.principalId,
      );
      const intent = snapshot(rawIntent);
      validateStagedReviewIntent(intent);
      if (
        intent.reviewerId !== access.principalId ||
        intent.ticketId !== identity.command.ticketId ||
        intent.sourceGeneration !== identity.command.sourceGeneration ||
        intent.expectedWorkGeneration !==
          identity.command.expectedWorkGeneration ||
        intent.policy.version !== identity.command.policyVersion ||
        canonical(intent.target) !== canonical(identity.command.target) ||
        identity.command.intentBinding !== (await fingerprint(intent))
      )
        throw new SupportDeskConflictError(
          "Review intent differs from command",
        );
      const prior = await terminal(identity);
      if (prior !== null) return prior;
      const previous = await at(
        identity.command.ticketId,
        identity.command.commandId,
      );
      if (previous !== null) {
        owner(access, previous.value);
        exact(identity, previous.value);
        return pending(previous.value);
      }
      const row: ResolutionLearningReviewAttemptRecord = {
        kind: "resolution_learning_review_attempt",
        partition: identity.command.ticketId,
        id: resolutionLearningReviewAttemptKey(
          identity.command.ticketId,
          identity.command.commandId,
        ).id,
        ticketId: identity.command.ticketId,
        reviewerId: access.principalId,
        command: identity.command,
        intent,
        fingerprint: identity.hash,
        state: "pending",
        phase: "proof",
        claimGeneration: 0,
        completionRows: 3,
        createdAt: clock.now(),
        expiresAt: intent.policy.validUntil,
      };
      check(row);
      const loaded = await load(row.ticketId);
      if (
        loaded.rows.filter(
          (value) => value.kind === "resolution_learning_review_attempt",
        ).length >= options.maxStagedReviewAttempts
      )
        throw new SupportDeskLimitError(
          "staged_review_attempts",
          options.maxStagedReviewAttempts,
        );
      const work = await currentWork(loaded, row);
      // Admission creates an attempt and Audit; reserve the later review/Audit/receipt too.
      deps.admission(loaded.ticket.value.ticket, loaded.rows, 5);
      const assert = await checkedGuard(guard);
      if (
        timestamp(intent.policy.verifiedAt, "verifiedAt") > now() ||
        timestamp(row.expiresAt, "expiresAt") <= now()
      )
        throw new SupportDeskConflictError("Review intent expired");
      assert();
      if (
        !(
          await records.transact(row.ticketId, [
            {
              action: "putIfUnchanged",
              version: loaded.ticket.version,
              value: loaded.ticket.value,
            },
            {
              action: "putIfUnchanged",
              version: loaded.source.version,
              value: loaded.source.value,
            },
            {
              action: "putIfUnchanged",
              version: work.version,
              value: work.value,
            },
            { action: "insert", value: row },
            deps.audit(
              identity.command,
              loaded.ticket.value.ticket,
              access.principalId,
              row.createdAt,
              "support.learning.review_requested",
              "\u0000support.learning.review.requested:" +
                identity.command.commandId,
            ),
          ])
        ).committed
      )
        throw new SupportDeskConflictError();
      return pending(row);
    },
    async readStatus(access, input) {
      permission(access);
      const identity = await resolutionLearningReviewIdentity(
        input,
        access.principalId,
      );
      const prior = await terminal(identity);
      if (prior !== null) return prior;
      const stored = await at(
        identity.command.ticketId,
        identity.command.commandId,
      );
      if (stored === null) return null;
      owner(access, stored.value);
      exact(identity, stored.value);
      if (
        stored.value.state === "accepted" ||
        stored.value.state === "cancelled"
      )
        throw new SupportDeskConflictError(
          "Terminal review receipt is unavailable",
        );
      return pending(stored.value);
    },
    async readPending(access, key) {
      permission(access, true);
      const value = fields(key, "review key", ["ticketId", "commandId"]);
      const stored = await at(
        value.ticketId as string,
        value.commandId as string,
      );
      return stored === null ? null : hint(stored.value);
    },
    async scanPending(access, input) {
      permission(access, true);
      const bounds = fields(input, "review scan", ["limit"], ["cursor"]);
      integer(bounds.limit, "limit", 1, MAX_SCAN_PAGE_SIZE);
      if (bounds.cursor !== undefined) text(bounds.cursor, "cursor", 20_000);
      const page = await records.scan({
        limit: bounds.limit as number,
        ...(bounds.cursor === undefined
          ? {}
          : { cursor: bounds.cursor as string }),
      });
      const candidates: ResolutionLearningStagedReviewHint[] = [];
      for (const entry of page.records) {
        if (entry.value.kind !== "resolution_learning_review_attempt") continue;
        assertResolutionLearningReviewAttempt(entry.value, entry.key);
        const value = hint(entry.value);
        if (
          value !== null &&
          !value.held &&
          (value.leaseUntil === undefined ||
            timestamp(value.leaseUntil, "leaseUntil") <= now())
        )
          candidates.push(value);
      }
      return {
        candidates,
        nextCursor: page.nextCursor,
        physicalRows: page.records.length,
        pages: 1,
      };
    },
    async claim(access, input) {
      permission(access);
      const command = snapshot(
        fields(input, "claim review", [
          "ticketId",
          "commandId",
          "workerId",
          "claimId",
          "leaseMilliseconds",
        ]),
      );
      for (const name of ["ticketId", "commandId", "workerId", "claimId"])
        text(command[name], name);
      const duration = integer(
        command.leaseMilliseconds,
        "leaseMilliseconds",
        1,
        options.maxLeaseMilliseconds,
      );
      const stored = await at(
        command.ticketId as string,
        command.commandId as string,
      );
      if (stored === null) return null;
      const row = stored.value;
      owner(access, row);
      const identity = await retainedIdentity(row);
      if ((await terminal(identity)) !== null) return null;
      if (
        row.state !== "pending" ||
        timestamp(row.expiresAt, "expiresAt") <= now() ||
        (row.phase === "commit" &&
          (row.proof === undefined ||
            timestamp(row.proof.validUntil, "proof.validUntil") <= now()))
      )
        return null;
      const result = (value: ResolutionLearningReviewAttemptRecord) =>
        snapshot({
          fence: value.claim!,
          reviewerId: value.reviewerId,
          command: value.command,
          intent: value.intent,
          phase: value.phase,
          leaseUntil: value.leaseUntil!,
          expiresAt: value.expiresAt,
          ...(value.proof === undefined ? {} : { proof: value.proof }),
        });
      if (
        row.claim !== undefined &&
        timestamp(row.leaseUntil, "leaseUntil") > now()
      )
        return row.claim.workerId === command.workerId &&
          row.claim.claimId === command.claimId
          ? result(row)
          : null;
      const fence: ResolutionLearningStagedReviewFence = {
        ticketId: row.ticketId,
        commandId: row.command.commandId,
        workerId: command.workerId as string,
        claimId: command.claimId as string,
        claimGeneration: integer(row.claimGeneration + 1, "claimGeneration", 1),
      };
      const next: ResolutionLearningReviewAttemptRecord = {
        ...row,
        claimGeneration: fence.claimGeneration,
        claim: fence,
        leaseUntil: new Date(
          Math.min(
            now() + duration,
            timestamp(row.expiresAt, "expiresAt"),
            row.proof === undefined
              ? Infinity
              : timestamp(row.proof.validUntil, "proof.validUntil"),
          ),
        ).toISOString(),
      };
      check(next);
      if (
        !(
          await records.transact(row.ticketId, [
            { action: "putIfUnchanged", version: stored.version, value: next },
          ])
        ).committed
      )
        throw new SupportDeskConflictError();
      return result(next);
    },
    async prepare(access, input, guard) {
      permission(access);
      guardRequired(guard);
      const command = snapshot(
        fields(input, "prepare review", ["fence", "proof"]),
      );
      validateStagedReviewFence(command.fence);
      validateStagedReviewProof(command.proof);
      const fence = command.fence;
      const proof = command.proof;
      const stored = await at(fence.ticketId, fence.commandId);
      if (stored === null) throw new SupportDeskNotFoundError();
      const row = stored.value;
      owner(access, row);
      const identity = await retainedIdentity(row);
      const prior = await terminal(identity);
      if (prior !== null) return prior;
      live(row, fence, "proof");
      if (
        timestamp(proof.validUntil, "proof.validUntil") >
        timestamp(row.expiresAt, "expiresAt")
      )
        throw new SupportDeskConflictError("P1 proof exceeds original intent");
      const loaded = await load(row.ticketId);
      const work = await currentWork(loaded, row);
      const next: ResolutionLearningReviewAttemptRecord = {
        ...unclaim(row),
        phase: "commit",
        proof,
      };
      check(next);
      const assert = await checkedGuard(guard);
      live(row, fence, "proof");
      if (timestamp(proof.validUntil, "proof.validUntil") <= now())
        throw new SupportDeskConflictError("P1 proof expired");
      assert();
      if (
        !(
          await records.transact(row.ticketId, [
            {
              action: "putIfUnchanged",
              version: loaded.ticket.version,
              value: loaded.ticket.value,
            },
            {
              action: "putIfUnchanged",
              version: loaded.source.version,
              value: loaded.source.value,
            },
            {
              action: "putIfUnchanged",
              version: work.version,
              value: work.value,
            },
            { action: "putIfUnchanged", version: stored.version, value: next },
          ])
        ).committed
      )
        throw new SupportDeskConflictError();
      return pending(next);
    },
    async complete(access, rawFence, guard) {
      permission(access);
      guardRequired(guard);
      const fence = snapshot(rawFence);
      validateStagedReviewFence(fence);
      const stored = await at(fence.ticketId, fence.commandId);
      if (stored === null) throw new SupportDeskNotFoundError();
      const row = stored.value;
      owner(access, row);
      const identity = await retainedIdentity(row);
      const prior = await terminal(identity);
      if (prior !== null) return prior;
      const next: ResolutionLearningReviewAttemptRecord = {
        ...unclaim(row),
        state: "accepted",
        completionRows: 0,
      };
      check(next);
      const result = await commitResolutionLearningReview(
        deps,
        load,
        access,
        row.command,
        guard,
        {
          version: stored.version,
          value: next,
          ensure: () => live(row, fence, "commit"),
        },
      );
      return { outcome: "accepted", result };
    },
    async cancel(access, input, guard) {
      permission(access);
      guardRequired(guard);
      const identity = await resolutionLearningReviewIdentity(
        input,
        access.principalId,
      );
      const prior = await terminal(identity);
      if (prior !== null) {
        (await checkedGuard(guard))();
        return prior;
      }
      const stored = await at(
        identity.command.ticketId,
        identity.command.commandId,
      );
      if (stored !== null) {
        owner(access, stored.value);
        exact(identity, stored.value);
      }
      const loaded = await load(identity.command.ticketId);
      const next: ResolutionLearningReviewAttemptRecord | undefined =
        stored === null
          ? undefined
          : { ...unclaim(stored.value), state: "cancelled", completionRows: 0 };
      if (next !== undefined) check(next);
      deps.admission(
        loaded.ticket.value.ticket,
        next === undefined
          ? loaded.rows
          : loaded.rows.map((row) => (row.id === next.id ? next : row)),
        2,
      );
      const result = {
        ticketId: loaded.source.value.ticketId,
        sourceGeneration: loaded.source.value.sourceGeneration,
        resolutionCycle: loaded.source.value.resolutionCycle,
        state: loaded.source.value.state,
      };
      const audit = deps.audit(
        identity.command,
        loaded.ticket.value.ticket,
        access.principalId,
        clock.now(),
        "support.learning.review_cancelled",
      );
      const assert = await checkedGuard(guard);
      assert();
      if (
        !(
          await records.transact(identity.command.ticketId, [
            {
              action: "putIfUnchanged",
              version: loaded.ticket.version,
              value: loaded.ticket.value,
            },
            ...(stored === null || next === undefined
              ? []
              : [
                  {
                    action: "putIfUnchanged" as const,
                    version: stored.version,
                    value: next,
                  },
                ]),
            audit,
            {
              action: "insert",
              value: {
                kind: "resolution_learning_receipt",
                partition: identity.command.ticketId,
                id: identity.key.id,
                fingerprint: identity.cancellationHash,
                result,
              },
            },
          ])
        ).committed
      )
        throw new SupportDeskConflictError();
      (await checkedGuard(guard))();
      return {
        outcome: "cancelled",
        ticketId: identity.command.ticketId,
        commandId: identity.command.commandId,
      };
    },
  };
}
