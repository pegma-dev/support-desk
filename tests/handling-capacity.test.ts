import { describe, expect, it } from "vitest";
import {
  handlingAgent as agent,
  handlingCustomer as customer,
  handlingFixture,
  handlingStaff as staff,
  handlingStores,
} from "../test/handling-fixtures.js";

for (const [name, createStore] of handlingStores) {
  describe(`managed handling completion reserve (${name})`, () => {
    it.each([
      "customer reply",
      "assistant reply",
      "note",
      "assignment",
      "priority",
      "tags",
      "resolve",
      "visible resolution",
    ] as const)(
      "preserves twelve physical rows from an ordinary %s",
      async (operation) => {
        const f = handlingFixture(createStore(), {
          limits: { maxRecordsPerTicket: 18, maxMessagesPerTicket: 3 },
          allowedTags: ["investigate"],
        });
        await f.create();
        const before = await f.rows();
        const command = f.command("ordinary-at-reserve");
        let execute: () => Promise<unknown>;
        switch (operation) {
          case "customer reply":
            execute = () =>
              f.app.replyToCustomerTicket(customer, {
                ...command,
                messageId: "ordinary",
                body: "More detail",
              });
            break;
          case "assistant reply": {
            const input = await f.assistantInput();
            execute = () => f.app.replyAsAssistant(agent, input);
            break;
          }
          case "note":
            execute = () =>
              f.app.addNote(staff, {
                ...command,
                messageId: "ordinary",
                body: "Private investigation",
              });
            break;
          case "assignment":
            execute = () =>
              f.app.assignTicket(staff, {
                ...command,
                assigneeId: staff.principalId,
              });
            break;
          case "priority":
            execute = () =>
              f.app.changePriority(staff, { ...command, priority: "high" });
            break;
          case "tags":
            execute = () =>
              f.app.setTags(staff, { ...command, tags: ["investigate"] });
            break;
          case "resolve":
            execute = () => f.app.resolveTicket(staff, command);
            break;
          case "visible resolution":
            execute = () =>
              f.app.resolveTicket(staff, {
                ...command,
                messageId: "ordinary",
                body: "Resolution update",
              });
            break;
        }
        await expect(execute()).rejects.toMatchObject({
          name: "SupportDeskLimitError",
          field: "ticket_partition",
        });
        expect(await f.rows()).toEqual(before);
      },
    );

    it.each(["customer", "assistant"] as const)(
      "reserves the final message slot from an ordinary %s reply",
      async (kind) => {
        const f = handlingFixture(createStore(), {
          limits: { maxMessagesPerTicket: 2 },
        });
        await f.create();
        const before = await f.rows();
        const input = await f.assistantInput();
        await expect(
          kind === "assistant"
            ? f.app.replyAsAssistant(agent, input)
            : f.app.replyToCustomerTicket(customer, {
                ...f.command("last-slot"),
                messageId: "last-slot",
                body: "New detail",
              }),
        ).rejects.toMatchObject({
          name: "SupportDeskLimitError",
          field: "ticket_messages",
        });
        expect(await f.rows()).toEqual(before);
      },
    );

    it("admits managed create only with its full completion reserve while legacy small tickets still work", async () => {
      const tooSmall = handlingFixture(createStore(), {
        limits: { maxRecordsPerTicket: 17 },
      });
      await expect(tooSmall.create()).rejects.toMatchObject({
        name: "SupportDeskLimitError",
      });
      expect(await tooSmall.rows()).toEqual([]);
      const minimum = handlingFixture(createStore(), {
        limits: { maxRecordsPerTicket: 18, maxMessagesPerTicket: 2 },
      });
      await minimum.create();
      expect(await minimum.rows()).toHaveLength(6);
      const legacy = handlingFixture(createStore(), {
        limits: { maxRecordsPerTicket: 6, maxMessagesPerTicket: 1 },
      });
      await legacy.create(false);
      expect(await legacy.rows()).toHaveLength(6);
      const messageLimited = handlingFixture(createStore(), {
        limits: { maxMessagesPerTicket: 1 },
      });
      await expect(messageLimited.create()).rejects.toMatchObject({
        name: "SupportDeskLimitError",
      });
    });

    it("charges optional create mail separately from the managed reserve", async () => {
      for (const maximum of [18, 19]) {
        const f = handlingFixture(createStore(), {
          limits: { maxRecordsPerTicket: maximum, maxMessagesPerTicket: 2 },
        });
        const command = {
          ...f.createInput(),
          notification: {
            id: "create-mail",
            recipientRef: customer.principalId,
            templateId: "synthetic.created",
            templateVersion: 1,
            variables: {},
            subject: "Support request created",
            outboundMessageId: "<handling-create@fixtures.invalid>",
          },
        };
        if (maximum === 18) {
          await expect(
            f.app.createCustomerTicket(customer, command),
          ).rejects.toMatchObject({ name: "SupportDeskLimitError" });
          expect(await f.rows()).toEqual([]);
        } else {
          await f.app.createCustomerTicket(customer, command);
          expect(await f.rows()).toHaveLength(7);
        }
      }
    });

    it("completes request, takeover, first human response and success proof at the minimum managed limits", async () => {
      const f = handlingFixture(createStore(), {
        limits: { maxRecordsPerTicket: 18, maxMessagesPerTicket: 2 },
      });
      await f.create();
      await f.app.requestPerson(customer, f.command("request-at-capacity"));
      const detail = await f.app.readStaffTicket(staff, "ticket");
      await f.app.takeOverTicket(staff, {
        ...f.command("takeover-at-capacity"),
        expectedRevision: detail.ticket.revision,
        expectedHandlingGeneration: detail.ticket.handling!.generation,
      });
      await f.app.replyAsStaff(staff, {
        ...f.command("first-human-at-capacity"),
        messageId: "first-human",
        body: "A verified human response",
      });
      expect(
        (await f.app.readCustomerTicket(customer, "ticket")).messages,
      ).toHaveLength(2);
      await f.app.confirmCustomerSuccess(customer, {
        ...f.command("success-at-full-message-cap"),
        lastSeenVisibleMessageId: "first-human",
      });
      expect(await f.rows()).toHaveLength(17);
      expect(
        await f.app.readCustomerSuccessConfirmations(staff, "ticket"),
      ).toHaveLength(1);
    });

    it("releases the managed reserve after the first human response", async () => {
      const f = handlingFixture(createStore(), {
        limits: { maxRecordsPerTicket: 18, maxMessagesPerTicket: 3 },
      });
      await f.create();
      await f.app.replyAsStaff(staff, {
        ...f.command("first-human"),
        messageId: "first-human",
        body: "A human answer",
      });
      await f.app.changePriority(staff, {
        ...f.command("priority-after-human"),
        priority: "high",
      });
      expect(
        (await f.app.readStaffTicket(staff, "ticket")).ticket.priority,
      ).toBe("high");
    });

    it("keeps the old full-cap behavior for tickets that never opted in", async () => {
      const f = handlingFixture(createStore(), {
        limits: { maxRecordsPerTicket: 9, maxMessagesPerTicket: 2 },
      });
      await f.create(false);
      await f.app.replyToCustomerTicket(customer, {
        ...f.command("legacy-last-slot"),
        messageId: "legacy-last-slot",
        body: "A second message",
      });
      expect(await f.rows()).toHaveLength(9);
      const before = await f.rows();
      await expect(
        f.app.replyToCustomerTicket(customer, {
          ...f.command("legacy-over-cap"),
          messageId: "legacy-over-cap",
          body: "Too many messages",
        }),
      ).rejects.toMatchObject({ name: "SupportDeskLimitError" });
      expect(await f.rows()).toEqual(before);
    });

    it.each(["assignment", "lifecycle"] as const)(
      "preserves the managed quota through an optional %s message and reserves the first human response",
      async (operation) => {
        const f = handlingFixture(createStore(), {
          limits: { maxMessagesPerTicket: 3 },
        });
        await f.create();
        const command = {
          ...f.command("optional-system-message"),
          messageId: "system-update",
          body: "A staff system update",
        };
        if (operation === "assignment")
          await f.app.assignTicket(staff, {
            ...command,
            assigneeId: staff.principalId,
          });
        else {
          await f.app.resolveTicket(staff, command);
          await f.app.reopenTicket(
            staff,
            f.command("reopen-after-system-message"),
          );
        }
        const current = await f.app.readStaffTicket(staff, "ticket");
        expect(current.ticket).not.toHaveProperty("firstStaffRespondedAt");
        expect
          .soft((await f.rows()).find((row) => row.kind === "ticket_quota"))
          .toMatchObject({ assistantManaged: true, messageCount: 2 });
        const before = await f.rows();
        await expect(
          f.app.replyToCustomerTicket(customer, {
            ...f.command("customer-cannot-spend-human-slot"),
            messageId: "ordinary-last-slot",
            body: "Customer detail",
          }),
        ).rejects.toMatchObject({
          name: "SupportDeskLimitError",
          field: "ticket_messages",
        });
        expect(await f.rows()).toEqual(before);
        await f.app.requestPerson(
          customer,
          f.command("human-request-without-message-slot"),
        );
        const pending = await f.app.readStaffTicket(staff, "ticket");
        await f.app.takeOverTicket(staff, {
          ...f.command("takeover-without-message-slot"),
          expectedRevision: pending.ticket.revision,
          expectedHandlingGeneration: pending.ticket.handling!.generation,
        });
        await f.app.replyAsStaff(staff, {
          ...f.command("first-human-reserved-slot"),
          messageId: "first-human",
          body: "A human response",
        });
        expect(
          (await f.app.readStaffTicket(staff, "ticket")).messages,
        ).toHaveLength(3);
        expect(
          (await f.app.readCustomerTicket(customer, "ticket")).messages.at(-1),
        ).toMatchObject({ id: "first-human", authorKind: "staff" });
        expect(
          (await f.rows()).find((row) => row.kind === "ticket_quota"),
        ).toMatchObject({ assistantManaged: true, messageCount: 3 });
        expect(
          (await f.app.readStaffTicket(staff, "ticket")).ticket
            .firstStaffRespondedAt,
        ).toBe(f.clock.now());
      },
    );
  });
}
