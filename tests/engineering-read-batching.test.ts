import type {
  CollectionDefinition,
  EntityKey,
  Store,
} from "@pegma/storage-core";
import {
  SupportDeskAuthorizationError,
  SupportDeskNotFoundError,
  supportRecords,
  supportPermissions,
  type ReviewEngineeringProposalCommand,
} from "@pegma/support-desk-application";
import { createSupportDeskEngineering } from "@pegma/support-desk-ai";
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
  describe(`engineering authorized read contexts (${name})`, () => {
    it.each(["source", "work"] as const)(
      "gates %s hydration on the returned Source and current access",
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
        expect(launched).toEqual(["engineering-source"]);
        expect(observed.calls).toHaveLength(operation === "source" ? 3 : 5);
      },
    );

    it("checks Source and current access before launching final Work confirmation", async () => {
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
      ).toHaveLength(1);
      expect(observed.calls).toHaveLength(5);
    });

    it("returns a withdrawn Source without starting an unavailable Ticket read", async () => {
      const observed = observe(createStore());
      const f = engineeringFixture(observed.store);
      const key = await f.eligible();
      await f.app.withdrawEngineeringSource(engineeringStaff, {
        ...f.command("withdraw-before-source-read"),
        reason: "privacy_withdrawal",
      });
      observed.calls.length = 0;
      observed.afterRead(async (read) => {
        if (read.key.id !== "engineering-source")
          throw new Error("Fictional protected read must not start");
      });
      const source = await f.app.readEngineeringSource(
        engineeringStaff,
        key.ticketId,
      );
      expect(source.state).toBe("withdrawn");
      expect(observed.calls.map((read) => read.key.id)).toEqual([
        "engineering-source",
        "engineering-source",
      ]);
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

    it("does not read protected Work or Ticket after Source privacy or existence denial", async () => {
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
      observed.calls.length = 0;
      await expect(
        f.app.readEngineeringWork(engineeringService, key),
      ).rejects.toBeInstanceOf(SupportDeskAuthorizationError);
      expect(observed.calls.map((read) => read.key.id)).toEqual([
        "engineering-source",
      ]);
      observed.calls.length = 0;
      await backing
        .collection(supportRecords)
        .delete({ partition: key.ticketId, id: "engineering-source" });
      await expect(
        f.app.readEngineeringWork(engineeringStaff, key),
      ).rejects.toBeInstanceOf(SupportDeskNotFoundError);
      expect(observed.calls.map((read) => read.key.id)).toEqual([
        "engineering-source",
      ]);
    });

    it.each(["source", "work"] as const)(
      "keeps Source privacy priority when a sibling %s hydration call throws synchronously",
      async (operation) => {
        const backing = createStore();
        let failingKey: string | undefined;
        let forbiddenReads = 0;
        const failure = new Error("Fictional synchronous Store read failure");
        const store: Store = {
          collection<T>(definition: CollectionDefinition<T>) {
            const target = backing.collection(definition);
            if (definition.name !== supportRecords.name) return target;
            return new Proxy(target, {
              get(object, property) {
                if (property === "get" || property === "getVersioned")
                  return (key: EntityKey) => {
                    if (key.id === failingKey) {
                      forbiddenReads += 1;
                      throw failure;
                    }
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
        expect(forbiddenReads).toBe(0);
      },
    );

    it("shares eligible Source/Work hydration without moving final confirmations before protected reads", async () => {
      const observed = observe(createStore());
      const f = engineeringFixture(observed.store);
      const key = await f.eligible();
      const source = await f.app.readEngineeringSource(
        engineeringStaff,
        key.ticketId,
      );
      const work = await f.app.readEngineeringWork(engineeringStaff, key);
      observed.calls.length = 0;
      const context = await f.app.readEngineeringContext!(engineeringStaff, {
        ...key,
        sourceBindingHash: source.sourceBindingHash!,
      });
      expect(context).toEqual({ source, work });
      expect(observed.calls.map((read) => read.key.id)).toEqual([
        "engineering-source",
        `engineering-work:${key.sourceGeneration}`,
        "ticket",
        "engineering-source",
        `engineering-work:${key.sourceGeneration}`,
      ]);
    });

    it.each(["withdrawn", "different_fence"] as const)(
      "returns %s Source context without touching unavailable Work",
      async (state) => {
        const observed = observe(createStore());
        const f = engineeringFixture(observed.store);
        const key = await f.eligible();
        const source = await f.app.readEngineeringSource(
          engineeringStaff,
          key.ticketId,
        );
        if (state === "withdrawn")
          await f.app.withdrawEngineeringSource(engineeringStaff, {
            ...f.command("withdraw-before-context"),
            reason: "privacy_withdrawal",
          });
        observed.calls.length = 0;
        observed.afterRead(async (read) => {
          if (
            read.key.id.startsWith("engineering-work:") ||
            (state === "withdrawn" && read.key.id === "ticket")
          )
            throw new Error("Fictional protected read must not start");
        });
        const context = await f.app.readEngineeringContext!(engineeringStaff, {
          ...key,
          sourceBindingHash:
            state === "different_fence"
              ? "different-binding"
              : source.sourceBindingHash!,
        });
        expect(context.work).toBeUndefined();
        expect(context.source.state).toBe(
          state === "withdrawn" ? "withdrawn" : "eligible",
        );
        expect(observed.calls.map((read) => read.key.id)).toEqual(
          state === "withdrawn"
            ? ["engineering-source", "engineering-source"]
            : ["engineering-source", "ticket", "engineering-source"],
        );
      },
    );

    it("keeps context Source privacy and Work absence ahead of Ticket reads", async () => {
      const backing = createStore();
      const observed = observe(backing);
      const f = engineeringFixture(observed.store);
      const key = await f.eligible();
      const source = await f.app.readEngineeringSource(
        engineeringStaff,
        key.ticketId,
      );
      await backing.collection(supportRecords).delete({
        partition: key.ticketId,
        id: `engineering-work:${key.sourceGeneration}`,
      });
      observed.calls.length = 0;
      await expect(
        f.app.readEngineeringContext!(engineeringStaff, {
          ...key,
          sourceBindingHash: source.sourceBindingHash!,
        }),
      ).rejects.toBeInstanceOf(SupportDeskNotFoundError);
      expect(observed.calls.map((read) => read.key.id)).toEqual([
        "engineering-source",
        `engineering-work:${key.sourceGeneration}`,
      ]);
    });

    it("rechecks current read authority after Work and before protected Ticket hydration", async () => {
      const observed = observe(createStore());
      const f = engineeringFixture(observed.store);
      const key = await f.eligible();
      const source = await f.app.readEngineeringSource(
        engineeringStaff,
        key.ticketId,
      );
      const access = {
        ...engineeringStaff,
        permissions: [...engineeringStaff.permissions],
      };
      observed.calls.length = 0;
      observed.afterRead(async (read) => {
        if (read.key.id.startsWith("engineering-work:"))
          access.permissions = access.permissions.filter(
            (value) => value !== supportPermissions.engineeringRead,
          );
      });
      await expect(
        f.app.readEngineeringContext!(access, {
          ...key,
          sourceBindingHash: source.sourceBindingHash!,
        }),
      ).rejects.toBeInstanceOf(SupportDeskAuthorizationError);
      expect(observed.calls.map((read) => read.key.id)).toEqual([
        "engineering-source",
        `engineering-work:${key.sourceGeneration}`,
      ]);
    });

    it("retries context after real Source invalidation during Work hydration", async () => {
      const observed = observe(createStore());
      const f = engineeringFixture(observed.store);
      const key = await f.eligible();
      const source = await f.app.readEngineeringSource(
        engineeringStaff,
        key.ticketId,
      );
      const barrier = engineeringBarrier();
      let armed = true;
      observed.afterRead(async (read) => {
        if (!armed || !read.key.id.startsWith("engineering-work:")) return;
        armed = false;
        await barrier.wait();
      });
      const reading = f.app.readEngineeringContext!(engineeringStaff, {
        ...key,
        sourceBindingHash: source.sourceBindingHash!,
      });
      await barrier.reached;
      await f.app.invalidateEngineeringSource(engineeringStaff, {
        ...f.command("invalidate-during-context"),
        reason: "evidence_revoked",
      });
      barrier.release();
      const context = await reading;
      observed.afterRead(undefined);
      expect(context.work).toBeUndefined();
      expect(context.source).toEqual(
        await f.app.readEngineeringSource(engineeringStaff, key.ticketId),
      );
      expect(context.source.state).toBe("held");
    });

    it("keeps public coordinator approval and exact receipt recovery compatible without the optional context", async () => {
      const f = await engineeringAiFixture(createStore());
      await f.prepareProposal();
      const work = await f.work();
      const legacyApplication = { ...f.app };
      delete legacyApplication.readEngineeringContext;
      const engineering = createSupportDeskEngineering({
        ...f.baseOptions,
        application: legacyApplication,
      });
      const command: ReviewEngineeringProposalCommand = {
        ...f.command("legacy-context-review"),
        sourceGeneration: f.key.sourceGeneration,
        expectedWorkGeneration: work.workGeneration,
        proposalHash: work.proposal!.proposalHash,
        decision: "approve",
      };
      const accepted = await engineering.reviewProposal(
        engineeringStaff,
        command,
      );
      f.resolveAuthority.mockRejectedValue(
        new Error("Fictional authority unavailable after acceptance"),
      );
      expect(
        await engineering.reviewProposal(engineeringStaff, command),
      ).toEqual(accepted);
      expect(f.createIssue).not.toHaveBeenCalled();
    });

    it("returns a withdrawn Source even when an unnecessary Ticket port would never settle", async () => {
      const backing = createStore();
      let blocked = false;
      let ticketReads = 0;
      const store: Store = {
        collection<T>(definition: CollectionDefinition<T>) {
          const target = backing.collection(definition);
          if (definition.name !== supportRecords.name) return target;
          return new Proxy(target, {
            get(object, property) {
              if (property === "get")
                return (key: EntityKey) => {
                  if (blocked && key.id === "ticket") {
                    ticketReads += 1;
                    return new Promise<never>(() => {});
                  }
                  return object.get(key);
                };
              const value: unknown = Reflect.get(object, property, object);
              return typeof value === "function" ? value.bind(object) : value;
            },
          });
        },
      };
      const f = engineeringFixture(store);
      const key = await f.eligible();
      await f.app.withdrawEngineeringSource(engineeringStaff, {
        ...f.command("withdraw-before-stalled-ticket"),
        reason: "privacy_withdrawal",
      });
      blocked = true;
      expect(
        (await f.app.readEngineeringSource(engineeringStaff, key.ticketId))
          .state,
      ).toBe("withdrawn");
      expect(ticketReads).toBe(0);
    });

    it("does not launch Ticket after a permitted Work port throws synchronously", async () => {
      const backing = createStore();
      let failing = false;
      const calls: string[] = [];
      const failure = new Error("Fictional synchronous Work port unavailable");
      const store: Store = {
        collection<T>(definition: CollectionDefinition<T>) {
          const target = backing.collection(definition);
          if (definition.name !== supportRecords.name) return target;
          return new Proxy(target, {
            get(object, property) {
              if (property === "get" || property === "getVersioned")
                return (key: EntityKey) => {
                  if (failing) {
                    calls.push(key.id);
                    if (key.id.startsWith("engineering-work:")) throw failure;
                  }
                  return object[property](key);
                };
              const value: unknown = Reflect.get(object, property, object);
              return typeof value === "function" ? value.bind(object) : value;
            },
          });
        },
      };
      const f = engineeringFixture(store);
      const key = await f.eligible();
      const source = await f.app.readEngineeringSource(
        engineeringStaff,
        key.ticketId,
      );
      failing = true;
      await expect(
        f.app.readEngineeringContext!(engineeringStaff, {
          ...key,
          sourceBindingHash: source.sourceBindingHash!,
        }),
      ).rejects.toBe(failure);
      expect(calls).toEqual([
        "engineering-source",
        `engineering-work:${key.sourceGeneration}`,
      ]);
    });

    it("confirms Work's opaque version after an actual concurrent claim", async () => {
      const observed = observe(createStore());
      const f = engineeringFixture(observed.store);
      const key = await f.eligible();
      const source = await f.app.readEngineeringSource(
        engineeringStaff,
        key.ticketId,
      );
      const barrier = engineeringBarrier();
      let sources = 0;
      observed.afterRead(async (read) => {
        if (read.key.id === "engineering-source" && ++sources === 2)
          await barrier.wait();
      });
      const reading = f.app.readEngineeringContext!(engineeringStaff, {
        ...key,
        sourceBindingHash: source.sourceBindingHash!,
      });
      await barrier.reached;
      const claim = await f.app.claimEngineeringWork(engineeringService, {
        ...key,
        workerId: "fictional-context-worker",
        claimId: "fictional-context-claim",
        leaseMilliseconds: 5000,
      });
      expect(claim).not.toBeNull();
      barrier.release();
      const context = await reading;
      observed.afterRead(undefined);
      expect(context.work).toEqual(
        await f.app.readEngineeringWork(engineeringStaff, key),
      );
      expect(context.work?.claim?.claimId).toBe("fictional-context-claim");
    });

    it.each([true, false])(
      "preserves terminal Source-before-Work outcomes in the public coordinator (context=%s)",
      async (combined) => {
        const observed = observe(createStore());
        const f = await engineeringAiFixture(observed.store);
        await f.prepareProposal();
        const work = await f.work();
        const application = { ...f.app };
        if (!combined) delete application.readEngineeringContext;
        const engineering = createSupportDeskEngineering({
          ...f.baseOptions,
          application,
        });
        const originalMetadata = f.getMetadata.getMockImplementation()!;
        let afterWithdrawal: Awaited<ReturnType<typeof f.rows>> | undefined;
        f.getMetadata.mockImplementation(async (...args) => {
          const result = await originalMetadata(...args);
          await f.app.withdrawEngineeringSource(engineeringStaff, {
            ...f.command("withdraw-during-final-proof"),
            reason: "privacy_withdrawal",
          });
          afterWithdrawal = await f.rows();
          observed.calls.length = 0;
          observed.afterRead(async (read) => {
            if (
              read.key.id.startsWith("engineering-work:") ||
              read.key.id === "ticket"
            )
              throw new Error(
                "Fictional terminal Source cannot require protected reads",
              );
          });
          return result;
        });
        await expect(
          engineering.reviewProposal(engineeringStaff, {
            ...f.command("terminal-context-review"),
            sourceGeneration: f.key.sourceGeneration,
            expectedWorkGeneration: work.workGeneration,
            proposalHash: work.proposal!.proposalHash,
            decision: "approve",
          }),
        ).rejects.toThrow();
        expect(afterWithdrawal).toBeDefined();
        expect(
          observed.calls.every(
            (read) =>
              !read.key.id.startsWith("engineering-work:") &&
              read.key.id !== "ticket",
          ),
        ).toBe(true);
        observed.afterRead(undefined);
        expect(await f.rows()).toEqual(afterWithdrawal);
        expect(f.createIssue).not.toHaveBeenCalled();
      },
    );

    it("checks the real coordinator's final Source before protected reads and retains receipt-first replay", async () => {
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
      expect(launched).toEqual(["engineering-source"]);
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
