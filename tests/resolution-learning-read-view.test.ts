import {
  StorageError,
  type CollectionDefinition,
  type EntityKey,
  type StoredRecord,
  type Store,
} from "@pegma/storage-core";
import {
  SupportDeskAuthorizationError,
  SupportDeskConflictError,
  SupportDeskLimitError,
  SupportDeskNotFoundError,
  supportPermissions,
  supportRecords,
  type ResolutionLearningSourceRecord,
  type ResolutionSourceFence,
  type SupportRecord,
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

/** Copy encoded bytes at a different real backend key, without faking a read. */
async function copyAtKey(backing: Store, key: EntityKey, value: SupportRecord) {
  const physical = backing.collection<StoredRecord>({
    name: supportRecords.name,
    key: () => key,
    codec: {
      encode: (record) => record,
      decode: (record) => record,
    },
  });
  await physical.put(supportRecords.codec.encode(value));
}

function readCalls(sourceGeneration?: number): ReadCall[] {
  return [
    { operation: "getVersioned", partition: "ticket", id: "ticket" },
    { operation: "getVersioned", partition: "ticket", id: "learning-source" },
    { operation: "listVersioned", partition: "ticket" },
    ...(sourceGeneration === undefined
      ? []
      : [
          {
            operation: "get" as const,
            partition: "ticket",
            id: `resolution-learning:${sourceGeneration}`,
          },
        ]),
  ];
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
      "groups exact-key %s reads with one capacity observation and retains the final source fence",
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
          expect(observed.calls).toEqual(readCalls());
        } else if (operation === "work") {
          expect(
            await f.app.readResolutionLearningWork(staff, {
              ticketId: "ticket",
              sourceGeneration: source.sourceGeneration,
            }),
          ).toEqual(work);
          expect(observed.calls).toEqual(readCalls(source.sourceGeneration));
        } else {
          expect(
            await f.app.confirmResolutionLearningSource(service, fence(source)),
          ).toBe(true);
          expect(observed.calls).toEqual([
            ...readCalls(),
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

    it("propagates a real partition-read failure without a fallback observation or write", async () => {
      const observed = observeReads(createStore());
      const f = resolutionLearningFixture(observed.store);
      await f.terminal();
      const { source } = await f.confirm();
      const before = await f.rows();
      const transactions = f.observed.transactions.length;
      for (const { read, work } of [
        {
          read: () => f.app.readResolutionLearningSource(staff, "ticket"),
          work: false,
        },
        {
          read: () =>
            f.app.readResolutionLearningWork(staff, {
              ticketId: "ticket",
              sourceGeneration: source.sourceGeneration,
            }),
          work: true,
        },
        {
          read: () =>
            f.app.confirmResolutionLearningSource(service, fence(source)),
          work: false,
        },
      ]) {
        const failure = new StorageError(
          "Synthetic partition response was lost",
        );
        observed.calls.length = 0;
        // The backend performs the actual read; only its returned response is
        // lost. Do not replace it with a successful domain result.
        observed.afterNextPartitionRead(async () => {
          throw failure;
        });
        await expect(read()).rejects.toBe(failure);
        expect(observed.calls).toEqual(
          readCalls(work ? source.sourceGeneration : undefined),
        );
        expect(f.observed.transactions).toHaveLength(transactions);
        expect(await f.rows()).toEqual(before);
      }
    });

    it.each(["ticket", "source", "work"] as const)(
      "does not accept a copied %s payload after its canonical physical row is deleted",
      async (kind) => {
        const backing = createStore();
        const f = resolutionLearningFixture(backing);
        await f.terminal();
        const { source } = await f.confirm();
        const records = backing.collection(supportRecords);
        const key = {
          partition: "ticket",
          id:
            kind === "ticket"
              ? "ticket"
              : kind === "source"
                ? "learning-source"
                : `resolution-learning:${source.sourceGeneration}`,
        };
        const canonical = await records.getVersioned(key);
        if (canonical === null)
          throw new Error("Expected the actual canonical row");
        await copyAtKey(
          backing,
          { partition: "ticket", id: `orphan-${kind}` },
          canonical.value,
        );
        expect(await records.deleteIfUnchanged(key, canonical.version)).toBe(
          true,
        );
        expect(await records.getVersioned(key)).toBeNull();
        const before = await f.rows();
        expect(before.some((row) => row.id === key.id)).toBe(true);

        await expect(
          f.app.readResolutionLearningWork(staff, {
            ticketId: "ticket",
            sourceGeneration: source.sourceGeneration,
          }),
        ).rejects.toBeInstanceOf(SupportDeskNotFoundError);
        if (kind !== "work") {
          await expect(
            f.app.readResolutionLearningSource(staff, "ticket"),
          ).rejects.toBeInstanceOf(SupportDeskNotFoundError);
          expect(
            await f.app.confirmResolutionLearningSource(service, fence(source)),
          ).toBe(false);
        } else {
          expect(
            await f.app.readResolutionLearningSource(staff, "ticket"),
          ).toEqual(source);
          expect(
            await f.app.confirmResolutionLearningSource(service, fence(source)),
          ).toBe(true);
        }
        expect(await f.rows()).toEqual(before);
      },
    );

    it.each(["duplicate-id", "foreign-partition"] as const)(
      "rejects a real stored %s observation without writing",
      async (corruption) => {
        const backing = createStore();
        const f = resolutionLearningFixture(backing);
        await f.terminal();
        const { source } = await f.confirm();
        const message = (await f.rows()).find((row) => row.kind === "message");
        if (message === undefined || message.kind !== "message")
          throw new Error("Expected an actual message row");
        const value =
          corruption === "duplicate-id"
            ? message
            : {
                ...message,
                partition: "foreign-ticket",
                id: "foreign-message",
              };
        await copyAtKey(
          backing,
          { partition: "ticket", id: "corrupted-message-envelope" },
          value,
        );
        const before = await f.rows();
        for (const read of [
          () => f.app.readResolutionLearningSource(staff, "ticket"),
          () =>
            f.app.readResolutionLearningWork(staff, {
              ticketId: "ticket",
              sourceGeneration: source.sourceGeneration,
            }),
          () => f.app.confirmResolutionLearningSource(service, fence(source)),
        ]) {
          await expect(read()).rejects.toBeInstanceOf(SupportDeskConflictError);
        }
        expect(await f.rows()).toEqual(before);
      },
    );

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
