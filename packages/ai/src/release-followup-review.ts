import type {
  DraftArticleDto,
  ValidationRequirementsDto,
} from "@pegma/knowledge-base-application";
import {
  engineeringFollowupChecksBinding,
  engineeringFollowupRetestRequestId,
  engineeringFollowupRetestProductBinding,
  type EngineeringFollowupBundle,
  type EngineeringFollowupCandidate,
  type EngineeringFollowupChecksBinding,
  type EngineeringFollowupKbTarget,
  type EngineeringFollowupWorkRecord,
} from "@pegma/support-desk-application";
import type { SupportDeskReleaseFollowupOptions } from "./release-followup-ports.js";
import type { LearningRuntime } from "./learning-runtime.js";
import { learningKnowledgeAuthority } from "./learning-runtime.js";
import {
  AssistantBoundaryError,
  bytes,
  canonical,
  count,
  exactKeys,
  fingerprint,
  scalar,
  snapshot,
  timestamp,
} from "./boundary.js";
import { releaseFollowupContent } from "./release-followup-output.js";
import {
  releaseFollowupCheckPolicy,
  releaseFollowupProof,
  releaseFollowupProofContext,
} from "./release-followup-request.js";

export class ReleaseFollowupReviewGuardFailure extends AssistantBoundaryError {}

function externalContext(runtime: LearningRuntime, phase: number) {
  return Object.freeze({
    purpose: "support_release_followup" as const,
    deadline: new Date(phase).toISOString(),
    signal: runtime.signal,
  });
}

interface TargetObservation {
  readonly target: EngineeringFollowupKbTarget;
  readonly baseline: DraftArticleDto | null;
  readonly requirements: ValidationRequirementsDto | null;
  readonly authorityBinding: string | null;
}

async function targetObservation(
  options: SupportDeskReleaseFollowupOptions,
  work: EngineeringFollowupWorkRecord,
  runtime: LearningRuntime,
  phase: number,
): Promise<TargetObservation> {
  if (work.context === undefined)
    throw new AssistantBoundaryError("source_changed");
  const selected = snapshot(
    await runtime.within(
      () =>
        options.targets.resolve(
          {
            key: { ticketId: work.ticketId, workId: work.workId },
            context: work.context!,
            proofContext: releaseFollowupProofContext(work),
          },
          externalContext(runtime, phase),
        ),
      phase,
    ),
  );
  if (selected.kind === "none") {
    exactKeys(selected, ["kind"]);
    return {
      target: { kind: "none" },
      baseline: null,
      requirements: null,
      authorityBinding: null,
    };
  }
  if (selected.kind !== "article")
    throw new AssistantBoundaryError("kb_target_unavailable");
  exactKeys(selected, ["kind", "articleId"]);
  scalar(selected.articleId);
  if (options.knowledge === undefined || options.knowledgeAccess === undefined)
    throw new AssistantBoundaryError("kb_target_unavailable");
  const authority = await learningKnowledgeAuthority(
    options.knowledgeAccess,
    runtime,
    phase,
  );
  const baseline = snapshot(
    await runtime.within(
      () =>
        options.knowledge!.getDraft(authority.access, {
          articleId: selected.articleId,
        }),
      phase,
    ),
  );
  if (
    baseline.articleId !== selected.articleId ||
    baseline.revision.articleId !== selected.articleId
  )
    throw new AssistantBoundaryError("kb_target_changed");
  count(baseline.generation, Number.MAX_SAFE_INTEGER, 1);
  count(baseline.revision.number, Number.MAX_SAFE_INTEGER, 1);
  scalar(baseline.revision.collectionId);
  scalar(baseline.revision.contentHash);
  const requirements = snapshot(
    await runtime.within(
      () =>
        options.knowledge!.getValidationRequirements(authority.access, {
          collectionId: baseline.revision.collectionId,
          kind: baseline.revision.kind,
        }),
      phase,
    ),
  );
  if (
    requirements.collectionId !== baseline.revision.collectionId ||
    !Array.isArray(requirements.checks) ||
    requirements.checks.length > 32
  )
    throw new AssistantBoundaryError("kb_target_changed");
  count(requirements.governanceGeneration, Number.MAX_SAFE_INTEGER, 1);
  scalar(requirements.validationPolicy.id);
  count(requirements.validationPolicy.version, Number.MAX_SAFE_INTEGER, 1);
  scalar(requirements.expectedStagingBuildId);
  const ids = requirements.checks.map((check) => {
    scalar(check.id);
    scalar(check.testKind);
    count(check.maxAgeMilliseconds, Number.MAX_SAFE_INTEGER, 1);
    return check.id;
  });
  if (
    new Set(ids).size !== ids.length ||
    bytes(canonical({ baseline, requirements })) > 262_144
  )
    throw new AssistantBoundaryError("kb_target_unavailable");
  const currentAuthority = await learningKnowledgeAuthority(
    options.knowledgeAccess,
    runtime,
    phase,
  );
  if (canonical(currentAuthority) !== canonical(authority))
    throw new AssistantBoundaryError("knowledge_authority_changed");
  return snapshot({
    target: {
      kind: "article",
      articleId: baseline.articleId,
      collectionId: baseline.revision.collectionId,
      articleRevision: baseline.revision.number,
      contentHash: baseline.revision.contentHash,
      validationRequirementsHash: await fingerprint(requirements),
      validationRequirementIds: ids,
    },
    baseline,
    requirements,
    authorityBinding: await fingerprint(authority),
  });
}

async function verifyReceipt(
  options: SupportDeskReleaseFollowupOptions,
  receipt: string,
  binding: EngineeringFollowupChecksBinding,
  runtime: LearningRuntime,
  phase: number,
): Promise<number> {
  scalar(receipt);
  const raw = await runtime.within(
    () => options.checks.verify(receipt, binding, runtime.signal),
    phase,
  );
  if (raw === null) throw new AssistantBoundaryError("checks_unavailable");
  const checked = snapshot(raw);
  exactKeys(checked, [
    "binding",
    "privacy",
    "factual",
    "applicability",
    "security",
    "verifierReceiptId",
    "verifierVersion",
    "verifiedAt",
    "validUntil",
  ]);
  scalar(checked.verifierReceiptId);
  scalar(checked.verifierVersion);
  const expiry = timestamp(checked.validUntil);
  if (
    canonical(checked.binding) !== canonical(binding) ||
    checked.privacy !== "passed" ||
    checked.factual !== "passed" ||
    checked.applicability !== "passed" ||
    checked.security !== "clear" ||
    timestamp(checked.verifiedAt) > timestamp(options.clock.now()) ||
    expiry <= timestamp(options.clock.now())
  )
    throw new AssistantBoundaryError("checks_unavailable");
  runtime.ensure(Math.min(phase, expiry));
  return expiry;
}

/** No model/provider dependency: identical logic prepares a worker draft or a staff reassessment. */
export async function prepareCheckedReleaseFollowupBundle(
  options: SupportDeskReleaseFollowupOptions,
  work: EngineeringFollowupWorkRecord,
  rawContent: EngineeringFollowupCandidate,
  runtime: LearningRuntime,
  observeCurrent: () => Promise<void>,
  phase = runtime.deadline,
) {
  const content = releaseFollowupContent(rawContent);
  const proof = await releaseFollowupProof(options, work, runtime, phase);
  const target = await targetObservation(options, work, runtime, phase);
  const productBinding = await engineeringFollowupRetestProductBinding(
    proof.context,
  );
  const requirementIds =
    content.kbProposal !== null && target.target.kind === "article"
      ? target.target.validationRequirementIds
      : [];
  const retestRequests = [];
  for (let index = 0; index < content.retestRequests.length; index += 1) {
    const request = content.retestRequests[index]!;
    retestRequests.push({
      ...request,
      requestId: await engineeringFollowupRetestRequestId({
        workId: work.workId,
        index,
        steps: request.steps,
        expectedBehavior: request.expectedBehavior,
        productBinding,
        validationRequirementIds: requirementIds,
      }),
      productBinding,
      validationRequirementIds: requirementIds,
    });
  }
  const bundle: EngineeringFollowupBundle = snapshot({
    customerDraft: content.customerDraft,
    kbProposal:
      content.kbProposal === null
        ? null
        : { ...content.kbProposal, target: target.target },
    retestRequests,
  });
  const serialized = canonical(bundle);
  if (Math.max(bytes(serialized), serialized.length * 2) > 16_000)
    throw new AssistantBoundaryError("bundle_limit");
  const policy = await releaseFollowupCheckPolicy(
    options,
    runtime,
    undefined,
    phase,
  );
  if (work.candidateHash === undefined)
    throw new AssistantBoundaryError("candidate_unavailable");
  const binding = await engineeringFollowupChecksBinding({
    workBindingHash: work.workBindingHash,
    candidateHash: work.candidateHash,
    exactBundle: bundle,
    checkPolicyVersion: policy.version,
    followupRevocationEpoch: work.association.followupRevocationEpoch,
    context: proof.context,
  });
  const checked = await runtime.within(
    () =>
      options.checks.check(
        {
          candidate: content,
          exactBundle: bundle,
          binding,
          releaseProof: proof,
          targetBaseline: target.baseline,
          validationRequirements: target.requirements,
        },
        externalContext(runtime, phase),
      ),
    phase,
  );
  if (checked.outcome !== "checked")
    throw new AssistantBoundaryError(
      checked.outcome === "restricted"
        ? "security_restricted"
        : "checks_unavailable",
    );
  const receipt = scalar(checked.receipt);
  const receiptExpiry = await verifyReceipt(
    options,
    receipt,
    binding,
    runtime,
    phase,
  );
  const deadline = Math.min(
    phase,
    timestamp(policy.validUntil),
    timestamp(proof.attestation.validUntil),
    receiptExpiry,
  );
  const guard = async (): Promise<void> => {
    try {
      const freshProof = await releaseFollowupProof(
        options,
        work,
        runtime,
        deadline,
      );
      const currentTarget = await targetObservation(
        options,
        work,
        runtime,
        deadline,
      );
      if (canonical(currentTarget) !== canonical(target))
        throw new AssistantBoundaryError("kb_target_changed");
      if (
        canonical(
          await releaseFollowupCheckPolicy(
            options,
            runtime,
            policy.version,
            deadline,
          ),
        ) !== canonical(policy)
      )
        throw new AssistantBoundaryError("check_policy_changed");
      const expiry = await verifyReceipt(
        options,
        receipt,
        binding,
        runtime,
        deadline,
      );
      // The caller resolves its current authority before its direct storage-only fence.
      await observeCurrent();
      runtime.ensure(
        Math.min(
          deadline,
          expiry,
          timestamp(freshProof.attestation.validUntil),
        ),
      );
    } catch (error) {
      throw new ReleaseFollowupReviewGuardFailure(
        error instanceof AssistantBoundaryError
          ? error.category
          : "verification_unavailable",
      );
    }
  };
  return {
    bundle,
    binding,
    receipt,
    checkPolicyVersion: policy.version,
    deadline,
    guard,
  };
}

/** Reverify the already stored body: posting never changes content or calls a provider. */
export async function confirmStoredReleaseFollowupBundle(
  options: SupportDeskReleaseFollowupOptions,
  work: EngineeringFollowupWorkRecord,
  runtime: LearningRuntime,
  observeCurrent: () => Promise<void>,
  phase = runtime.deadline,
): Promise<void> {
  const prepared = work.preparedBundle;
  if (prepared === undefined || work.context === undefined)
    throw new AssistantBoundaryError("bundle_unavailable");
  const proof = await releaseFollowupProof(options, work, runtime, phase);
  const target = await targetObservation(options, work, runtime, phase);
  if (
    prepared.bundle.kbProposal !== null &&
    canonical(prepared.bundle.kbProposal.target) !== canonical(target.target)
  )
    throw new AssistantBoundaryError("kb_target_changed");
  const requirementIds =
    prepared.bundle.kbProposal !== null && target.target.kind === "article"
      ? target.target.validationRequirementIds
      : [];
  const productBinding = await engineeringFollowupRetestProductBinding(
    proof.context,
  );
  if (
    prepared.bundle.retestRequests.some(
      (request) =>
        request.productBinding !== productBinding ||
        canonical(request.validationRequirementIds) !==
          canonical(requirementIds),
    )
  )
    throw new AssistantBoundaryError("kb_target_changed");
  const policy = await releaseFollowupCheckPolicy(
    options,
    runtime,
    prepared.binding.checkPolicyVersion,
    phase,
  );
  const binding = await engineeringFollowupChecksBinding({
    workBindingHash: work.workBindingHash,
    candidateHash: prepared.candidateHash,
    exactBundle: prepared.bundle,
    checkPolicyVersion: policy.version,
    followupRevocationEpoch: work.association.followupRevocationEpoch,
    context: proof.context,
  });
  if (
    canonical(binding) !== canonical(prepared.binding) ||
    binding.bundleHash !== prepared.bundleHash
  )
    throw new AssistantBoundaryError("bundle_changed");
  const expiry = await verifyReceipt(
    options,
    prepared.checksReceipt,
    binding,
    runtime,
    phase,
  );
  await observeCurrent();
  runtime.ensure(
    Math.min(
      phase,
      expiry,
      timestamp(policy.validUntil),
      timestamp(proof.attestation.validUntil),
    ),
  );
}

export function retainedReleaseFollowupContent(
  work: EngineeringFollowupWorkRecord,
): EngineeringFollowupCandidate {
  if (work.candidate !== undefined)
    return releaseFollowupContent(work.candidate);
  const bundle = work.preparedBundle?.bundle;
  if (bundle === undefined)
    throw new AssistantBoundaryError("candidate_unavailable");
  return releaseFollowupContent({
    customerDraft: bundle.customerDraft,
    kbProposal:
      bundle.kbProposal === null
        ? null
        : {
            summary: bundle.kbProposal.summary,
            changes: bundle.kbProposal.changes,
            advisoryValidationRequirements:
              bundle.kbProposal.advisoryValidationRequirements,
          },
    retestRequests: bundle.retestRequests.map((request) => ({
      steps: request.steps,
      expectedBehavior: request.expectedBehavior,
    })),
  });
}
