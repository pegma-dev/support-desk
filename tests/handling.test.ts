import {
  createInboundMailProcessor,
  createSupportDeskApplication,
  queueIndex,
  supportPermissions,
  type SupportRecord,
} from "@pegma/support-desk-application";
import { describe, expect, it } from "vitest";
import {
  handlingAgent as agent,
  handlingCustomer as customer,
  handlingFixture,
  handlingStaff as staff,
  handlingStores,
} from "../test/handling-fixtures.js";

for (const [name, createStore] of handlingStores) {
  describe(`optional ticket handling public entries (${name})`, () => {
    it("keeps legacy handling absent, human-visible and old command fingerprints replayable", async () => {
      const f = handlingFixture(createStore());
      const input = f.createInput(false);
      await f.app.createCustomerTicket(customer, input);
      const before = await f.rows();
      // Fixed pre-SD-01 create digest from the payload at baseline fcf5a68.
      expect(before.find((row) => row.kind === "command")).toMatchObject({
        requestFingerprint:
          "92841d2fdfd7a2ed7d41a22efbdb54c4cd4e7071f193f10c69ad4456204580fe",
      });
      expect(
        (await f.app.readStaffTicket(staff, "ticket")).ticket,
      ).not.toHaveProperty("handling");
      expect(await f.app.createCustomerTicket(customer, input)).toEqual(
        await f.app.readCustomerTicket(customer, "ticket"),
      );
      expect(await f.rows()).toEqual(before);
      expect((await f.app.listStaffQueue(staff)).items[0]?.ticketId).toBe(
        "ticket",
      );
      expect(await f.rows()).toEqual(before);
      const reply = {
        ...f.command("legacy-reply"),
        messageId: "staff-reply",
        body: "A human answer",
      };
      const historical = await f.app.replyAsStaff(staff, reply);
      await f.app.addNote(staff, {
        ...f.command("later-note"),
        messageId: "later-note",
        body: "PRIVATE_LATER_NOTE",
      });
      expect(await f.app.replyAsStaff(staff, reply)).toEqual(historical);
      expect(
        (await f.app.readStaffTicket(staff, "ticket")).messages.length,
      ).toBeGreaterThan(historical.messages.length);
    });

    it("requires explicit host opt-in and start permission for managed assistant handling", async () => {
      const backing = createStore();
      const f = handlingFixture(backing, { assistantHandlingEnabled: false });
      await expect(f.create()).rejects.toThrow();
      expect(await f.rows()).toEqual([]);
      const enabled = handlingFixture(backing);
      await expect(
        enabled.app.createCustomerTicket(
          {
            ...customer,
            permissions: customer.permissions.filter(
              (permission) => permission !== supportPermissions.assistantStart,
            ),
          },
          enabled.createInput(),
        ),
      ).rejects.toMatchObject({
        permission: supportPermissions.assistantStart,
      });
      await enabled.create();
      expect(
        (await enabled.app.readStaffTicket(staff, "ticket")).ticket.handling,
      ).toEqual({ state: "assistant", generation: 1 });
    });

    it("attributes assistant replies and exposes only safe customer conversation fields", async () => {
      const f = handlingFixture(createStore());
      await f.create();
      await f.app.addNote(staff, {
        ...f.command("note"),
        messageId: "note",
        body: "PRIVATE_INTERNAL_CANARY",
      });
      const input = await f.assistantInput();
      const ack = await f.app.replyAsAssistant(agent, input);
      expect(ack).toMatchObject({
        ticketId: "ticket",
        messageId: input.messageId,
      });
      const visible = await f.app.readCustomerTicket(customer, "ticket");
      const assistant = await f.app.readAssistantConversation(agent, "ticket");
      expect(visible.messages.at(-1)).toMatchObject({
        authorKind: "assistant",
        visibility: "customer",
        body: input.body,
      });
      expect(assistant.messages).toEqual(visible.messages);
      for (const secret of [
        "PRIVATE_INTERNAL_CANARY",
        staff.principalId,
        agent.principalId,
        customer.principalId,
        "authorPrincipalId",
        "requester",
        "priority",
        "assignedTo",
        "firstStaffRespondedAt",
      ])
        expect(JSON.stringify({ visible, assistant })).not.toContain(secret);
      expect(
        (await f.app.readStaffTicket(staff, "ticket")).ticket,
      ).not.toHaveProperty("firstStaffRespondedAt");
      await expect(
        f.app.resolveTicket(agent, f.command("agent-resolve")),
      ).rejects.toMatchObject({ permission: supportPermissions.queueRead });
      await expect(
        f.app.resolveTicket(
          {
            ...agent,
            permissions: [...agent.permissions, supportPermissions.queueRead],
          },
          f.command("agent-cannot-manage"),
        ),
      ).rejects.toMatchObject({ permission: supportPermissions.manage });
      const rows = await f.rows();
      expect(await f.app.replyAsAssistant(agent, input)).toEqual(ack);
      expect(await f.rows()).toEqual(rows);
      const afterAnswer = await f.app.readAssistantConversation(
        agent,
        "ticket",
      );
      await expect(
        f.app.replyAsAssistant(agent, {
          ...input,
          ...f.command("second-turn-answer"),
          messageId: "second-answer",
          expectedRevision: afterAnswer.revision,
          expectedHandlingGeneration: afterAnswer.handling.generation,
        }),
      ).rejects.toThrow();
      await f.app.replyAsStaff(staff, {
        ...f.command("human-answer"),
        messageId: "human-answer",
        body: "Human follow-up",
      });
      const human = await f.app.readStaffTicket(staff, "ticket");
      expect(human.ticket.firstStaffRespondedAt).toBe(f.clock.now());
      expect(human.ticket.handling?.state).toBe("human-active");
    });

    it("keeps the default queue human-only and confirms stale supervision projections against authority", async () => {
      const f = handlingFixture(createStore());
      await f.create(false, "legacy");
      await f.create(true, "managed");
      expect(
        (await f.app.listStaffQueue(staff)).items.map((item) => item.ticketId),
      ).toEqual(["legacy"]);
      expect(
        (
          await f.app.listStaffQueue(staff, { handling: "assistant" })
        ).items.map((item) => item.ticketId),
      ).toEqual(["managed"]);
      const projection = await f.backing
        .collection(queueIndex)
        .get({ partition: "managed", id: "queue" });
      expect(projection).not.toBeNull();
      await f.app.requestPerson(customer, f.command("handoff", "managed"));
      await f.backing.collection(queueIndex).put(projection!);
      expect(
        (await f.app.listStaffQueue(staff)).items
          .map((item) => item.ticketId)
          .sort(),
      ).toEqual(["legacy", "managed"]);
      expect(
        (await f.app.listStaffQueue(staff, { handling: "assistant" })).items,
      ).toEqual([]);
      await f.backing
        .collection(queueIndex)
        .put({ ...projection!, projectedRevision: 999 });
      expect(
        (await f.app.listStaffQueue(staff, { handling: "all" })).items.map(
          (item) => item.ticketId,
        ),
      ).toEqual(["legacy"]);
    });

    it("requests a person without a provider and commits handoff, audit and receipt together", async () => {
      const f = handlingFixture(createStore());
      await f.create();
      const before = await f.rows();
      f.observed.transactions.length = 0;
      const input = f.command("request-person");
      const result = await f.app.requestPerson(customer, input);
      const added = (await f.rows()).filter(
        (row) => !before.some((prior) => prior.id === row.id),
      );
      expect(added.map((row) => row.kind).sort()).toEqual([
        "audit",
        "command",
        "handoff_work",
      ]);
      expect(
        (await f.app.readStaffTicket(staff, "ticket")).ticket.handling?.state,
      ).toBe("human-pending");
      const accepted = f.observed.transactions.filter(
        (trace) => trace.collection === "support-desk.records.v1",
      );
      expect(accepted).toHaveLength(1);
      expect(
        accepted[0]?.actions
          .filter((action) => action.action !== "delete")
          .map((action) => (action.value as SupportRecord).kind),
      ).toEqual(
        expect.arrayContaining(["ticket", "audit", "command", "handoff_work"]),
      );
      const rows = await f.rows();
      expect(await f.app.requestPerson(customer, input)).toEqual(result);
      await f.app.requestPerson(customer, f.command("already-human"));
      expect(await f.rows()).toEqual(rows);
      await expect(
        f.app.requestPerson(
          { ...customer, principalId: "customer/other" },
          f.command("wrong-owner"),
        ),
      ).rejects.toThrow();
      expect(await f.rows()).toEqual(rows);
    });

    it("keeps escalation summaries and attempted guides in private work instead of conversation output", async () => {
      const f = handlingFixture(createStore());
      await f.create();
      await f.app.addNote(staff, {
        ...f.command("private-escalation-context"),
        messageId: "private-context",
        body: "PRIVATE_ESCALATION_SUMMARY private-guide-reference",
      });
      const safeAssistant = JSON.stringify(
        await f.app.readAssistantConversation(agent, "ticket"),
      );
      const {
        messageId: _messageId,
        body: _body,
        ...fence
      } = await f.assistantInput();
      const input = {
        ...fence,
        reason: "no_guidance" as const,
        summary: "PRIVATE_ESCALATION_SUMMARY",
        attemptedGuideIds: ["private-guide-reference"],
      };
      await f.app.escalateToHuman(agent, input);
      const work = (await f.rows()).find((row) => row.kind === "handoff_work");
      expect(work).toMatchObject({
        summary: input.summary,
        attemptedGuideIds: input.attemptedGuideIds,
        status: "pending",
      });
      const staffWork = await f.app.readHandoffWork(staff, "ticket");
      expect(staffWork).toEqual([
        expect.objectContaining({
          ticketId: "ticket",
          reason: "no_guidance",
          summary: input.summary,
          attemptedGuideIds: input.attemptedGuideIds,
        }),
      ]);
      expect(staffWork[0]).not.toHaveProperty("messages");
      expect(staffWork[0]).not.toHaveProperty("partition");
      for (const caller of [customer, agent])
        await expect(
          f.app.readHandoffWork(caller, "ticket"),
        ).rejects.toMatchObject({ permission: supportPermissions.queueRead });
      const safeCustomer = JSON.stringify(
        await f.app.readCustomerTicket(customer, "ticket"),
      );
      expect(safeCustomer).not.toContain(input.summary);
      expect(safeCustomer).not.toContain(input.attemptedGuideIds[0]);
      expect(safeAssistant).not.toContain(input.summary);
      expect(safeAssistant).not.toContain(input.attemptedGuideIds[0]);
      await expect(
        f.app.readAssistantConversation(agent, "ticket"),
      ).rejects.toMatchObject({
        name: "SupportDeskConflictError",
        message: "Assistant conversation is unavailable",
      });
      const before = await f.rows();
      await f.app.escalateToHuman(agent, input);
      expect(await f.rows()).toEqual(before);
    });

    it.each(["takeover", "staff reply", "customer reply"] as const)(
      "fences an assistant completion after %s without relying on a provider",
      async (change) => {
        const f = handlingFixture(createStore());
        await f.create();
        const stale = await f.assistantInput();
        if (change === "takeover")
          await f.app.takeOverTicket(staff, {
            ...f.command("take-over"),
            expectedRevision: stale.expectedRevision,
            expectedHandlingGeneration: stale.expectedHandlingGeneration,
          });
        else if (change === "staff reply")
          await f.app.replyAsStaff(staff, {
            ...f.command("staff-reply"),
            messageId: "staff-reply",
            body: "Human answer",
          });
        else
          await f.app.replyToCustomerTicket(customer, {
            ...f.command("customer-reply"),
            messageId: "customer-reply",
            body: "New information",
          });
        const before = await f.rows();
        await expect(f.app.replyAsAssistant(agent, stale)).rejects.toThrow();
        expect(await f.rows()).toEqual(before);
      },
    );

    it("resolves only after explicit customer success confirmation and keeps its proof private", async () => {
      const f = handlingFixture(createStore());
      await f.create();
      const answer = await f.assistantInput();
      await f.app.replyAsAssistant(agent, answer);
      const input = {
        ...f.command("confirm-success"),
        lastSeenVisibleMessageId: answer.messageId,
      };
      const before = await f.rows();
      const visibleBefore = await f.app.readCustomerTicket(customer, "ticket");
      const confirmed = await f.app.confirmCustomerSuccess(customer, input);
      expect(confirmed.messages).toEqual(visibleBefore.messages);
      expect(confirmed.ticket.status).toBe("resolved");
      const added = (await f.rows()).filter(
        (row) => !before.some((prior) => prior.id === row.id),
      );
      expect(added.map((row) => row.kind).sort()).toEqual([
        "audit",
        "command",
        "customer_success",
      ]);
      expect(
        await f.app.readCustomerSuccessConfirmations(staff, "ticket"),
      ).toEqual([
        expect.objectContaining({
          confirmedBy: customer.principalId,
          lastSeenVisibleMessageId: answer.messageId,
        }),
      ]);
      await expect(
        f.app.readCustomerSuccessConfirmations(customer, "ticket"),
      ).rejects.toThrow();
      const rows = await f.rows();
      expect(await f.app.confirmCustomerSuccess(customer, input)).toEqual(
        confirmed,
      );
      expect(await f.rows()).toEqual(rows);
      await f.app.confirmCustomerSuccess(customer, {
        ...input,
        ...f.command("already-confirmed-visible-message"),
      });
      expect(await f.rows()).toEqual(rows);
      await expect(
        f.app.confirmCustomerSuccess(
          { ...customer, principalId: "customer/other" },
          { ...input, ...f.command("wrong-success") },
        ),
      ).rejects.toThrow();
      expect(await f.rows()).toEqual(rows);
    });

    it("keeps initial email human-handled and routes a verified email reply away from assistant handling", async () => {
      const backing = createStore();
      const f = handlingFixture(backing);
      const created = await f.app.createCustomerTicket(customer, {
        ...f.createInput(),
        requesterEmail: "customer@fixtures.invalid",
      });
      const stale = await f.assistantInput();
      const processor = createInboundMailProcessor({
        store: backing,
        clock: f.clock,
        subjectMarkerPrefix: "SD",
        accountMatcher: {
          matchSenderEmail: async () => ({
            matches: "one",
            principalId: customer.principalId,
          }),
        },
        routingPolicy: { routeNewConversation: () => ({ priority: "normal" }) },
      });
      const base = {
        channelId: "synthetic-mail",
        from: "customer@fixtures.invalid",
        body: "Further detail by email",
        senderAuthentication: {
          method: "host_identity" as const,
          result: "pass" as const,
          email: "customer@fixtures.invalid",
        },
      };
      const initial = await processor.processInboundEmail({
        ...base,
        providerEventId: "new-mail",
        ticketId: "email-ticket",
        messageId: "email-initial",
        correlationId: "email-initial",
        subject: "Unrelated initial question",
      });
      expect(initial.outcome).toBe("created");
      expect(
        (await f.app.listStaffQueue(staff)).items.map((item) => item.ticketId),
      ).toContain("email-ticket");
      const reply = await processor.processInboundEmail({
        ...base,
        providerEventId: "thread-mail",
        ticketId: "unused-fallback",
        messageId: "email-reply",
        correlationId: "email-reply",
        subject: `Re: [SD-${created.ticket.number}] Synthetic workspace export`,
      });
      expect(reply).toMatchObject({ outcome: "replied", ticketId: "ticket" });
      expect(
        (await f.app.readStaffTicket(staff, "ticket")).ticket.handling?.state,
      ).toBe("human-pending");
      await expect(f.app.replyAsAssistant(agent, stale)).rejects.toThrow();
    });

    it("rejects hidden own extra properties on strict customer handling commands", async () => {
      const f = handlingFixture(createStore());
      await f.create();
      const input = Object.defineProperty(
        f.command("hidden-own-property"),
        "expectedRevision",
        { value: 999, enumerable: false },
      );
      expect(Object.getOwnPropertyNames(input)).toContain("expectedRevision");
      const before = await f.rows();
      await expect(f.app.requestPerson(customer, input)).rejects.toBeInstanceOf(
        TypeError,
      );
      expect(await f.rows()).toEqual(before);
    });

    it.each(["create", "reply"] as const)(
      "replays a committed assistant %s after flag-off while requiring current authority and denying new work",
      async (operation) => {
        const backing = createStore();
        const f = handlingFixture(backing);
        const create = f.createInput();
        await f.app.createCustomerTicket(customer, create);
        const reply = await f.assistantInput();
        const replyResult =
          operation === "reply"
            ? await f.app.replyAsAssistant(agent, reply)
            : undefined;
        await f.app.replyToCustomerTicket(customer, {
          ...f.command("new-visible-before-disable"),
          messageId: "new-visible",
          body: "A later customer question",
        });
        const off = createSupportDeskApplication({
          store: backing,
          clock: f.clock,
          assistantHandlingEnabled: false,
        });
        const before = await f.rows();
        if (operation === "create") {
          expect(await off.createCustomerTicket(customer, create)).toEqual(
            await f.app.readCustomerTicket(customer, "ticket"),
          );
          for (const denied of [
            supportPermissions.create,
            supportPermissions.assistantStart,
          ])
            await expect(
              off.createCustomerTicket(
                {
                  ...customer,
                  permissions: customer.permissions.filter(
                    (permission) => permission !== denied,
                  ),
                },
                create,
              ),
            ).rejects.toMatchObject({ permission: denied });
          await expect(
            off.createCustomerTicket(
              { ...customer, principalId: "customer/other" },
              create,
            ),
          ).rejects.toThrow();
          await expect(
            off.createCustomerTicket(customer, {
              ...create,
              ...f.command("disabled-new-create", "disabled-ticket"),
              messageId: "disabled-initial",
            }),
          ).rejects.toMatchObject({ name: "SupportDeskConflictError" });
          expect(await f.rows("disabled-ticket")).toEqual([]);
        } else {
          expect(await off.replyAsAssistant(agent, reply)).toEqual(replyResult);
          await expect(
            off.replyAsAssistant(
              {
                ...agent,
                permissions: agent.permissions.filter(
                  (permission) =>
                    permission !== supportPermissions.assistantReply,
                ),
              },
              reply,
            ),
          ).rejects.toMatchObject({
            permission: supportPermissions.assistantReply,
          });
          await expect(
            off.replyAsAssistant(
              { ...agent, principalId: "assistant/other" },
              reply,
            ),
          ).rejects.toThrow();
          const fresh = await f.assistantInput();
          await expect(
            off.replyAsAssistant(agent, fresh),
          ).rejects.toMatchObject({ name: "SupportDeskConflictError" });
        }
        expect(await f.rows()).toEqual(before);
      },
    );
  });
}
