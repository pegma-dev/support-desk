import type {
  CollectionDefinition,
  EntityKey,
  Store,
} from "@pegma/storage-core";
import {
  SupportDeskAuthorizationError,
  SupportDeskNotFoundError,
  supportRecords,
  type ReviewEngineeringProposalCommand,
} from "@pegma/support-desk-application";
import { describe, expect, it } from "vitest";
import {
  engineeringAiFixture,
  engineeringBarrier,
  engineeringFixture,
  engineeringService,
  engineeringStaff,
  engineeringStores,
} from "../test/engineering-fixtures.js";

interface Read {
  readonly method: "get" | "getVersioned";
  readonly key: EntityKey;
}

/** Trace and suspend actual public Store reads; never replace stored records. */
function observe(backing: Store) {
  const calls: Read[] = [];
  let afterRead: ((read: Read) => Promise<void>) | undefined;
  const store: Store = {
    collection<T>(definition: CollectionDefinition<T>) {
      const target = backing.collection(definition);
      if (definition.name !== supportRecords.name) return target;
      return new Proxy(target, {
        get(object, property) {
          if (property === "get" || property === "getVersioned")
            return async (key: EntityKey) => {
              const read = { method: property, key } as const;
              calls.push(read);
              const value = await object[property](key);
              await afterRead?.(read);
              return value;
            };
          const value: unknown = Reflect.get(object, property, object);
          return typeof value === "function" ? value.bind(object) : value;
        },
      });
    },
  };
  return {
    calls,
    store,
    afterRead(hook: typeof afterRead) {
      afterRead = hook;
    },
  };
}

for (const [name, createStore] of engineeringStores) {
  describe(`engineering independent read waves (${name})`, () => {
    it.each(["source", "work"] as const)(
      "launches independent exact-key %s hydration before awaiting a returned Source",
      async (operation) => {
        const observed = observe(createStore());
        const f = engineeringFixture(observed.store);
        const key = await f.eligible();
        const barrier = engineeringBarrier();
        observed.calls.length = 0;
        let armed = true;
        observed.afterRead(async (read) => {
          if (!armed || read.key.id !== "engineering-source") return;
          armed = false;
          await barrier.wait();
        });
        const reading =
          operation === "source"
            ? f.app.readEngineeringSource(engineeringStaff, key.ticketId)
            : f.app.readEngineeringWork(engineeringStaff, key);
        await barrier.reached;
        const launched = observed.calls.map((read) => read.key.id).sort();
        barrier.release();
        await reading;
        expect(launched).toEqual(
          operation === "source"
            ? ["engineering-source", "ticket"]
            : [
                "engineering-source",
                `engineering-work:${key.sourceGeneration}`,
                "ticket",
              ],
        );
        expect(observed.calls).toHaveLength(operation === "source" ? 3 : 5);
      },
    );

    it("launches both final opaque-version confirmations in the same later wave", async () => {
      const observed = observe(createStore());
      const f = engineeringFixture(observed.store);
      const key = await f.eligible();
      const barrier = engineeringBarrier();
      observed.calls.length = 0;
      let sources = 0;
      observed.afterRead(async (read) => {
        if (read.key.id === "engineering-source" && ++sources === 2)
          await barrier.wait();
      });
      const reading = f.app.readEngineeringWork(engineeringStaff, key);
      await barrier.reached;
      const launched = observed.calls.map((read) => read.key.id);
      barrier.release();
      await reading;
      expect(
        launched.filter(
          (id) => id === `engineering-work:${key.sourceGeneration}`,
        ),
      ).toHaveLength(2);
      expect(observed.calls).toHaveLength(5);
    });

    it("retains current Source confirmation when real invalidation commits during hydration", async () => {
      const observed = observe(createStore());
      const f = engineeringFixture(observed.store);
      const key = await f.eligible();
      const barrier = engineeringBarrier();
      let armed = true;
      observed.afterRead(async (read) => {
        if (!armed || read.key.id !== "engineering-source") return;
        armed = false;
        await barrier.wait();
      });
      const reading = f.app.readEngineeringWork(engineeringStaff, key);
      await barrier.reached;
      await f.app.invalidateEngineeringSource(engineeringStaff, {
        ...f.command("read-wave-invalidation"),
        reason: "evidence_revoked",
      });
      barrier.release();
      const returned = await reading;
      observed.afterRead(undefined);
      expect(returned).toEqual(
        await f.app.readEngineeringWork(engineeringStaff, key),
      );
      expect(returned.status).toBe("superseded");
    });

    it("keeps Source privacy and existence error priority when a sibling read fails", async () => {
      const backing = createStore();
      const observed = observe(backing);
      const f = engineeringFixture(observed.store);
      const key = await f.eligible(
        "staff_verified_failure",
        "ticket",
        "restricted",
      );
      const failure = new Error("Fictional sibling read unavailable");
      observed.afterRead(async (read) => {
        if (read.key.id.startsWith("engineering-work:")) throw failure;
      });
      await expect(
        f.app.readEngineeringWork(engineeringService, key),
      ).rejects.toBeInstanceOf(SupportDeskAuthorizationError);
      await backing
        .collection(supportRecords)
        .delete({ partition: key.ticketId, id: "engineering-source" });
      await expect(
        f.app.readEngineeringWork(engineeringStaff, key),
      ).rejects.toBeInstanceOf(SupportDeskNotFoundError);
    });

    it.each(["source", "work"] as const)(
      "keeps Source privacy priority when a sibling %s hydration call throws synchronously",
      async (operation) => {
        const backing = createStore();
        let failingKey: string | undefined;
        const failure = new Error("Fictional synchronous Store read failure");
        const store: Store = {
          collection<T>(definition: CollectionDefinition<T>) {
            const target = backing.collection(definition);
            if (definition.name !== supportRecords.name) return target;
            return new Proxy(target, {
              get(object, property) {
                if (property === "get" || property === "getVersioned")
                  return (key: EntityKey) => {
                    if (key.id === failingKey) throw failure;
                    return object[property](key);
                  };
                const value: unknown = Reflect.get(object, property, object);
                return typeof value === "function" ? value.bind(object) : value;
              },
            });
          },
        };
        const f = engineeringFixture(store);
        const key = await f.eligible(
          "staff_verified_failure",
          "ticket",
          "restricted",
        );
        failingKey =
          operation === "source"
            ? "ticket"
            : `engineering-work:${key.sourceGeneration}`;
        const reading =
          operation === "source"
            ? f.app.readEngineeringSource(engineeringService, key.ticketId)
            : f.app.readEngineeringWork(engineeringService, key);
        await expect(reading).rejects.toBeInstanceOf(
          SupportDeskAuthorizationError,
        );
      },
    );

    it("coalesces the real coordinator's final Source/Work read phase after fresh authority and policy", async () => {
      const observed = observe(createStore());
      const f = await engineeringAiFixture(observed.store);
      await f.prepareProposal();
      const work = await f.work();
      const command: ReviewEngineeringProposalCommand = {
        ...f.command("read-wave-review"),
        sourceGeneration: f.key.sourceGeneration,
        expectedWorkGeneration: work.workGeneration,
        proposalHash: work.proposal!.proposalHash,
        decision: "approve",
      };
      const barrier = engineeringBarrier();
      let proofRead = false;
      let armed = false;
      const originalMetadata = f.getMetadata.getMockImplementation()!;
      f.getMetadata.mockImplementation(async (...args) => {
        const value = await originalMetadata(...args);
        proofRead = true;
        return value;
      });
      const originalPolicy = f.baseOptions.policy.resolve;
      f.baseOptions.policy.resolve = async (access) => {
        const value = await originalPolicy(access);
        if (proofRead) {
          proofRead = false;
          armed = true;
          observed.calls.length = 0;
        }
        return value;
      };
      observed.afterRead(async (read) => {
        if (!armed || read.key.id !== "engineering-source") return;
        armed = false;
        await barrier.wait();
      });
      const reviewing = f.engineering.reviewProposal(engineeringStaff, command);
      await barrier.reached;
      const launched = observed.calls.map((read) => read.key.id).sort();
      barrier.release();
      const accepted = await reviewing;
      expect(launched).toEqual([
        "engineering-source",
        "engineering-source",
        `engineering-work:${f.key.sourceGeneration}`,
        "ticket",
        "ticket",
      ]);
      observed.afterRead(undefined);
      observed.calls.length = 0;
      const generation = f.generate.mock.calls.length;
      f.resolveAuthority.mockRejectedValue(
        new Error("Fictional authority revoked after acceptance"),
      );
      expect(
        await f.engineering.reviewProposal(engineeringStaff, command),
      ).toEqual(accepted);
      expect(observed.calls.map((read) => read.key.id)).toEqual([
        `engineering-command:${command.commandId}`,
      ]);
      expect(f.generate).toHaveBeenCalledTimes(generation);
      expect(f.createIssue).not.toHaveBeenCalled();
    });
  });
}
