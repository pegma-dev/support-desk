import type { CollectionDefinition, Store } from "@pegma/storage-core";
import { createSupportDeskReleaseFollowup } from "@pegma/support-desk-ai";
import {
  supportPermissions,
  type EngineeringFollowupModelObservation,
} from "@pegma/support-desk-application";
import { describe, expect, it, vi } from "vitest";
import {
  engineeringFollowupAiFixture,
  waitForFollowupHook,
} from "../test/engineering-followup-ai-fixtures.js";
import {
  engineeringFollowupStores,
  engineeringFollowupStaff,
  engineeringFollowupBarrier,
} from "../test/engineering-followup-fixtures.js";

type Fixture = Awaited<ReturnType<typeof engineeringFollowupAiFixture>>;
const stagedOptions = (f: Fixture) => ({
  ...f.baseOptions,
  checks: { ...f.baseOptions.checks, prepare: f.check },
});

/** Pause actual opening reads without replacing any Store result or version. */
function openingStore(backing: Store) {
  let target: { ticketId: string; workId: string } | undefined;
  const started: string[] = [];
  const barrier = engineeringFollowupBarrier();
  const complete = engineeringFollowupBarrier();
  let completed = 0;
  const store: Store = {
    collection<T>(definition: CollectionDefinition<T>) {
      const actual = backing.collection(definition);
      return new Proxy(actual, {
        get(object, property) {
          if (property === "getVersioned")
            return async (key: { partition: string; id: string }) => {
              const watched =
                target !== undefined &&
                key.partition === target.ticketId &&
                [
                  "ticket",
                  "engineering-source",
                  "engineering-followup-head",
                  `engineering-followup:${target.workId}`,
                ].includes(key.id);
              if (watched) started.push(key.id);
              const value = await object.getVersioned(key);
              if (watched) {
                completed += 1;
                if (completed === 4) void complete.wait();
                await barrier.wait();
              }
              return value;
            };
          const value: unknown = Reflect.get(object, property, object);
          return typeof value === "function" ? value.bind(object) : value;
        },
      });
    },
  };
  return {
    store,
    started,
    barrier,
    complete,
    arm(key: { ticketId: string; workId: string }) {
      target = key;
    },
    disarm() {
      target = undefined;
    },
  };
}

for (const [name, createStore] of engineeringFollowupStores) {
  describe(`staged release follow-up invocations (${name})`, () => {
    it("starts all four authorized mutation points before awaiting an opening result", async () => {
      const observed = openingStore(createStore());
      const f = await engineeringFollowupAiFixture(observed.store);
      const followup = createSupportDeskReleaseFollowup({
        ...stagedOptions(f),
        invocationMode: "staged",
      });
      observed.arm(f.key);
      const pending = followup.processWork(f.nextCommand());
      try {
        await waitForFollowupHook(observed.barrier, pending);
        expect(observed.started).toHaveLength(4);
      } finally {
        observed.disarm();
        observed.barrier.release();
        await pending;
      }
      expect(await pending).toMatchObject({ checkpoint: "model_planned" });
      expect(f.generate).not.toHaveBeenCalled();
    });

    it("does not claim or call a provider after Source changes behind the opening wave", async () => {
      const observed = openingStore(createStore());
      const f = await engineeringFollowupAiFixture(observed.store);
      const followup = createSupportDeskReleaseFollowup({
        ...stagedOptions(f),
        invocationMode: "staged",
      });
      observed.arm(f.key);
      const pending = followup.processWork(f.nextCommand());
      try {
        await waitForFollowupHook(observed.barrier, pending);
        expect(observed.started).toHaveLength(4);
        await observed.complete.reached;
        observed.disarm();
        await f.app.withdrawEngineeringSource(engineeringFollowupStaff, {
          ...f.command("withdraw-during-opening-wave"),
          reason: "privacy_withdrawal",
        });
      } finally {
        observed.disarm();
        observed.barrier.release();
        await pending;
      }
      expect(await pending).not.toMatchObject({ checkpoint: "model_planned" });
      expect(f.generate).not.toHaveBeenCalled();
      expect(f.reserve).not.toHaveBeenCalled();
      expect((await f.work()).claim).toBeUndefined();
    });

    it("uses one actual App proof per mutation", async () => {
      const f = await engineeringFollowupAiFixture(createStore());
      const followup = createSupportDeskReleaseFollowup({
        ...stagedOptions(f),
        invocationMode: "staged",
      });
      f.confirm.mockClear();
      expect(await followup.processWork(f.nextCommand())).toMatchObject({
        checkpoint: "model_planned",
      });
      expect(f.confirm).toHaveBeenCalledTimes(2);
      f.confirm.mockClear();
      expect(await followup.processWork(f.nextCommand())).toMatchObject({
        checkpoint: "model_recorded",
      });
      expect(f.confirm).toHaveBeenCalledTimes(3);
      expect(f.generate).toHaveBeenCalledOnce();
    });

    it("keeps proof views immutable, caller-bound and expired when their guard settles", async () => {
      const f = await engineeringFollowupAiFixture(createStore());
      const plan = f.app.planEngineeringFollowupModel!;
      let captured: EngineeringFollowupModelObservation | undefined;
      const followup = createSupportDeskReleaseFollowup({
        ...stagedOptions(f),
        invocationMode: "staged",
        application: {
          ...f.app,
          planEngineeringFollowupModel(access, command, guard) {
            return plan(access, command, async (observation) => {
              captured = observation;
              const proof = observation!.readProof!(f.state.authority.access);
              expect(Object.isFrozen(proof)).toBe(true);
              expect(Object.isFrozen(proof.publicFacts[0])).toBe(true);
              expect(() =>
                observation!.readProof!({
                  ...f.state.authority.access,
                  principalId: "another-service",
                }),
              ).toThrow();
              expect(() =>
                observation!.readProof!({
                  ...f.state.authority.access,
                  permissions: [],
                }),
              ).toThrow();
              await guard(observation);
            });
          },
        },
      });
      expect(await followup.processWork(f.nextCommand())).toMatchObject({
        checkpoint: "model_planned",
      });
      expect(() => captured!.readProof!(f.state.authority.access)).toThrow(
        "expired",
      );
    });

    it("retains full proof reads for an older structural guard observation", async () => {
      const f = await engineeringFollowupAiFixture(createStore());
      const begin = f.app.beginEngineeringFollowupModel!;
      const followup = createSupportDeskReleaseFollowup({
        ...stagedOptions(f),
        invocationMode: "staged",
        application: {
          ...f.app,
          beginEngineeringFollowupModel(access, command, guard) {
            return begin(access, command, (observation) =>
              guard(
                observation === undefined
                  ? undefined
                  : {
                      readWork: (reader) => observation.readWork(reader),
                    },
              ),
            );
          },
        },
      });
      await followup.processWork(f.nextCommand());
      f.confirm.mockClear();
      expect(await followup.processWork(f.nextCommand())).toMatchObject({
        checkpoint: "model_recorded",
      });
      expect(f.confirm).toHaveBeenCalledTimes(4);
      expect(f.generate).toHaveBeenCalledOnce();
    });

    it("rejects public facts changed after the claim proof and before the current App guard", async () => {
      const f = await engineeringFollowupAiFixture(createStore());
      let change = false;
      const followup = createSupportDeskReleaseFollowup({
        ...stagedOptions(f),
        invocationMode: "staged",
        configuration: {
          async resolve(...args) {
            const value = await f.resolveConfiguration(...args);
            if (change && args[0] === undefined) {
              change = false;
              f.releaseState.publicFacts = [
                {
                  reference: "changed-release",
                  text: "Different current release facts.",
                },
              ];
            }
            return value;
          },
        },
      });
      await followup.processWork(f.nextCommand());
      change = true;
      expect(await followup.processWork(f.nextCommand())).not.toMatchObject({
        checkpoint: "model_recorded",
      });
      expect(f.generate).not.toHaveBeenCalled();
      expect((await f.work()).pendingModelCompletion).toBeUndefined();
    });

    it.each(["role", "route", "expiry"] as const)(
      "retains fresh %s checks after the App opening proof",
      async (change) => {
        const f = await engineeringFollowupAiFixture(createStore());
        let armed = false;
        const followup = createSupportDeskReleaseFollowup({
          ...stagedOptions(f),
          invocationMode: "staged",
          checks: {
            ...stagedOptions(f).checks,
            async resolvePolicy(...args) {
              const value = await f.resolveCheckPolicy(...args);
              if (armed && args[0] !== undefined) {
                armed = false;
                if (change === "role")
                  f.state.authority = {
                    ...f.state.authority,
                    access: { ...f.state.authority.access, permissions: [] },
                  };
                else if (change === "route")
                  f.state.configuration = {
                    ...f.state.configuration,
                    dataControls: {
                      ...f.state.configuration.dataControls,
                      endpointRef: "changed-endpoint",
                    },
                  };
                else f.advance(61_000);
              }
              return value;
            },
          },
        });
        await followup.processWork(f.nextCommand());
        armed = true;
        await followup.processWork(f.nextCommand());
        expect(f.generate).not.toHaveBeenCalled();
        expect((await f.work()).pendingModelCompletion).toBeUndefined();
      },
    );

    it("commits a released not-called plan before any usage reservation or model call", async () => {
      const f = await engineeringFollowupAiFixture(createStore());
      const followup = createSupportDeskReleaseFollowup({
        ...stagedOptions(f),
        invocationMode: "staged",
      });
      expect(await followup.processWork(f.nextCommand())).toMatchObject({
        outcome: "pending",
        checkpoint: "model_planned",
        callState: "not_called",
      });
      expect(f.generate).not.toHaveBeenCalled();
      expect(f.reserve).not.toHaveBeenCalled();
      const planned = await f.work();
      expect(planned.claim).toBeUndefined();
      expect(planned.leaseUntil).toBeUndefined();
      expect(planned.modelAttempts).toHaveLength(1);
      expect(planned.modelAttempts[0]).toMatchObject({
        accounting: "not_called",
        callState: "not_called",
      });
      expect(planned.candidate).toBeUndefined();
    });

    it("uses a later one-shot provider invocation and a separate fresh completion", async () => {
      const f = await engineeringFollowupAiFixture(createStore());
      const followup = createSupportDeskReleaseFollowup({
        ...stagedOptions(f),
        invocationMode: "staged",
      });
      expect(await followup.processWork(f.nextCommand())).toMatchObject({
        checkpoint: "model_planned",
      });
      expect(await followup.processWork(f.nextCommand())).toMatchObject({
        checkpoint: "model_recorded",
        callState: "recorded",
      });
      expect(f.generate).toHaveBeenCalledOnce();
      expect(f.reserve).toHaveBeenCalledOnce();
      const recorded = await f.work();
      expect(recorded.claim).toBeUndefined();
      expect(recorded.candidate).toBeUndefined();
      expect(recorded.pendingModelCompletion?.candidate).toEqual(f.candidate());
      expect(await followup.processWork(f.nextCommand())).toMatchObject({
        outcome: "candidate",
      });
      expect(f.generate).toHaveBeenCalledOnce();
      expect((await f.work()).pendingModelCompletion).toBeUndefined();
      expect((await f.work()).candidate).toEqual(f.candidate());
    });

    it("holds a staged structural application without its capability before claiming", async () => {
      const f = await engineeringFollowupAiFixture(createStore());
      const claim = vi.fn(f.app.claimEngineeringFollowupWork);
      const { planEngineeringFollowupModel: _plan, ...legacy } = f.app;
      const followup = createSupportDeskReleaseFollowup({
        ...stagedOptions(f),
        invocationMode: "staged",
        application: {
          ...legacy,
          claimEngineeringFollowupWork: claim,
        },
      });
      const before = await f.work();
      expect(await followup.processWork(f.nextCommand())).toMatchObject({
        outcome: "pending",
        reason: "staged_invocation_unavailable",
      });
      expect(claim).not.toHaveBeenCalled();
      expect(f.generate).not.toHaveBeenCalled();
      expect(f.reserve).not.toHaveBeenCalled();
      expect(await f.work()).toEqual(before);
    });

    it("resumes a lost planning ACK without spending or creating another model attempt", async () => {
      const f = await engineeringFollowupAiFixture(createStore());
      const plan = f.app.planEngineeringFollowupModel!;
      const followup = createSupportDeskReleaseFollowup({
        ...stagedOptions(f),
        invocationMode: "staged",
        application: {
          ...f.app,
          async planEngineeringFollowupModel(...args) {
            await plan(...args);
            throw new Error("Fictional accepted plan ACK loss");
          },
        },
      });
      expect(await followup.processWork(f.nextCommand())).toMatchObject({
        outcome: "pending",
        stage: "prepare",
      });
      expect(f.generate).not.toHaveBeenCalled();
      expect((await f.work()).modelAttempts[0]?.callState).toBe("not_called");
      expect(await followup.processWork(f.nextCommand())).toMatchObject({
        checkpoint: "model_recorded",
      });
      expect(await followup.processWork(f.nextCommand())).toMatchObject({
        outcome: "candidate",
      });
      expect(f.generate).toHaveBeenCalledOnce();
      expect((await f.work()).usageTombstones).toHaveLength(1);
    });

    it("never repeats a potentially begun invocation when its transition ACK is lost", async () => {
      const f = await engineeringFollowupAiFixture(createStore());
      const begin = f.app.beginEngineeringFollowupModel!;
      const followup = createSupportDeskReleaseFollowup({
        ...stagedOptions(f),
        invocationMode: "staged",
        application: {
          ...f.app,
          async beginEngineeringFollowupModel(...args) {
            await begin(...args);
            throw new Error("Fictional accepted begin ACK loss");
          },
        },
      });
      await followup.processWork(f.nextCommand());
      expect(await followup.processWork(f.nextCommand())).toMatchObject({
        outcome: "held",
      });
      const stopped = await f.work();
      expect(stopped.modelAttempts[0]).toMatchObject({
        accounting: "unknown",
        callState: "possibly_called",
      });
      expect(f.generate).not.toHaveBeenCalled();
      expect(
        f.reconcile.mock.calls.some(
          ([, observation]) => observation.state === "unknown",
        ),
      ).toBe(true);
      expect(await followup.processWork(f.nextCommand())).toEqual({
        outcome: "not_claimed",
      });
      expect(f.generate).not.toHaveBeenCalled();
    });

    it("captures an actual result once and recovers a lost capture ACK without regenerating", async () => {
      const f = await engineeringFollowupAiFixture(createStore());
      f.setModel(async () => {
        expect((await f.work()).modelAttempts[0]).toMatchObject({
          callState: "possibly_called",
          accounting: "unknown",
        });
        return f.answer();
      });
      const record = f.app.recordEngineeringFollowupModel!;
      const followup = createSupportDeskReleaseFollowup({
        ...stagedOptions(f),
        invocationMode: "staged",
        application: {
          ...f.app,
          async recordEngineeringFollowupModel(...args) {
            await record(...args);
            throw new Error("Fictional recorded result ACK loss");
          },
        },
      });
      await followup.processWork(f.nextCommand());
      expect(await followup.processWork(f.nextCommand())).toMatchObject({
        outcome: "pending",
        stage: "complete",
      });
      expect((await f.work()).pendingModelCompletion?.accounting).toBe(
        "accounted",
      );
      expect(await followup.processWork(f.nextCommand())).toMatchObject({
        outcome: "candidate",
      });
      expect(f.generate).toHaveBeenCalledOnce();
      expect(f.reserve).toHaveBeenCalledOnce();
    });

    it.each(["configuration", "role", "release", "deadline"] as const)(
      "rechecks %s before a planned provider attempt",
      async (change) => {
        const f = await engineeringFollowupAiFixture(createStore());
        const followup = createSupportDeskReleaseFollowup({
          ...stagedOptions(f),
          invocationMode: "staged",
        });
        await followup.processWork(f.nextCommand());
        if (change === "configuration")
          f.state.configuration = {
            ...f.state.configuration,
            trustedInstructions: "Changed current instructions.",
          };
        else if (change === "role")
          f.state.authority = {
            ...f.state.authority,
            access: {
              ...f.state.authority.access,
              permissions: f.state.authority.access.permissions.filter(
                (p) => p !== supportPermissions.engineeringFollowupProcess,
              ),
            },
          };
        else if (change === "release")
          f.releaseState.currentOutcome = "unavailable";
        else f.advance(61_000);
        await followup.processWork(f.nextCommand());
        expect(f.generate).not.toHaveBeenCalled();
        expect(f.reserve).not.toHaveBeenCalled();
        expect((await f.work()).candidate).toBeUndefined();
      },
    );

    it("requires fresh completion policy and clears captured private text on source withdrawal", async () => {
      const f = await engineeringFollowupAiFixture(createStore());
      const followup = createSupportDeskReleaseFollowup({
        ...stagedOptions(f),
        invocationMode: "staged",
      });
      await followup.processWork(f.nextCommand());
      await followup.processWork(f.nextCommand());
      expect((await f.work()).pendingModelCompletion).toBeDefined();
      f.state.checkPolicyOutcome = "unavailable";
      expect(await followup.processWork(f.nextCommand())).not.toMatchObject({
        outcome: "candidate",
      });
      expect(f.generate).toHaveBeenCalledOnce();
      await f.app.withdrawEngineeringSource(engineeringFollowupStaff, {
        ...f.command("withdraw-staged-provider-result"),
        reason: "privacy_withdrawal",
      });
      const withdrawn = await f.work();
      expect(withdrawn.pendingModelCompletion).toBeUndefined();
      expect(withdrawn.modelAttempts).toHaveLength(0);
      expect(withdrawn.usageTombstones).toHaveLength(1);
    });

    it("keeps checkpoint responses body-free and preserves the configured one-attempt ceiling", async () => {
      const f = await engineeringFollowupAiFixture(createStore(), {
        followup: { maxModelAttempts: 1 },
      });
      f.setBudgets({ maxAttempts: 1 });
      const originalDeadline = (await f.work()).deadline;
      const followup = createSupportDeskReleaseFollowup({
        ...stagedOptions(f),
        invocationMode: "staged",
      });
      const planned = await followup.processWork(f.nextCommand());
      const recorded = await followup.processWork(f.nextCommand());
      expect(JSON.stringify([planned, recorded])).not.toContain(
        f.candidate().customerDraft.body,
      );
      expect(JSON.stringify([planned, recorded])).not.toContain("candidate");
      expect(await followup.processWork(f.nextCommand())).toMatchObject({
        outcome: "candidate",
      });
      expect(f.generate).toHaveBeenCalledOnce();
      expect(f.generate.mock.calls[0]?.[1].attempt).toBe(1);
      expect((await f.work()).deadline).toBe(originalDeadline);
    });

    it("keeps a concurrent worker from invoking a live one-shot model attempt twice", async () => {
      const f = await engineeringFollowupAiFixture(createStore(), {
        followup: { maxModelAttempts: 1 },
      });
      f.setBudgets({ maxAttempts: 1 });
      const barrier = engineeringFollowupBarrier();
      f.setModel(async () => {
        await barrier.wait();
        return f.answer();
      });
      const followup = createSupportDeskReleaseFollowup({
        ...stagedOptions(f),
        invocationMode: "staged",
      });
      await followup.processWork(f.nextCommand());
      const pending = followup.processWork(f.nextCommand());
      try {
        await waitForFollowupHook(barrier, pending);
        expect(await followup.processWork(f.nextCommand())).toEqual({
          outcome: "not_claimed",
        });
      } finally {
        barrier.release();
      }
      expect(await pending).toMatchObject({ checkpoint: "model_recorded" });
      expect(await followup.processWork(f.nextCommand())).toMatchObject({
        outcome: "candidate",
      });
      expect(f.generate).toHaveBeenCalledOnce();
      expect((await f.work()).usageTombstones).toHaveLength(1);
    });

    it("uses fresh physical deadlines after queue waits without renewing its semantic plan", async () => {
      const f = await engineeringFollowupAiFixture(createStore(), {
        followup: { maxModelAttempts: 1 },
      });
      f.setBudgets({ maxAttempts: 1 });
      const followup = createSupportDeskReleaseFollowup({
        ...stagedOptions(f),
        invocationMode: "staged",
        maxOperationMilliseconds: 5000,
      });
      expect(await followup.processWork(f.nextCommand())).toMatchObject({
        checkpoint: "model_planned",
      });
      const plan = (await f.work()).modelAttempts[0]!;
      f.advance(10_000);
      expect(await followup.processWork(f.nextCommand())).toMatchObject({
        checkpoint: "model_recorded",
      });
      expect(f.generate.mock.calls[0]?.[1].deadline).toBe(
        new Date(Date.parse(f.clock.now()) + 4000).toISOString(),
      );
      expect((await f.work()).modelAttempts[0]?.binding).toEqual(plan.binding);
      f.advance(10_000);
      expect(await followup.processWork(f.nextCommand())).toMatchObject({
        outcome: "candidate",
      });
      expect(f.generate).toHaveBeenCalledOnce();
    });
  });
}
