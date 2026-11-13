import type { Store } from "@pegma/storage-core";
import type { VerifiedEngineeringFollowupRetest } from "@pegma/support-desk-application";
import { describe, expect, it, vi } from "vitest";
import {
  engineeringFollowupFixture,
  engineeringFollowupStores,
  engineeringFollowupStaff,
} from "../test/engineering-followup-fixtures.js";

async function fixture(store: Store) {
  let f!: Awaited<ReturnType<typeof engineeringFollowupFixture>>;
  const state = {
    nullObservation: false,
    denied: false,
    mutateReturnedMetadata: false,
    afterConfirm: undefined as (() => Promise<void>) | undefined,
    events: [] as string[],
  };
  const verify = vi.fn(async (...args: Parameters<typeof f.retestVerify>) =>
    f.retestVerify(...args),
  );
  const observe = vi.fn(async (...args: Parameters<typeof f.retestVerify>) => {
    state.events.push("observe");
    if (state.nullObservation) return null;
    const verified = await f.retestVerify(...args);
    if (verified === null) return null;
    let consumed = false;
    return {
      verified,
      async confirm(signal: AbortSignal) {
        state.events.push("confirm");
        if (consumed || signal.aborted || state.denied)
          throw new Error("Current retest report denied");
        consumed = true;
        if (state.mutateReturnedMetadata)
          (
            verified as { result: VerifiedEngineeringFollowupRetest["result"] }
          ).result = "failed";
        await state.afterConfirm?.();
        return (): true => {
          state.events.push("assert");
          if (signal.aborted || state.denied)
            throw new Error("Closing retest proof denied");
          return true;
        };
      },
    };
  });
  f = await engineeringFollowupFixture(store, {
    observe: true,
    followup: { retestReceipts: { verify, observe } },
  });
  await f.prepareBundle();
  const binding = await f.retestBinding();
  const receiptReference = f.trust.issueRetest(
    "actual-retained-retest-proof",
    binding,
  );
  const command = {
    ...f.command("observed-retest-submission"),
    ...f.key,
    retestRequestId: binding.requestId,
    receiptReference,
  };
  return { f, state, verify, observe, command };
}

for (const [name, createStore] of engineeringFollowupStores) {
  describe(`callback-scoped retest observation (${name})`, () => {
    it("confirms the actual observation before the original browser fence and synchronous CAS proof", async () => {
      const t = await fixture(createStore());
      const result = await t.f.app.submitEngineeringFollowupRetestResult(
        engineeringFollowupStaff,
        t.command,
        {
          verifyBeforeCommit: async () => {
            t.state.events.push("browser");
          },
        },
      );
      expect(result.outcome).toBe("recorded");
      expect(t.state.events).toEqual([
        "observe",
        "confirm",
        "browser",
        "assert",
      ]);
      expect(t.verify).not.toHaveBeenCalled();
      t.state.nullObservation = true;
      expect(
        await t.f.app.submitEngineeringFollowupRetestResult(
          engineeringFollowupStaff,
          t.command,
        ),
      ).toEqual(result);
      expect(t.observe).toHaveBeenCalledOnce();
    });

    it("snapshots preliminary metadata and never bypasses an unavailable optional observation", async () => {
      const t = await fixture(createStore());
      t.state.nullObservation = true;
      const before = await t.f.work();
      await expect(
        t.f.app.submitEngineeringFollowupRetestResult(
          engineeringFollowupStaff,
          t.command,
        ),
      ).rejects.toThrow();
      expect(t.verify).not.toHaveBeenCalled();
      expect(await t.f.work()).toEqual(before);
      t.state.nullObservation = false;
      t.state.mutateReturnedMetadata = true;
      expect(
        await t.f.app.submitEngineeringFollowupRetestResult(
          engineeringFollowupStaff,
          t.command,
        ),
      ).toMatchObject({ result: "passed" });
      expect((await t.f.work()).retestResults[0]?.result).toBe("passed");
    });

    it("rejects preliminary success when confirmation fails without invoking the browser commit callback", async () => {
      const t = await fixture(createStore());
      t.state.denied = true;
      const browser = vi.fn(async () => {});
      await expect(
        t.f.app.submitEngineeringFollowupRetestResult(
          engineeringFollowupStaff,
          t.command,
          { verifyBeforeCommit: browser },
        ),
      ).rejects.toThrow();
      expect(browser).not.toHaveBeenCalled();
      expect((await t.f.work()).retestResults).toEqual([]);
    });

    it("asserts confirmation again after a late browser await before any transaction", async () => {
      const t = await fixture(createStore());
      await expect(
        t.f.app.submitEngineeringFollowupRetestResult(
          engineeringFollowupStaff,
          t.command,
          {
            verifyBeforeCommit: async () => {
              t.state.denied = true;
            },
          },
        ),
      ).rejects.toThrow();
      expect((await t.f.work()).retestResults).toEqual([]);
    });

    it("checks the returned assertion at CAS when the optional browser callback is omitted", async () => {
      const t = await fixture(createStore());
      t.state.afterConfirm = async () => { t.state.denied = true; };
      await expect(t.f.app.submitEngineeringFollowupRetestResult(engineeringFollowupStaff, t.command)).rejects.toThrow();
      expect((await t.f.work()).retestResults).toEqual([]);
    });

    it("gets a fresh single-use observation after an actual concurrent application mutation", async () => {
      const t = await fixture(createStore());
      t.state.afterConfirm = async () => {
        t.state.afterConfirm = undefined;
        const work = await t.f.work();
        await t.f.app.abandonEngineeringFollowupWork(engineeringFollowupStaff, {
          ...t.f.command("concurrent-retest-proof-attempt"),
          ...t.f.key,
          expectedWorkGeneration: work.workGeneration,
          reason: "staff_hold",
        });
      };
      expect(
        await t.f.app.submitEngineeringFollowupRetestResult(
          engineeringFollowupStaff,
          t.command,
        ),
      ).toMatchObject({ result: "passed" });
      expect(t.observe).toHaveBeenCalledTimes(2);
      expect(
        t.state.events.filter((event) => event === "confirm"),
      ).toHaveLength(2);
      expect((await t.f.work()).status).toBe("held");
    });
  });
}
