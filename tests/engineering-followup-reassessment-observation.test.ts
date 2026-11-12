import { createSupportDeskReleaseFollowup } from "@pegma/support-desk-ai";
import {
  supportPermissions,
  supportRecords,
  SupportDeskAuthorizationError,
  type EngineeringFollowupApplication,
  type EngineeringFollowupReassessmentObservation,
  type ReassessEngineeringFollowupBundleCommand,
} from "@pegma/support-desk-application";
import type { Store } from "@pegma/storage-core";
import { describe, expect, it, vi } from "vitest";
import {
  engineeringFollowupAiFixture,
  waitForFollowupHook,
} from "../test/engineering-followup-ai-fixtures.js";
import {
  engineeringFollowupStaff as staff,
  engineeringFollowupStores,
  engineeringFollowupBarrier,
} from "../test/engineering-followup-fixtures.js";

type Fixture = Awaited<ReturnType<typeof engineeringFollowupAiFixture>>;
type Reassess = NonNullable<
  EngineeringFollowupApplication["reassessEngineeringFollowupBundle"]
>;
async function advanceVersion(backing: Store, id: string) {
  const records = backing.collection(supportRecords);
  const row = await records.getVersioned({ partition: "ticket", id });
  if (row === null) throw new Error("Actual reassessment record missing");
  expect(await records.putIfUnchanged(row.value, row.version)).toBe(true);
}
function command(f: Fixture, workGeneration: number, label = "staff-reassess") {
  return {
    ...f.command(label),
    ...f.key,
    expectedWorkGeneration: workGeneration,
  };
}
function withApp(f: Fixture, reassess: Reassess) {
  return createSupportDeskReleaseFollowup({
    ...f.baseOptions,
    application: { ...f.app, reassessEngineeringFollowupBundle: reassess },
  });
}

for (const [name, createStore] of engineeringFollowupStores) {
  describe(`application-owned staff reassessment (${name})`, () => {
    it("reuses one authorized reassessment plan without repeated full views or model generation", async () => {
      const f = await engineeringFollowupAiFixture(createStore());
      const prepared = await f.prepareBundle();
      const read = vi.fn(f.app.readEngineeringFollowupReassessment);
      const followup = createSupportDeskReleaseFollowup({
        ...f.baseOptions,
        application: { ...f.app, readEngineeringFollowupReassessment: read },
      });
      const command = {
        ...f.command("observed-staff-reassessment"),
        ...f.key,
        expectedWorkGeneration: prepared.workGeneration,
      };
      const host = vi.fn(async () => {});
      f.readObserver.reads.length = 0;
      const result = await followup.prepareStaffReassessment(staff, command, {
        verifyBeforeCommit: host,
      });
      expect(result).toMatchObject({
        status: "bundle_prepared",
        workGeneration: prepared.workGeneration + 1,
      });
      const versions = f.readObserver.reads
        .filter((read) => read.method === "getVersioned")
        .map((read) => (read.key as { id: string }).id);
      expect(versions.filter((id) => id === "engineering-source")).toHaveLength(
        4,
      );
      for (const id of [
        "ticket",
        "engineering-followup-head",
        prepared.id,
        `engineering-work:${prepared.association.engineeringSourceGeneration}`,
      ])
        expect(
          versions.filter((value) => value === id),
          id,
        ).toHaveLength(3);
      expect(read).not.toHaveBeenCalled();
      expect(host).toHaveBeenCalledOnce();
      expect(f.generate).toHaveBeenCalledOnce();
      expect(
        (await f.app.readStaffTicket(staff, "ticket")).messages.some(
          (message) => message.id.startsWith("followup-notice:"),
        ),
      ).toBe(false);
    });

    it("recovers original accepted intent before planner, read grants, proof outages or App cancellation", async () => {
      const f = await engineeringFollowupAiFixture(createStore());
      const prepared = await f.prepareBundle();
      let original: ReassessEngineeringFollowupBundleCommand | undefined;
      const followup = withApp(f, async (access, input, planner, options) => {
        original = input;
        return f.app.reassessEngineeringFollowupBundle!(
          access,
          input,
          planner,
          options,
        );
      });
      const input = command(f, prepared.workGeneration);
      const accepted = await followup.prepareStaffReassessment(staff, input);
      await f.app.withdrawEngineeringSource(staff, {
        ...f.command("withdraw-after-reassessment"),
        reason: "privacy_withdrawal",
      });
      const before = await f.rows();
      f.releaseState.currentOutcome = "unavailable";
      f.state.checkPolicyOutcome = "unavailable";
      f.state.configurationOutcome = "disabled";
      const controller = new AbortController();
      controller.abort();
      const planner = vi.fn(async () => {
        throw new Error("Accepted intent must precede planning");
      });
      const guard = vi.fn(async () => {
        throw new Error("Accepted intent must precede host proof");
      });
      const reviewOnly = {
        ...staff,
        permissions: [
          supportPermissions.engineeringFollowupReview,
          supportPermissions.queueRead,
        ],
      };
      f.readObserver.reads.length = 0;
      await expect(
        f.app.reassessEngineeringFollowupBundle!(
          reviewOnly,
          original!,
          planner,
          { signal: controller.signal, verifyBeforeCommit: guard },
        ),
      ).resolves.toEqual(accepted);
      expect(planner).not.toHaveBeenCalled();
      expect(guard).not.toHaveBeenCalled();
      expect(
        f.readObserver.reads.filter((read) => read.method === "getVersioned"),
      ).toHaveLength(0);
      await expect(
        f.app.reassessEngineeringFollowupBundle!(
          reviewOnly,
          { ...original!, recoveryIntentHash: "0".repeat(64) },
          planner,
        ),
      ).rejects.toThrow();
      await expect(
        f.app.reassessEngineeringFollowupBundle!(
          { ...reviewOnly, permissions: [supportPermissions.queueRead] },
          original!,
          planner,
        ),
      ).rejects.toThrow(SupportDeskAuthorizationError);
      expect(await f.rows()).toEqual(before);
    });

    it("binds the callback view to the original caller and expires it before the late host boundary", async () => {
      const f = await engineeringFollowupAiFixture(createStore());
      const prepared = await f.prepareBundle();
      let captured: EngineeringFollowupReassessmentObservation | undefined;
      const followup = withApp(f, (access, input, planner, options) =>
        f.app.reassessEngineeringFollowupBundle!(
          access,
          input,
          async (observation) => {
            captured = observation;
            expect(observation.read(access).work).toEqual(prepared);
            expect(() =>
              observation.read({ ...access, principalId: "other-staff" }),
            ).toThrow(SupportDeskAuthorizationError);
            return planner(observation);
          },
          options,
        ),
      );
      const host = vi.fn(async () => {
        expect(() => captured!.read(staff)).toThrow("expired");
      });
      await followup.prepareStaffReassessment(
        staff,
        command(f, prepared.workGeneration),
        { verifyBeforeCommit: host },
      );
      expect(host).toHaveBeenCalledOnce();
      expect(() => captured!.read(staff)).toThrow("expired");
      await expect(captured!.confirm(staff)).rejects.toThrow("expired");
    });

    it.each(["source", "association", "work", "head", "ticket"] as const)(
      "refuses opaque %s changes during actual AI proof verification without replanning stale intent",
      async (record) => {
        const f = await engineeringFollowupAiFixture(createStore());
        const prepared = await f.prepareBundle();
        const barrier = engineeringFollowupBarrier();
        let first = true;
        const followup = createSupportDeskReleaseFollowup({
          ...f.baseOptions,
          checks: {
            ...f.baseOptions.checks,
            async verify(...args) {
              const checked = await f.baseOptions.checks.verify(...args);
              if (first) {
                first = false;
                await barrier.wait();
              }
              return checked;
            },
          },
        });
        const host = vi.fn(async () => {});
        const settled = followup
          .prepareStaffReassessment(
            staff,
            command(f, prepared.workGeneration),
            { verifyBeforeCommit: host },
          )
          .catch((error: unknown) => error);
        await waitForFollowupHook(barrier, settled);
        const id =
          record === "source"
            ? "engineering-source"
            : record === "association"
              ? `engineering-work:${prepared.association.engineeringSourceGeneration}`
              : record === "work"
                ? prepared.id
                : record === "head"
                  ? "engineering-followup-head"
                  : "ticket";
        await advanceVersion(f.backing, id);
        const before = await f.rows();
        const transactions = f.observed.transactions.length;
        barrier.release();
        await expect(settled).resolves.toBeInstanceOf(Error);
        expect(host).not.toHaveBeenCalled();
        expect(await f.rows()).toEqual(before);
        expect(f.observed.transactions).toHaveLength(transactions);
        expect(f.generate).toHaveBeenCalledOnce();
      },
    );

    it.each(["restricted", "withdrawn"] as const)(
      "checks the current %s Source before any protected reassessment view",
      async (state) => {
        const f = await engineeringFollowupAiFixture(createStore());
        const prepared = await f.prepareBundle();
        if (state === "withdrawn")
          await f.app.withdrawEngineeringSource(staff, {
            ...f.command("withdraw-before-reassessment"),
            reason: "privacy_withdrawal",
          });
        else
          await f.app.submitEngineeringEvidence(staff, {
            ...f.command("restrict-before-reassessment"),
            expectedRevision: (await f.app.readStaffTicket(staff, "ticket"))
              .ticket.revision,
            security: "restricted",
            evidence: await f.support.reportInput(),
          });
        const actor = {
          ...staff,
          permissions: staff.permissions.filter(
            (permission) =>
              permission !== supportPermissions.engineeringRestrictedRead,
          ),
        };
        const before = await f.rows();
        const host = vi.fn(async () => {});
        f.readObserver.reads.length = 0;
        await expect(
          f.followup.prepareStaffReassessment(
            actor,
            command(f, prepared.workGeneration),
            { verifyBeforeCommit: host },
          ),
        ).rejects.toThrow();
        expect(
          f.readObserver.reads
            .filter((read) => read.method === "getVersioned")
            .map((read) => (read.key as { id: string }).id),
        ).toEqual(["engineering-source"]);
        expect(host).not.toHaveBeenCalled();
        expect(await f.rows()).toEqual(before);
      },
    );

    it("rechecks current read permission after the independent closing version wave", async () => {
      const f = await engineeringFollowupAiFixture(createStore());
      const prepared = await f.prepareBundle();
      const actor = { ...staff, permissions: [...staff.permissions] };
      const before = await f.rows();
      const barrier = engineeringFollowupBarrier();
      let armed = false;
      const confirmed: string[] = [];
      const followup = withApp(f, (access, input, planner, options) =>
        f.app.reassessEngineeringFollowupBundle!(
          access,
          input,
          async (observation) => {
            const plan = await planner(observation);
            return {
              ...plan,
              async guard() {
                armed = true;
                return plan.guard();
              },
            };
          },
          options,
        ),
      );
      f.readObserver.afterRead(async (read) => {
        if (!armed || read.method !== "getVersioned") return;
        confirmed.push((read.key as { id: string }).id);
        await barrier.wait();
      });
      const settled = followup
        .prepareStaffReassessment(actor, command(f, prepared.workGeneration))
        .catch((error: unknown) => error);
      await waitForFollowupHook(barrier, settled);
      actor.permissions = actor.permissions.filter(
        (permission) =>
          permission !== supportPermissions.engineeringFollowupRead,
      );
      barrier.release();
      await expect(settled).resolves.toBeInstanceOf(Error);
      expect([...confirmed].sort()).toEqual(
        [
          "engineering-source",
          `engineering-work:${prepared.association.engineeringSourceGeneration}`,
          prepared.id,
          "engineering-followup-head",
          "ticket",
        ].sort(),
      );
      f.readObserver.afterRead(undefined);
      expect(await f.rows()).toEqual(before);
    });

    it("rebuilds the App-owned plan and late host guard after an actual conditional Ticket conflict", async () => {
      const f = await engineeringFollowupAiFixture(createStore());
      const prepared = await f.prepareBundle();
      const plans = vi.fn();
      const scopes: EngineeringFollowupReassessmentObservation[] = [];
      const followup = withApp(f, (access, input, planner, options) =>
        f.app.reassessEngineeringFollowupBundle!(
          access,
          input,
          (observation) => {
            plans();
            scopes.push(observation);
            return planner(observation);
          },
          options,
        ),
      );
      const outcomes: boolean[] = [];
      f.observed.intercept(async (_trace, commit) => {
        const outcome = await commit();
        outcomes.push(outcome.committed);
        return outcome;
      });
      const host = vi.fn(async () => {
        if (host.mock.calls.length === 1)
          await advanceVersion(f.backing, "ticket");
      });
      const accepted = await followup.prepareStaffReassessment(
        staff,
        command(f, prepared.workGeneration),
        { verifyBeforeCommit: host },
      );
      expect(accepted.workGeneration).toBe(prepared.workGeneration + 1);
      expect(outcomes).toEqual([false, true]);
      expect(plans).toHaveBeenCalledTimes(2);
      expect(host).toHaveBeenCalledTimes(2);
      expect(scopes[0]).not.toBe(scopes[1]);
      expect(() => scopes[0]!.read(staff)).toThrow("expired");
      expect(f.generate).toHaveBeenCalledOnce();
    });

    it("recovers a genuinely committed lost ACK without another planner, proof or host check", async () => {
      const f = await engineeringFollowupAiFixture(createStore());
      const prepared = await f.prepareBundle();
      const plans = vi.fn();
      let lost = false;
      const entry = vi.fn<Reassess>(async (access, input, planner, options) => {
        const accepted = await f.app.reassessEngineeringFollowupBundle!(
          access,
          input,
          (observation) => {
            plans();
            return planner(observation);
          },
          options,
        );
        if (!lost) {
          lost = true;
          throw new Error("Actual reassessment committed; ACK lost");
        }
        return accepted;
      });
      const followup = withApp(f, entry);
      const host = vi.fn(async () => {});
      const input = command(f, prepared.workGeneration);
      const accepted = await followup.prepareStaffReassessment(staff, input, {
        verifyBeforeCommit: host,
      });
      expect(entry).toHaveBeenCalledTimes(2);
      expect(plans).toHaveBeenCalledOnce();
      expect(host).toHaveBeenCalledOnce();
      const before = await f.rows();
      const checked = f.checksVerify.mock.calls.length;
      await expect(
        followup.prepareStaffReassessment(staff, input, {
          verifyBeforeCommit: async () => {
            throw new Error("Obsolete host proof");
          },
        }),
      ).resolves.toEqual(accepted);
      expect(f.checksVerify.mock.calls).toHaveLength(checked);
      expect(await f.rows()).toEqual(before);
      expect(f.generate).toHaveBeenCalledOnce();
    });

    it("preserves standalone current reads and the full legacy structural preparation path", async () => {
      const f = await engineeringFollowupAiFixture(createStore());
      const prepared = await f.prepareBundle();
      const { reassessEngineeringFollowupBundle: _optional, ...legacy } = f.app;
      const read = vi.fn(f.app.readEngineeringFollowupReassessment);
      const prepare = vi.fn(f.app.prepareEngineeringFollowupBundle);
      const followup = createSupportDeskReleaseFollowup({
        ...f.baseOptions,
        application: {
          ...legacy,
          readEngineeringFollowupReassessment: read,
          prepareEngineeringFollowupBundle: prepare,
        },
      });
      await expect(
        followup.prepareStaffReassessment(
          staff,
          command(f, prepared.workGeneration),
        ),
      ).resolves.toMatchObject({ status: "bundle_prepared" });
      expect(read).toHaveBeenCalledTimes(2);
      expect(prepare).toHaveBeenCalledOnce();
      expect(f.generate).toHaveBeenCalledOnce();
    });

    it("does not continue protected hydration after current Read authority disappears during the actual Ticket await", async () => {
      const f = await engineeringFollowupAiFixture(createStore());
      const prepared = await f.prepareBundle();
      const actor = { ...staff, permissions: [...staff.permissions] };
      const before = await f.rows();
      const barrier = engineeringFollowupBarrier();
      let armed = true;
      f.readObserver.reads.length = 0;
      f.readObserver.afterRead(async (read) => {
        if (
          !armed ||
          read.method !== "getVersioned" ||
          (read.key as { id: string }).id !== "ticket"
        )
          return;
        armed = false;
        await barrier.wait();
      });
      const settled = f.followup
        .prepareStaffReassessment(actor, command(f, prepared.workGeneration))
        .catch((error: unknown) => error);
      await waitForFollowupHook(barrier, settled);
      actor.permissions = actor.permissions.filter(
        (permission) =>
          permission !== supportPermissions.engineeringFollowupRead,
      );
      barrier.release();
      await expect(settled).resolves.toBeInstanceOf(Error);
      expect(
        f.readObserver.reads
          .filter((read) => read.method === "getVersioned")
          .map((read) => (read.key as { id: string }).id),
      ).toEqual(["engineering-source", "ticket"]);
      expect(f.readObserver.reads.some((read) => read.method === "list")).toBe(
        false,
      );
      f.readObserver.afterRead(undefined);
      expect(await f.rows()).toEqual(before);
    });

    it("honors cancellation at the late host await and refuses a returned stale synchronous configuration assertion", async () => {
      const f = await engineeringFollowupAiFixture(createStore());
      const prepared = await f.prepareBundle();
      const before = await f.rows();
      const transactions = f.observed.transactions.length;
      const barrier = engineeringFollowupBarrier();
      const controller = new AbortController();
      const settled = f.followup
        .prepareStaffReassessment(
          staff,
          command(f, prepared.workGeneration, "cancel-reassessment"),
          {
            signal: controller.signal,
            verifyBeforeCommit: async () => {
              await barrier.wait();
            },
          },
        )
        .catch((error: unknown) => error);
      await waitForFollowupHook(barrier, settled);
      controller.abort();
      await expect(settled).resolves.toMatchObject({ category: "cancelled" });
      barrier.release();
      await Promise.resolve();
      await expect(
        f.followup.prepareStaffReassessment(
          staff,
          command(f, prepared.workGeneration, "stale-config-reassessment"),
          {
            verifyBeforeCommit: async () => (): true => {
              throw new Error("Original host configuration changed");
            },
          },
        ),
      ).rejects.toThrow();
      expect(await f.rows()).toEqual(before);
      expect(f.observed.transactions).toHaveLength(transactions);
      expect(f.generate).toHaveBeenCalledOnce();
    });

    it("retains a real committed receipt after closing authority denial and recovers it once authority is restored", async () => {
      const f = await engineeringFollowupAiFixture(createStore());
      const prepared = await f.prepareBundle();
      const actor = { ...staff, permissions: [...staff.permissions] };
      const permissions = [...actor.permissions];
      let accepted = false;
      f.observed.intercept(async (_trace, commit) => {
        const outcome = await commit();
        if (outcome.committed) {
          accepted = true;
          actor.permissions = [];
        }
        return outcome;
      });
      const input = command(f, prepared.workGeneration);
      const host = vi.fn(async () => {});
      await expect(
        f.followup.prepareStaffReassessment(actor, input, {
          verifyBeforeCommit: host,
        }),
      ).rejects.toThrow();
      expect(accepted).toBe(true);
      f.observed.intercept(undefined);
      const committed = await f.rows();
      const receipt = committed.find(
        (row) =>
          row.kind === "engineering_followup_receipt" &&
          row.id === `engineering-followup-command:${input.commandId}`,
      );
      if (receipt?.kind !== "engineering_followup_receipt")
        throw new Error(
          "Actual reassessment receipt missing after closing denial",
        );
      actor.permissions = permissions;
      await expect(
        f.followup.prepareStaffReassessment(actor, input, {
          verifyBeforeCommit: async () => {
            throw new Error("Fresh proof unavailable");
          },
        }),
      ).resolves.toEqual(receipt.result);
      expect(host).toHaveBeenCalledOnce();
      expect(await f.rows()).toEqual(committed);
    });

    it.each(["restricted", "withdrawn"] as const)(
      "confirms a newly %s Source after the initial App release proof and before calling the planner",
      async (state) => {
        const f = await engineeringFollowupAiFixture(createStore());
        const prepared = await f.prepareBundle();
        const actor = {
          ...staff,
          permissions: staff.permissions.filter(
            (permission) =>
              permission !== supportPermissions.engineeringRestrictedRead,
          ),
        };
        const barrier = engineeringFollowupBarrier();
        const original = f.confirm.getMockImplementation()!;
        f.confirm.mockImplementationOnce(async (...args) => {
          const proof = await original(...args);
          await barrier.wait();
          return proof;
        });
        const planner = vi.fn();
        const followup = withApp(f, (access, input, plan, options) =>
          f.app.reassessEngineeringFollowupBundle!(
            access,
            input,
            (observation) => {
              planner();
              return plan(observation);
            },
            options,
          ),
        );
        const settled = followup
          .prepareStaffReassessment(actor, command(f, prepared.workGeneration))
          .catch((error: unknown) => error);
        await waitForFollowupHook(barrier, settled);
        if (state === "withdrawn")
          await f.app.withdrawEngineeringSource(staff, {
            ...f.command("withdraw-during-initial-release-proof"),
            reason: "privacy_withdrawal",
          });
        else
          await f.app.submitEngineeringEvidence(staff, {
            ...f.command("restrict-during-initial-release-proof"),
            expectedRevision: (await f.app.readStaffTicket(staff, "ticket"))
              .ticket.revision,
            security: "restricted",
            evidence: await f.support.reportInput(),
          });
        const before = await f.rows();
        f.readObserver.reads.length = 0;
        barrier.release();
        await expect(settled).resolves.toBeInstanceOf(Error);
        expect(planner).not.toHaveBeenCalled();
        expect(
          f.readObserver.reads
            .filter((read) => read.method === "getVersioned")
            .map((read) => (read.key as { id: string }).id),
        ).toEqual(["engineering-source"]);
        expect(await f.rows()).toEqual(before);
      },
    );
  });
}
