import type { CollectionDefinition, Store } from "@pegma/storage-core";
import {
  SupportDeskAuthorizationError,
  supportPermissions,
  supportRecords,
  type CompleteEngineeringModelCommand,
  type EngineeringModelPlanningObservation,
  type EngineeringWorkerObservation,
} from "@pegma/support-desk-application";
import { createSupportDeskEngineering } from "@pegma/support-desk-ai";
import { describe, expect, it, vi } from "vitest";
import {
  engineeringAiFixture,
  engineeringBarrier,
  engineeringCustomer,
  engineeringService,
  engineeringStaff,
  engineeringStores,
} from "../test/engineering-fixtures.js";

type Fixture = Awaited<ReturnType<typeof engineeringAiFixture>>;
function workerPorts(f: Fixture) {
  const plan = f.app.prepareEngineeringModelPlanned;
  const complete = f.app.completeEngineeringModelObserved;
  const proposal = f.app.prepareEngineeringProposalObserved;
  const begin = f.app.beginEngineeringDispatchObserved;
  if (
    plan === undefined ||
    complete === undefined ||
    proposal === undefined ||
    begin === undefined
  )
    throw new Error("Actual optional worker observation port missing");
  return { plan, complete, proposal, begin };
}
function readProbe(backing: Store) {
  const reads: string[] = [];
  const store: Store = {
    collection<T>(definition: CollectionDefinition<T>) {
      const target = backing.collection(definition);
      if (definition.name !== supportRecords.name) return target;
      return new Proxy(target, {
        get(object, key) {
          const value: unknown = Reflect.get(object, key, object);
          if (
            (key === "get" || key === "getVersioned" || key === "list") &&
            typeof value === "function"
          )
            return (...args: unknown[]) => {
              reads.push(
                typeof args[0] === "object" &&
                  args[0] !== null &&
                  "id" in args[0]
                  ? String(args[0].id)
                  : String(key),
              );
              return Reflect.apply(value, object, args);
            };
          return typeof value === "function" ? value.bind(object) : value;
        },
      });
    },
  };
  return { store, reads };
}
async function advanceVersion(store: Store, id: string) {
  const records = store.collection(supportRecords);
  const row = await records.getVersioned({ partition: "ticket", id });
  if (row === null) throw new Error("Actual SDK row missing");
  expect(await records.putIfUnchanged(row.value, row.version)).toBe(true);
}

for (const [name, createStore] of engineeringStores) {
  describe(`bounded observed worker phases (${name})`, () => {
    it("plans from the App-owned source without standalone source or context hydration", async () => {
      const f = await engineeringAiFixture(createStore());
      const ports = workerPorts(f);
      const plan = vi.fn(ports.plan);
      const readSource = vi.fn(async () => {
        throw new Error("Unexpected standalone source hydration");
      });
      const readContext = vi.fn(async () => {
        throw new Error("Unexpected standalone context hydration");
      });
      const engine = createSupportDeskEngineering({
        ...f.baseOptions,
        application: {
          ...f.app,
          prepareEngineeringModelPlanned: plan,
          readEngineeringSource: readSource,
          readEngineeringContext: readContext,
        },
      });
      expect(await engine.processWork(f.nextCommand())).toMatchObject({
        outcome: "candidate",
      });
      expect(plan).toHaveBeenCalledOnce();
      expect(readSource).not.toHaveBeenCalled();
      expect(readContext).not.toHaveBeenCalled();
      expect(f.generate).toHaveBeenCalledOnce();
      expect(f.reserve).toHaveBeenCalledOnce();
    });

    it("retries a lost planned preparation ACK using the exact already planned binding", async () => {
      const f = await engineeringAiFixture(createStore());
      const ports = workerPorts(f);
      const plans: unknown[] = [];
      const retries: unknown[] = [];
      const engine = createSupportDeskEngineering({
        ...f.baseOptions,
        application: {
          ...f.app,
          async prepareEngineeringModelPlanned(access, command, planner) {
            const result = await ports.plan(
              access,
              command,
              async (observation) => {
                const binding = await planner(observation);
                plans.push(structuredClone(binding));
                return binding;
              },
            );
            throw new Error(
              `Synthetic ACK loss for committed ${result.stepId}`,
            );
          },
          async prepareEngineeringModelObserved(...args) {
            retries.push(structuredClone(args[1].binding));
            return f.app.prepareEngineeringModelObserved!(...args);
          },
        },
      });
      expect(await engine.processWork(f.nextCommand())).toMatchObject({
        outcome: "candidate",
      });
      expect(plans).toHaveLength(1);
      expect(retries).toHaveLength(2);
      expect(
        retries.every(
          (binding) => JSON.stringify(binding) === JSON.stringify(plans[0]),
        ),
      ).toBe(true);
      expect((await f.work()).modelAttempts).toHaveLength(1);
      expect(f.generate).toHaveBeenCalledOnce();
      expect(f.reserve).toHaveBeenCalledOnce();
    });

    it("closes the planning scope and preserves one immutable plan through a real Ticket CAS conflict", async () => {
      const backing = createStore();
      const f = await engineeringAiFixture(backing);
      const owner = await f.claim();
      const binding = await f.modelBinding(owner);
      let captured: EngineeringModelPlanningObservation | undefined;
      const planner = vi.fn(
        async (scope: EngineeringModelPlanningObservation) => {
          captured = scope;
          expect(scope.read(engineeringService).claim.fence).toEqual(
            owner.fence,
          );
          expect(() =>
            scope.read({
              ...engineeringService,
              principalId: "foreign-model-owner",
            }),
          ).toThrow(SupportDeskAuthorizationError);
          await advanceVersion(backing, "ticket");
          return binding;
        },
      );
      await expect(
        workerPorts(f).plan(engineeringService, owner.fence, planner),
      ).resolves.toMatchObject({ maxCandidateBytes: 16000 });
      expect(planner).toHaveBeenCalledOnce();
      expect((await f.work()).modelAttempts).toHaveLength(1);
      expect(() => captured!.read(engineeringService)).toThrow("expired");
    });

    it("keeps monotonic planning time inside the original model lease", async () => {
      const f = await engineeringAiFixture(createStore());
      const owner = await f.claim();
      const binding = await f.modelBinding(owner);
      const before = await f.rows();
      let monotonic = performance.now();
      const now = vi
        .spyOn(performance, "now")
        .mockImplementation(() => monotonic);
      try {
        await expect(
          workerPorts(f).plan(
            engineeringService,
            owner.fence,
            async (scope) => {
              scope.read(engineeringService);
              monotonic +=
                Date.parse(owner.leaseUntil) - Date.parse(f.clock.now()) + 1;
              return binding;
            },
          ),
        ).rejects.toThrow(/claim|deadline/u);
        expect(await f.rows()).toEqual(before);
      } finally {
        now.mockRestore();
      }
    });

    it.each(["epoch", "withdraw", "reopen", "permission"] as const)(
      "does not commit a plan after %s changes during planning",
      async (change) => {
        const f = await engineeringAiFixture(createStore());
        if (change === "reopen")
          await f.app.resolveTicket(
            engineeringStaff,
            f.command("resolved-before-model-plan"),
          );
        const owner = await f.claim();
        const binding = await f.modelBinding(owner);
        const actor = {
          ...engineeringService,
          permissions: [...engineeringService.permissions],
        };
        let after: Awaited<ReturnType<Fixture["rows"]>> | undefined;
        await expect(
          workerPorts(f).plan(actor, owner.fence, async (scope) => {
            scope.read(actor);
            if (change === "epoch")
              await f.app.invalidateEngineeringSource(engineeringStaff, {
                ...f.command("epoch-during-plan"),
                reason: "evidence_revoked",
              });
            else if (change === "withdraw")
              await f.app.withdrawEngineeringSource(engineeringStaff, {
                ...f.command("withdraw-during-plan"),
                reason: "privacy_withdrawal",
              });
            else if (change === "reopen")
              await f.app.reopenTicket(
                engineeringStaff,
                f.command("reopen-during-model-plan"),
              );
            else
              actor.permissions = actor.permissions.filter(
                (p) => p !== supportPermissions.engineeringProcess,
              );
            after = await f.rows();
            return binding;
          }),
        ).rejects.toThrow();
        expect(await f.rows()).toEqual(after);
        expect(f.generate).not.toHaveBeenCalled();
      },
    );

    it("recovers accepted completion with one exact Work read and refuses changed packets or absent permission", async () => {
      const observed = readProbe(createStore());
      const f = await engineeringAiFixture(observed.store);
      const ports = workerPorts(f);
      let command: CompleteEngineeringModelCommand | undefined;
      const engine = createSupportDeskEngineering({
        ...f.baseOptions,
        application: {
          ...f.app,
          async completeEngineeringModelObserved(...args) {
            command = structuredClone(args[1]);
            return ports.complete(...args);
          },
        },
      });
      expect(await engine.processWork(f.nextCommand())).toMatchObject({
        outcome: "candidate",
      });
      if (command === undefined)
        throw new Error("Actual completion command not captured");
      const before = await f.rows();
      const guard = vi.fn(async () => {
        throw new Error("Accepted receipt must bypass proof");
      });
      observed.reads.length = 0;
      await expect(
        ports.complete(engineeringService, command, guard),
      ).resolves.toMatchObject({ status: "candidate" });
      expect(observed.reads).toEqual([
        `engineering-work:${command.sourceGeneration}`,
      ]);
      expect(guard).not.toHaveBeenCalled();
      await expect(
        ports.complete(
          engineeringService,
          { ...command, workerId: "foreign-claim-owner" },
          guard,
        ),
      ).rejects.toThrow();
      await expect(
        ports.complete(
          engineeringService,
          {
            ...command,
            candidate: { ...command.candidate, title: "Changed packet" },
          },
          guard,
        ),
      ).rejects.toThrow();
      await expect(
        ports.complete(
          { ...engineeringService, permissions: [] },
          command,
          guard,
        ),
      ).rejects.toThrow(SupportDeskAuthorizationError);
      expect(await f.rows()).toEqual(before);
    });

    it("leaves the same pending outcome after authorized permanent withdrawal without futile finish writes", async () => {
      const f = await engineeringAiFixture(createStore());
      f.setModel(async () => {
        await f.app.withdrawEngineeringSource(engineeringStaff, {
          ...f.command("withdraw-during-paid-model"),
          reason: "privacy_withdrawal",
        });
        return f.answer();
      });
      const finish = vi.fn(f.app.finishEngineeringWork);
      const engine = createSupportDeskEngineering({
        ...f.baseOptions,
        application: { ...f.app, finishEngineeringWork: finish },
      });
      expect(await engine.processWork(f.nextCommand())).toEqual({
        outcome: "pending",
        stage: "complete",
      });
      expect(finish).not.toHaveBeenCalled();
      expect((await f.source()).state).toBe("withdrawn");
      expect((await f.work()).candidate).toBeUndefined();
      expect(f.generate).toHaveBeenCalledOnce();
      expect(f.reconcile).toHaveBeenCalledWith(expect.anything(), {
        state: "known",
        usage: f.answer().usage,
      });
    });

    it("keeps an unavailable recovery read unknown rather than interpreting it as withdrawal", async () => {
      const f = await engineeringAiFixture(createStore());
      const finish = vi.fn(f.app.finishEngineeringWork);
      const engine = createSupportDeskEngineering({
        ...f.baseOptions,
        application: {
          ...f.app,
          async completeEngineeringModelObserved() {
            throw new Error("Synthetic completion unavailable before commit");
          },
          async readEngineeringSource() {
            throw new Error("Synthetic current source unavailable");
          },
          finishEngineeringWork: finish,
        },
      });
      expect(await engine.processWork(f.nextCommand())).toEqual({
        outcome: "pending",
        stage: "complete",
      });
      expect(finish).not.toHaveBeenCalled();
      expect((await f.source()).state).toBe("eligible");
      expect((await f.work()).candidate).toBeUndefined();
      expect(f.generate).toHaveBeenCalledOnce();
    });

    it.each(["proposal", "dispatch"] as const)(
      "replays only the exact observed %s packet after a committed ACK loss",
      async (phase) => {
        const f = await engineeringAiFixture(createStore());
        if (phase === "proposal")
          expect(
            await f.engineering.processWork(f.nextCommand()),
          ).toMatchObject({ outcome: "candidate" });
        else {
          await f.prepareProposal();
          await f.approve();
        }
        const ports = workerPorts(f);
        const commands: unknown[] = [];
        const engine = createSupportDeskEngineering({
          ...f.baseOptions,
          application: {
            ...f.app,
            async prepareEngineeringProposalObserved(...args) {
              commands.push(structuredClone(args[1]));
              const result = await ports.proposal(...args);
              if (commands.length === 1) {
                f.resolveConfiguration.mockResolvedValue({
                  outcome: "unavailable",
                });
                throw new Error("Synthetic prepared-proposal ACK loss");
              }
              return result;
            },
            async beginEngineeringDispatchObserved(...args) {
              commands.push(structuredClone(args[1]));
              const result = await ports.begin(...args);
              if (commands.length === 1)
                throw new Error(
                  "Synthetic dispatch-permit ACK loss before any POST",
                );
              return result;
            },
          },
        });
        expect(await engine.processWork(f.nextCommand())).toMatchObject({
          outcome: phase === "proposal" ? "prepared" : "dispatched",
        });
        expect(commands).toHaveLength(2);
        expect(commands[1]).toEqual(commands[0]);
        expect(f.createIssue).toHaveBeenCalledTimes(
          phase === "proposal" ? 0 : 1,
        );
        expect(f.generate).toHaveBeenCalledOnce();
        const work = await f.work();
        expect(work.proposalCount).toBe(1);
        if (phase === "dispatch")
          expect((await f.source()).destinations).toHaveLength(1);
      },
    );

    it("rebuilds the proposal observation after a genuine Work CAS conflict without repeating the provider", async () => {
      const backing = createStore();
      const f = await engineeringAiFixture(backing);
      expect(await f.engineering.processWork(f.nextCommand())).toMatchObject({
        outcome: "candidate",
      });
      const ports = workerPorts(f);
      const scopes: EngineeringWorkerObservation[] = [];
      const engine = createSupportDeskEngineering({
        ...f.baseOptions,
        application: {
          ...f.app,
          async prepareEngineeringProposalObserved(access, command, guard) {
            return ports.proposal(access, command, async (scope) => {
              scopes.push(scope);
              const result = await guard(scope);
              if (scopes.length === 1)
                await advanceVersion(
                  backing,
                  `engineering-work:${command.sourceGeneration}`,
                );
              return result;
            });
          },
        },
      });
      expect(await engine.processWork(f.nextCommand())).toMatchObject({
        outcome: "prepared",
      });
      expect(scopes).toHaveLength(2);
      expect(scopes[0]).not.toBe(scopes[1]);
      for (const scope of scopes) {
        await expect(scope.confirm(engineeringService)).rejects.toThrow(
          "expired",
        );
        await expect(scope.verifyApplication()).rejects.toThrow("expired");
      }
      expect((await f.work()).proposalCount).toBe(1);
      expect(f.generate).toHaveBeenCalledOnce();
      expect(f.createIssue).not.toHaveBeenCalled();
    });

    it("uses a new authorized post-start scope and closes both dispatch observations", async () => {
      const f = await engineeringAiFixture(createStore());
      await f.prepareProposal();
      await f.approve();
      const ports = workerPorts(f);
      const scopes: EngineeringWorkerObservation[] = [];
      const generations: number[] = [];
      const engine = createSupportDeskEngineering({
        ...f.baseOptions,
        application: {
          ...f.app,
          async beginEngineeringDispatchObserved(access, command, guard) {
            return ports.begin(access, command, async (scope) => {
              if (scopes.length > 0)
                await expect(scopes[0]!.confirm(access)).rejects.toThrow(
                  "expired",
                );
              await scope.confirm(access);
              generations.push(scope.read(access).work.workGeneration);
              scopes.push(scope);
              return guard(scope);
            });
          },
        },
      });
      expect(await engine.processWork(f.nextCommand())).toMatchObject({
        outcome: "dispatched",
      });
      expect(scopes.map((s) => s.phase)).toEqual([
        "before_dispatch",
        "after_dispatch",
      ]);
      expect(generations[1]).toBeGreaterThan(generations[0]!);
      for (const scope of scopes) {
        await expect(scope.confirm(engineeringService)).rejects.toThrow(
          "expired",
        );
        await expect(scope.verifyApplication()).rejects.toThrow("expired");
      }
      expect(f.createIssue).toHaveBeenCalledOnce();
    });

    it.each(["withdraw", "policy", "role", "checks", "metadata"] as const)(
      "withholds the POST after actual post-start %s loss during metadata",
      async (change) => {
        const f = await engineeringAiFixture(createStore());
        await f.prepareProposal();
        await f.approve();
        const metadata = f.getMetadata.getMockImplementation()!;
        let changed = false;
        f.getMetadata.mockImplementation(async (...args) => {
          const value = await metadata(...args);
          const work = await f.work();
          if (work.dispatch !== undefined && !changed) {
            changed = true;
            if (change === "withdraw")
              await f.app.withdrawEngineeringSource(engineeringStaff, {
                ...f.command("post-start-withdraw"),
                reason: "privacy_withdrawal",
              });
            else if (change === "policy") await f.putPolicy({ enabled: false });
            else if (change === "role")
              f.state.authority = {
                ...f.state.authority,
                access: {
                  ...f.state.authority.access,
                  permissions: f.state.authority.access.permissions.filter(
                    (p) => p !== supportPermissions.engineeringProcess,
                  ),
                },
              };
            else if (change === "checks")
              f.trust.revokeChecks(work.proposal!.checksReceipt);
            else
              f.trust.metadata.set(
                work.proposal!.request.repository.repositoryId,
                {
                  ...work.proposal!.request.repository,
                  owner: "different-current-owner",
                  metadataVersion: "changed-after-start",
                },
              );
          }
          return value;
        });
        const result = await f.engineering.processWork(f.nextCommand());
        expect(changed).toBe(true);
        expect(["pending", "held"]).toContain(result.outcome);
        expect(f.createIssue).not.toHaveBeenCalled();
        const work = await f.work();
        expect(work.dispatch).toBeDefined();
        expect(work.acknowledgement).toBeUndefined();
        expect(f.generate).toHaveBeenCalledOnce();
      },
    );

    it("keeps fresh Source confirmation after the last post-start policy await", async () => {
      const f = await engineeringAiFixture(createStore());
      await f.prepareProposal();
      await f.approve();
      const barrier = engineeringBarrier();
      let postMetadata = false;
      let captured = false;
      const metadata = f.getMetadata.getMockImplementation()!;
      f.getMetadata.mockImplementation(async (...args) => {
        const result = await metadata(...args);
        if ((await f.work()).dispatch !== undefined) postMetadata = true;
        return result;
      });
      const engine = createSupportDeskEngineering({
        ...f.baseOptions,
        policy: {
          async resolve(access) {
            const value = await f.baseOptions.policy.resolve(access);
            if (postMetadata && !captured) {
              captured = true;
              await barrier.wait();
            }
            return value;
          },
        },
      });
      const pending = engine.processWork(f.nextCommand());
      await Promise.race([
        barrier.reached,
        pending.then((r) => {
          throw new Error(
            `Post-start policy hook not reached: ${JSON.stringify(r)}`,
          );
        }),
      ]);
      await f.app.replyToCustomerTicket(engineeringCustomer, {
        ...f.command("visible-source-after-final-policy"),
        messageId: "updated-source",
        body: "The verified reproduction changed.",
      });
      barrier.release();
      expect((await pending).outcome).toBe("pending");
      expect(f.createIssue).not.toHaveBeenCalled();
    });

    it.each(["before_dispatch", "after_dispatch"] as const)(
      "keeps the final proof deadline at the %s handoff",
      async (phase) => {
        const f = await engineeringAiFixture(createStore());
        await f.prepareProposal();
        await f.approve();
        const ports = workerPorts(f);
        const engine = createSupportDeskEngineering({
          ...f.baseOptions,
          application: {
            ...f.app,
            async beginEngineeringDispatchObserved(access, command, guard) {
              return ports.begin(access, command, async (scope) => {
                const proof = await guard(scope);
                if (scope.phase === phase) f.advance(30001);
                return proof;
              });
            },
          },
        });
        await engine.processWork(f.nextCommand());
        expect(f.createIssue).not.toHaveBeenCalled();
        expect((await f.work()).dispatch === undefined).toBe(
          phase === "before_dispatch",
        );
      },
    );
  });
}
