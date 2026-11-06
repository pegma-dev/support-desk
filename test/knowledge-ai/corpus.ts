import type {
  AcceptanceCase,
  CountedArtifactKind,
  FixtureInstance,
  FixtureValue,
  InstanceId,
  ScenarioId,
  TurnIdentity,
} from "./types.js";

/** Wholly fictional instances; these are not either launch host's topology. */
export const fixtureInstances: Readonly<Record<InstanceId, FixtureInstance>> = {
  workshop: {
    id: "workshop",
    customerId: "workshop/customer-1",
    staffId: "workshop/staff-1",
    agentId: "workshop/author-1",
    portalSource: {
      instanceId: "workshop",
      articleId: "export-guide",
      revision: 3,
    },
    botSource: {
      instanceId: "workshop",
      articleId: "export-retry",
      revision: 2,
    },
    staffSentinel: "STAFF_NOTE_WORKSHOP_7",
    provenanceSentinel: "PRIVATE_SOURCE_WORKSHOP_4",
    customerSentinel: "CUSTOMER_DETAIL_WORKSHOP_9",
    privateLink: "https://workshop.invalid/private/ticket-1",
    publicSentinel: "PUBLIC_GUIDE_WORKSHOP_3",
    repositories: {
      guides: {
        id: "workshop/repository-guides",
        visibility: "public",
        description: "Documentation guide rendering and guide export.",
      },
      product: {
        id: "workshop/repository-product",
        visibility: "private",
        description: "Product calculation and account workflows.",
      },
    },
  },
  observatory: {
    id: "observatory",
    customerId: "observatory/customer-1",
    staffId: "observatory/staff-1",
    agentId: "observatory/author-1",
    portalSource: {
      instanceId: "observatory",
      articleId: "export-guide",
      revision: 3,
    },
    botSource: {
      instanceId: "observatory",
      articleId: "export-retry",
      revision: 2,
    },
    staffSentinel: "STAFF_NOTE_OBSERVATORY_7",
    provenanceSentinel: "PRIVATE_SOURCE_OBSERVATORY_4",
    customerSentinel: "CUSTOMER_DETAIL_OBSERVATORY_9",
    privateLink: "https://observatory.invalid/private/ticket-1",
    publicSentinel: "PUBLIC_GUIDE_OBSERVATORY_3",
    repositories: {
      guides: {
        id: "observatory/repository-guides",
        visibility: "public",
        description: "Documentation guide rendering and guide export.",
      },
      product: {
        id: "observatory/repository-product",
        visibility: "private",
        description: "Product calculation and account workflows.",
      },
    },
  },
};

export const planScenarios: readonly ScenarioId[] = [
  "agent-authored-explanation",
  "agent-tested-walkthrough",
  "collection-audiences",
  "exact-publication",
  "ticket-backed-answer",
  "human-request-and-takeover",
  "unsupported-or-conflicting-guidance",
  "learning",
  "reopen-and-deletion",
  "bug-validity",
  "ai-routing",
  "private-public-export",
  "security-uncertainty",
  "external-call-failures",
  "released-fix",
  "out-of-order-and-rollback",
  "capacity-and-isolation",
  "zdr-and-disclosure",
];

/** Tiny boundary-test values, never proposed production defaults. */
export const fixtureBudgets = {
  physicalPages: 2,
  physicalRows: 4,
  candidates: 2,
  modelCalls: 2,
  inputTokens: 512,
  outputTokens: 128,
  attempts: 2,
} as const;

/** Proposed approval bindings to carry into later domain contracts. */
export const approvalBindingFields = [
  "contentRevision",
  "contentHash",
  "collectionId",
  "audiencePolicyRevision",
  "productBuild",
  "validationPolicyRevision",
  "evidenceIdsAndHashes",
  "runnerIdentity",
  "sourceTicketRevision",
  "resolutionGeneration",
  "reviewerIdentity",
  "approvedAt",
  "destinationRepositoryId",
  "destinationVisibility",
  "destinationPolicyRevision",
  "outboundContentHash",
  "confirmedDeploymentMapping",
] as const;

type SourceSet = "none" | "portal" | "both";
interface Template {
  readonly suffix: string;
  readonly scenario: ScenarioId;
  readonly owners: readonly string[];
  readonly input: Readonly<Record<string, FixtureValue>>;
  readonly steps: readonly string[];
  readonly outcome: string;
  readonly modelCalls?: number;
  readonly modelSources?: SourceSet;
  readonly portalSources?: SourceSet;
  readonly messageSources?: SourceSet;
  readonly committedTurns?: readonly TurnIdentity[];
  readonly withRepositories?: boolean;
  readonly repositoryTargets?: readonly {
    readonly kind: "draft" | "issue";
    readonly repository: "guides" | "product";
  }[];
  readonly counts?: Readonly<Partial<Record<CountedArtifactKind, number>>>;
}

// Oracles are authored expectations, not decisions calculated from input policy.
const templates: readonly Template[] = [
  {
    suffix: "author-explanation",
    scenario: "agent-authored-explanation",
    owners: ["KB-02", "KB-04", "PG-01", "RG-01"],
    input: {
      actor: "author",
      articleKind: "explanation",
      transport: ["api", "mcp"],
      githubConnected: false,
    },
    steps: [
      "Create a draft through API/MCP; submit content checks; staff approve that exact revision.",
    ],
    outcome: "published",
    counts: { publication: 1 },
  },
  {
    suffix: "tested-walkthrough",
    scenario: "agent-tested-walkthrough",
    owners: ["KB-02", "KB-04"],
    input: {
      articleKind: "walkthrough",
      contentRevision: 4,
      evidenceRevision: 4,
      stagingBuild: "fixture-build-7",
      trustedRunner: true,
    },
    steps: [
      "Attach successful staging evidence for revision 4/build 7; staff approve revision 4.",
    ],
    outcome: "published",
    counts: { publication: 1 },
  },
  {
    suffix: "wrong-evidence",
    scenario: "agent-tested-walkthrough",
    owners: ["KB-02", "KB-04"],
    input: {
      articleKind: "walkthrough",
      contentRevision: 4,
      evidenceRevision: 3,
      expectedBuild: "fixture-build-7",
      evidenceBuild: "fixture-build-6",
      trustedRunner: false,
    },
    steps: [
      "Submit wrong-revision, wrong-build, and untrusted-runner evidence as separate mutations; attempt approval.",
    ],
    outcome: "held",
  },
  {
    suffix: "collection-audiences",
    scenario: "collection-audiences",
    owners: ["KB-03", "SD-02", "PG-02", "RG-02"],
    input: {
      actor: "customer",
      collections: ["portal", "bot_only", "staff_only"],
      botAudienceApproved: true,
    },
    steps: [
      "Browse/search permitted portal content; ask an answered question using approved portal and bot-only knowledge.",
    ],
    outcome: "answered",
    modelCalls: 1,
    modelSources: "both",
    portalSources: "portal",
    messageSources: "both",
    counts: { portal: 1, message: 1 },
  },
  {
    suffix: "foreign-instance",
    scenario: "capacity-and-isolation",
    owners: ["KB-03", "SD-02", "PG-02", "RG-02"],
    input: {
      searchTitle: "Export guide",
      staleCandidateFromOtherInstance: true,
    },
    steps: [
      "Inject the other fictional instance's same-title article as a candidate; retrieve local approved guidance.",
    ],
    outcome: "answered",
    modelCalls: 1,
    modelSources: "portal",
    messageSources: "portal",
    counts: { message: 1 },
  },
  {
    suffix: "draft-revision",
    scenario: "exact-publication",
    owners: ["KB-03"],
    input: { sourceState: "draft", indexContainsCandidate: true },
    steps: ["Retrieve an unpublished revision from a stale index candidate."],
    outcome: "no_result",
    counts: { portal: 0, message: 0 },
  },
  {
    suffix: "edited-approval",
    scenario: "exact-publication",
    owners: ["KB-02"],
    input: { approvedRevision: 3, currentDraftRevision: 4 },
    steps: [
      "Edit the approved draft; attempt to publish revision 4 using revision 3 approval.",
    ],
    outcome: "held",
  },
  {
    suffix: "retired-source",
    scenario: "exact-publication",
    owners: ["KB-03", "SD-02"],
    input: { sourceState: "retired", staleCacheContainsCandidate: true },
    steps: ["Retire the candidate after indexing/cache fill; retrieve again."],
    outcome: "no_result",
    counts: { portal: 0, message: 0 },
  },
  {
    suffix: "ticket-first-message",
    scenario: "ticket-backed-answer",
    owners: ["SD-01", "SD-02"],
    input: { handling: "assistant", replayFirstMessage: true },
    steps: [
      "Submit first message twice with the same operation ID; complete the assistant turn.",
    ],
    outcome: "answered",
    modelCalls: 1,
    modelSources: "both",
    messageSources: "both",
    counts: { ticket: 1, message: 2, job: 1 },
  },
  {
    suffix: "human-request",
    scenario: "human-request-and-takeover",
    owners: ["SD-01"],
    input: { provider: "offline", customerRequestedPerson: true },
    steps: [
      "Request a person through the deterministic command during a provider outage.",
    ],
    outcome: "human_pending",
    counts: { job: 1 },
  },
  {
    suffix: "takeover-race",
    scenario: "human-request-and-takeover",
    owners: ["SD-01", "SD-02"],
    input: { generationDeferred: true, staffTakesOverBeforeCompletion: true },
    steps: [
      "Start generation, commit staff takeover, then complete the old model request.",
    ],
    outcome: "human_active",
    modelCalls: 1,
    modelSources: "both",
    counts: { message: 0 },
  },
  {
    suffix: "new-message-race",
    scenario: "ticket-backed-answer",
    owners: ["SD-02"],
    input: {
      ticketId: "ticket-1",
      oldOperationId: "old-turn",
      newOperationId: "new-turn",
      oldRevision: 1,
      newRevision: 2,
      oldGeneration: 1,
      newGeneration: 2,
      completionOrder: [2, 1],
    },
    steps: [
      "Start two turns; finish newer generation before old generation; capture only assistant commits.",
      "Prefix operation/ticket IDs with the instance ID; record the committed operation, ticket revision, and generation from durable state.",
    ],
    outcome: "answered",
    modelCalls: 2,
    modelSources: "both",
    messageSources: "both",
    committedTurns: [
      {
        operationId: "new-turn",
        ticketId: "ticket-1",
        revision: 2,
        generation: 2,
      },
    ],
    counts: { message: 1 },
  },
  {
    suffix: "unsupported-guidance",
    scenario: "unsupported-or-conflicting-guidance",
    owners: ["SD-02"],
    input: { approvedSources: [] },
    steps: ["Ask a question with no applicable approved guide."],
    outcome: "human_pending",
    counts: { job: 1 },
  },
  {
    suffix: "conflicting-guidance",
    scenario: "unsupported-or-conflicting-guidance",
    owners: ["SD-02"],
    input: { sourcesConflictForCurrentBuild: true },
    steps: [
      "Detect conflicting instructions for the same applicable build; preserve handoff context.",
    ],
    outcome: "human_pending",
    modelCalls: 1,
    modelSources: "both",
    counts: { job: 1 },
  },
  {
    suffix: "resolution-learning",
    scenario: "learning",
    owners: ["SD-03"],
    input: {
      resolutionEvidence: [
        "customer_confirmed",
        "staff_verified",
        "successful_test",
      ],
      resolutionGeneration: 2,
      repeatedWorker: true,
    },
    steps: [
      "Repeat separately for each qualifying evidence kind; run the source-generation worker twice; capture one generalized draft/update.",
    ],
    outcome: "drafted",
    modelCalls: 1,
    counts: { draft: 1 },
  },
  {
    suffix: "unverified-resolution",
    scenario: "learning",
    owners: ["SD-03"],
    input: { ticketStatus: "resolved", resolutionEvidence: "missing" },
    steps: [
      "Evaluate a resolved ticket without customer confirmation, staff verification, or a successful test; capture no learning model call or draft.",
    ],
    outcome: "human_review",
    counts: { draft: 0, held_draft: 0 },
  },
  {
    suffix: "reopened-source",
    scenario: "reopen-and-deletion",
    owners: ["SD-03"],
    input: { draftResolutionGeneration: 2, sourceReopenedGeneration: 3 },
    steps: [
      "Reopen before approval; attempt publication with old evidence and reconcile invalidation.",
    ],
    outcome: "held",
    counts: { held_draft: 1 },
  },
  {
    suffix: "deleted-source",
    scenario: "reopen-and-deletion",
    owners: ["SD-03"],
    input: { sourceDeleted: true, privateReferencePreviouslyVisible: true },
    steps: [
      "Delete/revoke source access; confirm reference revocation and dependent evidence reassessment.",
    ],
    outcome: "held",
    counts: { held_draft: 1 },
  },
  {
    suffix: "unverified-bug",
    scenario: "bug-validity",
    owners: ["SD-04"],
    input: { reproductionEvidence: "missing" },
    steps: [
      "Report an apparent mismatch without verified reproduction/test evidence.",
    ],
    outcome: "human_review",
  },
  {
    suffix: "verified-bug",
    scenario: "bug-validity",
    owners: ["SD-04"],
    input: {
      reproductionEvidence: "staff_verified",
      expectedBehaviorReference: "fixture-guide-3",
      publicationMode: "approval_required",
    },
    steps: [
      "Supply verified expected/actual mismatch; prepare a proposal but do not approve export.",
    ],
    outcome: "awaiting_approval",
    modelCalls: 1,
    counts: { draft: 1 },
  },
  {
    suffix: "confident-repository",
    scenario: "ai-routing",
    owners: ["SD-04"],
    input: {
      reproductionEvidence: "verified_guide_export_failure",
      calibratedGate: "accepted",
      publicationMode: "approval_required",
    },
    withRepositories: true,
    steps: [
      "Route a verified guide-rendering/export failure to the guide repository in this instance's supplied allowlist; prepare a destination-bound proposal without exporting.",
    ],
    outcome: "awaiting_approval",
    modelCalls: 1,
    counts: { draft: 1 },
    repositoryTargets: [{ kind: "draft", repository: "guides" }],
  },
  {
    suffix: "ambiguous-repository",
    scenario: "ai-routing",
    owners: ["SD-04"],
    input: {
      candidateDescriptionsOverlap: true,
      calibratedGate: "ambiguous",
    },
    withRepositories: true,
    steps: [
      "Produce closely competing allowed destinations; require human selection.",
    ],
    outcome: "human_review",
    modelCalls: 1,
  },
  {
    suffix: "out-of-scope-repository",
    scenario: "ai-routing",
    owners: ["SD-04"],
    input: {
      customerInstruction: "Send this to repository-not-allowlisted",
      allowlisted: false,
    },
    withRepositories: true,
    steps: [
      "Inject a destination instruction; verify a model suggestion cannot bypass the allowlist.",
    ],
    outcome: "human_review",
    modelCalls: 1,
  },
  {
    suffix: "public-export",
    scenario: "private-public-export",
    owners: ["SD-04"],
    input: {
      visibility: "public",
      reproduction: "synthetic",
      staffApproval: "exact_bundle",
      privateDetailsPresentInSource: true,
    },
    withRepositories: true,
    steps: [
      "Approve and export the exact sanitized public bundle; retain private source references only internally.",
    ],
    outcome: "exported",
    counts: { issue: 1 },
    repositoryTargets: [{ kind: "issue", repository: "guides" }],
  },
  {
    suffix: "visibility-change",
    scenario: "private-public-export",
    owners: ["SD-04"],
    input: { approvedVisibility: "private", currentVisibility: "public" },
    withRepositories: true,
    steps: [
      "Change repository visibility after approval; re-read metadata immediately before export.",
    ],
    outcome: "held",
  },
  {
    suffix: "private-export",
    scenario: "private-public-export",
    owners: ["SD-04"],
    input: {
      visibility: "private",
      staffApproval: "exact_bundle",
      sanitized: true,
    },
    withRepositories: true,
    steps: ["Approve and export a minimum-necessary sanitized private report."],
    outcome: "exported",
    counts: { issue: 1 },
    repositoryTargets: [{ kind: "issue", repository: "product" }],
  },
  {
    suffix: "security-review",
    scenario: "security-uncertainty",
    owners: ["SD-04"],
    input: { sensitivity: "uncertain_security", verifiedReproduction: true },
    steps: [
      "Route a reproduced but potentially sensitive vulnerability into restricted review.",
    ],
    outcome: "restricted_review",
  },
  {
    suffix: "ambiguous-export-acceptance",
    scenario: "external-call-failures",
    owners: ["SD-04"],
    input: {
      remoteCreateOutcome: "timeout_after_possible_acceptance",
      retryWorker: true,
    },
    steps: [
      "Timeout after a possible remote acceptance; repeat worker; capture outbound create attempts as job artifacts.",
    ],
    outcome: "reconciliation_required",
    counts: { job: 1 },
  },
  {
    suffix: "provider-failure",
    scenario: "external-call-failures",
    owners: ["SD-02"],
    input: { provider: "throws", retriesExhausted: true },
    steps: [
      "Exhaust bounded generation attempts; preserve ticket and request-person availability.",
    ],
    outcome: "human_pending",
    modelCalls: 2,
    modelSources: "both",
    counts: { message: 0 },
  },
  {
    suffix: "released-fix",
    scenario: "released-fix",
    owners: ["SD-05"],
    input: {
      deploymentMapping: "confirmed_applicable",
      staffApproval: "not_yet_granted",
    },
    steps: [
      "Confirm a deployed fix; prepare customer update and KB revision plus a local-agent retest request.",
    ],
    outcome: "awaiting_approval",
    modelCalls: 1,
    counts: { draft: 2, retest: 1 },
  },
  {
    suffix: "issue-closed-only",
    scenario: "released-fix",
    owners: ["SD-05"],
    input: { issueState: "closed", deploymentMapping: "missing" },
    steps: [
      "Receive issue closure with no confirmed applicable deployment evidence.",
    ],
    outcome: "awaiting_release",
    counts: { draft: 0, retest: 0 },
  },
  {
    suffix: "release-rollback",
    scenario: "out-of-order-and-rollback",
    owners: ["SD-05"],
    input: { releaseSequence: [7, 8, 7], rollbackConfirmed: true },
    steps: [
      "Prepare follow-up for build 8, roll it back, then deliver stale release events.",
    ],
    outcome: "held",
    counts: { held_draft: 2 },
  },
  {
    suffix: "duplicate-release",
    scenario: "out-of-order-and-rollback",
    owners: ["SD-05"],
    input: { deploymentMapping: "confirmed_applicable", repeatedEvent: true },
    steps: [
      "Deliver one confirmed release repeatedly; capture exactly one logical work set.",
    ],
    outcome: "awaiting_approval",
    modelCalls: 1,
    counts: { draft: 2, retest: 1 },
  },
  {
    suffix: "physical-row-budget",
    scenario: "capacity-and-isolation",
    owners: ["KB-03", "SD-02"],
    input: {
      physicalRowsPerPage: [3, 2],
      filteredMatches: 1,
      physicalRowLimit: 4,
    },
    steps: [
      "Return five physical rows but one match; exceed the four-row budget without returning a complete-looking partial answer.",
    ],
    outcome: "bounded_failure",
    counts: { portal: 0, message: 0 },
  },
  {
    suffix: "credential-scope",
    scenario: "collection-audiences",
    owners: ["KB-04", "PG-01", "RG-01"],
    input: {
      credential: "author_without_publish_permission",
      attemptedOperation: "publish",
    },
    steps: [
      "Present an authenticated author credential without publication permission; attempt direct publication.",
    ],
    outcome: "denied",
    counts: { portal: 0, message: 0 },
  },
  {
    suffix: "credential-audience",
    scenario: "collection-audiences",
    owners: ["KB-04", "PG-01", "RG-01"],
    input: {
      credential: "otherwise_valid_wrong_resource_audience",
      attemptedOperation: "read",
    },
    steps: [
      "Present a validly signed credential for a different resource, with an otherwise sufficient read scope; reject before retrieval.",
    ],
    outcome: "denied",
    counts: { portal: 0, message: 0 },
  },
  {
    suffix: "credential-expired",
    scenario: "collection-audiences",
    owners: ["KB-04", "PG-01", "RG-01"],
    input: {
      credential: "expired_otherwise_valid",
      attemptedOperation: "read",
    },
    steps: [
      "Present an expired credential with the correct resource and sufficient scope; reject before retrieval.",
    ],
    outcome: "denied",
    counts: { portal: 0, message: 0 },
  },
  {
    suffix: "credential-revoked",
    scenario: "collection-audiences",
    owners: ["KB-04", "PG-01", "RG-01"],
    input: { credential: "revoked", previouslyAuthenticated: true },
    steps: [
      "Revoke the local agent credential; retry authoring/retrieval through both transports.",
    ],
    outcome: "denied",
    counts: { portal: 0, message: 0 },
  },
  {
    suffix: "zdr-unverified",
    scenario: "zdr-and-disclosure",
    owners: ["SD-02", "PG-02", "RG-02"],
    input: {
      provider: "zdr_unverified",
      customerSubmittedText: "Ordinary support question.",
    },
    steps: [
      "Remove provider-configuration verification; attempt generation while preserving human support.",
    ],
    outcome: "human_pending",
    counts: { message: 0 },
  },
  {
    suffix: "sensitive-submitted-context",
    scenario: "zdr-and-disclosure",
    owners: ["SD-02", "PG-02", "RG-02"],
    input: {
      provider: "verified_zdr",
      disclosureShown: true,
      customerSubmittedText:
        "My savings figure is 12345 in this fictional example; how do I export?",
      humanPrivacyScreening: false,
    },
    steps: [
      "Process the customer's submitted context with the verified provider; answer using permitted guides without routine human privacy screening.",
    ],
    outcome: "answered",
    modelCalls: 1,
    modelSources: "both",
    messageSources: "both",
    counts: { message: 1 },
  },
];

function sources(instance: FixtureInstance, set: SourceSet | undefined) {
  if (set === "portal") return [instance.portalSource];
  if (set === "both") return [instance.portalSource, instance.botSource];
  return [];
}

export const acceptanceCases: readonly AcceptanceCase[] = Object.values(
  fixtureInstances,
).flatMap((instance) =>
  templates.map((template): AcceptanceCase => ({
    id: `${instance.id}/${template.suffix}`,
    instanceId: instance.id,
    scenario: template.scenario,
    ownerTasks: template.owners,
    input: {
      ...template.input,
      ...(template.withRepositories
        ? { repositoryAllowlist: Object.values(instance.repositories) }
        : {}),
    },
    steps: template.steps,
    expected: {
      outcome: template.outcome,
      modelCalls: template.modelCalls ?? 0,
      modelSources: sources(instance, template.modelSources),
      portalSources: sources(instance, template.portalSources),
      messageSources: sources(instance, template.messageSources),
      ...(template.committedTurns === undefined
        ? {}
        : {
            committedTurns: template.committedTurns.map((turn) => ({
              ...turn,
              operationId: `${instance.id}/${turn.operationId}`,
              ticketId: `${instance.id}/${turn.ticketId}`,
            })),
          }),
      ...(template.repositoryTargets === undefined
        ? {}
        : {
            repositoryTargets: template.repositoryTargets.map((target) => ({
              kind: target.kind,
              repositoryId: instance.repositories[target.repository].id,
            })),
          }),
      counts: { publication: 0, issue: 0, notification: 0, ...template.counts },
      forbidden: [
        {
          sinks: [
            "model",
            "customer",
            "publication",
            "draft",
            "issue",
            "notification",
          ],
          values: Object.values(fixtureInstances).flatMap((profile) => [
            profile.staffSentinel,
            profile.provenanceSentinel,
            profile.privateLink,
          ]),
        },
        {
          sinks: [
            "model",
            "customer",
            "publication",
            "draft",
            "issue",
            "notification",
          ],
          values: Object.values(fixtureInstances)
            .filter((profile) => profile.id !== instance.id)
            .flatMap((profile) => [
              profile.publicSentinel,
              profile.customerSentinel,
            ]),
        },
        {
          sinks: ["publication", "draft", "issue", "notification"],
          values: Object.values(fixtureInstances).map(
            (profile) => profile.customerSentinel,
          ),
        },
      ],
    },
  })),
);
