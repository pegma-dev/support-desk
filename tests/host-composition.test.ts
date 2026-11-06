import { describe, expect, it } from "vitest";

import {
  createExampleComposition,
  EXAMPLE_CUSTOMER,
  EXAMPLE_STAFF,
  runCompleteExampleFlow,
  runInboundExampleFlow,
  runLifecycleExampleFlow,
} from "../examples/composition/composition.js";
import {
  SupportDeskAuthorizationError,
  SupportDeskNotFoundError,
  supportPermissions,
} from "@pegma/support-desk-application";

describe("host-neutral public composition", () => {
  it("exercises staff tags, host targets, and revision collision hints", async () => {
    const result = await runLifecycleExampleFlow();
    expect(result.tags).toEqual(["needs_review"]);
    expect(result.staleRevision).toBe(2);
    expect(result.customerMetadataHidden).toBe(true);
    expect(result.firstStaffRespondedAt).toBeDefined();
    expect(result.resolvedAt).toBeDefined();
  });
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

    // Cycle closed: checkpoint cleared after the last successful page.
    const sendState = await composition.scheduler.getState("mail.send");
    expect(sendState).not.toBeNull();
    expect(sendState?.checkpoint).toBeUndefined();
    const repairState = await composition.scheduler.getState("queue.repair");
    expect(repairState).not.toBeNull();
    expect(repairState?.checkpoint).toBeUndefined();

    const serialized = JSON.stringify(composition.sent);
    expect(serialized).not.toContain("Internal:");
    expect(serialized).not.toContain("check export entitlement");
    for (const field of [
      "tags",
      "firstResponseDueAt",
      "resolutionDueAt",
      "firstStaffRespondedAt",
      "resolvedAt",
    ])
      expect(serialized).not.toContain(`"${field}"`);
  });

  it("runs verified inbound mail through the public processor", async () => {
    const composition = createExampleComposition();
    await runCompleteExampleFlow(composition);
    const inbound = await runInboundExampleFlow(composition);

    expect(inbound.created).toMatchObject({
      outcome: "created",
      association: "unverified",
      ticketId: "ticket-inbound-001",
    });
    expect(inbound.retry).toEqual({
      ...inbound.created,
      duplicateDelivery: true,
    });
    expect(inbound.followUp).toMatchObject({
      outcome: "replied",
      matchMethod: "message_id",
      ticketId: "ticket-inbound-001",
    });
    expect(inbound.autoReply).toMatchObject({
      outcome: "suppressed",
      reason: "auto_submitted",
    });
    expect(inbound.matched.association).toBe("matched_email");
    expect(inbound.unverifiedQueueSize).toBe(1);

    const staffView = await composition.application.readStaffTicket(
      EXAMPLE_STAFF,
      "ticket-inbound-001",
    );
    expect(staffView.ticket.priority).toBe("low");
    expect(staffView.ticket.status).toBe("waiting_on_support");

    // The matched account still owns only its authenticated web ticket.
    const memberTickets = await composition.application.listCustomerTickets({
      ...EXAMPLE_CUSTOMER,
      principalId: "member-example-001",
    });
    expect(memberTickets).toEqual([]);

    const repairState = await composition.scheduler.getState(
      "thread-index.repair",
    );
    expect(repairState?.checkpoint).toBeUndefined();
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

  it("keeps independent scheduler checkpoints for mail send and queue repair", async () => {
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
    const sendCheckpoint = send.nextCursor;
    await expect(
      composition.scheduler.getState("mail.send"),
    ).resolves.toMatchObject(
      sendCheckpoint === null
        ? { consecutiveFailures: 0 }
        : { checkpoint: sendCheckpoint },
    );
    if (sendCheckpoint === null) {
      expect(
        (await composition.scheduler.getState("mail.send"))?.checkpoint,
      ).toBeUndefined();
    }
    await expect(
      composition.scheduler.getState("queue.repair"),
    ).resolves.toBeNull();

    const repair = await composition.runQueueRepairPage(1);
    await expect(
      composition.scheduler.getState("mail.send"),
    ).resolves.toMatchObject(
      sendCheckpoint === null
        ? { consecutiveFailures: 0 }
        : { checkpoint: sendCheckpoint },
    );
    if (sendCheckpoint === null) {
      expect(
        (await composition.scheduler.getState("mail.send"))?.checkpoint,
      ).toBeUndefined();
    }
    expect(
      (await composition.scheduler.getState("queue.repair"))?.checkpoint ??
        null,
    ).toBe(repair.nextCursor);
  });
});
