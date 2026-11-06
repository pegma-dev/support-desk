import { TableClient } from "@azure/data-tables";
import { createAzureTablesStore } from "@pegma/storage-azure-tables";
import { createMemoryStore, type Store } from "@pegma/storage-core";
import { describe, expect, it, vi } from "vitest";
import {
  createInboundMailProcessor,
  createSupportDeskApplication,
  defaultQueueTerminalRetentionMilliseconds,
  queueIndex,
  projectTicketToQueue,
  repairQueueProjectionPage,
  SupportDeskAuthorizationError,
  SupportDeskConflictError,
  SupportDeskStaleRevisionError,
  supportRecords,
  type ResponseTargetPolicy,
  type SupportDeskApplication,
} from "@pegma/support-desk-application";
import {
  EXAMPLE_CUSTOMER as customer,
  EXAMPLE_STAFF as staff,
} from "../examples/composition/composition.js";
import { TABLE_PORT } from "../test/azurite.js";

const start = "2026-11-01T10:00:00.000Z";
const later = "2026-11-01T11:00:00.000Z";
let ordinal = 0;
function azureStore(): Store {
  const connection = `DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;TableEndpoint=http://127.0.0.1:${TABLE_PORT}/devstoreaccount1;`;
  return createAzureTablesStore({
    client: TableClient.fromConnectionString(
      connection,
      `lifecycle${process.pid}${++ordinal}`,
      { allowInsecureConnection: true },
    ),
  });
}
const base = { ticketId: "ticket", correlationId: "correlation" };
async function create(app: SupportDeskApplication, ticketId = "ticket") {
  return app.createCustomerTicket(customer, {
    ...base,
    ticketId,
    commandId: `create-${ticketId}`,
    messageId: `initial-${ticketId}`,
    subject: "Synthetic question",
    body: "Please help",
  });
}

for (const [name, fixture] of [
  ["memory", createMemoryStore],
  ["Azurite", azureStore],
] as const) {
  describe(`lifecycle extras via public entry points (${name})`, () => {
    it("sorts unmet targets in both directions with inclusive due-soon boundaries", async () => {
      const store = fixture();
      let now = start;
      const dates: Record<string, string> = {
        early: start,
        boundary: later,
        soon: "2026-11-01T11:01:00.000Z",
        future: "2026-11-01T12:00:00.000Z",
      };
      const app = createSupportDeskApplication({
        store,
        clock: { now: () => now },
        responseTargetPolicy: {
          computeTargets: ({ ticketId }) =>
            dates[ticketId] === undefined
              ? {}
              : {
                  firstResponseDueAt: dates[ticketId],
                  resolutionDueAt: dates[ticketId],
                },
        },
      });
      for (const id of ["early", "boundary", "soon", "future", "missing"])
        await create(app, id);
      now = later;
      const ids = async (query: Parameters<typeof app.listStaffQueue>[1]) =>
        (await app.listStaffQueue(staff, query)).items.map(
          (row) => row.ticketId,
        );
      expect(await ids({ sort: "due_soonest" })).toEqual([
        "early",
        "boundary",
        "soon",
        "future",
        "missing",
      ]);
      expect(await ids({ sort: "due_latest" })).toEqual([
        "future",
        "soon",
        "boundary",
        "early",
        "missing",
      ]);
      expect(await ids({ targetState: "overdue" })).toEqual(["early"]);
      expect(
        await ids({
          targetState: "due_soon",
          dueSoonMilliseconds: 60_000,
          sort: "due_soonest",
        }),
      ).toEqual(["boundary", "soon"]);
      await app.replyAsStaff(staff, {
        ticketId: "early",
        correlationId: "reply",
        commandId: "reply",
        messageId: "reply",
        body: "Answered",
      });
      expect(
        await ids({ target: "first_response", sort: "due_latest" }),
      ).toEqual(["future", "soon", "boundary", "early", "missing"]);
      for (const query of [
        { targetState: "due_soon" as const },
        { dueSoonMilliseconds: -1 },
        { dueSoonMilliseconds: 31 * 86_400_000 },
      ])
        await expect(app.listStaffQueue(staff, query)).rejects.toThrow(
          TypeError,
        );
    });

    it("enriches legacy projection rows and refuses divergent same-revision targets", async () => {
      const store = fixture();
      const clock = { now: () => start };
      const app = createSupportDeskApplication({ store, clock });
      await create(app);
      await app.resolveTicket(staff, { ...base, commandId: "resolve" });
      const projections = store.collection(queueIndex);
      const row = await projections.get({ partition: "ticket", id: "queue" });
      const { resolvedAt: _resolved, ...legacy } = row!;
      await projections.put(legacy);
      const options = {
        store,
        clock,
        terminalRetentionMilliseconds:
          defaultQueueTerminalRetentionMilliseconds,
      };
      expect(await projectTicketToQueue("ticket", options)).toBe("written");
      expect(
        await projections.get({ partition: "ticket", id: "queue" }),
      ).toEqual(row);
      await projections.put({ ...row!, resolutionDueAt: later });
      await expect(
        projectTicketToQueue("ticket", options),
      ).rejects.toBeInstanceOf(SupportDeskConflictError);
    });
    it("normalizes tags, commits audit and replay state, and isolates customer fields and mail", async () => {
      const store = fixture();
      let now = start;
      const allowedTags = [" Needs_Review ", "follow_up", "needs_review"];
      const app = createSupportDeskApplication({
        store,
        clock: { now: () => now },
        allowedTags,
        maxTagsPerTicket: 2,
      });
      allowedTags.splice(0);
      const before = await create(app);
      now = later;
      const command = {
        ...base,
        commandId: "tags",
        expectedRevision: 1,
        tags: [" NEEDS_REVIEW ", "needs_review"],
      };
      const result = await app.setTags(staff, command);
      expect(result.ticket).toMatchObject({
        tags: ["needs_review"],
        revision: 2,
        updatedAt: later,
        customerUpdatedAt: start,
        status: "open",
      });
      expect(await app.readCustomerTicket(customer, "ticket")).toEqual(before);
      const rows = await store.collection(supportRecords).list("ticket");
      expect(
        rows
          .filter((row) => row.kind === "audit")
          .map((row) => row.event.action),
      ).toContain("support.ticket.tags_changed");
      expect(rows.some((row) => row.kind === "delivery_job")).toBe(false);
      await app.addNote(staff, {
        ...base,
        commandId: "note",
        messageId: "note",
        body: "Staff only",
      });
      expect(await app.setTags(staff, command)).toEqual(result);
      await expect(
        app.setTags(staff, { ...command, tags: ["follow_up"] }),
      ).rejects.toBeInstanceOf(SupportDeskConflictError);
      await expect(
        app.setTags(staff, {
          ...command,
          commandId: "bad",
          expectedRevision: 3,
          tags: ["unknown"],
        }),
      ).rejects.toBeInstanceOf(TypeError);
      await expect(
        app.setTags(
          { ...staff, permissions: [] },
          { ...command, commandId: "denied" },
        ),
      ).rejects.toBeInstanceOf(SupportDeskAuthorizationError);
      expect(
        (await app.listStaffQueue(staff, { tag: "NEEDS_REVIEW" })).items,
      ).toHaveLength(1);
      expect(
        (await app.listStaffQueue(staff, { tag: "follow_up" })).items,
      ).toEqual([]);
      await app.setTags(staff, { ...base, commandId: "clear", tags: [] });
      expect((await app.readStaffTicket(staff, "ticket")).ticket.tags).toEqual(
        [],
      );
    });

    it("records host targets and milestones, confirms filters, and repairs projection fields", async () => {
      const store = fixture();
      let now = start;
      const computeTargets = vi.fn<ResponseTargetPolicy["computeTargets"]>(
        (input) => ({
          firstResponseDueAt: input.priority === "high" ? start : later,
          resolutionDueAt: "2026-11-01T12:00:00.000Z",
        }),
      );
      const app = createSupportDeskApplication({
        store,
        clock: { now: () => now },
        responseTargetPolicy: { computeTargets },
      });
      await create(app);
      await create(app, "second");
      expect(computeTargets).toHaveBeenCalledTimes(2);
      const changed = await app.changePriority(staff, {
        ...base,
        commandId: "priority",
        priority: "high",
      });
      expect(changed.ticket.firstResponseDueAt).toBe(start);
      now = later;
      expect(
        (
          await app.listStaffQueue(staff, {
            target: "first_response",
            targetState: "overdue",
            sort: "due_soonest",
          })
        ).items.map((row) => row.ticketId),
      ).toEqual(["ticket"]);
      expect(
        (
          await app.listStaffQueue(staff, {
            target: "first_response",
            targetState: "due_soon",
            dueSoonMilliseconds: 60_000,
          })
        ).items.map((row) => row.ticketId),
      ).toEqual(["second"]);
      const reply = await app.replyAsStaff(staff, {
        ...base,
        commandId: "reply",
        messageId: "reply",
        body: "Hello",
      });
      expect(reply.ticket.firstStaffRespondedAt).toBe(later);
      expect(
        (
          await app.listStaffQueue(staff, {
            target: "first_response",
            targetState: "overdue",
          })
        ).items,
      ).toEqual([]);
      const resolved = await app.resolveTicket(staff, {
        ...base,
        commandId: "resolve",
      });
      expect(resolved.ticket.resolvedAt).toBe(later);
      now = "2026-11-01T11:30:00.000Z";
      expect(
        (
          await app.resolveTicket(staff, {
            ...base,
            commandId: "resolve-again",
          })
        ).ticket.resolvedAt,
      ).toBe(later);
      const reopened = await app.reopenTicket(staff, {
        ...base,
        commandId: "reopen",
      });
      expect(reopened.ticket.resolvedAt).toBeUndefined();
      expect(reopened.ticket.firstStaffRespondedAt).toBe(later);
      const rer = await app.resolveTicket(staff, {
        ...base,
        commandId: "reresolve",
      });
      expect(rer.ticket.resolvedAt).toBe(now);
      await app.replyToCustomerTicket(customer, {
        ...base,
        commandId: "customer-reopen",
        messageId: "customer-reopen",
        body: "Follow up",
      });
      expect(
        (await app.readStaffTicket(staff, "ticket")).ticket.resolvedAt,
      ).toBeUndefined();
      await store
        .collection(queueIndex)
        .delete({ partition: "ticket", id: "queue" });
      await repairQueueProjectionPage({
        store,
        clock: { now: () => now },
        terminalRetentionMilliseconds:
          defaultQueueTerminalRetentionMilliseconds,
      });
      expect(
        await store
          .collection(queueIndex)
          .get({ partition: "ticket", id: "queue" }),
      ).toMatchObject({
        firstStaffRespondedAt: later,
        firstResponseDueAt: start,
        resolutionDueAt: "2026-11-01T12:00:00.000Z",
      });
      const view = await app.readCustomerTicket(customer, "ticket");
      for (const field of [
        "tags",
        "firstResponseDueAt",
        "resolutionDueAt",
        "firstStaffRespondedAt",
        "resolvedAt",
      ])
        expect(view.ticket).not.toHaveProperty(field);
      // Equal-revision projection fields cannot influence authoritative filtering.
      const projection = await store
        .collection(queueIndex)
        .get({ partition: "ticket", id: "queue" });
      await store
        .collection(queueIndex)
        .put({ ...projection!, tags: ["forged"], resolutionDueAt: start });
      expect(
        (await app.listStaffQueue(staff, { tag: "forged" })).items,
      ).toEqual([]);
      expect(
        (
          await app.listStaffQueue(staff, {
            target: "resolution",
            targetState: "overdue",
          })
        ).items,
      ).toEqual([]);
    });

    it("rejects every stale staff mutation without writes and replays committed results", async () => {
      const store = fixture();
      const app = createSupportDeskApplication({
        store,
        clock: { now: () => start },
        allowedTags: ["review"],
      });
      await create(app);
      const note = {
        ...base,
        commandId: "note",
        expectedRevision: 1,
        messageId: "note",
        body: "Private",
      };
      const committed = await app.addNote(staff, note);
      const stale = { ...base, commandId: "stale", expectedRevision: 1 };
      const mutations = [
        () =>
          app.replyAsStaff(staff, {
            ...stale,
            messageId: "reply",
            body: "Reply",
          }),
        () =>
          app.addNote(staff, { ...stale, messageId: "note2", body: "Note" }),
        () => app.assignTicket(staff, { ...stale, assigneeId: null }),
        () => app.changePriority(staff, { ...stale, priority: "high" }),
        () => app.setTags(staff, { ...stale, tags: ["review"] }),
        () => app.resolveTicket(staff, stale),
        () => app.closeTicket(staff, stale),
        () => app.reopenTicket(staff, stale),
      ];
      const rows = await store.collection(supportRecords).list("ticket");
      for (const mutate of mutations) {
        await expect(mutate()).rejects.toBeInstanceOf(
          SupportDeskStaleRevisionError,
        );
        await expect(mutate()).rejects.toMatchObject({
          currentRevision: 2,
          updatedAt: start,
          message: "The ticket changed since it was loaded",
        });
      }
      expect(await store.collection(supportRecords).list("ticket")).toEqual(
        rows,
      );
      await app.assignTicket(staff, {
        ...base,
        commandId: "assign",
        assigneeId: "staff2",
      });
      expect(await app.addNote(staff, note)).toEqual(committed);
      await expect(
        app.addNote(staff, { ...note, expectedRevision: 3 }),
      ).rejects.toBeInstanceOf(SupportDeskConflictError);
    });

    it("applies the same host targets on inbound create and reply, skipping provider replay", async () => {
      const store = fixture();
      let now = start;
      const computeTargets = vi.fn<ResponseTargetPolicy["computeTargets"]>(
        () => ({ firstResponseDueAt: now, resolutionDueAt: later }),
      );
      const inbound = createInboundMailProcessor({
        store,
        clock: { now: () => now },
        accountMatcher: { matchSenderEmail: async () => ({ matches: "none" }) },
        routingPolicy: { routeNewConversation: () => ({ priority: "low" }) },
        responseTargetPolicy: { computeTargets },
      });
      const input = {
        ...base,
        ticketId: "email",
        messageId: "email1",
        channelId: "mail",
        providerEventId: "event1",
        from: "sender@example.test",
        subject: "Question",
        body: "Hello",
        externalMessageId: "<first@example.test>",
      };
      await inbound.processInboundEmail(input);
      await inbound.processInboundEmail(input);
      expect(computeTargets).toHaveBeenCalledTimes(1);
      now = later;
      await inbound.processInboundEmail({
        ...input,
        ticketId: "email-new",
        providerEventId: "event2",
        messageId: "email2",
        externalMessageId: "<second@example.test>",
        inReplyTo: input.externalMessageId,
      });
      expect(computeTargets).toHaveBeenCalledTimes(2);
      const app = createSupportDeskApplication({
        store,
        clock: { now: () => now },
      });
      expect((await app.readStaffTicket(staff, "email")).ticket).toMatchObject({
        firstResponseDueAt: later,
        resolutionDueAt: later,
      });
    });
  });
}
