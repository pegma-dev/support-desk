/** Runnable fictional host: public SDKs and real Store operations; scripted external systems. */
import { fixedClock, type Clock } from "@pegma/spine";
import { createMemoryStore, type Store } from "@pegma/storage-core";
import { articleKinds } from "@pegma/knowledge-base-contracts";
import {
  createKnowledgeBaseApplication,
  type KnowledgeBaseApplication,
} from "@pegma/knowledge-base-application";
import { createSupportDeskApplication } from "@pegma/support-desk-application";
import {
  createSupportDeskAssistant,
  createSupportDeskEngineering,
  createSupportDeskLearning,
  createSupportDeskLearningSourceVerifier,
  createSupportDeskReleaseFollowup,
  learningTargetBinding,
} from "@pegma/support-desk-ai";
import {
  createSyntheticPorts,
  ensure,
  same,
  syntheticApplicability,
  syntheticAudience,
  syntheticGuideText,
  syntheticPrivateNote,
  syntheticProduct,
} from "./synthetic-ports.js";

export interface SyntheticAiExampleOptions {
  readonly store?: Store;
  readonly clock?: Clock;
  /** Use a fresh Store namespace or a distinct prefix for every run. */
  readonly idPrefix?: string;
}
export interface SyntheticAiExampleResult {
  readonly answer: {
    readonly ticketId: string;
    readonly assistantMessageCount: number;
    readonly customerVisibleBodies: readonly string[];
    readonly humanTakeover: boolean;
    readonly citationArticleIds: readonly string[];
  };
  readonly learning: {
    readonly articleId: string;
    readonly sourceGeneration: number;
    readonly draftState: string;
    readonly excludedFromRetrieval: boolean;
    readonly retrievedArticleIds: readonly string[];
    readonly sourceReferenceCount: number;
  };
  readonly engineering: {
    readonly ticketId: string;
    readonly operation: "link_existing_issue";
    readonly issueId: string;
    readonly accepted: boolean;
  };
  readonly followup: {
    readonly workId: string;
    readonly messageId: string;
    readonly delivered: boolean;
    readonly kbProposalPrepared: boolean;
    readonly retestRequestCount: number;
    readonly ticketStatusBefore: string;
    readonly ticketStatusAfter: string;
    readonly customerNoticeCount: number;
    readonly postReplaySameMessage: boolean;
  };
  readonly safety: {
    readonly privateNotesExcluded: boolean;
    readonly noWorkerNotice: boolean;
    /** Fictional first arguments only, for example tests. The CLI never prints these captures. */
    readonly providerInputs: readonly {
      readonly purpose: string;
      readonly serializedInput: string;
    }[];
  };
  readonly calls: {
    readonly answer: number;
    readonly learning: number;
    readonly engineering: number;
    readonly followup: number;
    readonly githubCreate: number;
    readonly providerNetwork: number;
    readonly mailSend: number;
    readonly setupPublications: number;
    readonly agentPublications: number;
  };
}

export async function runSyntheticAiExample(
  options: SyntheticAiExampleOptions = {},
): Promise<SyntheticAiExampleResult> {
  const prefix = options.idPrefix ?? "synthetic-ai";
  ensure(
    /^[a-zA-Z0-9-]{1,64}$/u.test(prefix),
    "idPrefix must be a short safe identifier",
  );
  const store = options.store ?? createMemoryStore();
  const clock = options.clock ?? fixedClock("2026-11-08T12:00:00.000Z");
  const external = await createSyntheticPorts(clock, prefix);
  const { ids, actors } = external;
  const application = createSupportDeskApplication({
    store,
    clock,
    assistantHandlingEnabled: true,
    assistantTurns: {},
    resolutionLearning: {
      enabled: true,
      productContext: external.productContext,
      checks: external.learningChecks,
    },
    engineering: {
      enabled: true,
      productContext: external.productContext,
      routing: external.routing,
      checks: external.engineeringChecks,
      repositoryMetadata: {
        async resolve(repositoryId) {
          return repositoryId === ids.repository ? external.repository : null;
        },
      },
      dispatchResults: external.dispatchResults,
    },
    engineeringFollowup: {
      enabled: true,
      releaseEvidence: external.releaseEvidence,
      checks: external.followupChecks,
      retestReceipts: {
        async verify() {
          return null;
        },
      },
    },
  });
  const sources = createSupportDeskLearningSourceVerifier({
    application,
    serviceAccess: external.serviceAccess(actors.learning),
    reviewPolicy: external.learningChecks,
    otherSources: external.otherSources,
    clock,
  });
  const knowledge = createKnowledgeBaseApplication({
    store,
    clock,
    privateSources: sources,
    evidenceVerifier: external.evidenceVerifier,
    retrieval: { tokenCounter: external.tokenCounter },
  });
  let ordinal = 0;
  const command = (label: string, ticketId: string) => ({
    commandId: `${prefix}-${label}-${++ordinal}`,
    correlationId: `${prefix}-run`,
    ticketId,
  });
  const kbCommand = (label: string, expectedGeneration: number) => ({
    commandId: `${prefix}-kb-${label}-${++ordinal}`,
    correlationId: `${prefix}-setup`,
    expectedGeneration,
  });

  // Explicit human setup is the only publication in this example. No coordinator receives this actor or publish method.
  await knowledge.createCollection(actors.setupAdmin, {
    ...kbCommand("collection", 0),
    collectionId: ids.collection,
    name: "Fictional workspace guides",
  });
  const validation = {
    id: `${prefix}-validation`,
    version: 1,
    requirements: [
      ...articleKinds.map((kind) => ({
        id: `${kind}-content`,
        kind,
        testKind: "content",
        maxAgeMilliseconds: 3_600_000,
        trustedRunnerIds: [actors.setupAdmin.principalId],
      })),
      {
        id: "walkthrough-workflow",
        kind: "walkthrough" as const,
        testKind: "workflow",
        maxAgeMilliseconds: 3_600_000,
        trustedRunnerIds: [actors.setupAdmin.principalId],
      },
    ],
  };
  await knowledge.putValidationPolicy(actors.setupAdmin, {
    ...kbCommand("validation", 0),
    policy: validation,
  });
  const collection = await knowledge.getCollection(actors.setupAdmin, {
    collectionId: ids.collection,
  });
  await knowledge.putGovernanceConfiguration(actors.setupAdmin, {
    ...kbCommand("governance", collection.generation),
    collectionId: ids.collection,
    configuration: {
      validationPolicy: { id: validation.id, version: validation.version },
      expectedStagingBuildId: syntheticProduct.buildId,
      trustedAttesterIds: [ids.attester],
    },
  });
  const preview = await knowledge.previewCollectionPolicy(actors.setupAdmin, {
    collectionId: ids.collection,
    uses: {
      portal: {
        enabled: true,
        audience: { kind: "permission", permission: syntheticAudience },
      },
      bot: {
        enabled: true,
        audience: { kind: "permission", permission: syntheticAudience },
      },
    },
  });
  await knowledge.updateCollectionPolicy(actors.setupAdmin, {
    ...kbCommand("audience", preview.generation),
    collectionId: ids.collection,
    preview: preview.preview,
  });
  await knowledge.createDraft(actors.setupAdmin, {
    ...kbCommand("draft", 0),
    articleId: ids.seedArticle,
    collectionId: ids.collection,
    draft: {
      kind: "explanation",
      title: "Export your workspace",
      summary: "Download workspace rows as CSV.",
      content: { format: "plain_text", text: syntheticGuideText },
      tags: ["workspace", "export", "csv"],
      applicability: syntheticApplicability,
    },
  });
  let seed = await knowledge.getDraft(actors.setupAdmin, {
    articleId: ids.seedArticle,
  });
  await knowledge.setProvenance(actors.setupAdmin, {
    ...kbCommand("provenance", seed.generation),
    articleId: ids.seedArticle,
    references: [external.manualReference],
  });
  seed = await knowledge.getDraft(actors.setupAdmin, {
    articleId: ids.seedArticle,
  });
  const governance = await knowledge.getGovernanceConfiguration(
    actors.setupAdmin,
    { collectionId: ids.collection },
  );
  const evidence: Parameters<
    KnowledgeBaseApplication["submitEvidence"]
  >[1]["evidence"] = {
    id: `${prefix}-seed-check`,
    articleId: ids.seedArticle,
    articleRevision: seed.revision.number,
    contentHash: seed.revision.contentHash,
    validationPolicy: seed.revision.validationPolicy,
    checkId: "explanation-content",
    testKind: "content",
    applicability: seed.revision.applicability,
    stagingBuildId: syntheticProduct.buildId,
    steps: [
      "Read the fictional export guide and inspect the scripted CSV scenario.",
    ],
    result: "passed",
    executedAt: clock.now(),
    runnerId: actors.setupAdmin.principalId,
    artifacts: [{ id: "synthetic-only-artifact", hash: "a".repeat(64) }],
  };
  const receipt = await external.signer.issue("kb", {
    access: actors.setupAdmin,
    article: seed.revision,
    submission: evidence,
    configuration: governance.configuration,
  });
  await knowledge.submitEvidence(actors.setupAdmin, {
    ...kbCommand("evidence", seed.generation),
    articleId: ids.seedArticle,
    evidence,
    receipt,
  });
  seed = await knowledge.getDraft(actors.setupAdmin, {
    articleId: ids.seedArticle,
  });
  await knowledge.submitForReview(actors.setupAdmin, {
    ...kbCommand("review", seed.generation),
    articleId: ids.seedArticle,
  });
  const review = await knowledge.getReview(actors.setupAdmin, {
    articleId: ids.seedArticle,
  });
  await knowledge.publishArticle(actors.setupAdmin, {
    ...kbCommand("publish", review.generation),
    articleId: ids.seedArticle,
    review: review.review,
  });
  external.calls.setupPublications += 1;
  let indexed = false;
  for (let pass = 0; pass < 16; pass += 1) {
    const result = await knowledge.repairArticleIndex(actors.setupAdmin, {
      articleId: ids.seedArticle,
    });
    ensure(result.status !== "blocked", "approved seed indexing blocked");
    if (result.status === "ready" && result.indexed) {
      indexed = true;
      break;
    }
  }
  ensure(indexed, "approved seed did not index within sixteen passes");

  const citationArticleIds: string[] = [];
  const assistant = createSupportDeskAssistant({
    application,
    clock,
    knowledge: {
      retrieveAnswerSources: knowledge.retrieveAnswerSources,
      confirmAnswerSources: knowledge.confirmAnswerSources,
    },
    serviceAccess: async () => actors.assistant,
    configuration: {
      async resolve() {
        return { outcome: "ready", configuration: external.answerConfig };
      },
    },
    customerAuthority: {
      async resolve(principalId) {
        return principalId === actors.customer.principalId
          ? {
              outcome: "ready",
              authority: {
                access: actors.customer,
                audienceVersion: "synthetic-audience-v1",
                policyVersion: "synthetic-policy-v1",
                usageScopeRef: "PRIVATE_EXAMPLE_CUSTOMER_SCOPE",
                collectionIds: [ids.collection],
                applicability: syntheticApplicability,
              },
            }
          : { outcome: "inactive" };
      },
    },
    tokenCounter: external.tokenCounter,
    usage: external.usage,
    model: {
      async generate(input, context) {
        citationArticleIds.push(
          ...context.allSourceReferences.map(
            (reference) => reference.articleId,
          ),
        );
        return external.modelResult("answer", input, {
          kind: "answer",
          text: syntheticGuideText,
          citations: context.allSourceReferences,
        });
      },
    },
  });
  await application.createCustomerTicket(actors.customer, {
    ...command("ask", ids.answerTicket),
    messageId: `${prefix}-question`,
    subject: "How do I export my workspace?",
    body: "How do I export workspace rows as CSV?",
    initialHandling: "assistant",
  });
  await application.addNote(actors.staff, {
    ...command("private-note", ids.answerTicket),
    messageId: `${prefix}-private-note`,
    body: syntheticPrivateNote,
  });
  const answerPage = await assistant.scanCandidates({ limit: 100 });
  const turn = answerPage.candidates.find(
    (candidate) => candidate.ticketId === ids.answerTicket,
  );
  ensure(turn, "assistant turn missing from bounded scan");
  const answered = await assistant.processTurn({
    ...turn,
    workerId: `${prefix}-answer-worker`,
    leaseMilliseconds: 30_000,
  });
  ensure(
    answered.outcome === "completed",
    "assistant did not commit an answer",
  );
  await application.requestPerson(
    actors.customer,
    command("request-person", ids.answerTicket),
  );
  let answerStaff = await application.readStaffTicket(
    actors.staff,
    ids.answerTicket,
  );
  await application.takeOverTicket(actors.staff, {
    ...command("takeover", ids.answerTicket),
    expectedRevision: answerStaff.ticket.revision,
    expectedHandlingGeneration: answerStaff.ticket.handling?.generation ?? 0,
  });
  await application.replyAsStaff(actors.staff, {
    ...command("solution", ids.answerTicket),
    messageId: `${prefix}-verified-solution`,
    body: "Refresh Workspace, retry Export, and download the completed CSV file.",
  });
  await application.resolveTicket(
    actors.staff,
    command("human-resolve", ids.answerTicket),
  );
  answerStaff = await application.readStaffTicket(
    actors.staff,
    ids.answerTicket,
  );
  await application.enrollResolutionLearning(actors.staff, {
    ...command("enroll-learning", ids.answerTicket),
    expectedRevision: answerStaff.ticket.revision,
  });
  const answerView = await application.readCustomerTicket(
    actors.customer,
    ids.answerTicket,
  );
  await application.confirmCustomerSuccess(actors.customer, {
    ...command("confirm-success", ids.answerTicket),
    lastSeenVisibleMessageId: answerView.messages.at(-1)!.id,
  });
  const resolution = await application.readResolutionLearningSource(
    actors.staff,
    ids.answerTicket,
  );
  ensure(
    resolution.state === "eligible",
    "actual customer confirmation did not qualify learning",
  );
  const learning = createSupportDeskLearning({
    application,
    clock,
    sources,
    knowledge: {
      searchPublishedArticles: knowledge.searchPublishedArticles,
      getPublishedArticle: knowledge.getPublishedArticle,
      getDraft: knowledge.getDraft,
      getProvenance: knowledge.getProvenance,
      getValidationRequirements: knowledge.getValidationRequirements,
      createDraft: knowledge.createDraft,
      updateDraft: knowledge.updateDraft,
      retireArticle: knowledge.retireArticle,
    },
    serviceAccess: external.serviceAccess(actors.learning),
    knowledgeAccess: external.knowledgeAccess(actors.draft),
    retirementAccess: external.knowledgeAccess(actors.retirement),
    checks: external.learningChecks,
    configuration: {
      async resolve() {
        return { outcome: "ready", configuration: external.learningConfig };
      },
    },
    usage: external.usage,
    tokenCounter: external.tokenCounter,
    model: {
      async generate(input) {
        return external.modelResult("learning", input, {
          problem: "Retry a stalled workspace CSV export.",
          applicability: {
            productId: syntheticProduct.productId,
            version: syntheticProduct.version,
            buildId: syntheticProduct.buildId,
          },
          steps: ["Refresh Workspace.", "Retry Export."],
          solution: "Download the completed CSV file.",
          validationRequirements: [
            "Verify that the CSV contains workspace rows.",
          ],
        });
      },
    },
    targets: {
      async resolveScope() {
        return {
          outcome: "ready",
          scope: {
            version: "synthetic-learning-scope-v1",
            collectionId: ids.collection,
            kind: "explanation",
            searchQuery: "workspace export",
            explicitDraftIds: [],
          },
        };
      },
      async select(input) {
        return {
          outcome: "selected",
          operation: "create",
          articleId: input.newArticleId,
          draft: {
            kind: "explanation",
            title: "Retry a stalled workspace export",
            summary: input.candidate.problem,
            content: {
              format: "plain_text",
              text: [
                input.candidate.problem,
                ...input.candidate.steps,
                input.candidate.solution,
                ...input.candidate.validationRequirements,
              ].join("\n\n"),
            },
            tags: ["workspace", "export"],
            applicability: syntheticApplicability,
          },
        };
      },
    },
  });
  const learningCommand = {
    ticketId: ids.answerTicket,
    sourceGeneration: resolution.sourceGeneration,
    workerId: `${prefix}-learning-worker`,
    leaseMilliseconds: 30_000,
  };
  ensure(
    (await learning.processWork(learningCommand)).outcome === "candidate",
    "learning model stage failed",
  );
  const transferred = await learning.processWork(learningCommand);
  const deliveryDiagnostic =
    transferred.outcome === "held"
      ? `${transferred.outcome}:${transferred.reason}`
      : transferred.outcome;
  ensure(
    transferred.outcome === "delivered" && transferred.result.target,
    `checked private KB delivery failed (${deliveryDiagnostic})`,
  );
  const learnedId = transferred.result.target.articleId;
  const learned = await knowledge.getDraft(actors.draft, {
    articleId: learnedId,
  });
  const provenance = await knowledge.getProvenance(actors.draft, {
    articleId: learnedId,
  });
  const learningWork = await application.readResolutionLearningWork(
    actors.staff,
    {
      ticketId: ids.answerTicket,
      sourceGeneration: resolution.sourceGeneration,
    },
  );
  const learningCheckPolicy = await external.learningChecks.resolvePolicy(
    undefined,
    new AbortController().signal,
  );
  ensure(
    learningCheckPolicy.outcome === "ready",
    "learning check policy unavailable",
  );
  await learning.reviewProposal(actors.staff, {
    ...command("review-learning", ids.answerTicket),
    sourceGeneration: resolution.sourceGeneration,
    expectedWorkGeneration: learningWork.workGeneration,
    target: await learningTargetBinding(learned.revision, provenance.snapshot),
    decision: "approve",
    policyVersion: learningCheckPolicy.policy.version,
  });
  const retrieved = await knowledge.retrieveAnswerSources(actors.customer, {
    collectionIds: [ids.collection],
    query: "workspace export",
    applicability: syntheticApplicability,
    limit: 5,
  });
  const retrievedArticleIds = retrieved.sources.map(
    (source) => source.reference.articleId,
  );
  ensure(
    learned.state === "draft" && !retrievedArticleIds.includes(learnedId),
    "private learning draft entered approved retrieval",
  );

  await application.createCustomerTicket(actors.customer, {
    ...command("bug", ids.bugTicket),
    messageId: `${prefix}-bug-report`,
    subject: "CSV export drops rows",
    body: "Exporting a two-row workspace produces an empty CSV file.",
  });
  await application.addNote(actors.staff, {
    ...command("bug-note", ids.bugTicket),
    messageId: `${prefix}-bug-private-note`,
    body: syntheticPrivateNote,
  });
  const policy = await application.readRepositoryPolicy(actors.staff);
  const approvedPolicy = await application.putRepositoryPolicy(actors.staff, {
    commandId: `${prefix}-repository-policy`,
    correlationId: `${prefix}-run`,
    expectedGeneration: policy.generation,
    policy: external.repositoryPolicy,
  });
  external.bindRepositoryPolicy(approvedPolicy.policyHash);
  const bugStaff = await application.readStaffTicket(
    actors.staff,
    ids.bugTicket,
  );
  await application.enrollEngineeringSource(actors.staff, {
    ...command("enroll-bug", ids.bugTicket),
    expectedRevision: bugStaff.ticket.revision,
  });
  await application.submitEngineeringEvidence(actors.staff, {
    ...command("verify-failure", ids.bugTicket),
    expectedRevision: bugStaff.ticket.revision,
    security: "ordinary",
    evidence: {
      kind: "staff_verified_failure",
      expectedBehavior: "CSV contains both workspace rows.",
      actualBehavior: "CSV contains no rows.",
      reproductionSteps: [
        "Create a workspace with two rows.",
        "Export CSV and inspect row count.",
      ],
      visibleMessageIds: [`${prefix}-bug-report`],
      verificationReference: "PRIVATE_EXAMPLE_STAFF_REPRODUCTION",
    },
  });
  const bugSource = await application.readEngineeringSource(
    actors.staff,
    ids.bugTicket,
  );
  const engineering = createSupportDeskEngineering({
    application,
    clock,
    policy: { resolve: (access) => application.readRepositoryPolicy(access) },
    serviceAccess: external.serviceAccess(actors.engineering),
    reconciliationAccess: external.serviceAccess(actors.reconciliation),
    routing: external.routing,
    checks: external.engineeringChecks,
    configuration: {
      async resolve() {
        return { outcome: "ready", configuration: external.engineeringConfig };
      },
    },
    usage: external.usage,
    tokenCounter: external.tokenCounter,
    model: {
      async generate(input) {
        return external.modelResult("engineering", input, {
          title: "CSV export omits workspace rows",
          summary: "A reproducible export failure.",
          expectedBehavior: "CSV contains both workspace rows.",
          actualBehavior: "CSV contains no rows.",
          reproductionSteps: ["Create two rows.", "Export CSV."],
          applicability: {
            productId: syntheticProduct.productId,
            version: syntheticProduct.version,
            buildId: syntheticProduct.buildId,
          },
          security: "ordinary",
          routing: {
            outcome: "selected",
            repositoryId: ids.repository,
            alternativeRepositoryIds: [],
            rationale: "This repository owns workspace exports.",
          },
        });
      },
    },
    github: {
      async getMetadata(repositoryId) {
        return repositoryId === ids.repository
          ? {
              repository: external.repository,
              authority: {
                active: true,
                binding: "PRIVATE_EXAMPLE_INSTALLATION_AUTHORITY",
                validUntil: external.validUntil,
              },
            }
          : null;
      },
      async searchDuplicates() {
        return {
          issues: [
            {
              ...external.acknowledgement,
              title: "CSV export drops rows",
              body: "Synthetic known export issue.",
            },
          ],
          physicalResults: 1,
        };
      },
      async createIssue() {
        external.calls.githubCreate += 1;
        throw new Error(
          "GitHub issue creation is disabled in the synthetic example",
        );
      },
      async reconcile(input) {
        return input.repositoryId === ids.repository &&
          input.issueId === ids.issue
          ? {
              outcome: "accepted",
              acknowledgement: external.acknowledgement,
              proof: await external.signer.issue("github", input),
            }
          : { outcome: "unknown" };
      },
    },
    proposals: {
      async duplicateQuery() {
        return "workspace CSV export";
      },
      async prepare(input) {
        return {
          outcome: "prepared",
          request: {
            operation: "link_existing_issue",
            repository: input.repository,
            issueId: ids.issue,
            issueNumber: 17,
            bundle: {
              title: "CSV export drops rows",
              body: `Create two workspace rows and export CSV. Expected two rows; observed none.\n\n${input.exportMarker}`,
              labels: ["bug"],
              evidenceReferences: [],
              exportMarker: input.exportMarker,
            },
          },
        };
      },
    },
  });
  const engineeringCommand = {
    ticketId: ids.bugTicket,
    sourceGeneration: bugSource.sourceGeneration,
    workerId: `${prefix}-engineering-worker`,
    leaseMilliseconds: 30_000,
  };
  ensure(
    (await engineering.processWork(engineeringCommand)).outcome === "candidate",
    "bug assessment failed",
  );
  ensure(
    (await engineering.processWork(engineeringCommand)).outcome === "prepared",
    "checked existing-issue proposal failed",
  );
  const engineeringWork = await application.readEngineeringWork(actors.staff, {
    ticketId: ids.bugTicket,
    sourceGeneration: bugSource.sourceGeneration,
  });
  ensure(engineeringWork.proposal, "engineering exact proposal missing");
  await engineering.reviewProposal(actors.staff, {
    ...command("review-export", ids.bugTicket),
    sourceGeneration: bugSource.sourceGeneration,
    expectedWorkGeneration: engineeringWork.workGeneration,
    proposalHash: engineeringWork.proposal.proposalHash,
    decision: "approve",
  });
  ensure(
    (await engineering.processWork(engineeringCommand)).outcome ===
      "dispatched",
    "reviewed existing-issue association failed",
  );
  const association = await application.readEngineeringWork(actors.staff, {
    ticketId: ids.bugTicket,
    sourceGeneration: bugSource.sourceGeneration,
  });
  ensure(
    association.status === "accepted" &&
      association.acknowledgement?.issueId === ids.issue,
    "accepted engineering acknowledgement missing",
  );

  const observed = await application.observeEngineeringFollowup(
    actors.deploymentObserver,
    {
      ...command("deployment", ids.bugTicket),
      association: { repositoryId: ids.repository, issueId: ids.issue },
      inputReference: ids.releaseInput,
    },
  );
  ensure(
    observed.outcome === "queued" && observed.workId,
    "confirmed deployment did not queue follow-up",
  );
  const followupKey = { ticketId: ids.bugTicket, workId: observed.workId };
  const followup = createSupportDeskReleaseFollowup({
    application,
    clock,
    serviceAccess: external.serviceAccess(actors.followup),
    releaseEvidence: external.releaseEvidence,
    checks: external.followupChecks,
    usage: external.usage,
    tokenCounter: external.tokenCounter,
    configuration: {
      async resolve() {
        return { outcome: "ready", configuration: external.followupConfig };
      },
    },
    evaluations: {
      async resolve() {
        return {
          outcome: "ready",
          evaluation: {
            version: external.followupConfig.evaluationVersion,
            artifactRef: "PRIVATE_EXAMPLE_FOLLOWUP_EVALUATION",
            modelVersion: external.followupConfig.modelVersion,
            promptVersion: external.followupConfig.promptVersion,
            parserVersion: external.followupConfig.parserVersion,
            verifiedAt: external.verifiedAt,
            validUntil: external.validUntil,
          },
        };
      },
    },
    model: {
      async generate(input) {
        return external.modelResult("followup", input, {
          customerDraft: {
            body: "The workspace update is deployed and corrects the CSV export. Please retry exporting your workspace.",
          },
          kbProposal: {
            summary: "Update CSV export guidance for the deployed correction.",
            changes: [
              "Explain that the deployed correction preserves workspace rows.",
            ],
            advisoryValidationRequirements: [
              "Retest a workspace containing two rows.",
            ],
          },
          retestRequests: [
            {
              steps: [
                "Create two workspace rows.",
                "Export CSV and inspect both rows.",
              ],
              expectedBehavior: "The CSV contains both rows.",
            },
          ],
        });
      },
    },
    targets: {
      async resolve() {
        return { kind: "article", articleId: learnedId };
      },
    },
    knowledge: {
      getDraft: knowledge.getDraft,
      getValidationRequirements: knowledge.getValidationRequirements,
    },
    knowledgeAccess: external.knowledgeAccess(actors.draft),
  });
  const beforeWorker = await application.readCustomerTicket(
    actors.customer,
    ids.bugTicket,
  );
  const followupCommand = {
    ...followupKey,
    workerId: `${prefix}-followup-worker`,
    leaseMilliseconds: 30_000,
  };
  ensure(
    (await followup.processWork(followupCommand)).outcome === "candidate",
    "follow-up model draft failed",
  );
  ensure(
    (await followup.processWork(followupCommand)).outcome === "prepared",
    "whole-bundle follow-up checks failed",
  );
  const prepared = await application.readEngineeringFollowupWork(
    actors.staff,
    followupKey,
  );
  ensure(prepared.preparedBundle, "follow-up checked bundle missing");
  const beforePost = await application.readCustomerTicket(
    actors.customer,
    ids.bugTicket,
  );
  const currentPostTicket = (
    await application.readStaffTicket(actors.staff, ids.bugTicket)
  ).ticket;
  const noWorkerNotice =
    beforeWorker.messages.length === beforePost.messages.length;
  ensure(noWorkerNotice, "worker sent a customer notice");
  const postCommand = {
    ...command("explicit-staff-post", ids.bugTicket),
    workId: followupKey.workId,
    expectedWorkGeneration: prepared.workGeneration,
    expectedTicketRevision: currentPostTicket.revision,
    bundleHash: prepared.preparedBundle.bundleHash,
    messageId: `${prefix}-staff-notice`,
  };
  const posted = await followup.approveAndPostWebUpdate(
    actors.staff,
    postCommand,
  );
  const replayed = await followup.approveAndPostWebUpdate(
    actors.staff,
    postCommand,
  );
  const delivered = await application.readEngineeringFollowupWork(
    actors.staff,
    followupKey,
  );
  const afterPost = await application.readCustomerTicket(
    actors.customer,
    ids.bugTicket,
  );
  const finalAnswer = await application.readCustomerTicket(
    actors.customer,
    ids.answerTicket,
  );
  const customerNoticeCount = afterPost.messages.filter(
    (message) => message.id === posted.messageId,
  ).length;
  const privateNotesExcluded = !JSON.stringify([
    finalAnswer.messages,
    afterPost.messages,
    external.providerInputs,
  ]).includes(syntheticPrivateNote);
  ensure(privateNotesExcluded, "private note escaped the staff view");
  ensure(
    customerNoticeCount === 1 && same(posted, replayed),
    "exact post replay duplicated or changed the notice",
  );
  ensure(
    beforePost.ticket.status === afterPost.ticket.status,
    "informational notice changed ticket status",
  );
  ensure(
    external.calls.githubCreate === 0 && external.calls.agentPublications === 0,
    "unexpected external or publication capability used",
  );
  return {
    answer: {
      ticketId: ids.answerTicket,
      assistantMessageCount: finalAnswer.messages.filter(
        (message) => message.authorKind === "assistant",
      ).length,
      customerVisibleBodies: finalAnswer.messages.map(
        (message) => message.body,
      ),
      humanTakeover: answerStaff.ticket.handling?.state === "human-active",
      citationArticleIds,
    },
    learning: {
      articleId: learnedId,
      sourceGeneration: resolution.sourceGeneration,
      draftState: learned.state,
      excludedFromRetrieval: !retrievedArticleIds.includes(learnedId),
      retrievedArticleIds,
      sourceReferenceCount: provenance.snapshot.references.length,
    },
    engineering: {
      ticketId: ids.bugTicket,
      operation: "link_existing_issue",
      issueId: ids.issue,
      accepted: true,
    },
    followup: {
      workId: followupKey.workId,
      messageId: posted.messageId,
      delivered: delivered.status === "delivered",
      kbProposalPrepared: prepared.preparedBundle.bundle.kbProposal !== null,
      retestRequestCount: prepared.preparedBundle.bundle.retestRequests.length,
      ticketStatusBefore: beforePost.ticket.status,
      ticketStatusAfter: afterPost.ticket.status,
      customerNoticeCount,
      postReplaySameMessage: same(posted, replayed),
    },
    safety: {
      privateNotesExcluded,
      noWorkerNotice,
      providerInputs: external.providerInputs,
    },
    calls: external.calls,
  };
}
