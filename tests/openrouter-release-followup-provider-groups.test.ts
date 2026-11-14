import {
  createMemoryStore,
  type CollectionDefinition,
  type CollectionStore,
  type Store,
} from "@pegma/storage-core";
import { describe, expect, it, vi } from "vitest";
import {
  createSupportIndependentCheckModel,
  createSupportReleaseFollowupChecks,
  independentCheckRoutePolicyHash,
  type ReleaseFollowupIndependentCheckInput,
} from "@pegma/support-desk-ai/openrouter";
import { CHECK_PASS } from "../test/openrouter-fixtures.js";
import {
  followupChecksFixture,
  followupModelFixture,
} from "../test/openrouter-release-followup-fixtures.js";

type Fixture = Awaited<ReturnType<typeof followupChecksFixture>>;
type Wire = Fixture["wire"];
const PRICE = { prompt: 0.05, completion: 0.1, request: 0 } as const;
const signal = () => new AbortController().signal;

function group(wire: Wire) {
  wire.route.endpointTag = "azure";
  wire.route.providerSelectionScope = "provider_group";
  wire.route.providerMaxPrice = { ...PRICE };
  wire.route.approval.providerSelectionScope = "provider_group";
  wire.options.allowlist[0]!.endpointTag = "azure";
  Reflect.set(
    wire.options.allowlist[0]!,
    "providerSelectionScope",
    "provider_group",
  );
}
async function approve(wire: Wire) {
  const { approval, ...base } = wire.route;
  approval.requestPolicySha256 = await independentCheckRoutePolicyHash(base);
}
const fixture = () =>
  followupChecksFixture(createMemoryStore(), { configureChecker: group });
function request(f: Fixture): ReleaseFollowupIndependentCheckInput {
  return {
    trustedInstructions: f.wire.c.trustedInstructions,
    kind: "release_followup",
    purpose: "support_release_followup",
    facts: {
      messages: ["The fictional export was empty."],
      publicReleaseFacts: [
        {
          ref: "release-1",
          text: "The fictional deployed fix exports every row.",
        },
      ],
    },
    candidate: f.input.candidate,
    outbound: f.input.exactBundle,
    binding: f.input.binding,
    targetBaseline: null,
    validationRequirements: null,
  };
}
function directContext(f: Fixture) {
  return {
    ...f.wire.context,
    deadline: new Date(Date.parse(f.wire.state.now) + 2_000).toISOString(),
  };
}
function wireBody(f: Fixture, index = 0) {
  return JSON.parse(String(f.wire.state.requests[index]!.init.body));
}

/** Observe actual public Store admission calls; no seeded private checker rows. */
function admissionStore(base: Store) {
  const writes = vi.fn();
  const store: Store = {
    collection<T>(definition: CollectionDefinition<T>): CollectionStore<T> {
      const records = base.collection(definition);
      return {
        ...records,
        async update(key, decide, options) {
          writes(definition.name);
          return records.update(key, decide, options);
        },
      };
    },
  };
  return { store, writes };
}
async function refusesBeforeProviderOrAdmission(f: Fixture) {
  const observed = admissionStore(f.store);
  const credential = vi.fn(f.options.readApiKey),
    authority = vi.fn(f.options.authority.resolve),
    application = vi.fn(f.options.application);
  const checks = createSupportReleaseFollowupChecks(
    {
      ...f.options,
      store: observed.store,
      readApiKey: credential,
      authority: { resolve: authority },
      application,
    },
    "pegma.dev",
  );
  expect(
    await checks.resolvePolicy(f.input.binding.checkPolicyVersion, signal()),
  ).toEqual({ outcome: "unavailable" });
  expect(await checks.forWork(f.f.key).check(f.input, f.context)).toEqual({
    outcome: "held",
  });
  expect(credential).not.toHaveBeenCalled();
  expect(authority).not.toHaveBeenCalled();
  expect(application).not.toHaveBeenCalled();
  expect(observed.writes).not.toHaveBeenCalled();
  expect(f.wire.state.calls).toBe(0);
  // Existing receipt-HMAC key reads are deliberately outside these provider assertions.
}

describe("SD05 independent-check provider-group opt-in", () => {
  it("checks the actual bundle, verifies its sf1 receipt and posts through the public application once", async () => {
    const f = await fixture(),
      port = f.checks.forWork(f.f.key);
    const checked = await port.check(f.input, f.context);
    expect(checked.outcome).toBe("checked");
    if (checked.outcome !== "checked")
      throw new Error("Actual SD05 checked receipt required");
    expect(checked.receipt).toMatch(/^sf1\./u);
    expect(
      await f.checks.sdkVerifier.verify(
        checked.receipt,
        f.input.binding,
        signal(),
      ),
    ).not.toBeNull();
    expect(
      await f.checks
        .currentVerifierFor(f.f.key)
        .verify(checked.receipt, f.input.binding, signal()),
    ).not.toBeNull();
    expect(wireBody(f).provider).toEqual({
      only: ["azure"],
      allow_fallbacks: false,
      data_collection: "deny",
      zdr: true,
      require_parameters: true,
      max_price: PRICE,
    });
    await f.f.prepareBundle({
      exactBundle: f.input.exactBundle,
      checksReceipt: checked.receipt,
      checkPolicyVersion: f.input.binding.checkPolicyVersion,
    });
    expect((await f.f.post()).result.messageId).toBeTruthy();
    expect(f.wire.state.calls).toBe(1);
  });

  it("changes only provider selection/price in the complete direct wire and retains legacy content", async () => {
    const f = await followupChecksFixture(),
      input = request(f),
      context = directContext(f);
    const legacy = createSupportIndependentCheckModel(
      f.wire.options,
      "pegma.dev",
    );
    expect(await legacy.resolve()).not.toBeNull();
    await legacy.generate(input, context, f.wire.c);
    const legacyWire = wireBody(f);
    group(f.wire);
    await approve(f.wire);
    const grouped = createSupportIndependentCheckModel(
      f.wire.options,
      "pegma.dev",
    );
    expect(await grouped.resolve()).not.toBeNull();
    expect(
      grouped.parseVerdict(
        (await grouped.generate(input, context, f.wire.c)).outputJson,
      ),
    ).toEqual(CHECK_PASS);
    const groupedWire = wireBody(f, 1);
    expect(groupedWire.provider).toEqual({
      ...legacyWire.provider,
      only: ["azure"],
      max_price: PRICE,
    });
    expect(
      JSON.stringify({ ...groupedWire, provider: legacyWire.provider }),
    ).toBe(JSON.stringify(legacyWire));
    expect(f.wire.state.calls).toBe(2);
  });

  it.each(Array.from({ length: 8 }, (_, value) => value))(
    "requires all three opt-ins while retaining legacy mask %i",
    async (mask) => {
      const f = await followupChecksFixture();
      if (mask & 1) {
        f.wire.route.endpointTag = "azure";
        f.wire.options.allowlist[0]!.endpointTag = "azure";
        f.wire.route.providerSelectionScope = "provider_group";
        f.wire.route.providerMaxPrice = { ...PRICE };
      }
      if (mask & 2)
        f.wire.route.approval.providerSelectionScope = "provider_group";
      if (mask & 4)
        Reflect.set(
          f.wire.options.allowlist[0]!,
          "providerSelectionScope",
          "provider_group",
        );
      await approve(f.wire);
      if (mask !== 0 && mask !== 7) return refusesBeforeProviderOrAdmission(f);
      const checks = createSupportReleaseFollowupChecks(f.options, "pegma.dev");
      expect(
        (await checks.forWork(f.f.key).check(f.input, f.context)).outcome,
      ).toBe("checked");
      expect(f.wire.state.calls).toBe(1);
    },
  );

  for (const mode of ["missing", "undefined", "contradictory"] as const) {
    it.each([
      "route scope",
      "approval scope",
      "allowlist scope",
      "price",
    ] as const)(
      `holds a ${mode} %s without provider credentials or funding`,
      async (field) => {
        const f = await fixture();
        const target =
          field === "approval scope"
            ? f.wire.route.approval
            : field === "allowlist scope"
              ? f.wire.options.allowlist[0]!
              : f.wire.route;
        const property =
          field === "price" ? "providerMaxPrice" : "providerSelectionScope";
        if (mode === "missing") Reflect.deleteProperty(target, property);
        else
          Reflect.set(
            target,
            property,
            mode === "undefined"
              ? undefined
              : field === "price"
                ? { ...PRICE, request: 1 }
                : "endpoint",
          );
        // An own undefined route key cannot obtain a canonical approval hash.
        // Preserve the last valid approval and exercise the runtime refusal.
        if (
          mode !== "undefined" ||
          field === "approval scope" ||
          field === "allowlist scope"
        )
          await approve(f.wire);
        await refusesBeforeProviderOrAdmission(f);
      },
    );
  }

  it.each([
    "missing",
    "expired",
    "future",
    "wrong purpose",
    "wrong wire",
    "short window",
  ] as const)(
    "retains the separate SD05 profile requirement: %s",
    async (fault) => {
      const f = await fixture(),
        evidence = f.wire.route.releaseFollowup!;
      if (fault === "missing")
        Reflect.deleteProperty(f.wire.route, "releaseFollowup");
      if (fault === "expired") evidence.validUntil = f.wire.state.now;
      if (fault === "future")
        evidence.verifiedAt = new Date(
          Date.parse(f.wire.state.now) + 1,
        ).toISOString();
      if (fault === "wrong purpose")
        Reflect.set(evidence, "purpose", "support_independent_check");
      if (fault === "wrong wire")
        Reflect.set(
          evidence,
          "wireVersion",
          "openrouter-support-independent-check-v2",
        );
      if (fault === "short window")
        evidence.validUntil = new Date(
          Date.parse(f.wire.route.approval.validUntil) - 1,
        ).toISOString();
      await approve(f.wire);
      await refusesBeforeProviderOrAdmission(f);
    },
  );

  it("keeps generator group selection unsupported and never reads its provider key", async () => {
    const f = await followupModelFixture();
    Reflect.set(f.route, "providerSelectionScope", "provider_group");
    Reflect.set(f.route, "providerMaxPrice", PRICE);
    Reflect.set(f.route.approval, "providerSelectionScope", "provider_group");
    expect(
      (await f.model.configuration.resolve(undefined, signal())).outcome,
    ).toBe("unavailable");
    await expect(
      f.model.model.generate(f.input, f.context, f.c),
    ).rejects.toThrow();
    expect(f.key).not.toHaveBeenCalled();
    expect(f.state.calls).toBe(0);
  });
});

describe("SD05 group renewal and exact receipt recovery", () => {
  it("defers provider and receipt work in real later invocations and never repeats the physical call", async () => {
    const f = await fixture(),
      checks = createSupportReleaseFollowupChecks(
        { ...f.options, deferred: true },
        "pegma.dev",
      ),
      port = checks.forWork(f.f.key);
    expect(await port.check(f.input, f.context)).toMatchObject({
      outcome: "deferred",
      callState: "not_called",
    });
    expect(f.wire.state.calls).toBe(0);
    const [pending] = await checks.scanPending();
    expect(pending?.phase).toBe("provider");
    expect(
      await checks.precomputePending(pending!.operationId, f.context, f.f.key),
    ).toMatchObject({ outcome: "received" });
    expect((await checks.scanPending())[0]?.phase).toBe("receipt");
    expect(
      await checks.precomputePending(pending!.operationId, f.context, f.f.key),
    ).toMatchObject({ outcome: "checked" });
    const checked = await port.check(f.input, f.context);
    expect(checked.outcome).toBe("checked");
    if (checked.outcome !== "checked")
      throw new Error("Actual group receipt required");
    expect(
      await port.verify(checked.receipt, f.input.binding, signal()),
    ).not.toBeNull();
    expect(await port.check(f.input, f.context)).toEqual(checked);
    await checks.precomputePending(pending!.operationId, f.context, f.f.key);
    expect(f.wire.state.calls).toBe(1);
  });

  it.each(["price", "group", "hash"] as const)(
    "does not turn a renewed %s into permission to run an old queued request",
    async (change) => {
      const f = await fixture();
      const extra = {
        ...f.wire.options.allowlist[0]!,
        endpointTag: "fixture-other-group",
      };
      f.wire.options.allowlist.push(extra);
      f.wire.route.approval.validUntil = new Date(
        Date.parse(f.wire.state.now) + 120_000,
      ).toISOString();
      const key = vi.fn(f.options.readApiKey),
        checks = createSupportReleaseFollowupChecks(
          { ...f.options, deferred: true, readApiKey: key },
          "pegma.dev",
        );
      await checks.forWork(f.f.key).check(f.input, f.context);
      const [pending] = await checks.scanPending();
      expect(pending).toBeDefined();
      f.f.advance(1_000);
      f.wire.state.now = f.f.clock.now();
      f.wire.route.approval.verifiedAt = f.wire.state.now;
      f.wire.route.approval.validUntil = new Date(
        Date.parse(f.wire.state.now) + 180_000,
      ).toISOString();
      if (change === "price")
        f.wire.route.providerMaxPrice = { ...PRICE, prompt: 0.055 };
      if (change === "group") f.wire.route.endpointTag = extra.endpointTag;
      await approve(f.wire);
      if (change === "hash")
        f.wire.route.approval.requestPolicySha256 = "f".repeat(64);
      if (change !== "hash")
        expect(await checks.resolvePolicy(undefined, signal())).toMatchObject({
          outcome: "ready",
        });
      expect(
        (
          await checks.precomputePending(
            pending!.operationId,
            f.context,
            f.f.key,
          )
        ).outcome,
      ).toBe("held");
      expect(key).not.toHaveBeenCalled();
      expect(f.wire.state.calls).toBe(0);
    },
  );

  it.each(["before provider", "after provider"] as const)(
    "allows only a benign approval extension %s and retains the original receipt expiry",
    async (phase) => {
      const f = await fixture(),
        original = new Date(
          Date.parse(f.wire.state.now) + 120_000,
        ).toISOString();
      f.wire.route.approval.validUntil = original;
      let renewed = false;
      const renew = () => {
        if (renewed) return;
        renewed = true;
        f.f.advance(1_000);
        f.wire.state.now = f.f.clock.now();
        f.wire.route.approval.verifiedAt = f.wire.state.now;
        f.wire.route.approval.validUntil = new Date(
          Date.parse(f.wire.state.now) + 180_000,
        ).toISOString();
      };
      const confirm = f.options.releaseEvidence.confirm;
      const checks = createSupportReleaseFollowupChecks(
        {
          ...f.options,
          readApiKey: () => {
            if (phase === "before provider") renew();
            return "fictional-key";
          },
          releaseEvidence: {
            ...f.options.releaseEvidence,
            confirm: async (...args) => {
              const proof = await confirm(...args);
              if (phase === "after provider" && f.wire.state.calls === 1)
                renew();
              return proof;
            },
          },
        },
        "pegma.dev",
      );
      const checked = await checks.forWork(f.f.key).check(f.input, f.context);
      expect(renewed).toBe(true);
      expect(checked.outcome).toBe("checked");
      if (checked.outcome !== "checked")
        throw new Error("Benign renewed receipt required");
      const proof = await checks.sdkVerifier.verify(
        checked.receipt,
        f.input.binding,
        signal(),
      );
      expect(proof).not.toBeNull();
      expect(Date.parse(proof!.validUntil)).toBeLessThanOrEqual(
        Date.parse(original),
      );
      expect(f.wire.state.calls).toBe(1);
    },
  );

  it.each(["price", "hash", "approval expiry", "source authority"] as const)(
    "holds a late %s mutation before the physical callback can dispatch",
    async (change) => {
      const f = await fixture();
      const key = vi.fn(() => {
        if (change === "price")
          f.wire.route.providerMaxPrice = { ...PRICE, prompt: 0.04 };
        if (change === "hash")
          f.wire.route.approval.requestPolicySha256 = "f".repeat(64);
        if (change === "approval expiry")
          f.wire.route.approval.validUntil = f.wire.state.now;
        if (change === "source authority") f.state.active = false;
        return "fictional-provider-key";
      });
      const checks = createSupportReleaseFollowupChecks(
        { ...f.options, readApiKey: key },
        "pegma.dev",
      );
      expect(
        (await checks.forWork(f.f.key).check(f.input, f.context)).outcome,
      ).toBe("held");
      expect(key).toHaveBeenCalledTimes(1);
      expect(f.wire.state.calls).toBe(0);
    },
  );

  it.each([
    "missing cost",
    "unexpected provider",
    "reasoning tokens",
    "unknown fee",
    "over budget",
  ] as const)(
    "withholds an SD05 receipt after %s without a second opportunity",
    async (fault) => {
      const f = await fixture();
      if (fault === "missing cost")
        Reflect.deleteProperty(f.wire.state.document.usage, "cost");
      if (fault === "unexpected provider")
        f.wire.state.document.provider = "unapproved provider";
      if (fault === "reasoning tokens")
        Reflect.set(f.wire.state.document.usage, "completion_tokens_details", {
          reasoning_tokens: 1,
        });
      if (fault === "unknown fee")
        Reflect.set(f.wire.state.document.usage, "cost_details", {
          unreviewed_fee: 0.001,
        });
      if (fault === "over budget") f.wire.state.document.usage.cost = 0.001001;
      const port = f.checks.forWork(f.f.key);
      expect((await port.check(f.input, f.context)).outcome).toBe("held");
      expect((await port.check(f.input, f.context)).outcome).toBe("held");
      expect(f.wire.state.calls).toBe(1);
    },
  );
});
