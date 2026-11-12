import { describe, expect, it, vi } from "vitest";
import { createMemoryStore, type Store } from "@pegma/storage-core";
import {
  engineeringFollowupChecksBinding,
  supportPermissions,
} from "@pegma/support-desk-application";
import {
  createSupportReleaseFollowupModel,
  createSupportReleaseFollowupChecks,
  createSupportReleaseFollowupUsage,
  createSupportIndependentCheckModel,
  createSupportIndependentChecks,
  independentCheckRoutePolicyHash,
  SupportOpenRouterModelError,
  releaseFollowupCheckAttempts,
} from "@pegma/support-desk-ai/openrouter";
import {
  followupModelFixture,
  followupChecksFixture,
  followupControllerFixture,
} from "../test/openrouter-release-followup-fixtures.js";
import {
  engineeringFollowupStaff,
  engineeringFollowupService,
  engineeringFollowupStores,
} from "../test/engineering-followup-fixtures.js";
import {
  engineeringFollowupKnowledgeFixture,
  followupCandidate,
} from "../test/engineering-followup-ai-fixtures.js";

import { createSupportDeskReleaseFollowup } from "@pegma/support-desk-ai";
const signal = () => new AbortController().signal;
describe("purpose-correct SD05 generator", () => {
  it("is inert and disabled without explicit configuration", async () => {
    const readRoute = vi.fn(),
      readApiKey = vi.fn(),
      fetch = vi.fn();
    const ports = createSupportReleaseFollowupModel(
      {
        clock: { now: () => new Date().toISOString() },
        readRoute,
        readApiKey,
        fetch,
      },
      "pegma.dev",
    );
    expect(readRoute).not.toHaveBeenCalled();
    expect(readApiKey).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(await ports.configuration.resolve(undefined, signal())).toEqual({
      outcome: "disabled",
    });
    expect(await ports.evaluations.resolve("absent", signal())).toEqual({
      outcome: "unavailable",
    });
  });
  it("sends only the first public argument, returns exact advisory candidate and actual billed usage", async () => {
    const f = await followupModelFixture();
    expect(
      (await f.model.configuration.resolve(undefined, signal())).outcome,
    ).toBe("ready");
    expect(
      (await f.model.evaluations.resolve(f.c.evaluationVersion, signal()))
        .outcome,
    ).toBe("ready");
    const result = await f.model.model.generate(f.input, f.context, f.c);
    expect(JSON.parse(result.outputJson)).toEqual(followupCandidate());
    expect(result.usage.costMicros).toBe(100);
    expect(f.state.calls).toBe(1);
    const body = JSON.parse(String(f.state.requests[0]!.body));
    const payload = body.messages[1].content;
    expect(JSON.parse(payload)).toEqual(f.input);
    expect(payload).not.toContain("PRIVATE_");
    expect(payload).not.toContain(f.c.dataControls.accountRef);
    expect(body.provider).toMatchObject({
      only: [f.route.endpointTag],
      allow_fallbacks: false,
      zdr: true,
      data_collection: "deny",
    });
  });
  it.each([
    "missing evaluation",
    "expired evaluation",
    "wrong purpose",
    "changed route",
    "wrong host",
  ] as const)("holds %s before credentials/provider", async (kind) => {
    const f = await followupModelFixture();
    if (kind === "missing evaluation")
      Reflect.deleteProperty(f.route, "evaluation");
    if (kind === "expired evaluation")
      f.route.evaluation.validUntil = f.state.now;
    if (kind === "wrong purpose")
      Reflect.set(f.route.configuration, "purpose", "support_engineering");
    if (kind === "changed route") f.route.endpointTag = "fictional/other";
    const m =
      kind === "wrong host"
        ? createSupportReleaseFollowupModel(f.options, "other.example")
        : f.model;
    expect((await m.configuration.resolve(undefined, signal())).outcome).toBe(
      "unavailable",
    );
    expect(f.key).not.toHaveBeenCalled();
    expect(f.state.calls).toBe(0);
  });
  it("observes original options callback/key changes and rejects a key-time route flip", async () => {
    const f = await followupModelFixture();
    await f.model.configuration.resolve(undefined, signal());
    f.options.readApiKey = vi.fn(() => {
      f.state.enabled = false;
      return "fictional-key";
    });
    await expect(
      f.model.model.generate(f.input, f.context, f.c),
    ).rejects.toBeInstanceOf(SupportOpenRouterModelError);
    expect(f.state.calls).toBe(0);
  });
  it.each([1, 2, 3])(
    "honors a tighter per-attempt message cap without truncation at %i",
    async (count) => {
      const f = await followupModelFixture();
      await f.model.configuration.resolve(undefined, signal());
      const input = {
        ...f.input,
        messages: Array.from({ length: count }, () => f.input.messages[0]!),
      };
      const context = {
        ...f.context,
        budgets: { ...f.c.budgets, maxMessages: 2 },
      };
      if (count > 2) {
        await expect(
          f.model.model.generate(input, context, f.c),
        ).rejects.toBeInstanceOf(SupportOpenRouterModelError);
        expect(f.key).not.toHaveBeenCalled();
        expect(f.state.calls).toBe(0);
      } else {
        await f.model.model.generate(input, context, f.c);
        expect(
          JSON.parse(
            JSON.parse(String(f.state.requests[0]!.body)).messages[1].content,
          ).messages,
        ).toHaveLength(count);
      }
    },
  );
  it("preserves known billing when malformed paid output cannot be a candidate", async () => {
    const f = await followupModelFixture();
    await f.model.configuration.resolve(undefined, signal());
    f.state.document.choices[0]!.message.content = '{"passed":true}';
    const result = await f.model.model.generate(f.input, f.context, f.c);
    expect(result.outputJson).toBe("");
    expect(result.usage.costMicros).toBe(100);
  });
  it("uses the existing durable generator ledger with exact identity and conservative unknown accounting", async () => {
    const f = await followupModelFixture();
    const store = createMemoryStore();
    const usage = createSupportReleaseFollowupUsage({
      store,
      clock: f.options.clock,
      policy: {
        version: "fictional-generator-pool",
        scopeRef: f.route.usageScopeRef,
        configurationVersion: f.c.version,
        modelVersion: f.c.modelVersion,
        pricingRef: f.c.pricingRef,
        currency: "USD",
        maxCostMicros: 10000,
        maxReservationCostMicros: 10000,
        maxReservations: 1,
        validFrom: f.state.now,
        validUntil: f.route.approval.validUntil,
        terminalRetentionMilliseconds: 60000,
      },
    });
    expect(await usage.reserve(f.context)).toMatchObject({
      outcome: "reserved",
    });
    expect(await usage.reconcile(f.context, { state: "unknown" })).toBe(
      "reconciled",
    );
    expect(
      await usage.reserve({
        ...f.context,
        attemptId: "another",
        operationId: "another",
        usageReservationId: "another",
      }),
    ).toEqual({ outcome: "denied" });
  });
});

for (const [backend, makeStore] of engineeringFollowupStores) {
  describe("SD05 complete-bundle checks " + backend, () => {
    it("checks actual Source/Work, signs a disjoint receipt, replays without paid work and feeds actual App preparation", async () => {
      const f = await followupChecksFixture(makeStore());
      const port = f.checks.forWork(f.f.key);
      const result = await port.check(f.input, f.context);
      expect(result.outcome).toBe("checked");
      if (result.outcome !== "checked")
        throw new Error("Expected actual complete-bundle check");
      expect(result.receipt).toMatch(/^sf1\./u);
      const legacy = createSupportIndependentChecks(
        { ...f.options, application: () => f.f.app },
        "pegma.dev",
      );
      expect(
        await Reflect.apply(legacy.engineeringSdkVerifier.verify, undefined, [
          result.receipt,
          f.input.binding,
        ]),
      ).toBeNull();
      expect(
        await Reflect.apply(legacy.learningSdkVerifier.verify, undefined, [
          result.receipt,
          f.input.binding,
          signal(),
        ]),
      ).toBeNull();

      expect(f.wire.state.calls).toBe(1);
      const verified = await f.checks.sdkVerifier.verify(
        result.receipt,
        f.input.binding,
        signal(),
      );
      expect(verified).toMatchObject({
        binding: f.input.binding,
        privacy: "passed",
        factual: "passed",
        applicability: "passed",
        security: "clear",
      });
      const replay = await port.check(f.input, f.context);
      expect(replay).toEqual(result);
      expect(f.wire.state.calls).toBe(1);
      const prepared = await f.f.prepareBundle({
        exactBundle: f.input.exactBundle,
        checksReceipt: result.receipt,
        checkPolicyVersion: f.input.binding.checkPolicyVersion,
      });
      expect(prepared.work.preparedBundle?.checksReceipt).toBe(result.receipt);
      expect(
        await port.verify(result.receipt, f.input.binding, signal()),
      ).not.toBeNull();
      expect(
        await f.checks.sdkVerifier.verify(
          result.receipt,
          { ...f.input.binding, bundleHash: "f".repeat(64) },
          signal(),
        ),
      ).toBeNull();
      expect(
        await f.checks.sdkVerifier.verify(
          result.receipt.replace("sf1.", "ic2."),
          f.input.binding,
          signal(),
        ),
      ).toBeNull();
      const other = createSupportReleaseFollowupChecks(
        f.options,
        "other.example",
      );
      expect(
        await other.sdkVerifier.verify(
          result.receipt,
          f.input.binding,
          signal(),
        ),
      ).toBeNull();
      const wire = JSON.parse(String(f.wire.state.requests[0]!.init.body));
      const payload = JSON.parse(wire.messages[1].content);
      expect(payload.outbound).toEqual(f.input.exactBundle);
      expect(payload.kind).toBe("release_followup");
      expect(payload.purpose).toBe("support_release_followup");
      expect(payload).not.toHaveProperty("releaseProof");
      expect(payload).not.toHaveProperty("authority");
      expect(f.f.retestVerify).not.toHaveBeenCalled();
    });
    it("requires explicit SD05 checker qualification before key, ownership, funding or provider", async () => {
      const f = await followupChecksFixture(makeStore());
      Reflect.deleteProperty(f.wire.route, "releaseFollowup");
      const { approval, ...base } = f.wire.route;
      f.wire.route.approval.requestPolicySha256 =
        await independentCheckRoutePolicyHash(base);
      void approval;
      const key = vi.fn(() => "fictional-key");
      const options = { ...f.options, readApiKey: key };
      const checks = createSupportReleaseFollowupChecks(options, "pegma.dev");
      expect((await checks.resolvePolicy(undefined, signal())).outcome).toBe(
        "unavailable",
      );
      expect(
        (await checks.forWork(f.f.key).check(f.input, f.context)).outcome,
      ).toBe("held");
      expect(key).not.toHaveBeenCalled();
      expect(f.wire.state.calls).toBe(0);
      expect(
        await f.store
          .collection(releaseFollowupCheckAttempts)
          .get({ partition: "support_release_followup", id: "attempts" }),
      ).toBeNull();
    });
    it("holds changed exact bundle/binding and current authority before any paid opportunity", async () => {
      const f = await followupChecksFixture(makeStore());
      const changed = {
        ...f.input,
        exactBundle: {
          ...f.input.exactBundle,
          customerDraft: { body: "An unbound claim." },
        },
      };
      expect(
        (await f.checks.forWork(f.f.key).check(changed, f.context)).outcome,
      ).toBe("held");
      f.state.access = {
        ...f.state.access,
        permissions: f.state.access.permissions.filter(
          (p) => p !== supportPermissions.engineeringFollowupRead,
        ),
      };
      expect(
        (await f.checks.forWork(f.f.key).check(f.input, f.context)).outcome,
      ).toBe("held");
      expect(f.wire.state.calls).toBe(0);
    });
    it("rejects late authority loss after known billed response, preserves ownership and does not pay on retry", async () => {
      const f = await followupChecksFixture(makeStore());
      const fetch = f.options.fetch!;
      const options = {
        ...f.options,
        fetch: async (url: string, init: RequestInit) => {
          const response = await fetch(url, init);
          f.state.active = false;
          return response;
        },
      };
      const checks = createSupportReleaseFollowupChecks(options, "pegma.dev");
      const port = checks.forWork(f.f.key);
      expect((await port.check(f.input, f.context)).outcome).toBe("held");
      expect(f.wire.state.calls).toBe(1);
      f.state.active = true;
      expect((await port.check(f.input, f.context)).outcome).toBe("held");
      expect(f.wire.state.calls).toBe(1);
    });
  });
}

describe("SD05 bounded ambiguous recovery", () => {
  it("keeps replay on the same immutable shared funding policy when the caller replaces its options data", async () => {
    const f = await followupChecksFixture();
    const port = f.checks.forWork(f.f.key);
    const first = await port.check(f.input, f.context);
    expect(first.outcome).toBe("checked");
    Reflect.set(f.options, "usagePolicy", {
      ...f.policy,
      version: "another-pool-policy",
    });
    expect(await port.check(f.input, f.context)).toEqual(first);
    expect(f.wire.state.calls).toBe(1);
  });

  it("keeps a signed receipt usable beyond the checker invocation while its actual proof remains live", async () => {
    const f = await followupChecksFixture();
    const result = await f.checks.forWork(f.f.key).check(f.input, f.context);
    expect(result.outcome).toBe("checked");
    if (result.outcome !== "checked") throw new Error("Expected receipt");
    f.f.advance(20000);
    f.wire.state.now = f.f.clock.now();
    expect(
      await f.checks.sdkVerifier.verify(
        result.receipt,
        f.input.binding,
        signal(),
      ),
    ).not.toBeNull();
    f.f.advance(60000);
    f.wire.state.now = f.f.clock.now();
    expect(
      await f.checks.sdkVerifier.verify(
        result.receipt,
        f.input.binding,
        signal(),
      ),
    ).toBeNull();
  });

  it("recovers a committed check receipt after its Store acknowledgement is lost without another paid call", async () => {
    const f = await followupChecksFixture();
    let lost = false;
    const store: Store = {
      ...f.store,
      collection(definition) {
        const collection = f.store.collection(definition);
        if (definition.name !== releaseFollowupCheckAttempts.name)
          return collection;
        return new Proxy(collection, {
          get(target, key, receiver) {
            const value = Reflect.get(target, key, receiver);
            if (key === "update")
              return async (...args: unknown[]) => {
                const result = await Reflect.apply(value, target, args);
                if (
                  !lost &&
                  (
                    result as {
                      value?: { entries: readonly { state: string }[] };
                    }
                  ).value?.entries.some(
                    (e: { state: string }) => e.state === "checked",
                  )
                ) {
                  lost = true;
                  throw new Error("fictional committed ACK loss");
                }
                return result;
              };
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      },
    };
    const checks = createSupportReleaseFollowupChecks(
      { ...f.options, store },
      "pegma.dev",
    );
    const port = checks.forWork(f.f.key);
    expect((await port.check(f.input, f.context)).outcome).toBe("held");
    expect(lost).toBe(true);
    expect(f.wire.state.calls).toBe(1);
    const replay = await port.check(f.input, f.context);
    expect(replay.outcome).toBe("checked");
    expect(f.wire.state.calls).toBe(1);
  });
  it("retains unknown provider usage and never gives the exact attempt another provider chance", async () => {
    const f = await followupChecksFixture();
    let physical = 0;
    const checks = createSupportReleaseFollowupChecks(
      {
        ...f.options,
        fetch: async () => {
          physical++;
          throw new Error("fictional transport loss");
        },
      },
      "pegma.dev",
    );
    const port = checks.forWork(f.f.key);
    expect((await port.check(f.input, f.context)).outcome).toBe("held");
    expect((await port.check(f.input, f.context)).outcome).toBe("held");
    expect(physical).toBe(1);
    const head = await f.store
      .collection(releaseFollowupCheckAttempts)
      .get({ partition: "support_release_followup", id: "attempts" });
    expect(head?.entries).toHaveLength(1);
    expect(head?.entries[0]?.receipt).toBeNull();
    expect(head?.entries[0]?.proof).not.toContain(
      f.input.candidate.customerDraft.body,
    );
  });
  it("does not append private notes or real Source identifiers to generator content", async () => {
    const f = await followupControllerFixture();
    const g = await followupModelFixture("pegma.dev", f.f.clock.now());
    // Actual application fixture has a real internal note already. The generator
    // fixture's public input remains the only serialized provider content.
    await g.model.configuration.resolve(undefined, signal());
    await g.model.model.generate(g.input, g.context, g.c);
    expect(String(g.state.requests[0]!.body)).not.toContain(
      "PRIVATE_ENGINEERING_INTERNAL_NOTE",
    );
    const bad = {
      ...g.input,
      privateNote: "PRIVATE_ENGINEERING_INTERNAL_NOTE",
    };
    await expect(
      g.model.model.generate(bad, g.context, g.c),
    ).rejects.toBeInstanceOf(SupportOpenRouterModelError);
    expect(g.state.calls).toBe(1);
  });
});

describe("SD05 checker direct-public boundary", () => {
  it("does not export provider factories from the provider-neutral root", async () => {
    const root = await import("@pegma/support-desk-ai");
    expect(root).not.toHaveProperty("createSupportReleaseFollowupModel");
    expect(root).not.toHaveProperty("createSupportReleaseFollowupChecks");
  });
  it("refuses late release-evidence revocation after a billed check response", async () => {
    const f = await followupChecksFixture();
    const fetch = f.options.fetch!;
    const checks = createSupportReleaseFollowupChecks(
      {
        ...f.options,
        fetch: async (url, init) => {
          const response = await fetch(url, init);
          f.f.state.currentOutcome = "unavailable";
          return response;
        },
      },
      "pegma.dev",
    );
    expect(
      (await checks.forWork(f.f.key).check(f.input, f.context)).outcome,
    ).toBe("held");
    expect(f.wire.state.calls).toBe(1);
  });

  it("rejects absent follow-up approval before credentials even outside the controller", async () => {
    const f = await followupChecksFixture();
    delete f.wire.route.releaseFollowup;
    const { approval, ...base } = f.wire.route;
    f.wire.route.approval.requestPolicySha256 =
      await independentCheckRoutePolicyHash(base);
    void approval;
    const key = vi.fn(() => "fictional-key");
    const model = createSupportIndependentCheckModel(
      { ...f.wire.options, readApiKey: key },
      "pegma.dev",
    );
    await model.resolve();
    const input = {
      trustedInstructions: f.wire.c.trustedInstructions,
      kind: "release_followup" as const,
      purpose: "support_release_followup" as const,
      facts: {
        messages: ["Fictional message"],
        publicReleaseFacts: [
          { ref: "release-1", text: "Fictional release fact" },
        ],
      },
      candidate: f.input.candidate,
      outbound: f.input.exactBundle,
      binding: f.input.binding,
      targetBaseline: null,
      validationRequirements: null,
    };
    await expect(
      model.generate(input, f.wire.context, f.wire.c),
    ).rejects.toMatchObject({ code: "route_unavailable" });
    expect(key).not.toHaveBeenCalled();
    expect(f.wire.state.calls).toBe(0);
  });
});

for (const [backend, makeStore] of engineeringFollowupStores) {
  describe("SD05 coordinator and staff reassessment " + backend, () => {
    it.each([false, true])(
      "drives actual coordinator stages with real SDK persistence and KB target=%s",
      async (hasTarget) => {
        const f = await followupControllerFixture(makeStore());
        const g = await followupModelFixture("pegma.dev", f.f.clock.now());
        const usage = createSupportReleaseFollowupUsage({
          store: f.store,
          clock: g.options.clock,
          policy: {
            version: "fictional-generator-pool",
            scopeRef: g.route.usageScopeRef,
            configurationVersion: g.c.version,
            modelVersion: g.c.modelVersion,
            pricingRef: g.c.pricingRef,
            currency: "USD",
            maxCostMicros: 20000,
            maxReservationCostMicros: 10000,
            maxReservations: 2,
            validFrom: g.state.now,
            validUntil: g.route.approval.validUntil,
            terminalRetentionMilliseconds: 60000,
          },
        });
        const knowledge = hasTarget
          ? await engineeringFollowupKnowledgeFixture(f.store)
          : undefined;
        const kbAccess = knowledge
          ? {
              resolve: async () => ({
                outcome: "ready" as const,
                authority: {
                  access: knowledge.access.draftService,
                  authorityVersion: "fictional-real-kb",
                },
              }),
            }
          : undefined;
        const checks = knowledge
          ? createSupportReleaseFollowupChecks(
              {
                ...f.options,
                knowledge: knowledge.ports.knowledge,
                knowledgeAccess: kbAccess!,
              },
              "pegma.dev",
            )
          : f.checks;
        const coordinator = createSupportDeskReleaseFollowup({
          application: f.f.app,
          clock: f.f.clock,
          serviceAccess: {
            resolve: async () => ({
              outcome: "ready",
              authority: {
                access: engineeringFollowupService,
                authorityVersion: "fictional-generator-service",
                usageScopeRef: g.route.usageScopeRef,
              },
            }),
          },
          releaseEvidence: f.f.releaseEvidence,
          configuration: g.model.configuration,
          evaluations: g.model.evaluations,
          model: g.model.model,
          tokenCounter: g.model.tokenCounter,
          usage,
          checks: checks.forWork(f.f.key),
          targets: {
            resolve: async () =>
              knowledge
                ? { kind: "article", articleId: knowledge.articleId }
                : { kind: "none" },
          },
          ...(knowledge
            ? {
                knowledge: knowledge.ports.knowledge,
                knowledgeAccess: kbAccess!,
              }
            : {}),
        });
        const command = {
          ...f.f.key,
          workerId: "fictional-followup-worker",
          leaseMilliseconds: 30000,
        };
        const generated = await coordinator.processWork(command);
        expect(generated.outcome).toBe("candidate");
        const checked = await coordinator.processWork(command);
        expect(checked.outcome).toBe("prepared");
        const work = await f.f.work();
        expect(work.preparedBundle?.checksReceipt).toMatch(/^sf1\./u);
        expect(work.delivered).toBeUndefined();
        expect(work.retestResults).toEqual([]);
        expect(g.state.calls).toBe(1);
        expect(f.wire.state.calls).toBe(1);
        const generatedWire = String(g.state.requests[0]!.body);
        expect(generatedWire).not.toContain(
          "PRIVATE_ENGINEERING_INTERNAL_NOTE",
        );
        expect(generatedWire).not.toContain("PRIVATE_FOLLOWUP_KB_GUIDE_BODY");
        if (knowledge) {
          const payload = JSON.parse(
            JSON.parse(String(f.wire.state.requests[0]!.init.body)).messages[1]
              .content,
          );
          expect(payload.targetBaseline.articleId).toBe(knowledge.articleId);
          expect(payload.validationRequirements.collectionId).toBe(
            knowledge.draft.revision.collectionId,
          );
        }
      },
    );
    it("uses actual reassessment observations and only an explicit current staff Review resolver", async () => {
      const f = await followupChecksFixture(makeStore());
      let access = engineeringFollowupStaff;
      const resolve = vi.fn(async () => ({
        outcome: "ready" as const,
        authority: {
          access,
          authorityVersion: "fictional-current-staff",
          usageScopeRef: f.wire.route.usageScopeRef,
        },
      }));
      const view = await f.f.app.readEngineeringFollowupReassessment(
        access,
        f.f.key,
      );
      const input = {
        ...f.input,
        releaseProof: view.proof,
        binding: await engineeringFollowupChecksBinding({
          workBindingHash: view.prospectiveWorkBindingHash,
          candidateHash: view.work.candidateHash!,
          exactBundle: f.input.exactBundle,
          checkPolicyVersion: f.input.binding.checkPolicyVersion,
          followupRevocationEpoch: view.proofContext.followupRevocationEpoch,
          context: view.proof.context,
        }),
      };
      const port = f.checks.forReassessment(f.f.key, { resolve });
      const result = await port.check(input, f.context);
      expect(result.outcome).toBe("checked");
      expect(resolve.mock.calls.length).toBeGreaterThan(2);
      if (result.outcome !== "checked")
        throw new Error("Actual staff check required");
      const current = f.checks.currentVerifierFor(f.f.key, { resolve });
      expect(
        await current.verify(result.receipt, input.binding, signal()),
      ).not.toBeNull();
      access = {
        ...access,
        permissions: access.permissions.filter(
          (p) => p !== supportPermissions.engineeringFollowupReview,
        ),
      };
      expect(
        await current.verify(result.receipt, input.binding, signal()),
      ).toBeNull();
      expect((await port.check(input, f.context)).outcome).toBe("held");
      expect(f.wire.state.calls).toBe(1);
      expect(
        await f.checks
          .forWork({ ...f.f.key, workId: "other-work" })
          .verify(result.receipt, input.binding, signal()),
      ).toBeNull();
    });
    it("rejects late original-staff role loss before a reassessment receipt can be issued", async () => {
      const f = await followupChecksFixture(makeStore());
      let access = engineeringFollowupStaff;
      const fetch = f.options.fetch!;
      const checks = createSupportReleaseFollowupChecks(
        {
          ...f.options,
          fetch: async (url, init) => {
            const response = await fetch(url, init);
            access = { ...access, permissions: [] };
            return response;
          },
        },
        "pegma.dev",
      );
      const port = checks.forReassessment(f.f.key, {
        resolve: async () => ({
          outcome: "ready",
          authority: {
            access,
            authorityVersion: "fictional-staff",
            usageScopeRef: f.wire.route.usageScopeRef,
          },
        }),
      });
      expect((await port.check(f.input, f.context)).outcome).toBe("held");
      expect(f.wire.state.calls).toBe(1);
      const head = await f.store
        .collection(releaseFollowupCheckAttempts)
        .get({ partition: "support_release_followup", id: "attempts" });
      expect(head?.entries.every((e) => e.receipt === null)).toBe(true);
    });
  });
}
