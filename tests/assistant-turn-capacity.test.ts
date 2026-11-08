import {
  customerTicketIndex,
  type NotificationInput,
} from "@pegma/support-desk-application";
import { describe, expect, it } from "vitest";
import { assistantTurnFixture } from "../test/assistant-turn-fixtures.js";
import {
  handlingAgent as agent,
  handlingCustomer as customer,
  handlingStaff as staff,
  handlingStores,
} from "../test/handling-fixtures.js";

const notification: NotificationInput = {
  id: "synthetic-notification",
  recipientRef: "synthetic-support-queue",
  templateId: "synthetic.ticket",
  templateVersion: 1,
  variables: {},
  subject: "Synthetic support update",
  outboundMessageId: "<assistant-turn@fixtures.invalid>",
};

for (const [name, createStore] of handlingStores) {
  describe(`durable assistant turn capacity (${name})`, () => {
    it.each([false, true])(
      "accounts for the job before reserving customer capacity (create mail: %s)",
      async (withMail) => {
        const minimum = withMail ? 20 : 19;
        const rejected = assistantTurnFixture(createStore(), {
          limits: { maxRecordsPerTicket: minimum - 1, maxMessagesPerTicket: 2 },
        });
        await expect(
          rejected.app.createCustomerTicket(customer, {
            ...rejected.createInput(),
            ...(withMail ? { notification } : {}),
          }),
        ).rejects.toMatchObject({ name: "SupportDeskLimitError" });
        expect(await rejected.rows()).toEqual([]);
        expect(
          await rejected.backing.collection(customerTicketIndex).get({
            partition: customer.principalId,
            id: "tickets",
          }),
        ).toBeNull();
        const admitted = assistantTurnFixture(createStore(), {
          limits: { maxRecordsPerTicket: minimum, maxMessagesPerTicket: 2 },
        });
        await admitted.app.createCustomerTicket(customer, {
          ...admitted.createInput(),
          ...(withMail ? { notification } : {}),
        });
        expect(await admitted.rows()).toHaveLength(withMail ? 8 : 7);
      },
    );

    it.each([false, true])(
      "charges follow-up message, receipt, audit, job and optional mail before spending the reserve (reply mail: %s)",
      async (withMail) => {
        const minimum = withMail ? 24 : 23;
        for (const maximum of [minimum - 1, minimum]) {
          const f = assistantTurnFixture(createStore(), {
            limits: { maxRecordsPerTicket: maximum, maxMessagesPerTicket: 3 },
          });
          await f.create();
          const before = await f.rows();
          const input = {
            ...f.command("bounded-follow-up"),
            messageId: "follow-up",
            body: "Further export details",
            ...(withMail ? { notification } : {}),
          };
          if (maximum < minimum) {
            await expect(
              f.app.replyToCustomerTicket(customer, input),
            ).rejects.toMatchObject({
              name: "SupportDeskLimitError",
              field: "ticket_partition",
            });
            expect(await f.rows()).toEqual(before);
          } else {
            await f.app.replyToCustomerTicket(customer, input);
            const rows = await f.rows();
            expect(rows).toHaveLength(before.length + (withMail ? 5 : 4));
            expect(
              rows.filter((row) => row.kind === "assistant_turn"),
            ).toHaveLength(2);
            expect(
              await f.app.replyToCustomerTicket(customer, input),
            ).toMatchObject({
              messages: expect.arrayContaining([
                expect.objectContaining({ id: "follow-up" }),
              ]),
            });
            expect(await f.rows()).toEqual(rows);
          }
        }
      },
    );

    it("keeps the twelve-row and human-message reserve through claim/preparation/retry and spends it on actual human completion", async () => {
      const f = assistantTurnFixture(createStore(), {
        limits: { maxRecordsPerTicket: 19, maxMessagesPerTicket: 2 },
      });
      await f.create();
      const claim = await f.claim();
      await f.prepare(claim);
      await f.app.finishAssistantTurnAttempt(agent, {
        ...claim.fence,
        disposition: "retry",
        accounting: "not_called",
        retryAt: f.clock.now(),
      });
      expect(await f.rows()).toHaveLength(7);
      const before = await f.rows();
      await expect(
        f.app.replyToCustomerTicket(customer, {
          ...f.command("ordinary-at-reserve"),
          messageId: "ordinary",
          body: "One more detail",
        }),
      ).rejects.toMatchObject({ name: "SupportDeskLimitError" });
      expect(await f.rows()).toEqual(before);
      await f.app.requestPerson(customer, f.command("person-at-reserve"));
      const current = (await f.app.readStaffTicket(staff, "ticket")).ticket;
      await f.app.takeOverTicket(staff, {
        ...f.command("takeover-at-reserve"),
        expectedRevision: current.revision,
        expectedHandlingGeneration: current.handling!.generation,
      });
      await f.app.replyAsStaff(staff, {
        ...f.command("human-at-reserve"),
        messageId: "human-answer",
        body: "A human verified the export instructions.",
        notification,
      });
      await f.app.confirmCustomerSuccess(customer, {
        ...f.command("success-at-reserve"),
        lastSeenVisibleMessageId: "human-answer",
      });
      expect(await f.rows()).toHaveLength(19);
      expect(
        (await f.app.readCustomerTicket(customer, "ticket")).messages,
      ).toHaveLength(2);
      expect((await f.app.readStaffTicket(staff, "ticket")).ticket.status).toBe(
        "resolved",
      );
    });

    it("gives a web reply reopening a terminal assistant ticket either causal work or an atomic human handoff", async () => {
      const f = assistantTurnFixture(createStore());
      await f.create();
      await f.app.resolveTicket(staff, f.command("resolve-before-web-reply"));
      await f.app.replyToCustomerTicket(customer, {
        ...f.command("web-reopen"),
        messageId: "web-reopen",
        body: "The export still needs help.",
      });
      const rows = await f.rows();
      const jobs = rows.filter(
        (row) =>
          row.kind === "assistant_turn" &&
          row.triggerMessageId === "web-reopen",
      );
      const handoffs = (await f.app.readHandoffWork(staff, "ticket")).filter(
        (work) => work.transcript.lastVisibleMessageId === "web-reopen",
      );
      const ticket = (await f.app.readStaffTicket(staff, "ticket")).ticket;
      expect(ticket.status).toBe("waiting_on_support");
      if (ticket.handling?.state === "assistant") {
        expect(jobs).toHaveLength(1);
        expect(handoffs).toHaveLength(0);
      } else {
        expect(ticket.handling?.state).toBe("human-pending");
        expect(jobs).toHaveLength(0);
        expect(handoffs).toHaveLength(1);
      }
    });
  });
}
