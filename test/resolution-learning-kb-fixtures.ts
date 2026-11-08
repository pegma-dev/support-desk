import type { AccessContext } from "@pegma/authorization-core";
import {
  createKnowledgeBaseApplication,
  type EvidenceVerificationRequest,
  type KnowledgeBaseApplication,
  type PrivateSourceReference,
  type PrivateSourcesVerifier,
} from "@pegma/knowledge-base-application";
import {
  articleKinds,
  knowledgePermissions,
  type ValidationPolicy,
} from "@pegma/knowledge-base-contracts";
import type { Store } from "@pegma/storage-core";
import {
  supportPermissions,
  supportRecords,
  type ResolutionLearningKey,
} from "@pegma/support-desk-application";
import { isDeepStrictEqual } from "node:util";
import { vi } from "vitest";
import { createSupportDeskLearning } from "../packages/ai/src/learning-coordinator.js";
import {
  learningSourceReference,
  learningTargetBinding,
} from "../packages/ai/src/learning-bindings.js";
import { createSupportDeskLearningSourceVerifier } from "../packages/ai/src/learning-sources.js";
import type {
  LearningArticleDraft,
  LearningKnowledgeAuthority,
  LearningTargetPort,
  LearningTargetScope,
  SupportDeskLearningOptions,
} from "../packages/ai/src/learning-integration-types.js";
import type {
  LearningChecksPort,
  LearningModelPort,
  LearningServiceAuthority,
  VerifiedLearningConfiguration,
  VerifiedLearningCheckPolicy,
} from "../packages/ai/src/learning-ports.js";
import { handlingBarrier, handlingStores } from "./handling-fixtures.js";
import {
  learningCustomer,
  learningService,
  learningStaff,
  resolutionLearningFixture,
} from "./resolution-learning-fixtures.js";

export const learningKbStores = handlingStores;
export const learningKbBarrier = handlingBarrier;
export const learningKbCollectionId = "learning-workspace-help";
export const learningKbAudience = "synthetic.workspace.customer";
export const learningKbProduct = {
  productId: "workspace",
  productVersion: "2.3.0",
  buildId: "build-verified-230",
};
export const learningKbCanaries = [
  "PRIVATE_KB_LEARNING_NOTE",
  "PRIVATE_KB_LEARNING_PROOF",
  "PRIVATE_KB_LEARNING_ARTIFACT",
  "PRIVATE_KB_LEARNING_ATTESTER",
  "PRIVATE_KB_LEARNING_ACCOUNT",
  "PRIVATE_KB_LEARNING_SCOPE",
];

type KnowledgeCall = {
  readonly operation: keyof KnowledgeBaseApplication;
  readonly args: readonly unknown[];
};
type KnowledgeInterceptor = (
  call: KnowledgeCall,
  invoke: () => Promise<unknown>,
) => Promise<unknown>;

function access(
  principalId: string,
  permissions: readonly string[],
): AccessContext {
  return {
    principalId,
    policyVersion: "synthetic-learning-authority-v1",
    roles: [],
    entitlements: [],
    permissions,
  };
}

/** Real Support and published KB applications; fake only host/provider attestations. */
export async function learningKbFixture(backing: Store) {
  const sourceRead = [
    supportPermissions.queueRead,
    supportPermissions.learningRead,
    supportPermissions.learningProcess,
  ];
  const actors = {
    admin: access("synthetic-learning-admin", [
      ...Object.values(knowledgePermissions),
      ...Object.values(supportPermissions),
      learningKbAudience,
    ]),
    draftService: access("synthetic-learning-draft-service", [
      knowledgePermissions.collectionRead,
      knowledgePermissions.articleRead,
      knowledgePermissions.draftRead,
      knowledgePermissions.draftWrite,
      knowledgePermissions.provenanceRead,
      knowledgePermissions.provenanceWrite,
      learningKbAudience,
      ...sourceRead,
    ]),
    retirementService: access("synthetic-learning-retirement-service", [
      knowledgePermissions.collectionRead,
      knowledgePermissions.draftRead,
      knowledgePermissions.provenanceRead,
      knowledgePermissions.retire,
      ...sourceRead,
    ]),
    guideAuthor: access("synthetic-learning-guide-runner", [
      knowledgePermissions.collectionRead,
      knowledgePermissions.draftRead,
      knowledgePermissions.evidenceSubmit,
      knowledgePermissions.reviewSubmit,
      knowledgePermissions.provenanceRead,
      ...sourceRead,
    ]),
    customer: access("synthetic-learning-customer", [
      knowledgePermissions.articleRead,
      learningKbAudience,
    ]),
    bot: access("synthetic-learning-bot-customer", [
      knowledgePermissions.articleRead,
      knowledgePermissions.botRead,
      learningKbAudience,
    ]),
    staff: access(learningStaff.principalId, [
      ...learningStaff.permissions,
      knowledgePermissions.draftRead,
      knowledgePermissions.provenanceRead,
    ]),
    service: learningService,
    supportCustomer: learningCustomer,
  };
  let ordinal = 0;
  const checkReceipts = new Map<
    string,
    Parameters<LearningChecksPort["verify"]>[1]
  >();
  const evidenceReceipts = new Map<
    string,
    Omit<EvidenceVerificationRequest, "receipt">
  >();
  const resolvePolicy = vi.fn<LearningChecksPort["resolvePolicy"]>(async () =>
    state.policyOutcome === "ready"
      ? { outcome: "ready", policy: structuredClone(state.policy) }
      : { outcome: state.policyOutcome },
  );
  const check = vi.fn<LearningChecksPort["check"]>(async (input) => {
    if (state.checkOutcome !== "checked")
      return { outcome: state.checkOutcome };
    const receipt = `independent-full-request-check:${++ordinal}`;
    checkReceipts.set(receipt, structuredClone(input.binding));
    return { outcome: "checked", receipt };
  });
  const verifyChecks = vi.fn<LearningChecksPort["verify"]>(
    async (receipt, binding) => {
      if (
        !state.checksReadable ||
        !isDeepStrictEqual(checkReceipts.get(receipt), binding)
      )
        return null;
      return {
        binding: structuredClone(binding),
        privacy: "passed",
        factual: "passed",
        applicability: "passed",
        duplication: "passed",
        verifierReceiptId: receipt,
        verifierVersion: "synthetic-independent-checks-v1",
        verifiedAt: support.clock.now(),
        validUntil: state.policy.validUntil,
      };
    },
  );
  const checks: LearningChecksPort = {
    resolvePolicy,
    check,
    verify: verifyChecks,
  };
  const support = resolutionLearningFixture(backing, {
    resolutionLearning: { checks },
  });
  const now = support.clock.now();
  const state = {
    serviceOutcome: "ready" as "ready" | "inactive" | "unavailable",
    serviceAuthority: {
      access: learningService,
      authorityVersion: "support-learning-service-v1",
      usageScopeRef: "PRIVATE_KB_LEARNING_SCOPE",
    } as LearningServiceAuthority,
    knowledgeOutcome: "ready" as "ready" | "inactive" | "unavailable",
    knowledgeAuthority: {
      access: actors.draftService,
      authorityVersion: "kb-draft-service-v1",
    } as LearningKnowledgeAuthority,
    retirementOutcome: "ready" as "ready" | "inactive" | "unavailable",
    retirementAuthority: {
      access: actors.retirementService,
      authorityVersion: "kb-retirement-service-v1",
    } as LearningKnowledgeAuthority,
    configurationOutcome: "ready" as "ready" | "disabled" | "unavailable",
    configuration: {
      purpose: "support_learning",
      version: "learning-kb-config-v1",
      promptVersion: "learning-kb-prompt-v1",
      modelVersion: "learning-kb-model-v1",
      provider: "synthetic-learning-provider",
      model: "synthetic-learning-model",
      pricingRef: "synthetic-learning-pricing-v1",
      trustedInstructions:
        "Generalize the verified visible solution into safe workspace guidance.",
      framingTokens: 20,
      budgets: {
        maxMessages: 20,
        maxInputBytes: 32_768,
        maxInputTokens: 32_768,
        maxContextTokens: 65_536,
        maxOutputBytes: 16_000,
        maxOutputTokens: 8_192,
        maxCandidateBytes: 16_000,
        maxDurationMilliseconds: 5_000,
        maxCostMicros: 10_000,
        currency: "USD",
        maxAttempts: 2,
      },
      dataControls: {
        status: "verified",
        purpose: "support_learning",
        configurationBinding: "learning-kb-config-v1",
        accountRef: "PRIVATE_KB_LEARNING_ACCOUNT",
        projectRef: "synthetic-learning-project",
        endpointRef: "synthetic-learning-endpoint",
        modelRef: "synthetic-learning-model",
        featuresRef: "synthetic-learning-features",
        exceptionsRef: "synthetic-learning-exceptions",
        intermediaryRefs: [],
        verifiedAt: now,
        validUntil: new Date(Date.parse(now) + 3_600_000).toISOString(),
      },
    } as VerifiedLearningConfiguration,
    policyOutcome: "ready" as "ready" | "disabled" | "unavailable",
    policy: {
      version: "synthetic-check-policy-v1",
      binding: "learning-kb-check-policy-binding-v1",
      verifiedAt: now,
      validUntil: new Date(Date.parse(now) + 3_600_000).toISOString(),
    } as VerifiedLearningCheckPolicy,
    checkOutcome: "checked" as "checked" | "held" | "unavailable",
    checksReadable: true,
    otherRead: true,
    otherCurrent: true,
    otherPublish: true,
    scope: {
      version: "learning-target-scope-v1",
      collectionId: learningKbCollectionId,
      kind: "explanation",
      searchQuery: "workspace export",
      explicitDraftIds: [],
    } as LearningTargetScope,
    scopeOutcome: "ready" as "ready" | "held" | "unavailable",
    selectionOutcome: "selected" as "selected" | "held" | "unavailable",
    targetArticleId: null as string | null,
    reserveOutcome: "reserved" as "reserved" | "denied" | "unavailable",
    usageReconciliation: "reconciled" as "reconciled" | "pending",
  };
  const resolveService = vi.fn<
    SupportDeskLearningOptions["serviceAccess"]["resolve"]
  >(async () =>
    state.serviceOutcome === "ready"
      ? { outcome: "ready", authority: structuredClone(state.serviceAuthority) }
      : { outcome: state.serviceOutcome },
  );
  const resolveKnowledge = vi.fn<
    SupportDeskLearningOptions["knowledgeAccess"]["resolve"]
  >(async () =>
    state.knowledgeOutcome === "ready"
      ? {
          outcome: "ready",
          authority: structuredClone(state.knowledgeAuthority),
        }
      : { outcome: state.knowledgeOutcome },
  );
  const resolveRetirement = vi.fn<
    SupportDeskLearningOptions["retirementAccess"]["resolve"]
  >(async () =>
    state.retirementOutcome === "ready"
      ? {
          outcome: "ready",
          authority: structuredClone(state.retirementAuthority),
        }
      : { outcome: state.retirementOutcome },
  );
  const resolveConfiguration = vi.fn<
    SupportDeskLearningOptions["configuration"]["resolve"]
  >(async () =>
    state.configurationOutcome === "ready"
      ? {
          outcome: "ready",
          configuration: structuredClone(state.configuration),
        }
      : { outcome: state.configurationOutcome },
  );
  const otherSources = {
    canRead: vi.fn<PrivateSourcesVerifier["canRead"]>(
      async () => state.otherRead,
    ),
    canPublish: vi.fn<PrivateSourcesVerifier["canPublish"]>(
      async () => state.otherPublish,
    ),
    isCurrent: vi.fn<PrivateSourcesVerifier["isCurrent"]>(
      async () => state.otherCurrent,
    ),
  };
  const verifier = createSupportDeskLearningSourceVerifier({
    application: support.app,
    serviceAccess: { resolve: resolveService },
    reviewPolicy: checks,
    otherSources,
    clock: support.clock,
  });
  const sources = {
    canRead: vi.fn<PrivateSourcesVerifier["canRead"]>((request) =>
      verifier.canRead(request),
    ),
    canPublish: vi.fn<PrivateSourcesVerifier["canPublish"]>((request) =>
      verifier.canPublish(request),
    ),
    isCurrent: vi.fn<PrivateSourcesVerifier["isCurrent"]>((request) =>
      verifier.isCurrent(request),
    ),
  };
  const kb = createKnowledgeBaseApplication({
    store: backing,
    clock: support.clock,
    privateSources: sources,
    evidenceVerifier: {
      async verify(request) {
        const { receipt, ...binding } = request;
        return isDeepStrictEqual(evidenceReceipts.get(receipt), binding)
          ? {
              id: receipt,
              verifiedBy: "PRIVATE_KB_LEARNING_ATTESTER",
              verifiedAt: support.clock.now(),
            }
          : null;
      },
    },
    retrieval: {
      tokenCounter: {
        count: (text) => new TextEncoder().encode(text).byteLength,
      },
    },
  });
  const knowledgeCalls: KnowledgeCall[] = [];
  let knowledgeInterceptor: KnowledgeInterceptor | undefined;
  const knowledge = new Proxy(
    { ...kb },
    {
      get(target, property) {
        const value: unknown = Reflect.get(target, property, target);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          const call: KnowledgeCall = {
            operation: property as keyof KnowledgeBaseApplication,
            args: structuredClone(args),
          };
          knowledgeCalls.push(call);
          const invoke = () =>
            Reflect.apply(value, kb, args) as Promise<unknown>;
          return knowledgeInterceptor === undefined
            ? invoke()
            : knowledgeInterceptor(call, invoke);
        };
      },
    },
  );
  const candidate = {
    problem: "Export a workspace to a downloadable file.",
    applicability: {
      productId: "workspace",
      version: "2.3.0",
      buildId: "build-verified-230",
    },
    steps: ["Open Workspace.", "Choose Export."],
    solution: "Download the completed workspace export.",
    validationRequirements: ["Verify that the downloaded export opens."],
  };
  let modelScript: LearningModelPort["generate"] = async () => ({
    outputJson: JSON.stringify(candidate),
    provider: state.configuration.provider,
    model: state.configuration.model,
    requestId: "synthetic-learning-kb-model-request",
    usage: {
      inputTokens: 100,
      outputTokens: 50,
      costMicros: 10,
      currency: "USD",
    },
  });
  const generate = vi.fn<LearningModelPort["generate"]>((...args) =>
    modelScript(...args),
  );
  const reserve = vi.fn<SupportDeskLearningOptions["usage"]["reserve"]>(
    async (context) =>
      state.reserveOutcome === "reserved"
        ? {
            outcome: "reserved",
            usageReservationId: context.usageReservationId,
          }
        : { outcome: state.reserveOutcome },
  );
  const reconcileUsage = vi.fn<
    SupportDeskLearningOptions["usage"]["reconcile"]
  >(async () => state.usageReconciliation);
  const resolveScope = vi.fn<LearningTargetPort["resolveScope"]>(async () =>
    state.scopeOutcome === "ready"
      ? { outcome: "ready", scope: structuredClone(state.scope) }
      : { outcome: state.scopeOutcome },
  );
  let selectionScript: LearningTargetPort["select"] = async (input) => {
    if (state.selectionOutcome !== "selected")
      return { outcome: state.selectionOutcome };
    const id = state.targetArticleId ?? input.newArticleId;
    const existing =
      input.explicitDrafts.find((draft) => draft.articleId === id)?.revision ??
      input.publishedMatches.find((article) => article.articleId === id);
    const text = [
      existing?.content.text,
      input.candidate.problem,
      ...input.candidate.steps,
      input.candidate.solution,
      ...input.candidate.validationRequirements,
    ]
      .filter(Boolean)
      .join("\n\n");
    return {
      outcome: "selected",
      operation: state.targetArticleId === null ? "create" : "update",
      articleId: id,
      draft: {
        kind: input.scope.kind,
        title: "Export your workspace",
        summary: "Download and verify a workspace export.",
        content: { format: "plain_text", text },
        tags: ["workspace", "export"],
        applicability: learningKbProduct,
      },
    };
  };
  const select = vi.fn<LearningTargetPort["select"]>((...args) =>
    selectionScript(...args),
  );
  const learning = createSupportDeskLearning({
    application: support.app,
    knowledge,
    sources,
    serviceAccess: { resolve: resolveService },
    knowledgeAccess: { resolve: resolveKnowledge },
    retirementAccess: { resolve: resolveRetirement },
    configuration: { resolve: resolveConfiguration },
    checks,
    model: { generate },
    usage: { reserve, reconcile: reconcileUsage },
    tokenCounter: {
      count: (text) => new TextEncoder().encode(text).byteLength,
    },
    targets: { resolveScope, select },
    clock: support.clock,
  });
  const command = (label: string, expectedGeneration: number) => ({
    commandId: `learning-kb:${label}:${++ordinal}`,
    correlationId: "synthetic-learning-kb",
    expectedGeneration,
  });
  const policy: ValidationPolicy = {
    id: "learning-kb-validation",
    version: 1,
    requirements: [
      ...articleKinds.map((kind) => ({
        id: `${kind}-content`,
        kind,
        testKind: "content",
        maxAgeMilliseconds: 3_600_000,
        trustedRunnerIds: [actors.guideAuthor.principalId],
      })),
      {
        id: "walkthrough-workflow",
        kind: "walkthrough",
        testKind: "workflow",
        maxAgeMilliseconds: 3_600_000,
        trustedRunnerIds: [actors.guideAuthor.principalId],
      },
    ],
  };
  async function setup() {
    await kb.createCollection(actors.admin, {
      ...command("collection", 0),
      collectionId: learningKbCollectionId,
      name: "Synthetic workspace learning",
    });
    await kb.putValidationPolicy(actors.admin, {
      ...command("validation-policy", 0),
      policy,
    });
    const collection = await kb.getCollection(actors.admin, {
      collectionId: learningKbCollectionId,
    });
    await kb.putGovernanceConfiguration(actors.admin, {
      ...command("governance", collection.generation),
      collectionId: learningKbCollectionId,
      configuration: {
        validationPolicy: { id: policy.id, version: policy.version },
        expectedStagingBuildId: learningKbProduct.buildId,
        trustedAttesterIds: ["PRIVATE_KB_LEARNING_ATTESTER"],
      },
    });
    const preview = await kb.previewCollectionPolicy(actors.admin, {
      collectionId: learningKbCollectionId,
      uses: {
        portal: {
          enabled: true,
          audience: { kind: "permission", permission: learningKbAudience },
        },
        bot: {
          enabled: true,
          audience: { kind: "permission", permission: learningKbAudience },
        },
      },
    });
    await kb.updateCollectionPolicy(actors.admin, {
      ...command("collection-policy", preview.generation),
      collectionId: learningKbCollectionId,
      preview: preview.preview,
    });
  }
  async function currentSourceContext(articleId: string) {
    const draft = await kb.getDraft(actors.admin, { articleId });
    const provenance = await kb.getProvenance(actors.admin, { articleId });
    return { article: draft.revision, snapshot: provenance.snapshot };
  }
  async function currentTarget(articleId: string) {
    const context = await currentSourceContext(articleId);
    return learningTargetBinding(context.article, context.snapshot);
  }
  async function issueGuideEvidence(articleId: string) {
    const initial = await kb.getDraft(actors.guideAuthor, { articleId });
    const requirements = await kb.getValidationRequirements(
      actors.guideAuthor,
      {
        collectionId: initial.revision.collectionId,
        kind: initial.revision.kind,
      },
    );
    for (const requirement of requirements.checks) {
      const current = await kb.getDraft(actors.guideAuthor, { articleId });
      const governance = await kb.getGovernanceConfiguration(actors.admin, {
        collectionId: current.revision.collectionId,
      });
      const evidence: Parameters<
        KnowledgeBaseApplication["submitEvidence"]
      >[1]["evidence"] = {
        id: `guide-evidence:${++ordinal}`,
        articleId,
        articleRevision: current.revision.number,
        contentHash: current.revision.contentHash,
        validationPolicy: current.revision.validationPolicy,
        checkId: requirement.id,
        testKind: requirement.testKind,
        applicability: current.revision.applicability,
        stagingBuildId: requirements.expectedStagingBuildId,
        steps: ["PRIVATE_KB_LEARNING_VERIFICATION_STEPS"],
        result: "passed",
        executedAt: support.clock.now(),
        runnerId: actors.guideAuthor.principalId,
        artifacts: [
          { id: "PRIVATE_KB_LEARNING_ARTIFACT", hash: "a".repeat(64) },
        ],
      };
      const receipt = `guide-attestation:${++ordinal}`;
      evidenceReceipts.set(
        receipt,
        structuredClone({
          access: actors.guideAuthor,
          article: current.revision,
          submission: evidence,
          configuration: governance.configuration,
        }),
      );
      await kb.submitEvidence(actors.guideAuthor, {
        ...command("guide-evidence", current.generation),
        articleId,
        evidence,
        receipt,
      });
    }
    return kb.getDraft(actors.guideAuthor, { articleId });
  }
  async function supportReview(articleId: string, ticketId = "ticket") {
    const source = await support.app.readResolutionLearningSource(
      learningStaff,
      ticketId,
    );
    const work = await support.app.readResolutionLearningWork(learningStaff, {
      ticketId,
      sourceGeneration: source.sourceGeneration,
    });
    const target = await currentTarget(articleId);
    await learning.reviewProposal(actors.staff, {
      ...support.command("actual-guide-review", ticketId),
      sourceGeneration: source.sourceGeneration,
      expectedWorkGeneration: work.workGeneration,
      target,
      decision: "approve",
      policyVersion: state.policy.version,
    });
    return target;
  }
  async function publish(articleId: string) {
    const draft = await kb.getDraft(actors.guideAuthor, { articleId });
    await kb.submitForReview(actors.guideAuthor, {
      ...command("submit-review", draft.generation),
      articleId,
    });
    const review = await kb.getReview(actors.admin, { articleId });
    await kb.publishArticle(actors.admin, {
      ...command("publish", review.generation),
      articleId,
      review: review.review,
    });
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const indexed = await kb.repairArticleIndex(actors.admin, { articleId });
      if (indexed.status === "ready" && indexed.indexed)
        return kb.getPublishedArticle(actors.customer, { articleId });
      if (indexed.status === "blocked")
        throw new Error(`Actual KB index blocked: ${indexed.reason}`);
    }
    throw new Error("Actual KB index exceeded sixteen bounded passes");
  }
  async function eligible(
    kind:
      | "customer_confirmation"
      | "staff_verified_fix"
      | "successful_test" = "customer_confirmation",
    ticketId = "ticket",
  ): Promise<ResolutionLearningKey> {
    const terminal = await support.terminal(ticketId);
    await support.app.addNote(learningStaff, {
      ...support.command("private-note", ticketId),
      messageId: `private-note:${ticketId}`,
      body: "PRIVATE_KB_LEARNING_NOTE",
    });
    if (kind === "customer_confirmation") await support.confirm(ticketId);
    else {
      const ticket = (
        await support.app.readStaffTicket(learningStaff, ticketId)
      ).ticket;
      const common = {
        ...support.command("eligible-proof", ticketId),
        expectedRevision: ticket.revision,
        resolutionCycle: terminal.source.resolutionCycle,
      };
      if (kind === "staff_verified_fix")
        await support.app.submitResolutionEvidence(learningStaff, {
          ...common,
          evidence: {
            kind,
            solutionMessageId: terminal.solutionMessageId,
            verificationReference: "PRIVATE_KB_LEARNING_PROOF",
          },
        });
      else {
        const trust = {
          ticketId,
          ticketRevision: ticket.revision,
          resolutionCycle: terminal.source.resolutionCycle,
          resolvedAt: ticket.resolvedAt!,
          actorId: learningStaff.principalId,
          acceptedAt: support.clock.now(),
        };
        const receipt = `trusted-ticket-test:${ticketId}`;
        support.trust.issueTest(receipt, {
          ...trust,
          product: support.trust.productFor(trust),
        });
        await support.app.submitResolutionEvidence(learningStaff, {
          ...common,
          evidence: {
            kind,
            solutionMessageId: terminal.solutionMessageId,
            receipt,
          },
        });
      }
    }
    const source = await support.app.readResolutionLearningSource(
      learningStaff,
      ticketId,
    );
    return { ticketId, sourceGeneration: source.sourceGeneration };
  }
  async function processToDraft(key?: ResolutionLearningKey) {
    const currentKey = key ?? {
      ticketId: "ticket",
      sourceGeneration: (await support.source()).sourceGeneration,
    };
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const result = await learning.processWork({
        ...currentKey,
        workerId: "synthetic-learning-worker",
        leaseMilliseconds: 30_000,
      });
      if (result.outcome === "delivered") {
        const work = await support.app.readResolutionLearningWork(
          learningStaff,
          currentKey,
        );
        if (work.target === undefined)
          throw new Error("Delivered work has no actual target");
        return kb.getDraft(actors.admin, { articleId: work.target.articleId });
      }
      if (result.outcome !== "candidate")
        throw new Error(
          `Expected model candidate or delivered draft, received ${JSON.stringify(result)}`,
        );
    }
    throw new Error("Learning fixture exceeded four bounded stage invocations");
  }
  await setup();
  return {
    backing,
    support,
    kb,
    learning,
    sources,
    access: actors,
    state,
    policy,
    command,
    checks,
    otherSources,
    ports: {
      knowledge,
      knowledgeCalls,
      resolveService,
      resolveKnowledge,
      resolveRetirement,
      resolveConfiguration,
      resolvePolicy,
      check,
      verifyChecks,
      generate,
      reserve,
      reconcileUsage,
      resolveScope,
      select,
    },
    setup,
    eligible,
    processToDraft,
    issueGuideEvidence,
    supportReview,
    currentTarget,
    currentSourceContext,
    publish,
    async reviewAndPublish(articleId: string, ticketId = "ticket") {
      await supportReview(articleId, ticketId);
      await issueGuideEvidence(articleId);
      return publish(articleId);
    },
    updateTarget(articleId: string) {
      state.targetArticleId = articleId;
      state.scope = { ...state.scope, explicitDraftIds: [articleId] };
    },
    setTargetScript(script: LearningTargetPort["select"]) {
      selectionScript = script;
    },
    setModel(script: LearningModelPort["generate"]) {
      modelScript = script;
    },
    interceptKnowledge(interceptor: KnowledgeInterceptor | undefined) {
      knowledgeInterceptor = interceptor;
    },
    async createGuide(
      articleId: string,
      text = "Existing independently verified export guidance.",
      references: readonly PrivateSourceReference[] = [],
    ) {
      const draft: LearningArticleDraft = {
        kind: "explanation",
        title: "Existing export guide",
        summary: "Existing workspace guidance.",
        content: { format: "plain_text", text },
        tags: ["workspace", "export"],
        applicability: learningKbProduct,
      };
      await kb.createDraft(actors.admin, {
        ...command("independent-guide", 0),
        articleId,
        collectionId: learningKbCollectionId,
        draft,
        sourceReferences: references,
      });
      return kb.getDraft(actors.admin, { articleId });
    },
    async publishIndependentGuide(
      articleId = "independent-export",
      text?: string,
      references: readonly PrivateSourceReference[] = [],
    ) {
      await this.createGuide(articleId, text, references);
      await issueGuideEvidence(articleId);
      return publish(articleId);
    },
    async deleteTicketBody(ticketId = "ticket") {
      await backing
        .collection(supportRecords)
        .delete({ partition: ticketId, id: "ticket" });
    },
    async reference(ticketId = "ticket") {
      return learningSourceReference(
        await support.app.readResolutionLearningSource(learningStaff, ticketId),
      );
    },
  };
}
