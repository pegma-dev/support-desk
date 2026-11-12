import { createSupportDeskReleaseFollowup } from "@pegma/support-desk-ai";
import {
  SupportDeskAuthorizationError,
  supportPermissions,
  supportRecords,
  type EngineeringFollowupPostObservation,
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
function pausedProof(
  f: Fixture,
  barrier: ReturnType<typeof engineeringFollowupBarrier>,
) {
  return createSupportDeskReleaseFollowup({
    ...f.baseOptions,
    checks: {
      ...f.baseOptions.checks,
      async verify(...args) {
        const result = await f.baseOptions.checks.verify(...args);
        await barrier.wait();
        return result;
      },
    },
  });
}
async function advanceVersion(backing: Store, id: string) {
  const records = backing.collection(supportRecords);
  const row = await records.getVersioned({ partition: "ticket", id });
  if (row === null) throw new Error("Actual posting record missing");
  expect(await records.putIfUnchanged(row.value, row.version)).toBe(true);
}

for (const [name, createStore] of engineeringFollowupStores) {
  describe(`follow-up posting operation observations (${name})`, () => {
    it("reuses the application's eligible post work and confirms opaque versions without full rehydration", async () => {
      const f = await engineeringFollowupAiFixture(createStore());
      const prepared = await f.prepareBundle();
      const command = await f.postCommand("observed-followup-post");
      const readWork = vi.fn(f.app.readEngineeringFollowupWork);
      const confirmCurrent = vi.fn(f.app.confirmEngineeringFollowupCurrent);
      const followup = createSupportDeskReleaseFollowup({
        ...f.baseOptions,
        application: {
          ...f.app,
          readEngineeringFollowupWork: readWork,
          confirmEngineeringFollowupCurrent: confirmCurrent,
        },
      });
      const host = vi.fn(async () => {});
      f.readObserver.reads.length = 0;
      await expect(
        followup.approveAndPostWebUpdate(staff, command, {
          verifyBeforeCommit: host,
        }),
      ).resolves.toMatchObject({
        messageId: command.messageId,
        bundleHash: command.bundleHash,
      });
      const versions = f.readObserver.reads
        .filter((read) => read.method === "getVersioned")
        .map((read) => (read.key as { id: string }).id);
      for (const id of [
        "engineering-source",
        "ticket",
        "engineering-followup-head",
        prepared.id,
        `engineering-work:${prepared.association.engineeringSourceGeneration}`,
      ])
        expect(
          versions.filter((value) => value === id),
          id,
        ).toHaveLength(3);
      expect(readWork).not.toHaveBeenCalled();
      expect(confirmCurrent).not.toHaveBeenCalled();
      expect(host).toHaveBeenCalledOnce();
      expect(f.generate).toHaveBeenCalledOnce();
      const before = await f.rows();
      await expect(
        followup.approveAndPostWebUpdate(staff, command, {
          verifyBeforeCommit: async () => {
            throw new Error("Fresh guard must not run on an accepted receipt");
          },
        }),
      ).resolves.toMatchObject({ messageId: command.messageId });
      expect(await f.rows()).toEqual(before);
    });

    it("keeps an ignored posting observation compatible with the original non-read posting grants", async () => {
      const f = await engineeringFollowupAiFixture(createStore());
      await f.prepareBundle();
      const command = await f.postCommand("legacy-nonread-post-guard");
      const actor = {
        ...staff,
        permissions: [
          supportPermissions.engineeringFollowupReview,
          supportPermissions.queueRead,
          supportPermissions.replyAny,
        ],
      };
      await expect(
        f.app.approveAndPostEngineeringFollowupWebUpdate(
          actor,
          command,
          async () => {},
        ),
      ).resolves.toMatchObject({ messageId: command.messageId });
    });

    it("binds the view to the original caller and expires it before the final browser authority check", async () => {
      const f = await engineeringFollowupAiFixture(createStore());
      const prepared = await f.prepareBundle();
      const command = await f.postCommand("scoped-post-observation");
      let captured: EngineeringFollowupPostObservation | undefined;
      await expect(
        f.app.approveAndPostEngineeringFollowupWebUpdate(
          staff,
          command,
          async (observation) => {
            if (observation === undefined)
              throw new Error("Actual application observation missing");
            captured = observation;
            expect(observation.readWork(staff)).toEqual(prepared);
            expect(() =>
              observation.readWork({
                ...staff,
                principalId: "another-authorized-reader",
              }),
            ).toThrow(SupportDeskAuthorizationError);
            await observation.confirm(staff);
            return (): true => true;
          },
          {
            verifyBeforeCommit: async () => {
              expect(() => captured!.readWork(staff)).toThrow("expired");
            },
          },
        ),
      ).resolves.toMatchObject({ messageId: command.messageId });
      expect(() => captured!.readWork(staff)).toThrow("expired");
      await expect(captured!.confirm(staff)).rejects.toThrow("expired");
    });

    it.each(["source", "association", "work", "head", "ticket"] as const)(
      "denies an opaque %s version change after the actual AI check receipt",
      async (record) => {
        const f = await engineeringFollowupAiFixture(createStore());
        const prepared = await f.prepareBundle();
        const command = await f.postCommand(`stale-post-${record}`);
        const barrier = engineeringFollowupBarrier();
        const followup = pausedProof(f, barrier);
        const host = vi.fn(async () => {});
        const settled = followup
          .approveAndPostWebUpdate(staff, command, { verifyBeforeCommit: host })
          .catch((error: unknown) => error);
        await waitForFollowupHook(barrier, settled);
        try {
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
        } finally {
          barrier.release();
        }
        await expect(settled).resolves.toMatchObject({
          category: "current_fence_changed",
        });
        expect(host).not.toHaveBeenCalled();
        expect((await f.work()).status).toBe("bundle_prepared");
        expect(
          (await f.app.readStaffTicket(staff, "ticket")).messages.some(
            (message) => message.id === command.messageId,
          ),
        ).toBe(false);
      },
    );

    it.each(["withdrawn", "restricted"] as const)(
      "checks the actual %s Source before reading any subsequent posting record",
      async (state) => {
        const f = await engineeringFollowupAiFixture(createStore());
        await f.prepareBundle();
        const command = await f.postCommand(`source-first-post-${state}`);
        const actor = {
          ...staff,
          permissions: staff.permissions.filter(
            (permission) =>
              permission !== supportPermissions.engineeringRestrictedRead,
          ),
        };
        const barrier = engineeringFollowupBarrier();
        const followup = pausedProof(f, barrier);
        const settled = followup
          .approveAndPostWebUpdate(actor, command)
          .catch((error: unknown) => error);
        await waitForFollowupHook(barrier, settled);
        let afterChange;
        try {
          if (state === "withdrawn")
            await f.app.withdrawEngineeringSource(staff, {
              ...f.command("withdraw-during-post-proof"),
              reason: "privacy_withdrawal",
            });
          else
            await f.app.submitEngineeringEvidence(staff, {
              ...f.command("restrict-during-post-proof"),
              expectedRevision: (await f.app.readStaffTicket(staff, "ticket"))
                .ticket.revision,
              security: "restricted",
              evidence: await f.support.reportInput(),
            });
          afterChange = await f.rows();
          f.readObserver.reads.length = 0;
        } finally {
          barrier.release();
        }
        await expect(settled).resolves.toMatchObject({
          category:
            state === "restricted"
              ? "authorization_unavailable"
              : "current_fence_changed",
        });
        expect(
          f.readObserver.reads.map((read) => (read.key as { id?: string }).id),
        ).toEqual(["engineering-source"]);
        expect(await f.rows()).toEqual(afterChange);
      },
    );

    it("rechecks closing read grants after the first opaque Source await", async () => {
      const f = await engineeringFollowupAiFixture(createStore());
      await f.prepareBundle();
      const command = await f.postCommand("closing-observation-read-grants");
      const actor = { ...staff, permissions: [...staff.permissions] };
      const before = await f.rows();
      const barrier = engineeringFollowupBarrier();
      const confirmed: string[] = [];
      let checking = false;
      f.readObserver.afterRead(async (read) => {
        if (!checking || read.method !== "getVersioned") return;
        const id = (read.key as { id: string }).id;
        confirmed.push(id);
        if (id === "engineering-source") await barrier.wait();
      });
      const settled = f.app
        .approveAndPostEngineeringFollowupWebUpdate(
          actor,
          command,
          async (observation) => {
            if (observation === undefined)
              throw new Error("Actual observation missing");
            observation.readWork(actor);
            checking = true;
            await observation.confirm(actor);
          },
        )
        .catch((error: unknown) => error);
      await waitForFollowupHook(barrier, settled);
      actor.permissions = actor.permissions.filter(
        (permission) =>
          permission !== supportPermissions.engineeringFollowupRead,
      );
      barrier.release();
      await expect(settled).resolves.toBeInstanceOf(
        SupportDeskAuthorizationError,
      );
      expect(confirmed).toEqual(["engineering-source"]);
      f.readObserver.afterRead(undefined);
      expect(await f.rows()).toEqual(before);
    });

    it("creates a fresh observation and host check after an actual final Ticket CAS conflict", async () => {
      const f = await engineeringFollowupAiFixture(createStore());
      await f.prepareBundle();
      const command = await f.postCommand("observed-post-occ-retry");
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
      await expect(
        f.followup.approveAndPostWebUpdate(staff, command, {
          verifyBeforeCommit: host,
        }),
      ).resolves.toMatchObject({ messageId: command.messageId });
      expect(outcomes).toEqual([false, true]);
      expect(host).toHaveBeenCalledTimes(2);
      expect(
        (await f.app.readStaffTicket(staff, "ticket")).messages.filter(
          (message) => message.id === command.messageId,
        ),
      ).toHaveLength(1);
    });

    it("retains current standalone reads for legacy structural application ports that omit the optional observation", async () => {
      const f = await engineeringFollowupAiFixture(createStore());
      await f.prepareBundle();
      const command = await f.postCommand("legacy-structural-post-port");
      const readWork = vi.fn(f.app.readEngineeringFollowupWork);
      const confirmCurrent = vi.fn(f.app.confirmEngineeringFollowupCurrent);
      const followup = createSupportDeskReleaseFollowup({
        ...f.baseOptions,
        application: {
          ...f.app,
          readEngineeringFollowupWork: readWork,
          confirmEngineeringFollowupCurrent: confirmCurrent,
          approveAndPostEngineeringFollowupWebUpdate(
            access,
            input,
            guard,
            options,
          ) {
            return f.app.approveAndPostEngineeringFollowupWebUpdate(
              access,
              input,
              () => guard(),
              options,
            );
          },
        },
      });
      await expect(
        followup.approveAndPostWebUpdate(staff, command),
      ).resolves.toMatchObject({ messageId: command.messageId });
      expect(readWork).toHaveBeenCalledTimes(2);
      expect(confirmCurrent).toHaveBeenCalledOnce();
    });
  });
}
