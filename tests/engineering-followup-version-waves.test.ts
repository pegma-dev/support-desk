import {
  SupportDeskConflictError,
  supportRecords,
} from "@pegma/support-desk-application";
import { describe, expect, it } from "vitest";
import { engineeringFollowupAiFixture } from "../test/engineering-followup-ai-fixtures.js";
import {
  engineeringFollowupBarrier,
  engineeringFollowupStaff as staff,
  engineeringFollowupStores,
} from "../test/engineering-followup-fixtures.js";

type Fixture = Awaited<ReturnType<typeof engineeringFollowupAiFixture>>;
async function advanceVersion(f: Fixture, id: string) {
  const records = f.backing.collection(supportRecords);
  const row = await records.getVersioned({ partition: "ticket", id });
  if (row === null) throw new Error("Actual follow-up record missing");
  expect(await records.putIfUnchanged(row.value, row.version)).toBe(true);
}

function readWave(expected: number) {
  const entered: string[] = [];
  const allStarted = engineeringFollowupBarrier();
  const finish = engineeringFollowupBarrier();
  return {
    entered,
    async read(id: string) {
      entered.push(id);
      if (entered.length === expected) allStarted.release();
      await finish.wait();
    },
    async release() {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          allStarted.wait().then(() => true),
          new Promise<false>((resolve) => {
            timer = setTimeout(() => resolve(false), 2_000);
          }),
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        finish.release();
      }
    },
  };
}

for (const [name, createStore] of engineeringFollowupStores) {
  describe(`follow-up independent version waves (${name})`, () => {
    it("starts all four current Work version reads before any can finish", async () => {
      const f = await engineeringFollowupAiFixture(createStore());
      const prepared = await f.prepareBundle();
      const before = await f.rows();
      const wave = readWave(4);
      let workReads = 0;
      let closing = false;
      f.readObserver.afterRead(async (read) => {
        if (read.method !== "getVersioned") return;
        const id = (read.key as { id: string }).id;
        if (id === prepared.id && ++workReads === 2) closing = true;
        if (closing) await wave.read(id);
      });
      const settled = f.app.readEngineeringFollowupWork(staff, f.key);
      const concurrent = await wave.release();
      await expect(settled).resolves.toEqual(prepared);
      f.readObserver.afterRead(undefined);
      expect(concurrent).toBe(true);
      expect([...wave.entered].sort()).toEqual(
        [
          prepared.id,
          "engineering-followup-head",
          "ticket",
          "engineering-source",
        ].sort(),
      );
      expect(await f.rows()).toEqual(before);
    });

    it("starts all five observation version reads before any can finish", async () => {
      const f = await engineeringFollowupAiFixture(createStore());
      const prepared = await f.prepareBundle();
      const before = await f.rows();
      const wave = readWave(5);
      let closing = false;
      f.readObserver.afterRead(async (read) => {
        if (closing && read.method === "getVersioned")
          await wave.read((read.key as { id: string }).id);
      });
      const stop = new Error(
        "Read-only observation confirmed; no new mutation",
      );
      const settled = f.app.reassessEngineeringFollowupBundle!(
        staff,
        {
          ...f.command("concurrent-version-observation"),
          ...f.key,
          expectedWorkGeneration: prepared.workGeneration,
          recoveryIntentHash: "1".repeat(64),
        },
        async (observation) => {
          closing = true;
          await observation.confirm(staff);
          throw stop;
        },
      ).catch((error: unknown) => error);
      const concurrent = await wave.release();
      expect(await settled).toBe(stop);
      f.readObserver.afterRead(undefined);
      expect(concurrent).toBe(true);
      expect([...wave.entered].sort()).toEqual(
        [
          "engineering-source",
          `engineering-work:${prepared.association.engineeringSourceGeneration}`,
          prepared.id,
          "engineering-followup-head",
          "ticket",
        ].sort(),
      );
      expect(await f.rows()).toEqual(before);
    });

    it.each(["stale", "error"] as const)(
      "keeps an earlier Work %s ahead of a later independent read error",
      async (first) => {
        const f = await engineeringFollowupAiFixture(createStore());
        const prepared = await f.prepareBundle();
        const firstError = new Error("First Work version read failed");
        const laterError = new Error("Later head version read failed");
        let workReads = 0;
        let closing = false;
        let failedLater = false;
        f.readObserver.afterRead(async (read) => {
          if (read.method !== "getVersioned") return;
          const id = (read.key as { id: string }).id;
          if (id === prepared.id) {
            workReads += 1;
            if (workReads === 1 && first === "stale")
              await advanceVersion(f, prepared.id);
            if (workReads === 2) {
              closing = true;
              if (first === "error") throw firstError;
            }
          }
          if (closing && id === "engineering-followup-head" && !failedLater) {
            failedLater = true;
            throw laterError;
          }
        });
        if (first === "stale")
          await expect(
            f.app.readEngineeringFollowupWork(staff, f.key),
          ).resolves.toEqual(prepared);
        else
          await expect(
            f.app.readEngineeringFollowupWork(staff, f.key),
          ).rejects.toBe(firstError);
        f.readObserver.afterRead(undefined);
        expect(failedLater).toBe(true);
      },
    );

    it.each(["stale", "error"] as const)(
      "keeps an earlier observation Source %s ahead of a later read error",
      async (first) => {
        const f = await engineeringFollowupAiFixture(createStore());
        const prepared = await f.prepareBundle();
        const firstError = new Error("First Source version read failed");
        const laterError = new Error("Later observation head read failed");
        let closing = false;
        let failedLater = false;
        f.readObserver.afterRead(async (read) => {
          if (!closing || read.method !== "getVersioned") return;
          const id = (read.key as { id: string }).id;
          if (id === "engineering-source" && first === "error")
            throw firstError;
          if (id === "engineering-followup-head") {
            failedLater = true;
            throw laterError;
          }
        });
        const before = await f.rows();
        const result = await f.app.reassessEngineeringFollowupBundle!(
          staff,
          {
            ...f.command(`ordered-observation-${first}`),
            ...f.key,
            expectedWorkGeneration: prepared.workGeneration,
            recoveryIntentHash: "2".repeat(64),
          },
          async (observation) => {
            if (first === "stale")
              await advanceVersion(f, "engineering-source");
            closing = true;
            await observation.confirm(staff);
            throw new Error("Invalid closing observation accepted");
          },
        ).catch((error: unknown) => error);
        if (first === "stale") {
          expect(result).toBeInstanceOf(SupportDeskConflictError);
          expect(result).toHaveProperty(
            "message",
            "Follow-up observation changed",
          );
        } else expect(result).toBe(firstError);
        f.readObserver.afterRead(undefined);
        expect(failedLater).toBe(true);
        expect(await f.rows()).toEqual(before);
      },
    );
  });
}
