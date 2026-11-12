import type {
  CollectionDefinition,
  EntityKey,
  Store,
} from "@pegma/storage-core";
import {
  SupportDeskAuthorizationError,
  supportPermissions,
  supportRecords,
  type EngineeringModelObservation,
  type PrepareEngineeringModelCommand,
  type CompleteEngineeringModelCommand,
} from "@pegma/support-desk-application";
import { createSupportDeskEngineering } from "@pegma/support-desk-ai";
import { describe, expect, it, vi } from "vitest";
import {
  engineeringAiFixture,
  engineeringService,
  engineeringStaff,
  engineeringStores,
} from "../test/engineering-fixtures.js";

type Read = { method: string; id?: string };
function observe(backing: Store) {
  const reads: Read[] = [];
  let intercept: ((read: Read) => void | Promise<void>) | undefined;
  const store: Store = {
    collection<T>(definition: CollectionDefinition<T>) {
      const target = backing.collection(definition);
      if (definition.name !== supportRecords.name) return target;
      return new Proxy(target, {
        get(object, property) {
          const value: unknown = Reflect.get(object, property, object);
          if (
            ["get", "getVersioned", "list"].includes(String(property)) &&
            typeof value === "function"
          )
            return (...args: unknown[]) => {
              const read = {
                method: String(property),
                ...(typeof args[0] === "object" &&
                args[0] !== null &&
                "id" in args[0]
                  ? { id: String(args[0].id) }
                  : {}),
              };
              reads.push(read);
              const pending = intercept?.(read);
              return pending === undefined
                ? Reflect.apply(value, object, args)
                : pending.then(() => Reflect.apply(value, object, args));
            };
          return typeof value === "function" ? value.bind(object) : value;
        },
      });
    },
  };
  return {
    store,
    reads,
    intercept(hook?: typeof intercept) {
      intercept = hook;
    },
  };
}
type Fixture = Awaited<ReturnType<typeof engineeringAiFixture>>;
async function preparation(f: Fixture) {
  const owner = await f.claim();
  const command: PrepareEngineeringModelCommand = {
    ...owner.fence,
    binding: await f.modelBinding(owner),
  };
  return { owner, command };
}
async function completion(f: Fixture) {
  const prepared = await preparation(f);
  const result = await f.app.prepareEngineeringModel(
    engineeringService,
    prepared.command,
  );
  const command: CompleteEngineeringModelCommand = {
    ...prepared.owner.fence,
    stepId: result.stepId,
    requestHash: result.requestHash,
    candidate: f.assessment(),
    accounting: "accounted",
  };
  return { ...prepared, complete: command };
}
async function advanceVersion(store: Store, key: EntityKey) {
  const records = store.collection(supportRecords);
  const row = await records.getVersioned(key);
  if (row === null) throw new Error("Actual model row missing");
  expect(await records.putIfUnchanged(row.value, row.version)).toBe(true);
}
function observedPorts(f: Fixture) {
  const prepare = f.app.prepareEngineeringModelObserved;
  const complete = f.app.completeEngineeringModelObserved;
  if (prepare === undefined || complete === undefined)
    throw new Error("Actual application model observation ports missing");
  return { prepare, complete };
}

for (const [name, createStore] of engineeringStores) {
  describe(`model operation observations (${name})`, () => {
    it("reduces protected rehydration while preserving all authority callbacks and the legacy structural fallback", async () => {
      const results = [];
      for (const legacy of [false, true]) {
        const observed = observe(createStore());
        const f = await engineeringAiFixture(observed.store);
        const {
          prepareEngineeringModelObserved: _prepare,
          completeEngineeringModelObserved: _complete,
          ...original
        } = f.app;
        const engine = createSupportDeskEngineering({
          ...f.baseOptions,
          application: legacy ? original : f.app,
        });
        observed.reads.length = 0;
        f.resolveAuthority.mockClear();
        expect(await engine.processWork(f.nextCommand())).toMatchObject({
          outcome: "candidate",
        });
        expect(f.generate).toHaveBeenCalledOnce();
        expect(f.reserve).toHaveBeenCalledOnce();
        expect(f.reconcile).toHaveBeenCalledWith(expect.anything(), {
          state: "known",
          usage: f.answer().usage,
        });
        results.push({
          source: observed.reads.filter((r) => r.id === "engineering-source")
            .length,
          work: observed.reads.filter((r) => r.id === "engineering-work:1")
            .length,
          ticket: observed.reads.filter((r) => r.id === "ticket").length,
          authority: f.resolveAuthority.mock.calls.length,
          candidate: (await f.work()).candidate,
        });
      }
      expect(results[0]).toMatchObject({ source: 8, work: 6, ticket: 5 });
      expect(results[1]).toMatchObject({ source: 10, work: 8, ticket: 7 });
      expect(results[0]!.authority).toBe(results[1]!.authority);
      expect(results[0]!.candidate).toEqual(results[1]!.candidate);
    });

    it("keeps caller-owned model deadlines instead of imposing the remote-verifier timeout", async () => {
      const f = await engineeringAiFixture(createStore());
      const { owner, command } = await preparation(f);
      const ports = observedPorts(f);
      const guard = async (scope: EngineeringModelObservation) => {
        // The remote-verifier default is 250ms; this remains inside the real 30s model lease.
        await new Promise<void>((resolve) => setTimeout(resolve, 350));
        await scope.confirm(engineeringService);
        scope.read(engineeringService);
      };
      const prepared = await ports.prepare(engineeringService, command, guard);
      await expect(
        ports.complete(
          engineeringService,
          {
            ...owner.fence,
            stepId: prepared.stepId,
            requestHash: prepared.requestHash,
            candidate: f.assessment(),
            accounting: "accounted",
          },
          guard,
        ),
      ).resolves.toMatchObject({ status: "candidate" });
    });

    it("requires fresh confirmation, consumes each read, binds the original actor and closes the scope", async () => {
      const f = await engineeringAiFixture(createStore());
      const { command } = await preparation(f);
      let captured: EngineeringModelObservation | undefined;
      await observedPorts(f).prepare(
        engineeringService,
        command,
        async (scope) => {
          captured = scope;
          expect(() => scope.read(engineeringService)).toThrow("confirmation");
          expect(() =>
            scope.read({
              ...engineeringService,
              principalId: "foreign-service",
            }),
          ).toThrow(SupportDeskAuthorizationError);
          await scope.confirm(engineeringService);
          expect(scope.read(engineeringService).source.state).toBe("eligible");
          expect(() => scope.read(engineeringService)).toThrow("confirmation");
          return (): true => true;
        },
      );
      expect(() => captured!.read(engineeringService)).toThrow("expired");
      await expect(captured!.confirm(engineeringService)).rejects.toThrow(
        "expired",
      );
    });

    it.each(["prepare", "complete"] as const)(
      "rejects %s when source privacy changes before the guarded wave",
      async (phase) => {
        const observed = observe(createStore());
        const f = await engineeringAiFixture(observed.store);
        const { command, complete } = await completion(f);
        await f.app.withdrawEngineeringSource(engineeringStaff, {
          ...f.command("privacy-before-model-wave"),
          reason: "privacy_withdrawal",
        });
        const before = await f.rows();
        observed.reads.length = 0;
        const guard = vi.fn(async () => {});
        const ports = observedPorts(f);
        await expect(
          phase === "prepare"
            ? ports.prepare(engineeringService, command, guard)
            : ports.complete(engineeringService, complete, guard),
        ).rejects.toThrow();
        expect(guard).not.toHaveBeenCalled();
        expect(observed.reads.some((r) => r.method === "list")).toBe(false);
        expect(await f.rows()).toEqual(before);
        expect(f.generate).not.toHaveBeenCalled();
      },
    );

    it.each(["list", "work", "both"] as const)(
      "observes every %s failure and keeps list-first priority without a mutation",
      async (failure) => {
        const observed = observe(createStore());
        const f = await engineeringAiFixture(observed.store);
        const { command } = await preparation(f);
        const before = await f.rows();
        const listError = new Error("synthetic bounded list failed");
        const workError = new Error("synthetic exact Work failed");
        observed.reads.length = 0;
        observed.intercept((read) => {
          if (read.method === "list" && failure !== "work") throw listError;
          if (read.id === "engineering-work:1" && failure !== "list")
            throw workError;
        });
        const guard = vi.fn(async () => {});
        await expect(
          observedPorts(f).prepare(engineeringService, command, guard),
        ).rejects.toBe(failure === "work" ? workError : listError);
        expect(observed.reads.some((r) => r.method === "list")).toBe(true);
        expect(observed.reads.some((r) => r.id === "engineering-work:1")).toBe(
          true,
        );
        expect(guard).not.toHaveBeenCalled();
        observed.intercept();
        expect(await f.rows()).toEqual(before);
      },
    );

    it("keeps the real whole-partition capacity failure ahead of an exact Work read failure", async () => {
      const backing = createStore();
      const observed = observe(backing);
      const f = await engineeringAiFixture(observed.store, {
        limits: { maxRecordsPerTicket: 64 },
      });
      const { command } = await preparation(f);
      const records = backing.collection(supportRecords);
      const work = await records.get({
        partition: "ticket",
        id: "engineering-work:1",
      });
      if (work?.kind !== "engineering_work")
        throw new Error("Actual Work missing");
      for (let index = 0; index < 65; index += 1)
        await records.put({
          ...work,
          id: `engineering-work:${index + 100}`,
          sourceGeneration: index + 100,
          ...(work.claim === undefined
            ? {}
            : { claim: { ...work.claim, sourceGeneration: index + 100 } }),
        });
      const before = await f.rows();
      const workError = new Error(
        "Synthetic competing exact Work read failure",
      );
      observed.intercept((read) => {
        if (read.id === "engineering-work:1") throw workError;
      });
      await expect(
        observedPorts(f).prepare(engineeringService, command, async () => {}),
      ).rejects.toMatchObject({ field: "ticket_partition", maximum: 64 });
      observed.intercept();
      expect(await f.rows()).toEqual(before);
    });

    it("checks read authority again after the bounded list settles", async () => {
      const observed = observe(createStore());
      const f = await engineeringAiFixture(observed.store);
      const { command } = await preparation(f);
      const actor = {
        ...engineeringService,
        permissions: [...engineeringService.permissions],
      };
      const before = await f.rows();
      observed.intercept(async (read) => {
        if (read.method === "list")
          actor.permissions = actor.permissions.filter(
            (p) => p !== supportPermissions.engineeringRead,
          );
      });
      const guard = vi.fn(async () => {});
      await expect(
        observedPorts(f).prepare(actor, command, guard),
      ).rejects.toThrow(SupportDeskAuthorizationError);
      expect(guard).not.toHaveBeenCalled();
      observed.intercept();
      expect(await f.rows()).toEqual(before);
    });

    for (const phase of ["prepare", "complete"] as const) {
      it.each(["engineering-source", "engineering-work:1"])(
        `denies an opaque %s change after ${phase} external proof`,
        async (id) => {
          const backing = createStore();
          const f = await engineeringAiFixture(backing);
          const { command, complete } = await completion(f);
          let afterChange: Awaited<ReturnType<Fixture["rows"]>> | undefined;
          const guard = async (scope: EngineeringModelObservation) => {
            await advanceVersion(backing, { partition: "ticket", id });
            afterChange = await f.rows();
            await scope.confirm(engineeringService);
          };
          const ports = observedPorts(f);
          await expect(
            phase === "prepare"
              ? ports.prepare(engineeringService, command, guard)
              : ports.complete(engineeringService, complete, guard),
          ).rejects.toThrow("changed");
          expect(afterChange).toBeDefined();
          expect(await f.rows()).toEqual(afterChange);
        },
      );
    }

    it("takes a new callback scope after a genuine Ticket CAS conflict", async () => {
      const backing = createStore();
      const f = await engineeringAiFixture(backing);
      const { command } = await preparation(f);
      const scopes: EngineeringModelObservation[] = [];
      await observedPorts(f).prepare(
        engineeringService,
        command,
        async (scope) => {
          scopes.push(scope);
          await scope.confirm(engineeringService);
          scope.read(engineeringService);
          if (scopes.length === 1)
            await advanceVersion(backing, {
              partition: "ticket",
              id: "ticket",
            });
        },
      );
      expect(scopes).toHaveLength(2);
      expect(scopes[0]).not.toBe(scopes[1]);
      for (const scope of scopes)
        await expect(scope.confirm(engineeringService)).rejects.toThrow(
          "expired",
        );
      expect((await f.work()).modelAttempts).toHaveLength(1);
    });

    it("recovers an exact accepted completion after withdrawal and read-grant loss without new proof", async () => {
      const f = await engineeringAiFixture(createStore());
      const { complete } = await completion(f);
      const ports = observedPorts(f);
      const accepted = await ports.complete(
        engineeringService,
        complete,
        async (scope) => {
          await scope.confirm(engineeringService);
          scope.read(engineeringService);
        },
      );
      await f.app.withdrawEngineeringSource(engineeringStaff, {
        ...f.command("withdraw-after-accepted-model"),
        reason: "privacy_withdrawal",
      });
      await f.putPolicy({ enabled: false });
      const before = await f.rows();
      const guard = vi.fn(async () => {
        throw new Error("Accepted receipt must bypass proof");
      });
      await expect(
        ports.complete(
          {
            ...engineeringService,
            permissions: [supportPermissions.engineeringProcess],
          },
          complete,
          guard,
        ),
      ).resolves.toEqual({
        ticketId: complete.ticketId,
        sourceGeneration: complete.sourceGeneration,
        workGeneration: accepted.workGeneration + 1,
        status: "held",
        stepId: complete.stepId,
        requestHash: complete.requestHash,
      });
      expect(guard).not.toHaveBeenCalled();
      expect(await f.rows()).toEqual(before);
    });

    it.each(["prepare", "complete"] as const)(
      "replays only the exact observed %s command after its committed ACK is lost",
      async (phase) => {
        const f = await engineeringAiFixture(createStore());
        const ports = observedPorts(f);
        const preparations: PrepareEngineeringModelCommand[] = [];
        const completions: CompleteEngineeringModelCommand[] = [];
        const engine = createSupportDeskEngineering({
          ...f.baseOptions,
          application: {
            ...f.app,
            async prepareEngineeringModelObserved(...args) {
              preparations.push(structuredClone(args[1]));
              const result = await ports.prepare(...args);
              if (phase === "prepare" && preparations.length === 1)
                throw new Error("Synthetic observed preparation ACK loss");
              return result;
            },
            async completeEngineeringModelObserved(...args) {
              completions.push(structuredClone(args[1]));
              const result = await ports.complete(...args);
              if (phase === "complete" && completions.length === 1)
                throw new Error("Synthetic observed completion ACK loss");
              return result;
            },
          },
        });
        expect(await engine.processWork(f.nextCommand())).toMatchObject({
          outcome: "candidate",
        });
        expect(preparations.length).toBe(phase === "prepare" ? 3 : 2);
        expect(
          preparations.every(
            (command) =>
              JSON.stringify(command) === JSON.stringify(preparations[0]),
          ),
        ).toBe(true);
        expect(completions.length).toBe(phase === "complete" ? 2 : 1);
        expect(
          completions.every(
            (command) =>
              JSON.stringify(command) === JSON.stringify(completions[0]),
          ),
        ).toBe(true);
        expect(f.generate).toHaveBeenCalledOnce();
        expect(f.reserve).toHaveBeenCalledOnce();
        expect((await f.work()).modelAttempts).toHaveLength(1);
        expect((await f.work()).candidate).toEqual(f.assessment());
      },
    );

    it("carries a synchronous minimum-deadline assertion through the final application await", async () => {
      const f = await engineeringAiFixture(createStore());
      const { complete } = await completion(f);
      const before = await f.rows();
      await expect(
        observedPorts(f).complete(
          engineeringService,
          complete,
          async (scope) => {
            await scope.confirm(engineeringService);
            scope.read(engineeringService);
            return (): true => {
              throw new Error("Synthetic final proof deadline expired");
            };
          },
        ),
      ).rejects.toThrow("Synthetic final proof deadline expired");
      expect(await f.rows()).toEqual(before);
    });
  });
}
