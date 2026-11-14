import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createMemoryStore } from "@pegma/storage-core";
import {
  createSupportIndependentCheckModel,
  createSupportOpenRouterModel,
  createSupportReleaseFollowupChecks,
  independentCheckRoutePolicyHash,
  INDEPENDENT_CHECK_ENDPOINT,
  INDEPENDENT_CHECK_PURPOSE,
  type ReleaseFollowupIndependentCheckInput,
} from "@pegma/support-desk-ai/openrouter";
import {
  checkerModelFixture,
  CHECK_PASS,
} from "../test/openrouter-fixtures.js";
import { followupChecksFixture } from "../test/openrouter-release-followup-fixtures.js";

type Fixture = Awaited<ReturnType<typeof checkerModelFixture>>;
const PRICE = { prompt: 0.05, completion: 0.1, request: 0 } as const;
const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");

async function approve(f: Fixture) {
  const { approval, ...base } = f.route;
  approval.requestPolicySha256 = await independentCheckRoutePolicyHash(base);
}

function group(f: Fixture) {
  f.route.endpointTag = "azure";
  Reflect.set(f.route, "providerSelectionScope", "provider_group");
  Reflect.set(f.route, "providerMaxPrice", { ...PRICE });
  Reflect.set(f.route.approval, "providerSelectionScope", "provider_group");
  f.options.allowlist[0]!.endpointTag = "azure";
  Reflect.set(
    f.options.allowlist[0]!,
    "providerSelectionScope",
    "provider_group",
  );
}

async function groupFixture() {
  const f = await checkerModelFixture();
  group(f);
  await approve(f);
  const model = createSupportIndependentCheckModel(f.options, "pegma.dev");
  return { ...f, model };
}

function wire(f: Fixture) {
  return JSON.parse(String(f.state.requests.at(-1)!.init.body)) as {
    messages: { role: string; content: string }[];
    provider: Record<string, unknown>;
    [key: string]: unknown;
  };
}

async function refusesBeforeCredentials(f: Fixture) {
  const credential = vi.fn(f.options.readApiKey);
  f.options.readApiKey = credential;
  const admission = vi.fn(async () => {});
  const physical = vi.fn();
  expect(await f.model.resolve()).toBeNull();
  await expect(
    f.model.generate(
      f.input,
      {
        ...f.context,
        beforePhysicalCall: admission,
        onPhysicalCall: physical,
      },
      f.c,
    ),
  ).rejects.toThrow();
  expect(credential).not.toHaveBeenCalled();
  expect(admission).not.toHaveBeenCalled();
  expect(physical).not.toHaveBeenCalled();
  expect(f.state.calls).toBe(0);
}

describe("explicit independent-check provider groups", () => {
  it("preserves the fixed legacy route hash, parsed keys and complete request bytes when the new fields are omitted", async () => {
    const f = await checkerModelFixture();
    expect(f.route.approval.requestPolicySha256).toBe(
      "a80a31ceaa5fedaf772cba38da2fa50ed4d9abaf5ffb731c1bc854cea77f9db3",
    );
    expect(await f.model.resolve()).not.toBeNull();
    const parsed = f.model.currentRoute();
    expect(parsed).toEqual(f.route);
    expect(Object.keys(parsed!).sort()).toEqual(Object.keys(f.route).sort());
    expect(parsed).not.toHaveProperty("providerSelectionScope");
    expect(parsed).not.toHaveProperty("providerMaxPrice");
    expect(parsed!.approval).not.toHaveProperty("providerSelectionScope");
    await f.model.generate(f.input, f.context, f.c);
    expect(sha256(String(f.state.requests[0]!.init.body))).toBe(
      "b82aa04aa9b048dd6fb60207cce786c64881544e6b776993ef7f5bd2766b4274",
    );
    expect(wire(f).provider).toEqual({
      only: ["fictional/region"],
      allow_fallbacks: false,
      data_collection: "deny",
      zdr: true,
      require_parameters: true,
    });
  });

  it.each(["route scope", "route price", "approval scope"] as const)(
    "refuses an explicitly present undefined %s before credentials or dispatch",
    async (field) => {
      const f = await checkerModelFixture();
      expect(await f.model.resolve()).not.toBeNull();
      const approvedHash = f.route.approval.requestPolicySha256;
      const target = field === "approval scope" ? f.route.approval : f.route;
      const key =
        field === "route price" ? "providerMaxPrice" : "providerSelectionScope";
      Reflect.set(target, key, undefined);
      expect(Object.hasOwn(target, key)).toBe(true);
      expect(f.route.approval.requestPolicySha256).toBe(approvedHash);
      await refusesBeforeCredentials(f);
    },
  );

  it.each(Array.from({ length: 8 }, (_, mask) => mask))(
    "requires matching route, approval and allowlist scope opt-ins (mask %i)",
    async (mask) => {
      const f = await checkerModelFixture();
      if (mask & 1) {
        f.route.endpointTag = "azure";
        f.options.allowlist[0]!.endpointTag = "azure";
        Reflect.set(f.route, "providerSelectionScope", "provider_group");
        Reflect.set(f.route, "providerMaxPrice", { ...PRICE });
      }
      if (mask & 2)
        Reflect.set(
          f.route.approval,
          "providerSelectionScope",
          "provider_group",
        );
      if (mask & 4)
        Reflect.set(
          f.options.allowlist[0]!,
          "providerSelectionScope",
          "provider_group",
        );
      await approve(f);
      const model = createSupportIndependentCheckModel(f.options, "pegma.dev");
      const current = { ...f, model };
      if (mask === 0 || mask === 7) {
        expect(await model.resolve()).not.toBeNull();
        expect(
          model.parseVerdict(
            (await model.generate(f.input, f.context, f.c)).outputJson,
          ),
        ).toEqual(CHECK_PASS);
        expect(f.state.calls).toBe(1);
      } else await refusesBeforeCredentials(current);
    },
  );

  it("sends only the group selector and explicit prices while preserving all privacy controls and the frozen SYSTEM and USER", async () => {
    const legacy = await checkerModelFixture();
    expect(await legacy.model.resolve()).not.toBeNull();
    await legacy.model.generate(legacy.input, legacy.context, legacy.c);
    const f = await groupFixture();
    expect(await f.model.resolve()).not.toBeNull();
    const result = await f.model.generate(f.input, f.context, f.c);
    expect(f.model.parseVerdict(result.outputJson)).toEqual(CHECK_PASS);
    expect(f.state.requests[0]!.url).toBe(INDEPENDENT_CHECK_ENDPOINT);
    expect(wire(f).provider).toEqual({
      only: ["azure"],
      allow_fallbacks: false,
      data_collection: "deny",
      zdr: true,
      require_parameters: true,
      max_price: { prompt: 0.05, completion: 0.1, request: 0 },
    });
    expect(wire(f)).toEqual({ ...wire(legacy), provider: wire(f).provider });
    expect(sha256(wire(f).messages[0]!.content)).toBe(
      "b5e1901057196db873ca9d0245b6cdac5bb2c50ab1de6d4128904223fe4bc5c4",
    );
    expect(sha256(wire(f).messages[1]!.content)).toBe(
      "a8bd2c77c4d2b1a5a61739914a4271bf56e75e1ce9b8fcba423e757454bc7d47",
    );
    expect(f.state.requests[0]!.init).toMatchObject({
      method: "POST",
      redirect: "error",
      cache: "no-store",
      credentials: "omit",
      headers: {
        "X-OpenRouter-Cache": "false",
        "Cache-Control": "no-store",
      },
    });
    expect(f.state.calls).toBe(1);
  });

  it.each([
    "azure/region",
    "azure/eastus",
    "Azure",
    "azure_*",
    "azure,other",
    "azure/",
    "*",
    "",
  ])(
    "refuses non-bare group selector %j even with a matching allowlist and fresh hash",
    async (endpointTag) => {
      const f = await groupFixture();
      f.route.endpointTag = endpointTag;
      f.options.allowlist[0]!.endpointTag = endpointTag;
      await approve(f);
      const model = createSupportIndependentCheckModel(f.options, "pegma.dev");
      await refusesBeforeCredentials({ ...f, model });
    },
  );

  it.each(["fictional/region", "azure/eastus.v2/nested", "fictional/a_-b"])(
    "keeps legacy qualified selector %s valid with all group fields omitted",
    async (endpointTag) => {
      const f = await checkerModelFixture();
      f.route.endpointTag = endpointTag;
      f.options.allowlist[0]!.endpointTag = endpointTag;
      await approve(f);
      const model = createSupportIndependentCheckModel(f.options, "pegma.dev");
      expect(await model.resolve()).not.toBeNull();
      await model.generate(f.input, f.context, f.c);
      expect(wire(f).provider.only).toEqual([endpointTag]);
      expect(wire(f).provider).not.toHaveProperty("max_price");
    },
  );

  it("does not infer group scope from a bare slug on a legacy route", async () => {
    const f = await checkerModelFixture();
    f.route.endpointTag = "azure";
    f.options.allowlist[0]!.endpointTag = "azure";
    await approve(f);
    const model = createSupportIndependentCheckModel(f.options, "pegma.dev");
    await refusesBeforeCredentials({ ...f, model });
  });

  it("binds group semantics and every price to a new reviewed route hash", async () => {
    const f = await checkerModelFixture();
    group(f);
    f.model = createSupportIndependentCheckModel(f.options, "pegma.dev");
    await refusesBeforeCredentials(f);
    await approve(f);
    const first = f.route.approval.requestPolicySha256;
    expect(await f.model.resolve()).not.toBeNull();
    Reflect.set(f.route, "providerMaxPrice", { ...PRICE, completion: 0.09 });
    await refusesBeforeCredentials(f);
    await approve(f);
    expect(f.route.approval.requestPolicySha256).not.toBe(first);
    expect(await f.model.resolve()).not.toBeNull();
    await f.model.generate(f.input, f.context, f.c);
    expect(wire(f).provider.max_price).toEqual({ ...PRICE, completion: 0.09 });
  });
});

describe("group text-price ceilings", () => {
  it("refuses a lower live attempt cost cap before credentials when the current token envelope can cost more", async () => {
    const f = await groupFixture();
    expect(await f.model.resolve()).not.toBeNull();
    const credential = vi.fn(f.options.readApiKey);
    f.options.readApiKey = credential;
    const admission = vi.fn(async () => {});
    const physical = vi.fn();
    // The configured envelope costs at most 900 micros; the fictional native
    // response would cost only 100. Admission must bound the request first.
    await expect(
      f.model.generate(
        f.input,
        {
          ...f.context,
          budgets: { ...f.context.budgets, maxCostMicros: 899 },
          beforePhysicalCall: admission,
          onPhysicalCall: physical,
        },
        f.c,
      ),
    ).rejects.toThrow();
    expect(credential).not.toHaveBeenCalled();
    expect(admission).not.toHaveBeenCalled();
    expect(physical).not.toHaveBeenCalled();
    expect(f.state.calls).toBe(0);
  });

  it.each([
    {
      name: "zero prices",
      prompt: 0,
      completion: 0,
      input: 16_000,
      output: 1000,
      maximum: 1,
      allowed: true,
    },
    {
      name: "USD per million, not USD per token",
      prompt: 0.05,
      completion: 0.1,
      input: 16_000,
      output: 1000,
      maximum: 900,
      allowed: true,
    },
    {
      name: "one micro below the configured worst case",
      prompt: 0.05,
      completion: 0.1,
      input: 16_000,
      output: 1000,
      maximum: 899,
      allowed: false,
    },
    {
      name: "exact integral boundary",
      prompt: 0.05625,
      completion: 0.1,
      input: 16_000,
      output: 1000,
      maximum: 1000,
      allowed: true,
    },
    {
      name: "decimal just over integral boundary",
      prompt: 0.05625000000000001,
      completion: 0.1,
      input: 16_000,
      output: 1000,
      maximum: 1000,
      allowed: false,
    },
    {
      name: "combined decimal rounding instead of rounding each leg",
      prompt: 0.1,
      completion: 0.1,
      input: 3,
      output: 7,
      maximum: 1,
      allowed: true,
    },
    {
      name: "fractional micro rounds up",
      prompt: 0.00001,
      completion: 0,
      input: 16_000,
      output: 1000,
      maximum: 1,
      allowed: true,
    },
    {
      name: "smallest positive exponent rounds up",
      prompt: Number.MIN_VALUE,
      completion: 0,
      input: 16_000,
      output: 1000,
      maximum: 1,
      allowed: true,
    },
    {
      name: "huge finite price exceeds the safe budget",
      prompt: Number.MAX_VALUE,
      completion: 0,
      input: 16_000,
      output: 1000,
      maximum: Number.MAX_SAFE_INTEGER,
      allowed: false,
    },
  ])(
    "uses an exact decimal sum for $name",
    async ({ prompt, completion, input, output, maximum, allowed }) => {
      const f = await groupFixture();
      Reflect.set(f.route, "providerMaxPrice", {
        prompt,
        completion,
        request: 0,
      });
      Object.assign(f.c.budgets, {
        maxInputTokens: input,
        maxOutputTokens: output,
        maxContextTokens: input + output,
        maxCostMicros: maximum,
      });
      if (input <= f.c.framingTokens) {
        f.c.framingTokens = 0;
        Object.assign(f.counter.qualification, { framingTokens: 0 });
      }
      await approve(f);
      if (allowed) expect(await f.model.resolve()).not.toBeNull();
      else await refusesBeforeCredentials(f);
      expect(f.state.calls).toBe(0);
    },
  );

  const malformed: { name: string; value: unknown; hashable?: boolean }[] = [
    { name: "missing cap", value: undefined },
    { name: "null cap", value: null },
    { name: "empty cap", value: {} },
    { name: "missing prompt", value: { completion: 0.1, request: 0 } },
    { name: "missing completion", value: { prompt: 0.05, request: 0 } },
    { name: "missing request fee", value: { prompt: 0.05, completion: 0.1 } },
    { name: "negative prompt", value: { ...PRICE, prompt: -0.01 } },
    { name: "negative completion", value: { ...PRICE, completion: -0.01 } },
    { name: "text prompt", value: { ...PRICE, prompt: "0.05" } },
    { name: "text completion", value: { ...PRICE, completion: "0.1" } },
    { name: "NaN prompt", value: { ...PRICE, prompt: NaN }, hashable: false },
    {
      name: "infinite completion",
      value: { ...PRICE, completion: Infinity },
      hashable: false,
    },
    { name: "positive request fee", value: { ...PRICE, request: 0.000001 } },
    { name: "negative request fee", value: { ...PRICE, request: -1 } },
    { name: "text zero request fee", value: { ...PRICE, request: "0" } },
    { name: "extra image price", value: { ...PRICE, image: 0 } },
    { name: "extra request-fee feature", value: { ...PRICE, web_search: 0 } },
  ];
  it.each(malformed)(
    "refuses $name before credentials or admission",
    async ({ value, hashable }) => {
      const f = await groupFixture();
      if (value === undefined)
        Reflect.deleteProperty(f.route, "providerMaxPrice");
      else Reflect.set(f.route, "providerMaxPrice", value);
      if (hashable !== false) await approve(f);
      await refusesBeforeCredentials(f);
    },
  );

  it("does not add a price cap to a legacy route without the three group approvals", async () => {
    const f = await checkerModelFixture();
    Reflect.set(f.route, "providerMaxPrice", { ...PRICE });
    await approve(f);
    await refusesBeforeCredentials(f);
  });
});

describe("group route final dispatch fences", () => {
  it.each(["scope", "approval scope", "price", "selector"] as const)(
    "refuses a freshly rehashed %s mutation during final source admission before the physical callback",
    async (change) => {
      const f = await groupFixture();
      expect(await f.model.resolve()).not.toBeNull();
      const credential = vi.fn(f.options.readApiKey);
      f.options.readApiKey = credential;
      const physical = vi.fn();
      const admission = vi.fn(async () => {
        await Promise.resolve();
        if (change === "scope")
          Reflect.deleteProperty(f.route, "providerSelectionScope");
        if (change === "approval scope")
          Reflect.deleteProperty(f.route.approval, "providerSelectionScope");
        if (change === "price")
          Reflect.set(f.route, "providerMaxPrice", { ...PRICE, prompt: 0.04 });
        if (change === "selector") f.route.endpointTag = "other";
        await approve(f);
      });
      await expect(
        f.model.generate(
          f.input,
          {
            ...f.context,
            beforePhysicalCall: admission,
            onPhysicalCall: physical,
          },
          f.c,
        ),
      ).rejects.toThrow();
      expect(credential).toHaveBeenCalledTimes(1);
      expect(admission).toHaveBeenCalledTimes(1);
      expect(physical).not.toHaveBeenCalled();
      expect(f.state.calls).toBe(0);
    },
  );

  it("refuses a price mutation inside the synchronous credential callback before physical dispatch", async () => {
    const f = await groupFixture();
    expect(await f.model.resolve()).not.toBeNull();
    f.options.readApiKey = () => {
      Reflect.set(f.route, "providerMaxPrice", { ...PRICE, prompt: 0.04 });
      return "fictional-provider-key";
    };
    const physical = vi.fn();
    await expect(
      f.model.generate(
        f.input,
        { ...f.context, onPhysicalCall: physical },
        f.c,
      ),
    ).rejects.toThrow();
    expect(physical).not.toHaveBeenCalled();
    expect(f.state.calls).toBe(0);
  });

  it.each([undefined, false])(
    "does not let the shared transport serialize a group when its purpose protocol opt-in is %s",
    async (allowProviderGroup) => {
      const f = await groupFixture();
      expect(await f.model.resolve()).not.toBeNull();
      const credential = vi.fn(() => "fictional-provider-key");
      const model = createSupportOpenRouterModel(
        {
          clock: f.options.clock,
          configuration: f.model,
          readApiKey: credential,
          fetch: f.options.fetch,
        },
        {
          purpose: INDEPENDENT_CHECK_PURPOSE,
          endpoint: INDEPENDENT_CHECK_ENDPOINT,
          system: "Fictional raw protocol without group authorization.",
          schemaName: "fictional_raw",
          schema: {},
          ...(allowProviderGroup === undefined ? {} : { allowProviderGroup }),
          input: (value) => JSON.stringify(value),
          output: (content) => content,
          validate: () => {},
        },
      );
      await expect(
        model.generate(f.input, f.context, f.c),
      ).rejects.toMatchObject({ code: "route_unavailable" });
      expect(credential).not.toHaveBeenCalled();
      expect(f.state.calls).toBe(0);
    },
  );
});

describe("group routing preserves independent response guards", () => {
  it.each([
    "unknown response field",
    "unknown usage field",
    "reasoning text",
    "reasoning details",
    "reasoning tokens",
    "missing native charge",
    "unknown native fee",
  ] as const)(
    "rejects %s after exactly one physical group call",
    async (change) => {
      const f = await groupFixture();
      expect(await f.model.resolve()).not.toBeNull();
      if (change === "unknown response field")
        Reflect.set(f.state.document, "unreviewed", true);
      if (change === "unknown usage field")
        Reflect.set(f.state.document.usage, "unreviewed", 0);
      if (change === "reasoning text")
        Reflect.set(
          f.state.document.choices[0]!.message,
          "reasoning",
          "Unreviewed reasoning",
        );
      if (change === "reasoning details")
        Reflect.set(f.state.document.choices[0]!.message, "reasoning_details", [
          { text: "Unreviewed reasoning" },
        ]);
      if (change === "reasoning tokens")
        f.state.document.usage.completion_tokens_details.reasoning_tokens = 1;
      if (change === "missing native charge")
        Reflect.deleteProperty(f.state.document.usage, "cost");
      if (change === "unknown native fee")
        Reflect.set(f.state.document.usage, "cost_details", {
          web_search: 0.001,
        });
      const physical = vi.fn();
      await expect(
        f.model.generate(
          f.input,
          { ...f.context, onPhysicalCall: physical },
          f.c,
        ),
      ).rejects.toThrow();
      expect(physical).toHaveBeenCalledTimes(1);
      expect(f.state.calls).toBe(1);
    },
  );

  it("keeps the actual native charge and withholds the verdict when group usage exceeds the budget", async () => {
    const f = await groupFixture();
    expect(await f.model.resolve()).not.toBeNull();
    f.state.document.usage.cost = 0.001001;
    const result = await f.model.generate(f.input, f.context, f.c);
    expect(result.outputJson).toBe("");
    expect(result.usage.costMicros).toBe(1001);
    expect(f.state.calls).toBe(1);
  });
});

describe("SD05 remains outside provider-group approval", () => {
  it("refuses a group at SD05 model resolution even though the ordinary independent checker accepts it", async () => {
    const f = await groupFixture();
    expect(await f.model.resolve()).not.toBeNull();
    const model = createSupportIndependentCheckModel(f.options, "pegma.dev", {
      allowApprovalRenewal: true,
      allowProviderGroup: false,
    });
    await refusesBeforeCredentials({ ...f, model });
  });

  it("refuses a complete direct release_followup request before credentials despite live SD05 evidence", async () => {
    const f = await followupChecksFixture(createMemoryStore());
    group(f.wire);
    await approve(f.wire);
    const ordinary = createSupportIndependentCheckModel(
      f.wire.options,
      "pegma.dev",
    );
    expect(await ordinary.resolve()).not.toBeNull();
    const input: ReleaseFollowupIndependentCheckInput = {
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
    const credential = vi.fn(f.wire.options.readApiKey);
    f.wire.options.readApiKey = credential;
    const admission = vi.fn(async () => {});
    const physical = vi.fn();
    await expect(
      ordinary.generate(
        input,
        {
          ...f.wire.context,
          deadline: new Date(Date.parse(f.wire.state.now) + 2000).toISOString(),
          beforePhysicalCall: admission,
          onPhysicalCall: physical,
        },
        f.wire.c,
      ),
    ).rejects.toMatchObject({ code: "route_unavailable" });
    expect(credential).not.toHaveBeenCalled();
    expect(admission).not.toHaveBeenCalled();
    expect(physical).not.toHaveBeenCalled();
    expect(f.wire.state.calls).toBe(0);
  });

  it("makes SD05 policy unavailable and holds an actual check before model credentials, authority or durable admission", async () => {
    const f = await followupChecksFixture(createMemoryStore());
    group(f.wire);
    await approve(f.wire);
    const credential = vi.fn(() => "fictional-provider-key");
    const authority = vi.fn(f.options.authority.resolve);
    const application = vi.fn(f.options.application);
    const options = {
      ...f.options,
      allowlist: f.wire.options.allowlist,
      readApiKey: credential,
      authority: { resolve: authority },
      application,
    };
    const checks = createSupportReleaseFollowupChecks(options, "pegma.dev");
    expect(
      await checks.resolvePolicy(
        f.input.binding.checkPolicyVersion,
        new AbortController().signal,
      ),
    ).toEqual({ outcome: "unavailable" });
    expect(await checks.forWork(f.f.key).check(f.input, f.context)).toEqual({
      outcome: "held",
    });
    expect(credential).not.toHaveBeenCalled();
    expect(authority).not.toHaveBeenCalled();
    expect(application).not.toHaveBeenCalled();
    expect(f.wire.state.calls).toBe(0);
  });
});
