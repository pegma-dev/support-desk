import { vi } from "vitest";
import { createMemoryStore, type Store } from "@pegma/storage-core";
import { engineeringFollowupChecksBinding } from "@pegma/support-desk-application";
import {
  createSupportReleaseFollowupModel,
  createSupportReleaseFollowupChecks,
  supportReleaseFollowupRoutePolicySha256,
  independentCheckRoutePolicyHash,
  SUPPORT_RELEASE_FOLLOWUP_WIRE_VERSION,
  type ApprovedSupportReleaseFollowupRoute,
  type QualifiedSupportReleaseFollowupCounter,
  type SupportReleaseFollowupChecksOptions,
} from "@pegma/support-desk-ai/openrouter";
import type { ReleaseFollowupAttemptContext } from "@pegma/support-desk-ai";
import { checkerModelFixture } from "./openrouter-fixtures.js";
import {
  followupCandidate,
  followupConfiguration,
} from "./engineering-followup-ai-fixtures.js";
import {
  engineeringFollowupFixture,
  engineeringFollowupService,
} from "./engineering-followup-fixtures.js";

/** All model, ZDR, pricing and evaluation facts here are fictional wire fixtures. */
export async function followupModelFixture(
  host = "pegma.dev",
  startsAt?: string,
) {
  const base = await checkerModelFixture(host, undefined, startsAt);
  const c = followupConfiguration(base.state.now);
  const evaluation = {
    version: c.evaluationVersion,
    artifactRef: "fictional-evaluation",
    modelVersion: c.modelVersion,
    promptVersion: c.promptVersion,
    parserVersion: c.parserVersion,
    verifiedAt: base.state.now,
    validUntil: base.route.approval.validUntil,
  };
  const raw: Omit<ApprovedSupportReleaseFollowupRoute, "approval"> = {
    host,
    purpose: "support_release_followup",
    endpoint: base.route.endpoint,
    endpointTag: base.route.endpointTag,
    outputTokenParameter: "max_tokens",
    credentialRef: "fictional-generator-key",
    usageScopeRef: "fictional-generator-pool",
    configuration: c,
    evaluation,
  };
  const route: ApprovedSupportReleaseFollowupRoute = {
    ...raw,
    approval: {
      ...base.route.approval,
      wireVersion: SUPPORT_RELEASE_FOLLOWUP_WIRE_VERSION,
      configurationVersion: c.version,
      evaluationRef: evaluation.artifactRef,
      requestPolicySha256: await supportReleaseFollowupRoutePolicySha256(raw),
    },
  };
  const counter: QualifiedSupportReleaseFollowupCounter = {
    qualification: {
      ...base.counter.qualification,
      model: c.model,
      modelVersion: c.modelVersion,
      wireVersion: SUPPORT_RELEASE_FOLLOWUP_WIRE_VERSION,
      framingTokens: c.framingTokens,
    },
    count: (value) => new TextEncoder().encode(value).length,
  };
  const key = vi.fn(() => "fictional-generator-credential");
  const state = {
    enabled: true,
    now: base.state.now,
    calls: 0,
    requests: [] as RequestInit[],
    document: {
      ...base.state.document,
      provider: c.provider,
      model: c.model,
      choices: [
        {
          index: 0,
          finish_reason: "stop",
          message: {
            role: "assistant",
            content: JSON.stringify(followupCandidate()),
          },
        },
      ],
    },
  };
  const options = {
    clock: { now: () => state.now },
    enabled: () => state.enabled,
    readRoute: () => route,
    allowlist: [
      {
        model: c.model,
        provider: c.provider,
        endpointTag: route.endpointTag,
        outputTokenParameter: route.outputTokenParameter,
      },
    ],
    counter,
    readApiKey: key,
    fetch: async (_url: string, init: RequestInit) => {
      state.calls++;
      state.requests.push(init);
      return new Response(JSON.stringify(state.document), {
        headers: { "content-type": "application/json" },
      });
    },
  };
  const model = createSupportReleaseFollowupModel(options, host);
  const context: ReleaseFollowupAttemptContext = {
    purpose: "support_release_followup",
    invocationId: "fictional-invocation",
    operationId: "fictional-operation",
    attemptId: "fictional-attempt",
    attempt: 1,
    inputFingerprint: "a".repeat(64),
    inputManifestHash: "b".repeat(64),
    configurationVersion: c.version,
    promptVersion: c.promptVersion,
    modelVersion: c.modelVersion,
    parserVersion: c.parserVersion,
    evaluationVersion: c.evaluationVersion,
    checkPolicyVersion: "fictional-check-policy",
    authorityVersion: "PRIVATE_AUTHORITY",
    usageScopeRef: route.usageScopeRef,
    usageReservationId: "PRIVATE_RESERVATION",
    deadline: new Date(Date.parse(state.now) + 2000).toISOString(),
    signal: new AbortController().signal,
    budgets: c.budgets,
  };
  const input = {
    trustedInstructions: c.trustedInstructions,
    messages: [
      { speaker: "customer" as const, text: "The export appears empty." },
    ],
    publicReleaseFacts: [
      { ref: "release-1", text: "A public update corrects export rows." },
    ],
  };
  return { model, route, c, context, input, state, options, key };
}

export async function followupControllerFixture(
  store: Store = createMemoryStore(),
  fixtureOptions: {
    readonly privateNote?: string;
    readonly maxModelAttempts?: number;
    readonly configureChecker?: (
      wire: Awaited<ReturnType<typeof checkerModelFixture>>,
    ) => void | Promise<void>;
  } = {},
) {
  const wire = await checkerModelFixture();
  wire.route.releaseFollowup = {
    purpose: "support_release_followup",
    wireVersion: "openrouter-support-release-followup-check-v1",
    evidenceRef: "fictional-SD05-check-approval",
    verifiedAt: wire.state.now,
    validUntil: wire.route.approval.validUntil,
  };
  const { approval, ...base } = wire.route;
  wire.route.approval.requestPolicySha256 =
    await independentCheckRoutePolicyHash(base);
  const key = await crypto.subtle.generateKey(
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  const state = { access: engineeringFollowupService, active: true };
  let f!: Awaited<ReturnType<typeof engineeringFollowupFixture>>;
  const policy = {
    version: "fictional-shared-pool",
    scopeRef: wire.route.usageScopeRef,
    configurationVersion: wire.c.version,
    modelVersion: wire.c.modelVersion,
    pricingRef: wire.c.pricingRef,
    currency: "USD",
    maxCostMicros: 8000,
    maxReservationCostMicros: 1000,
    maxReservations: 8,
    validFrom: wire.state.now,
    validUntil: approval.validUntil,
    terminalRetentionMilliseconds: 60000,
  };
  const options: SupportReleaseFollowupChecksOptions = {
    ...wire.options,
    store,
    application: () => f.app,
    authority: {
      resolve: async () =>
        state.active
          ? {
              outcome: "ready",
              authority: {
                access: state.access,
                authorityVersion: "fictional-followup-authority",
                usageScopeRef: wire.route.usageScopeRef,
              },
            }
          : { outcome: "inactive" },
    },
    releaseEvidence: {
      verifyInput: (...args) => f.releaseEvidence.verifyInput(...args),
      confirm: (...args) => f.releaseEvidence.confirm(...args),
    },
    usagePolicy: policy,
    readReceiptKey: () => ({
      id: "fictional-sd05-key",
      key,
      validUntil: approval.validUntil,
    }),
    maxOperationMilliseconds: 15000,
  };
  let actual!: ReturnType<typeof createSupportReleaseFollowupChecks>;
  f = await engineeringFollowupFixture(store, {
    support:
      fixtureOptions.privateNote === undefined
        ? {}
        : { privateNote: fixtureOptions.privateNote },
    followup: {
      ...(fixtureOptions.maxModelAttempts === undefined
        ? {}
        : { maxModelAttempts: fixtureOptions.maxModelAttempts }),
      checks: { verify: (...args) => actual.sdkVerifier.verify(...args) },
    },
  });
  wire.state.now = f.clock.now();
  // Fixture timestamps are independent of wall time and all qualifications use
  // the actual service clock. This is fictional proof, never host qualification.
  const shift = Date.parse(wire.state.now) - Date.parse(policy.validFrom);
  const moved = (at: string) => new Date(Date.parse(at) + shift).toISOString();
  wire.route.approval.verifiedAt = wire.state.now;
  wire.route.approval.validUntil = moved(approval.validUntil);
  wire.route.configuration.dataControls.verifiedAt = wire.state.now;
  wire.route.configuration.dataControls.validUntil =
    wire.route.approval.validUntil;
  wire.route.releaseFollowup.verifiedAt = wire.state.now;
  wire.route.releaseFollowup.validUntil = wire.route.approval.validUntil;
  Object.assign(wire.counter.qualification, {
    verifiedAt: wire.state.now,
    validUntil: wire.route.approval.validUntil,
  });
  Object.assign(policy, {
    validFrom: wire.state.now,
    validUntil: wire.route.approval.validUntil,
  });
  // The factory snapshots policy at creation: create it only after clock alignment.
  if (fixtureOptions.configureChecker)
    await fixtureOptions.configureChecker(wire);
  const { approval: ignored, ...shifted } = wire.route;
  void ignored;
  wire.route.approval.requestPolicySha256 =
    await independentCheckRoutePolicyHash(shifted);
  actual = createSupportReleaseFollowupChecks(options, "pegma.dev");
  // App verifier is read-free and current route/key bound; it carries no model state.
  await f.eligible();
  return { f, wire, state, options, checks: actual, policy, store };
}

export async function followupChecksFixture(
  store: Store = createMemoryStore(),
  fixtureOptions: {
    readonly privateNote?: string;
    readonly configureChecker?: (
      wire: Awaited<ReturnType<typeof checkerModelFixture>>,
    ) => void | Promise<void>;
  } = {},
) {
  const base = await followupControllerFixture(store, fixtureOptions);
  const { f, wire } = base;
  const prepared = await f.prepareCandidate();
  const work = await f.work();
  const exactBundle = await f.exactBundle(prepared.candidate);
  const binding = await engineeringFollowupChecksBinding({
    workBindingHash: work.workBindingHash,
    candidateHash: prepared.candidateHash,
    exactBundle,
    checkPolicyVersion: wire.c.policyVersion,
    followupRevocationEpoch: work.association.followupRevocationEpoch,
    context: work.context!,
  });
  const input = {
    candidate: prepared.candidate,
    exactBundle,
    binding,
    releaseProof: f.proof(),
    targetBaseline: null,
    validationRequirements: null,
  };
  const context = {
    purpose: "support_release_followup" as const,
    deadline: new Date(Date.parse(wire.state.now) + 15000).toISOString(),
    signal: new AbortController().signal,
  };
  return {
    ...base,
    input,
    context,
  };
}
