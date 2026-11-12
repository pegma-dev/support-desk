import {
  createSupportIndependentCheckModel,
  independentCheckRoutePolicyHash,
  INDEPENDENT_CHECK_ENDPOINT,
  INDEPENDENT_CHECK_PURPOSE,
  INDEPENDENT_CHECK_WIRE,
  type IndependentCheckRoute,
  type IndependentCheckContext,
  type IndependentCheckCounter,
} from "@pegma/support-desk-ai/openrouter";

export const CHECK_START = "2026-11-10T12:00:00.000Z";
export const CHECK_END = "2026-11-10T13:00:00.000Z";
export const CHECK_PASS = {
  privacy: "passed",
  factual: "passed",
  security: "clear",
  applicability: "passed",
  duplication: "passed",
  publicReproduction: "not_applicable",
  findings: [],
};
/** All approvals/prices/qualification references here are fictional test evidence. */
export async function checkerModelFixture(
  host = "pegma.dev",
  policyVersion = "fictional-check-policy",
  startsAt = CHECK_START,
  maxMessages = 20,
) {
  const endsAt = new Date(Date.parse(startsAt) + 3_600_000).toISOString();
  const c: IndependentCheckRoute["configuration"] = {
    purpose: INDEPENDENT_CHECK_PURPOSE,
    version: "fictional-check-config",
    promptVersion: "fictional-check-prompt",
    modelVersion: "fictional-check-model",
    parserVersion: "fictional-check-parser",
    policyVersion,
    policyBinding: "fictional-check-policy-binding",
    rubricVersion: "fictional-check-rubric",
    model: "fictional/checker",
    provider: "Fictional Provider",
    pricingRef: "fictional-check-price",
    trustedInstructions: "Compare only supplied fictional facts.",
    framingTokens: 512,
    budgets: {
      maxMessages,
      maxInputBytes: 65_536,
      maxInputTokens: 16_000,
      maxContextTokens: 20_000,
      maxOutputBytes: 4_000,
      maxOutputTokens: 1_000,
      maxDurationMilliseconds: 2_000,
      maxCostMicros: 1_000,
      currency: "USD",
      maxAttempts: 1,
    },
    dataControls: {
      status: "verified",
      purpose: INDEPENDENT_CHECK_PURPOSE,
      configurationBinding: "fictional-check-config",
      accountRef: "fictional-account",
      projectRef: "fictional-project",
      endpointRef: "fictional-endpoint",
      modelRef: "fictional-model",
      featuresRef: "fictional-features",
      exceptionsRef: "fictional-exceptions",
      intermediaryRefs: ["fictional-intermediary"],
      verifiedAt: startsAt,
      validUntil: endsAt,
    },
  };
  const base: Omit<IndependentCheckRoute, "approval"> = {
    host,
    purpose: INDEPENDENT_CHECK_PURPOSE,
    endpoint: INDEPENDENT_CHECK_ENDPOINT,
    endpointTag: "fictional/region",
    outputTokenParameter: "max_tokens",
    credentialRef: "fictional-provider-credential",
    usageScopeRef: "fictional-check-budget",
    configuration: c,
  };
  const route: IndependentCheckRoute = {
    ...base,
    approval: {
      wireVersion: INDEPENDENT_CHECK_WIRE,
      configurationVersion: c.version,
      requestPolicySha256: await independentCheckRoutePolicyHash(base),
      evidenceRef: "fictional-approval",
      effectivePolicyRef: "fictional-effective-policy",
      evaluationRef: "fictional-evaluation",
      responseIdentityRef: "fictional-identity",
      tokenizerRef: "fictional-tokenizer",
      nativeCostCurrency: "USD",
      nativeCostUnit: "openrouter_credits_usd",
      rounding: "ceil_micro",
      zdr: true,
      safetyRetention: false,
      inputOutputLogging: false,
      inputOutputUse: false,
      broadcast: false,
      responseCache: false,
      unreviewedFeatures: false,
      implicitCache: "absent",
      verifiedAt: startsAt,
      validUntil: endsAt,
    },
  };
  const state = {
    enabled: true,
    calls: 0,
    requests: [] as { url: string; init: RequestInit }[],
    now: startsAt,
    document: {
      id: "fictional-check-response",
      object: "chat.completion",
      created: 1,
      provider: c.provider,
      model: c.model,
      choices: [
        {
          index: 0,
          finish_reason: "stop",
          message: { role: "assistant", content: JSON.stringify(CHECK_PASS) },
        },
      ],
      usage: {
        prompt_tokens: 200,
        completion_tokens: 100,
        total_tokens: 300,
        cost: 0.0001,
        currency: "USD",
        is_byok: false,
        prompt_tokens_details: {
          cached_tokens: 0,
          audio_tokens: 0,
          video_tokens: 0,
        },
        completion_tokens_details: {
          reasoning_tokens: 0,
          image_tokens: 0,
          audio_tokens: 0,
        },
      },
    },
  };
  const counter: IndependentCheckCounter = {
    qualification: {
      model: c.model,
      modelVersion: c.modelVersion,
      wireVersion: INDEPENDENT_CHECK_WIRE,
      framingTokens: c.framingTokens,
      evidenceRef: "fictional-tokenizer",
      verifiedAt: startsAt,
      validUntil: endsAt,
    },
    count: (s: string) => new TextEncoder().encode(s).length,
  };
  const options = {
    clock: { now: () => state.now },
    enabled: () => state.enabled,
    readRoute: () => route,
    allowlist: [
      {
        model: c.model,
        provider: c.provider,
        endpointTag: base.endpointTag,
        outputTokenParameter: base.outputTokenParameter,
      },
    ],
    counter,
    readApiKey: () => "fictional-provider-key",
    fetch: async (url: string, init: RequestInit) => {
      state.calls++;
      state.requests.push({ url, init });
      return new Response(JSON.stringify(state.document), {
        headers: { "content-type": "application/json" },
      });
    },
  };
  const model = createSupportIndependentCheckModel(options, host);
  const context: IndependentCheckContext = {
    purpose: INDEPENDENT_CHECK_PURPOSE,
    configurationVersion: c.version,
    promptVersion: c.promptVersion,
    modelVersion: c.modelVersion,
    usageScopeRef: base.usageScopeRef,
    operationId: "fictional-operation",
    attemptId: "fictional-attempt",
    inputFingerprint: "a".repeat(64),
    usageReservationId: "fictional-reservation",
    deadline: new Date(Date.parse(startsAt) + 2_000).toISOString(),
    signal: new AbortController().signal,
    budgets: c.budgets,
  };
  const input = {
    trustedInstructions: c.trustedInstructions,
    kind: "engineering" as const,
    facts: {
      messages: ["The export appears empty."],
      actualBehavior: "The export appears empty.",
    },
    candidate: { actualBehavior: "The export is empty." },
    outbound: {
      body: "Export is empty. <!-- hidden unverified claim -->",
      labels: ["bug"],
      templateId: "issue",
    },
  };
  return { c, state, route, model, context, input, options, counter };
}
import {
  createMemoryStore,
  type Store,
  type CollectionDefinition,
} from "@pegma/storage-core";
import {
  createSupportIndependentChecks,
  type SupportIndependentChecksOptions,
  type IndependentCheckReceiptKey,
} from "@pegma/support-desk-ai/openrouter";
import {
  engineeringAiFixture,
  engineeringService,
} from "./engineering-fixtures.js";

/** Actual SDK Source/Work/candidate/request; only external model/key/proof ports are fictional. */
export async function actualEngineeringCheckerFixture(
  host = "pegma.dev",
  deferred = false,
  inputBudget: {
    readonly maxMessages?: number;
    readonly secondVisibleMessage?: boolean;
  } = {},
) {
  const backing = createMemoryStore();
  const calls: string[] = [];
  const store: Store = {
    collection<T>(definition: CollectionDefinition<T>) {
      const target = backing.collection(definition);
      return new Proxy(target, {
        get(object, property) {
          const value: unknown = Reflect.get(object, property, object);
          if (typeof value !== "function") return value;
          return (...args: unknown[]) => {
            calls.push(definition.name + ":" + String(property));
            return Reflect.apply(value, object, args);
          };
        },
      });
    },
  };
  const f = await engineeringAiFixture(
    store,
    inputBudget.secondVisibleMessage
      ? {
          notificationBody:
            "Synthetic export remains empty after verification.",
        }
      : {},
  );
  const first = await f.engineering.processWork(f.nextCommand());
  if (first.outcome !== "candidate")
    throw new Error(
      "Expected actual engineering candidate: " + JSON.stringify(first),
    );
  f.checksCheck.mockImplementation(async () => ({ outcome: "held" }));
  await f.engineering.processWork(f.nextCommand());
  const captured = f.checksCheck.mock.calls[0]?.[0];
  if (captured?.candidate === undefined)
    throw new Error("Expected actual SDK-built complete request");
  const p = await checkerModelFixture(
    host,
    f.state.checkPolicy.version,
    f.clock.now(),
    inputBudget.maxMessages,
  );
  const repositories = f.engineeringOptions.repositoryMetadata;
  if (!repositories)
    throw new Error("Expected actual fixture repository observations");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode("FICTIONAL_TEST_ONLY_32_BYTE_HMAC__"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  const state = {
    key: {
      id: "fictional-key-1",
      key,
      validUntil: p.route.approval.validUntil,
    } as IndependentCheckReceiptKey | null,
  };
  const options: SupportIndependentChecksOptions = {
    ...p.options,
    clock: f.clock,
    store,
    application: () => f.app,
    deferred,
    authority: {
      async resolve(signal) {
        const current = await f.baseOptions.serviceAccess.resolve(signal);
        return current.outcome === "ready"
          ? {
              outcome: "ready",
              authority: {
                ...current.authority,
                usageScopeRef: p.route.usageScopeRef,
              },
            }
          : current;
      },
    },
    repositories,
    usagePolicy: {
      version: "fictional-funding",
      scopeRef: p.route.usageScopeRef,
      configurationVersion: p.c.version,
      modelVersion: p.c.modelVersion,
      pricingRef: p.c.pricingRef,
      currency: "USD",
      maxCostMicros: 8_000,
      maxReservationCostMicros: 1_000,
      maxReservations: 8,
      validFrom: f.clock.now(),
      validUntil: p.route.approval.validUntil,
      terminalRetentionMilliseconds: 3_600_000,
    },
    readReceiptKey: () => state.key,
  };
  const adapter = createSupportIndependentChecks(options, host);
  const input = {
    ...captured,
    checkPolicyVersion: f.state.checkPolicy.version,
  };
  const context = {
    ...f.checksCheck.mock.calls[0]![1],
    deadline: new Date(Date.parse(f.clock.now()) + 10_000).toISOString(),
    signal: new AbortController().signal,
  };
  return {
    f,
    p,
    store,
    calls,
    options,
    state,
    adapter,
    input,
    context,
    service: engineeringService,
  };
}
