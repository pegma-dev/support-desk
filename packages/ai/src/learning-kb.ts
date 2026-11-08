import type { AccessContext } from "@pegma/authorization-core";
import {
  KnowledgeBaseNotFoundError,
  type ArticleAcknowledgement,
  type DraftArticleDto,
  type ProvenanceDto,
  type PublishedArticleDto,
  type ValidationRequirementsDto,
} from "@pegma/knowledge-base-application";
import {
  resolutionLearningDeliveryBinding,
  type CompleteResolutionLearningStepCommand,
  type FinishResolutionLearningWorkCommand,
  type PrepareResolutionLearningStepCommand,
  type ResolutionLearningChecksBinding,
  type ResolutionLearningClaim,
  type ResolutionLearningDeliveryRequest,
  type ResolutionLearningPreparedStep,
} from "@pegma/support-desk-application";
import type {
  LearningArticleDraft,
  LearningProcessResult,
  LearningTargetProduct,
  LearningTargetScope,
  SupportDeskLearningOptions,
} from "./learning-integration-types.js";
import type {
  VerifiedLearningCheckPolicy,
  VerifiedLearningConfiguration,
} from "./learning-ports.js";
import {
  AssistantBoundaryError,
  bytes,
  canonical,
  count,
  exactKeys,
  fingerprint,
  scalar,
  snapshot,
  text,
  timestamp,
} from "./boundary.js";
import {
  learningReferencesSnapshot,
  learningSourceFence,
  learningSourceReference,
  learningTargetBinding,
  supportDeskLearningSourceSystem,
} from "./learning-bindings.js";
import {
  learningCheckPolicySnapshot,
  learningConfigurationSnapshot,
} from "./learning-request.js";
import {
  learningKnowledgeAuthority,
  learningServiceAuthority,
  type LearningRuntime,
} from "./learning-runtime.js";

export interface LearningKBTargetSnapshot {
  readonly draft: DraftArticleDto;
  readonly provenance: ProvenanceDto;
}

/** Read an actual consistent draft/provenance pair; never synthesize a revision. */
export async function readLearningKBTarget(
  options: SupportDeskLearningOptions,
  access: AccessContext,
  articleId: string,
  runtime: LearningRuntime,
  deadline = runtime.deadline,
): Promise<LearningKBTargetSnapshot> {
  scalar(articleId);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const draft = snapshot(
      await runtime.within(
        () => options.knowledge.getDraft(access, { articleId }),
        deadline,
      ),
    );
    const provenance = snapshot(
      await runtime.within(
        () => options.knowledge.getProvenance(access, { articleId }),
        deadline,
      ),
    );
    const confirmed = snapshot(
      await runtime.within(
        () => options.knowledge.getDraft(access, { articleId }),
        deadline,
      ),
    );
    if (
      draft.articleId !== articleId ||
      provenance.articleId !== articleId ||
      draft.revision.articleId !== articleId
    )
      throw new AssistantBoundaryError("target_mismatch");
    count(draft.generation, Number.MAX_SAFE_INTEGER, 1);
    count(provenance.generation, Number.MAX_SAFE_INTEGER, 1);
    learningReferencesSnapshot(provenance.snapshot.references);
    if (provenance.publishedSnapshot !== undefined)
      learningReferencesSnapshot(provenance.publishedSnapshot.references);
    if (
      draft.generation === provenance.generation &&
      canonical(draft) === canonical(confirmed)
    )
      return Object.freeze({ draft, provenance });
  }
  throw new AssistantBoundaryError("target_changed");
}

/** Full current and published reference sets remain readable, without filtering. */
export async function confirmLearningKBReadability(
  options: SupportDeskLearningOptions,
  access: AccessContext,
  target: LearningKBTargetSnapshot,
  runtime: LearningRuntime,
  deadline = runtime.deadline,
): Promise<void> {
  for (const source of [
    target.provenance.snapshot,
    target.provenance.publishedSnapshot,
  ]) {
    if (source === undefined) continue;
    for (const reference of learningReferencesSnapshot(source.references)) {
      const readable = await runtime.within(
        () =>
          options.sources.canRead({
            access,
            articleId: target.draft.articleId,
            reference,
          }),
        deadline,
      );
      if (readable !== true)
        throw new AssistantBoundaryError("source_unreadable");
    }
  }
}

/** Final guards check the complete actual aggregate, including every contributor. */
export async function confirmLearningKBCurrent(
  options: SupportDeskLearningOptions,
  access: AccessContext,
  target: LearningKBTargetSnapshot,
  runtime: LearningRuntime,
  deadline = runtime.deadline,
): Promise<void> {
  await confirmLearningKBReadability(
    options,
    access,
    target,
    runtime,
    deadline,
  );
  if (
    (await runtime.within(
      () =>
        options.sources.isCurrent({
          article: target.draft.revision,
          snapshot: target.provenance.snapshot,
        }),
      deadline,
    )) !== true
  )
    throw new AssistantBoundaryError("contributor_changed");
}

export function learningDraftFromRevision(
  target: LearningKBTargetSnapshot,
): LearningArticleDraft {
  const revision = target.draft.revision;
  return snapshot({
    kind: revision.kind,
    title: revision.title,
    summary: revision.summary,
    content: revision.content,
    tags: revision.tags,
    applicability: revision.applicability,
  });
}

function scopeSnapshot(
  raw: LearningTargetScope,
  maxExplicit: number,
): LearningTargetScope {
  const scope = snapshot(raw);
  exactKeys(scope, [
    "version",
    "collectionId",
    "kind",
    "searchQuery",
    "explicitDraftIds",
  ]);
  scalar(scope.version);
  scalar(scope.collectionId);
  scalar(scope.searchQuery, 256);
  if (
    ![
      "explanation",
      "walkthrough",
      "troubleshooting",
      "developer-reference",
    ].includes(scope.kind) ||
    !Array.isArray(scope.explicitDraftIds) ||
    scope.explicitDraftIds.length > maxExplicit ||
    new Set(scope.explicitDraftIds).size !== scope.explicitDraftIds.length
  )
    throw new AssistantBoundaryError("target_scope_invalid");
  scope.explicitDraftIds.forEach((id) => scalar(id));
  return scope;
}

function productSnapshot(
  claim: ResolutionLearningClaim,
): LearningTargetProduct {
  const value = claim.work.product;
  if (value === undefined) throw new AssistantBoundaryError("source_changed");
  return snapshot({
    productId: scalar(value.productId),
    version: scalar(value.version),
    buildId: scalar(value.buildId),
    binding: scalar(value.binding),
    contextVersion: scalar(value.contextVersion),
  });
}

function draftSnapshot(
  raw: LearningArticleDraft,
  scope: LearningTargetScope,
  product: LearningTargetProduct,
): LearningArticleDraft {
  const draft = snapshot(raw);
  exactKeys(draft, [
    "kind",
    "title",
    "summary",
    "content",
    "tags",
    "applicability",
  ]);
  scalar(draft.title, 200);
  scalar(draft.summary, 1_000);
  exactKeys(draft.content, ["format", "text"]);
  if (
    draft.kind !== scope.kind ||
    !["markdown", "plain_text"].includes(draft.content.format) ||
    bytes(text(draft.content.text, 32_768)) > 32_768 ||
    !Array.isArray(draft.tags) ||
    draft.tags.length > 16 ||
    new Set(draft.tags).size !== draft.tags.length ||
    canonical(draft.applicability) !==
      canonical({
        productId: product.productId,
        productVersion: product.version,
        buildId: product.buildId,
      })
  )
    throw new AssistantBoundaryError("draft_invalid");
  draft.tags.forEach((tag) => scalar(tag, 64));
  return draft;
}

interface DeliveryPayload {
  readonly draft: LearningArticleDraft;
  readonly scope: LearningTargetScope;
  readonly configurationHash: string;
  readonly policyBinding: string;
  readonly requirements: ValidationRequirementsDto;
  readonly base: null | {
    readonly generation: number;
    readonly articleRevision: number;
    readonly contentHash: string;
    readonly sourceSnapshotHash: string;
    readonly sourceSnapshotGeneration: number;
    readonly publishedSourceSnapshotHash: string | null;
  };
}

function payloadSnapshot(
  raw: string,
  product: LearningTargetProduct,
  maxExplicit: number,
): DeliveryPayload {
  text(raw, 24_000);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new AssistantBoundaryError("request_invalid");
  }
  const value = exactKeys(parsed, [
    "draft",
    "scope",
    "configurationHash",
    "policyBinding",
    "requirements",
    "base",
  ]);
  const scope = scopeSnapshot(value.scope as LearningTargetScope, maxExplicit);
  const draft = draftSnapshot(
    value.draft as LearningArticleDraft,
    scope,
    product,
  );
  scalar(value.configurationHash);
  scalar(value.policyBinding);
  const result = snapshot({
    ...value,
    draft,
    scope,
  }) as unknown as DeliveryPayload;
  if (canonical(result) !== raw)
    throw new AssistantBoundaryError("request_invalid");
  return result;
}

async function confirmBaseContributors(
  options: SupportDeskLearningOptions,
  access: AccessContext,
  target: LearningKBTargetSnapshot,
  own: ResolutionLearningDeliveryRequest["sourceReferences"][number],
  runtime: LearningRuntime,
  deadline: number,
): Promise<void> {
  await confirmLearningKBReadability(
    options,
    access,
    target,
    runtime,
    deadline,
  );
  let foreign = false;
  for (const reference of target.provenance.snapshot.references) {
    if (reference.id === own.id) {
      if (
        reference.system !== own.system ||
        reference.resourceId !== own.resourceId
      )
        throw new AssistantBoundaryError("source_identity_collision");
      // This ticket's prior resolution may be stale. Replace its reference with
      // the newly confirmed source instead of requiring the obsolete proof.
      continue;
    }
    if (reference.system !== supportDeskLearningSourceSystem) {
      foreign = true;
      continue;
    }
    const support = await learningServiceAuthority(options, runtime, deadline);
    const source = await runtime.within(
      () =>
        options.application.readResolutionLearningSource(
          support.access,
          reference.resourceId,
        ),
      deadline,
    );
    if (
      canonical(learningSourceReference(source)) !== canonical(reference) ||
      (await runtime.within(
        () =>
          options.application.confirmResolutionLearningSource(
            support.access,
            learningSourceFence(source),
          ),
        deadline,
      )) !== true
    )
      throw new AssistantBoundaryError("contributor_changed");
  }
  // A foreign namespace cannot be separated from an aggregate denial by making
  // up a filtered SourceSnapshot/hash. Mixed uncertainty is held in Support.
  if (
    foreign &&
    (await runtime.within(
      () =>
        options.sources.isCurrent({
          article: target.draft.revision,
          snapshot: target.provenance.snapshot,
        }),
      deadline,
    )) !== true
  )
    throw new AssistantBoundaryError("contributor_changed");
}

function baseBinding(
  target: LearningKBTargetSnapshot,
): NonNullable<DeliveryPayload["base"]> {
  return snapshot({
    generation: target.draft.generation,
    articleRevision: target.draft.revision.number,
    contentHash: target.draft.revision.contentHash,
    sourceSnapshotHash: target.provenance.snapshot.hash,
    sourceSnapshotGeneration: target.provenance.snapshot.generation,
    publishedSourceSnapshotHash:
      target.provenance.publishedSnapshot?.hash ?? null,
  });
}

function acknowledgement(
  raw: ArticleAcknowledgement,
  articleId: string,
): ArticleAcknowledgement {
  const ack = snapshot(raw);
  exactKeys(ack, [
    "id",
    "generation",
    "articleRevision",
    "state",
    "contentHash",
  ]);
  if (
    scalar(ack.id) !== articleId ||
    !["draft", "in-review", "published", "retired"].includes(ack.state)
  )
    throw new AssistantBoundaryError("acknowledgement_mismatch");
  count(ack.generation, Number.MAX_SAFE_INTEGER, 1);
  count(ack.articleRevision, Number.MAX_SAFE_INTEGER, 1);
  scalar(ack.contentHash);
  return ack;
}

class DeliveryGuardFailure extends AssistantBoundaryError {}

/** One private create/update stage against the exact verified released KB API. */
export async function processLearningKBClaim(
  options: SupportDeskLearningOptions,
  rawClaim: ResolutionLearningClaim,
  runtime: LearningRuntime,
): Promise<LearningProcessResult> {
  const claim = snapshot(rawClaim);
  const attempts = count(options.storageCommandAttempts ?? 2, 3, 1);
  const reserve = count(options.commitReserveMilliseconds ?? 1_000, 5_000, 1);
  const maxPublished = count(options.maxPublishedMatches ?? 5, 5, 1);
  const maxExplicit = count(options.maxExplicitDrafts ?? 5, 5);
  let prepared:
    | Extract<ResolutionLearningPreparedStep, { step: "kb_delivery" }>
    | undefined;
  let invoked = false;
  let request: ResolutionLearningDeliveryRequest | undefined;
  const finish = async (reason: string): Promise<LearningProcessResult> => {
    const command: FinishResolutionLearningWorkCommand = snapshot({
      ...claim.fence,
      ...(prepared === undefined
        ? {}
        : { stepId: prepared.stepId, requestHash: prepared.requestHash }),
      disposition: invoked ? "unknown" : "held",
      reason,
    });
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const access = await learningServiceAuthority(options, runtime);
        const result = await runtime.within(() =>
          options.application.finishResolutionLearningWork(
            access.access,
            command,
          ),
        );
        return result.status === "unknown"
          ? { outcome: "pending", stage: "delivery" }
          : { outcome: "held", reason, result };
      } catch {
        /* Exact finish only; acceptance may already have cleared ownership. */
      }
    }
    return { outcome: "pending", stage: "delivery" };
  };
  try {
    const product = productSnapshot(claim);
    const support = await learningServiceAuthority(options, runtime);
    const knowledge = await learningKnowledgeAuthority(
      options.knowledgeAccess,
      runtime,
    );
    const configResult = await runtime.within(() =>
      options.configuration.resolve(undefined, runtime.signal),
    );
    if (configResult.outcome !== "ready")
      throw new AssistantBoundaryError("configuration_unavailable");
    const config: VerifiedLearningConfiguration = learningConfigurationSnapshot(
      configResult.configuration,
      timestamp(options.clock.now()),
    );
    const policyResult = await runtime.within(() =>
      options.checks.resolvePolicy(
        claim.work.checkPolicyVersion,
        runtime.signal,
      ),
    );
    if (policyResult.outcome !== "ready")
      throw new AssistantBoundaryError("check_policy_unavailable");
    const policy: VerifiedLearningCheckPolicy = learningCheckPolicySnapshot(
      policyResult.policy,
      timestamp(options.clock.now()),
    );
    if (
      claim.work.exactRequest !== undefined &&
      policy.version !== claim.work.checkPolicyVersion
    )
      throw new AssistantBoundaryError("check_policy_changed");
    const deadline = Math.min(
      runtime.deadline,
      timestamp(claim.leaseUntil),
      timestamp(claim.work.deadline),
      timestamp(config.dataControls.validUntil),
      timestamp(policy.validUntil),
    );
    const externalDeadline = deadline - reserve;
    runtime.ensure(externalDeadline);
    const scopeResult = await runtime.within(
      () =>
        options.targets.resolveScope(product, {
          deadline: new Date(externalDeadline).toISOString(),
          signal: runtime.signal,
        }),
      externalDeadline,
    );
    if (scopeResult.outcome !== "ready")
      throw new AssistantBoundaryError("target_scope_unavailable");
    const scope = scopeSnapshot(scopeResult.scope, maxExplicit);
    const source = await runtime.within(
      () =>
        options.application.readResolutionLearningSource(
          support.access,
          claim.fence.ticketId,
        ),
      externalDeadline,
    );
    if (canonical(learningSourceFence(source)) !== canonical(claim.sourceFence))
      throw new AssistantBoundaryError("source_changed");
    const own = learningSourceReference(source);
    let payload: DeliveryPayload;
    let targetDecisionHash: string;
    let receipt: string;
    let base: LearningKBTargetSnapshot | undefined;
    let binding: ResolutionLearningChecksBinding;
    if (claim.work.exactRequest !== undefined) {
      request = snapshot(claim.work.exactRequest);
      payload = payloadSnapshot(request.draftPayload, product, maxExplicit);
      if (
        request.collectionId !== scope.collectionId ||
        canonical(payload.scope) !== canonical(scope) ||
        payload.configurationHash !== (await fingerprint(config)) ||
        payload.policyBinding !== policy.binding ||
        claim.work.candidateHash === undefined ||
        claim.work.targetDecisionHash === undefined ||
        claim.work.verifiedCheckReceipt === undefined
      )
        throw new AssistantBoundaryError("prepared_request_changed");
      targetDecisionHash = claim.work.targetDecisionHash;
      receipt = scalar(claim.work.verifiedCheckReceipt);
      binding = await resolutionLearningDeliveryBinding({
        candidateHash: claim.work.candidateHash,
        sourceBindingHash: claim.sourceFence.sourceBindingHash,
        policyVersion: policy.version,
        targetDecisionHash,
        applicability: {
          productId: product.productId,
          version: product.version,
          buildId: product.buildId,
        },
        exactRequest: request,
      });
      if (
        request.sourceReferences.filter((reference) => reference.id === own.id)
          .length !== 1 ||
        !request.sourceReferences.some(
          (reference) => canonical(reference) === canonical(own),
        )
      )
        throw new AssistantBoundaryError("source_changed");
    } else {
      const candidate = claim.work.candidate;
      if (
        candidate === undefined ||
        claim.work.candidateHash !== (await fingerprint(candidate))
      )
        throw new AssistantBoundaryError("candidate_changed");
      const publishedMatches: PublishedArticleDto[] = [];
      const search = snapshot(
        await runtime.within(
          () =>
            options.knowledge.searchPublishedArticles(knowledge.access, {
              collectionId: scope.collectionId,
              query: scope.searchQuery,
              applicability: {
                productId: product.productId,
                productVersion: product.version,
                buildId: product.buildId,
              },
              limit: maxPublished,
            }),
          externalDeadline,
        ),
      );
      if (
        !Array.isArray(search.articles) ||
        search.articles.length > maxPublished
      )
        throw new AssistantBoundaryError("target_budget_exceeded");
      const ids = new Set<string>();
      for (const hint of search.articles) {
        scalar(hint.articleId);
        if (ids.has(hint.articleId))
          throw new AssistantBoundaryError("target_invalid");
        ids.add(hint.articleId);
        const article = snapshot(
          await runtime.within(
            () =>
              options.knowledge.getPublishedArticle(knowledge.access, {
                articleId: hint.articleId,
              }),
            externalDeadline,
          ),
        );
        if (
          article.articleId !== hint.articleId ||
          article.collectionId !== scope.collectionId ||
          article.kind !== scope.kind ||
          article.revision !== hint.revision ||
          article.contentHash !== hint.contentHash ||
          canonical(article.applicability) !==
            canonical({
              productId: product.productId,
              productVersion: product.version,
              buildId: product.buildId,
            })
        )
          throw new AssistantBoundaryError("target_changed");
        publishedMatches.push(article);
      }
      const explicitDrafts: DraftArticleDto[] = [];
      for (const articleId of scope.explicitDraftIds) {
        const observed = await readLearningKBTarget(
          options,
          knowledge.access,
          articleId,
          runtime,
          externalDeadline,
        );
        await confirmLearningKBReadability(
          options,
          knowledge.access,
          observed,
          runtime,
          externalDeadline,
        );
        if (observed.draft.revision.collectionId !== scope.collectionId)
          throw new AssistantBoundaryError("target_scope_invalid");
        explicitDrafts.push(observed.draft);
      }
      const newArticleId =
        "support-learning:" +
        (
          await fingerprint({
            ticketId: claim.fence.ticketId,
            sourceGeneration: claim.fence.sourceGeneration,
          })
        ).slice(0, 48);
      const selection = snapshot(
        await runtime.within(
          () =>
            options.targets.select(
              {
                candidate,
                scope,
                newArticleId,
                publishedMatches,
                explicitDrafts,
              },
              {
                sourceFence: claim.sourceFence,
                deadline: new Date(externalDeadline).toISOString(),
                signal: runtime.signal,
              },
            ),
          externalDeadline,
        ),
      );
      if (selection.outcome !== "selected")
        throw new AssistantBoundaryError("target_selection_held");
      scalar(selection.articleId);
      if (selection.operation === "create") {
        if (selection.articleId !== newArticleId)
          throw new AssistantBoundaryError("target_identity_invalid");
      } else if (selection.operation === "update") {
        if (
          !publishedMatches.some(
            (article) => article.articleId === selection.articleId,
          ) &&
          !scope.explicitDraftIds.includes(selection.articleId)
        )
          throw new AssistantBoundaryError("target_identity_invalid");
        base = await readLearningKBTarget(
          options,
          knowledge.access,
          selection.articleId,
          runtime,
          externalDeadline,
        );
        if (base.draft.revision.collectionId !== scope.collectionId)
          throw new AssistantBoundaryError("target_scope_invalid");
        const explicit = explicitDrafts.find(
          (article) => article.articleId === selection.articleId,
        );
        const approved = publishedMatches.find(
          (article) => article.articleId === selection.articleId,
        );
        if (
          (explicit !== undefined &&
            canonical(explicit) !== canonical(base.draft)) ||
          (explicit === undefined &&
            (approved === undefined ||
              approved.revision !== base.draft.revision.number ||
              approved.contentHash !== base.draft.revision.contentHash))
        )
          throw new AssistantBoundaryError("unseen_unpublished_draft");
        await confirmBaseContributors(
          options,
          knowledge.access,
          base,
          own,
          runtime,
          externalDeadline,
        );
      } else throw new AssistantBoundaryError("target_identity_invalid");
      const draft = draftSnapshot(selection.draft, scope, product);
      if (
        !candidate.validationRequirements.every((requirement) =>
          draft.content.text.includes(requirement),
        )
      )
        throw new AssistantBoundaryError("advisory_validation_missing");
      const requirements = snapshot(
        await runtime.within(
          () =>
            options.knowledge.getValidationRequirements(knowledge.access, {
              collectionId: scope.collectionId,
              kind: scope.kind,
            }),
          externalDeadline,
        ),
      );
      payload = snapshot({
        draft,
        scope,
        configurationHash: await fingerprint(config),
        policyBinding: policy.binding,
        requirements,
        base: base === undefined ? null : baseBinding(base),
      });
      targetDecisionHash = await fingerprint({
        operation: selection.operation,
        articleId: selection.articleId,
        draft,
        scope,
        base: payload.base,
        requirements,
      });
      const references =
        base === undefined ? [own] : [...base.provenance.snapshot.references];
      const ownIndex = references.findIndex(
        (reference) => reference.id === own.id,
      );
      if (ownIndex < 0) references.push(own);
      else references[ownIndex] = own;
      const identity = await fingerprint({
        sourceFence: claim.sourceFence,
        candidateHash: claim.work.candidateHash,
        targetDecisionHash,
      });
      request = snapshot({
        operation: selection.operation,
        articleId: selection.articleId,
        collectionId: scope.collectionId,
        draftPayload: canonical(payload),
        sourceReferences: learningReferencesSnapshot(references),
        originalExpectedGeneration: base?.draft.generation ?? 0,
        commandId: "learning-kb:" + identity.slice(0, 48),
        correlationId: "learning:" + identity.slice(0, 48),
      });
      text(request.draftPayload, 24_000);
      binding = await resolutionLearningDeliveryBinding({
        candidateHash: claim.work.candidateHash!,
        sourceBindingHash: claim.sourceFence.sourceBindingHash,
        policyVersion: policy.version,
        targetDecisionHash,
        applicability: candidate.applicability,
        exactRequest: request,
      });
      const workingSolution = claim.workingSolutionMessageIds.map((id) =>
        text(
          claim.messages.find((message) => message.messageId === id)?.body,
          20_000,
        ),
      );
      const checked = await runtime.within(
        () =>
          options.checks.check(
            {
              candidate,
              exactRequest: request!,
              workingSolution,
              targetComparison: {
                operation: selection.operation,
                ...(base === undefined
                  ? {}
                  : {
                      existingDraft: canonical(learningDraftFromRevision(base)),
                    }),
              },
              binding,
            },
            {
              purpose: "support_learning",
              deadline: new Date(externalDeadline).toISOString(),
              signal: runtime.signal,
            },
          ),
        externalDeadline,
      );
      if (checked.outcome !== "checked")
        throw new AssistantBoundaryError("independent_checks_held");
      receipt = scalar(checked.receipt);
    }
    const exactRequest = request;
    const verifyReceipt = async (phase: number): Promise<number> => {
      const verified = snapshot(
        await runtime.within(
          () => options.checks.verify(receipt, binding, runtime.signal),
          phase,
        ),
      );
      if (
        verified === null ||
        canonical(verified.binding) !== canonical(binding) ||
        [
          verified.privacy,
          verified.factual,
          verified.applicability,
          verified.duplication,
        ].some((value) => value !== "passed") ||
        timestamp(verified.verifiedAt) > timestamp(options.clock.now()) ||
        timestamp(verified.validUntil) <= timestamp(options.clock.now())
      )
        throw new AssistantBoundaryError("independent_checks_held");
      scalar(verified.verifierReceiptId);
      scalar(verified.verifierVersion);
      const receiptDeadline = timestamp(verified.validUntil);
      runtime.ensure(Math.min(phase, receiptDeadline));
      return receiptDeadline;
    };
    const verifyCurrent = async (
      phase: number,
    ): Promise<{
      support: typeof support;
      knowledge: typeof knowledge;
      receiptDeadline: number;
    }> => {
      const currentSupport = await learningServiceAuthority(
        options,
        runtime,
        phase,
      );
      const currentKnowledge = await learningKnowledgeAuthority(
        options.knowledgeAccess,
        runtime,
        phase,
      );
      if (
        canonical(currentSupport) !== canonical(support) ||
        canonical(currentKnowledge) !== canonical(knowledge)
      )
        throw new AssistantBoundaryError("authority_changed");
      if (
        (await runtime.within(
          () =>
            options.application.confirmResolutionLearningSource(
              currentSupport.access,
              claim.sourceFence,
            ),
          phase,
        )) !== true
      )
        throw new AssistantBoundaryError("source_changed");
      let foreign = false;
      for (const reference of learningReferencesSnapshot(
        exactRequest.sourceReferences,
      )) {
        if (
          (await runtime.within(
            () =>
              options.sources.canRead({
                access: currentKnowledge.access,
                articleId: exactRequest.articleId,
                reference,
              }),
            phase,
          )) !== true
        )
          throw new AssistantBoundaryError("source_unreadable");
        if (reference.system !== supportDeskLearningSourceSystem) {
          foreign = true;
          continue;
        }
        const contributor = await runtime.within(
          () =>
            options.application.readResolutionLearningSource(
              currentSupport.access,
              reference.resourceId,
            ),
          phase,
        );
        if (
          canonical(learningSourceReference(contributor)) !==
            canonical(reference) ||
          (await runtime.within(
            () =>
              options.application.confirmResolutionLearningSource(
                currentSupport.access,
                learningSourceFence(contributor),
              ),
            phase,
          )) !== true
        )
          throw new AssistantBoundaryError("contributor_changed");
      }
      if (exactRequest.operation === "update") {
        const observed = await readLearningKBTarget(
          options,
          currentKnowledge.access,
          exactRequest.articleId,
          runtime,
          phase,
        );
        await confirmBaseContributors(
          options,
          currentKnowledge.access,
          observed,
          own,
          runtime,
          phase,
        );
        if (
          foreign &&
          (!exactRequest.sourceReferences
            .filter(
              (reference) =>
                reference.system !== supportDeskLearningSourceSystem,
            )
            .every((reference) =>
              observed.provenance.snapshot.references.some(
                (current) => canonical(current) === canonical(reference),
              ),
            ) ||
            (await runtime.within(
              () =>
                options.sources.isCurrent({
                  article: observed.draft.revision,
                  snapshot: observed.provenance.snapshot,
                }),
              phase,
            )) !== true)
        )
          throw new AssistantBoundaryError("contributor_changed");
      } else if (foreign)
        throw new AssistantBoundaryError("contributor_changed");
      const currentScope = await runtime.within(
        () =>
          options.targets.resolveScope(product, {
            deadline: new Date(phase).toISOString(),
            signal: runtime.signal,
          }),
        phase,
      );
      if (
        currentScope.outcome !== "ready" ||
        canonical(scopeSnapshot(currentScope.scope, maxExplicit)) !==
          canonical(scope)
      )
        throw new AssistantBoundaryError("target_scope_changed");
      const requirements = await runtime.within(
        () =>
          options.knowledge.getValidationRequirements(currentKnowledge.access, {
            collectionId: scope.collectionId,
            kind: scope.kind,
          }),
        phase,
      );
      if (canonical(requirements) !== canonical(payload.requirements))
        throw new AssistantBoundaryError("validation_policy_changed");
      const currentPolicy = await runtime.within(
        () => options.checks.resolvePolicy(policy.version, runtime.signal),
        phase,
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
      const receiptDeadline = await verifyReceipt(phase);
      const verifiedDeadline = Math.min(phase, receiptDeadline);
      const currentConfig = await runtime.within(
        () => options.configuration.resolve(config.version, runtime.signal),
        verifiedDeadline,
      );
      if (
        currentConfig.outcome !== "ready" ||
        canonical(
          learningConfigurationSnapshot(
            currentConfig.configuration,
            timestamp(options.clock.now()),
          ),
        ) !== canonical(config)
      )
        throw new AssistantBoundaryError("configuration_changed");
      runtime.ensure(verifiedDeadline);
      return {
        support: currentSupport,
        knowledge: currentKnowledge,
        receiptDeadline,
      };
    };
    await verifyCurrent(externalDeadline);
    if (base !== undefined) {
      const fresh = await readLearningKBTarget(
        options,
        knowledge.access,
        exactRequest.articleId,
        runtime,
        externalDeadline,
      );
      if (canonical(fresh) !== canonical(base))
        throw new AssistantBoundaryError("target_changed");
      await confirmBaseContributors(
        options,
        knowledge.access,
        fresh,
        own,
        runtime,
        externalDeadline,
      );
    }
    const prepareCommand: PrepareResolutionLearningStepCommand = snapshot({
      ...claim.fence,
      step: "kb_delivery",
      candidateHash: claim.work.candidateHash!,
      verifiedCheckReceipt: receipt,
      policyVersion: policy.version,
      targetDecisionHash,
      exactRequest,
    });
    const checkPreparation = (
      ack: ResolutionLearningPreparedStep,
    ): Extract<ResolutionLearningPreparedStep, { step: "kb_delivery" }> => {
      if (ack.step !== "kb_delivery" || ack.requestHash !== binding.requestHash)
        throw new AssistantBoundaryError("preparation_mismatch");
      scalar(ack.stepId);
      return snapshot(ack);
    };
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const access = await learningServiceAuthority(
          options,
          runtime,
          externalDeadline,
        );
        prepared = checkPreparation(
          await runtime.within(
            () =>
              options.application.prepareResolutionLearningStep(
                access.access,
                prepareCommand,
              ),
            externalDeadline,
          ),
        );
        break;
      } catch {
        /* Unknown acknowledgement repeats only this complete request. */
      }
    }
    if (prepared === undefined) return { outcome: "pending", stage: "prepare" };
    let ack: ArticleAcknowledgement | undefined;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const current = await verifyCurrent(externalDeadline);
      const repeated = checkPreparation(
        await runtime.within(
          () =>
            options.application.prepareResolutionLearningStep(
              current.support.access,
              prepareCommand,
            ),
          externalDeadline,
        ),
      );
      if (canonical(repeated) !== canonical(prepared))
        throw new AssistantBoundaryError("preparation_mismatch");
      const verifiedCurrent = await verifyCurrent(externalDeadline);
      const mutationDeadline = Math.min(
        externalDeadline,
        verifiedCurrent.receiptDeadline,
      );
      runtime.ensure(mutationDeadline);
      invoked = true;
      try {
        const input = {
          articleId: exactRequest.articleId,
          collectionId: exactRequest.collectionId,
          draft: payload.draft,
          sourceReferences: exactRequest.sourceReferences,
          expectedGeneration: exactRequest.originalExpectedGeneration,
          commandId: exactRequest.commandId,
          correlationId: exactRequest.correlationId,
        };
        const accepted = await runtime.within(
          () =>
            exactRequest.operation === "create"
              ? options.knowledge.createDraft(current.knowledge.access, input)
              : options.knowledge.updateDraft(current.knowledge.access, input),
          mutationDeadline,
        );
        ack = acknowledgement(accepted.value, exactRequest.articleId);
        break;
      } catch {
        /* Every invoked failure can follow a commit; replay exactly. */
      }
    }
    if (ack === undefined) return await finish("kb_acceptance_unknown");
    const actual = await readLearningKBTarget(
      options,
      knowledge.access,
      exactRequest.articleId,
      runtime,
      deadline,
    );
    await confirmLearningKBCurrent(
      options,
      knowledge.access,
      actual,
      runtime,
      deadline,
    );
    if (
      actual.draft.revision.collectionId !== exactRequest.collectionId ||
      actual.draft.revision.kind !== scope.kind ||
      canonical(actual.draft.revision.applicability) !==
        canonical(payload.draft.applicability) ||
      canonical(actual.provenance.snapshot.references) !==
        canonical(exactRequest.sourceReferences) ||
      canonical(actual.draft.revision.validationPolicy) !==
        canonical(payload.requirements.validationPolicy)
    )
      throw new AssistantBoundaryError("target_changed");
    const target = await learningTargetBinding(
      actual.draft.revision,
      actual.provenance.snapshot,
    );
    const completeCommand: CompleteResolutionLearningStepCommand = snapshot({
      ...claim.fence,
      step: "kb_delivery",
      stepId: prepared.stepId,
      requestHash: prepared.requestHash,
      historicalAck: ack,
      currentTargetBinding: target,
    });
    const guard = async (): Promise<void> => {
      try {
        const current = await verifyCurrent(deadline);
        const guardDeadline = Math.min(deadline, current.receiptDeadline);
        const observed = await readLearningKBTarget(
          options,
          current.knowledge.access,
          exactRequest.articleId,
          runtime,
          guardDeadline,
        );
        if (canonical(observed) !== canonical(actual))
          throw new AssistantBoundaryError("target_changed");
        await confirmLearningKBCurrent(
          options,
          current.knowledge.access,
          observed,
          runtime,
          guardDeadline,
        );
        runtime.ensure(guardDeadline);
      } catch (error) {
        throw new DeliveryGuardFailure(
          error instanceof AssistantBoundaryError
            ? error.category
            : "verification_unavailable",
        );
      }
    };
    let uncertainCompletion = false;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const current = await learningServiceAuthority(
          options,
          runtime,
          deadline,
        );
        const result = await runtime.within(
          () =>
            options.application.completeResolutionLearningStep(
              current.access,
              completeCommand,
              guard,
            ),
          deadline,
        );
        return result.status === "completed"
          ? { outcome: "delivered", result }
          : { outcome: "held", reason: "kb_target_changed", result };
      } catch (error) {
        if (error instanceof DeliveryGuardFailure && !uncertainCompletion)
          return await finish(error.category);
        uncertainCompletion = true;
      }
    }
    return { outcome: "pending", stage: "complete" };
  } catch (error) {
    return await finish(
      error instanceof AssistantBoundaryError
        ? error.category
        : error instanceof KnowledgeBaseNotFoundError
          ? "target_unavailable"
          : "learning_delivery_unavailable",
    );
  }
}
