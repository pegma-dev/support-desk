import type { Store } from "@pegma/storage-core";
import type { ResolutionLearningCandidate } from "@pegma/support-desk-application";
import { vi } from "vitest";
import { createLearningModelExecutor } from "../packages/ai/src/learning-model.js";
import type {
  LearningBudgets,
  LearningCheckPolicyPort,
  LearningConfigurationPort,
  LearningModelExecutorOptions,
  LearningModelPort,
  LearningModelResult,
  LearningServiceAccessPort,
  LearningServiceAuthority,
  LearningUsagePort,
  VerifiedLearningCheckPolicy,
  VerifiedLearningConfiguration,
} from "../packages/ai/src/learning-ports.js";
import {
  learningService,
  learningStaff,
  resolutionLearningFixture,
} from "./resolution-learning-fixtures.js";

export const privateLearningCanaries = [
  "PRIVATE_LEARNING_STAFF_NOTE",
  "PRIVATE_LEARNING_VERIFICATION_REFERENCE",
  "PRIVATE_LEARNING_ACCOUNT_PROOF",
  "PRIVATE_LEARNING_PROJECT_PROOF",
  "PRIVATE_LEARNING_ENDPOINT_PROOF",
  "PRIVATE_LEARNING_MODEL_PROOF",
  "PRIVATE_LEARNING_FEATURE_PROOF",
  "PRIVATE_LEARNING_EXCEPTION_PROOF",
  "PRIVATE_LEARNING_INTERMEDIARY_PROOF",
  "PRIVATE_LEARNING_USAGE_SCOPE",
] as const;

export function learningFixtureTokens(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

function configuration(now: string): VerifiedLearningConfiguration {
  return {
    purpose: "support_learning",
    version: "synthetic-learning-config-v1",
    promptVersion: "synthetic-learning-prompt-v1",
    modelVersion: "synthetic-learning-model-v1",
    provider: "synthetic-learning-provider",
    model: "synthetic-learning-model",
    pricingRef: "synthetic-learning-pricing-v1",
    trustedInstructions:
      "Generalize the verified visible solution into a private candidate.",
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
      configurationBinding: "synthetic-learning-config-v1",
      accountRef: "PRIVATE_LEARNING_ACCOUNT_PROOF",
      projectRef: "PRIVATE_LEARNING_PROJECT_PROOF",
      endpointRef: "PRIVATE_LEARNING_ENDPOINT_PROOF",
      modelRef: "PRIVATE_LEARNING_MODEL_PROOF",
      featuresRef: "PRIVATE_LEARNING_FEATURE_PROOF",
      exceptionsRef: "PRIVATE_LEARNING_EXCEPTION_PROOF",
      intermediaryRefs: ["PRIVATE_LEARNING_INTERMEDIARY_PROOF"],
      verifiedAt: now,
      validUntil: new Date(Date.parse(now) + 3_600_000).toISOString(),
    },
  };
}

/** Only host/provider ports are fake; every learning row belongs to the real app. */
export async function resolutionLearningAiFixture(
  backing: Store,
  options: { readonly notificationBody?: string } = {},
) {
  const support = resolutionLearningFixture(backing);
  const terminal = await support.terminal();
  if (options.notificationBody !== undefined)
    await support.app.closeTicket(learningStaff, {
      ...support.command("close-with-learning-notification"),
      messageId: "learning-lifecycle-notification",
      body: options.notificationBody,
    });
  await support.app.addNote(learningStaff, {
    ...support.command("private-learning-note"),
    messageId: "private-learning-note",
    body: "PRIVATE_LEARNING_STAFF_NOTE",
  });
  const ticket = (await support.app.readStaffTicket(learningStaff, "ticket"))
    .ticket;
  await support.app.submitResolutionEvidence(learningStaff, {
    ...support.command("learning-evidence"),
    expectedRevision: ticket.revision,
    resolutionCycle: terminal.source.resolutionCycle,
    evidence: {
      kind: "staff_verified_fix",
      solutionMessageId: terminal.solutionMessageId,
      verificationReference: "PRIVATE_LEARNING_VERIFICATION_REFERENCE",
    },
  });
  const state: {
    configuration: VerifiedLearningConfiguration;
    configurationOutcome: "ready" | "disabled" | "unavailable";
    authority: LearningServiceAuthority;
    authorityOutcome: "ready" | "inactive" | "unavailable";
    checkPolicy: VerifiedLearningCheckPolicy;
    checkPolicyOutcome: "ready" | "disabled" | "unavailable";
    reserveOutcome: "reserved" | "denied" | "unavailable";
    reconciliationOutcome: "reconciled" | "pending";
  } = {
    configuration: configuration(support.clock.now()),
    configurationOutcome: "ready",
    authority: {
      access: learningService,
      authorityVersion: "synthetic-learning-service-v1",
      usageScopeRef: "PRIVATE_LEARNING_USAGE_SCOPE",
    },
    authorityOutcome: "ready",
    checkPolicy: {
      version: "synthetic-check-policy-v1",
      binding: "synthetic-independent-check-policy-binding-v1",
      verifiedAt: support.clock.now(),
      validUntil: new Date(
        Date.parse(support.clock.now()) + 3_600_000,
      ).toISOString(),
    },
    checkPolicyOutcome: "ready",
    reserveOutcome: "reserved",
    reconciliationOutcome: "reconciled",
  };
  const resolveConfiguration = vi.fn<LearningConfigurationPort["resolve"]>(
    async () =>
      state.configurationOutcome === "ready"
        ? {
            outcome: "ready",
            configuration: structuredClone(state.configuration),
          }
        : { outcome: state.configurationOutcome },
  );
  const resolveAuthority = vi.fn<LearningServiceAccessPort["resolve"]>(
    async () =>
      state.authorityOutcome === "ready"
        ? { outcome: "ready", authority: structuredClone(state.authority) }
        : { outcome: state.authorityOutcome },
  );
  const resolvePolicy = vi.fn<LearningCheckPolicyPort["resolvePolicy"]>(
    async () =>
      state.checkPolicyOutcome === "ready"
        ? { outcome: "ready", policy: structuredClone(state.checkPolicy) }
        : { outcome: state.checkPolicyOutcome },
  );
  const reserve = vi.fn<LearningUsagePort["reserve"]>(async (context) =>
    state.reserveOutcome === "reserved"
      ? { outcome: "reserved", usageReservationId: context.usageReservationId }
      : { outcome: state.reserveOutcome },
  );
  const reconcile = vi.fn<LearningUsagePort["reconcile"]>(
    async () => state.reconciliationOutcome,
  );
  const candidate = (
    overrides: Partial<ResolutionLearningCandidate> = {},
  ): ResolutionLearningCandidate => ({
    problem: "Export a workspace to a downloadable file.",
    applicability: {
      productId: "workspace",
      version: "2.3.0",
      buildId: "build-verified-230",
    },
    steps: ["Open Workspace.", "Choose Export."],
    solution: "Download the completed workspace export.",
    validationRequirements: ["Verify that the downloaded export opens."],
    ...overrides,
  });
  const answer = (
    overrides: Partial<LearningModelResult> = {},
  ): LearningModelResult => ({
    outputJson: JSON.stringify(candidate()),
    provider: state.configuration.provider,
    model: state.configuration.model,
    requestId: "synthetic-learning-provider-request",
    usage: {
      inputTokens: 100,
      outputTokens: 30,
      costMicros: 10,
      currency: "USD",
    },
    ...overrides,
  });
  let script: LearningModelPort["generate"] = async () => answer();
  const generate = vi.fn<LearningModelPort["generate"]>((...args) =>
    script(...args),
  );
  const countTokens = vi.fn(learningFixtureTokens);
  const baseOptions: LearningModelExecutorOptions = {
    application: support.app,
    serviceAccess: { resolve: resolveAuthority },
    configuration: { resolve: resolveConfiguration },
    checkPolicy: { resolvePolicy },
    usage: { reserve, reconcile },
    model: { generate },
    tokenCounter: { count: countTokens },
    clock: support.clock,
  };
  return {
    ...support,
    state,
    baseOptions,
    executor: createLearningModelExecutor(baseOptions),
    generate,
    reserve,
    reconcile,
    resolveConfiguration,
    resolveAuthority,
    resolvePolicy,
    countTokens,
    candidate,
    answer,
    setBudgets(overrides: Partial<LearningBudgets>) {
      state.configuration = {
        ...state.configuration,
        budgets: { ...state.configuration.budgets, ...overrides },
      };
    },
    setModel(next: LearningModelPort["generate"]) {
      script = next;
    },
  };
}
