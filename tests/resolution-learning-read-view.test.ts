import type {
  CollectionDefinition,
  EntityKey,
  Store,
} from "@pegma/storage-core";
import {
  SupportDeskAuthorizationError,
  SupportDeskLimitError,
  SupportDeskNotFoundError,
  supportPermissions,
  supportRecords,
  type ResolutionLearningSourceRecord,
  type ResolutionSourceFence,
} from "@pegma/support-desk-application";
import { describe, expect, it } from "vitest";
import { handlingBarrier } from "../test/handling-fixtures.js";
import {
  learningCustomer as customer,
  learningService as service,
  learningStaff as staff,
  learningStores,
  resolutionLearningFixture,
} from "../test/resolution-learning-fixtures.js";

interface ReadCall {
  readonly operation: "get" | "getVersioned" | "list" | "listVersioned";
  readonly partition: string;
  readonly id?: string;
}

/** Observe real Store reads and pause a returned observation, never replace it. */
function observeReads(backing: Store) {
  const calls: ReadCall[] = [];
  let afterPartition: (() => Promise<void>) | undefined;
  const store: Store = {
    collection<T>(definition: CollectionDefinition<T>) {
      const actual = backing.collection(definition);
      if (definition.name !== supportRecords.name) return actual;
      return new Proxy(actual, {
        get(target, property) {
          if (property === "get" || property === "getVersioned")
            return async (key: EntityKey) => {
              calls.push({ operation: property, ...key });
              return property === "get"
                ? target.get(key)
                : target.getVersioned(key);
            };
          if (property === "list" || property === "listVersioned")
            return async (partition: string) => {
              calls.push({ operation: property, partition });
              const value =
                property === "list"
                  ? await target.list(partition)
                  : await target.listVersioned(partition);
              const pause = afterPartition;
              afterPartition = undefined;
              await pause?.();
              return value;
            };
          const value: unknown = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  };
  return {
    store,
    calls,
    afterNextPartitionRead(callback: () => Promise<void>) {
      if (afterPartition !== undefined)
        throw new Error("A real partition observation is already held");
      afterPartition = callback;
    },
  };
}

function fence(source: ResolutionLearningSourceRecord): ResolutionSourceFence {
  if (source.sourceBindingHash === undefined)
    throw new Error("Expected an actual eligible source binding");
  return {
    ticketId: source.ticketId,
    sourceGeneration: source.sourceGeneration,
    resolutionCycle: source.resolutionCycle,
    sourceBindingHash: source.sourceBindingHash,
  };
}

async function reached(
  gate: ReturnType<typeof handlingBarrier>,
  pending: Promise<unknown>,
) {
  await Promise.race([
    gate.reached,
    pending.then(
      () => {
        throw new Error("Source confirmation skipped its real partition read");
      },
      (error: unknown) => {
        throw error;
      },
    ),
  ]);
}

for (const [name, createStore] of learningStores) {
  describe(`versioned learning read views (${name})`, () => {
    it.each(["source", "work", "confirmation"] as const)(
      "reads %s from one whole-partition observation and retains the final source fence",
      async (operation) => {
        const backing = createStore();
        const observed = observeReads(backing);
        const f = resolutionLearningFixture(observed.store);
        await f.terminal();
        const accepted = await f.confirm();
        const source = accepted.source;
        const work = await f.work();
        const before = await f.rows();
        observed.calls.length = 0;

        if (operation === "source") {
          expect(
            await f.app.readResolutionLearningSource(staff, "ticket"),
          ).toEqual(source);
          expect(observed.calls).toEqual([
            { operation: "listVersioned", partition: "ticket" },
          ]);
        } else if (operation === "work") {
          expect(
            await f.app.readResolutionLearningWork(staff, {
              ticketId: "ticket",
              sourceGeneration: source.sourceGeneration,
            }),
          ).toEqual(work);
          expect(observed.calls).toEqual([
            { operation: "listVersioned", partition: "ticket" },
          ]);
        } else {
          expect(
            await f.app.confirmResolutionLearningSource(service, fence(source)),
          ).toBe(true);
          expect(observed.calls).toEqual([
            { operation: "listVersioned", partition: "ticket" },
            {
              operation: "getVersioned",
              partition: "ticket",
              id: "learning-source",
            },
          ]);
        }
        expect(await f.rows()).toEqual(before);
      },
    );

    it("counts all ticket rows before filtering source and work", async () => {
      const f = resolutionLearningFixture(createStore());
      await f.terminal();
      const { source } = await f.confirm();
      await f.app.addNote(staff, {
        ...f.command("physical-unrelated-note"),
        messageId: "physical-unrelated-note",
        body: "PRIVATE_SYNTHETIC_NOTE",
      });
      const before = await f.rows();
      const bounded = f.freshApplication({
        limits: { maxRecordsPerTicket: before.length - 1 },
      });
      for (const read of [
        () => bounded.readResolutionLearningSource(staff, "ticket"),
        () =>
          bounded.readResolutionLearningWork(staff, {
            ticketId: "ticket",
            sourceGeneration: source.sourceGeneration,
          }),
        () => bounded.confirmResolutionLearningSource(service, fence(source)),
      ]) {
        await expect(read()).rejects.toBeInstanceOf(SupportDeskLimitError);
      }
      expect(await f.rows()).toEqual(before);
    });

    it("keeps compatible legacy message rows in the observed partition", async () => {
      const backing = createStore();
      const f = resolutionLearningFixture(backing);
      await f.terminal();
      const { source } = await f.confirm();
      const records = backing.collection(supportRecords);
      const message = (await f.rows()).find((row) => row.kind === "message");
      if (message === undefined || message.kind !== "message")
        throw new Error("Expected a real application-created message");
      const legacy = structuredClone(message);
      Reflect.deleteProperty(legacy, "ordinal");
      await records.put(legacy);
      const before = await f.rows();

      expect(await f.app.readResolutionLearningSource(staff, "ticket")).toEqual(
        source,
      );
      expect(
        await f.app.readResolutionLearningWork(staff, {
          ticketId: "ticket",
          sourceGeneration: source.sourceGeneration,
        }),
      ).toMatchObject({ sourceGeneration: source.sourceGeneration });
      expect(
        await f.app.confirmResolutionLearningSource(service, fence(source)),
      ).toBe(true);
      expect(await f.rows()).toEqual(before);
    });

    it("denies withdrawn read, queue and process permissions before storage", async () => {
      const observed = observeReads(createStore());
      const f = resolutionLearningFixture(observed.store);
      await f.terminal();
      const { source } = await f.confirm();
      for (const permission of [
        supportPermissions.learningRead,
        supportPermissions.queueRead,
      ]) {
        const denied = {
          ...staff,
          permissions: staff.permissions.filter(
            (entry) => entry !== permission,
          ),
        };
        observed.calls.length = 0;
        await expect(
          f.app.readResolutionLearningSource(denied, "ticket"),
        ).rejects.toBeInstanceOf(SupportDeskAuthorizationError);
        await expect(
          f.app.readResolutionLearningWork(denied, {
            ticketId: "ticket",
            sourceGeneration: source.sourceGeneration,
          }),
        ).rejects.toBeInstanceOf(SupportDeskAuthorizationError);
        expect(observed.calls).toEqual([]);
      }
      observed.calls.length = 0;
      await expect(
        f.app.confirmResolutionLearningSource(
          {
            ...service,
            permissions: service.permissions.filter(
              (entry) => entry !== supportPermissions.learningProcess,
            ),
          },
          fence(source),
        ),
      ).rejects.toBeInstanceOf(SupportDeskAuthorizationError);
      expect(observed.calls).toEqual([]);
    });

    it.each(["reopen", "withdraw", "raw-version", "private-edit"] as const)(
      "rechecks the actual source after a concurrent %s",
      async (change) => {
        const backing = createStore();
        const observed = observeReads(backing);
        const f = resolutionLearningFixture(observed.store);
        await f.terminal();
        const { source } = await f.confirm();
        const gate = handlingBarrier();
        observed.afterNextPartitionRead(() => gate.wait());
        const pending = f.app.confirmResolutionLearningSource(
          service,
          fence(source),
        );
        await reached(gate, pending);
        try {
          if (change === "reopen")
            await f.app.reopenTicket(staff, f.command("concurrent-reopen"));
          else if (change === "withdraw")
            await f.app.withdrawResolutionLearningSource(staff, {
              ...f.command("concurrent-withdraw"),
              reason: "privacy_withdrawal",
            });
          else if (change === "private-edit")
            await f.app.changePriority(staff, {
              ...f.command("concurrent-private-edit"),
              priority: "high",
            });
          else {
            const records = backing.collection(supportRecords);
            const key = { partition: "ticket", id: "learning-source" };
            const current = await records.getVersioned(key);
            if (
              current === null ||
              current.value.kind !== "resolution_learning_source"
            )
              throw new Error("Expected the actual source version");
            expect(
              await records.putIfUnchanged(current.value, current.version),
            ).toBe(true);
            const rewritten = await records.getVersioned(key);
            expect(rewritten?.value).toEqual(current.value);
            expect(rewritten?.version).not.toBe(current.version);
          }
        } finally {
          gate.release();
        }
        expect(await pending).toBe(change === "private-edit");
      },
    );

    it("preserves missing exact ticket, source and work behavior", async () => {
      const backing = createStore();
      const f = resolutionLearningFixture(backing);
      await f.terminal();
      const { source } = await f.confirm();
      await expect(
        f.app.readResolutionLearningSource(staff, "missing"),
      ).rejects.toBeInstanceOf(SupportDeskNotFoundError);
      await expect(
        f.app.readResolutionLearningWork(staff, {
          ticketId: "ticket",
          sourceGeneration: source.sourceGeneration + 1,
        }),
      ).rejects.toBeInstanceOf(SupportDeskNotFoundError);
      expect(
        await f.app.confirmResolutionLearningSource(service, {
          ...fence(source),
          ticketId: "missing",
        }),
      ).toBe(false);

      const records = backing.collection(supportRecords);
      const key = { partition: "ticket", id: "learning-source" };
      const current = await records.getVersioned(key);
      if (current === null) throw new Error("Expected a persisted source");
      expect(await records.deleteIfUnchanged(key, current.version)).toBe(true);
      await expect(
        f.app.readResolutionLearningSource(staff, "ticket"),
      ).rejects.toBeInstanceOf(SupportDeskNotFoundError);
      expect(
        await f.app.confirmResolutionLearningSource(service, fence(source)),
      ).toBe(false);
    });

    it("keeps missing-ticket precedence when an orphan payload cannot be decoded", async () => {
      const backing = createStore();
      const f = resolutionLearningFixture(backing);
      interface EncodedRow {
        readonly partition: string;
        readonly id: string;
        readonly payload: string;
      }
      // Write an actual corrupted encoded row through the real adapter. Domain
      // reads still use supportRecords' real decoder and are never replaced.
      const physical = backing.collection<EncodedRow>({
        name: supportRecords.name,
        key: (value) => ({ partition: value.partition, id: value.id }),
        codec: {
          encode: (value) => ({ ...value }),
          decode(value) {
            if (
              typeof value.partition !== "string" ||
              typeof value.id !== "string" ||
              typeof value.payload !== "string"
            )
              throw new TypeError("Invalid encoded corruption fixture");
            return {
              partition: value.partition,
              id: value.id,
              payload: value.payload,
            };
          },
        },
      });
      const ticketId = "missing-ticket-with-orphan";
      await physical.put({ partition: ticketId, id: "orphan", payload: "{" });
      const before = await physical.list(ticketId);
      await expect(
        backing.collection(supportRecords).list(ticketId),
      ).rejects.toThrow();

      await expect(
        f.app.readResolutionLearningSource(staff, ticketId),
      ).rejects.toBeInstanceOf(SupportDeskNotFoundError);
      await expect(
        f.app.readResolutionLearningWork(staff, {
          ticketId,
          sourceGeneration: 1,
        }),
      ).rejects.toBeInstanceOf(SupportDeskNotFoundError);
      expect(
        await f.app.confirmResolutionLearningSource(service, {
          ticketId,
          sourceGeneration: 1,
          resolutionCycle: 1,
          sourceBindingHash: "a".repeat(64),
        }),
      ).toBe(false);
      expect(await physical.list(ticketId)).toEqual(before);
    });

    it("keeps an accepted evidence receipt exact after reads and reopening", async () => {
      const f = resolutionLearningFixture(createStore());
      await f.terminal();
      const accepted = await f.confirm();
      const { source } = accepted;
      await f.app.readResolutionLearningSource(staff, "ticket");
      await f.app.readResolutionLearningWork(staff, {
        ticketId: "ticket",
        sourceGeneration: source.sourceGeneration,
      });
      await f.app.confirmResolutionLearningSource(service, fence(source));
      await f.app.reopenTicket(staff, f.command("after-accepted-evidence"));
      const before = await f.rows();
      const productCalls = f.trust.productCalls.length;

      await f.app.confirmCustomerSuccess(customer, accepted.command);
      expect(await f.rows()).toEqual(before);
      expect(f.trust.productCalls).toHaveLength(productCalls);
      await expect(
        f.app.confirmCustomerSuccess(
          {
            ...customer,
            permissions: customer.permissions.filter(
              (entry) => entry !== supportPermissions.confirmSuccess,
            ),
          },
          accepted.command,
        ),
      ).rejects.toBeInstanceOf(SupportDeskAuthorizationError);
      expect(await f.rows()).toEqual(before);
    });
  });
}
