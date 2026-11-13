import type { CollectionDefinition, Store } from "@pegma/storage-core";
import {
  supportPermissions,
  supportRecords,
  type SubmitResolutionEvidenceCommand,
  type SubmitResolutionEvidenceOptions,
  type SupportRecord,
} from "@pegma/support-desk-application";
import { describe, expect, it, vi } from "vitest";
import { handlingBarrier } from "../test/handling-fixtures.js";
import {
  learningStaff as staff,
  learningStores,
  resolutionLearningFixture,
} from "../test/resolution-learning-fixtures.js";

type Fixture = ReturnType<typeof resolutionLearningFixture>;

async function packet(
  f: Fixture,
  kind: "successful_test" | "staff_verified_fix" = "successful_test",
): Promise<SubmitResolutionEvidenceCommand> {
  const terminal = await f.terminal();
  const trust = {
    ticketId: terminal.ticket.id,
    ticketRevision: terminal.ticket.revision,
    resolutionCycle: terminal.source.resolutionCycle,
    resolvedAt: terminal.ticket.resolvedAt!,
    actorId: staff.principalId,
    acceptedAt: f.clock.now(),
  };
  f.trust.issueTest("verified-run", {
    ...trust,
    product: f.trust.productFor(trust),
  });
  return {
    ...f.command("guarded-evidence"),
    expectedRevision: terminal.ticket.revision,
    resolutionCycle: terminal.source.resolutionCycle,
    evidence:
      kind === "successful_test"
        ? {
            kind,
            solutionMessageId: terminal.solutionMessageId,
            receipt: "verified-run",
          }
        : {
            kind,
            solutionMessageId: terminal.solutionMessageId,
            verificationReference: "verified-fix",
          },
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
      throw new Error("Evidence mutation did not reach its expected barrier");
    }),
  ]);
}

function evidenceTransaction(trace: {
  actions: readonly { action: string; value?: unknown }[];
}) {
  return trace.actions.some(
    (action) =>
      action.action !== "delete" &&
      (action.value as SupportRecord)?.kind === "resolution_learning_receipt",
  );
}

for (const [backend, createStore] of learningStores) {
  describe(`resolution evidence current mutation guard (${backend})`, () => {
    it.each(["revoked session", "expired entitlement"] as const)(
      "refuses %s after the real test-receipt await without changing Source, Work, Audit or receipt",
      async () => {
        const gate = handlingBarrier();
        let f!: Fixture;
        f = resolutionLearningFixture(createStore(), {
          resolutionLearning: {
            testReceipts: {
              async verify(...args) {
                await gate.wait();
                return f.learningOptions.testReceipts!.verify(...args);
              },
            },
          },
        });
        const input = await packet(f);
        const before = await f.rows();
        let current = true;
        const guard = vi.fn(async () => {
          if (!current) throw new Error("Current browser authority lost");
          return (): true => true;
        });
        const pending = caught(
          f.app.submitResolutionEvidence(staff, input, {
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
        expect(f.trust.testCalls).toHaveLength(1);
      },
    );

    it("fences staff verification after the real product await too", async () => {
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
      const input = await packet(f, "staff_verified_fix");
      const before = await f.rows();
      const guard = vi.fn(async () => {
        throw new Error("Staff session revoked during product verification");
      });
      const pending = caught(
        f.app.submitResolutionEvidence(staff, input, {
          verifyBeforeCommit: guard,
        }),
      );
      await reached(gate, pending);
      gate.release();
      const result = await pending;
      expect(await f.rows()).toEqual(before);
      expect(result).toHaveProperty("error");
      expect(guard).toHaveBeenCalledOnce();
    });

    it("rechecks original permission changed during receipt verification for legacy calls", async () => {
      const access = { ...staff, permissions: [...staff.permissions] };
      let f!: Fixture;
      f = resolutionLearningFixture(createStore(), {
        resolutionLearning: {
          testReceipts: {
            async verify(...args) {
              access.permissions = [];
              return f.learningOptions.testReceipts!.verify(...args);
            },
          },
        },
      });
      const input = await packet(f);
      const before = await f.rows();
      const result = await caught(
        f.app.submitResolutionEvidence(access, input),
      );
      expect(await f.rows()).toEqual(before);
      expect(result).toMatchObject({
        error: { permission: supportPermissions.learningEvidenceSubmit },
      });
    });

    it("also fences the held-source mutation when the test receipt cannot qualify", async () => {
      const f = resolutionLearningFixture(createStore(), {
        resolutionLearning: { testReceipts: undefined },
      });
      const input = await packet(f);
      const before = await f.rows();
      const guard = vi.fn(async () => {
        throw new Error("Current browser authority lost");
      });
      await expect(
        f.app.submitResolutionEvidence(staff, input, {
          verifyBeforeCommit: guard,
        }),
      ).rejects.toThrow("authority lost");
      expect(guard).toHaveBeenCalledOnce();
      expect(await f.rows()).toEqual(before);
    });

    it("makes host refresh the last awaited precommit work with its synchronous proof at the handoff", async () => {
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
                if (armed) events.push(String(property));
                return Reflect.apply(value, object, args);
              };
            },
          });
        },
      };
      const f = resolutionLearningFixture(observed);
      const input = await packet(f);
      armed = true;
      expect(
        (
          await f.app.submitResolutionEvidence(staff, input, {
            async verifyBeforeCommit() {
              events.push("host-refresh");
              await Promise.resolve();
              events.push("host-ready");
              return (): true => {
                events.push("sync-proof");
                return true;
              };
            },
          })
        ).state,
      ).toBe("eligible");
      const ready = events.indexOf("host-ready");
      const transaction = events.indexOf("transact", ready);
      expect(ready).toBeGreaterThan(-1);
      expect(events.slice(ready + 1, transaction)).toEqual(["sync-proof"]);
      expect(transaction).toBe(ready + 2);
      expect(f.trust.testCalls).toHaveLength(1);
    });

    it.each(["principal", "permission", "queue", "policy", "roles"] as const)(
      "rechecks original %s context after the awaited host callback",
      async (change) => {
        const f = resolutionLearningFixture(createStore());
        const input = await packet(f);
        const before = await f.rows();
        const access = {
          ...staff,
          roles: [...staff.roles],
          permissions: [...staff.permissions],
        };
        const assertion = vi.fn((): true => true);
        await expect(
          f.app.submitResolutionEvidence(access, input, {
            async verifyBeforeCommit() {
              await Promise.resolve();
              if (change === "principal") access.principalId = "other-staff";
              else if (change === "permission") access.permissions = [];
              else if (change === "queue")
                access.permissions = access.permissions.filter(
                  (name) => name !== supportPermissions.queueRead,
                );
              else if (change === "policy") access.policyVersion = "changed";
              else access.roles = [...access.roles, "changed"];
              return assertion;
            },
          }),
        ).rejects.toMatchObject({
          permission:
            change === "queue"
              ? supportPermissions.queueRead
              : supportPermissions.learningEvidenceSubmit,
        });
        expect(assertion).not.toHaveBeenCalled();
        expect(await f.rows()).toEqual(before);
      },
    );

    it("rejects deadline expiry inside the synchronous transaction assertion", async () => {
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
        f.app.submitResolutionEvidence(staff, input, {
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
      "refuses malformed %s synchronous proof without writing",
      async (kind) => {
        const f = resolutionLearningFixture(createStore());
        const input = await packet(f);
        const before = await f.rows();
        const bad = kind === "async" ? async () => true : () => false;
        const verifyBeforeCommit = (() =>
          bad) as unknown as SubmitResolutionEvidenceOptions["verifyBeforeCommit"];
        await expect(
          f.app.submitResolutionEvidence(staff, input, {
            verifyBeforeCommit: verifyBeforeCommit!,
          }),
        ).rejects.toThrow("proof is not current");
        expect(await f.rows()).toEqual(before);
      },
    );

    it.each(["before proof", "during receipt", "during guard"] as const)(
      "honors cancellation %s without changing rows",
      async (when) => {
        const gate = handlingBarrier();
        let f!: Fixture;
        f = resolutionLearningFixture(createStore(), {
          resolutionLearning: {
            testReceipts: {
              async verify(...args) {
                if (when === "during receipt") await gate.wait();
                return f.learningOptions.testReceipts!.verify(...args);
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
          f.app.submitResolutionEvidence(staff, input, {
            signal: abort.signal,
            verifyBeforeCommit: guard,
          }),
        );
        if (when !== "before proof") {
          await reached(gate, pending);
          abort.abort();
          if (when === "during receipt") gate.release();
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
      "obtains a fresh host fence after a real Source CAS conflict then %s",
      async (next) => {
        const f = resolutionLearningFixture(createStore());
        const input = await packet(f);
        const before = await f.rows();
        let conflicted = false;
        let current = true;
        const assertions: ReturnType<typeof vi.fn>[] = [];
        const guard = vi.fn(async () => {
          if (!current) throw new Error("Authority lost before retry");
          const assertion = vi.fn((): true => true);
          assertions.push(assertion);
          return assertion;
        });
        f.observed.intercept(async (trace, commit) => {
          if (!conflicted && evidenceTransaction(trace)) {
            const records = f.backing.collection(supportRecords);
            const source = await records.getVersioned({
              partition: input.ticketId,
              id: "learning-source",
            });
            if (source?.value.kind !== "resolution_learning_source")
              throw new Error("Real Source missing");
            // Rewrite the same public Store record to change its real opaque
            // version without changing the explicit resolution/revision fence.
            conflicted = await records.putIfUnchanged(
              source.value,
              source.version,
            );
            if (next === "deny") current = false;
          }
          return commit();
        });
        const result = await caught(
          f.app.submitResolutionEvidence(staff, input, {
            verifyBeforeCommit: guard,
          }),
        );
        f.observed.intercept(undefined);
        expect(conflicted).toBe(true);
        expect(guard).toHaveBeenCalledTimes(2);
        expect(f.trust.testCalls).toHaveLength(2);
        expect(assertions).toHaveLength(next === "accept" ? 2 : 1);
        for (const assertion of assertions)
          expect(assertion).toHaveBeenCalledOnce();
        if (next === "deny") {
          expect(result).toHaveProperty("error");
          expect(await f.rows()).toEqual(before);
        } else {
          expect(result).toMatchObject({ value: { state: "eligible" } });
          const rows = await f.rows();
          for (const kind of [
            "resolution_learning_work",
            "resolution_learning_receipt",
          ])
            expect(rows.filter((row) => row.kind === kind)).toHaveLength(1);
        }
      },
    );

    it("recovers an accepted lost ACK before unavailable proof, obsolete guard and cancellation", async () => {
      const f = resolutionLearningFixture(createStore());
      const input = await packet(f);
      let lost = false;
      f.observed.intercept(async (trace, commit) => {
        const result = await commit();
        if (!lost && result.committed && evidenceTransaction(trace)) {
          lost = true;
          throw new Error("Lost accepted evidence ACK");
        }
        return result;
      });
      await expect(
        f.app.submitResolutionEvidence(staff, input, {
          verifyBeforeCommit: async () => () => true,
        }),
      ).rejects.toThrow("Lost accepted");
      f.observed.intercept(undefined);
      const accepted = await f.rows();
      const guard = vi.fn(async () => {
        throw new Error("Obsolete guard must not run");
      });
      const abort = new AbortController();
      abort.abort();
      const unavailable = f.freshApplication({
        resolutionLearning: {
          enabled: false,
          productContext: undefined,
          testReceipts: undefined,
        },
      });
      expect(
        await unavailable.submitResolutionEvidence(staff, input, {
          signal: abort.signal,
          verifyBeforeCommit: guard,
        }),
      ).toMatchObject({ state: "eligible" });
      expect(guard).not.toHaveBeenCalled();
      expect(f.trust.testCalls).toHaveLength(1);
      expect(await f.rows()).toEqual(accepted);
      for (const access of [
        { ...staff, principalId: "other-staff" },
        { ...staff, permissions: [] },
        {
          ...staff,
          permissions: staff.permissions.filter(
            (name) => name !== supportPermissions.queueRead,
          ),
        },
      ])
        await expect(
          unavailable.submitResolutionEvidence(access, input, {
            verifyBeforeCommit: guard,
          }),
        ).rejects.toThrow();
      expect(await f.rows()).toEqual(accepted);
    });

    it("captures the initial guard before receipt awaits so mutable options cannot replace it", async () => {
      const gate = handlingBarrier();
      let f!: Fixture;
      f = resolutionLearningFixture(createStore(), {
        resolutionLearning: {
          testReceipts: {
            async verify(...args) {
              await gate.wait();
              return f.learningOptions.testReceipts!.verify(...args);
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
        f.app.submitResolutionEvidence(staff, input, options),
      );
      await reached(gate, pending);
      options.verifyBeforeCommit = allow;
      gate.release();
      expect(await pending).toHaveProperty("error");
      expect(deny).toHaveBeenCalledOnce();
      expect(allow).not.toHaveBeenCalled();
      expect(await f.rows()).toEqual(before);
    });

    it.each(["successful_test", "staff_verified_fix"] as const)(
      "retains legacy two-argument %s submission",
      async (kind) => {
        const f = resolutionLearningFixture(createStore());
        const input = await packet(f, kind);
        expect((await f.app.submitResolutionEvidence(staff, input)).state).toBe(
          "eligible",
        );
        expect(
          (await f.rows()).filter(
            (row) => row.kind === "resolution_learning_work",
          ),
        ).toHaveLength(1);
      },
    );
  });
}
