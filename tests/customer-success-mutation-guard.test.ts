import type { CollectionDefinition, Store } from "@pegma/storage-core";
import {
  supportPermissions,
  supportRecords,
  type ConfirmCustomerSuccessOptions,
  type SupportRecord,
} from "@pegma/support-desk-application";
import { describe, expect, it, vi } from "vitest";
import {
  handlingBarrier,
  handlingCustomer as customer,
  handlingStaff as staff,
} from "../test/handling-fixtures.js";
import {
  resolutionLearningFixture,
  learningStores,
} from "../test/resolution-learning-fixtures.js";

type Fixture = ReturnType<typeof resolutionLearningFixture>;

async function packet(f: Fixture) {
  const terminal = await f.terminal();
  return {
    ...f.command("guarded-success"),
    lastSeenVisibleMessageId: terminal.solutionMessageId,
  };
}

function caught<T>(promise: Promise<T>) {
  return promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
}

async function reached(
  gate: ReturnType<typeof handlingBarrier>,
  pending: Promise<unknown>,
) {
  await Promise.race([
    gate.reached,
    pending.then(() => {
      throw new Error("Success mutation did not reach its expected barrier");
    }),
  ]);
}

function successTransaction(trace: {
  actions: readonly { action: string; value?: unknown }[];
}) {
  return trace.actions.some(
    (action) =>
      action.action !== "delete" &&
      (action.value as SupportRecord)?.kind === "customer_success",
  );
}

for (const [backend, createStore] of learningStores) {
  describe(`customer success current mutation guard (${backend})`, () => {
    it.each([
      ["guard", 60_000, true],
      ["guard", 60_001, false],
      ["assertion", 60_001, false],
    ] as const)(
      "proof freshness preserves human confirmation after %s advances %ims, with eligible learning=%s",
      async (when, elapsed, eligible) => {
        const f = resolutionLearningFixture(createStore());
        const input = await packet(f);
        const result = await f.app.confirmCustomerSuccess(customer, input, {
          async verifyBeforeCommit() {
            if (when === "guard") f.advance(elapsed);
            return (): true => {
              if (when === "assertion") f.advance(elapsed);
              return true;
            };
          },
        });
        expect(result.ticket.status).toBe("resolved");
        const source = await f.source();
        expect(source.state).toBe(eligible ? "eligible" : "held");
        if (!eligible)
          expect(source.heldReason).toBe("product_context_unverified");
        const rows = await f.rows();
        expect(
          rows.filter((row) => row.kind === "customer_success"),
        ).toHaveLength(1);
        expect(
          rows.filter((row) => row.kind === "resolution_learning_work"),
        ).toHaveLength(eligible ? 1 : 0);
      },
    );

    it("proof freshness selects a new product plan after a genuine Ticket CAS conflict", async () => {
      const f = resolutionLearningFixture(createStore());
      const input = await packet(f);
      let guards = 0;
      let conflicted = false;
      f.observed.intercept(async (trace, commit) => {
        if (!conflicted && successTransaction(trace)) {
          const source = trace.actions.find(
            (action) =>
              action.action !== "delete" &&
              (action.value as SupportRecord)?.kind ===
                "resolution_learning_source",
          );
          expect(
            source && source.action !== "delete" && source.value,
          ).toMatchObject({ state: "held" });
          expect(
            trace.actions.some(
              (action) =>
                action.action !== "delete" &&
                (action.value as SupportRecord)?.kind ===
                  "resolution_learning_work",
            ),
          ).toBe(false);
          conflicted = true;
          await f.app.addNote(staff, {
            ...f.command("freshness-conflict"),
            messageId: "freshness-note",
            body: "A real concurrent note changes the Ticket version.",
          });
        }
        return commit();
      });
      await f.app.confirmCustomerSuccess(customer, input, {
        async verifyBeforeCommit() {
          if (++guards === 1) f.advance(60_001);
          return (): true => true;
        },
      });
      f.observed.intercept(undefined);
      expect(conflicted).toBe(true);
      expect(guards).toBe(2);
      expect(f.trust.productCalls).toHaveLength(2);
      expect((await f.source()).state).toBe("eligible");
      expect(
        (await f.rows()).filter(
          (row) => row.kind === "resolution_learning_work",
        ),
      ).toHaveLength(1);
    });

    it("observes cancellation triggered by the final literal-true assertion before any transaction", async () => {
      const f = resolutionLearningFixture(createStore());
      const input = await packet(f);
      const before = await f.rows();
      const controller = new AbortController();
      await expect(
        f.app.confirmCustomerSuccess(customer, input, {
          signal: controller.signal,
          verifyBeforeCommit: async () => (): true => {
            controller.abort();
            return true;
          },
        }),
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(await f.rows()).toEqual(before);
    });

    it("refuses current host authority denied after the real product await without committing confirmation, Source or Work", async () => {
      const gate = handlingBarrier();
      let f!: Fixture;
      f = resolutionLearningFixture(createStore(), {
        resolutionLearning: {
          productContext: {
            async resolve(context) {
              await gate.wait();
              return f.trust.productFor(context);
            },
          },
        },
      });
      const input = await packet(f);
      const before = await f.rows();
      let current = true;
      const guard = vi.fn(async () => {
        if (!current) throw new Error("Current browser authority unavailable");
        return (): true => true;
      });
      const pending = caught(
        f.app.confirmCustomerSuccess(customer, input, {
          verifyBeforeCommit: guard,
        }),
      );
      await reached(gate, pending);
      expect(guard).not.toHaveBeenCalled();
      current = false;
      gate.release();
      const result = await pending;
      expect(await f.rows()).toEqual(before);
      expect(result).toHaveProperty("error");
      expect(guard).toHaveBeenCalledOnce();
    });

    it("rechecks an original permission changed during product verification even for legacy calls", async () => {
      const access = { ...customer, permissions: [...customer.permissions] };
      let f!: Fixture;
      f = resolutionLearningFixture(createStore(), {
        resolutionLearning: {
          productContext: {
            async resolve(context) {
              access.permissions = [];
              return f.trust.productFor(context);
            },
          },
        },
      });
      const input = await packet(f);
      const before = await f.rows();
      const result = await caught(f.app.confirmCustomerSuccess(access, input));
      expect(await f.rows()).toEqual(before);
      expect(result).toMatchObject({
        error: { permission: supportPermissions.confirmSuccess },
      });
    });

    it("makes the host refresh the last awaited precommit work, with its synchronous proof directly at the handoff", async () => {
      const backing = createStore();
      let armed = false;
      const events: string[] = [];
      const observed: Store = {
        collection<T>(definition: CollectionDefinition<T>) {
          const actual = backing.collection(definition);
          return new Proxy(actual, {
            get(object, property) {
              const value: unknown = Reflect.get(object, property, object);
              if (typeof value !== "function") return value;
              return (...args: unknown[]) => {
                if (armed && definition.name === supportRecords.name)
                  events.push(String(property));
                return Reflect.apply(value, object, args);
              };
            },
          });
        },
      };
      const f = resolutionLearningFixture(observed);
      const input = await packet(f);
      armed = true;
      const result = await f.app.confirmCustomerSuccess(customer, input, {
        async verifyBeforeCommit() {
          events.push("host-refresh");
          await Promise.resolve();
          events.push("host-ready");
          return (): true => {
            events.push("sync-proof");
            return true;
          };
        },
      });
      expect(result.ticket.status).toBe("resolved");
      const ready = events.indexOf("host-ready");
      const transaction = events.indexOf("transact", ready);
      expect(ready).toBeGreaterThan(-1);
      expect(events.slice(ready + 1, transaction)).toEqual(["sync-proof"]);
      expect(transaction).toBe(ready + 2);
      expect(f.trust.productCalls).toHaveLength(1);
    });

    it.each(["principal", "permission", "policy", "roles"] as const)(
      "rechecks the original %s context after the awaited host callback",
      async (change) => {
        const f = resolutionLearningFixture(createStore());
        const input = await packet(f);
        const before = await f.rows();
        const access = {
          ...customer,
          roles: [...customer.roles],
          permissions: [...customer.permissions],
        };
        const assertion = vi.fn((): true => true);
        await expect(
          f.app.confirmCustomerSuccess(access, input, {
            async verifyBeforeCommit() {
              await Promise.resolve();
              if (change === "principal")
                access.principalId = "different-customer";
              else if (change === "permission") access.permissions = [];
              else if (change === "policy")
                access.policyVersion = "different-current-policy";
              else access.roles = [...access.roles, "changed-role"];
              return assertion;
            },
          }),
        ).rejects.toMatchObject({
          permission: supportPermissions.confirmSuccess,
        });
        expect(assertion).not.toHaveBeenCalled();
        expect(await f.rows()).toEqual(before);
      },
    );

    it("rejects a deadline crossing inside the synchronous handoff assertion", async () => {
      const f = resolutionLearningFixture(createStore());
      const input = await packet(f);
      const before = await f.rows();
      const deadline = Date.parse(f.clock.now()) + 1;
      const assertion = vi.fn((): true => {
        if (Date.parse(f.clock.now()) >= deadline)
          throw new Error("Browser deadline expired");
        return true;
      });
      await expect(
        f.app.confirmCustomerSuccess(customer, input, {
          async verifyBeforeCommit() {
            f.advance(1);
            return assertion;
          },
        }),
      ).rejects.toThrow("deadline expired");
      expect(assertion).toHaveBeenCalledOnce();
      expect(await f.rows()).toEqual(before);
    });

    it.each(["not true", "async"] as const)(
      "refuses a malformed %s handoff assertion without writing",
      async (kind) => {
        const f = resolutionLearningFixture(createStore());
        const input = await packet(f);
        const before = await f.rows();
        const bad = kind === "async" ? async () => true : () => false;
        const verifyBeforeCommit = (() =>
          bad) as unknown as ConfirmCustomerSuccessOptions["verifyBeforeCommit"];
        await expect(
          f.app.confirmCustomerSuccess(customer, input, {
            verifyBeforeCommit: verifyBeforeCommit!,
          }),
        ).rejects.toThrow("proof is not current");
        expect(await f.rows()).toEqual(before);
      },
    );

    it.each(["before proof", "during product", "during guard"] as const)(
      "honors cancellation %s without changing rows",
      async (when) => {
        const gate = handlingBarrier();
        let f!: Fixture;
        f = resolutionLearningFixture(createStore(), {
          resolutionLearning: {
            productContext: {
              async resolve(context) {
                if (when === "during product") await gate.wait();
                return f.trust.productFor(context);
              },
            },
          },
        });
        const input = await packet(f);
        const before = await f.rows();
        const abort = new AbortController();
        const guard = vi.fn(async () => {
          if (when === "during guard") await gate.wait();
        });
        if (when === "before proof") abort.abort();
        const pending = caught(
          f.app.confirmCustomerSuccess(customer, input, {
            signal: abort.signal,
            verifyBeforeCommit: guard,
          }),
        );
        if (when !== "before proof") {
          await reached(gate, pending);
          abort.abort();
          if (when === "during product") gate.release();
        }
        try {
          expect(await pending).toMatchObject({
            error: { name: "AbortError" },
          });
          expect(await f.rows()).toEqual(before);
        } finally {
          gate.release();
        }
        if (when !== "during guard") expect(guard).not.toHaveBeenCalled();
      },
    );

    it.each(["accept", "deny"] as const)(
      "obtains a new host fence after a genuine CAS conflict and then %s",
      async (next) => {
        const f = resolutionLearningFixture(createStore());
        const input = await packet(f);
        let current = true;
        let conflicted = false;
        let afterNote: Awaited<ReturnType<Fixture["rows"]>> | undefined;
        const assertions: ReturnType<typeof vi.fn>[] = [];
        const guard = vi.fn(async () => {
          if (!current) throw new Error("Authority lost before retry");
          const proof = vi.fn((): true => true);
          assertions.push(proof);
          return proof;
        });
        f.observed.intercept(async (trace, commit) => {
          if (!conflicted && successTransaction(trace)) {
            conflicted = true;
            await f.app.addNote(staff, {
              ...f.command("concurrent-note"),
              messageId: "concurrent-note",
              body: "Private note forces a genuine Ticket version conflict.",
            });
            afterNote = await f.rows();
            if (next === "deny") current = false;
          }
          return commit();
        });
        const result = await caught(
          f.app.confirmCustomerSuccess(customer, input, {
            verifyBeforeCommit: guard,
          }),
        );
        f.observed.intercept(undefined);
        expect(conflicted).toBe(true);
        expect(guard).toHaveBeenCalledTimes(2);
        expect(assertions).toHaveLength(next === "accept" ? 2 : 1);
        for (const assertion of assertions)
          expect(assertion).toHaveBeenCalledOnce();
        if (next === "deny") {
          expect(result).toHaveProperty("error");
          expect(await f.rows()).toEqual(afterNote);
        } else {
          expect(result).toHaveProperty("value");
          const rows = await f.rows();
          expect(
            rows.filter((row) => row.kind === "customer_success"),
          ).toHaveLength(1);
          expect(
            rows.filter((row) => row.kind === "resolution_learning_work"),
          ).toHaveLength(1);
        }
      },
    );

    it("keeps callback-time ownership changes fenced by the original Ticket CAS", async () => {
      const f = resolutionLearningFixture(createStore());
      const input = await packet(f);
      let transferred = false;
      const guard = vi.fn(async () => {
        if (!transferred) {
          const records = f.backing.collection(supportRecords);
          const row = await records.getVersioned({
            partition: input.ticketId,
            id: "ticket",
          });
          if (row?.value.kind !== "ticket")
            throw new Error("Real Ticket missing");
          transferred = await records.putIfUnchanged(
            {
              ...row.value,
              ticket: {
                ...row.value.ticket,
                requester: {
                  ...row.value.ticket.requester,
                  principalId: "other-customer",
                },
              },
            },
            row.version,
          );
        }
      });
      await expect(
        f.app.confirmCustomerSuccess(customer, input, {
          verifyBeforeCommit: guard,
        }),
      ).rejects.toThrow();
      expect(transferred).toBe(true);
      expect(guard).toHaveBeenCalledOnce();
      const rows = await f.rows();
      expect(
        rows.filter(
          (row) =>
            row.kind === "customer_success" ||
            row.kind === "resolution_learning_work",
        ),
      ).toEqual([]);
    });

    it("recovers an accepted lost ACK before unavailable product proof, obsolete guard and cancellation", async () => {
      const f = resolutionLearningFixture(createStore());
      const input = await packet(f);
      let lost = false;
      f.observed.intercept(async (trace, commit) => {
        const result = await commit();
        if (result.committed && successTransaction(trace) && !lost) {
          lost = true;
          throw new Error("Lost accepted success ACK");
        }
        return result;
      });
      await expect(
        f.app.confirmCustomerSuccess(customer, input, {
          verifyBeforeCommit: async () => () => true,
        }),
      ).rejects.toThrow("Lost accepted");
      f.observed.intercept(undefined);
      const acceptedRows = await f.rows();
      f.advance(60_001);
      const guard = vi.fn(async () => {
        throw new Error("Obsolete host mutation proof must not run");
      });
      const controller = new AbortController();
      controller.abort();
      const unavailable = f.freshApplication({
        resolutionLearning: { enabled: false, productContext: undefined },
      });
      const result = await unavailable.confirmCustomerSuccess(customer, input, {
        signal: controller.signal,
        verifyBeforeCommit: guard,
      });
      expect(result.ticket.status).toBe("resolved");
      expect(guard).not.toHaveBeenCalled();
      expect(await f.rows()).toEqual(acceptedRows);
      for (const access of [
        { ...customer, principalId: "another-customer" },
        { ...customer, permissions: [] },
      ]) {
        await expect(
          unavailable.confirmCustomerSuccess(access, input, {
            verifyBeforeCommit: guard,
          }),
        ).rejects.toThrow();
      }
      expect(await f.rows()).toEqual(acceptedRows);
    });

    it("captures the initial guard before product awaits so mutable options cannot replace it", async () => {
      const gate = handlingBarrier();
      let f!: Fixture;
      f = resolutionLearningFixture(createStore(), {
        resolutionLearning: {
          productContext: {
            async resolve(context) {
              await gate.wait();
              return f.trust.productFor(context);
            },
          },
        },
      });
      const input = await packet(f);
      const before = await f.rows();
      const deny = vi.fn(async () => {
        throw new Error("Captured original guard denies");
      });
      const allow = vi.fn(async () => {});
      const options: { verifyBeforeCommit: () => Promise<void> } = {
        verifyBeforeCommit: deny,
      };
      const pending = caught(
        f.app.confirmCustomerSuccess(customer, input, options),
      );
      await reached(gate, pending);
      options.verifyBeforeCommit = allow;
      gate.release();
      expect(await pending).toHaveProperty("error");
      expect(deny).toHaveBeenCalledOnce();
      expect(allow).not.toHaveBeenCalled();
      expect(await f.rows()).toEqual(before);
    });

    it("retains two-argument legacy success confirmation", async () => {
      const f = resolutionLearningFixture(createStore());
      const input = await packet(f);
      expect(
        (await f.app.confirmCustomerSuccess(customer, input)).ticket.status,
      ).toBe("resolved");
      expect(
        (await f.rows()).filter((row) => row.kind === "customer_success"),
      ).toHaveLength(1);
    });
  });
}
