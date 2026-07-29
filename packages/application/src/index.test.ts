import type { AccessContext } from "@pegma/authorization-core";
import { auditRecordId } from "@pegma/audit";
import { maxMailAttempts } from "@pegma/mail";
import { fixedClock } from "@pegma/spine";
import {
  createMemoryStore,
  type CollectionStore,
  type Store,
} from "@pegma/storage-core";
import { describe, expect, it } from "vitest";
import {
  createSupportDeskApplication,
  type CustomerTicketIndexRecord,
  customerTicketIndex,
  deliveryCallbackBucket,
  deliveryCallbackReceipts,
  inboundReceiptBucket,
  inboundReceiptDedupeDays,
  inboundReceiptLocation,
  inboundReceipts,
  maxDeliveryCallbacksPerBucket,
  maxInboundReceiptsPerBucket,
  pruneCustomerTicketIndex,
  recordDeliveryCallback,
  SupportDeskConflictError,
  supportAudit,
  supportPermissions,
  supportRecords,
  supportMail,
  supportTicketAuditActions,
  SupportDeskAuthorizationError,
  SupportDeskLimitError,
  SupportDeskNotFoundError,
  type SupportRecord,
  sweepDeliveryCallbackReceipts,
  sweepInboundReceipts,
} from "./index.js";

function access(
  principalId: string,
  permissions: readonly string[],
): AccessContext {
  return {
    principalId,
    policyVersion: "test",
    roles: [],
    entitlements: [],
    permissions,
  };
}

const allCustomerPermissions = [
  supportPermissions.create,
  supportPermissions.readOwn,
  supportPermissions.replyOwn,
] as const;
const callbackClock = fixedClock("2026-07-27T14:00:00.000Z");

function sequenceClock(...timestamps: readonly string[]) {
  let index = 0;
  return {
    now() {
      const timestamp = timestamps[Math.min(index, timestamps.length - 1)];
      index += 1;
      if (timestamp === undefined) {
        throw new Error("test clock has no timestamp");
      }
      return timestamp;
    },
  };
}

describe("customer application services", () => {
  it("commits the ticket, message, audit, command receipt, and outbox together", async () => {
    const store = createMemoryStore();
    const application = createSupportDeskApplication({
      store,
      clock: fixedClock("2026-07-27T12:00:00.000Z"),
    });

    const created = await application.createCustomerTicket(
      access("customer-1", allCustomerPermissions),
      {
        commandId: "command-1",
        correlationId: "correlation-1",
        ticketId: "ticket-1",
        ticketNumber: 42,
        messageId: "message-1",
        subject: "Cannot open my plan",
        body: "The plan page stays blank.",
        notification: {
          id: "notification-1",
          recipientRef: "support-queue",
          templateId: "staff.new-ticket",
          templateVersion: 1,
          variables: { ticket_number: "42" },
          subject: "[Ticket #42] Cannot open my plan",
          outboundMessageId: "<support.notification-1@example.test>",
        },
      },
    );

    expect(created.ticket.id).toBe("ticket-1");
    expect(created.ticket.number).toBe(42);
    expect(created.ticket.customerUpdatedAt).toBe("2026-07-27T12:00:00.000Z");
    expect(created.messages.map((message) => message.body)).toEqual([
      "The plan page stays blank.",
    ]);
    const storedTicket = (
      await store.collection(supportRecords).list("ticket-1")
    ).find((record) => record.kind === "ticket");
    expect(
      storedTicket?.kind === "ticket" &&
        storedTicket.ticket.requester.principalId,
    ).toBe("customer-1");
    const records = await store.collection(supportRecords).list("ticket-1");
    expect(records.map((record) => record.kind).sort()).toEqual([
      "audit",
      "command",
      "delivery_job",
      "message",
      "ticket",
      "ticket_quota",
      "ticket_reservation",
    ]);
    const history = await supportAudit.history(
      store.collection(supportRecords),
      "ticket-1",
    );
    expect(history).toEqual([
      {
        id: "command-1",
        occurredAt: "2026-07-27T12:00:00.000Z",
        actor: { kind: "principal", principalId: "customer-1" },
        action: supportTicketAuditActions.created,
        subject: "ticket-1",
        sequence: 1,
        details: {
          commandId: "command-1",
          correlationId: "correlation-1",
        },
      },
    ]);
    const auditRecord = records.find((record) => record.kind === "audit");
    expect(auditRecord?.id).toBe(auditRecordId("command-1"));
  });

  it("commits create and reply Audit actions with the state change", async () => {
    const store = createMemoryStore();
    const records = store.collection(supportRecords);
    const application = createSupportDeskApplication({
      store,
      clock: fixedClock("2026-07-27T12:00:00.000Z"),
    });
    const caller = access("customer-1", allCustomerPermissions);

    await application.createCustomerTicket(caller, {
      commandId: "command-1",
      correlationId: "correlation-1",
      ticketId: "ticket-1",
      ticketNumber: 42,
      messageId: "message-1",
      subject: "Question",
      body: "Please help.",
    });
    await application.replyToCustomerTicket(caller, {
      commandId: "reply-1",
      correlationId: "correlation-2",
      ticketId: "ticket-1",
      messageId: "message-2",
      body: "More detail.",
    });

    const history = await supportAudit.history(records, "ticket-1");
    expect(
      history.map((event) => [event.action, event.sequence, event.id]),
    ).toEqual([
      [supportTicketAuditActions.created, 1, "command-1"],
      [supportTicketAuditActions.customerReplied, 2, "reply-1"],
    ]);
    expect(history.every((event) => event.subject === "ticket-1")).toBe(true);
  });

  it("leaves no state change or orphan Audit event when a transaction is refused", async () => {
    const store = createMemoryStore();
    const records = store.collection(supportRecords);
    const application = createSupportDeskApplication({
      store,
      clock: fixedClock("2026-07-27T12:00:00.000Z"),
    });
    const caller = access("customer-1", allCustomerPermissions);

    await application.createCustomerTicket(caller, {
      commandId: "command-1",
      correlationId: "correlation-1",
      ticketId: "ticket-1",
      ticketNumber: 42,
      messageId: "message-1",
      subject: "Question",
      body: "Please help.",
    });

    await expect(
      application.createCustomerTicket(caller, {
        commandId: "command-2",
        correlationId: "correlation-2",
        ticketId: "ticket-1",
        ticketNumber: 43,
        messageId: "message-2",
        subject: "Collision",
        body: "Should not commit.",
      }),
    ).rejects.toBeInstanceOf(SupportDeskConflictError);

    expect(await supportAudit.history(records, "ticket-1")).toHaveLength(1);
    expect(
      (await records.list("ticket-1")).filter(
        (record) => record.kind === "message",
      ),
    ).toHaveLength(1);
    expect(
      (await records.list("ticket-1")).some(
        (record) =>
          record.kind === "command" && record.commandId === "command-2",
      ),
    ).toBe(false);
  });

  it("does not append a second Audit event when a command is replayed", async () => {
    const store = createMemoryStore();
    const records = store.collection(supportRecords);
    const application = createSupportDeskApplication({
      store,
      clock: fixedClock("2026-07-27T12:00:00.000Z"),
    });
    const caller = access("customer-1", allCustomerPermissions);
    const createCommand = {
      commandId: "command-1",
      correlationId: "correlation-1",
      ticketId: "ticket-1",
      ticketNumber: 42,
      messageId: "message-1",
      subject: "Question",
      body: "Please help.",
    };
    const replyCommand = {
      commandId: "reply-1",
      correlationId: "correlation-2",
      ticketId: "ticket-1",
      messageId: "message-2",
      body: "More detail.",
    };

    await application.createCustomerTicket(caller, createCommand);
    await application.createCustomerTicket(caller, createCommand);
    await application.replyToCustomerTicket(caller, replyCommand);
    await application.replyToCustomerTicket(caller, replyCommand);

    expect(await supportAudit.history(records, "ticket-1")).toHaveLength(2);
  });

  it("orders Audit history by ticket revision when timestamps are equal", async () => {
    const store = createMemoryStore();
    const records = store.collection(supportRecords);
    const application = createSupportDeskApplication({
      store,
      clock: fixedClock("2026-07-27T12:00:00.000Z"),
    });
    const caller = access("customer-1", allCustomerPermissions);

    await application.createCustomerTicket(caller, {
      commandId: "command-1",
      correlationId: "correlation-1",
      ticketId: "ticket-1",
      ticketNumber: 42,
      messageId: "message-1",
      subject: "Question",
      body: "Please help.",
    });
    await application.replyToCustomerTicket(caller, {
      commandId: "reply-1",
      correlationId: "correlation-2",
      ticketId: "ticket-1",
      messageId: "message-2",
      body: "More detail.",
    });
    await application.replyToCustomerTicket(caller, {
      commandId: "reply-2",
      correlationId: "correlation-3",
      ticketId: "ticket-1",
      messageId: "message-3",
      body: "Still more.",
    });

    const history = await supportAudit.history(records, "ticket-1");
    expect(new Set(history.map((event) => event.occurredAt))).toEqual(
      new Set(["2026-07-27T12:00:00.000Z"]),
    );
    expect(history.map((event) => event.sequence)).toEqual([1, 2, 3]);
  });

  it("keeps Audit records out of customer views", async () => {
    const store = createMemoryStore();
    const application = createSupportDeskApplication({
      store,
      clock: fixedClock("2026-07-27T12:00:00.000Z"),
    });
    const caller = access("customer-1", allCustomerPermissions);

    await application.createCustomerTicket(caller, {
      commandId: "command-1",
      correlationId: "correlation-1",
      ticketId: "ticket-1",
      ticketNumber: 42,
      messageId: "message-1",
      subject: "Question",
      body: "Please help.",
    });
    const view = await application.readCustomerTicket(caller, "ticket-1");
    const listed = await application.listCustomerTickets(caller);

    expect(Object.keys(view).sort()).toEqual(["messages", "ticket"]);
    expect(JSON.stringify(view)).not.toContain("audit");
    expect(JSON.stringify(view)).not.toContain(
      supportTicketAuditActions.created,
    );
    expect(JSON.stringify(listed)).not.toContain("audit");
    expect(
      await supportAudit.history(store.collection(supportRecords), "ticket-1"),
    ).toHaveLength(1);
  });

  it("returns customer-safe summaries without staff-only fields", async () => {
    const store = createMemoryStore();
    const application = createSupportDeskApplication({
      store,
      clock: fixedClock("2026-07-27T12:00:00.000Z"),
      allowedCategories: ["feedback"],
    });
    const caller = access("customer-1", allCustomerPermissions);

    const created = await application.createCustomerTicket(caller, {
      commandId: "command-1",
      correlationId: "correlation-1",
      ticketId: "ticket-1",
      ticketNumber: 42,
      messageId: "message-1",
      subject: "Product feedback",
      body: "Please help.",
      category: "feedback",
      requesterEmail: "customer@example.com",
    });
    const listed = await application.listCustomerTickets(caller);
    const encoded = JSON.stringify({ created, listed });

    expect(created.ticket).toEqual({
      id: "ticket-1",
      number: 42,
      subject: "Product feedback",
      category: "feedback",
      status: "open",
      channel: "web",
      createdAt: "2026-07-27T12:00:00.000Z",
      customerUpdatedAt: "2026-07-27T12:00:00.000Z",
    });
    expect(Object.keys(created.ticket).sort()).toEqual([
      "category",
      "channel",
      "createdAt",
      "customerUpdatedAt",
      "id",
      "number",
      "status",
      "subject",
    ]);
    expect(listed).toEqual([created.ticket]);
    expect(created.messages[0]).toEqual({
      id: "message-1",
      ticketId: "ticket-1",
      authorKind: "customer",
      channel: "web",
      visibility: "customer",
      format: "plain_text",
      body: "Please help.",
      createdAt: "2026-07-27T12:00:00.000Z",
    });
    expect(Object.keys(created.messages[0]!).sort()).toEqual([
      "authorKind",
      "body",
      "channel",
      "createdAt",
      "format",
      "id",
      "ticketId",
      "visibility",
    ]);
    expect(encoded).not.toContain('"requester"');
    expect(encoded).not.toContain('"priority"');
    expect(encoded).not.toContain('"assignedTo"');
    expect(encoded).not.toContain('"revision"');
    expect(encoded).not.toContain('"updatedAt"');
    expect(encoded).not.toContain('"authorPrincipalId"');
    expect(encoded).not.toContain('"externalMessageId"');
    expect(encoded).not.toContain("audit");
    expect(encoded).not.toContain("customer@example.com");

    const stored = (
      await store.collection(supportRecords).list("ticket-1")
    ).find((record) => record.kind === "ticket");
    expect(stored?.kind === "ticket" && stored.ticket.priority).toBe("normal");
    expect(stored?.kind === "ticket" && stored.ticket.requester.email).toBe(
      "customer@example.com",
    );
  });

  it("supports RetireGolden entitlement and pegma.dev default policy fixtures", async () => {
    const retiregoldenPolicy = access("rg-customer", allCustomerPermissions);
    const pegmaAuthenticated = access("pegma-user", allCustomerPermissions);
    const pegmaUnentitledWithoutPerms = access("pegma-free", []);

    for (const [label, caller, categories] of [
      ["retiregolden", retiregoldenPolicy, ["billing", "account"] as const],
      [
        "pegma.dev",
        pegmaAuthenticated,
        [
          "feedback",
          "bug",
          "feature_request",
          "documentation",
          "question",
        ] as const,
      ],
    ] as const) {
      const store = createMemoryStore();
      const application = createSupportDeskApplication({
        store,
        clock: fixedClock("2026-07-27T12:00:00.000Z"),
        allowedCategories: [...categories],
      });
      const created = await application.createCustomerTicket(caller, {
        commandId: `${label}-create`,
        correlationId: `${label}-correlation`,
        ticketId: `${label}-ticket`,
        ticketNumber: 1,
        messageId: `${label}-message`,
        subject: `${label} question`,
        body: "Hello",
        category: categories[0],
      });
      expect(created.ticket.category).toBe(categories[0]);
      expect(await application.listCustomerTickets(caller)).toHaveLength(1);
      await application.replyToCustomerTicket(caller, {
        commandId: `${label}-reply`,
        correlationId: `${label}-reply-correlation`,
        ticketId: `${label}-ticket`,
        messageId: `${label}-reply`,
        body: "More detail",
      });
      const detail = await application.readCustomerTicket(
        caller,
        `${label}-ticket`,
      );
      expect(detail.messages).toHaveLength(2);
      expect(detail.ticket.status).toBe("waiting_on_support");
      expect(detail.ticket.category).toBe(categories[0]);
    }

    const store = createMemoryStore();
    const application = createSupportDeskApplication({
      store,
      clock: fixedClock("2026-07-27T12:00:00.000Z"),
      allowedCategories: ["feedback"],
    });
    await expect(
      application.createCustomerTicket(pegmaUnentitledWithoutPerms, {
        commandId: "denied",
        correlationId: "denied",
        ticketId: "ticket-denied",
        ticketNumber: 1,
        messageId: "message-denied",
        subject: "Should fail",
        body: "No permission",
        category: "feedback",
      }),
    ).rejects.toBeInstanceOf(SupportDeskAuthorizationError);
  });

  it("validates category shape and allowlist before persistence", async () => {
    const store = createMemoryStore();
    const application = createSupportDeskApplication({
      store,
      clock: fixedClock("2026-07-27T12:00:00.000Z"),
      allowedCategories: ["feedback", "bug"],
    });
    const caller = access("customer-1", allCustomerPermissions);
    const base = {
      commandId: "command-1",
      correlationId: "correlation-1",
      ticketId: "ticket-1",
      ticketNumber: 1,
      messageId: "message-1",
      subject: "Question",
      body: "Please help.",
    };

    await expect(
      application.createCustomerTicket(caller, {
        ...base,
        category: "unknown",
      }),
    ).rejects.toThrow(/category is not configured/);
    await expect(
      application.createCustomerTicket(caller, {
        ...base,
        category: "Bug",
      }),
    ).rejects.toThrow(/must match/);
    await expect(
      application.createCustomerTicket(caller, {
        ...base,
        category: "a".repeat(33),
      }),
    ).rejects.toThrow(/must match/);
    await expect(
      application.createCustomerTicket(caller, {
        ...base,
        category: "bad-dash",
      }),
    ).rejects.toThrow(/must match/);
    await expect(
      application.createCustomerTicket(caller, {
        ...base,
        category: "bad\u0000",
      }),
    ).rejects.toThrow(/must match/);

    const accessorCategoryCommand = { ...base };
    Object.defineProperty(accessorCategoryCommand, "category", {
      enumerable: true,
      configurable: true,
      get() {
        throw new Error("accessor should not run");
      },
    });
    await expect(
      application.createCustomerTicket(
        caller,
        accessorCategoryCommand as never,
      ),
    ).rejects.toThrow(/own data property/);

    expect(await store.collection(supportRecords).list("ticket-1")).toEqual([]);

    expect(() =>
      createSupportDeskApplication({
        store,
        clock: fixedClock("2026-07-27T12:00:00.000Z"),
        allowedCategories: ["feedback", "feedback"],
      }),
    ).toThrow(/duplicates/);
    expect(() =>
      createSupportDeskApplication({
        store,
        clock: fixedClock("2026-07-27T12:00:00.000Z"),
        allowedCategories: Array.from({ length: 33 }, (_, i) => `c${i}`),
      }),
    ).toThrow(/at most 32/);
    const accessorAllowlist = ["feedback"];
    Object.defineProperty(accessorAllowlist, 0, {
      enumerable: true,
      get() {
        throw new Error("allowlist accessor should not run");
      },
    });
    expect(() =>
      createSupportDeskApplication({
        store,
        clock: fixedClock("2026-07-27T12:00:00.000Z"),
        allowedCategories: accessorAllowlist,
      }),
    ).toThrow(/own data property/);
  });

  it("includes category in the create idempotency fingerprint", async () => {
    const store = createMemoryStore();
    const application = createSupportDeskApplication({
      store,
      clock: fixedClock("2026-07-27T12:00:00.000Z"),
      allowedCategories: ["feedback", "bug"],
    });
    const caller = access("customer-1", allCustomerPermissions);
    const command = {
      commandId: "command-1",
      correlationId: "correlation-1",
      ticketId: "ticket-1",
      ticketNumber: 1,
      messageId: "message-1",
      subject: "Question",
      body: "Please help.",
      category: "feedback",
    };

    await application.createCustomerTicket(caller, command);
    await expect(
      application.createCustomerTicket(caller, {
        ...command,
        category: "bug",
      }),
    ).rejects.toBeInstanceOf(SupportDeskConflictError);
  });

  it("replays a committed create after the category is removed from the allowlist", async () => {
    const store = createMemoryStore();
    const caller = access("customer-1", allCustomerPermissions);
    const command = {
      commandId: "command-1",
      correlationId: "correlation-1",
      ticketId: "ticket-1",
      ticketNumber: 1,
      messageId: "message-1",
      subject: "Question",
      body: "Please help.",
      category: "feedback",
    };
    const first = createSupportDeskApplication({
      store,
      clock: fixedClock("2026-07-27T12:00:00.000Z"),
      allowedCategories: ["feedback"],
    });
    const created = await first.createCustomerTicket(caller, command);

    const afterConfigChange = createSupportDeskApplication({
      store,
      clock: fixedClock("2026-07-27T12:00:00.000Z"),
      allowedCategories: ["bug"],
    });
    const replayed = await afterConfigChange.createCustomerTicket(
      caller,
      command,
    );
    expect(replayed.ticket).toEqual(created.ticket);
    expect(replayed.messages).toEqual(created.messages);

    await expect(
      afterConfigChange.createCustomerTicket(caller, {
        ...command,
        commandId: "command-2",
        ticketId: "ticket-2",
        messageId: "message-2",
        ticketNumber: 2,
      }),
    ).rejects.toThrow(/category is not configured/);
  });

  it("does not let category change authorization or initial priority", async () => {
    const store = createMemoryStore();
    const application = createSupportDeskApplication({
      store,
      clock: fixedClock("2026-07-27T12:00:00.000Z"),
      allowedCategories: ["bug", "question"],
    });
    const denied = access("no-perms", []);
    await expect(
      application.createCustomerTicket(denied, {
        commandId: "denied",
        correlationId: "denied",
        ticketId: "ticket-denied",
        ticketNumber: 1,
        messageId: "message-denied",
        subject: "Bug",
        body: "Still denied",
        category: "bug",
      }),
    ).rejects.toBeInstanceOf(SupportDeskAuthorizationError);

    const caller = access("customer-1", allCustomerPermissions);
    await application.createCustomerTicket(caller, {
      commandId: "command-1",
      correlationId: "correlation-1",
      ticketId: "ticket-1",
      ticketNumber: 1,
      messageId: "message-1",
      subject: "Bug",
      body: "Broken",
      category: "bug",
    });
    await application.createCustomerTicket(caller, {
      commandId: "command-2",
      correlationId: "correlation-2",
      ticketId: "ticket-2",
      ticketNumber: 2,
      messageId: "message-2",
      subject: "Question",
      body: "Curious",
      category: "question",
    });

    for (const ticketId of ["ticket-1", "ticket-2"]) {
      const stored = (
        await store.collection(supportRecords).list(ticketId)
      ).find((record) => record.kind === "ticket");
      expect(stored?.kind === "ticket" && stored.ticket.priority).toBe(
        "normal",
      );
    }
  });

  it("advances customerUpdatedAt on customer reply without exposing staff fields", async () => {
    const store = createMemoryStore();
    const application = createSupportDeskApplication({
      store,
      clock: sequenceClock(
        "2026-07-27T12:00:00.000Z",
        "2026-07-27T12:05:00.000Z",
      ),
      allowedCategories: ["question"],
    });
    const caller = access("customer-1", allCustomerPermissions);
    const created = await application.createCustomerTicket(caller, {
      commandId: "command-1",
      correlationId: "correlation-1",
      ticketId: "ticket-1",
      ticketNumber: 1,
      messageId: "message-1",
      subject: "Question",
      body: "Start",
      category: "question",
    });
    expect(created.ticket.customerUpdatedAt).toBe("2026-07-27T12:00:00.000Z");

    const replied = await application.replyToCustomerTicket(caller, {
      commandId: "reply-1",
      correlationId: "correlation-2",
      ticketId: "ticket-1",
      messageId: "message-2",
      body: "Follow up",
    });
    expect(replied.ticket.customerUpdatedAt).toBe("2026-07-27T12:05:00.000Z");
    expect(replied.ticket.category).toBe("question");
    expect("priority" in replied.ticket).toBe(false);
    expect("revision" in replied.ticket).toBe(false);
  });

  it("treats repeated commands as the same completed operation", async () => {
    const store = createMemoryStore();
    const application = createSupportDeskApplication({
      store,
      clock: fixedClock("2026-07-27T12:00:00.000Z"),
    });
    const caller = access("customer-1", allCustomerPermissions);
    const command = {
      commandId: "command-1",
      correlationId: "correlation-1",
      ticketId: "ticket-1",
      ticketNumber: 42,
      messageId: "message-1",
      subject: "Question",
      body: "Please help.",
    };

    await application.createCustomerTicket(caller, command);
    await application.createCustomerTicket(caller, command);
    await application.replyToCustomerTicket(caller, {
      commandId: "reply-1",
      correlationId: "correlation-2",
      ticketId: "ticket-1",
      messageId: "message-2",
      body: "More detail.",
    });
    const repeated = await application.replyToCustomerTicket(caller, {
      commandId: "reply-1",
      correlationId: "correlation-2",
      ticketId: "ticket-1",
      messageId: "message-2",
      body: "More detail.",
    });

    expect(repeated.ticket.status).toBe("waiting_on_support");
    expect(repeated.messages).toHaveLength(2);
    const storedAfterReplay = (
      await store.collection(supportRecords).list("ticket-1")
    ).find((record) => record.kind === "ticket");
    expect(
      storedAfterReplay?.kind === "ticket" && storedAfterReplay.ticket.revision,
    ).toBe(2);
    expect(
      (await store.collection(supportRecords).list("ticket-1"))
        .filter((record) => record.kind === "message")
        .sort((left, right) => left.ordinal! - right.ordinal!)
        .map((record) => [record.message.id, record.ordinal]),
    ).toEqual([
      ["message-1", 1],
      ["message-2", 2],
    ]);
    await expect(
      application.replyToCustomerTicket(caller, {
        commandId: "reply-1",
        correlationId: "correlation-2",
        ticketId: "ticket-1",
        messageId: "message-2",
        body: "A different request reusing the key.",
      }),
    ).rejects.toBeInstanceOf(SupportDeskConflictError);
  });

  it("serializes concurrent replies without losing either message", async () => {
    const store = createMemoryStore();
    const application = createSupportDeskApplication({
      store,
      clock: fixedClock("2026-07-27T12:00:00.000Z"),
      maxConflictAttempts: 10,
    });
    const caller = access("customer-1", allCustomerPermissions);
    await application.createCustomerTicket(caller, {
      commandId: "create",
      correlationId: "correlation-1",
      ticketId: "ticket-1",
      ticketNumber: 42,
      messageId: "message-1",
      subject: "Question",
      body: "Start.",
    });

    await Promise.all(
      ["2", "3", "4", "5"].map((suffix) =>
        application.replyToCustomerTicket(caller, {
          commandId: `reply-${suffix}`,
          correlationId: `correlation-${suffix}`,
          ticketId: "ticket-1",
          messageId: `message-${suffix}`,
          body: `Reply ${suffix}`,
        }),
      ),
    );

    const view = await application.readCustomerTicket(caller, "ticket-1");
    expect(view.messages).toHaveLength(5);
    const committed = (await store.collection(supportRecords).list("ticket-1"))
      .filter((record) => record.kind === "message")
      .sort((left, right) => left.ordinal! - right.ordinal!);
    expect(committed.map((record) => record.ordinal)).toEqual([1, 2, 3, 4, 5]);
    const storedTicket = (
      await store.collection(supportRecords).list("ticket-1")
    ).find((record) => record.kind === "ticket");
    expect(
      storedTicket?.kind === "ticket" && storedTicket.ticket.revision,
    ).toBe(5);
    expect(view.messages.map((message) => message.id)).toEqual(
      committed.map((record) => record.message.id),
    );
  });

  it("clamps the trusted reply clock on every transaction retry", async () => {
    const backing = createMemoryStore();
    const records = backing.collection(supportRecords);
    let replyTransactions = 0;
    const store: Store = {
      collection(definition) {
        const collection = backing.collection(definition);
        if (definition.name !== supportRecords.name) {
          return collection;
        }
        return {
          ...collection,
          async transact(partition, actions) {
            const isReply = actions.some(
              (action) =>
                action.action === "insert" &&
                (action.value as { readonly commandType?: string })
                  .commandType === "reply_customer_ticket",
            );
            if (isReply) {
              replyTransactions += 1;
            }
            if (isReply && replyTransactions === 1) {
              await records.update(
                { partition: "ticket", id: "ticket" },
                (current) => {
                  return current?.kind !== "ticket"
                    ? { action: "keep" }
                    : {
                        action: "write",
                        value: {
                          ...current,
                          ticket: {
                            ...current.ticket,
                            revision: current.ticket.revision + 1,
                            status: "waiting_on_support" as const,
                            updatedAt: "2026-07-27T12:10:00.000Z",
                          },
                        },
                      };
                },
              );
            }
            return collection.transact(partition, actions);
          },
        };
      },
    };
    const application = createSupportDeskApplication({
      store,
      clock: sequenceClock(
        "2026-07-27T12:00:00.000Z",
        "2026-07-27T12:05:00.000Z",
        "2026-07-27T11:00:00.000Z",
      ),
    });
    const caller = access("customer", allCustomerPermissions);
    await application.createCustomerTicket(caller, {
      commandId: "create",
      correlationId: "create-correlation",
      ticketId: "ticket",
      ticketNumber: 1,
      messageId: "message",
      subject: "Question",
      body: "Start.",
    });
    const replied = await application.replyToCustomerTicket(caller, {
      commandId: "reply",
      correlationId: "reply-correlation",
      ticketId: "ticket",
      messageId: "reply-message",
      body: "Follow up.",
    });
    expect(replyTransactions).toBe(2);
    expect(replied.ticket.customerUpdatedAt).toBe("2026-07-27T12:10:00.000Z");
    expect(replied.messages.at(-1)?.createdAt).toBe("2026-07-27T12:10:00.000Z");
    const storedReplyTicket = (
      await backing.collection(supportRecords).list("ticket")
    ).find((record) => record.kind === "ticket");
    expect(
      storedReplyTicket?.kind === "ticket" &&
        storedReplyTicket.ticket.updatedAt,
    ).toBe("2026-07-27T12:10:00.000Z");

    const invalidClockApplication = createSupportDeskApplication({
      store,
      clock: fixedClock("not-a-timestamp"),
    });
    await expect(
      invalidClockApplication.replyToCustomerTicket(caller, {
        commandId: "invalid-clock",
        correlationId: "invalid-clock",
        ticketId: "ticket",
        messageId: "invalid-clock",
        body: "Follow up.",
      }),
    ).rejects.toThrow(/clock\.now\(\) must be a canonical ISO timestamp/);
  });

  it("requires named permissions and confirms ownership after index lookup", async () => {
    const store = createMemoryStore();
    const application = createSupportDeskApplication({
      store,
      clock: fixedClock("2026-07-27T12:00:00.000Z"),
    });
    const owner = access("owner", allCustomerPermissions);
    await application.createCustomerTicket(owner, {
      commandId: "create",
      correlationId: "correlation",
      ticketId: "ticket-1",
      ticketNumber: 1,
      messageId: "message-1",
      subject: "Question",
      body: "Start.",
    });

    await expect(
      application.createCustomerTicket(access("unpaid", []), {
        commandId: "denied",
        correlationId: "denied",
        ticketId: "ticket-2",
        ticketNumber: 2,
        messageId: "message-2",
        subject: "Question",
        body: "Start.",
      }),
    ).rejects.toBeInstanceOf(SupportDeskAuthorizationError);
    await expect(
      application.readCustomerTicket(
        access("attacker", [supportPermissions.readOwn]),
        "ticket-1",
      ),
    ).rejects.toBeInstanceOf(SupportDeskNotFoundError);
    await expect(
      application.listCustomerTickets(
        access("owner", [supportPermissions.readOwn]),
      ),
    ).resolves.toHaveLength(1);
    await expect(
      application.listCustomerTickets(
        access("owner", [supportPermissions.create]),
      ),
    ).rejects.toBeInstanceOf(SupportDeskAuthorizationError);
  });

  it("enforces configurable input size limits before persistence", async () => {
    const store = createMemoryStore();
    const application = createSupportDeskApplication({
      store,
      clock: fixedClock("2026-07-27T12:00:00.000Z"),
      limits: { maxSubjectCharacters: 4, maxMessageCharacters: 5 },
    });

    await expect(
      application.createCustomerTicket(
        access("customer", allCustomerPermissions),
        {
          commandId: "create",
          correlationId: "correlation",
          ticketId: "ticket",
          ticketNumber: 1,
          messageId: "message",
          subject: "too long",
          body: "short",
        },
      ),
    ).rejects.toBeInstanceOf(SupportDeskLimitError);
    expect(await store.collection(supportRecords).list("ticket")).toEqual([]);
  });

  it("snapshots notification boundaries without executing accessors or proxy reads", async () => {
    const store = createMemoryStore();
    const application = createSupportDeskApplication({
      store,
      clock: fixedClock("2026-07-27T12:00:00.000Z"),
    });
    const caller = access("customer", allCustomerPermissions);
    const baseCommand = {
      commandId: "create",
      correlationId: "correlation",
      ticketId: "ticket",
      ticketNumber: 1,
      messageId: "message",
      subject: "Question",
      body: "Start.",
    };
    const validNotification = {
      id: "notify",
      recipientRef: "support",
      templateId: "staff.new-ticket",
      templateVersion: 1,
      variables: { ticket_number: "1" },
      subject: "[Ticket #1] Question",
      outboundMessageId: "<support.notify@example.test>",
    };

    let notificationReads = 0;
    await expect(
      application.createCustomerTicket(caller, {
        ...baseCommand,
        get notification() {
          notificationReads += 1;
          return validNotification;
        },
      }),
    ).rejects.toThrow(/command.notification must be an own data property/);
    expect(notificationReads).toBe(0);

    let variablesReads = 0;
    await expect(
      application.createCustomerTicket(caller, {
        ...baseCommand,
        notification: {
          ...validNotification,
          get variables() {
            variablesReads += 1;
            return { ticket_number: "1" };
          },
        },
      }),
    ).rejects.toThrow(/notification.variables must be an own data property/);
    expect(variablesReads).toBe(0);

    let variableValueReads = 0;
    const accessorVariables = Object.defineProperty({}, "ticket_number", {
      enumerable: true,
      get() {
        variableValueReads += 1;
        return "1";
      },
    });
    await expect(
      application.createCustomerTicket(caller, {
        ...baseCommand,
        notification: {
          ...validNotification,
          variables: accessorVariables,
        },
      }),
    ).rejects.toThrow(/enumerable own string values/);
    expect(variableValueReads).toBe(0);

    let proxyValueReads = 0;
    const proxiedVariables = new Proxy(
      { ticket_number: "1" },
      {
        ownKeys() {
          throw new TypeError("proxy variable enumeration refused");
        },
        get(target, key, receiver) {
          proxyValueReads += 1;
          return Reflect.get(target, key, receiver);
        },
      },
    );
    await expect(
      application.createCustomerTicket(caller, {
        ...baseCommand,
        notification: {
          ...validNotification,
          variables: proxiedVariables,
        },
      }),
    ).rejects.toThrow(/proxy variable enumeration refused/);
    expect(proxyValueReads).toBe(0);

    for (const outboundMessageId of [
      "<a\u0000b@example.test>",
      "<a..b@example.test>",
      "<a.@example.test>",
      "<a@example.test.>",
      "<á@example.test>",
    ]) {
      await expect(
        application.createCustomerTicket(caller, {
          ...baseCommand,
          notification: { ...validNotification, outboundMessageId },
        }),
      ).rejects.toThrow(/header-safe ASCII Message-ID/);
    }
    expect(await store.collection(supportRecords).list("ticket")).toEqual([]);

    let descriptorReads = 0;
    let changingProxyGets = 0;
    const changingProxy = new Proxy(
      {},
      {
        ownKeys: () => ["ticket_number"],
        getOwnPropertyDescriptor() {
          descriptorReads += 1;
          return {
            configurable: true,
            enumerable: true,
            writable: false,
            value: descriptorReads === 1 ? "1" : "changed",
          };
        },
        get() {
          changingProxyGets += 1;
          return "changed";
        },
      },
    );
    await application.createCustomerTicket(caller, {
      ...baseCommand,
      notification: {
        ...validNotification,
        variables: changingProxy,
      },
    });
    expect(descriptorReads).toBe(1);
    expect(changingProxyGets).toBe(0);
    const messageRecord = (
      await store.collection(supportRecords).list("ticket")
    ).find((record) => record.kind === "message");
    expect(
      messageRecord?.kind === "message" &&
        messageRecord.deliveryContent?.variables,
    ).toEqual({ ticket_number: "1" });
  });

  it("bounds notification variable shape and canonicalizes idempotency fingerprints", async () => {
    const store = createMemoryStore();
    const application = createSupportDeskApplication({
      store,
      clock: fixedClock("2026-07-27T12:00:00.000Z"),
    });
    const caller = access("customer", allCustomerPermissions);
    const baseNotification = {
      id: "notify",
      recipientRef: "support",
      templateId: "staff.new-ticket",
      templateVersion: 1,
      subject: "[Ticket #1] Question",
      outboundMessageId: "<support.notify@example.test>",
    };
    const command = {
      commandId: "create",
      correlationId: "correlation",
      ticketId: "ticket",
      ticketNumber: 1,
      messageId: "message",
      subject: "Question",
      body: "Start.",
    };
    const invalidVariables = [
      Object.fromEntries(
        Array.from({ length: 33 }, (_unused, index) => [`v${index}`, "x"]),
      ),
      { oversized: "😀".repeat(2_049) },
      {
        first: "x".repeat(3_000),
        second: "x".repeat(3_000),
        third: "x".repeat(3_000),
      },
      { "Unsafe-Key": "x" },
    ];
    for (const variables of invalidVariables) {
      await expect(
        application.createCustomerTicket(caller, {
          ...command,
          notification: { ...baseNotification, variables },
        }),
      ).rejects.toThrow(/notification.variable/);
    }
    expect(await store.collection(supportRecords).list("ticket")).toEqual([]);

    await application.createCustomerTicket(caller, {
      ...command,
      notification: {
        ...baseNotification,
        variables: { second: "2", first: "1" },
      },
    });
    const repeated = await application.createCustomerTicket(caller, {
      ...command,
      notification: {
        ...baseNotification,
        variables: { first: "1", second: "2" },
      },
    });
    expect(repeated.ticket.id).toBe("ticket");
    expect(
      (await store.collection(supportRecords).list("ticket")).filter(
        (record) => record.kind === "delivery_job",
      ),
    ).toHaveLength(1);
  });

  it("snapshots every command field once and never executes command accessors", async () => {
    const store = createMemoryStore();
    let clockGetterReads = 0;
    expect(() =>
      createSupportDeskApplication({
        store,
        get clock() {
          clockGetterReads += 1;
          return fixedClock("2026-07-27T12:00:00.000Z");
        },
      }),
    ).toThrow(/application options.clock must be an own data property/);
    expect(clockGetterReads).toBe(0);
    const application = createSupportDeskApplication({
      store,
      clock: fixedClock("2026-07-27T12:00:00.000Z"),
    });
    const caller = access("customer", allCustomerPermissions);
    const base = {
      commandId: "create",
      correlationId: "correlation",
      ticketId: "ticket",
      ticketNumber: 1,
      messageId: "message",
      subject: "Question",
      body: "Start.",
    };

    let bodyGetterReads = 0;
    await expect(
      application.createCustomerTicket(caller, {
        ...base,
        get body() {
          bodyGetterReads += 1;
          return "changed";
        },
      }),
    ).rejects.toThrow(/create command.body must be an own data property/);
    expect(bodyGetterReads).toBe(0);

    let emailGetterReads = 0;
    await expect(
      application.createCustomerTicket(caller, {
        ...base,
        get requesterEmail() {
          emailGetterReads += 1;
          return "customer@example.com";
        },
      }),
    ).rejects.toThrow(
      /create command.requesterEmail must be an own data property/,
    );
    expect(emailGetterReads).toBe(0);

    let replyBodyGetterReads = 0;
    await expect(
      application.replyToCustomerTicket(caller, {
        commandId: "reply",
        correlationId: "reply-correlation",
        ticketId: "ticket",
        messageId: "reply-message",
        get body() {
          replyBodyGetterReads += 1;
          return "changed";
        },
      }),
    ).rejects.toThrow(/reply command.body must be an own data property/);
    expect(replyBodyGetterReads).toBe(0);
    expect(await store.collection(supportRecords).list("ticket")).toEqual([]);

    const descriptorReads = new Map<PropertyKey, number>();
    let proxyGets = 0;
    const changingCommand = new Proxy(
      {},
      {
        getOwnPropertyDescriptor(_target, key) {
          descriptorReads.set(key, (descriptorReads.get(key) ?? 0) + 1);
          const values: Readonly<Record<string, unknown>> = {
            commandId: "create",
            correlationId: "correlation",
            ticketId: "ticket",
            ticketNumber: 1,
            messageId: "message",
            subject: "Question",
            body:
              descriptorReads.get("body") === 1
                ? "Original body."
                : "Changed body.",
          };
          if (!Object.hasOwn(values, key)) {
            return undefined;
          }
          return {
            configurable: true,
            enumerable: true,
            writable: false,
            value: values[key as string],
          };
        },
        get() {
          proxyGets += 1;
          return "changed";
        },
      },
    ) as typeof base;
    const created = await application.createCustomerTicket(
      caller,
      changingCommand,
    );
    expect(proxyGets).toBe(0);
    expect(
      [
        "commandId",
        "correlationId",
        "ticketId",
        "ticketNumber",
        "messageId",
        "subject",
        "body",
        "requesterEmail",
        "notification",
      ].map((key) => descriptorReads.get(key)),
    ).toEqual(Array.from({ length: 9 }, () => 1));
    expect(created.messages[0]?.body).toBe("Original body.");
  });

  it("normalizes and bounds requester email without using it as identity", async () => {
    const store = createMemoryStore();
    const application = createSupportDeskApplication({
      store,
      clock: fixedClock("2026-07-27T12:00:00.000Z"),
    });
    const caller = access("customer", allCustomerPermissions);
    const command = {
      commandId: "create",
      correlationId: "correlation",
      ticketId: "ticket",
      ticketNumber: 1,
      messageId: "message",
      subject: "Question",
      body: "Start.",
    };
    const invalidEmails = [
      "<script>@example.com",
      "customer\u0000@example.com",
      "customer @example.com",
      `${"a".repeat(245)}@example.com`,
    ];
    for (const requesterEmail of invalidEmails) {
      await expect(
        application.createCustomerTicket(caller, {
          ...command,
          requesterEmail,
        }),
      ).rejects.toThrow(/requesterEmail must be a plain email address/);
    }
    expect(await store.collection(supportRecords).list("ticket")).toEqual([]);

    const created = await application.createCustomerTicket(caller, {
      ...command,
      requesterEmail: "  Customer@Example.COM  ",
    });
    expect(created.ticket.id).toBe("ticket");
    const storedCreated = (
      await store.collection(supportRecords).list("ticket")
    ).find((record) => record.kind === "ticket");
    expect(
      storedCreated?.kind === "ticket" && storedCreated.ticket.requester,
    ).toMatchObject({
      association: "authenticated",
      principalId: "customer",
      email: "Customer@example.com",
    });
    const repeated = await application.createCustomerTicket(caller, {
      ...command,
      requesterEmail: "Customer@example.com",
    });
    expect(repeated.ticket.id).toBe("ticket");
  });

  it("never returns internal messages in a customer view", async () => {
    const store = createMemoryStore();
    const application = createSupportDeskApplication({
      store,
      clock: fixedClock("2026-07-27T12:00:00.000Z"),
    });
    const caller = access("customer", allCustomerPermissions);
    await application.createCustomerTicket(caller, {
      commandId: "create",
      correlationId: "correlation",
      ticketId: "ticket",
      ticketNumber: 1,
      messageId: "public",
      subject: "Question",
      body: "Start.",
    });
    await store.collection(supportRecords).insertIfAbsent({
      kind: "message",
      partition: "ticket",
      id: "message:internal",
      ordinal: 2,
      message: {
        id: "internal",
        ticketId: "ticket",
        authorKind: "staff",
        authorPrincipalId: "staff",
        channel: "web",
        visibility: "internal",
        format: "plain_text",
        body: "Never show this.",
        createdAt: "2026-07-27T12:00:00.000Z",
      },
    });
    await store.collection(supportRecords).insertIfAbsent({
      kind: "message",
      partition: "ticket",
      id: "message:staff-public",
      ordinal: 3,
      message: {
        id: "staff-public",
        ticketId: "ticket",
        authorKind: "staff",
        authorPrincipalId: "staff-1",
        channel: "web",
        visibility: "customer",
        format: "plain_text",
        body: "Public staff reply.",
        createdAt: "2026-07-27T12:01:00.000Z",
        externalMessageId: "<staff@example.test>",
        inReplyToExternalMessageId: "<prior@example.test>",
      },
    });

    const view = await application.readCustomerTicket(caller, "ticket");
    expect(view.messages.map((message) => message.id)).toEqual([
      "public",
      "staff-public",
    ]);
    expect(JSON.stringify(view.messages)).not.toContain("staff-1");
    expect(JSON.stringify(view.messages)).not.toContain("authorPrincipalId");
    expect(JSON.stringify(view.messages)).not.toContain("externalMessageId");
    expect(view.messages[1]).toMatchObject({
      id: "staff-public",
      authorKind: "staff",
      body: "Public staff reply.",
    });
  });

  it("rejects unmigrated or duplicate stored message ordinals", async () => {
    const store = createMemoryStore();
    const application = createSupportDeskApplication({
      store,
      clock: fixedClock("2026-07-27T12:00:00.000Z"),
    });
    const caller = access("customer", allCustomerPermissions);
    await application.createCustomerTicket(caller, {
      commandId: "create",
      correlationId: "correlation",
      ticketId: "ticket",
      ticketNumber: 1,
      messageId: "initial",
      subject: "Question",
      body: "Start.",
    });
    const records = store.collection(supportRecords);
    await records.update(
      { partition: "ticket", id: "message:initial" },
      (current) => {
        if (current?.kind !== "message") {
          return { action: "keep" };
        }
        const { ordinal: _ordinal, ...legacy } = current;
        return { action: "write", value: legacy as SupportRecord };
      },
    );
    await expect(
      application.readCustomerTicket(caller, "ticket"),
    ).rejects.toThrow(/migrate the record/);

    await records.update(
      { partition: "ticket", id: "message:initial" },
      (current) =>
        current?.kind === "message"
          ? { action: "write", value: { ...current, ordinal: 1 } }
          : { action: "keep" },
    );
    await application.replyToCustomerTicket(caller, {
      commandId: "reply",
      correlationId: "reply-correlation",
      ticketId: "ticket",
      messageId: "reply",
      body: "More.",
    });
    await records.update(
      { partition: "ticket", id: "message:reply" },
      (current) =>
        current?.kind === "message"
          ? { action: "write", value: { ...current, ordinal: 1 } }
          : { action: "keep" },
    );
    await expect(
      application.readCustomerTicket(caller, "ticket"),
    ).rejects.toThrow(/duplicate explicit ordinal/);
  });

  it("records provider callbacks idempotently and updates the delivery job", async () => {
    const store = createMemoryStore();
    const application = createSupportDeskApplication({
      store,
      clock: fixedClock("2026-07-27T12:00:00.000Z"),
    });
    await application.createCustomerTicket(
      access("customer", allCustomerPermissions),
      {
        commandId: "create",
        correlationId: "correlation",
        ticketId: "ticket",
        ticketNumber: 1,
        messageId: "message",
        subject: "Question",
        body: "Start.",
        notification: {
          id: "notify",
          recipientRef: "support",
          templateId: "staff.new-ticket",
          templateVersion: 1,
          variables: {},
          subject: "[Ticket #1] Question",
          outboundMessageId: "<support.notify@example.test>",
        },
      },
    );
    const callback = {
      provider: "test-provider",
      providerEventId: "event-1",
      ticketId: "ticket",
      deliveryJobId: "notify",
      submissionGeneration: 1,
      status: "delivered" as const,
      occurredAt: "2026-07-27T12:01:00.000Z",
    };

    await supportMail
      .worker({
        records: store.collection(supportRecords),
        clock: fixedClock("2026-07-27T12:00:30.000Z"),
        workerId: "worker",
        provider: {
          send: async () => ({ providerMessageRef: "provider-ref" }),
        },
        reconciliation: {
          reconcile: async () => ({ status: "unknown" }),
        },
        preparation: {
          prepare: async () => ({
            recipient: "support@example.test",
            subject: "Question",
            text: "New ticket",
          }),
        },
      })
      .send({ partition: "ticket", jobId: "notify" });

    const fenced = await recordDeliveryCallback(
      store,
      {
        ...callback,
        providerEventId: "event-stale-generation",
        submissionGeneration: 2,
      },
      callbackClock,
    );
    const first = await recordDeliveryCallback(store, callback, callbackClock);
    const repeated = await recordDeliveryCallback(
      store,
      {
        ...callback,
        providerMessageRef: undefined,
        failureCategory: undefined,
      },
      callbackClock,
    );

    expect(fenced).toEqual({ duplicate: false, job: null });
    expect(first.duplicate).toBe(false);
    expect(first.job?.job.status).toBe("delivered");
    expect(repeated).toEqual({ duplicate: true, job: null });

    const normalizedFailure = {
      ...callback,
      providerEventId: "event-normalized-failure",
      providerMessageRef: undefined,
      status: "failed" as const,
      failureCategory: undefined,
    };
    const normalizedFirst = await recordDeliveryCallback(
      store,
      normalizedFailure,
      callbackClock,
    );
    const normalizedRepeated = await recordDeliveryCallback(
      store,
      {
        ...normalizedFailure,
        failureCategory: "provider_callback_failure",
      },
      callbackClock,
    );
    expect(normalizedFirst).toEqual({ duplicate: false, job: null });
    expect(normalizedRepeated).toEqual({ duplicate: true, job: null });
    const normalizedBucket = await deliveryCallbackBucket(
      normalizedFailure.provider,
      normalizedFailure.providerEventId,
    );
    const [normalizedReceipt] = await store
      .collection(deliveryCallbackReceipts)
      .list(normalizedBucket);
    expect(normalizedReceipt?.failureCategory).toBe(
      "provider_callback_failure",
    );
    expect(
      normalizedReceipt === undefined
        ? true
        : Object.hasOwn(normalizedReceipt, "providerMessageRef"),
    ).toBe(false);

    const expectRejectedWithoutReceipt = async (
      invalid: Parameters<typeof recordDeliveryCallback>[1],
      expected: RegExp,
    ): Promise<void> => {
      await expect(
        recordDeliveryCallback(store, invalid, callbackClock),
      ).rejects.toThrow(expected);
      const bucket = await deliveryCallbackBucket(
        invalid.provider,
        invalid.providerEventId,
      );
      expect(
        await store.collection(deliveryCallbackReceipts).list(bucket),
      ).toEqual([]);
    };
    await expectRejectedWithoutReceipt(
      {
        ...callback,
        providerEventId: "event-generation-too-large",
        submissionGeneration: maxMailAttempts + 1,
      },
      /submissionGeneration must be between 1 and 20/,
    );
    await expectRejectedWithoutReceipt(
      {
        ...callback,
        providerEventId: "event-reference-too-large",
        providerMessageRef: "x".repeat(513),
      },
      /providerMessageRef must be non-empty, at most 512 characters/,
    );
    await expectRejectedWithoutReceipt(
      {
        ...callback,
        providerEventId: "event-category-too-large",
        status: "failed",
        failureCategory: "x".repeat(100_000),
      },
      /failureCategory must be a coarse safe token/,
    );
    await expectRejectedWithoutReceipt(
      {
        ...callback,
        providerEventId: "event-delivered-category",
        failureCategory: "provider_failure",
      },
      /delivered callback cannot include a failureCategory/,
    );

    await expect(
      recordDeliveryCallback(
        store,
        {
          ...callback,
          occurredAt: "2026-07-27T13:01:00.000Z",
        },
        callbackClock,
      ),
    ).rejects.toBeInstanceOf(SupportDeskConflictError);
    await expect(
      recordDeliveryCallback(
        store,
        {
          ...callback,
          status: "failed",
        },
        callbackClock,
      ),
    ).rejects.toThrow(/reused for different input/);
    let statusReads = 0;
    await expect(
      recordDeliveryCallback(
        store,
        {
          ...callback,
          providerEventId: "event-changing-status",
          get status() {
            statusReads += 1;
            return statusReads === 1 ? "delivered" : "failed";
          },
        } as never,
        callbackClock,
      ),
    ).rejects.toThrow(/status must be an own data property/);
    expect(statusReads).toBe(0);
  });

  it("replays a callback safely after crashing before receipt finalization", async () => {
    const backing = createMemoryStore();
    await createSupportDeskApplication({
      store: backing,
      clock: fixedClock("2026-07-27T12:00:00.000Z"),
    }).createCustomerTicket(access("customer", allCustomerPermissions), {
      commandId: "create",
      correlationId: "correlation",
      ticketId: "ticket",
      ticketNumber: 1,
      messageId: "message",
      subject: "Question",
      body: "Start.",
      notification: {
        id: "notify",
        recipientRef: "support",
        templateId: "staff.new-ticket",
        templateVersion: 1,
        variables: {},
        subject: "[Ticket #1] Question",
        outboundMessageId: "<support.notify@example.test>",
      },
    });
    const records = backing.collection(supportRecords);
    await supportMail
      .worker({
        records,
        clock: fixedClock("2026-07-27T12:00:30.000Z"),
        workerId: "worker",
        provider: {
          send: async () => ({ providerMessageRef: "provider-ref" }),
        },
        reconciliation: {
          reconcile: async () => ({ status: "unknown" }),
        },
        preparation: {
          prepare: async () => ({
            recipient: "support@example.test",
            subject: "Question",
            text: "New ticket",
          }),
        },
      })
      .send({ partition: "ticket", jobId: "notify" });

    let failReceiptFinalization = true;
    const crashingStore: Store = {
      collection<T>(definition: { readonly name: string }): CollectionStore<T> {
        const collection = backing.collection(
          definition as Parameters<Store["collection"]>[0],
        ) as CollectionStore<T>;
        if (definition.name !== deliveryCallbackReceipts.name) {
          return collection;
        }
        return {
          ...collection,
          async update(key, decide, options) {
            if (failReceiptFinalization) {
              failReceiptFinalization = false;
              throw new Error("injected receipt finalization crash");
            }
            return collection.update(key, decide, options);
          },
        };
      },
    };
    const callback = {
      provider: "test-provider",
      providerEventId: "event-crash-replay",
      ticketId: "ticket",
      deliveryJobId: "notify",
      submissionGeneration: 1,
      providerMessageRef: "provider-ref",
      status: "delivered" as const,
      occurredAt: "2026-07-27T12:01:00.000Z",
    };

    await expect(
      recordDeliveryCallback(crashingStore, callback, callbackClock),
    ).rejects.toThrow(/injected receipt finalization crash/);
    const location = await deliveryCallbackBucket(
      callback.provider,
      callback.providerEventId,
    );
    const [unfinishedReceipt] = await backing
      .collection(deliveryCallbackReceipts)
      .list(location);
    expect(unfinishedReceipt?.processedAt).toBeUndefined();
    const afterCrash = await records.getVersioned({
      partition: "ticket",
      id: "delivery:notify",
    });
    expect(afterCrash?.value).toMatchObject({
      kind: "delivery_job",
      job: {
        status: "delivered",
        submissionGeneration: 1,
        attemptCount: 1,
      },
    });

    expect(
      await recordDeliveryCallback(backing, callback, callbackClock),
    ).toEqual({ duplicate: true, job: null });
    const afterReplay = await records.getVersioned({
      partition: "ticket",
      id: "delivery:notify",
    });
    expect(afterReplay?.version).toBe(afterCrash?.version);
    expect(afterReplay?.value).toEqual(afterCrash?.value);
    const [finalizedReceipt] = await backing
      .collection(deliveryCallbackReceipts)
      .list(location);
    expect(finalizedReceipt?.processedAt).toBe(callbackClock.now());
  });

  it("enforces bounded principal and ticket records and supports safe retention", async () => {
    const store = createMemoryStore();
    const application = createSupportDeskApplication({
      store,
      clock: fixedClock("2026-07-27T12:00:00.000Z"),
      limits: {
        maxTicketsPerPrincipal: 1,
        maxMessagesPerTicket: 2,
      },
    });
    const caller = access("customer", allCustomerPermissions);
    await application.createCustomerTicket(caller, {
      commandId: "create-1",
      correlationId: "correlation-1",
      ticketId: "ticket-1",
      ticketNumber: 1,
      messageId: "message-1",
      subject: "Question",
      body: "Start.",
      notification: {
        id: "notify",
        recipientRef: "support",
        templateId: "staff.new-ticket",
        templateVersion: 1,
        variables: {},
        subject: "[Ticket #1] Question",
        outboundMessageId: "<support.notify@example.test>",
      },
    });
    await expect(
      application.createCustomerTicket(caller, {
        commandId: "create-2",
        correlationId: "correlation-2",
        ticketId: "ticket-2",
        ticketNumber: 2,
        messageId: "message-2",
        subject: "Question",
        body: "Start.",
      }),
    ).rejects.toMatchObject({ field: "customer_tickets" });
    await application.replyToCustomerTicket(caller, {
      commandId: "reply-1",
      correlationId: "reply-correlation-1",
      ticketId: "ticket-1",
      messageId: "reply-message-1",
      body: "One reply.",
    });
    await expect(
      application.replyToCustomerTicket(caller, {
        commandId: "reply-2",
        correlationId: "reply-correlation-2",
        ticketId: "ticket-1",
        messageId: "reply-message-2",
        body: "Too many.",
      }),
    ).rejects.toMatchObject({ field: "ticket_messages" });

    await store.collection(customerTicketIndex).put({
      principalId: "customer",
      entries: [
        {
          ticketId: "ticket-1",
          reservationToken: "confirmed",
          reservationGeneration: 1,
          reservedAt: "2026-07-27T12:00:00.000Z",
          state: "confirmed",
        },
        {
          ticketId: "missing-ticket",
          reservationToken: "stale",
          reservationGeneration: 1,
          reservedAt: "2026-07-26T12:00:00.000Z",
          state: "reserved",
        },
      ],
    });
    expect(
      await pruneCustomerTicketIndex(store, "customer", {
        reservedBefore: "2026-07-27T00:00:00.000Z",
      }),
    ).toEqual(["ticket-1"]);
  });

  it("fences an expired create reservation before prune frees capacity", async () => {
    const backing = createMemoryStore();
    let releaseTransaction = (): void => {};
    let reportWaiting = (): void => {};
    let releasePruneRemoval = (): void => {};
    let reportPruneWaiting = (): void => {};
    const transactionReleased = new Promise<void>((resolve) => {
      releaseTransaction = resolve;
    });
    const transactionWaiting = new Promise<void>((resolve) => {
      reportWaiting = resolve;
    });
    const pruneRemovalReleased = new Promise<void>((resolve) => {
      releasePruneRemoval = resolve;
    });
    const pruneRemovalWaiting = new Promise<void>((resolve) => {
      reportPruneWaiting = resolve;
    });
    let interceptTransaction = true;
    let interceptPruneRemoval = true;
    const store: Store = {
      collection(definition) {
        const collection = backing.collection(definition);
        if (definition.name === customerTicketIndex.name) {
          return {
            ...collection,
            async update(key, decide, options) {
              return collection.update(
                key,
                async (current) => {
                  const decision = await decide(current);
                  const currentIndex =
                    current as CustomerTicketIndexRecord | null;
                  const nextIndex =
                    decision.action === "write"
                      ? (decision.value as CustomerTicketIndexRecord)
                      : null;
                  if (
                    interceptPruneRemoval &&
                    currentIndex !== null &&
                    nextIndex !== null &&
                    nextIndex.entries.length < currentIndex.entries.length
                  ) {
                    interceptPruneRemoval = false;
                    reportPruneWaiting();
                    await pruneRemovalReleased;
                  }
                  return decision;
                },
                options,
              );
            },
          };
        }
        if (definition.name !== supportRecords.name) {
          return collection;
        }
        return {
          ...collection,
          async transact(partition, actions) {
            if (interceptTransaction) {
              interceptTransaction = false;
              reportWaiting();
              await transactionReleased;
            }
            return collection.transact(partition, actions);
          },
        };
      },
    };
    const application = createSupportDeskApplication({
      store,
      clock: fixedClock("2026-07-27T12:00:00.000Z"),
      limits: { maxTicketsPerPrincipal: 1 },
    });
    const caller = access("customer", allCustomerPermissions);
    const command = {
      commandId: "create",
      correlationId: "correlation",
      ticketId: "ticket",
      ticketNumber: 1,
      messageId: "message",
      subject: "Question",
      body: "Start.",
    };

    const inFlight = application.createCustomerTicket(caller, command);
    await transactionWaiting;
    const pruning = pruneCustomerTicketIndex(store, "customer", {
      reservedBefore: "2026-07-27T12:01:00.000Z",
    });
    await pruneRemovalWaiting;
    await expect(
      application.createCustomerTicket(caller, command),
    ).rejects.toThrow(/cancellation is still being finalized/);
    releasePruneRemoval();
    expect(await pruning).toEqual([]);
    releaseTransaction();
    await expect(inFlight).rejects.toBeInstanceOf(SupportDeskConflictError);
    expect(
      await store.collection(supportRecords).get({
        partition: "ticket",
        id: "ticket",
      }),
    ).toBeNull();

    const retried = await application.createCustomerTicket(caller, command);
    expect(retried.ticket.id).toBe("ticket");
    expect(await application.listCustomerTickets(caller)).toHaveLength(1);
  });

  it("prevents a stale create from overtaking two pruned reservation generations", async () => {
    const backing = createMemoryStore();
    let reportStaleFenceRead = (): void => {};
    let releaseStaleFenceRead = (): void => {};
    let reportSecondTransaction = (): void => {};
    let releaseSecondTransaction = (): void => {};
    const staleFenceReadWaiting = new Promise<void>((resolve) => {
      reportStaleFenceRead = resolve;
    });
    const staleFenceReadReleased = new Promise<void>((resolve) => {
      releaseStaleFenceRead = resolve;
    });
    const secondTransactionWaiting = new Promise<void>((resolve) => {
      reportSecondTransaction = resolve;
    });
    const secondTransactionReleased = new Promise<void>((resolve) => {
      releaseSecondTransaction = resolve;
    });
    let pauseFirstFenceRead = true;
    let pauseFirstTransaction = true;
    const store: Store = {
      collection(definition) {
        const collection = backing.collection(definition);
        if (definition.name !== supportRecords.name) {
          return collection;
        }
        return {
          ...collection,
          async getVersioned(key) {
            if (
              pauseFirstFenceRead &&
              key.partition === "ticket" &&
              key.id === "reservation"
            ) {
              pauseFirstFenceRead = false;
              reportStaleFenceRead();
              await staleFenceReadReleased;
            }
            return collection.getVersioned(key);
          },
          async transact(partition, actions) {
            if (pauseFirstTransaction) {
              pauseFirstTransaction = false;
              reportSecondTransaction();
              await secondTransactionReleased;
            }
            return collection.transact(partition, actions);
          },
        };
      },
    };
    const application = createSupportDeskApplication({
      store,
      clock: fixedClock("2026-07-27T12:00:00.000Z"),
      limits: { maxTicketsPerPrincipal: 1 },
    });
    const caller = access("customer", allCustomerPermissions);
    const command = (suffix: string) => ({
      commandId: `create-${suffix}`,
      correlationId: `correlation-${suffix}`,
      ticketId: "ticket",
      ticketNumber: 1,
      messageId: `message-${suffix}`,
      subject: "Question",
      body: "Start.",
    });

    const staleCreate = application.createCustomerTicket(
      caller,
      command("stale"),
    );
    await staleFenceReadWaiting;
    expect(
      await pruneCustomerTicketIndex(store, "customer", {
        reservedBefore: "2026-07-27T12:01:00.000Z",
      }),
    ).toEqual([]);

    const secondCreate = application.createCustomerTicket(
      caller,
      command("second"),
    );
    await secondTransactionWaiting;
    expect(
      await pruneCustomerTicketIndex(store, "customer", {
        reservedBefore: "2026-07-27T12:01:00.000Z",
      }),
    ).toEqual([]);

    releaseStaleFenceRead();
    await expect(staleCreate).rejects.toThrow(/cancelled before commit/);
    releaseSecondTransaction();
    await expect(secondCreate).rejects.toBeInstanceOf(SupportDeskConflictError);
    expect(
      await store.collection(supportRecords).get({
        partition: "ticket",
        id: "ticket",
      }),
    ).toBeNull();
    expect(await application.listCustomerTickets(caller)).toEqual([]);

    const fresh = await application.createCustomerTicket(
      caller,
      command("fresh"),
    );
    expect(fresh.ticket.id).toBe("ticket");
    expect(await application.listCustomerTickets(caller)).toHaveLength(1);
  });

  it("bounds inbound receipt shards and conditionally sweeps terminal receipts", async () => {
    const store = createMemoryStore();
    const location = await inboundReceiptLocation("mailbox", "event-a");
    const bucket = location.bucket;
    expect(location.slot).toMatch(/^[0-9a-f]{2}$/);
    expect(bucket).not.toBe(await inboundReceiptBucket("mailbox", "event-b"));
    expect(maxInboundReceiptsPerBucket).toBe(256);
    expect(inboundReceiptDedupeDays).toBe(30);
    const receipts = store.collection(inboundReceipts);
    await expect(
      receipts.put({
        bucket,
        slot: "not-a-slot",
        channelId: "mailbox",
        providerEventId: "invalid",
        payloadFingerprint: "fingerprint",
        status: "processed",
        receivedAt: "2026-07-01T00:00:00.000Z",
        processedAt: "2026-07-01T00:01:00.000Z",
      }),
    ).rejects.toThrow(/exactly two lowercase hex digits/);
    await receipts.put({
      bucket,
      slot: "00",
      channelId: "mailbox",
      providerEventId: "old-terminal",
      payloadFingerprint: "fingerprint-a",
      status: "processed",
      receivedAt: "2026-07-01T00:00:00.000Z",
      processedAt: "2026-07-01T00:01:00.000Z",
    });
    await receipts.put({
      bucket,
      slot: "01",
      channelId: "mailbox",
      providerEventId: "in-flight",
      payloadFingerprint: "fingerprint-b",
      status: "processing",
      receivedAt: "2026-07-01T00:00:00.000Z",
    });
    await receipts.put({
      bucket,
      slot: "02",
      channelId: "mailbox",
      providerEventId: "recent-terminal",
      payloadFingerprint: "fingerprint-c",
      status: "rejected",
      receivedAt: "2026-08-20T00:00:00.000Z",
      processedAt: "2026-08-20T00:01:00.000Z",
    });
    expect(
      await sweepInboundReceipts(
        store,
        fixedClock("2026-08-28T00:00:00.000Z"),
        {
          bucket,
          processedBefore: "2026-08-27T00:00:00.000Z",
        },
      ),
    ).toBe(1);
    expect(
      (await receipts.list(bucket)).map((receipt) => receipt.slot),
    ).toEqual(["01", "02"]);

    await receipts.put({
      bucket,
      slot: "03",
      channelId: "mailbox",
      providerEventId: "racing-terminal",
      payloadFingerprint: "fingerprint-d",
      status: "processed",
      receivedAt: "2026-07-01T00:00:00.000Z",
      processedAt: "2026-07-01T00:01:00.000Z",
    });
    let raced = false;
    const racingStore: Store = {
      collection(definition) {
        const collection = store.collection(definition);
        if (definition.name !== inboundReceipts.name) {
          return collection;
        }
        return {
          ...collection,
          async deleteIfUnchanged(key, version) {
            if (!raced) {
              raced = true;
              await receipts.update(key, (current) =>
                current === null
                  ? { action: "keep" }
                  : {
                      action: "write",
                      value: { ...current, diagnostic: "updated concurrently" },
                    },
              );
            }
            return collection.deleteIfUnchanged(key, version);
          },
        };
      },
    };
    expect(
      await sweepInboundReceipts(
        racingStore,
        fixedClock("2026-08-28T00:00:00.000Z"),
        {
          bucket,
          processedBefore: "2026-08-27T00:00:00.000Z",
        },
      ),
    ).toBe(0);
    expect(
      (await receipts.list(bucket)).some((receipt) => receipt.slot === "03"),
    ).toBe(true);

    let bucketGetterReads = 0;
    await expect(
      sweepInboundReceipts(store, fixedClock("2026-08-28T00:00:00.000Z"), {
        get bucket() {
          bucketGetterReads += 1;
          return bucket;
        },
        processedBefore: "2026-08-27T00:00:00.000Z",
      }),
    ).rejects.toThrow(
      /inbound receipt sweep.bucket must be an own data property/,
    );
    expect(bucketGetterReads).toBe(0);

    const firstBucket = await inboundReceiptBucket("cross", "first");
    const secondBucket = await inboundReceiptBucket("cross", "second");
    await receipts.put({
      bucket: firstBucket,
      slot: "aa",
      channelId: "cross",
      providerEventId: "first",
      payloadFingerprint: "first",
      status: "processed",
      receivedAt: "2026-07-01T00:00:00.000Z",
      processedAt: "2026-07-01T00:01:00.000Z",
    });
    await receipts.put({
      bucket: secondBucket,
      slot: "aa",
      channelId: "cross",
      providerEventId: "second",
      payloadFingerprint: "second",
      status: "processing",
      receivedAt: "2026-07-01T00:00:00.000Z",
    });
    let bucketDescriptorReads = 0;
    let sweepPropertyReads = 0;
    const changingSweep = new Proxy(
      {},
      {
        getOwnPropertyDescriptor(_target, key) {
          if (key === "bucket") {
            bucketDescriptorReads += 1;
            return {
              configurable: true,
              enumerable: true,
              value: bucketDescriptorReads === 1 ? firstBucket : secondBucket,
            };
          }
          if (key === "processedBefore") {
            return {
              configurable: true,
              enumerable: true,
              value: "2026-08-27T00:00:00.000Z",
            };
          }
          return undefined;
        },
        get() {
          sweepPropertyReads += 1;
          return secondBucket;
        },
      },
    ) as {
      readonly bucket: string;
      readonly processedBefore: string;
    };
    expect(
      await sweepInboundReceipts(
        store,
        fixedClock("2026-08-28T00:00:00.000Z"),
        changingSweep,
      ),
    ).toBe(1);
    expect(bucketDescriptorReads).toBe(1);
    expect(sweepPropertyReads).toBe(0);
    expect(await receipts.list(firstBucket)).toEqual([]);
    expect(await receipts.list(secondBucket)).toHaveLength(1);
    expect((await receipts.list(secondBucket))[0]?.status).toBe("processing");
  });

  it("bounds callback shards and retains delayed events from trusted processing time", async () => {
    const store = createMemoryStore();
    const application = createSupportDeskApplication({
      store,
      clock: fixedClock("2026-07-27T12:00:00.000Z"),
    });
    await application.createCustomerTicket(
      access("customer", allCustomerPermissions),
      {
        commandId: "create",
        correlationId: "correlation",
        ticketId: "ticket",
        ticketNumber: 1,
        messageId: "message",
        subject: "Question",
        body: "Start.",
        notification: {
          id: "notify",
          recipientRef: "support",
          templateId: "staff.new-ticket",
          templateVersion: 1,
          variables: {},
          subject: "[Ticket #1] Question",
          outboundMessageId: "<support.notify@example.test>",
        },
      },
    );
    const occurredAt = "2026-05-01T12:01:00.000Z";
    const processedAt = "2026-07-27T14:00:00.000Z";
    await recordDeliveryCallback(
      store,
      {
        provider: "provider",
        providerEventId: "event-a",
        ticketId: "ticket",
        deliveryJobId: "notify",
        submissionGeneration: 1,
        status: "delivered",
        occurredAt,
      },
      fixedClock(processedAt),
    );
    const bucket = await deliveryCallbackBucket("provider", "event-a");
    expect(bucket).not.toBe(
      await deliveryCallbackBucket("provider", "event-b"),
    );
    const stored = await store
      .collection(deliveryCallbackReceipts)
      .list(bucket);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.occurredAt).toBe(occurredAt);
    expect(stored[0]?.processedAt).toBe(processedAt);
    expect(stored[0]?.slot).toMatch(/^[0-9a-f]{2}$/);
    expect(maxDeliveryCallbacksPerBucket).toBe(256);
    expect(
      await sweepDeliveryCallbackReceipts(
        store,
        fixedClock("2026-07-28T14:00:00.000Z"),
        {
          bucket,
          processedBefore: "2026-07-28T15:00:00.000Z",
          maxDeletes: 1,
        },
      ),
    ).toBe(0);
    expect(
      await sweepDeliveryCallbackReceipts(
        store,
        fixedClock("2026-08-28T14:00:00.000Z"),
        {
          bucket,
          processedBefore: "2026-07-01T00:00:00.000Z",
          maxDeletes: 1,
        },
      ),
    ).toBe(0);
    expect(
      await sweepDeliveryCallbackReceipts(
        store,
        fixedClock("2026-08-28T14:00:00.000Z"),
        {
          bucket,
          processedBefore: "2026-07-28T00:00:00.000Z",
          maxDeletes: 1,
        },
      ),
    ).toBe(1);
    await expect(
      sweepDeliveryCallbackReceipts(
        store,
        fixedClock("2026-08-28T14:00:00.000Z"),
        {
          bucket,
          processedBefore: "2026-07-28T00:00:00.000Z",
          maxDeletes: 1_001,
        },
      ),
    ).rejects.toThrow(/between 1 and 1000/);

    const firstBucket = await deliveryCallbackBucket("cross", "first");
    const secondBucket = await deliveryCallbackBucket("cross", "second");
    const callbackReceipts = store.collection(deliveryCallbackReceipts);
    await callbackReceipts.put({
      bucket: firstBucket,
      slot: "bb",
      provider: "cross",
      providerEventId: "first",
      ticketId: "ticket",
      deliveryJobId: "notify",
      submissionGeneration: 1,
      status: "delivered",
      occurredAt: "2026-07-01T00:00:00.000Z",
      processedAt: "2026-07-01T00:01:00.000Z",
    });
    await callbackReceipts.put({
      bucket: secondBucket,
      slot: "bb",
      provider: "cross",
      providerEventId: "second",
      ticketId: "ticket",
      deliveryJobId: "notify",
      submissionGeneration: 1,
      status: "delivered",
      occurredAt: "2026-07-01T00:00:00.000Z",
    });
    let bucketDescriptorReads = 0;
    const changingSweep = new Proxy(
      {},
      {
        getOwnPropertyDescriptor(_target, key) {
          if (key === "bucket") {
            bucketDescriptorReads += 1;
            return {
              configurable: true,
              value: bucketDescriptorReads === 1 ? firstBucket : secondBucket,
            };
          }
          if (key === "processedBefore") {
            return {
              configurable: true,
              value: "2026-08-27T00:00:00.000Z",
            };
          }
          return undefined;
        },
      },
    ) as {
      readonly bucket: string;
      readonly processedBefore: string;
    };
    expect(
      await sweepDeliveryCallbackReceipts(
        store,
        fixedClock("2026-08-28T00:00:00.000Z"),
        changingSweep,
      ),
    ).toBe(1);
    expect(bucketDescriptorReads).toBe(1);
    expect(await callbackReceipts.list(firstBucket)).toEqual([]);
    expect(await callbackReceipts.list(secondBucket)).toHaveLength(1);
    expect(
      (await callbackReceipts.list(secondBucket))[0]?.processedAt,
    ).toBeUndefined();
  });

  it("keeps a maximum-size conversation within the documented read envelope", async () => {
    const store = createMemoryStore();
    const application = createSupportDeskApplication({
      store,
      clock: fixedClock("2026-07-27T12:00:00.000Z"),
    });
    const caller = access("customer", allCustomerPermissions);
    const body = "x".repeat(20_000);
    await application.createCustomerTicket(caller, {
      commandId: "create",
      correlationId: "correlation",
      ticketId: "ticket",
      ticketNumber: 1,
      messageId: "message-0",
      subject: "Question",
      body,
      notification: {
        id: "notify",
        recipientRef: "support",
        templateId: "staff.new-ticket",
        templateVersion: 1,
        variables: { body: "y".repeat(8_192) },
        subject: "[Ticket #1] Question",
        outboundMessageId: "<support.notify@example.test>",
      },
    });
    for (let index = 1; index < 100; index += 1) {
      await application.replyToCustomerTicket(caller, {
        commandId: `reply-${index}`,
        correlationId: `correlation-${index}`,
        ticketId: "ticket",
        messageId: `message-${index}`,
        body,
      });
    }
    const view = await application.readCustomerTicket(caller, "ticket");
    expect(view.messages).toHaveLength(100);
    expect(JSON.stringify(view).length).toBeLessThan(2_100_000);
    await expect(
      application.replyToCustomerTicket(caller, {
        commandId: "over-limit",
        correlationId: "over-limit",
        ticketId: "ticket",
        messageId: "message-over-limit",
        body,
      }),
    ).rejects.toMatchObject({ field: "ticket_messages" });
  });
});
