import {
  createSupportReleaseFollowupChecks,
  createSupportReleaseFollowupUsage,
  releaseFollowupCheckAttempts,
  createSupportReleaseFollowupCheckCleanup,
  supportReleaseFollowupRoutePolicySha256,
} from "@pegma/support-desk-ai/openrouter";
import { createSupportDeskReleaseFollowup } from "@pegma/support-desk-ai";
import { engineeringFollowupChecksBinding } from "@pegma/support-desk-application";
import type { Store } from "@pegma/storage-core";
import { describe, expect, it } from "vitest";
import {
  followupChecksFixture,
  followupControllerFixture,
  followupModelFixture,
} from "../test/openrouter-release-followup-fixtures.js";
import {
  engineeringFollowupStores,
  engineeringFollowupService,
  engineeringFollowupStaff,
} from "../test/engineering-followup-fixtures.js";

function loseAcceptedAck(store: Store, state: "received" | "checked"): Store {
  let lost = false;
  return {
    collection(definition) {
      const records = store.collection(definition);
      return {
        ...records,
        async update(key, decide, options) {
          const accepted = await records.update(key, decide, options);
          const entries = (
            accepted.value as { entries?: readonly { state?: string }[] } | null
          )?.entries;
          if (
            !lost &&
            definition.name === releaseFollowupCheckAttempts.name &&
            entries?.some((entry) => entry.state === state)
          ) {
            lost = true;
            throw new Error("Fictional accepted check transition ACK loss");
          }
          return accepted;
        },
      };
    },
  };
}

for (const [name, createStore] of engineeringFollowupStores) {
  describe(`deferred SD05 independent checks (${name})`, () => {
    it("durably defers the exact request, calls once in a later invocation and only looks up thereafter", async () => {
      const f = await followupChecksFixture(createStore());
      const controller = createSupportReleaseFollowupChecks(
        { ...f.options, deferred: true },
        "pegma.dev",
      );
      const port = controller.forWork(f.f.key);
      const prepared = await port.check(f.input, f.context);
      expect(prepared).toMatchObject({
        outcome: "deferred",
        callState: "not_called",
      });
      expect(f.wire.state.calls).toBe(0);
      const pending = await controller.scanPending();
      expect(pending).toHaveLength(1);
      expect(JSON.stringify(pending)).not.toContain(
        f.input.exactBundle.customerDraft.body,
      );
      expect(
        await controller.precomputePending(
          pending[0]!.operationId,
          f.context,
          f.f.key,
        ),
      ).toMatchObject({ outcome: "received" });
      expect((await controller.scanPending())[0]?.phase).toBe("receipt");
      expect(await port.check(f.input, f.context)).toMatchObject({
        outcome: "deferred",
        callState: "recorded",
      });
      expect(
        await controller.precomputePending(
          pending[0]!.operationId,
          f.context,
          f.f.key,
        ),
      ).toMatchObject({ outcome: "checked" });
      expect(f.wire.state.calls).toBe(1);
      const checked = await port.check(f.input, f.context);
      expect(checked).toMatchObject({ outcome: "checked" });
      expect(
        await port.verify(
          checked.outcome === "checked" ? checked.receipt : "",
          f.input.binding,
          f.context.signal,
        ),
      ).not.toBeNull();
      await controller.precomputePending(
        pending[0]!.operationId,
        f.context,
        f.f.key,
      );
      expect(f.wire.state.calls).toBe(1);
    });

    it("holds a lost provider ACK and never calls that request again", async () => {
      const f = await followupChecksFixture(createStore());
      const controller = createSupportReleaseFollowupChecks(
        {
          ...f.options,
          deferred: true,
          fetch: async () => {
            f.wire.state.calls += 1;
            throw new TypeError("Fictional provider ACK loss");
          },
        },
        "pegma.dev",
      );
      await controller.forWork(f.f.key).check(f.input, f.context);
      const [pending] = await controller.scanPending();
      expect(pending).toBeDefined();
      expect(
        await controller.precomputePending(
          pending!.operationId,
          f.context,
          f.f.key,
        ),
      ).not.toMatchObject({ outcome: "checked" });
      expect(f.wire.state.calls).toBe(1);
      await controller.precomputePending(
        pending!.operationId,
        f.context,
        f.f.key,
      );
      await controller.forWork(f.f.key).check(f.input, f.context);
      expect(f.wire.state.calls).toBe(1);
    });

    it("permits only one concurrent provider invocation and requires a fresh later receipt phase", async () => {
      const f = await followupChecksFixture(createStore());
      const controller = createSupportReleaseFollowupChecks(
        { ...f.options, deferred: true },
        "pegma.dev",
      );
      await controller.forWork(f.f.key).prepare!(f.input, f.context);
      const [pending] = await controller.scanPending();
      const outcomes = await Promise.all(
        [1, 2].map(() =>
          controller.precomputePending(
            pending!.operationId,
            f.context,
            f.f.key,
          ),
        ),
      );
      expect(
        outcomes.filter((value) => value.outcome === "received"),
      ).toHaveLength(1);
      expect(f.wire.state.calls).toBe(1);
      const head = await f.store
        .collection(releaseFollowupCheckAttempts)
        .get({ partition: "support_release_followup", id: "attempts" });
      expect(head?.entries[0]?.receipt).toBeNull();
      f.state.active = false;
      expect(
        await controller.precomputePending(
          pending!.operationId,
          f.context,
          f.f.key,
        ),
      ).toEqual({ outcome: "held" });
      expect(f.wire.state.calls).toBe(1);
    });

    it.each(["role", "scope", "cancel", "kill"] as const)(
      "rechecks %s before the deferred physical call",
      async (change) => {
        const f = await followupChecksFixture(createStore());
        const controller = createSupportReleaseFollowupChecks(
          { ...f.options, deferred: true },
          "pegma.dev",
        );
        await controller.forWork(f.f.key).prepare!(f.input, f.context);
        const [pending] = await controller.scanPending();
        if (change === "role") f.state.active = false;
        const cancelled = new AbortController();
        if (change === "cancel") cancelled.abort();
        expect(
          await controller.precomputePending(
            pending!.operationId,
            { ...f.context, signal: cancelled.signal },
            change === "scope"
              ? { ...f.f.key, workId: "different-work" }
              : f.f.key,
            () => change !== "kill",
          ),
        ).toEqual({ outcome: "held" });
        expect(f.wire.state.calls).toBe(0);
      },
    );

    it("erases queued private text on withdrawal and retains an intent tombstone against requeue", async () => {
      const f = await followupChecksFixture(createStore());
      const controller = createSupportReleaseFollowupChecks(
        { ...f.options, deferred: true },
        "pegma.dev",
      );
      await controller.forWork(f.f.key).prepare!(f.input, f.context);
      const [pending] = await controller.scanPending();
      await f.f.app.withdrawEngineeringSource(engineeringFollowupStaff, {
        ...f.f.command("withdraw-deferred-sd05-check"),
        reason: "privacy_withdrawal",
      });
      await controller.discardTicket(f.f.key.ticketId);
      const head = await f.store
        .collection(releaseFollowupCheckAttempts)
        .get({ partition: "support_release_followup", id: "attempts" });
      expect(head?.entries).toHaveLength(1);
      expect(head?.entries[0]).toMatchObject({ state: "held", request: null });
      expect(JSON.stringify(head)).not.toContain(
        f.input.exactBundle.customerDraft.body,
      );
      expect(
        await controller.precomputePending(
          pending!.operationId,
          f.context,
          f.f.key,
        ),
      ).toEqual({ outcome: "held" });
      expect(f.wire.state.calls).toBe(0);
    });

    it("purges expired request text without making an expired intent callable again", async () => {
      const f = await followupChecksFixture(createStore());
      const controller = createSupportReleaseFollowupChecks(
        { ...f.options, deferred: true, deferredRetentionMilliseconds: 1 },
        "pegma.dev",
      );
      await controller.forWork(f.f.key).prepare!(f.input, f.context);
      const [pending] = await controller.scanPending();
      f.wire.state.now = new Date(
        Date.parse(f.wire.state.now) + 2,
      ).toISOString();
      f.f.advance(2);
      await controller.purgeExpired();
      expect(await controller.scanPending()).toEqual([]);
      expect(
        await controller.precomputePending(
          pending!.operationId,
          f.context,
          f.f.key,
        ),
      ).toEqual({ outcome: "held" });
      expect(
        await controller.forWork(f.f.key).prepare!(f.input, f.context),
      ).toEqual({ outcome: "held" });
      expect(f.wire.state.calls).toBe(0);
    });

    it("erases private requests using only Store and Clock after all paid configuration is removed", async () => {
      const f = await followupChecksFixture(createStore());
      const controller = createSupportReleaseFollowupChecks(
        { ...f.options, deferred: true },
        "pegma.dev",
      );
      await controller.forWork(f.f.key).prepare!(f.input, f.context);
      f.state.active = false;
      const cleanup = createSupportReleaseFollowupCheckCleanup({
        store: f.store,
        clock: f.options.clock,
      });
      await cleanup.discardTicket(f.f.key.ticketId);
      const head = await f.store
        .collection(releaseFollowupCheckAttempts)
        .get({ partition: "support_release_followup", id: "attempts" });
      expect(head?.entries[0]).toMatchObject({ state: "held", request: null });
      expect(JSON.stringify(head)).not.toContain(
        f.input.exactBundle.customerDraft.body,
      );
      expect(f.wire.state.calls).toBe(0);
    });

    it.each(["received", "checked"] as const)(
      "recovers a lost %s ACK through a fresh receipt-only invocation",
      async (state) => {
        const f = await followupChecksFixture(createStore());
        const controller = createSupportReleaseFollowupChecks(
          {
            ...f.options,
            deferred: true,
            store: loseAcceptedAck(f.store, state),
          },
          "pegma.dev",
        );
        await controller.forWork(f.f.key).prepare!(f.input, f.context);
        const [pending] = await controller.scanPending();
        if (state === "checked")
          expect(
            await controller.precomputePending(
              pending!.operationId,
              f.context,
              f.f.key,
            ),
          ).toMatchObject({ outcome: "received" });
        expect(
          await controller.precomputePending(
            pending!.operationId,
            f.context,
            f.f.key,
          ),
        ).toMatchObject({ outcome: "held" });
        const head = await f.store
          .collection(releaseFollowupCheckAttempts)
          .get({ partition: "support_release_followup", id: "attempts" });
        expect(head?.entries[0]?.state).toBe(state);
        expect(
          await controller.precomputePending(
            pending!.operationId,
            f.context,
            f.f.key,
          ),
        ).toMatchObject({ outcome: "checked" });
        expect(f.wire.state.calls).toBe(1);
      },
    );

    it("preserves existing current-staff inline reassessment when Work deferral is enabled", async () => {
      const f = await followupChecksFixture(createStore());
      const controller = createSupportReleaseFollowupChecks(
        { ...f.options, deferred: true },
        "pegma.dev",
      );
      const view = await f.f.app.readEngineeringFollowupReassessment(
        engineeringFollowupStaff,
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
      const port = controller.forReassessment(f.f.key, {
        resolve: async () => ({
          outcome: "ready",
          authority: {
            access: engineeringFollowupStaff,
            authorityVersion: "fictional-current-staff",
            usageScopeRef: f.wire.route.usageScopeRef,
          },
        }),
      });
      expect(port.prepare).toBeUndefined();
      expect(await port.check(input, f.context)).toMatchObject({
        outcome: "checked",
      });
      expect(f.wire.state.calls).toBe(1);
      expect(await controller.scanPending()).toEqual([]);
    });

    it("resumes queued provider and receipt phases after their prior physical deadlines", async () => {
      const f = await followupChecksFixture(createStore());
      const controller = createSupportReleaseFollowupChecks(
        { ...f.options, deferred: true, maxOperationMilliseconds: 5000 },
        "pegma.dev",
      );
      const external = () => ({
        signal: new AbortController().signal,
        deadline: new Date(Date.parse(f.wire.state.now) + 5000).toISOString(),
      });
      await controller.forWork(f.f.key).prepare!(f.input, {
        ...external(),
        purpose: "support_release_followup",
      });
      const [pending] = await controller.scanPending();
      const advance = () => {
        f.f.advance(10_000);
        f.wire.state.now = f.f.clock.now();
      };
      advance();
      expect(
        await controller.precomputePending(
          pending!.operationId,
          external(),
          f.f.key,
        ),
      ).toMatchObject({ outcome: "received" });
      advance();
      expect(
        await controller.precomputePending(
          pending!.operationId,
          external(),
          f.f.key,
        ),
      ).toMatchObject({ outcome: "checked" });
      expect(f.wire.state.calls).toBe(1);
    });

    it("allows nonshortening approval-window refresh across queued phases without extending the original receipt bound", async () => {
      const f = await followupChecksFixture(createStore());
      f.wire.route.approval.validUntil = new Date(
        Date.parse(f.wire.state.now) + 120000,
      ).toISOString();
      const controller = createSupportReleaseFollowupChecks(
        { ...f.options, deferred: true },
        "pegma.dev",
      );
      const external = () => ({
        signal: new AbortController().signal,
        deadline: new Date(Date.parse(f.wire.state.now) + 15000).toISOString(),
      });
      await controller.forWork(f.f.key).prepare!(f.input, {
        ...external(),
        purpose: "support_release_followup",
      });
      const [pending] = await controller.scanPending();
      const refresh = () => {
        f.f.advance(10_000);
        f.wire.state.now = f.f.clock.now();
        f.wire.route.approval.verifiedAt = f.wire.state.now;
        f.wire.route.approval.validUntil = new Date(
          Date.parse(f.wire.route.approval.validUntil) + 60_000,
        ).toISOString();
      };
      refresh();
      expect(
        await controller.precomputePending(
          pending!.operationId,
          external(),
          f.f.key,
        ),
      ).toMatchObject({ outcome: "received" });
      refresh();
      const completed = await controller.precomputePending(
        pending!.operationId,
        external(),
        f.f.key,
      );
      expect(completed.outcome).toBe("checked");
      const verified = await controller.sdkVerifier.verify(
        completed.receipt!,
        f.input.binding,
        external().signal,
      );
      expect(verified).not.toBeNull();
      expect(Date.parse(verified!.validUntil)).toBeLessThanOrEqual(
        Date.parse(pending!.expiresAt),
      );
      expect(f.wire.state.calls).toBe(1);
    });

    it("rejects a shortened current approval even when the queued retention window would still be live", async () => {
      const f = await followupChecksFixture(createStore());
      f.wire.route.approval.validUntil = new Date(
        Date.parse(f.wire.state.now) + 120000,
      ).toISOString();
      const controller = createSupportReleaseFollowupChecks(
        { ...f.options, deferred: true },
        "pegma.dev",
      );
      await controller.forWork(f.f.key).prepare!(f.input, f.context);
      const [pending] = await controller.scanPending();
      f.wire.route.approval.validUntil = new Date(
        Date.parse(f.wire.route.approval.validUntil) - 1,
      ).toISOString();
      expect(
        await controller.precomputePending(
          pending!.operationId,
          f.context,
          f.f.key,
        ),
      ).toEqual({ outcome: "held" });
      expect(f.wire.state.calls).toBe(0);
    });

    it("drives real SDK plan, generator, completion, deferred check and checked bundle in separate invocations", async () => {
      const f = await followupControllerFixture(createStore(), {
        maxModelAttempts: 1,
      });
      const g = await followupModelFixture("pegma.dev", f.f.clock.now());
      Object.assign(g.route.configuration.budgets, { maxAttempts: 1 });
      const { approval: _approval, ...route } = g.route;
      g.route.approval.requestPolicySha256 =
        await supportReleaseFollowupRoutePolicySha256(route);
      const originalDeadline = (await f.f.work()).deadline;
      const usage = createSupportReleaseFollowupUsage({
        store: f.store,
        clock: g.options.clock,
        policy: {
          version: "fictional-staged-generator-pool",
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
      const checks = createSupportReleaseFollowupChecks(
        { ...f.options, deferred: true },
        "pegma.dev",
      );
      const coordinator = createSupportDeskReleaseFollowup({
        application: f.f.app,
        clock: f.f.clock,
        invocationMode: "staged",
        serviceAccess: {
          resolve: async () => ({
            outcome: "ready",
            authority: {
              access: engineeringFollowupService,
              authorityVersion: "fictional-staged-generator",
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
        targets: { resolve: async () => ({ kind: "none" }) },
      });
      const command = {
        ...f.f.key,
        workerId: "fictional-staged-worker",
        leaseMilliseconds: 30000,
      };
      expect(await coordinator.processWork(command)).toMatchObject({
        checkpoint: "model_planned",
        callState: "not_called",
      });
      expect(g.state.calls).toBe(0);
      expect(await coordinator.processWork(command)).toMatchObject({
        checkpoint: "model_recorded",
        callState: "recorded",
      });
      expect(await coordinator.processWork(command)).toMatchObject({
        outcome: "candidate",
      });
      expect(await coordinator.processWork(command)).toMatchObject({
        checkpoint: "checks_planned",
        callState: "not_called",
      });
      expect(f.wire.state.calls).toBe(0);
      const [pending] = await checks.scanPending();
      const context = {
        signal: new AbortController().signal,
        deadline: new Date(Date.parse(f.f.clock.now()) + 15000).toISOString(),
      };
      expect(
        await checks.precomputePending(pending!.operationId, context, f.f.key),
      ).toMatchObject({ outcome: "received" });
      expect(
        await checks.precomputePending(pending!.operationId, context, f.f.key),
      ).toMatchObject({ outcome: "checked" });
      expect(await coordinator.processWork(command)).toMatchObject({
        outcome: "prepared",
      });
      expect((await f.f.work()).preparedBundle?.checksReceipt).toMatch(
        /^sf1\./u,
      );
      expect((await f.f.work()).delivered).toBeUndefined();
      expect(g.state.calls).toBe(1);
      expect(f.wire.state.calls).toBe(1);
      expect((await f.f.work()).deadline).toBe(originalDeadline);
      expect((await f.f.work()).usageTombstones).toHaveLength(1);
    });
  });
}
