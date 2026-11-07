import {
  createSupportDeskApplication,
  type SupportRecord,
} from "@pegma/support-desk-application";
import { describe, expect, it } from "vitest";
import {
  handlingAgent as agent,
  handlingBarrier,
  handlingCustomer as customer,
  handlingFixture,
  handlingStaff as staff,
  handlingStores,
} from "../test/handling-fixtures.js";

for (const [name, createStore] of handlingStores) {
  describe(`handling real-Store concurrency (${name})`, () => {
    it("rejects a delayed assistant transaction after a committed human takeover", async () => {
      const backing = createStore();
      const f = handlingFixture(backing);
      await f.create();
      const stale = await f.assistantInput();
      const gate = handlingBarrier();
      let paused = false;
      f.observed.intercept(async (trace, commit) => {
        if (
          !paused &&
          trace.actions.some(
            (action) =>
              action.action !== "delete" &&
              (action.value as SupportRecord).kind === "message",
          )
        ) {
          paused = true;
          await gate.wait();
        }
        return commit();
      });
      const pending = f.app.replyAsAssistant(agent, stale).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      let afterTakeover;
      try {
        await Promise.race([
          gate.reached,
          pending.then(() => {
            throw new Error(
              "Assistant did not reach its real transaction barrier",
            );
          }),
        ]);
        const other = createSupportDeskApplication({
          store: backing,
          clock: f.clock,
          assistantHandlingEnabled: true,
        });
        await other.takeOverTicket(staff, {
          ...f.command("takeover-race"),
          expectedRevision: stale.expectedRevision,
          expectedHandlingGeneration: stale.expectedHandlingGeneration,
        });
        afterTakeover = await f.rows();
      } finally {
        gate.release();
      }
      const result = await pending;
      f.observed.intercept(undefined);
      expect(result).toHaveProperty("error");
      expect(await f.rows()).toEqual(afterTakeover);
      expect(
        (await f.app.readStaffTicket(staff, "ticket")).ticket.handling?.state,
      ).toBe("human-active");
      expect(
        (await f.app.readCustomerTicket(customer, "ticket")).messages,
      ).toHaveLength(1);
    });

    it.each(["private note", "visible customer reply"] as const)(
      "rechecks the last visible message after an interleaved %s",
      async (change) => {
        const backing = createStore();
        const f = handlingFixture(backing);
        await f.create();
        const answer = await f.assistantInput();
        await f.app.replyAsAssistant(agent, answer);
        const input = {
          ...f.command("success-race"),
          lastSeenVisibleMessageId: answer.messageId,
        };
        const gate = handlingBarrier();
        let paused = false;
        f.observed.intercept(async (trace, commit) => {
          if (
            !paused &&
            trace.actions.some(
              (action) =>
                action.action !== "delete" &&
                (action.value as SupportRecord).kind === "customer_success",
            )
          ) {
            paused = true;
            await gate.wait();
          }
          return commit();
        });
        const pending = f.app.confirmCustomerSuccess(customer, input).then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
        let concurrentRows;
        try {
          await Promise.race([
            gate.reached,
            pending.then(() => {
              throw new Error(
                "Success confirmation did not reach its proof transaction barrier",
              );
            }),
          ]);
          const other = createSupportDeskApplication({
            store: backing,
            clock: f.clock,
            assistantHandlingEnabled: true,
          });
          if (change === "private note")
            await other.addNote(staff, {
              ...f.command("note-during-success"),
              messageId: "concurrent-note",
              body: "PRIVATE_NOTE_DURING_CONFIRMATION",
            });
          else
            await other.replyToCustomerTicket(customer, {
              ...f.command("visible-during-success"),
              messageId: "new-visible",
              body: "A new customer question",
            });
          concurrentRows = await f.rows();
        } finally {
          gate.release();
        }
        const result = await pending;
        f.observed.intercept(undefined);
        if (change === "private note") {
          expect(result).toHaveProperty("value");
          expect(
            await f.app.readCustomerSuccessConfirmations(staff, "ticket"),
          ).toHaveLength(1);
          expect(
            JSON.stringify(await f.app.readCustomerTicket(customer, "ticket")),
          ).not.toContain("PRIVATE_NOTE_DURING_CONFIRMATION");
        } else {
          expect(result).toHaveProperty("error");
          expect(await f.rows()).toEqual(concurrentRows);
          expect(
            await f.app.readCustomerSuccessConfirmations(staff, "ticket"),
          ).toEqual([]);
        }
      },
    );

    it.each(["handoff", "success"] as const)(
      "refuses a %s transaction atomically and retries its exact command without duplicate proof",
      async (operation) => {
        const f = handlingFixture(createStore(), { maxConflictAttempts: 1 });
        await f.create();
        let lastSeenVisibleMessageId = "initial-ticket";
        if (operation === "success") {
          const answer = await f.assistantInput();
          await f.app.replyAsAssistant(agent, answer);
          lastSeenVisibleMessageId = answer.messageId;
        }
        const input = f.command("atomic-control");
        const invoke = () =>
          operation === "handoff"
            ? f.app.requestPerson(customer, input)
            : f.app.confirmCustomerSuccess(customer, {
                ...input,
                lastSeenVisibleMessageId,
              });
        const before = await f.rows();
        f.observed.intercept(async (trace, commit) =>
          trace.collection === "support-desk.records.v1"
            ? { committed: false, reason: "changed" }
            : commit(),
        );
        await expect(invoke()).rejects.toThrow();
        f.observed.intercept(undefined);
        expect(await f.rows()).toEqual(before);
        const accepted = await invoke();
        const rows = await f.rows();
        expect(await invoke()).toEqual(accepted);
        expect(await f.rows()).toEqual(rows);
        expect(
          rows.filter(
            (row) =>
              row.kind ===
              (operation === "handoff" ? "handoff_work" : "customer_success"),
          ),
        ).toHaveLength(1);
      },
    );
  });
}
