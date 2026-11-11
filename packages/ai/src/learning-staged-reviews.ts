import { hasPermission, type AccessContext } from "@pegma/authorization-core";
import { knowledgePermissions } from "@pegma/knowledge-base-contracts";
import {
  SupportDeskAuthorizationError,
  supportPermissions,
  type ResolutionLearningStagedReviewClaim,
  type ResolutionLearningStagedReviewGuard,
  type ResolutionLearningStagedReviewProof,
} from "@pegma/support-desk-application";
import {
  AssistantBoundaryError,
  canonical,
  fingerprint,
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
  readLearningKBTarget,
} from "./learning-kb.js";
import {
  learningReviewAuthority,
  learningReviewCommand,
} from "./learning-review-command.js";
import { learningCheckPolicySnapshot } from "./learning-request.js";
import {
  createLearningRuntime,
  learningServiceAuthority,
  type LearningRuntime,
} from "./learning-runtime.js";
import type { LearningRunOptions } from "./learning-integration-types.js";
import type {
  LearningStagedReviewProcessResult,
  SupportDeskStagedLearningReviewOptions,
  SupportDeskStagedLearningReviews,
} from "./learning-staged-review-types.js";

const knowledgeGrants = [
  knowledgePermissions.draftRead,
  knowledgePermissions.provenanceRead,
];
const operationCeiling = new Set<string>([
  supportPermissions.learningReview,
  supportPermissions.queueRead,
  supportPermissions.learningRead,
  ...knowledgeGrants,
]);

/** Separate optional capability: no model, KB mutation, provider, or browser credentials. */
export function createSupportDeskStagedLearningReviews(
  options: SupportDeskStagedLearningReviewOptions,
): SupportDeskStagedLearningReviews {
  const staged = options.application.stagedResolutionLearningReviews;
  if (staged === undefined)
    throw new TypeError(
      "Staged learning reviews require the application capability",
    );
  if (typeof options.resolveActor !== "function")
    throw new TypeError(
      "Staged learning reviews require a current-actor resolver",
    );
  if (options.readScheduling !== undefined && options.readScheduling !== "sdk")
    throw new TypeError("Unknown learning read scheduling");

  async function actor(
    principalId: string,
    runtime: LearningRuntime,
    deadline = runtime.deadline,
    requireKnowledge = true,
  ): Promise<AccessContext> {
    const resolved = await runtime.within(
      () => options.resolveActor({ principalId, signal: runtime.signal }),
      deadline,
    );
    if (resolved === null || resolved.principalId !== principalId)
      throw new AssistantBoundaryError("authority_unavailable");
    const current = learningReviewAuthority(resolved);
    if (requireKnowledge)
      for (const permission of knowledgeGrants)
        if (!hasPermission(current, permission))
          throw new SupportDeskAuthorizationError(permission);
    // Fresh grants never expand the retained operation's fixed action/target ceiling.
    return snapshot({
      ...current,
      permissions: current.permissions.filter((permission) =>
        operationCeiling.has(permission),
      ),
    });
  }
  function finalFence(runtime: LearningRuntime, deadline: number): () => true {
    return () => {
      runtime.ensure(deadline);
      return true;
    };
  }
  function humanGuard(
    guard: ResolutionLearningStagedReviewGuard,
    runtime: LearningRuntime,
  ): ResolutionLearningStagedReviewGuard {
    if (typeof guard !== "function")
      throw new TypeError("A fresh current-human commit guard is required");
    return async () => {
      const assertion = await runtime.within(async () => guard());
      return () => {
        runtime.ensure();
        if (assertion !== undefined && assertion() !== true)
          throw new AssistantBoundaryError("authority_changed");
        return true;
      };
    };
  }

  /** Each stage repeats the full proof; the P1 digest never supplies live authority. */
  async function verify(
    claim: ResolutionLearningStagedReviewClaim,
    staff: AccessContext,
    runtime: LearningRuntime,
    deadline: number,
  ): Promise<ResolutionLearningStagedReviewProof> {
    const { command, intent } = claim;
    const service = await learningServiceAuthority(options, runtime, deadline);
    const source = await runtime.within(
      () =>
        options.application.readResolutionLearningSource(
          service.access,
          command.ticketId,
        ),
      deadline,
    );
    const sourceFence = learningSourceFence(source);
    if (sourceFence.sourceGeneration !== command.sourceGeneration)
      throw new AssistantBoundaryError("source_changed");
    const own = learningSourceReference(source);
    const resolvedPolicy = await runtime.within(
      () => options.checks.resolvePolicy(command.policyVersion, runtime.signal),
      deadline,
    );
    if (resolvedPolicy.outcome !== "ready")
      throw new AssistantBoundaryError("check_policy_unavailable");
    const policy = learningCheckPolicySnapshot(
      resolvedPolicy.policy,
      timestamp(options.clock.now()),
    );
    if (
      canonical(policy) !== canonical(intent.policy) ||
      policy.version !== command.policyVersion
    )
      throw new AssistantBoundaryError("check_policy_changed");
    const currentService = await learningServiceAuthority(
      options,
      runtime,
      deadline,
    );
    if (canonical(currentService) !== canonical(service))
      throw new AssistantBoundaryError("authority_changed");
    const target = await readLearningKBTarget(
      options,
      staff,
      command.target.articleId,
      runtime,
      deadline,
    );
    if (
      canonical(
        await learningTargetBinding(
          target.draft.revision,
          target.provenance.snapshot,
        ),
      ) !== canonical(command.target) ||
      !target.provenance.snapshot.references.some(
        (reference) => canonical(reference) === canonical(own),
      )
    )
      throw new AssistantBoundaryError("target_changed");
    await confirmLearningKBCurrent(options, staff, target, runtime, deadline);
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
      () => options.checks.resolvePolicy(command.policyVersion, runtime.signal),
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
    const latestDraft = snapshot(
      await runtime.within(
        () =>
          options.knowledge.getDraft(staff, {
            articleId: command.target.articleId,
          }),
        deadline,
      ),
    );
    if (canonical(latestDraft) !== canonical(target.draft))
      throw new AssistantBoundaryError("target_changed");
    const binding = await runtime.within(
      () =>
        fingerprint({
          reviewerId: claim.reviewerId,
          intentBinding: command.intentBinding,
          sourceFence,
          workGeneration: command.expectedWorkGeneration,
          target: command.target,
          policy,
        }),
      deadline,
    );
    runtime.ensure(deadline);
    return { binding, validUntil: policy.validUntil };
  }

  const reviews: SupportDeskStagedLearningReviews = {
    async admitReviewIntent(access, input, run) {
      const runtime = createLearningRuntime(options, run);
      try {
        const staff = learningReviewAuthority(access);
        const packet = snapshot(input);
        const { command } = await learningReviewCommand(staff, packet);
        return await runtime.within(() =>
          staged.admit(
            staff,
            command,
            packet.intent,
            humanGuard(run.verifyBeforeCommit, runtime),
          ),
        );
      } finally {
        runtime.close();
      }
    },
    async readReviewStatus(access, input, run: LearningRunOptions = {}) {
      const runtime = createLearningRuntime(options, run);
      try {
        const staff = learningReviewAuthority(access);
        const { command } = await learningReviewCommand(staff, input);
        return await runtime.within(() => staged.readStatus(staff, command));
      } finally {
        runtime.close();
      }
    },
    async cancelReview(access, input, run) {
      const runtime = createLearningRuntime(options, run);
      try {
        const staff = learningReviewAuthority(access);
        const { command } = await learningReviewCommand(staff, input);
        return await runtime.within(() =>
          staged.cancel(
            staff,
            command,
            humanGuard(run.verifyBeforeCommit, runtime),
          ),
        );
      } finally {
        runtime.close();
      }
    },
    async scanPending(bounds, run: LearningRunOptions = {}) {
      const runtime = createLearningRuntime(options, run);
      try {
        const service = await learningServiceAuthority(options, runtime);
        return snapshot(
          await runtime.within(() =>
            staged.scanPending(service.access, snapshot(bounds)),
          ),
        );
      } finally {
        runtime.close();
      }
    },
    async processReview(
      input,
      run: LearningRunOptions = {},
    ): Promise<LearningStagedReviewProcessResult> {
      const runtime = createLearningRuntime(options, run);
      let claim: ResolutionLearningStagedReviewClaim | undefined;
      let attemptedPhase: "proof" | "commit" | undefined;
      try {
        const command = snapshot({ ...input, claimId: crypto.randomUUID() });
        const service = await learningServiceAuthority(options, runtime);
        // Only authoritative private dispatch metadata selects the original human.
        const pending = await runtime.within(() =>
          staged.readPending(service.access, {
            ticketId: command.ticketId,
            commandId: command.commandId,
          }),
        );
        if (pending === null) return { outcome: "not_pending" };
        if (pending.held) return { outcome: "held", reason: "review_held" };
        const staff = await actor(
          pending.reviewerId,
          runtime,
          runtime.deadline,
          false,
        );
        // A committed claim can lose its response. Keep its authoritative phase
        // before crossing that mutation boundary; absence of an ACK is not held.
        attemptedPhase = pending.phase;
        const acquired = await runtime.within(() =>
          staged.claim(staff, command),
        );
        if (acquired === null) return { outcome: "not_claimed" };
        claim = snapshot(acquired);
        if (
          claim.reviewerId !== pending.reviewerId ||
          claim.intent.reviewerId !== pending.reviewerId
        )
          throw new AssistantBoundaryError("authority_changed");
        const currentClaim = claim;
        const deadline = Math.min(
          runtime.deadline,
          timestamp(claim.expiresAt),
          timestamp(claim.leaseUntil),
          timestamp(claim.intent.policy.validUntil),
          claim.proof === undefined
            ? Infinity
            : timestamp(claim.proof.validUntil),
        );
        runtime.ensure(deadline);
        if (claim.phase === "proof") {
          const current = await actor(claim.reviewerId, runtime, deadline);
          const proof = await verify(claim, current, runtime, deadline);
          const status = await runtime.within(
            () =>
              staged.prepare(
                current,
                { fence: currentClaim.fence, proof },
                async () => {
                  const confirmed = await actor(
                    currentClaim.reviewerId,
                    runtime,
                    deadline,
                  );
                  if (canonical(confirmed) !== canonical(current))
                    throw new AssistantBoundaryError("authority_changed");
                  return finalFence(runtime, deadline);
                },
              ),
            deadline,
          );
          if (status.outcome !== "pending")
            return { outcome: "completed", receipt: status };
          // The caller must end this invocation, even if commit work is immediately discoverable.
          return { outcome: "prepared", status };
        }
        if (claim.proof === undefined)
          throw new AssistantBoundaryError("review_proof_missing");
        const preparedProof = claim.proof;
        const receipt = await runtime.within(
          () =>
            staged.complete(staff, currentClaim.fence, async () => {
              const current = await actor(
                currentClaim.reviewerId,
                runtime,
                deadline,
              );
              const proof = await verify(
                currentClaim,
                current,
                runtime,
                deadline,
              );
              if (proof.binding !== preparedProof.binding)
                throw new AssistantBoundaryError("review_proof_changed");
              const confirmed = await actor(
                currentClaim.reviewerId,
                runtime,
                deadline,
              );
              if (canonical(confirmed) !== canonical(current))
                throw new AssistantBoundaryError("authority_changed");
              return finalFence(runtime, deadline);
            }),
          deadline,
        );
        return { outcome: "completed", receipt };
      } catch (error) {
        const reason =
          error instanceof AssistantBoundaryError
            ? error.category
            : error instanceof SupportDeskAuthorizationError
              ? "authorization_unavailable"
              : "review_unavailable";
        const phase = claim?.phase ?? attemptedPhase ?? "dispatch";
        return { outcome: "pending", phase, reason };
      } finally {
        runtime.close();
      }
    },
  };
  return Object.freeze(reviews);
}
