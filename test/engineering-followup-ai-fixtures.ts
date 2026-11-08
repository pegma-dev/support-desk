import type { Store } from "@pegma/storage-core";
import type { EngineeringFollowupCandidate } from "@pegma/support-desk-application";
import { vi } from "vitest";
import { createSupportDeskReleaseFollowup } from "../packages/ai/src/release-followup-coordinator.js";
import type {
  ReleaseFollowupBudgets,
  ReleaseFollowupModelPort,
  ReleaseFollowupModelResult,
  SupportDeskReleaseFollowupOptions,
  VerifiedReleaseFollowupConfiguration,
  VerifiedReleaseFollowupEvaluation,
} from "../packages/ai/src/release-followup-ports.js";
import type { VerifiedLearningCheckPolicy } from "../packages/ai/src/learning-ports.js";
import { learningKbFixture } from "./resolution-learning-kb-fixtures.js";
import {
  engineeringFollowupBarrier,
  engineeringFollowupFixture,
  engineeringFollowupService,
  engineeringFollowupStaff,
} from "./engineering-followup-fixtures.js";

export const followupPrivateKnowledgeText =
  "PRIVATE_FOLLOWUP_KB_GUIDE_BODY: Internal validation details stay private.";

export function followupConfiguration(
  now: string,
): VerifiedReleaseFollowupConfiguration {
  return {
    purpose: "support_release_followup",
    version: "followup-config-v1",
    promptVersion: "followup-prompt-v1",
    modelVersion: "followup-model-v1",
    parserVersion: "followup-parser-v1",
    evaluationVersion: "followup-evaluation-v1",
    provider: "synthetic-followup-provider",
    model: "synthetic-followup-model",
    pricingRef: "synthetic-followup-pricing-v1",
    trustedInstructions:
      "Draft a private update using only the visible conversation and approved public release facts.",
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
      purpose: "support_release_followup",
      configurationBinding: "followup-config-v1",
      accountRef: "PRIVATE_FOLLOWUP_ACCOUNT",
      projectRef: "PRIVATE_FOLLOWUP_PROJECT",
      endpointRef: "PRIVATE_FOLLOWUP_ENDPOINT",
      modelRef: "PRIVATE_FOLLOWUP_MODEL",
      featuresRef: "PRIVATE_FOLLOWUP_FEATURES",
      exceptionsRef: "PRIVATE_FOLLOWUP_EXCEPTIONS",
      intermediaryRefs: ["PRIVATE_FOLLOWUP_INTERMEDIARY"],
      verifiedAt: now,
      validUntil: new Date(Date.parse(now) + 3_600_000).toISOString(),
    },
  };
}

export function followupCandidate(
  overrides: Partial<EngineeringFollowupCandidate> = {},
): EngineeringFollowupCandidate {
  return {
    customerDraft: {
      body: "The deployed workspace update includes the export correction. Please retry exporting your workspace.",
    },
    kbProposal: {
      summary: "Document the corrected workspace export behavior.",
      changes: ["Explain that the deployed update preserves workspace rows."],
      advisoryValidationRequirements: [
        "Retest exporting a workspace with two rows.",
      ],
    },
    retestRequests: [
      {
        steps: [
          "Create a workspace with two rows.",
          "Export and inspect the downloaded file.",
        ],
        expectedBehavior: "The export contains both workspace rows.",
      },
    ],
    ...overrides,
  };
}

/** Independent real KB setup; no learning evidence or delivery is fabricated. */
export async function engineeringFollowupKnowledgeFixture(backing: Store) {
  const knowledge = await learningKbFixture(backing);
  const articleId = "private-followup-export-guide";
  const draft = await knowledge.createGuide(
    articleId,
    followupPrivateKnowledgeText,
  );
  return { ...knowledge, articleId, draft };
}

export async function waitForFollowupHook(
  barrier: ReturnType<typeof engineeringFollowupBarrier>,
  pending: Promise<unknown>,
) {
  await Promise.race([
    barrier.reached,
    pending.then((result) => {
      throw new Error(
        `Follow-up hook was not reached: ${JSON.stringify(result)}`,
      );
    }),
  ]);
}

type BaseOptions = NonNullable<
  Parameters<typeof engineeringFollowupFixture>[1]
>;

/** Real Support/KB services, with fake independent host and paid-provider ports. */
export async function engineeringFollowupAiFixture(
  backing: Store,
  options: BaseOptions & {
    readonly knowledge?: boolean;
    readonly notificationBody?: string;
  } = {},
) {
  const { knowledge: useKnowledge, notificationBody, ...base } = options;
  const f = await engineeringFollowupFixture(backing, {
    ...base,
    observe: false,
    support: {
      ...base.support,
      ...(notificationBody === undefined ? {} : { notificationBody }),
    },
  });
  const key = await f.eligible();
  const knowledge = useKnowledge
    ? await engineeringFollowupKnowledgeFixture(backing)
    : undefined;
  const now = f.clock.now();
  const validUntil = new Date(Date.parse(now) + 3_600_000).toISOString();
  const state = {
    configuration: followupConfiguration(now),
    configurationOutcome: "ready" as "ready" | "disabled" | "unavailable",
    evaluationOutcome: "ready" as "ready" | "unavailable",
    evaluation: {
      version: "followup-evaluation-v1",
      artifactRef: "PRIVATE_FOLLOWUP_ACTUAL_MODEL_EVAL",
      modelVersion: "followup-model-v1",
      promptVersion: "followup-prompt-v1",
      parserVersion: "followup-parser-v1",
      verifiedAt: now,
      validUntil,
    } as VerifiedReleaseFollowupEvaluation,
    authorityOutcome: "ready" as "ready" | "inactive" | "unavailable",
    authority: {
      access: engineeringFollowupService,
      authorityVersion: "followup-service-v1",
      usageScopeRef: "PRIVATE_FOLLOWUP_USAGE_SCOPE",
    },
    checkPolicyOutcome: "ready" as "ready" | "disabled" | "unavailable",
    checkPolicy: {
      version: "followup-check-policy-v1",
      binding: "followup-independent-whole-bundle-policy",
      verifiedAt: now,
      validUntil,
    } as VerifiedLearningCheckPolicy,
    checkOutcome: "checked" as
      "checked" | "held" | "restricted" | "unavailable",
    reserveOutcome: "reserved" as "reserved" | "denied" | "unavailable",
    reconciliationOutcome: "reconciled" as "reconciled" | "pending",
    targetKind: (knowledge === undefined ? "none" : "article") as
      "none" | "article" | "unavailable",
    knowledgeOutcome: "ready" as "ready" | "inactive" | "unavailable",
  };
  const resolveConfiguration = vi.fn<
    SupportDeskReleaseFollowupOptions["configuration"]["resolve"]
  >(async () =>
    state.configurationOutcome === "ready"
      ? {
          outcome: "ready",
          configuration: structuredClone(state.configuration),
        }
      : { outcome: state.configurationOutcome },
  );
  const resolveEvaluation = vi.fn<
    SupportDeskReleaseFollowupOptions["evaluations"]["resolve"]
  >(async () =>
    state.evaluationOutcome === "ready"
      ? { outcome: "ready", evaluation: structuredClone(state.evaluation) }
      : { outcome: "unavailable" },
  );
  const resolveAuthority = vi.fn<
    SupportDeskReleaseFollowupOptions["serviceAccess"]["resolve"]
  >(async () =>
    state.authorityOutcome === "ready"
      ? { outcome: "ready", authority: structuredClone(state.authority) }
      : { outcome: state.authorityOutcome },
  );
  const resolveCheckPolicy = vi.fn<
    SupportDeskReleaseFollowupOptions["checks"]["resolvePolicy"]
  >(async () =>
    state.checkPolicyOutcome === "ready"
      ? { outcome: "ready", policy: structuredClone(state.checkPolicy) }
      : { outcome: state.checkPolicyOutcome },
  );
  let ordinal = 0;
  const check = vi.fn<SupportDeskReleaseFollowupOptions["checks"]["check"]>(
    async (input) => {
      if (state.checkOutcome !== "checked")
        return { outcome: state.checkOutcome };
      const receipt = `followup-independent-bundle-check:${++ordinal}`;
      f.trust.issueChecks(receipt, input.binding);
      return { outcome: "checked", receipt };
    },
  );
  const reserve = vi.fn<SupportDeskReleaseFollowupOptions["usage"]["reserve"]>(
    async (context) =>
      state.reserveOutcome === "reserved"
        ? {
            outcome: "reserved",
            usageReservationId: context.usageReservationId,
          }
        : { outcome: state.reserveOutcome },
  );
  const reconcile = vi.fn<
    SupportDeskReleaseFollowupOptions["usage"]["reconcile"]
  >(async () => state.reconciliationOutcome);
  const answer = (
    overrides: Partial<ReleaseFollowupModelResult> = {},
  ): ReleaseFollowupModelResult => ({
    outputJson: JSON.stringify(followupCandidate()),
    provider: state.configuration.provider,
    model: state.configuration.model,
    requestId: "synthetic-followup-provider-request",
    usage: {
      inputTokens: 100,
      outputTokens: 50,
      costMicros: 10,
      currency: "USD",
    },
    ...overrides,
  });
  let modelScript: ReleaseFollowupModelPort["generate"] = async () => answer();
  const generate = vi.fn<ReleaseFollowupModelPort["generate"]>((...args) =>
    modelScript(...args),
  );
  const countTokens = vi.fn(
    (text: string) => new TextEncoder().encode(text).byteLength,
  );
  const resolveTarget = vi.fn<
    SupportDeskReleaseFollowupOptions["targets"]["resolve"]
  >(async () =>
    state.targetKind === "article" && knowledge !== undefined
      ? { kind: "article", articleId: knowledge.articleId }
      : {
          kind:
            state.targetKind === "article" ? "unavailable" : state.targetKind,
        },
  );
  const resolveKnowledge = vi.fn<
    NonNullable<SupportDeskReleaseFollowupOptions["knowledgeAccess"]>["resolve"]
  >(async () =>
    state.knowledgeOutcome === "ready" && knowledge !== undefined
      ? {
          outcome: "ready",
          authority: {
            access: knowledge.access.draftService,
            authorityVersion: "followup-kb-read-v1",
          },
        }
      : {
          outcome:
            state.knowledgeOutcome === "ready"
              ? "unavailable"
              : state.knowledgeOutcome,
        },
  );
  const baseOptions: SupportDeskReleaseFollowupOptions = {
    application: f.app,
    clock: f.clock,
    serviceAccess: { resolve: resolveAuthority },
    releaseEvidence: f.releaseEvidence,
    configuration: { resolve: resolveConfiguration },
    evaluations: { resolve: resolveEvaluation },
    model: { generate },
    usage: { reserve, reconcile },
    tokenCounter: { count: countTokens },
    targets: { resolve: resolveTarget },
    checks: {
      resolvePolicy: resolveCheckPolicy,
      check,
      verify: f.checksVerify,
    },
    ...(knowledge === undefined
      ? {}
      : {
          knowledge: {
            getDraft: (...args) => knowledge.ports.knowledge.getDraft(...args),
            getValidationRequirements: (...args) =>
              knowledge.ports.knowledge.getValidationRequirements(...args),
          },
          knowledgeAccess: { resolve: resolveKnowledge },
        }),
  };
  const followup = createSupportDeskReleaseFollowup(baseOptions);
  const nextCommand = () => ({
    ...key,
    workerId: "followup-ai-worker",
    leaseMilliseconds: 30_000,
  });
  return {
    ...f,
    key,
    state,
    releaseState: f.state,
    knowledge,
    baseOptions,
    followup,
    generate,
    reserve,
    reconcile,
    countTokens,
    resolveConfiguration,
    resolveEvaluation,
    resolveAuthority,
    resolveCheckPolicy,
    check,
    resolveTarget,
    resolveKnowledge,
    candidate: followupCandidate,
    answer,
    nextCommand,
    setModel(script: ReleaseFollowupModelPort["generate"]) {
      modelScript = script;
    },
    setBudgets(budgets: Partial<ReleaseFollowupBudgets>) {
      state.configuration = {
        ...state.configuration,
        budgets: { ...state.configuration.budgets, ...budgets },
      };
    },
    async prepareBundle() {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const result = await followup.processWork(nextCommand());
        if (result.outcome === "prepared") return f.work();
        if (result.outcome !== "candidate")
          throw new Error(
            `Follow-up did not prepare: ${JSON.stringify(result)}`,
          );
      }
      throw new Error("Follow-up preparation exceeded three bounded stages");
    },
    async postCommand(label = "staff-post-followup") {
      const work = await f.work();
      if (work.preparedBundle === undefined)
        throw new Error("A checked follow-up bundle is required");
      const ticket = (
        await f.app.readStaffTicket(engineeringFollowupStaff, key.ticketId)
      ).ticket;
      return {
        ...f.command(label),
        ...key,
        expectedWorkGeneration: work.workGeneration,
        expectedTicketRevision: ticket.revision,
        bundleHash: work.preparedBundle.bundleHash,
        messageId: `followup-notice:${++ordinal}`,
      };
    },
  };
}
