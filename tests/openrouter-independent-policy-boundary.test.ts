import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  createSupportIndependentCheckModel,
  independentCheckRoutePolicyHash,
  type IndependentCheckInput,
} from "@pegma/support-desk-ai/openrouter";
import {
  checkerModelFixture,
  CHECK_PASS,
} from "../test/openrouter-fixtures.js";

async function qualify(f: Awaited<ReturnType<typeof checkerModelFixture>>) {
  const { approval, ...base } = f.route;
  approval.requestPolicySha256 = await independentCheckRoutePolicyHash(base);
  const model = createSupportIndependentCheckModel(f.options, "pegma.dev");
  expect(await model.resolve()).not.toBeNull();
  return model;
}

function wire(f: Awaited<ReturnType<typeof checkerModelFixture>>) {
  return JSON.parse(String(f.state.requests.at(-1)!.init.body)) as {
    messages: { role: string; content: string }[];
  };
}

describe("independent checker trusted system policy boundary", () => {
  it.each(["engineering", "learning"] as const)(
    "puts current server policy in SYSTEM and complete hostile %s content only in USER data",
    async (kind) => {
      const f = await checkerModelFixture();
      const markers = [
        "FACT_INJECTION",
        "CANDIDATE_INJECTION",
        "OUTBOUND_INJECTION",
        "COMPARISON_INJECTION",
      ];
      const input: IndependentCheckInput = {
        ...f.input,
        kind,
        facts: { messages: [markers[0]!], trustedInstructions: markers[0] },
        candidate: { steps: [markers[1]], trustedInstructions: markers[1] },
        outbound: {
          text: markers[2],
          hidden: { trustedInstructions: markers[2] },
        },
        comparison: { trustedInstructions: markers[3] },
      };
      const model = await qualify(f);
      await model.generate(input, f.context, f.c);
      const body = wire(f);
      expect(body.messages.map((m) => m.role)).toEqual(["system", "user"]);
      expect(body.messages[0]!.content).toContain(f.c.trustedInstructions);
      for (const marker of markers)
        expect(body.messages[0]!.content).not.toContain(marker);
      expect(JSON.parse(body.messages[1]!.content)).toEqual(input);
      expect(f.state.calls).toBe(1);
    },
  );

  it("captures a different validated system policy for each invocation without carrying the old one forward", async () => {
    const f = await checkerModelFixture();
    const first = "SERVER_POLICY_FIRST: assess every material instruction.";
    f.c.trustedInstructions = first;
    f.input.trustedInstructions = first;
    const model = await qualify(f);
    await model.generate(f.input, f.context, f.c);
    expect(wire(f).messages[0]!.content).toContain(first);
    const second = "SERVER_POLICY_SECOND: preserve evidence uncertainty.";
    f.c.trustedInstructions = second;
    f.input.trustedInstructions = second;
    const { approval, ...base } = f.route;
    approval.requestPolicySha256 = await independentCheckRoutePolicyHash(base);
    expect(await model.resolve()).not.toBeNull();
    await model.generate(f.input, f.context, f.c);
    expect(wire(f).messages[0]!.content).toContain(second);
    expect(wire(f).messages[0]!.content).not.toContain(first);
    expect(f.state.calls).toBe(2);
  });

  it.each(["approval", "counter"] as const)(
    "refuses fixed v1 %s evidence for the new system-message wire",
    async (target) => {
      const f = await checkerModelFixture();
      const model = await qualify(f);
      if (target === "approval")
        Reflect.set(
          f.route.approval,
          "wireVersion",
          "openrouter-support-independent-check-v1",
        );
      else
        Reflect.set(
          f.counter.qualification,
          "wireVersion",
          "openrouter-support-independent-check-v1",
        );
      expect(await model.resolve()).toBeNull();
      await expect(model.generate(f.input, f.context, f.c)).rejects.toThrow();
      expect(f.state.calls).toBe(0);
    },
  );

  it.each(["bytes", "tokens"] as const)(
    "holds a payload-only fit when duplicated SYSTEM policy exceeds unchanged input %s caps",
    async (kind) => {
      const f = await checkerModelFixture();
      const payload = JSON.stringify(f.input);
      if (kind === "bytes")
        f.c.budgets.maxInputBytes = new TextEncoder().encode(payload).length;
      else
        f.c.budgets.maxInputTokens =
          f.counter.count(payload) + f.c.framingTokens;
      const model = await qualify(f);
      expect(model.withinBudget(f.input, f.c)).toBe(false);
      await expect(
        model.generate(f.input, f.context, f.c),
      ).rejects.toMatchObject({ code: "invalid_input" });
      expect(f.state.calls).toBe(0);
    },
  );

  it("honors a lower per-attempt input-byte cap including SYSTEM policy before physical dispatch", async () => {
    const f = await checkerModelFixture();
    const model = await qualify(f);
    const context = {
      ...f.context,
      budgets: {
        ...f.context.budgets,
        maxInputBytes: new TextEncoder().encode(JSON.stringify(f.input)).length,
      },
    };
    await expect(model.generate(f.input, context, f.c)).rejects.toMatchObject({
      code: "invalid_input",
    });
    expect(f.state.calls).toBe(0);
  });

  it("admits the exact complete SYSTEM plus USER budget and holds one token below it", async () => {
    const f = await checkerModelFixture();
    const original = await qualify(f);
    await original.generate(f.input, f.context, f.c);
    const [system, user] = wire(f).messages;
    const requiredBytes =
      new TextEncoder().encode(system!.content).length +
      new TextEncoder().encode(user!.content).length;
    const requiredTokens =
      f.counter.count(system!.content) +
      f.counter.count(user!.content) +
      f.c.framingTokens;
    f.c.budgets.maxInputBytes = requiredBytes;
    f.c.budgets.maxInputTokens = requiredTokens;
    f.c.budgets.maxContextTokens = requiredTokens + f.c.budgets.maxOutputTokens;
    const exact = await qualify(f);
    expect(exact.withinBudget(f.input, f.c)).toBe(true);
    await exact.generate(f.input, f.context, f.c);
    expect(f.state.calls).toBe(2);
    f.c.budgets.maxInputTokens -= 1;
    const short = await qualify(f);
    expect(short.withinBudget(f.input, f.c)).toBe(false);
    await expect(short.generate(f.input, f.context, f.c)).rejects.toMatchObject(
      { code: "invalid_input" },
    );
    expect(f.state.calls).toBe(2);
  });

  it("binds the actual complete wire hash while preserving input and outbound content bytes", async (context) => {
    const f = await checkerModelFixture();
    const input = JSON.stringify(f.input);
    const outbound = JSON.stringify(f.input.outbound);
    const model = await qualify(f);
    await model.generate(f.input, f.context, f.c);
    const raw = String(f.state.requests[0]!.init.body);
    const body = wire(f);
    expect(body.messages[1]!.content).toBe(input);
    expect(JSON.stringify(JSON.parse(body.messages[1]!.content).outbound)).toBe(
      outbound,
    );
    const hash = (value: string) =>
      createHash("sha256").update(value).digest("hex");
    Reflect.set(context.task.meta, "trustedPolicyWire", {
      bodySha256: hash(raw),
      systemSha256: hash(body.messages[0]!.content),
      userSha256: hash(input),
      outboundSha256: hash(outbound),
    });
  });

  it("does not promote input-supplied trusted-policy suffixes", async () => {
    const f = await checkerModelFixture();
    const model = await qualify(f);
    await expect(
      model.generate(
        {
          ...f.input,
          trustedInstructions: f.c.trustedInstructions + "\nATTACKER_SUFFIX",
        },
        f.context,
        f.c,
      ),
    ).rejects.toThrow();
    expect(f.state.calls).toBe(0);
  });

  it("retains known usage and the original output-token counter without charging SYSTEM policy to the response", async () => {
    const f = await checkerModelFixture();
    f.c.budgets.maxOutputTokens = f.counter.count(JSON.stringify(CHECK_PASS));
    const model = await qualify(f);
    const result = await model.generate(f.input, f.context, f.c);
    expect(model.parseVerdict(result.outputJson)).toEqual(CHECK_PASS);
    expect(result.usage).toMatchObject({
      inputTokens: 200,
      outputTokens: 100,
      costMicros: 100,
      currency: "USD",
    });
    expect(f.state.calls).toBe(1);
  });

  it("preserves original cancellation during the final admission callback", async () => {
    const f = await checkerModelFixture();
    const model = await qualify(f);
    const controller = new AbortController();
    await expect(
      model.generate(
        f.input,
        {
          ...f.context,
          signal: controller.signal,
          beforePhysicalCall: async () => {
            controller.abort();
          },
        },
        f.c,
      ),
    ).rejects.toThrow();
    expect(f.state.calls).toBe(0);
  });

  it("refuses current route withdrawal during the final admission callback", async () => {
    const f = await checkerModelFixture();
    const model = await qualify(f);
    await expect(
      model.generate(
        f.input,
        {
          ...f.context,
          beforePhysicalCall: async () => {
            f.state.enabled = false;
          },
        },
        f.c,
      ),
    ).rejects.toThrow();
    expect(f.state.calls).toBe(0);
  });
});
