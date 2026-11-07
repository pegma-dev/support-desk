import type { AccessContext } from "@pegma/authorization-core";
import { fixedClock } from "@pegma/spine";
import { createMemoryStore } from "@pegma/storage-core";
import {
  createSupportDeskApplication,
  defaultSupportDeskLimits,
  supportPermissions,
  supportRecords,
  type SupportDeskApplication,
} from "@pegma/support-desk-application";
import { describe, expect, it } from "vitest";

import {
  assessRowAdmission,
  estimateTicketRows,
} from "../test/knowledge-ai/capacity.js";

const customer: AccessContext = {
  principalId: "capacity/customer",
  policyVersion: "capacity-fixture-1",
  roles: [],
  entitlements: [],
  permissions: [
    supportPermissions.create,
    supportPermissions.readOwn,
    supportPermissions.replyOwn,
  ],
};
const staff: AccessContext = {
  principalId: "capacity/staff",
  policyVersion: "capacity-fixture-1",
  roles: [],
  entitlements: [],
  permissions: Object.values(supportPermissions),
};
const ticketId = "capacity-ticket";
const base = { ticketId, correlationId: "capacity-correlation" };
const createCommand = {
  ...base,
  commandId: "create",
  messageId: "initial",
  subject: "Synthetic export question",
  body: "How do I export?",
};

function fixture(
  maxRecordsPerTicket = defaultSupportDeskLimits.maxRecordsPerTicket,
) {
  const store = createMemoryStore();
  const app = createSupportDeskApplication({
    store,
    clock: fixedClock("2026-11-06T12:00:00.000Z"),
    limits: { maxRecordsPerTicket },
  });
  return { app, records: store.collection(supportRecords) };
}

function notification(id: string) {
  return {
    id,
    recipientRef: customer.principalId,
    templateId: "fixture.reply",
    templateVersion: 1,
    variables: {},
    subject: "Synthetic support update",
    outboundMessageId: `<${id}@fixtures.invalid>`,
  };
}

async function executeMessageOperation(
  app: SupportDeskApplication,
  operation: "create" | "customer" | "staff" | "lifecycle",
  withMail: boolean,
) {
  const delivery = withMail
    ? { notification: notification(`mail-${operation}`) }
    : {};
  if (operation === "create")
    return app.createCustomerTicket(customer, {
      ...createCommand,
      ...delivery,
    });
  await app.createCustomerTicket(customer, createCommand);
  const command = {
    ...base,
    commandId: operation,
    messageId: `message-${operation}`,
    body: "Synthetic reply.",
    ...delivery,
  };
  if (operation === "customer")
    return app.replyToCustomerTicket(customer, command);
  if (operation === "staff") return app.replyAsStaff(staff, command);
  return app.resolveTicket(staff, command);
}

describe("current public Support Desk physical row costs", () => {
  it("creates six records and replays without adding any records", async () => {
    const { app, records } = fixture();
    const created = await app.createCustomerTicket(customer, createCommand);
    const snapshot = await records.list(ticketId);
    expect(snapshot.map((row) => row.kind).sort()).toEqual([
      "audit",
      "command",
      "message",
      "ticket",
      "ticket_quota",
      "ticket_reservation",
    ]);
    expect(await app.createCustomerTicket(customer, createCommand)).toEqual(
      created,
    );
    expect(await records.list(ticketId)).toEqual(snapshot);
    expect(snapshot).toHaveLength(
      estimateTicketRows({
        messages: 1,
        deliveries: 0,
        nonMessageCommands: 0,
        extensionRows: 0,
      }),
    );
  });

  it("charges three rows for each message and two for each message-free staff mutation", async () => {
    const { app, records } = fixture();
    await app.createCustomerTicket(customer, createCommand);
    expect(await records.list(ticketId)).toHaveLength(6);
    await app.replyToCustomerTicket(customer, {
      ...base,
      commandId: "customer",
      messageId: "customer",
      body: "More detail.",
    });
    expect(await records.list(ticketId)).toHaveLength(9);
    await app.replyAsStaff(staff, {
      ...base,
      commandId: "staff",
      messageId: "staff",
      body: "Try Export.",
    });
    expect(await records.list(ticketId)).toHaveLength(12);
    await app.addNote(staff, {
      ...base,
      commandId: "note",
      messageId: "note",
      body: "Internal synthetic investigation.",
    });
    expect(await records.list(ticketId)).toHaveLength(15);
    await app.assignTicket(staff, {
      ...base,
      commandId: "assign",
      assigneeId: staff.principalId,
    });
    expect(await records.list(ticketId)).toHaveLength(17);
    await app.changePriority(staff, {
      ...base,
      commandId: "priority",
      priority: "high",
    });
    expect(await records.list(ticketId)).toHaveLength(19);
    await app.resolveTicket(staff, { ...base, commandId: "resolve" });
    expect(await records.list(ticketId)).toHaveLength(21);
    await app.closeTicket(staff, { ...base, commandId: "close" });
    expect(await records.list(ticketId)).toHaveLength(23);
    const reopen = { ...base, commandId: "reopen" };
    await app.reopenTicket(staff, reopen);
    const snapshot = await records.list(ticketId);
    expect(snapshot).toHaveLength(25);
    expect(snapshot).toHaveLength(
      estimateTicketRows({
        messages: 4,
        deliveries: 0,
        nonMessageCommands: 5,
        extensionRows: 0,
      }),
    );
    await app.reopenTicket(staff, reopen);
    expect(await records.list(ticketId)).toEqual(snapshot);
  });

  it.each(["create", "customer", "staff", "lifecycle"] as const)(
    "adds exactly one physical row for optional %s mail",
    async (operation) => {
      const plain = fixture();
      const mailed = fixture();
      await executeMessageOperation(plain.app, operation, false);
      await executeMessageOperation(mailed.app, operation, true);
      const plainRows = await plain.records.list(ticketId);
      const mailedRows = await mailed.records.list(ticketId);
      expect(plainRows).toHaveLength(operation === "create" ? 6 : 9);
      expect(mailedRows).toHaveLength(plainRows.length + 1);
      expect(
        mailedRows.filter((row) => row.kind === "delivery_job"),
      ).toHaveLength(1);
      expect(
        plainRows.filter((row) => row.kind === "delivery_job"),
      ).toHaveLength(0);
      expect(mailedRows).toHaveLength(
        estimateTicketRows({
          messages: operation === "create" ? 1 : 2,
          deliveries: 1,
          nonMessageCommands: 0,
          extensionRows: 0,
        }),
      );
    },
  );

  it("fills the actual default physical cap and refuses further mutations atomically", async () => {
    expect(defaultSupportDeskLimits.maxRecordsPerTicket).toBe(512);
    const { app, records } = fixture();
    await app.createCustomerTicket(customer, createCommand);
    for (let index = 0; index < 253; index += 1) {
      await app.changePriority(staff, {
        ...base,
        commandId: `priority-${index}`,
        priority: index % 2 === 0 ? "high" : "normal",
      });
    }
    const snapshot = structuredClone(await records.list(ticketId));
    expect(snapshot).toHaveLength(512);
    expect(snapshot.filter((row) => row.kind === "message")).toHaveLength(1);
    expect(snapshot).toHaveLength(
      estimateTicketRows({
        messages: 1,
        deliveries: 0,
        nonMessageCommands: 253,
        extensionRows: 0,
      }),
    );

    await expect(
      app.replyToCustomerTicket(customer, {
        ...base,
        commandId: "refused-customer",
        messageId: "refused-customer",
        body: "This cannot fit.",
      }),
    ).rejects.toMatchObject({ field: "ticket_partition", maximum: 512 });
    expect(await records.list(ticketId)).toEqual(snapshot);
    await expect(
      app.replyAsStaff(staff, {
        ...base,
        commandId: "refused-staff",
        messageId: "refused-staff",
        body: "This cannot fit.",
        notification: notification("refused-mail"),
      }),
    ).rejects.toMatchObject({ field: "ticket_partition", maximum: 512 });
    expect(await records.list(ticketId)).toEqual(snapshot);
    await expect(
      app.addNote(staff, {
        ...base,
        commandId: "refused-note",
        messageId: "refused-note",
        body: "This cannot fit.",
      }),
    ).rejects.toMatchObject({ field: "ticket_partition", maximum: 512 });
    expect(await records.list(ticketId)).toEqual(snapshot);
    await expect(
      app.resolveTicket(staff, { ...base, commandId: "refused-resolve" }),
    ).rejects.toMatchObject({ field: "ticket_partition", maximum: 512 });
    expect(await records.list(ticketId)).toEqual(snapshot);
    await app.createCustomerTicket(customer, createCommand);
    expect(await records.list(ticketId)).toEqual(snapshot);
  });

  it("refuses an undersized first commit without partial ticket rows", async () => {
    const { app, records } = fixture(5);
    await expect(
      app.createCustomerTicket(customer, createCommand),
    ).rejects.toMatchObject({ field: "ticket_partition", maximum: 5 });
    expect(await records.list(ticketId)).toEqual([]);
  });
});

describe("proposed envelope and reserve arithmetic (harness only)", () => {
  it("models R = 3 + 3M + D + 2N + E, including the reviewed 483-row envelope", () => {
    const rows = estimateTicketRows({
      messages: 100,
      deliveries: 100,
      nonMessageCommands: 20,
      extensionRows: 40,
    });
    expect(rows).toBe(483);
    expect(
      assessRowAdmission({
        currentRows: rows,
        addedRows: 0,
        capacity: 512,
        reservedRows: 0,
      }),
    ).toEqual({
      fits: true,
      projectedRows: 483,
      spareRows: 29,
      shortfallRows: 0,
    });
  });

  it("reserves future rows explicitly without claiming production reserve admission exists", () => {
    const currentRows = estimateTicketRows({
      messages: 100,
      deliveries: 100,
      nonMessageCommands: 20,
      extensionRows: 0,
    });
    expect(currentRows).toBe(443);
    expect(
      assessRowAdmission({
        currentRows,
        addedRows: 29,
        capacity: 512,
        reservedRows: 40,
      }),
    ).toEqual({
      fits: true,
      projectedRows: 472,
      spareRows: 0,
      shortfallRows: 0,
    });
    expect(
      assessRowAdmission({
        currentRows,
        addedRows: 30,
        capacity: 512,
        reservedRows: 40,
      }),
    ).toEqual({
      fits: false,
      projectedRows: 473,
      spareRows: 0,
      shortfallRows: 1,
    });
    expect(
      assessRowAdmission({
        currentRows: 483,
        addedRows: 29,
        capacity: 512,
        reservedRows: 0,
      }).fits,
    ).toBe(true);
    expect(
      assessRowAdmission({
        currentRows: 483,
        addedRows: 30,
        capacity: 512,
        reservedRows: 0,
      }).fits,
    ).toBe(false);
  });

  it.each([
    -1,
    0.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ])("rejects invalid count or admission bound %s", (invalid) => {
    const envelope = {
      messages: 0,
      deliveries: 0,
      nonMessageCommands: 0,
      extensionRows: 0,
    };
    for (const field of Object.keys(envelope) as (keyof typeof envelope)[]) {
      expect(() =>
        estimateTicketRows({ ...envelope, [field]: invalid }),
      ).toThrow(TypeError);
    }
    const admission = {
      currentRows: 0,
      addedRows: 0,
      capacity: 512,
      reservedRows: 0,
    };
    for (const field of Object.keys(admission) as (keyof typeof admission)[]) {
      expect(() =>
        assessRowAdmission({ ...admission, [field]: invalid }),
      ).toThrow(TypeError);
    }
  });

  it("rejects unsafe sums or a reserve greater than physical capacity", () => {
    expect(() =>
      estimateTicketRows({
        messages: Number.MAX_SAFE_INTEGER,
        deliveries: 0,
        nonMessageCommands: 0,
        extensionRows: 0,
      }),
    ).toThrow(TypeError);
    expect(() =>
      assessRowAdmission({
        currentRows: Number.MAX_SAFE_INTEGER,
        addedRows: 1,
        capacity: Number.MAX_SAFE_INTEGER,
        reservedRows: 0,
      }),
    ).toThrow(TypeError);
    expect(() =>
      assessRowAdmission({
        currentRows: 0,
        addedRows: 0,
        capacity: 2,
        reservedRows: 3,
      }),
    ).toThrow(TypeError);
    expect(
      assessRowAdmission({
        currentRows: 0,
        addedRows: 0,
        capacity: 0,
        reservedRows: 0,
      }).fits,
    ).toBe(true);
  });
});
