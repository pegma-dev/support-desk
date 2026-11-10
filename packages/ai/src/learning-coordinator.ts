import { hasPermission, type AccessContext } from "@pegma/authorization-core";
import type {
  LearningProcessResult,
  LearningReviewCancellationOptions,
  LearningReviewCommand,
  LearningReviewPreparation,
  LearningRunOptions,
  LearningScanBounds,
  ProcessLearningWorkCommand,
  SupportDeskLearning,
  SupportDeskLearningOptions,
} from "./learning-integration-types.js";
import {
  SupportDeskAuthorizationError,
  supportPermissions,
  type ResolutionLearningClaim,
  type ResolutionLearningKey,
  type ResolutionLearningSourceResult,
  type ReviewResolutionLearningProposalCommand,
} from "@pegma/support-desk-application";
import {
  AssistantBoundaryError,
  canonical,
  count,
  exactKeys,
  fingerprint,
  scalar,
  snapshot,
  timestamp,
} from "./boundary.js";
import {
  learningSourceFence,
  learningSourceReference,
  learningTargetBinding,
} from "./learning-bindings.js";
import {
  confirmLearningKBCurrent,
  processLearningKBClaim,
  readLearningKBTarget,
} from "./learning-kb.js";
import { createLearningModelExecutor } from "./learning-model.js";
import {
  learningAuthoritySnapshot,
  learningCheckPolicySnapshot,
} from "./learning-request.js";
import { createLearningReconciler } from "./learning-retirement.js";
import {
  createLearningRuntime,
  learningServiceAuthority,
} from "./learning-runtime.js";

import type { VerifiedLearningCheckPolicy } from "./learning-ports.js";

class LearningReviewGuardFailure extends AssistantBoundaryError {}

/** Optional composition: the application remains the durable source authority. */
export function createSupportDeskLearning(
  options: SupportDeskLearningOptions,
): SupportDeskLearning {
  const attempts = count(options.storageCommandAttempts ?? 2, 3, 1);
  count(options.maxPublishedMatches ?? 5, 5, 1);
  count(options.maxExplicitDrafts ?? 5, 5);
  const model = createLearningModelExecutor({
    ...options,
    checkPolicy: options.checks,
  });
  const reconcileSource = createLearningReconciler(options);
  function reviewAuthority(access: AccessContext): AccessContext {
    const staff = learningAuthoritySnapshot({
      access,
      authorityVersion: "staff-review",
      usageScopeRef: "staff-review",
    }).access;
    for (const name of [
      supportPermissions.learningReview,
      supportPermissions.queueRead,
    ])
      if (!hasPermission(staff, name))
        throw new SupportDeskAuthorizationError(name);
    return staff;
  }
  async function reviewCommand(
    access: AccessContext,
    input: LearningReviewCommand,
  ) {
    const packet = snapshot(input);
    exactKeys(packet, [
      "intent",
      "commandId",
      "correlationId",
      "decision",
      ...(packet.reason === undefined ? [] : ["reason"]),
    ]);
    const intent = packet.intent;
    exactKeys(intent, [
      "reviewerId",
      "ticketId",
      "sourceGeneration",
      "expectedWorkGeneration",
      "target",
      "policy",
    ]);
    scalar(intent.reviewerId);
    if (intent.reviewerId !== access.principalId)
      throw new AssistantBoundaryError("authority_changed");
    exactKeys(intent.policy, [
      "version",
      "binding",
      "verifiedAt",
      "validUntil",
    ]);
    scalar(intent.policy.version);
    scalar(intent.policy.binding);
    timestamp(intent.policy.verifiedAt);
    timestamp(intent.policy.validUntil);
    // Expired historical proofs may still recover a receipt or be cancelled.
    // Only a new submission must satisfy current policy and KB/source checks.
    const command: ReviewResolutionLearningProposalCommand = {
      ticketId: intent.ticketId,
      sourceGeneration: intent.sourceGeneration,
      expectedWorkGeneration: intent.expectedWorkGeneration,
      target: intent.target,
      policyVersion: intent.policy.version,
      intentBinding: await fingerprint(intent),
      commandId: packet.commandId,
      correlationId: packet.correlationId,
      decision: packet.decision,
      ...(packet.reason === undefined ? {} : { reason: packet.reason }),
    };
    return { command, policy: intent.policy };
  }
  async function reviewProposal(
    access: AccessContext,
    input: ReviewResolutionLearningProposalCommand,
    runOptions: LearningRunOptions = {},
    expectedPolicy?: VerifiedLearningCheckPolicy,
  ): Promise<ResolutionLearningSourceResult> {
    const runtime = createLearningRuntime(options, runOptions);
    try {
      const staff = reviewAuthority(access);
      const command = snapshot(input);
      const prior = await runtime.within(() =>
        options.application.readResolutionLearningReviewReceipt(staff, command),
      );
      if (prior?.outcome === "accepted") return prior.result;
      if (prior?.outcome === "cancelled")
        throw new AssistantBoundaryError("review_cancelled");
      const service = await learningServiceAuthority(options, runtime);
      const source = await runtime.within(() =>
        options.application.readResolutionLearningSource(
          service.access,
          command.ticketId,
        ),
      );
      const sourceFence = learningSourceFence(source);
      if (sourceFence.sourceGeneration !== command.sourceGeneration)
        throw new AssistantBoundaryError("source_changed");
      const own = learningSourceReference(source);
      const policyResult = await runtime.within(() =>
        options.checks.resolvePolicy(command.policyVersion, runtime.signal),
      );
      if (policyResult.outcome !== "ready")
        throw new AssistantBoundaryError("check_policy_unavailable");
      const policy = learningCheckPolicySnapshot(
        policyResult.policy,
        timestamp(options.clock.now()),
      );
      if (
        expectedPolicy !== undefined &&
        canonical(policy) !== canonical(expectedPolicy)
      )
        throw new AssistantBoundaryError("check_policy_changed");
      if (policy.version !== command.policyVersion)
        throw new AssistantBoundaryError("check_policy_changed");
      const deadline = Math.min(runtime.deadline, timestamp(policy.validUntil));
      const verifyTarget = async (): Promise<void> => {
        const currentService = await learningServiceAuthority(
          options,
          runtime,
          deadline,
        );
        if (canonical(currentService) !== canonical(service))
          throw new AssistantBoundaryError("authority_changed");
        const actual = await readLearningKBTarget(
          options,
          staff,
          command.target.articleId,
          runtime,
          deadline,
        );
        if (
          canonical(
            await learningTargetBinding(
              actual.draft.revision,
              actual.provenance.snapshot,
            ),
          ) !== canonical(command.target) ||
          !actual.provenance.snapshot.references.some(
            (reference) => canonical(reference) === canonical(own),
          )
        )
          throw new AssistantBoundaryError("target_changed");
        await confirmLearningKBCurrent(
          options,
          staff,
          actual,
          runtime,
          deadline,
        );
        if (
          (await runtime.within(
            () =>
              options.application.confirmResolutionLearningSource(
                currentService.access,
                sourceFence,
              ),
            deadline,
          )) !== true
        )
          throw new AssistantBoundaryError("source_changed");
        const currentPolicy = await runtime.within(
          () =>
            options.checks.resolvePolicy(command.policyVersion, runtime.signal),
          deadline,
        );
        if (
          currentPolicy.outcome !== "ready" ||
          canonical(
            learningCheckPolicySnapshot(
              currentPolicy.policy,
              timestamp(options.clock.now()),
            ),
          ) !== canonical(policy)
        )
          throw new AssistantBoundaryError("check_policy_changed");
        runtime.ensure(deadline);
      };
      await verifyTarget();
      const guard = async (): Promise<void> => {
        try {
          await verifyTarget();
        } catch (error) {
          throw new LearningReviewGuardFailure(
            error instanceof AssistantBoundaryError
              ? error.category
              : "verification_unavailable",
          );
        }
      };
      let uncertain = false;
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        try {
          return await runtime.within(
            () =>
              options.application.reviewResolutionLearningProposal(
                staff,
                command,
                guard,
              ),
            deadline,
          );
        } catch (error) {
          if (error instanceof LearningReviewGuardFailure && !uncertain)
            throw error;
          uncertain = true;
        }
      }
      throw new AssistantBoundaryError("review_acknowledgement_unknown");
    } finally {
      runtime.close();
    }
  }
  return Object.freeze({
    async scanCandidates(bounds: LearningScanBounds) {
      const runtime = createLearningRuntime(options);
      try {
        const current = await learningServiceAuthority(options, runtime);
        return snapshot(
          await runtime.within(() =>
            options.application.scanResolutionLearningCandidates(
              current.access,
              bounds,
            ),
          ),
        );
      } finally {
        runtime.close();
      }
    },

    async processWork(
      command: ProcessLearningWorkCommand,
      runOptions: LearningRunOptions = {},
    ): Promise<LearningProcessResult> {
      const runtime = createLearningRuntime(options, runOptions);
      // A caller replay identity can never be the owner of two physical calls.
      const claimCommand = snapshot({
        ...command,
        claimId: crypto.randomUUID(),
      });
      let claim: ResolutionLearningClaim | undefined;
      try {
        const current = await learningServiceAuthority(options, runtime);
        const acquired = await runtime.within(() =>
          options.application.claimResolutionLearningWork(
            current.access,
            claimCommand,
          ),
        );
        if (acquired === null) return { outcome: "not_claimed" };
        claim = snapshot(acquired);
        const deadline = Math.min(
          runtime.deadline,
          timestamp(claim.leaseUntil),
          timestamp(claim.work.deadline),
        );
        runtime.ensure(deadline);
        if (
          claim.work.candidate !== undefined ||
          claim.work.exactRequest !== undefined ||
          claim.work.stage === "kb_delivery"
        )
          return await runtime.within(
            () => processLearningKBClaim(options, claim!, runtime),
            deadline,
          );
        return await runtime.within(
          () => model.processClaim(claim!, { signal: runtime.signal }),
          deadline,
        );
      } catch (error) {
        if (claim !== undefined)
          return {
            outcome: "pending",
            stage:
              claim.work.candidate !== undefined ||
              claim.work.exactRequest !== undefined ||
              claim.work.stage === "kb_delivery"
                ? "delivery"
                : "finish",
          };
        return {
          outcome: "held",
          reason:
            error instanceof AssistantBoundaryError
              ? error.category
              : "learning_unavailable",
        };
      } finally {
        runtime.close();
      }
    },

    reviewProposal,
    async prepareReviewIntent(
      access: AccessContext,
      input: ResolutionLearningKey,
      runOptions: LearningRunOptions = {},
    ): Promise<LearningReviewPreparation> {
      const runtime = createLearningRuntime(options, runOptions);
      try {
        const staff = reviewAuthority(access);
        const key = snapshot(input);
        exactKeys(key, ["ticketId", "sourceGeneration"]);
        scalar(key.ticketId);
        count(key.sourceGeneration, Number.MAX_SAFE_INTEGER, 1);
        const service = await learningServiceAuthority(options, runtime);
        const source = await runtime.within(() =>
          options.application.readResolutionLearningSource(
            service.access,
            key.ticketId,
          ),
        );
        const fence = learningSourceFence(source);
        if (fence.sourceGeneration !== key.sourceGeneration)
          throw new AssistantBoundaryError("source_changed");
        const work = await runtime.within(() =>
          options.application.readResolutionLearningWork(service.access, key),
        );
        if (work.target === undefined || work.checkPolicyVersion === undefined)
          throw new AssistantBoundaryError("target_changed");
        const policyResult = await runtime.within(() =>
          options.checks.resolvePolicy(work.checkPolicyVersion, runtime.signal),
        );
        if (policyResult.outcome !== "ready")
          throw new AssistantBoundaryError("check_policy_unavailable");
        const policy = learningCheckPolicySnapshot(
          policyResult.policy,
          timestamp(options.clock.now()),
        );
        if (policy.version !== work.checkPolicyVersion)
          throw new AssistantBoundaryError("check_policy_changed");
        const deadline = Math.min(
          runtime.deadline,
          timestamp(policy.validUntil),
        );
        const actual = await readLearningKBTarget(
          options,
          staff,
          work.target.articleId,
          runtime,
          deadline,
        );
        if (
          canonical(
            await learningTargetBinding(
              actual.draft.revision,
              actual.provenance.snapshot,
            ),
          ) !== canonical(work.target) ||
          !actual.provenance.snapshot.references.some(
            (reference) =>
              canonical(reference) ===
              canonical(learningSourceReference(source)),
          )
        )
          throw new AssistantBoundaryError("target_changed");
        await confirmLearningKBCurrent(
          options,
          staff,
          actual,
          runtime,
          deadline,
        );
        if (
          (await runtime.within(
            () =>
              options.application.confirmResolutionLearningSource(
                service.access,
                fence,
              ),
            deadline,
          )) !== true
        )
          throw new AssistantBoundaryError("source_changed");
        const latest = await runtime.within(
          () =>
            options.application.readResolutionLearningWork(service.access, key),
          deadline,
        );
        if (
          latest.workGeneration !== work.workGeneration ||
          canonical(latest.target) !== canonical(work.target) ||
          latest.checkPolicyVersion !== work.checkPolicyVersion
        )
          throw new AssistantBoundaryError("target_changed");
        const currentPolicy = await runtime.within(
          () => options.checks.resolvePolicy(policy.version, runtime.signal),
          deadline,
        );
        if (
          currentPolicy.outcome !== "ready" ||
          canonical(
            learningCheckPolicySnapshot(
              currentPolicy.policy,
              timestamp(options.clock.now()),
            ),
          ) !== canonical(policy)
        )
          throw new AssistantBoundaryError("check_policy_changed");
        if (
          canonical(
            await learningServiceAuthority(options, runtime, deadline),
          ) !== canonical(service)
        )
          throw new AssistantBoundaryError("authority_changed");
        return snapshot({
          intent: {
            reviewerId: staff.principalId,
            ticketId: key.ticketId,
            sourceGeneration: key.sourceGeneration,
            expectedWorkGeneration: work.workGeneration,
            target: work.target,
            policy,
          },
          draft: actual.draft,
        });
      } finally {
        runtime.close();
      }
    },
    async submitReviewIntent(
      access: AccessContext,
      input: LearningReviewCommand,
      runOptions: LearningRunOptions = {},
    ) {
      const staff = reviewAuthority(access);
      const value = await reviewCommand(staff, input);
      return reviewProposal(staff, value.command, runOptions, value.policy);
    },
    async readReviewReceipt(
      access: AccessContext,
      input: LearningReviewCommand,
      runOptions: LearningRunOptions = {},
    ) {
      const runtime = createLearningRuntime(options, runOptions);
      try {
        const staff = reviewAuthority(access);
        const { command } = await reviewCommand(staff, input);
        return await runtime.within(() =>
          options.application.readResolutionLearningReviewReceipt(
            staff,
            command,
          ),
        );
      } finally {
        runtime.close();
      }
    },
    async cancelReview(
      access: AccessContext,
      input: LearningReviewCommand,
      runOptions: LearningReviewCancellationOptions,
    ) {
      if (typeof runOptions?.verifyBeforeCommit !== "function")
        throw new TypeError(
          "Review cancellation requires a current-authority guard",
        );
      const runtime = createLearningRuntime(options, runOptions);
      try {
        const staff = reviewAuthority(access);
        const { command } = await reviewCommand(staff, input);
        for (let attempt = 0; attempt < attempts; attempt += 1) {
          try {
            return await runtime.within(() =>
              options.application.cancelResolutionLearningReview(
                staff,
                command,
                async () => {
                  await runtime.within(async () => {
                    await runOptions.verifyBeforeCommit();
                  });
                },
              ),
            );
          } catch (error) {
            runtime.ensure();
            if (attempt === attempts - 1) throw error;
          }
        }
        throw new AssistantBoundaryError("review_cancellation_unknown");
      } finally {
        runtime.close();
      }
    },

    reconcileSource,
  });
}
