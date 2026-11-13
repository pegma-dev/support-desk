import { describe, expect, it, vi } from "vitest";
import {
  createMemoryStore,
  defineCollection,
  type Store,
} from "@pegma/storage-core";
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
  it("rejects non-contract fields in a direct generator input", async () => {
    const g = await followupModelFixture();
    await g.model.configuration.resolve(undefined, signal());
    await g.model.model.generate(g.input, g.context, g.c);
    const extra = { ...g.input, privateNote: "EXTRA_FIELD" };
    await expect(
      g.model.model.generate(extra, g.context, g.c),
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
    it.each([
      [false, false],
      [true, false],
      [true, true],
    ] as const)(
      "drives actual coordinator stages with real SDK persistence and KB target=%s customer-only=%s",
      async (hasTarget, customerOnly) => {
        const f = await followupControllerFixture(makeStore());
        const g = await followupModelFixture("pegma.dev", f.f.clock.now());
        if (customerOnly)
          g.state.document.choices[0]!.message.content = JSON.stringify(
            followupCandidate({ kbProposal: null }),
          );
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
        if (customerOnly)
          expect(work.preparedBundle?.bundle.kbProposal).toBeNull();
        expect(work.delivered).toBeUndefined();
        expect(work.retestResults).toEqual([]);
        expect(g.state.calls).toBe(1);
        expect(f.wire.state.calls).toBe(1);
        const generatedWire = String(g.state.requests[0]!.body);
        expect(generatedWire).not.toContain(
          "PRIVATE_ENGINEERING_INTERNAL_NOTE",
        );
        expect(generatedWire).not.toContain("PRIVATE_FOLLOWUP_KB_GUIDE_BODY");
        const source = await f.f.app.readEngineeringSource(
          engineeringFollowupStaff,
          f.f.key.ticketId,
        );
        const ticket = await f.f.app.readStaffTicket(
          engineeringFollowupStaff,
          f.f.key.ticketId,
        );
        const payload = JSON.parse(
          JSON.parse(generatedWire).messages[1].content,
        ) as {
          trustedInstructions: string;
          messages: { speaker: string; text: string }[];
          publicReleaseFacts: { ref: string; text: string }[];
        };
        const disclosed = [
          payload.trustedInstructions,
          ...payload.messages.flatMap((m) => [m.speaker, m.text]),
          ...payload.publicReleaseFacts.flatMap((f) => [f.ref, f.text]),
        ];
        for (const value of [
          source.sourceId,
          source.proofIdentity,
          work.workId,
          work.association.dispatchId,
          ticket.ticket.requester.principalId,
          ticket.ticket.requester.email,
          ...ticket.messages
            .filter((m) => m.visibility === "internal")
            .map((m) => m.body),
        ]) {
          if (typeof value === "string" && value.length > 0)
            expect(disclosed.every((text) => !text.includes(value))).toBe(true);
        }

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

for (const [backend, makeStore] of engineeringFollowupStores) {
  describe("configured review SD05 regressions " + backend, () => {
    it("requires canonical base64url signatures in every receipt verifier", async () => {
      const f = await followupChecksFixture(makeStore());
      const port = f.checks.forWork(f.f.key);
      const result = await port.check(f.input, f.context);
      expect(result.outcome).toBe("checked");
      if (result.outcome !== "checked")
        throw new Error("Actual checked receipt required");
      expect(
        await f.checks.sdkVerifier.verify(
          result.receipt,
          f.input.binding,
          signal(),
        ),
      ).not.toBeNull();
      expect(
        await f.checks
          .currentVerifierFor(f.f.key)
          .verify(result.receipt, f.input.binding, signal()),
      ).not.toBeNull();
      const alphabet =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
      const parts = result.receipt.split(".");
      const signature = parts[4]!;
      const last = alphabet.indexOf(signature.at(-1)!);
      expect(last % 4).toBe(0);
      for (const lowBits of [1, 2, 3]) {
        const alternate = [
          ...parts.slice(0, 4),
          signature.slice(0, -1) + alphabet[last + lowBits],
        ].join(".");
        expect(
          await f.checks.sdkVerifier.verify(
            alternate,
            f.input.binding,
            signal(),
          ),
        ).toBeNull();
        expect(
          await port.verify(alternate, f.input.binding, signal()),
        ).toBeNull();
        expect(
          await f.checks
            .currentVerifierFor(f.f.key)
            .verify(alternate, f.input.binding, signal()),
        ).toBeNull();
      }
      expect(f.wire.state.calls).toBe(1);
    });
    it("survives approval-window refresh with one exact operation and unchanged signed receipt expiry", async () => {
      const f = await followupChecksFixture(makeStore());
      f.wire.route.approval.validUntil = new Date(
        Date.parse(f.wire.state.now) + 120000,
      ).toISOString();
      const port = f.checks.forWork(f.f.key);
      const first = await port.check(f.input, f.context);
      expect(first.outcome).toBe("checked");
      if (first.outcome !== "checked")
        throw new Error("Actual checked receipt required");
      const original = await f.checks.sdkVerifier.verify(
        first.receipt,
        f.input.binding,
        signal(),
      );
      expect(original).not.toBeNull();
      await f.f.prepareBundle({
        exactBundle: f.input.exactBundle,
        checksReceipt: first.receipt,
        checkPolicyVersion: f.input.binding.checkPolicyVersion,
      });
      f.f.advance(1000);
      f.wire.state.now = f.f.clock.now();
      f.wire.route.approval.verifiedAt = f.wire.state.now;
      f.wire.route.approval.validUntil = new Date(
        Date.parse(f.wire.state.now) + 180000,
      ).toISOString();
      const verified = await f.checks.sdkVerifier.verify(
        first.receipt,
        f.input.binding,
        signal(),
      );
      expect(verified).not.toBeNull();
      expect(verified?.validUntil).toBe(original?.validUntil);
      expect(await port.check(f.input, f.context)).toEqual(first);
      expect(f.wire.state.calls).toBe(1);
      const head = await f.store
        .collection(releaseFollowupCheckAttempts)
        .get({ partition: "support_release_followup", id: "attempts" });
      expect(head?.entries).toHaveLength(1);
      const posted = await f.f.post();
      expect(posted.result.messageId).toBeTruthy();
      expect(f.wire.state.calls).toBe(1);
      f.f.advance(60000);
      f.wire.state.now = f.f.clock.now();
      expect(
        await f.checks.sdkVerifier.verify(
          first.receipt,
          f.input.binding,
          signal(),
        ),
      ).toBeNull();
    });
    it("still rejects a shortened current approval window and changed semantic policy binding", async () => {
      const f = await followupChecksFixture(makeStore());
      const first = await f.checks.forWork(f.f.key).check(f.input, f.context);
      expect(first.outcome).toBe("checked");
      if (first.outcome !== "checked")
        throw new Error("Actual checked receipt required");
      const previous = f.wire.route.approval.validUntil;
      f.wire.route.approval.validUntil = new Date(
        Date.parse(f.wire.state.now) + 500,
      ).toISOString();
      expect(
        await f.checks.sdkVerifier.verify(
          first.receipt,
          f.input.binding,
          signal(),
        ),
      ).toBeNull();
      f.wire.route.approval.validUntil = previous;
      f.wire.route.configuration.policyBinding = "different-current-policy";
      const { approval, ...base } = f.wire.route;
      f.wire.route.approval.requestPolicySha256 =
        await independentCheckRoutePolicyHash(base);
      void approval;
      expect(
        await f.checks.sdkVerifier.verify(
          first.receipt,
          f.input.binding,
          signal(),
        ),
      ).toBeNull();
      expect(f.wire.state.calls).toBe(1);
    });
    it("makes absent funding unavailable before admission while keeping policy and receipt verification available", async () => {
      const f = await followupChecksFixture(makeStore());
      const accepted = await f.checks
        .forWork(f.f.key)
        .check(f.input, f.context);
      expect(accepted.outcome).toBe("checked");
      if (accepted.outcome !== "checked")
        throw new Error("Actual checked receipt required");
      const { usagePolicy, ...withoutPolicy } = f.options;
      void usagePolicy;
      const opened = vi.fn(),
        application = vi.fn(() => {
          throw new Error("No App admission expected");
        }),
        apiKey = vi.fn(() => "fictional-key"),
        receiptKey = vi.fn(f.options.readReceiptKey!);
      const store = new Proxy(f.store, {
        get(target, key, receiver) {
          const value = Reflect.get(target, key, receiver);
          if (key === "collection")
            return (...args: unknown[]) => {
              opened();
              return Reflect.apply(value, target, args);
            };
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const checker = createSupportReleaseFollowupChecks(
        {
          ...withoutPolicy,
          store,
          application,
          readApiKey: apiKey,
          readReceiptKey: receiptKey,
        },
        "pegma.dev",
      );
      expect(await checker.forWork(f.f.key).check(f.input, f.context)).toEqual({
        outcome: "unavailable",
      });
      expect(opened).not.toHaveBeenCalled();
      expect(application).not.toHaveBeenCalled();
      expect(apiKey).not.toHaveBeenCalled();
      expect(receiptKey).not.toHaveBeenCalled();
      expect(f.wire.state.calls).toBe(1);
      expect(
        (
          await checker.resolvePolicy(
            f.input.binding.checkPolicyVersion,
            signal(),
          )
        ).outcome,
      ).toBe("ready");
      expect(
        await checker.sdkVerifier.verify(
          accepted.receipt,
          f.input.binding,
          signal(),
        ),
      ).not.toBeNull();
      expect(opened).not.toHaveBeenCalled();
    });
  });
}

async function readActualCheckUsage(store: Store) {
  const key = { partition: "support_independent_check", id: "budget" };
  const rows = defineCollection<{ payload: string }>({
    name: "pegma.support-independent-checks.usage.v1",
    key: () => key,
    codec: {
      encode() {
        throw new Error("Read-only actual usage observation");
      },
      decode(raw) {
        if (
          raw.partition !== key.partition ||
          raw.id !== key.id ||
          typeof raw.payload !== "string"
        )
          throw new Error("Expected actual usage payload");
        return { payload: raw.payload };
      },
    },
  });
  const row = await store.collection(rows).get(key);
  if (!row) throw new Error("Expected actual durable usage head");
  return JSON.parse(row.payload) as {
    spentMicros: string;
    reservations: { state: string; usage: { costMicros: number } | null }[];
  };
}
for (const [backend, makeStore] of engineeringFollowupStores) {
  describe("new configured review SD05 regressions " + backend, () => {
    it.each([
      "PRIVATE one\ntwo",
      'PRIVATE "quoted" note',
      "PRIVATE \\ backslash note",
    ])(
      "blocks an actual escaped internal note before HTTP: %s",
      async (note) => {
        const f = await followupControllerFixture(makeStore(), {
          privateNote: note,
        });
        const prepared = await f.f.prepareCandidate({
          candidate: followupCandidate({
            customerDraft: { body: "Customer copy: " + note },
          }),
        });
        const work = await f.f.work();
        const bundle = await f.f.exactBundle(prepared.candidate);
        const binding = await engineeringFollowupChecksBinding({
          workBindingHash: work.workBindingHash,
          candidateHash: prepared.candidateHash,
          exactBundle: bundle,
          checkPolicyVersion: f.wire.c.policyVersion,
          followupRevocationEpoch: work.association.followupRevocationEpoch,
          context: work.context!,
        });
        const context = {
          purpose: "support_release_followup" as const,
          deadline: new Date(
            Date.parse(f.wire.state.now) + 15000,
          ).toISOString(),
          signal: signal(),
        };
        const result = await f.checks.forWork(f.f.key).check(
          {
            candidate: prepared.candidate,
            exactBundle: bundle,
            binding,
            releaseProof: f.f.proof(),
            targetBaseline: null,
            validationRequirements: null,
          },
          context,
        );
        expect(result.outcome).toBe("held");
        expect(f.wire.state.calls).toBe(0);
        expect(
          await f.store
            .collection(releaseFollowupCheckAttempts)
            .get({ partition: "support_release_followup", id: "attempts" }),
        ).toBeNull();
      },
    );
    it.each(["process", "review"] as const)(
      "snapshots a shared mutable %s access object before awaited proof work",
      async (mode) => {
        const f = await followupChecksFixture(makeStore());
        const access = structuredClone(
          mode === "review"
            ? engineeringFollowupStaff
            : engineeringFollowupService,
        );
        const shared = {
          access,
          authorityVersion: "mutable-authority",
          usageScopeRef: f.wire.route.usageScopeRef,
        };
        let changed = false;
        const resolve = async () => ({
          outcome: "ready" as const,
          authority: shared,
        });
        const confirm = f.options.releaseEvidence.confirm;
        const checker = createSupportReleaseFollowupChecks(
          {
            ...f.options,
            authority: { resolve },
            releaseEvidence: {
              ...f.options.releaseEvidence,
              confirm: async (...args) => {
                const proof = await confirm(...args);
                if (!changed) {
                  changed = true;
                  Reflect.set(
                    access,
                    "principalId",
                    "replacement-with-the-same-grants",
                  );
                }
                return proof;
              },
            },
          },
          "pegma.dev",
        );
        const port =
          mode === "review"
            ? checker.forReassessment(f.f.key, { resolve })
            : checker.forWork(f.f.key);
        expect((await port.check(f.input, f.context)).outcome).toBe("held");
        expect(changed).toBe(true);
        expect(f.wire.state.calls).toBe(0);
      },
    );
    it("snapshots shared knowledge authority before actual draft/requirements awaits", async () => {
      const f = await followupControllerFixture(makeStore());
      const candidate = followupCandidate({ kbProposal: null });
      const prepared = await f.f.prepareCandidate({ candidate });
      const work = await f.f.work();
      const bundle = await f.f.exactBundle(candidate);
      const knowledge = await engineeringFollowupKnowledgeFixture(f.store);
      const access = structuredClone(knowledge.access.draftService);
      const shared = { access, authorityVersion: "mutable-knowledge" };
      const resolve = async () => ({
        outcome: "ready" as const,
        authority: shared,
      });
      let changed = false;
      const requirements =
        await knowledge.ports.knowledge.getValidationRequirements(access, {
          collectionId: knowledge.draft.revision.collectionId,
          kind: knowledge.draft.revision.kind,
        });
      const checker = createSupportReleaseFollowupChecks(
        {
          ...f.options,
          knowledge: {
            ...knowledge.ports.knowledge,
            getDraft: async (...args) => {
              const value = await knowledge.ports.knowledge.getDraft(...args);
              if (!changed) {
                changed = true;
                Reflect.set(
                  access,
                  "principalId",
                  "another-reader-with-equal-grants",
                );
              }
              return value;
            },
          },
          knowledgeAccess: { resolve },
        },
        "pegma.dev",
      );
      const binding = await engineeringFollowupChecksBinding({
        workBindingHash: work.workBindingHash,
        candidateHash: prepared.candidateHash,
        exactBundle: bundle,
        checkPolicyVersion: f.wire.c.policyVersion,
        followupRevocationEpoch: work.association.followupRevocationEpoch,
        context: work.context!,
      });
      expect(
        (
          await checker.forWork(f.f.key).check(
            {
              candidate,
              exactBundle: bundle,
              binding,
              releaseProof: f.f.proof(),
              targetBaseline: knowledge.draft,
              validationRequirements: requirements,
            },
            {
              purpose: "support_release_followup",
              deadline: new Date(
                Date.parse(f.wire.state.now) + 15000,
              ).toISOString(),
              signal: signal(),
            },
          )
        ).outcome,
      ).toBe("held");
      expect(changed).toBe(true);
      expect(f.wire.state.calls).toBe(0);
    });
    it.each(["before provider", "after provider"] as const)(
      "holds a same-version approved route replacement %s",
      async (phase) => {
        const f = await followupChecksFixture(makeStore());
        const replacement = structuredClone(f.wire.route);
        replacement.endpointTag = "fictional/alternate";
        const { approval, ...base } = replacement;
        replacement.approval.requestPolicySha256 =
          await independentCheckRoutePolicyHash(base);
        void approval;
        const allowlist = [
          ...f.options.allowlist!,
          {
            model: f.wire.c.model,
            provider: f.wire.c.provider,
            endpointTag: replacement.endpointTag,
            outputTokenParameter: replacement.outputTokenParameter,
          },
        ];
        let changed = false;
        const swap = () => {
          if (!changed) {
            changed = true;
            Object.assign(f.wire.route, replacement);
          }
        };
        const confirm = f.options.releaseEvidence.confirm;
        const checker = createSupportReleaseFollowupChecks(
          {
            ...f.options,
            allowlist,
            readApiKey: () => {
              if (phase === "before provider") swap();
              return "fictional-key";
            },
            releaseEvidence: {
              ...f.options.releaseEvidence,
              confirm: async (...args) => {
                const result = await confirm(...args);
                if (phase === "after provider" && f.wire.state.calls === 1)
                  swap();
                return result;
              },
            },
          },
          "pegma.dev",
        );
        expect(
          (await checker.forWork(f.f.key).check(f.input, f.context)).outcome,
        ).toBe("held");
        expect(changed).toBe(true);
        expect(f.wire.state.calls).toBe(phase === "before provider" ? 0 : 1);
        const head = await f.store
          .collection(releaseFollowupCheckAttempts)
          .get({ partition: "support_release_followup", id: "attempts" });
        expect(head?.entries[0]?.receipt).toBeNull();
        expect(head?.entries[0]?.state).toBe("held");
        const usage = await readActualCheckUsage(f.store);
        if (phase === "after provider") {
          expect(usage.reservations[0]?.state).toBe("known");
          expect(usage.reservations[0]?.usage?.costMicros).toBe(100);
          expect(usage.spentMicros).toBe("100");
        } else {
          expect(usage.reservations[0]?.state).toBe("not_called");
          expect(usage.spentMicros).toBe("0");
        }
      },
    );
  });
}
