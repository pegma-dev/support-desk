import { TableClient } from "@azure/data-tables";
import { createAzureTablesStore } from "@pegma/storage-azure-tables";
import { createMemoryStore, type Store } from "@pegma/storage-core";
import { describe, expect, it, vi } from "vitest";
import {
  createSupportDeskApplication,
  supportPermissions,
  supportRecords,
  SupportDeskAuthorizationError,
  SupportDeskConflictError,
  SupportDeskStaleRevisionError,
} from "@pegma/support-desk-application";
import {
  EXAMPLE_CUSTOMER as customer,
  EXAMPLE_STAFF as staff,
  runCannedResponseExampleFlow,
} from "../examples/composition/composition.js";
import { TABLE_PORT } from "../test/azurite.js";
import { delegateCollection } from "../test/delegating-collection.js";
import { defineTemplate, renderTemplate } from "@pegma/support-desk-templates";

const now = "2026-11-12T10:00:00.000Z";
const clock = { now: () => now };
const catalog = [
  {
    id: "acknowledge",
    version: 1,
    title: "Acknowledge",
    target: "reply" as const,
    variables: ["topic"],
    body: "We will review {{topic}}.",
  },
  {
    id: "investigate",
    version: 2,
    title: "Investigation note",
    target: "note" as const,
    variables: [],
    body: "Private investigation checklist.",
  },
];
const selection = {
  id: "acknowledge",
  version: 1,
  values: { topic: "your question" },
};
const reply = {
  ticketId: "ticket",
  commandId: "reply",
  messageId: "reply",
  correlationId: "test",
  body: "We will review your question.",
  cannedResponse: selection,
  expectedRevision: 1,
};
let ordinal = 0;
function azureStore(): Store {
  return createAzureTablesStore({
    client: TableClient.fromConnectionString(
      `DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;TableEndpoint=http://127.0.0.1:${TABLE_PORT}/devstoreaccount1;`,
      `canned${process.pid}${++ordinal}`,
      { allowInsecureConnection: true },
    ),
  });
}
async function setup(store: Store) {
  const app = createSupportDeskApplication({
    store,
    clock,
    cannedResponses: catalog,
  });
  await app.createCustomerTicket(customer, {
    ticketId: "ticket",
    commandId: "create",
    messageId: "initial",
    correlationId: "test",
    subject: "Synthetic question",
    body: "Please help",
  });
  return app;
}

for (const [name, fixture] of [
  ["memory", createMemoryStore],
  ["Azurite", azureStore],
] as const) {
  describe(`staff canned responses (${name})`, () => {
    it("commits reply provenance in Audit, replays after catalog removal, and enforces current authority", async () => {
      const store = fixture();
      const app = await setup(store);
      const accepted = await app.replyAsStaff(staff, reply);
      const audit = await app.readTicketAuditHistory(staff, "ticket");
      expect(audit.at(-1)?.details).toMatchObject({
        cannedResponseId: "acknowledge",
        cannedResponseVersion: "1",
      });
      expect(JSON.stringify(audit)).not.toContain("your question");
      const removed = createSupportDeskApplication({ store, clock });
      await removed.addNote(staff, {
        ticketId: "ticket",
        correlationId: "test",
        commandId: "later",
        messageId: "later",
        body: "Later note",
        expectedRevision: 2,
      });
      expect(await removed.replyAsStaff(staff, reply)).toEqual(accepted);
      await expect(removed.replyAsStaff(customer, reply)).rejects.toThrow(
        SupportDeskAuthorizationError,
      );
      await expect(
        removed.replyAsStaff(staff, {
          ...reply,
          commandId: "new",
          messageId: "new",
          expectedRevision: 3,
        }),
      ).rejects.toThrow(TypeError);
      expect(
        (await removed.readStaffTicket(staff, "ticket")).messages,
      ).toHaveLength(3);
    });

    it("rejects changed preview, wrong target and unavailable versions without writes", async () => {
      const store = fixture();
      const app = await setup(store);
      const before = await store.collection(supportRecords).list("ticket");
      for (const command of [
        { ...reply, body: "Edited without a matching preview" },
        { ...reply, cannedResponse: { ...selection, version: 2 } },
        { ...reply, cannedResponse: { id: "missing", version: 1, values: {} } },
        {
          ...reply,
          body: catalog[1]!.body,
          cannedResponse: { id: "investigate", version: 2, values: {} },
        },
      ])
        await expect(app.replyAsStaff(staff, command)).rejects.toThrow(
          TypeError,
        );
      await expect(app.addNote(staff, reply)).rejects.toThrow(TypeError);
      expect(await store.collection(supportRecords).list("ticket")).toEqual(
        before,
      );
    });

    it("lists only authorized response targets and never grants mutation permission", async () => {
      const app = await setup(fixture());
      const queueOnly = {
        ...staff,
        permissions: [supportPermissions.queueRead],
      };
      const replyOnly = {
        ...staff,
        permissions: [supportPermissions.replyAny],
      };
      const noteOnly = {
        ...staff,
        permissions: [supportPermissions.queueRead, supportPermissions.note],
      };
      const replyStaff = {
        ...staff,
        permissions: [
          supportPermissions.queueRead,
          supportPermissions.replyAny,
        ],
      };
      await expect(app.listCannedResponses(customer)).rejects.toThrow(
        SupportDeskAuthorizationError,
      );
      expect(await app.listCannedResponses(queueOnly)).toEqual([]);
      expect(
        (await app.listCannedResponses(replyStaff)).map((item) => item.id),
      ).toEqual(["acknowledge"]);
      expect(
        (await app.listCannedResponses(noteOnly)).map((item) => item.id),
      ).toEqual(["investigate"]);
      for (const access of [customer, queueOnly, replyOnly, noteOnly])
        await expect(app.replyAsStaff(access, reply)).rejects.toThrow(
          SupportDeskAuthorizationError,
        );
      await expect(
        app.addNote(replyStaff, {
          ...reply,
          body: catalog[1]!.body,
          cannedResponse: { id: "investigate", version: 2, values: {} },
        }),
      ).rejects.toThrow(SupportDeskAuthorizationError);
      const listed = await app.listCannedResponses(staff);
      expect(Object.isFrozen(listed)).toBe(true);
      expect(Object.isFrozen(listed[0])).toBe(true);
    });

    it("keeps canned notes, catalog and provenance out of customer views and mail", async () => {
      const store = fixture();
      const app = await setup(store);
      const before = await app.readCustomerTicket(customer, "ticket");
      await app.addNote(staff, {
        ...reply,
        body: catalog[1]!.body,
        cannedResponse: { id: "investigate", version: 2, values: {} },
      });
      expect(await app.readCustomerTicket(customer, "ticket")).toEqual(before);
      expect(
        (await store.collection(supportRecords).list("ticket")).filter(
          (row) => row.kind === "delivery_job",
        ),
      ).toHaveLength(0);
      const audit = await app.readTicketAuditHistory(staff, "ticket");
      expect(audit.at(-1)?.action).toBe("support.ticket.note_added");
      expect(audit.at(-1)?.details).toMatchObject({
        cannedResponseId: "investigate",
        cannedResponseVersion: "2",
      });
      const accepted = await app.replyAsStaff(staff, {
        ...reply,
        commandId: "public-reply",
        messageId: "public-reply",
        expectedRevision: 2,
        notification: {
          id: "mail",
          recipientRef: "customer",
          templateId: "staff.reply",
          templateVersion: 1,
          variables: {},
          subject: "Support reply",
          outboundMessageId: "<reply@example.invalid>",
        },
      });
      const visible = await app.readCustomerTicket(customer, "ticket");
      expect(visible.messages.map((item) => item.body)).toEqual([
        "Please help",
        reply.body,
      ]);
      expect(JSON.stringify(visible)).not.toMatch(
        /investigate|cannedResponse|acknowledge|Private investigation/,
      );
      expect(accepted.ticket.firstStaffRespondedAt).toBe(now);
      const rows = await store.collection(supportRecords).list("ticket");
      expect(rows.filter((row) => row.kind === "delivery_job")).toHaveLength(1);
      // The normal notification renderer escapes the approved message as a value.
      const html = renderTemplate(
        defineTemplate({
          id: "reply",
          version: 1,
          variables: ["message"],
          plainText: "{{message}}",
          html: "<p>{{message}}</p>",
        }),
        { message: visible.messages.at(-1)!.body },
      );
      expect(html.html).toBe("<p>We will review your question.</p>");
      expect(
        JSON.stringify(rows.filter((row) => row.kind === "delivery_job")),
      ).not.toMatch(/cannedResponse|investigate|Private investigation/);
    });

    it("retains revision fences, exact replay and distinct selection fingerprints", async () => {
      const store = fixture();
      const app = await setup(store);
      const [first, second] = await Promise.all([
        app.replyAsStaff(staff, reply),
        app.replyAsStaff(staff, reply),
      ]);
      expect(first).toEqual(second);
      await expect(
        app.replyAsStaff(staff, {
          ...reply,
          cannedResponse: { ...selection, version: 2 },
        }),
      ).rejects.toThrow(SupportDeskConflictError);
      const { cannedResponse: _selection, ...manual } = reply;
      await expect(app.replyAsStaff(staff, manual)).rejects.toThrow(
        SupportDeskConflictError,
      );
      await expect(
        app.replyAsStaff(staff, {
          ...reply,
          commandId: "stale",
          messageId: "stale",
        }),
      ).rejects.toThrow(SupportDeskStaleRevisionError);
      expect(
        (await app.readStaffTicket(staff, "ticket")).messages,
      ).toHaveLength(2);
      expect(await app.readTicketAuditHistory(staff, "ticket")).toHaveLength(2);
    });

    it("rolls back reply, receipt, Audit and outbox together and recovers the same command", async () => {
      const store = fixture();
      const app = await setup(store);
      const before = await store.collection(supportRecords).list("ticket");
      const failing: Store = {
        collection(definition) {
          const collection = store.collection(definition);
          return definition.name === supportRecords.name
            ? delegateCollection(collection, {
                async transact() {
                  throw new Error("Synthetic transaction outage");
                },
              })
            : collection;
        },
      };
      const blocked = createSupportDeskApplication({
        store: failing,
        clock,
        cannedResponses: catalog,
      });
      const command = {
        ...reply,
        notification: {
          id: "mail",
          recipientRef: "customer",
          templateId: "reply",
          templateVersion: 1,
          variables: {},
          subject: "Reply",
          outboundMessageId: "<reply@example.invalid>",
        },
      };
      await expect(blocked.replyAsStaff(staff, command)).rejects.toThrow(
        "Synthetic transaction outage",
      );
      expect(await store.collection(supportRecords).list("ticket")).toEqual(
        before,
      );
      await app.replyAsStaff(staff, command);
      await app.replyAsStaff(staff, command);
      const rows = await store.collection(supportRecords).list("ticket");
      expect(rows.filter((row) => row.kind === "delivery_job")).toHaveLength(1);
      expect(rows.filter((row) => row.kind === "audit")).toHaveLength(2);
      expect(rows.filter((row) => row.kind === "command")).toHaveLength(2);
    });

    it("retains message quotas and fails atomically on an occupied message slot", async () => {
      const store = fixture();
      const app = await setup(store);
      await app.addNote(staff, {
        ticketId: "ticket",
        commandId: "occupy",
        messageId: "reply",
        correlationId: "test",
        body: "Existing private note",
      });
      const before = await store.collection(supportRecords).list("ticket");
      await expect(
        app.replyAsStaff(staff, { ...reply, expectedRevision: 2 }),
      ).rejects.toThrow(SupportDeskConflictError);
      expect(await store.collection(supportRecords).list("ticket")).toEqual(
        before,
      );
      const limited = createSupportDeskApplication({
        store,
        clock,
        cannedResponses: catalog,
        limits: { maxMessagesPerTicket: 2 },
      });
      await expect(
        limited.replyAsStaff(staff, {
          ...reply,
          messageId: "new",
          expectedRevision: 2,
        }),
      ).rejects.toThrow(/limit/i);
      expect(await store.collection(supportRecords).list("ticket")).toEqual(
        before,
      );
    });
  });
}

describe("canned response boundary snapshots", () => {
  it("exercises explicit staff approval and private notes in the runnable composition", async () => {
    expect(await runCannedResponseExampleFlow()).toEqual({
      customerMessages: 2,
      auditedUses: 2,
    });
  });
  it("freezes configuration and command values before awaits", async () => {
    const store = createMemoryStore();
    const definitions = catalog.map((item) => ({
      ...item,
      variables: [...item.variables],
    }));
    const app = createSupportDeskApplication({
      store,
      clock,
      cannedResponses: definitions,
    });
    await app.createCustomerTicket(customer, {
      ticketId: "ticket",
      commandId: "create",
      messageId: "initial",
      correlationId: "test",
      subject: "Question",
      body: "Hello",
    });
    definitions[0]!.body = "Changed";
    definitions[0]!.variables.push("secret");
    const command = {
      ...reply,
      cannedResponse: { ...selection, values: { ...selection.values } },
    };
    const pending = app.replyAsStaff(staff, command);
    command.body = "Changed after entry";
    command.cannedResponse.values.topic = "Changed after entry";
    expect((await pending).messages.at(-1)?.body).toBe(reply.body);
  });

  it("rejects inherited, accessor and unknown selections before storage", async () => {
    const store = createMemoryStore();
    const app = await setup(store);
    const getter = vi.fn(() => selection);
    for (const cannedResponse of [
      { ...selection, values: { topic: "question", extra: "private" } },
      {
        ...selection,
        values: Object.defineProperty({}, "topic", { get: getter }),
      },
      Object.create(selection),
      { ...selection, target: "reply" },
      { ...selection, values: { topic: "bad\u0000" } },
    ])
      await expect(
        app.replyAsStaff(staff, { ...reply, cannedResponse }),
      ).rejects.toThrow(TypeError);
    await expect(
      app.replyAsStaff(
        staff,
        Object.defineProperty({ ...reply }, "cannedResponse", { get: getter }),
      ),
    ).rejects.toThrow(TypeError);
    const inherited = Object.assign(
      Object.create({ cannedResponse: selection }),
      {
        ticketId: "ticket",
        commandId: "inherited",
        messageId: "inherited",
        correlationId: "test",
        body: reply.body,
      },
    );
    await expect(app.replyAsStaff(staff, inherited)).rejects.toThrow(TypeError);
    expect(getter).not.toHaveBeenCalled();
    expect((await app.readStaffTicket(staff, "ticket")).ticket.revision).toBe(
      1,
    );
  });

  it("uses canonical value order for replay and preserves ordinary reply behavior", async () => {
    const store = createMemoryStore();
    const app = createSupportDeskApplication({
      store,
      clock,
      cannedResponses: [
        {
          ...catalog[0]!,
          variables: ["first", "last"],
          body: "{{first}} {{last}}",
        },
      ],
    });
    await app.createCustomerTicket(customer, {
      ticketId: "ticket",
      commandId: "create",
      messageId: "initial",
      correlationId: "test",
      subject: "Question",
      body: "Hello",
    });
    const command = {
      ...reply,
      body: "Hello there",
      cannedResponse: {
        ...selection,
        values: { first: "Hello", last: "there" },
      },
    };
    const accepted = await app.replyAsStaff(staff, command);
    expect(
      await app.replyAsStaff(staff, {
        ...command,
        cannedResponse: {
          ...selection,
          values: { last: "there", first: "Hello" },
        },
      }),
    ).toEqual(accepted);
    const ordinary = createSupportDeskApplication({ store, clock });
    await ordinary.replyAsStaff(staff, {
      ticketId: "ticket",
      commandId: "ordinary",
      messageId: "ordinary",
      correlationId: "test",
      body: "Manual reply",
      expectedRevision: 2,
    });
    expect(
      (await ordinary.readTicketAuditHistory(staff, "ticket")).at(-1)?.details,
    ).not.toHaveProperty("cannedResponseId");
  });
});
