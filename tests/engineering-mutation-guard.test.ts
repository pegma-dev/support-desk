import type {
  EngineeringMutationOptions,
  SupportDeskApplication,
} from "@pegma/support-desk-application";
import {
  engineeringPolicyRecords,
  supportRecords,
  SupportDeskConflictError,
  SupportDeskAuthorizationError,
  supportPermissions,
} from "@pegma/support-desk-application";
import { describe, expect, it, vi } from "vitest";
import {
  engineeringFixture,
  engineeringBarrier,
  engineeringStores,
  engineeringStaff as staff,
  engineeringAdmin as admin,
  engineeringCustomer as customer,
  engineeringRepositories,
} from "../test/engineering-fixtures.js";

const operations = [
  "enroll",
  "evidence",
  "select",
  "invalidate",
  "withdraw",
  "put",
  "disable",
] as const;
type Operation = (typeof operations)[number];
type Fixture = ReturnType<typeof engineeringFixture>;

async function mutation(f: Fixture, operation: Operation) {
  let invoke: (
    application: SupportDeskApplication,
    options?: EngineeringMutationOptions,
  ) => Promise<unknown>;
  if (operation === "enroll") {
    const legacy = f.freshApplication({ engineering: undefined });
    await legacy.createCustomerTicket(customer, f.createInput(false));
    const ticket = (await f.app.readStaffTicket(staff, "ticket")).ticket;
    const command = {
      ...f.command("guarded-enroll"),
      expectedRevision: ticket.revision,
    };
    invoke = (app, options) =>
      app.enrollEngineeringSource(staff, command, options);
  } else if (operation === "evidence") {
    await f.create(false);
    const ticket = (await f.app.readStaffTicket(staff, "ticket")).ticket;
    const command = {
      ...f.command("guarded-evidence"),
      expectedRevision: ticket.revision,
      security: "ordinary" as const,
      evidence: await f.reportInput(),
    };
    invoke = (app, options) =>
      app.submitEngineeringEvidence(staff, command, options);
  } else if (operation === "select") {
    await f.eligible();
    await f.prepareCandidate();
    const source = await f.source();
    const work = await f.work();
    const policy = await f.policy();
    const command = {
      ...f.command("guarded-selection"),
      sourceGeneration: source.sourceGeneration,
      expectedWorkGeneration: work.workGeneration,
      repositoryId: engineeringRepositories[0]!.repositoryId,
      policyGeneration: policy.generation,
      policyHash: policy.policyHash,
      reason: "Staff checked the fictional component owner.",
    };
    invoke = (app, options) =>
      app.selectEngineeringRepository(staff, command, options);
  } else if (operation === "invalidate" || operation === "withdraw") {
    await f.eligible();
    if (operation === "invalidate") {
      const command = {
        ...f.command("guarded-invalidation"),
        reason: "evidence_revoked" as const,
      };
      invoke = (app, options) =>
        app.invalidateEngineeringSource(staff, command, options);
    } else {
      const command = {
        ...f.command("guarded-withdrawal"),
        reason: "privacy_withdrawal" as const,
      };
      invoke = (app, options) =>
        app.withdrawEngineeringSource(staff, command, options);
    }
  } else {
    await f.putPolicy();
    const policy = await f.policy();
    const command = f.policyCommand("guarded-policy", policy.generation);
    if (operation === "put") {
      const input = {
        ...command,
        policy: { enabled: true, repositories: [...engineeringRepositories] },
      };
      invoke = (app, options) => app.putRepositoryPolicy(admin, input, options);
    } else
      invoke = (app, options) =>
        app.disableEngineeringExports(admin, command, options);
  }
  return {
    invoke: (options?: EngineeringMutationOptions, application = f.app) =>
      invoke(application, options),
    rows: () =>
      Promise.all([
        f.rows(),
        f.store.collection(engineeringPolicyRecords).list("instance"),
      ]),
  };
}

async function bounded<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error("Caller cancellation did not settle the SDK operation"),
            ),
          1_000,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

for (const [backend, createStore] of engineeringStores) {
  describe(`engineering mutation commit guard (${backend})`, () => {
    it.each(operations)(
      "refuses a new %s mutation when the current host guard denies without writing any row",
      async (operation) => {
        const f = engineeringFixture(createStore());
        const command = await mutation(f, operation);
        const before = await command.rows();
        const transactions = f.observed.transactions.length;
        const denied = new SupportDeskAuthorizationError(
          supportPermissions.engineeringEvidenceSubmit,
        );
        const guard = vi.fn(async () => {
          throw denied;
        });
        await expect(
          command.invoke({ verifyBeforeCommit: guard }),
        ).rejects.toBe(denied);
        expect(guard).toHaveBeenCalledOnce();
        expect(await command.rows()).toEqual(before);
        expect(f.observed.transactions).toHaveLength(transactions);
      },
    );
    it.each(operations)(
      "cancels a new %s command before proof without writing",
      async (operation) => {
        const f = engineeringFixture(createStore());
        const command = await mutation(f, operation);
        const before = await command.rows();
        const transactions = f.observed.transactions.length;
        const controller = new AbortController();
        controller.abort();
        const guard = vi.fn(async () => {});
        await expect(
          command.invoke({
            signal: controller.signal,
            verifyBeforeCommit: guard,
          }),
        ).rejects.toMatchObject({ name: "AbortError" });
        expect(guard).not.toHaveBeenCalled();
        expect(await command.rows()).toEqual(before);
        expect(f.observed.transactions).toHaveLength(transactions);
      },
    );

    it.each(operations)(
      "recovers the exact accepted %s receipt after a real discarded transaction ACK before obsolete guards or cancellation",
      async (operation) => {
        const f = engineeringFixture(createStore());
        const command = await mutation(f, operation);
        const before = await command.rows();
        const lost = new Error("Synthetic committed transaction ACK discarded");
        let discarded = false;
        f.observed.intercept(async (_trace, commit) => {
          const outcome = await commit();
          if (outcome.committed && !discarded) {
            discarded = true;
            throw lost;
          }
          return outcome;
        });
        await expect(
          command.invoke({ verifyBeforeCommit: async () => {} }),
        ).rejects.toBe(lost);
        f.observed.intercept(undefined);
        expect(discarded).toBe(true);
        const acceptedRows = await command.rows();
        expect(acceptedRows).not.toEqual(before);
        const transactions = f.observed.transactions.length;
        const controller = new AbortController();
        controller.abort();
        const guard = vi.fn(async () => {
          throw new Error("Accepted replay must precede obsolete proof");
        });
        const withoutProof = f.freshApplication({
          engineering: {
            enabled: false,
            productContext: undefined,
            testReceipts: undefined,
          },
        });
        const recovered = await command.invoke(
          { signal: controller.signal, verifyBeforeCommit: guard },
          withoutProof,
        );
        expect(await command.invoke()).toEqual(recovered);
        expect(guard).not.toHaveBeenCalled();
        expect(await command.rows()).toEqual(acceptedRows);
        expect(f.observed.transactions).toHaveLength(transactions);
      },
    );

    it.each(operations)(
      "refreshes the live %s guard after a genuine opaque-version conflict",
      async (operation) => {
        const f = engineeringFixture(createStore());
        const command = await mutation(f, operation);
        const before = await command.rows();
        const transactions = f.observed.transactions.length;
        const denied = new SupportDeskAuthorizationError(
          supportPermissions.queueRead,
        );
        let current = true;
        let touched = false;
        const guard = vi.fn(async () => {
          if (!current) throw denied;
        });
        f.observed.intercept(async (_trace, commit) => {
          if (!touched) {
            touched = true;
            // Preserve the actual SDK value and change only its real backend
            // version. The delegated transaction must observe this OCC conflict.
            if (operation === "put" || operation === "disable") {
              const records = f.backing.collection(engineeringPolicyRecords);
              const stored = await records.getVersioned({
                partition: "instance",
                id: "policy",
              });
              if (stored === null)
                throw new Error("Actual policy head missing");
              expect(
                await records.putIfUnchanged(stored.value, stored.version),
              ).toBe(true);
            } else {
              const records = f.backing.collection(supportRecords);
              const stored = await records.getVersioned({
                partition: "ticket",
                id: "ticket",
              });
              if (stored === null) throw new Error("Actual ticket missing");
              expect(
                await records.putIfUnchanged(stored.value, stored.version),
              ).toBe(true);
            }
            current = false;
          }
          const outcome = await commit();
          expect(outcome.committed).toBe(false);
          return outcome;
        });
        await expect(
          command.invoke({ verifyBeforeCommit: guard }),
        ).rejects.toBe(denied);
        f.observed.intercept(undefined);
        expect(touched).toBe(true);
        expect(guard).toHaveBeenCalledTimes(2);
        expect(await command.rows()).toEqual(before);
        expect(f.observed.transactions).toHaveLength(transactions + 1);
      },
    );

    it.each(operations)(
      "checks the final synchronous %s proof after the guard's last asynchronous handoff",
      async (operation) => {
        const f = engineeringFixture(createStore());
        const command = await mutation(f, operation);
        const before = await command.rows();
        const transactions = f.observed.transactions.length;
        const deadline = Date.parse(f.clock.now()) + 10;
        const expired = new SupportDeskConflictError(
          "Synthetic current host proof expired",
        );
        const proof = vi.fn((): true => {
          if (Date.parse(f.clock.now()) >= deadline) throw expired;
          return true;
        });
        const guard = vi.fn(async () => {
          queueMicrotask(() => f.advance(11));
          return proof;
        });
        await expect(
          command.invoke({ verifyBeforeCommit: guard }),
        ).rejects.toBe(expired);
        expect(proof).toHaveBeenCalledOnce();
        expect(await command.rows()).toEqual(before);
        expect(f.observed.transactions).toHaveLength(transactions);
      },
    );

    it("settles caller cancellation while the asynchronous host guard remains deferred", async () => {
      const f = engineeringFixture(createStore());
      const command = await mutation(f, "enroll");
      const before = await command.rows();
      const transactions = f.observed.transactions.length;
      const barrier = engineeringBarrier();
      const controller = new AbortController();
      const pending = command.invoke({
        signal: controller.signal,
        verifyBeforeCommit: () => barrier.wait(),
      });
      const settled = pending.catch((error: unknown) => error);
      await barrier.reached;
      try {
        controller.abort();
        await expect(bounded(settled)).resolves.toMatchObject({
          name: "AbortError",
        });
      } finally {
        barrier.release();
      }
      expect(await command.rows()).toEqual(before);
      expect(f.observed.transactions).toHaveLength(transactions);
    });

    it.each(["product", "test"] as const)(
      "denies current host authority revoked during the actual %s proof",
      async (boundary) => {
        const f = engineeringFixture(createStore());
        await f.create(false);
        const ticket = (await f.app.readStaffTicket(staff, "ticket")).ticket;
        const report = await f.reportInput();
        const {
          kind: _kind,
          verificationReference: _reference,
          ...mismatch
        } = report;
        const command = {
          ...f.command("revoked-during-proof"),
          expectedRevision: ticket.revision,
          security: "ordinary" as const,
          evidence:
            boundary === "product"
              ? report
              : {
                  ...mismatch,
                  kind: "failed_test" as const,
                  receipt: "unverified-synthetic-test",
                },
        };
        const barrier = engineeringBarrier();
        let current = true;
        const originalProduct = f.engineeringOptions.productContext!;
        const originalTest = f.engineeringOptions.testReceipts!;
        const app = f.freshApplication({
          engineering:
            boundary === "product"
              ? {
                  productContext: {
                    async resolve(...args) {
                      const value = await originalProduct.resolve(...args);
                      await barrier.wait();
                      return value;
                    },
                  },
                }
              : {
                  testReceipts: {
                    async verify(...args) {
                      const value = await originalTest.verify(...args);
                      await barrier.wait();
                      return value;
                    },
                  },
                },
        });
        const before = await f.rows();
        const transactions = f.observed.transactions.length;
        const denied = new SupportDeskAuthorizationError(
          supportPermissions.engineeringEvidenceSubmit,
        );
        const pending = app.submitEngineeringEvidence(staff, command, {
          verifyBeforeCommit: async () => {
            if (!current) throw denied;
          },
        });
        const settled = pending.catch((error: unknown) => error);
        await barrier.reached;
        try {
          current = false;
        } finally {
          barrier.release();
        }
        expect(await settled).toBe(denied);
        expect(await f.rows()).toEqual(before);
        expect(f.observed.transactions).toHaveLength(transactions);
      },
    );

    it.each(["product", "test"] as const)(
      "propagates caller cancellation into the actual %s proof and prevents a held commit",
      async (boundary) => {
        const f = engineeringFixture(createStore());
        await f.create(false);
        const ticket = (await f.app.readStaffTicket(staff, "ticket")).ticket;
        const report = await f.reportInput();
        const {
          kind: _kind,
          verificationReference: _reference,
          ...mismatch
        } = report;
        const command = {
          ...f.command("cancelled-during-proof"),
          expectedRevision: ticket.revision,
          security: "ordinary" as const,
          evidence:
            boundary === "product"
              ? report
              : {
                  ...mismatch,
                  kind: "failed_test" as const,
                  receipt: "unverified-synthetic-test",
                },
        };
        const barrier = engineeringBarrier();
        const controller = new AbortController();
        let proofSignal: AbortSignal | undefined;
        const originalProduct = f.engineeringOptions.productContext!;
        const originalTest = f.engineeringOptions.testReceipts!;
        const app = f.freshApplication({
          engineering:
            boundary === "product"
              ? {
                  productContext: {
                    async resolve(...args) {
                      proofSignal = args[1];
                      const value = await originalProduct.resolve(...args);
                      await barrier.wait();
                      return value;
                    },
                  },
                }
              : {
                  testReceipts: {
                    async verify(...args) {
                      proofSignal = args[2];
                      const value = await originalTest.verify(...args);
                      await barrier.wait();
                      return value;
                    },
                  },
                },
        });
        const before = await f.rows();
        const transactions = f.observed.transactions.length;
        const guard = vi.fn(async () => {});
        const pending = app.submitEngineeringEvidence(staff, command, {
          signal: controller.signal,
          verifyBeforeCommit: guard,
        });
        const settled = pending.catch((error: unknown) => error);
        await barrier.reached;
        try {
          controller.abort();
          await expect(bounded(settled)).resolves.toMatchObject({
            name: "AbortError",
          });
          expect(proofSignal?.aborted).toBe(true);
        } finally {
          barrier.release();
        }
        expect(guard).not.toHaveBeenCalled();
        expect(await f.rows()).toEqual(before);
        expect(f.observed.transactions).toHaveLength(transactions);
      },
    );
    it.each(["guard", "signal"] as const)(
      "captures the original %s option once before a proof handoff",
      async (change) => {
        const f = engineeringFixture(createStore());
        const command = await mutation(f, "evidence");
        const original = f.engineeringOptions.productContext!;
        const barrier = engineeringBarrier();
        const app = f.freshApplication({
          engineering: {
            productContext: {
              async resolve(...args) {
                const value = await original.resolve(...args);
                await barrier.wait();
                return value;
              },
            },
          },
        });
        const controller = new AbortController();
        let signal = controller.signal;
        const denied = new SupportDeskAuthorizationError(
          supportPermissions.queueRead,
        );
        const originalGuard = vi.fn(async () => {
          throw denied;
        });
        const replacement = vi.fn(async () => {});
        let guard: () => Promise<void> = originalGuard;
        let signalReads = 0;
        let guardReads = 0;
        const options = {
          get signal() {
            signalReads += 1;
            return signal;
          },
          get verifyBeforeCommit() {
            guardReads += 1;
            return guard;
          },
        };
        const before = await command.rows();
        const transactions = f.observed.transactions.length;
        const pending = command
          .invoke(options, app)
          .catch((error: unknown) => error);
        await barrier.reached;
        try {
          if (change === "guard") guard = replacement;
          else {
            signal = new AbortController().signal;
            controller.abort();
          }
        } finally {
          barrier.release();
        }
        if (change === "guard") expect(await pending).toBe(denied);
        else expect(await pending).toMatchObject({ name: "AbortError" });
        expect(signalReads).toBe(1);
        expect(guardReads).toBe(1);
        expect(replacement).not.toHaveBeenCalled();
        expect(await command.rows()).toEqual(before);
        expect(f.observed.transactions).toHaveLength(transactions);
      },
    );
    it("honors cancellation triggered by the final synchronous proof before transaction entry", async () => {
      const f = engineeringFixture(createStore());
      const command = await mutation(f, "enroll");
      const before = await command.rows();
      const transactions = f.observed.transactions.length;
      const controller = new AbortController();
      const proof = vi.fn((): true => {
        controller.abort();
        return true;
      });
      await expect(
        command.invoke({
          signal: controller.signal,
          verifyBeforeCommit: async () => proof,
        }),
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(proof).toHaveBeenCalledOnce();
      expect(await command.rows()).toEqual(before);
      expect(f.observed.transactions).toHaveLength(transactions);
    });
  });
}
