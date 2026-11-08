import type { AccessContext } from "@pegma/authorization-core";
import type {
  LearningProcessResult,
  LearningRunOptions,
  LearningScanBounds,
  ProcessLearningWorkCommand,
  SupportDeskLearning,
  SupportDeskLearningOptions,
} from "./learning-integration-types.js";
import type {
  ResolutionLearningClaim,
  ReviewResolutionLearningProposalCommand,
} from "@pegma/support-desk-application";
import {
  AssistantBoundaryError,
  canonical,
  count,
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

    async reviewProposal(
      access: AccessContext,
      input: ReviewResolutionLearningProposalCommand,
      runOptions: LearningRunOptions = {},
    ) {
      const runtime = createLearningRuntime(options, runOptions);
      try {
        const staff = learningAuthoritySnapshot({
          access,
          authorityVersion: "staff-review",
          usageScopeRef: "staff-review",
        }).access;
        const command = snapshot(input);
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
        if (policy.version !== command.policyVersion)
          throw new AssistantBoundaryError("check_policy_changed");
        const deadline = Math.min(
          runtime.deadline,
          timestamp(policy.validUntil),
        );
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
              options.checks.resolvePolicy(
                command.policyVersion,
                runtime.signal,
              ),
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
    },

    reconcileSource,
  });
}
