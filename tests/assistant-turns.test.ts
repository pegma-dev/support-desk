import {
  supportRecords,
  type AssistantTurnKey,
  type SupportRecord,
} from "@pegma/support-desk-application";
import { describe, expect, it } from "vitest";
import {
  assistantTurnFixture,
  observeAssistantScans,
  type AssistantScanPage,
} from "../test/assistant-turn-fixtures.js";
import {
  handlingAgent as agent,
  handlingCustomer as customer,
  handlingFixture,
  handlingStores,
} from "../test/handling-fixtures.js";

for (const [name, createStore] of handlingStores) {
  describe(`durable assistant turn ingress and discovery (${name})`, () => {
    it("commits one discoverable turn with its signed-in web message, audit, receipt and quota", async () => {
      const f = assistantTurnFixture(createStore());
      const created = await f.create();
      const rows = await f.rows();
      expect(rows).toHaveLength(7);
      const jobs = rows.filter((row) => row.kind === "assistant_turn");
      expect(jobs).toHaveLength(1);
      const key = await f.candidate();
      expect(jobs[0]).toMatchObject({
        partition: "ticket",
        id: `assistant-turn:${key.turnId}`,
        ticketId: "ticket",
        turnId: key.turnId,
        status: "pending",
        attempt: 0,
      });
      const transactions = f.observed.transactions.filter(
        (trace) => trace.collection === supportRecords.name,
      );
      expect(transactions).toHaveLength(1);
      expect(transactions[0]?.partition).toBe("ticket");
      expect(
        transactions[0]?.actions
          .filter((action) => action.action !== "delete")
          .map((action) => (action.value as SupportRecord).kind),
      ).toEqual(
        expect.arrayContaining([
          "ticket",
          "ticket_quota",
          "message",
          "audit",
          "command",
          "assistant_turn",
        ]),
      );
      expect(created.messages).toHaveLength(1);
      const input = f.createInput();
      await expect(
        f.app.createCustomerTicket(
          { ...customer, principalId: "unrelated-customer" },
          input,
        ),
      ).rejects.toThrow();
      expect(await f.rows()).toEqual(rows);
    });

    it("commits a new turn with each eligible web follow-up and never adds a scheduling transaction", async () => {
      const f = assistantTurnFixture(createStore());
      await f.create();
      const before = await f.rows();
      f.observed.transactions.length = 0;
      await f.app.replyToCustomerTicket(customer, {
        ...f.command("web-follow-up"),
        messageId: "follow-up",
        body: "Can I export the current workspace?",
      });
      const rows = await f.rows();
      expect(rows).toHaveLength(before.length + 4);
      expect(rows.filter((row) => row.kind === "assistant_turn")).toHaveLength(
        2,
      );
      const transactions = f.observed.transactions.filter(
        (trace) => trace.collection === supportRecords.name,
      );
      expect(transactions).toHaveLength(1);
      expect(
        transactions[0]?.actions
          .filter((action) => action.action !== "delete")
          .map((action) => (action.value as SupportRecord).kind),
      ).toEqual(
        expect.arrayContaining([
          "ticket",
          "ticket_quota",
          "message",
          "audit",
          "command",
          "assistant_turn",
        ]),
      );
    });

    it.each(["create", "reply"] as const)(
      "replays %s after a lost durable acknowledgment without manufacturing a second job",
      async (operation) => {
        const f = assistantTurnFixture(createStore());
        if (operation === "reply") await f.create();
        const input = f.createInput();
        const followUp = {
          ...f.command("lost-ack-follow-up"),
          messageId: "follow-up",
          body: "One more export question",
        };
        const invoke = () =>
          operation === "create"
            ? f.app.createCustomerTicket(customer, input)
            : f.app.replyToCustomerTicket(customer, followUp);
        let dropped = false;
        f.observed.intercept(async (trace, commit) => {
          const result = await commit();
          if (
            !dropped &&
            result.committed &&
            trace.collection === supportRecords.name &&
            trace.actions.some(
              (action) =>
                action.action !== "delete" &&
                (action.value as SupportRecord).kind === "assistant_turn",
            )
          ) {
            dropped = true;
            throw new Error("Synthetic lost transaction acknowledgment");
          }
          return result;
        });
        await invoke().catch(() => undefined);
        f.observed.intercept(undefined);
        expect(dropped).toBe(true);
        const committed = await f.rows();
        const replay = await invoke();
        expect(await invoke()).toEqual(replay);
        expect(await f.rows()).toEqual(committed);
        expect(
          committed.filter((row) => row.kind === "assistant_turn"),
        ).toHaveLength(operation === "create" ? 1 : 2);
        expect(
          (await f.app.readCustomerTicket(customer, "ticket")).messages,
        ).toHaveLength(operation === "create" ? 1 : 2);
      },
    );

    it("preserves the base application when durable turns are absent and skips human-only tickets", async () => {
      const legacy = handlingFixture(createStore());
      await legacy.create();
      expect(await legacy.rows()).toHaveLength(6);
      await expect(
        legacy.app.scanAssistantTurnCandidates(agent, { limit: 100 }),
      ).rejects.toMatchObject({ name: "SupportDeskConflictError" });
      const human = assistantTurnFixture(createStore());
      await human.create(false);
      expect(await human.rows()).toHaveLength(6);
      expect(
        (await human.app.scanAssistantTurnCandidates(agent, { limit: 100 }))
          .candidates,
      ).toEqual([]);
    });

    it("counts physical rows before filtering and forwards exactly one opaque adapter page per call", async () => {
      const scans = observeAssistantScans(createStore());
      const f = assistantTurnFixture(scans.store);
      await f.create(false, "human-1");
      await f.create(false, "human-2");
      await f.create(true, "assistant");
      let physical = 0;
      let actualPageRows = 0;
      scans.transformPage((page) => {
        actualPageRows = page.records.length;
        return page;
      });
      const candidates: AssistantTurnKey[] = [];
      let cursor: string | undefined;
      for (let pageNumber = 0; pageNumber < 32; pageNumber += 1) {
        const callsBefore = scans.calls.length;
        const page = await f.app.scanAssistantTurnCandidates(agent, {
          limit: 2,
          ...(cursor === undefined ? {} : { cursor }),
        });
        expect(scans.calls).toHaveLength(callsBefore + 1);
        expect(scans.calls.at(-1)).toEqual({
          limit: 2,
          ...(cursor === undefined ? {} : { cursor }),
        });
        expect(page.pages).toBe(1);
        expect(page.physicalRows).toBe(actualPageRows);
        expect(page.physicalRows).toBeLessThanOrEqual(2);
        physical += page.physicalRows;
        candidates.push(...page.candidates);
        if (page.nextCursor === null) break;
        cursor = page.nextCursor;
        if (pageNumber === 31)
          throw new Error("Scan did not finish within fixture bound");
      }
      expect(physical).toBe(19);
      expect(candidates).toHaveLength(1);
      expect(candidates[0]?.ticketId).toBe("assistant");
    });

    it.each(["physical key", "invalid job"] as const)(
      "fails closed on an adapter-returned %s instead of claiming another ticket",
      async (corruption) => {
        const backing = createStore();
        const scans = observeAssistantScans(backing);
        const f = assistantTurnFixture(scans.store);
        await f.create();
        const before = await f.rows();
        scans.transformPage(
          (page) =>
            ({
              ...page,
              records: page.records.map((entry) =>
                entry.value.kind !== "assistant_turn"
                  ? entry
                  : corruption === "physical key"
                    ? {
                        ...entry,
                        key: { ...entry.key, partition: "foreign-ticket" },
                      }
                    : { ...entry, value: { ...entry.value, attempt: -1 } },
              ),
            }) as AssistantScanPage,
        );
        await expect(
          f.app.scanAssistantTurnCandidates(agent, { limit: 100 }),
        ).rejects.toThrow();
        expect(await f.rows()).toEqual(before);
      },
    );
  });
}
