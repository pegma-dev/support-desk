import type { CollectionDefinition, Store } from "@pegma/storage-core";
import {
  engineeringFollowupChecksBinding,
  supportPermissions,
  supportRecords,
  type EngineeringFollowupBundleObservation,
  type PrepareEngineeringFollowupBundleCommand,
} from "@pegma/support-desk-application";
import { createSupportDeskReleaseFollowup } from "@pegma/support-desk-ai";
import { describe, expect, it, vi } from "vitest";
import {
  engineeringFollowupAiFixture,
  waitForFollowupHook,
} from "../test/engineering-followup-ai-fixtures.js";
import {
  engineeringFollowupBarrier,
  engineeringFollowupService,
  engineeringFollowupStaff,
  engineeringFollowupStores,
} from "../test/engineering-followup-fixtures.js";

type Fixture = Awaited<ReturnType<typeof engineeringFollowupAiFixture>>;

const staged = (f: Fixture) => ({
  ...f.baseOptions,
  invocationMode: "staged" as const,
  storageCommandAttempts: 1,
  checks: { ...f.baseOptions.checks, prepare: f.check },
});

async function bundleCommand(f: Fixture) {
  const work = await f.work();
  const bundle = await f.exactBundle(work.candidate!, f.key, work.context!);
  const checkPolicyVersion = f.state.checkPolicy.version;
  const binding = await engineeringFollowupChecksBinding({
    workBindingHash: work.workBindingHash,
    candidateHash: work.candidateHash!,
    exactBundle: bundle,
    checkPolicyVersion,
    followupRevocationEpoch: work.association.followupRevocationEpoch,
    context: work.context!,
  });
  const checksReceipt = "actual-exact-bundle-receipt";
  f.trust.issueChecks(checksReceipt, binding);
  return {
    ...f.command("scoped-bundle"),
    ...f.key,
    mode: "prepare",
    expectedWorkGeneration: work.workGeneration,
    candidateHash: work.candidateHash!,
    exactBundle: bundle,
    checkPolicyVersion,
    checksReceipt,
  } satisfies PrepareEngineeringFollowupBundleCommand;
}

function openingStore(backing: Store) {
  let target: Fixture["key"] | undefined;
  const started: string[] = [];
  const barrier = engineeringFollowupBarrier();
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
              if (watched) await barrier.wait();
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
    arm(key: Fixture["key"]) {
      target = key;
    },
    disarm() {
      target = undefined;
    },
  };
}

for (const [name, createStore] of engineeringFollowupStores) {
  describe(`late bundle observation (${name})`, () => {
    it("opens all four authorized bundle mutation points before the first awaited result", async () => {
      const observed = openingStore(createStore());
      const f = await engineeringFollowupAiFixture(observed.store);
      await f.prepareCandidate();
      const command = await bundleCommand(f);
      observed.arm(f.key);
      const pending = f.app.prepareEngineeringFollowupBundle(
        engineeringFollowupService,
        command,
        async () => {},
      );
      try {
        await waitForFollowupHook(observed.barrier, pending);
        expect(observed.started).toHaveLength(4);
      } finally {
        observed.disarm();
        observed.barrier.release();
        await pending;
      }
      expect(await pending).toMatchObject({ status: "bundle_prepared" });
      expect(f.generate).not.toHaveBeenCalled();
    });

    it("provides immutable same-actor Work and proof only inside the actual App guard", async () => {
      const f = await engineeringFollowupAiFixture(createStore());
      await f.prepareCandidate();
      const command = await bundleCommand(f);
      let captured: EngineeringFollowupBundleObservation | undefined;
      await f.app.prepareEngineeringFollowupBundle(
        engineeringFollowupService,
        command,
        async (observation) => {
          captured = observation;
          expect(observation).toBeDefined();
          const work = observation!.readWork(engineeringFollowupService);
          const proof = observation!.readProof(engineeringFollowupService);
          expect(work.workId).toBe(f.key.workId);
          expect(Object.isFrozen(work)).toBe(true);
          expect(Object.isFrozen(work.association)).toBe(true);
          expect(Object.isFrozen(proof.publicFacts[0])).toBe(true);
          expect(Object.keys(observation!)).toEqual(["readWork", "readProof"]);
          expect(() => {
            Reflect.set(work.association, "issueId", "wrong-resource");
          }).not.toThrow();
          expect(work.association.issueId).not.toBe("wrong-resource");
          for (const reader of [
            { ...engineeringFollowupService, principalId: "another-service" },
            {
              ...engineeringFollowupService,
              permissions: [supportPermissions.engineeringFollowupRead],
            },
            {
              ...engineeringFollowupService,
              permissions: [supportPermissions.queueRead],
            },
          ]) {
            expect(() => observation!.readWork(reader)).toThrow();
            expect(() => observation!.readProof(reader)).toThrow();
          }
        },
      );
      expect(() => captured!.readWork(engineeringFollowupService)).toThrow(
        "expired",
      );
      expect(() => captured!.readProof(engineeringFollowupService)).toThrow(
        "expired",
      );
    });

    it("uses only claim planning and the late App release proof, without standalone current rereads", async () => {
      const f = await engineeringFollowupAiFixture(createStore());
      await f.prepareCandidate();
      const read = vi.fn(f.app.readEngineeringFollowupWork);
      const confirm = vi.fn(f.app.confirmEngineeringFollowupCurrent);
      const followup = createSupportDeskReleaseFollowup({
        ...staged(f),
        application: {
          ...f.app,
          readEngineeringFollowupWork: read,
          confirmEngineeringFollowupCurrent: confirm,
        },
      });
      f.confirm.mockClear();
      expect(await followup.processWork(f.nextCommand())).toMatchObject({
        outcome: "prepared",
      });
      expect(f.confirm).toHaveBeenCalledTimes(2);
      expect(read).not.toHaveBeenCalled();
      expect(confirm).not.toHaveBeenCalled();
      expect(f.generate).not.toHaveBeenCalled();
    });

    it.each(["legacy", "inline"] as const)(
      "retains complete fresh %s proof and current-work fallbacks",
      async (mode) => {
        const f = await engineeringFollowupAiFixture(createStore());
        await f.prepareCandidate();
        const read = vi.fn(f.app.readEngineeringFollowupWork);
        const confirm = vi.fn(f.app.confirmEngineeringFollowupCurrent);
        const followup = createSupportDeskReleaseFollowup({
          ...(mode === "inline" ? f.baseOptions : staged(f)),
          application: {
            ...f.app,
            readEngineeringFollowupWork: read,
            confirmEngineeringFollowupCurrent: confirm,
            async claimEngineeringFollowupWork(...args) {
              const claim = await f.app.claimEngineeringFollowupWork(...args);
              if (claim === null || mode === "inline") return claim;
              const { bundleObservation: _capability, ...legacy } = claim;
              return legacy;
            },
            prepareEngineeringFollowupBundle(access, command, guard, control) {
              return f.app.prepareEngineeringFollowupBundle(
                access,
                command,
                () => guard(),
                control,
              );
            },
          },
        });
        f.confirm.mockClear();
        expect(await followup.processWork(f.nextCommand())).toMatchObject({
          outcome: "prepared",
        });
        expect(f.confirm).toHaveBeenCalledTimes(4);
        expect(read).toHaveBeenCalledOnce();
        expect(confirm).toHaveBeenCalledOnce();
        expect(f.generate).not.toHaveBeenCalled();
      },
    );

    it("observes release changes during receipt verification at the late proof boundary", async () => {
      const f = await engineeringFollowupAiFixture(createStore());
      await f.prepareCandidate();
      const original = f.checksVerify.getMockImplementation()!;
      let beforeAppReceipt = -1;
      let calls = 0;
      f.checksVerify.mockImplementation(async (...args) => {
        const result = await original(...args);
        if (++calls === 2) {
          beforeAppReceipt = f.confirm.mock.calls.length;
          f.releaseState.publicFacts = [
            {
              reference: "changed-during-receipt",
              text: "Different currently deployed behavior.",
            },
          ];
        }
        return result;
      });
      f.confirm.mockClear();
      const result = await createSupportDeskReleaseFollowup(
        staged(f),
      ).processWork(f.nextCommand());
      expect(beforeAppReceipt).toBe(1);
      expect(result).not.toMatchObject({ outcome: "prepared" });
      expect((await f.work()).preparedBundle).toBeUndefined();
      expect(f.confirm.mock.calls.length).toBeGreaterThan(beforeAppReceipt);
      expect(f.generate).not.toHaveBeenCalled();
    });

    it.each(["source", "association", "work", "head", "ticket"] as const)(
      "retains the closing opaque %s version after the guard",
      async (changed) => {
        const backing = createStore();
        const f = await engineeringFollowupAiFixture(backing, {
          support: { maxConflictAttempts: 1 },
        });
        await f.prepareCandidate();
        const command = await bundleCommand(f);
        const work = await f.work();
        const id =
          changed === "source"
            ? "engineering-source"
            : changed === "association"
              ? `engineering-work:${work.association.engineeringSourceGeneration}`
              : changed === "work"
                ? `engineering-followup:${f.key.workId}`
                : changed === "head"
                  ? "engineering-followup-head"
                  : "ticket";
        let changedVersion = false;
        await expect(
          f.app.prepareEngineeringFollowupBundle(
            engineeringFollowupService,
            command,
            async (observation) => {
              expect(
                observation!.readProof(engineeringFollowupService),
              ).toBeDefined();
              const records = backing.collection(supportRecords);
              const row = await records.getVersioned({
                partition: f.key.ticketId,
                id,
              });
              expect(row).not.toBeNull();
              changedVersion = await records.putIfUnchanged(
                row!.value,
                row!.version,
              );
            },
          ),
        ).rejects.toThrow();
        expect(changedVersion).toBe(true);
        expect((await f.work()).preparedBundle).toBeUndefined();
      },
    );

    it.each(["role", "route", "expiry", "signal"] as const)(
      "retains current %s refusal during the worker guard",
      async (change) => {
        const f = await engineeringFollowupAiFixture(createStore());
        await f.prepareCandidate();
        let armed = true;
        const originalRoute = f.state.configuration.dataControls.endpointRef;
        const abort = new AbortController();
        const followup = createSupportDeskReleaseFollowup({
          ...staged(f),
          checks: {
            ...staged(f).checks,
            async verify(...args) {
              // Model the host verifier's live route-bound receipt authority.
              return f.state.configuration.dataControls.endpointRef ===
                originalRoute
                ? f.checksVerify(...args)
                : null;
            },
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
                      endpointRef: "changed-route",
                    },
                  };
                else if (change === "expiry") f.advance(61_000);
                else abort.abort();
              }
              return value;
            },
          },
        });
        expect(
          await followup.processWork(f.nextCommand(), { signal: abort.signal }),
        ).not.toMatchObject({ outcome: "prepared" });
        expect(armed).toBe(false);
        expect((await f.work()).preparedBundle).toBeUndefined();
        expect(f.generate).not.toHaveBeenCalled();
      },
    );

    it("rejects actual Source withdrawal while the worker guard is suspended", async () => {
      const f = await engineeringFollowupAiFixture(createStore());
      await f.prepareCandidate();
      let withdrew = false;
      const followup = createSupportDeskReleaseFollowup({
        ...staged(f),
        checks: {
          ...staged(f).checks,
          async resolvePolicy(...args) {
            const result = await f.resolveCheckPolicy(...args);
            if (args[0] !== undefined && !withdrew) {
              withdrew = true;
              await f.app.withdrawEngineeringSource(engineeringFollowupStaff, {
                ...f.command("withdraw-during-bundle-guard"),
                reason: "privacy_withdrawal",
              });
            }
            return result;
          },
        },
      });
      expect(await followup.processWork(f.nextCommand())).not.toMatchObject({
        outcome: "prepared",
      });
      expect(withdrew).toBe(true);
      expect(await f.work()).toMatchObject({ withdrawn: true });
      expect((await f.work()).preparedBundle).toBeUndefined();
      expect(f.generate).not.toHaveBeenCalled();
    });

    it("refuses a wrong-resource observation and never treats it as current Work", async () => {
      const f = await engineeringFollowupAiFixture(createStore());
      await f.prepareCandidate();
      const followup = createSupportDeskReleaseFollowup({
        ...staged(f),
        application: {
          ...f.app,
          prepareEngineeringFollowupBundle(access, command, guard, control) {
            return f.app.prepareEngineeringFollowupBundle(
              access,
              command,
              (observation) =>
                guard({
                  readProof: (reader) => observation!.readProof(reader),
                  readWork: (reader) => ({
                    ...observation!.readWork(reader),
                    workId: "other-work",
                  }),
                }),
              control,
            );
          },
        },
      });
      expect(await followup.processWork(f.nextCommand())).not.toMatchObject({
        outcome: "prepared",
      });
      expect((await f.work()).preparedBundle).toBeUndefined();
    });

    it("expires an observation within a suspended guard and prevents commitment", async () => {
      const f = await engineeringFollowupAiFixture(createStore());
      await f.prepareCandidate();
      const command = await bundleCommand(f);
      await expect(
        f.app.prepareEngineeringFollowupBundle(
          engineeringFollowupService,
          command,
          async (observation) => {
            expect(
              observation!.readProof(engineeringFollowupService),
            ).toBeDefined();
            f.advance(61_000);
            expect(() =>
              observation!.readWork(engineeringFollowupService),
            ).toThrow("expired");
            expect(() =>
              observation!.readProof(engineeringFollowupService),
            ).toThrow("expired");
          },
        ),
      ).rejects.toThrow();
      expect((await f.work()).preparedBundle).toBeUndefined();
    });

    it("recovers an accepted unknown bundle ACK before new proof and never calls the model again", async () => {
      const f = await engineeringFollowupAiFixture(createStore());
      f.setBudgets({ maxAttempts: 1 });
      let accepted: PrepareEngineeringFollowupBundleCommand | undefined;
      const followup = createSupportDeskReleaseFollowup({
        ...staged(f),
        application: {
          ...f.app,
          async prepareEngineeringFollowupBundle(
            access,
            command,
            guard,
            control,
          ) {
            const result = await f.app.prepareEngineeringFollowupBundle(
              access,
              command,
              guard,
              control,
            );
            accepted = command;
            throw new Error(`Lost accepted ACK: ${result.status}`);
          },
        },
      });
      expect(await followup.processWork(f.nextCommand())).toMatchObject({
        checkpoint: "model_planned",
      });
      expect(await followup.processWork(f.nextCommand())).toMatchObject({
        checkpoint: "model_recorded",
      });
      expect(await followup.processWork(f.nextCommand())).toMatchObject({
        outcome: "candidate",
      });
      expect(await followup.processWork(f.nextCommand())).toMatchObject({
        outcome: "pending",
        stage: "bundle",
      });
      const prepared = await f.work();
      expect(prepared.preparedBundle).toBeDefined();
      f.releaseState.currentOutcome = "unavailable";
      f.releaseState.checksOutcome = "unavailable";
      f.confirm.mockClear();
      const guard = vi.fn(async () => {});
      expect(
        await f.app.prepareEngineeringFollowupBundle(
          engineeringFollowupService,
          accepted!,
          guard,
        ),
      ).toMatchObject({ status: "bundle_prepared" });
      expect(guard).not.toHaveBeenCalled();
      expect(f.confirm).not.toHaveBeenCalled();
      expect(await followup.processWork(f.nextCommand())).toMatchObject({
        outcome: "not_claimed",
      });
      expect(f.generate).toHaveBeenCalledOnce();
      expect(f.reserve).toHaveBeenCalledOnce();
      expect((await f.work()).modelAttempts).toEqual(prepared.modelAttempts);
    });
  });
}
