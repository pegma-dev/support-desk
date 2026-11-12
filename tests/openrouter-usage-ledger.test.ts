import {
  createMemoryStore,
  defineCollection,
  type Store,
} from "@pegma/storage-core";
import { describe, expect, it } from "vitest";
import {
  createSupportModelUsageLedger,
  type SupportModelUsagePolicy,
} from "@pegma/support-desk-ai/openrouter";

const START = "2026-11-10T12:00:00.000Z";
function fixture(overrides: Partial<SupportModelUsagePolicy> = {}) {
  const store = createMemoryStore();
  const state = { now: Date.parse(START) };
  const clock = { now: () => new Date(state.now).toISOString() };
  const policy: SupportModelUsagePolicy = {
    version: "fictional-funding-v1",
    scopeRef: "fictional-independent-budget",
    configurationVersion: "fictional-config",
    modelVersion: "fictional-model",
    pricingRef: "fictional-price",
    currency: "USD",
    maxCostMicros: 400,
    maxReservationCostMicros: 200,
    maxReservations: 8,
    validFrom: START,
    validUntil: "2026-11-10T13:00:00.000Z",
    terminalRetentionMilliseconds: 60_000,
    ...overrides,
  };
  const context = (ordinal = 1) => ({
    purpose: "support_independent_check",
    operationId: "operation-" + ordinal,
    attemptId: "attempt-" + ordinal,
    inputFingerprint: "a".repeat(64),
    usageReservationId: "reservation-" + ordinal,
    usageScopeRef: policy.scopeRef,
    configurationVersion: policy.configurationVersion,
    modelVersion: policy.modelVersion,
    deadline: new Date(state.now + 30_000).toISOString(),
    signal: new AbortController().signal,
    budgets: { currency: "USD", maxCostMicros: 200 },
  });
  type Context = ReturnType<typeof context>;
  const schema = {
    purpose: "support_independent_check",
    collection: "test.openrouter-usage.v1",
    key: { partition: "support_independent_check", id: "budget" },
    binding: (value: Context) => value.inputFingerprint,
    identity: (value: Context) => value,
  };
  const make = () =>
    createSupportModelUsageLedger<Context, Context>(
      { store, clock, policy },
      schema,
    );
  const snapshot = async () => {
    const reader = defineCollection<{ payload: string }>({
      name: schema.collection,
      key: () => schema.key,
      codec: {
        encode() {
          throw new Error("Read-only public raw payload observation");
        },
        decode(value) {
          if (
            value.partition !== schema.key.partition ||
            value.id !== schema.key.id ||
            typeof value.payload !== "string"
          )
            throw new Error("Expected actual usage payload");
          return { payload: value.payload };
        },
      },
    });
    return store.collection(reader).getVersioned(schema.key);
  };
  return { store, clock, state, policy, context, schema, make, snapshot };
}

describe("portable bounded durable usage ledger", () => {
  it("keeps missing policy inert before collection access", async () => {
    const f = fixture();
    let opened = 0;
    const denied: Store = {
      collection() {
        opened++;
        throw new Error("Must remain unopened");
      },
    };
    const ledger = createSupportModelUsageLedger(
      { store: denied, clock: f.clock },
      f.schema,
    );
    expect(await ledger.reserve(f.context())).toEqual({
      outcome: "unavailable",
    });
    expect(await ledger.reconcile(f.context(), { state: "unknown" })).toBe(
      "pending",
    );
    expect(opened).toBe(0);
  });
  it("preserves exact encoded bytes and versions on cold exact reserve/reconcile replay", async () => {
    const f = fixture();
    const command = f.context();
    expect(await f.make().reserve(command)).toMatchObject({
      outcome: "reserved",
    });
    const reserved = await f.snapshot();
    expect(await f.make().reserve(command)).toMatchObject({
      outcome: "reserved",
    });
    expect(await f.snapshot()).toEqual(reserved);
    const observation = {
      state: "known" as const,
      usage: {
        inputTokens: 50,
        outputTokens: 0,
        costMicros: 123,
        currency: "USD",
      },
    };
    expect(await f.make().reconcile(command, observation)).toBe("reconciled");
    const known = await f.snapshot();
    expect(await f.make().reconcile(command, observation)).toBe("reconciled");
    expect(await f.snapshot()).toEqual(known);
    expect(JSON.parse(known!.value.payload)).toMatchObject({
      spentMicros: "123",
      accountingHold: false,
    });
  });
  it("does not refund an unknown reservation using a later not_called observation", async () => {
    const f = fixture();
    const first = f.context();
    expect(await f.make().reserve(first)).toMatchObject({
      outcome: "reserved",
    });
    expect(await f.make().reconcile(first, { state: "unknown" })).toBe(
      "reconciled",
    );
    expect(await f.make().reconcile(first, { state: "not_called" })).toBe(
      "pending",
    );
    expect(await f.make().reserve(f.context(2))).toMatchObject({
      outcome: "reserved",
    });
    expect(await f.make().reserve(f.context(3))).toEqual({ outcome: "denied" });
    expect(
      JSON.parse((await f.snapshot())!.value.payload).reservations[0].state,
    ).toBe("unknown");
  });
  it("rejects changed identity and whole binding on an existing reservation", async () => {
    const f = fixture();
    const command = f.context();
    await f.make().reserve(command);
    const before = await f.snapshot();
    expect(
      await f.make().reserve({ ...command, inputFingerprint: "b".repeat(64) }),
    ).toEqual({ outcome: "denied" });
    expect(await f.snapshot()).toEqual(before);
    expect(await f.make().reserve(command)).toMatchObject({
      outcome: "reserved",
    });
  });
  it("records over-budget known charge and durably holds conflicting accepted accounting", async () => {
    const f = fixture();
    const command = f.context();
    await f.make().reserve(command);
    const usage = {
      inputTokens: 80,
      outputTokens: 20,
      costMicros: 500,
      currency: "USD",
    };
    expect(await f.make().reconcile(command, { state: "known", usage })).toBe(
      "reconciled",
    );
    expect(JSON.parse((await f.snapshot())!.value.payload).spentMicros).toBe(
      "500",
    );
    expect(await f.make().reserve(f.context(2))).toEqual({ outcome: "denied" });
    expect(
      await f.make().reconcile(command, {
        state: "known",
        usage: { ...usage, costMicros: 501 },
      }),
    ).toBe("pending");
    expect(JSON.parse((await f.snapshot())!.value.payload).accountingHold).toBe(
      true,
    );
    expect(await f.make().reserve(f.context(3))).toEqual({ outcome: "denied" });
  });
  it("retains terminal capacity throughout the whole funded window", async () => {
    const f = fixture({ maxReservations: 2 });
    for (const n of [1, 2]) {
      const command = f.context(n);
      await f.make().reserve(command);
      expect(await f.make().reconcile(command, { state: "not_called" })).toBe(
        "reconciled",
      );
    }
    f.state.now += 120_000;
    expect(await f.make().reserve(f.context(3))).toEqual({ outcome: "denied" });
    expect(
      JSON.parse((await f.snapshot())!.value.payload).reservations,
    ).toHaveLength(2);
  });
  it("refuses capacity above the unchanged 32-entry physical bound", () => {
    const f = fixture({ maxReservations: 33 });
    expect(f.make).toThrow(TypeError);
  });
});
