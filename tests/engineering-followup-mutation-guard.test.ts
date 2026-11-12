import type { AccessContext } from "@pegma/authorization-core";
import type {
  EngineeringMutationOptions,
  PrepareEngineeringFollowupBundleCommand,
} from "@pegma/support-desk-application";
import {
  SupportDeskAuthorizationError,
  SupportDeskConflictError,
  supportPermissions,
  supportRecords,
} from "@pegma/support-desk-application";
import { createSupportDeskReleaseFollowup } from "@pegma/support-desk-ai";
import { describe, expect, it, vi } from "vitest";
import {
  engineeringFollowupBarrier,
  engineeringFollowupFixture,
  engineeringFollowupService as service,
  engineeringFollowupStaff as staff,
  engineeringFollowupStores,
} from "../test/engineering-followup-fixtures.js";
import {
  engineeringFollowupAiFixture,
  waitForFollowupHook,
} from "../test/engineering-followup-ai-fixtures.js";

const operations = [
  "observe",
  "retry",
  "abandon",
  "reject",
  "prepare",
] as const;
type Operation = (typeof operations)[number];
type Fixture = Awaited<ReturnType<typeof engineeringFollowupFixture>>;

/** Every command targets actual accepted engineering/follow-up state and proof. */
async function mutation(
  f: Fixture,
  operation: Operation,
  actor: AccessContext = staff,
) {
  if (operation === "observe") {
    const association = await f.association();
    const command = {
      ...f.command("guarded-followup-observe"),
      association: {
        repositoryId: association.repositoryId,
        issueId: association.issueId,
      },
      inputReference: await f.issueInput(),
    };
    return {
      invoke: (options?: EngineeringMutationOptions) =>
        f.app.observeEngineeringFollowup(actor, command, options),
    };
  }
  await f.eligible();
  if (operation === "prepare") {
    let command: PrepareEngineeringFollowupBundleCommand | undefined;
    const captured = new Error(
      "Captured the real checked preparation before its commit",
    );
    await f
      .prepareBundle({
        mode: "staff_reassessment",
        beforePrepare(value) {
          command = value;
          throw captured;
        },
      })
      .catch((error: unknown) => {
        if (error !== captured) throw error;
      });
    if (command === undefined)
      throw new Error("Actual preparation was not captured");
    const proof = vi.fn(async () => {});
    return {
      invoke: (options?: EngineeringMutationOptions) =>
        f.app.prepareEngineeringFollowupBundle(actor, command!, proof, options),
    };
  }
  if (operation === "retry") {
    const owner = await f.claim();
    await f.app.finishEngineeringFollowupModel(service, {
      ...owner.fence,
      disposition: "held",
      reason: "temporary_outage",
    });
  }
  if (operation === "reject") await f.prepareBundle();
  const work = await f.work();
  const command = {
    ...f.command(`guarded-followup-${operation}`),
    ...f.key,
    expectedWorkGeneration: work.workGeneration,
  };
  if (operation === "retry")
    return {
      invoke: (options?: EngineeringMutationOptions) =>
        f.app.retryEngineeringFollowupWork(actor, command, options),
    };
  if (operation === "abandon")
    return {
      invoke: (options?: EngineeringMutationOptions) =>
        f.app.abandonEngineeringFollowupWork(
          actor,
          { ...command, reason: "Staff abandoned this retained attempt." },
          options,
        ),
    };
  const bundleHash = work.preparedBundle!.bundleHash;
  return {
    invoke: (options?: EngineeringMutationOptions) =>
      f.app.rejectEngineeringFollowupBundle(
        actor,
        { ...command, bundleHash, reason: "Staff rejected this exact bundle." },
        options,
      ),
  };
}

for (const [name, createStore] of engineeringFollowupStores) {
  describe(`follow-up mutation host boundary (${name})`, () => {
    it.each(operations)(
      "refuses late host authority loss during actual Store reads for %s",
      async (operation) => {
        const f = await engineeringFollowupFixture(createStore());
        const command = await mutation(f, operation);
        const before = await f.rows();
        const transactions = f.observed.transactions.length;
        const barrier = engineeringFollowupBarrier();
        let current = true;
        let armed = true;
        f.readObserver.afterRead(async (trace) => {
          if (
            !armed ||
            trace.collection !== supportRecords.name ||
            trace.method !== "getVersioned"
          )
            return;
          armed = false;
          await barrier.wait();
        });
        const denied = new SupportDeskAuthorizationError(
          supportPermissions.engineeringFollowupReview,
        );
        const guard = vi.fn(async () => {
          if (!current) throw denied;
        });
        const replaced = vi.fn(async () => {});
        const options = { verifyBeforeCommit: guard };
        const settled = command.invoke(options).then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
        await waitForFollowupHook(barrier, settled);
        current = false;
        options.verifyBeforeCommit = replaced;
        barrier.release();
        expect(await settled).toEqual({ error: denied });
        expect(guard).toHaveBeenCalledOnce();
        expect(replaced).not.toHaveBeenCalled();
        f.readObserver.afterRead(undefined);
        expect(await f.rows()).toEqual(before);
        expect(f.observed.transactions).toHaveLength(transactions);
      },
    );

    it.each(operations)(
      "rechecks the original %s caller's grants after the awaited host guard",
      async (operation) => {
        const f = await engineeringFollowupFixture(createStore());
        const actor = { ...staff, permissions: [...staff.permissions] };
        const command = await mutation(f, operation, actor);
        const before = await f.rows();
        const transactions = f.observed.transactions.length;
        const guard = vi.fn(async () => {
          actor.permissions = [];
        });
        await expect(
          command.invoke({ verifyBeforeCommit: guard }),
        ).rejects.toThrow(SupportDeskAuthorizationError);
        expect(guard).toHaveBeenCalledOnce();
        expect(await f.rows()).toEqual(before);
        expect(f.observed.transactions).toHaveLength(transactions);
      },
    );

    it.each(["observe", "retry", "prepare"] as const)(
      "keeps %s trusted proof expiry after the final host await",
      async (operation) => {
        const f = await engineeringFollowupFixture(createStore());
        const command = await mutation(f, operation);
        const before = await f.rows();
        const transactions = f.observed.transactions.length;
        await expect(
          command.invoke({
            verifyBeforeCommit: async () => {
              f.advance(61_000);
            },
          }),
        ).rejects.toThrow(SupportDeskConflictError);
        expect(await f.rows()).toEqual(before);
        expect(f.observed.transactions).toHaveLength(transactions);
      },
    );

    it.each(operations)(
      "cancels %s after receipt lookup and before new private proof",
      async (operation) => {
        const f = await engineeringFollowupFixture(createStore());
        const command = await mutation(f, operation);
        const before = await f.rows();
        const transactions = f.observed.transactions.length;
        const proofCalls =
          f.verifyInput.mock.calls.length +
          f.confirm.mock.calls.length +
          f.checksVerify.mock.calls.length;
        f.readObserver.reads.length = 0;
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
        expect(
          f.readObserver.reads.filter(
            (trace) => trace.method === "getVersioned",
          ),
        ).toEqual([]);
        expect(
          f.verifyInput.mock.calls.length +
            f.confirm.mock.calls.length +
            f.checksVerify.mock.calls.length,
        ).toBe(proofCalls);
        expect(await f.rows()).toEqual(before);
        expect(f.observed.transactions).toHaveLength(transactions);
      },
    );

    it.each(operations)(
      "asserts the returned current configuration proof at the final %s handoff",
      async (operation) => {
        const f = await engineeringFollowupFixture(createStore());
        const command = await mutation(f, operation);
        const before = await f.rows();
        const transactions = f.observed.transactions.length;
        let configuration = "original";
        const changed = new SupportDeskConflictError(
          "Original host configuration changed",
        );
        const proof = vi.fn((): true => {
          if (configuration !== "original") throw changed;
          return true;
        });
        const guard = vi.fn(async () => {
          queueMicrotask(() => {
            configuration = "changed";
          });
          return proof;
        });
        await expect(
          command.invoke({ verifyBeforeCommit: guard }),
        ).rejects.toBe(changed);
        expect(guard).toHaveBeenCalledOnce();
        expect(proof).toHaveBeenCalledOnce();
        expect(await f.rows()).toEqual(before);
        expect(f.observed.transactions).toHaveLength(transactions);
      },
    );

    it.each(operations)(
      "rechecks %s host authority on each actual OCC retry",
      async (operation) => {
        const f = await engineeringFollowupFixture(createStore());
        const command = await mutation(f, operation);
        const before = await f.rows();
        let current = true;
        const denied = new SupportDeskAuthorizationError(
          supportPermissions.engineeringFollowupReview,
        );
        const guard = vi.fn(async () => {
          if (!current) throw denied;
        });
        const outcomes: boolean[] = [];
        f.observed.intercept(async (_trace, commit) => {
          const records = f.backing.collection(supportRecords);
          const ticket = await records.getVersioned({
            partition: "ticket",
            id: "ticket",
          });
          if (ticket === null) throw new Error("Actual ticket disappeared");
          expect(
            await records.putIfUnchanged(ticket.value, ticket.version),
          ).toBe(true);
          current = false;
          const outcome = await commit();
          outcomes.push(outcome.committed);
          return outcome;
        });
        await expect(
          command.invoke({ verifyBeforeCommit: guard }),
        ).rejects.toBe(denied);
        expect(outcomes).toEqual([false]);
        expect(guard).toHaveBeenCalledTimes(2);
        expect(await f.rows()).toEqual(before);
      },
    );

    it.each(operations)(
      "keeps legacy %s acceptance and recovers a lost ACK before obsolete host guard or cancellation",
      async (operation) => {
        const f = await engineeringFollowupFixture(createStore());
        const command = await mutation(f, operation);
        const before = await f.rows();
        const lost = new Error("Synthetic real committed follow-up ACK lost");
        f.observed.intercept(async (_trace, commit) => {
          const outcome = await commit();
          if (outcome.committed) throw lost;
          return outcome;
        });
        await expect(command.invoke()).rejects.toBe(lost);
        f.observed.intercept(undefined);
        const committed = await f.rows();
        const receipt = committed.find(
          (row) =>
            row.kind === "engineering_followup_receipt" &&
            !before.some((old) => old.id === row.id),
        );
        if (receipt?.kind !== "engineering_followup_receipt")
          throw new Error("Actual accepted mutation receipt missing");
        const transactions = f.observed.transactions.length;
        const inaccessible = new Error(
          "New private proof must not run for an accepted command",
        );
        f.readObserver.afterRead(async (trace) => {
          if (
            trace.method !== "get" ||
            trace.key === null ||
            typeof trace.key !== "object" ||
            !("id" in trace.key) ||
            trace.key.id !== receipt.id
          )
            throw inaccessible;
        });
        const controller = new AbortController();
        controller.abort();
        const guard = vi.fn(async () => {
          throw inaccessible;
        });
        await expect(
          command.invoke({
            signal: controller.signal,
            verifyBeforeCommit: guard,
          }),
        ).resolves.toEqual(receipt.result);
        expect(guard).not.toHaveBeenCalled();
        f.readObserver.afterRead(undefined);
        expect(await f.rows()).toEqual(committed);
        expect(f.observed.transactions).toHaveLength(transactions);
      },
    );

    it.each(["observe", "prepare"] as const)(
      "settles cancellation while %s host verification remains deferred",
      async (operation) => {
        const f = await engineeringFollowupFixture(createStore());
        const command = await mutation(f, operation);
        const before = await f.rows();
        const transactions = f.observed.transactions.length;
        const barrier = engineeringFollowupBarrier();
        const controller = new AbortController();
        const settled = command
          .invoke({
            signal: controller.signal,
            verifyBeforeCommit: () => barrier.wait(),
          })
          .catch((error: unknown) => error);
        await waitForFollowupHook(barrier, settled);
        try {
          controller.abort();
          await expect(settled).resolves.toMatchObject({ name: "AbortError" });
        } finally {
          barrier.release();
        }
        expect(await f.rows()).toEqual(before);
        expect(f.observed.transactions).toHaveLength(transactions);
      },
    );

    it("does not mistake a post-commit caller-authority denial for absence of the accepted mutation", async () => {
      const f = await engineeringFollowupFixture(createStore());
      const permissions = [...staff.permissions];
      const actor = { ...staff, permissions: [...permissions] };
      const command = await mutation(f, "abandon", actor);
      const before = await f.rows();
      f.observed.intercept(async (_trace, commit) => {
        const outcome = await commit();
        if (outcome.committed) actor.permissions = [];
        return outcome;
      });
      const guard = vi.fn(async () => {});
      await expect(
        command.invoke({ verifyBeforeCommit: guard }),
      ).rejects.toThrow(SupportDeskAuthorizationError);
      f.observed.intercept(undefined);
      const committed = await f.rows();
      const receipt = committed.find(
        (row) =>
          row.kind === "engineering_followup_receipt" &&
          !before.some((old) => old.id === row.id),
      );
      if (receipt?.kind !== "engineering_followup_receipt")
        throw new Error("Actual committed receipt was lost");
      actor.permissions = [...permissions];
      await expect(
        command.invoke({ verifyBeforeCommit: guard }),
      ).resolves.toEqual(receipt.result);
      expect(guard).toHaveBeenCalledOnce();
      expect(await f.rows()).toEqual(committed);
    });

    for (const path of ["application-owned", "legacy"] as const) {
      for (const expiry of ["receipt", "release"] as const) {
        const withShorterFinalProof = (
          f: Awaited<ReturnType<typeof engineeringFollowupAiFixture>>,
        ) => {
          let releaseChecks = 0;
          let receiptChecks = 0;
          const observed = { shortened: false };
          const { reassessEngineeringFollowupBundle: _optional, ...legacy } =
            f.app;
          const followup = createSupportDeskReleaseFollowup({
            ...f.baseOptions,
            application: path === "application-owned" ? f.app : legacy,
            releaseEvidence: {
              ...f.baseOptions.releaseEvidence,
              async confirm(...args) {
                const proof = await f.baseOptions.releaseEvidence.confirm(
                  ...args,
                );
                releaseChecks += 1;
                if (proof === null || expiry !== "release" || releaseChecks < 2)
                  return proof;
                observed.shortened = true;
                return {
                  ...proof,
                  attestation: {
                    ...proof.attestation,
                    validUntil: new Date(
                      Date.parse(f.clock.now()) + 1_000,
                    ).toISOString(),
                  },
                };
              },
            },
            checks: {
              ...f.baseOptions.checks,
              async verify(...args) {
                const receipt = await f.baseOptions.checks.verify(...args);
                receiptChecks += 1;
                if (
                  receipt === null ||
                  expiry !== "receipt" ||
                  receiptChecks < 2
                )
                  return receipt;
                observed.shortened = true;
                return {
                  ...receipt,
                  validUntil: new Date(
                    Date.parse(f.clock.now()) + 1_000,
                  ).toISOString(),
                };
              },
            },
          });
          return { followup, observed };
        };

        it.each(["host wait", "returned assertion"] as const)(
          `expires the fresher final ${expiry} across the ${path} %s`,
          async (boundary) => {
            const f = await engineeringFollowupAiFixture(createStore());
            const prepared = await f.prepareBundle();
            const before = await f.rows();
            const transactions = f.observed.transactions.length;
            const { followup, observed } = withShorterFinalProof(f);
            const host = vi.fn(async () => {
              if (boundary === "host wait") f.advance(1_500);
              return (): true => {
                if (boundary === "returned assertion") f.advance(1_500);
                return true;
              };
            });
            await expect(
              followup.prepareStaffReassessment(
                staff,
                {
                  ...f.command(`fresh-${expiry}-${path}-${boundary}`),
                  ...f.key,
                  expectedWorkGeneration: prepared.workGeneration,
                },
                { verifyBeforeCommit: host },
              ),
            ).rejects.toMatchObject({ category: "deadline" });
            expect(observed.shortened).toBe(true);
            expect(host).toHaveBeenCalledOnce();
            expect(await f.rows()).toEqual(before);
            expect(f.observed.transactions).toHaveLength(transactions);
          },
        );

        it(`permits the ${path} reassessment before its fresher final ${expiry} expires`, async () => {
          const f = await engineeringFollowupAiFixture(createStore());
          const prepared = await f.prepareBundle();
          const { followup, observed } = withShorterFinalProof(f);
          const result = await followup.prepareStaffReassessment(
            staff,
            {
              ...f.command(`current-${expiry}-${path}`),
              ...f.key,
              expectedWorkGeneration: prepared.workGeneration,
            },
            {
              verifyBeforeCommit: async () => {
                f.advance(500);
              },
            },
          );
          expect(observed.shortened).toBe(true);
          expect(result).toMatchObject({
            status: "bundle_prepared",
            workGeneration: prepared.workGeneration + 1,
          });
        });
      }
    }

    it("preserves paid-worker receipt recovery after a shorter final proof expires", async () => {
      const f = await engineeringFollowupAiFixture(createStore());
      expect(await f.followup.processWork(f.nextCommand())).toMatchObject({
        outcome: "candidate",
      });
      let verifies = 0;
      let lost = false;
      let committed: Awaited<ReturnType<typeof f.rows>> | undefined;
      const prepare = vi.fn<typeof f.app.prepareEngineeringFollowupBundle>(
        async (...args) => {
          const result = await f.app.prepareEngineeringFollowupBundle(...args);
          if (!lost) {
            lost = true;
            committed = await f.rows();
            f.advance(1_500);
            throw new Error(
              "Committed worker bundle ACK lost after final proof expiry",
            );
          }
          return result;
        },
      );
      const followup = createSupportDeskReleaseFollowup({
        ...f.baseOptions,
        application: { ...f.app, prepareEngineeringFollowupBundle: prepare },
        checks: {
          ...f.baseOptions.checks,
          async verify(...args) {
            const receipt = await f.baseOptions.checks.verify(...args);
            verifies += 1;
            return receipt === null || verifies < 2
              ? receipt
              : {
                  ...receipt,
                  validUntil: new Date(
                    Date.parse(f.clock.now()) + 1_000,
                  ).toISOString(),
                };
          },
        },
      });
      expect(await followup.processWork(f.nextCommand())).toMatchObject({
        outcome: "prepared",
      });
      expect(lost).toBe(true);
      expect(prepare).toHaveBeenCalledTimes(2);
      expect(f.generate).toHaveBeenCalledOnce();
      expect(await f.rows()).toEqual(committed);
    });

    it("keeps the shorter AI policy deadline across the new late host authority await", async () => {
      const f = await engineeringFollowupAiFixture(createStore());
      const prepared = await f.prepareBundle();
      const before = await f.rows();
      const transactions = f.observed.transactions.length;
      f.state.checkPolicy = {
        ...f.state.checkPolicy,
        validUntil: new Date(Date.parse(f.clock.now()) + 2_000).toISOString(),
      };
      const guard = vi.fn(async () => {
        f.advance(2_500);
      });
      await expect(
        f.followup.prepareStaffReassessment(
          staff,
          {
            ...f.command("ai-policy-deadline-after-authority"),
            ...f.key,
            expectedWorkGeneration: prepared.workGeneration,
          },
          { verifyBeforeCommit: guard },
        ),
      ).rejects.toMatchObject({ category: "deadline" });
      expect(guard).toHaveBeenCalledOnce();
      expect(await f.rows()).toEqual(before);
      expect(f.observed.transactions).toHaveLength(transactions);
    });

    it("forwards the public AI staff host proof assertion and recovers its real accepted ACK before fresh verification", async () => {
      const f = await engineeringFollowupAiFixture(createStore());
      const prepared = await f.prepareBundle();
      let lost = false;
      const prepare = vi.fn<typeof f.app.prepareEngineeringFollowupBundle>(
        async (...args) => {
          const result = await f.app.prepareEngineeringFollowupBundle(...args);
          if (!lost) {
            lost = true;
            throw new Error("Actual AI preparation ACK lost after commit");
          }
          return result;
        },
      );
      const { reassessEngineeringFollowupBundle: _optional, ...legacy } = f.app;
      const followup = createSupportDeskReleaseFollowup({
        ...f.baseOptions,
        application: { ...legacy, prepareEngineeringFollowupBundle: prepare },
      });
      const proof = vi.fn((): true => true);
      const guard = vi.fn(async () => proof);
      const command = {
        ...f.command("accepted-ai-reassessment-host-guard"),
        ...f.key,
        expectedWorkGeneration: prepared.workGeneration,
      };
      const accepted = await followup.prepareStaffReassessment(staff, command, {
        verifyBeforeCommit: guard,
      });
      expect(prepare).toHaveBeenCalledTimes(2);
      expect(guard).toHaveBeenCalledOnce();
      expect(proof).toHaveBeenCalledOnce();
      const rows = await f.rows();
      const checks = f.checksVerify.mock.calls.length;
      const obsolete = vi.fn(async () => {
        throw new Error("Fresh browser proof no longer available");
      });
      await expect(
        followup.prepareStaffReassessment(staff, command, {
          verifyBeforeCommit: obsolete,
        }),
      ).resolves.toEqual(accepted);
      expect(obsolete).not.toHaveBeenCalled();
      expect(f.checksVerify).toHaveBeenCalledTimes(checks);
      expect(await f.rows()).toEqual(rows);
    });

    it("refuses late host authority loss in public AI staff reassessment after its private proof", async () => {
      const f = await engineeringFollowupAiFixture(createStore());
      const prepared = await f.prepareBundle();
      const before = await f.rows();
      const transactions = f.observed.transactions.length;
      const checksBefore = f.checksVerify.mock.calls.length;
      const denied = new SupportDeskAuthorizationError(
        supportPermissions.engineeringFollowupReview,
      );
      const guard = vi.fn(async () => {
        expect(f.checksVerify.mock.calls.length).toBeGreaterThan(checksBefore);
        throw denied;
      });
      const followup = createSupportDeskReleaseFollowup(f.baseOptions);
      const barrier = engineeringFollowupBarrier();
      let armed = true;
      f.readObserver.afterRead(async (trace) => {
        if (!armed || trace.method !== "getVersioned") return;
        armed = false;
        await barrier.wait();
      });
      const replaced = vi.fn(async () => {});
      const options: { verifyBeforeCommit: () => Promise<void> } = {
        verifyBeforeCommit: guard,
      };
      const settled = followup
        .prepareStaffReassessment(
          staff,
          {
            ...f.command("guarded-ai-reassessment"),
            ...f.key,
            expectedWorkGeneration: prepared.workGeneration,
          },
          options,
        )
        .then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
      await waitForFollowupHook(barrier, settled);
      options.verifyBeforeCommit = replaced;
      barrier.release();
      expect(await settled).toHaveProperty("error");
      expect(guard).toHaveBeenCalled();
      expect(replaced).not.toHaveBeenCalled();
      f.readObserver.afterRead(undefined);
      expect(await f.rows()).toEqual(before);
      expect(f.observed.transactions).toHaveLength(transactions);
    });
  });
}
