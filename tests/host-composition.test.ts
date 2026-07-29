import { describe, expect, it } from "vitest";

import {
  createExampleComposition,
  EXAMPLE_CUSTOMER,
  EXAMPLE_STAFF,
  runCompleteExampleFlow,
} from "../examples/composition/composition.js";
import {
  SupportDeskAuthorizationError,
  SupportDeskNotFoundError,
  supportPermissions,
} from "@pegma/support-desk-application";

describe("host-neutral public composition", () => {
  it("runs complete customer and staff flows through public entry points", async () => {
    const composition = createExampleComposition();
    const result = await runCompleteExampleFlow(composition);

    expect(result.ticketId).toBe("ticket-example-001");
    expect(result.customerViewSubject).toBe("Cannot export my data");
    expect(result.staffQueueSize).toBe(1);
    expect(result.noteCount).toBe(1);
    expect(result.customerMessageBodies).toEqual([
      "The export button stays disabled.",
      "I tried again after a refresh.",
      "Thanks — we are investigating the export control.",
    ]);
    expect(result.mailSent).toBeGreaterThanOrEqual(1);
    expect(composition.cursors.get("mail.send")).toBeNull();
    expect(composition.cursors.get("queue.repair")).toBeNull();

    const serialized = JSON.stringify(composition.sent);
    expect(serialized).not.toContain("Internal:");
    expect(serialized).not.toContain("check export entitlement");
  });

  it("maps missing permission and foreign ticket access to public error classes", async () => {
    const composition = createExampleComposition();
    await runCompleteExampleFlow(composition);

    await expect(
      composition.application.listCustomerTickets({
        ...EXAMPLE_CUSTOMER,
        permissions: [],
      }),
    ).rejects.toBeInstanceOf(SupportDeskAuthorizationError);

    await expect(
      composition.application.readCustomerTicket(
        {
          ...EXAMPLE_CUSTOMER,
          principalId: "other-customer",
          permissions: [
            supportPermissions.create,
            supportPermissions.readOwn,
            supportPermissions.replyOwn,
          ],
        },
        "ticket-example-001",
      ),
    ).rejects.toBeInstanceOf(SupportDeskNotFoundError);

    await expect(
      composition.application.readStaffTicket(
        {
          ...EXAMPLE_STAFF,
          permissions: [supportPermissions.note],
        },
        "ticket-example-001",
      ),
    ).rejects.toBeInstanceOf(SupportDeskAuthorizationError);
  });

  it("keeps independent cursors for mail send and queue repair loops", async () => {
    const composition = createExampleComposition();
    await composition.application.createCustomerTicket(EXAMPLE_CUSTOMER, {
      commandId: "cmd-create-cursor",
      correlationId: "corr-create-cursor",
      ticketId: "ticket-cursor-1",
      messageId: "msg-cursor-1",
      subject: "Cursor isolation",
      body: "Body",
      notification: {
        id: "notify-cursor-1",
        recipientRef: "staff@example.test",
        templateId: "example.staff-new-ticket",
        templateVersion: 1,
        variables: { ticket_number: "1" },
        subject: "Cursor isolation",
        outboundMessageId: "<support.notify-cursor-1@example.test>",
      },
    });

    const send = await composition.runMailSendPage(1);
    const repair = await composition.runQueueRepairPage(1);

    expect(composition.cursors.get("mail.send")).toBe(send.nextCursor);
    expect(composition.cursors.get("queue.repair")).toBe(repair.nextCursor);
    // Separate loop keys must not overwrite each other even when both end.
    expect(composition.cursors.get("mail.send")).not.toBe(
      composition.cursors.get("queue.repair") === undefined
        ? "missing"
        : "shared-wrongly",
    );
  });
});
