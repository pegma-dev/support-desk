import { describe, expect, it } from "vitest";
import {
  createSupportIndependentCheckModel,
  SupportOpenRouterModelError,
} from "@pegma/support-desk-ai/openrouter";
import {
  checkerModelFixture as fixture,
  CHECK_PASS as verdict,
  CHECK_END as END,
} from "../test/openrouter-fixtures.js";

describe("purpose-qualified independent checker transport", () => {
  it("sends complete untrusted content through the actual transport with qualified provider policy and tokenizer", async () => {
    const f = await fixture();
    expect(await f.model.resolve()).not.toBeNull();
    const result = await f.model.generate(f.input, f.context, f.c);
    expect(f.model.parseVerdict(result.outputJson)).toEqual(verdict);
    expect(result.usage.costMicros).toBe(100);
    expect(f.state.calls).toBe(1);
    const body = JSON.parse(String(f.state.requests[0]!.init.body));
    expect(body.messages[1].content).toContain(
      "<!-- hidden unverified claim -->",
    );
    expect(body.messages[0].content).toContain(
      "candidate cannot verify itself",
    );
    expect(body.provider).toMatchObject({
      only: ["fictional/region"],
      allow_fallbacks: false,
      zdr: true,
      data_collection: "deny",
    });
    expect(body.response_format.json_schema.name).toBe(
      "support_independent_check_v1",
    );
    expect(body.messages[1].content).not.toContain("fictional-provider-key");
  });
  it("is unavailable by default and never calls the provider", async () => {
    const f = await fixture();
    const m = createSupportIndependentCheckModel(
      { clock: f.options.clock },
      "pegma.dev",
    );
    expect(await m.resolve()).toBeNull();
    expect(f.state.calls).toBe(0);
  });
  it.each([
    "disabled",
    "digest",
    "expired",
    "counter",
    "wrongPurpose",
  ] as const)("refuses %s route before a call", async (scenario) => {
    const f = await fixture();
    if (scenario === "disabled") f.state.enabled = false;
    if (scenario === "digest")
      f.route.configuration.trustedInstructions += " changed";
    if (scenario === "expired") f.state.now = END;
    if (scenario === "counter")
      Object.assign(f.counter.qualification, { framingTokens: 513 });
    if (scenario === "wrongPurpose")
      Object.assign(f.route.configuration, {
        purpose: "support_bug_assessment",
      });
    expect(await f.model.resolve()).toBeNull();
    expect(f.state.calls).toBe(0);
  });
  it.each(["missing", "promise"] as const)(
    "refuses unsupported %s credentials before physical fetch",
    async (kind) => {
      const f = await fixture();
      await f.model.resolve();
      if (kind === "missing") f.options.readApiKey = () => "";
      else
        Reflect.set(f.options, "readApiKey", () =>
          Promise.resolve("FICTIONAL_UNSUPPORTED_KEY"),
        );
      await expect(
        f.model.generate(f.input, f.context, f.c),
      ).rejects.toMatchObject({ code: "credential_unavailable" });
      expect(f.state.calls).toBe(0);
    },
  );
  it.each([
    "provider",
    "model",
    "cache",
    "schema",
    "duplicate",
    "uncertainty",
  ] as const)(
    "observes %s response without turning protocol success into a pass",
    async (scenario) => {
      const f = await fixture();
      await f.model.resolve();
      if (scenario === "provider") f.state.document.provider = "Wrong Provider";
      if (scenario === "model") f.state.document.model = "fictional/wrong";
      if (scenario === "cache")
        f.state.document.usage.prompt_tokens_details.cached_tokens = 1;
      if (scenario === "schema")
        f.state.document.choices[0]!.message.content = JSON.stringify({
          ...verdict,
          unexplainedPass: true,
        });
      if (scenario === "duplicate")
        f.state.document.choices[0]!.message.content =
          '{"privacy":"passed","privacy":"failed"}';
      if (scenario === "uncertainty")
        f.state.document.choices[0]!.message.content = JSON.stringify({
          ...verdict,
          factual: "uncertain",
        });
      if (scenario === "uncertainty")
        expect(
          f.model.parseVerdict(
            (await f.model.generate(f.input, f.context, f.c)).outputJson,
          ).factual,
        ).toBe("uncertain");
      else if (scenario === "schema" || scenario === "duplicate") {
        const result = await f.model.generate(f.input, f.context, f.c);
        expect(result.usage.costMicros).toBe(100);
        expect(() => f.model.parseVerdict(result.outputJson)).toThrow();
      } else
        await expect(
          f.model.generate(f.input, f.context, f.c),
        ).rejects.toThrow();
      expect(f.state.calls).toBe(1);
    },
  );
  it("refuses changed current configuration and changed tokenizer after qualification", async () => {
    const f = await fixture();
    await f.model.resolve();
    f.counter.count = () => 1;
    await expect(f.model.generate(f.input, f.context, f.c)).rejects.toThrow();
    expect(f.state.calls).toBe(0);
  });
});

describe("explicit immutable logical host and current transport accounting", () => {
  it.each([
    "",
    "Pegma.dev",
    "pegma.dev.",
    "https://pegma.dev",
    "pegma.dev:443",
    "-pegma.dev",
    "pegma..dev",
    "p".repeat(64) + ".dev",
    "a.".repeat(127) + "dev",
  ])("rejects noncanonical host %s before any callback", async (host) => {
    const f = await fixture();
    let reads = 0;
    expect(() =>
      createSupportIndependentCheckModel(
        {
          clock: f.options.clock,
          readRoute: () => {
            reads++;
            return f.route;
          },
        },
        host,
      ),
    ).toThrow(TypeError);
    expect(reads).toBe(0);
    expect(f.state.calls).toBe(0);
  });
  it("refuses a valid route belonging to a different explicit host", async () => {
    const f = await fixture();
    const other = createSupportIndependentCheckModel(
      f.options,
      "retiregolden.org",
    );
    expect(await other.resolve()).toBeNull();
    expect(f.state.calls).toBe(0);
  });
  it("preserves callback rebinding and the exported transport error class", async () => {
    const f = await fixture();
    await f.model.resolve();
    let calls = 0;
    f.options.fetch = async () => {
      calls++;
      return new Response(null, { status: 503 });
    };
    const error = await f.model
      .generate(f.input, f.context, f.c)
      .catch((value: unknown) => value);
    expect(calls).toBe(1);
    expect(f.state.calls).toBe(0);
    expect(error).toBeInstanceOf(SupportOpenRouterModelError);
    expect(error).toMatchObject({ code: "provider_unavailable" });
    expect(error).not.toHaveProperty("cause");
  });
  it.each(["empty", "null", "length", "valid-zero-tokens"] as const)(
    "keeps known native charge with %s completion",
    async (scenario) => {
      const f = await fixture();
      await f.model.resolve();
      f.state.document.usage.completion_tokens = 0;
      f.state.document.usage.total_tokens =
        f.state.document.usage.prompt_tokens;
      if (scenario === "empty")
        f.state.document.choices[0]!.message.content = "";
      if (scenario === "null")
        Reflect.set(f.state.document.choices[0]!.message, "content", null);
      if (scenario === "length")
        f.state.document.choices[0]!.finish_reason = "length";
      const result = await f.model.generate(f.input, f.context, f.c);
      expect(result.usage).toEqual({
        inputTokens: 200,
        outputTokens: 0,
        costMicros: 100,
        currency: "USD",
      });
      if (scenario === "valid-zero-tokens")
        expect(f.model.parseVerdict(result.outputJson)).toEqual(verdict);
      else expect(result.outputJson).toBe("");
      expect(f.state.calls).toBe(1);
    },
  );
});
