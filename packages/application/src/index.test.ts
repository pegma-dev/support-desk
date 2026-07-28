import type { AccessContext } from "@pegma/authorization-core";
import { fixedClock } from "@pegma/spine";
import { createMemoryStore, type Store } from "@pegma/storage-core";
import { describe, expect, it } from "vitest";
import {
  claimAcceptedDeliveryJob,
  claimDeliveryJob,
  completeDeliveryAttempt,
  createSupportDeskApplication,
  type CustomerTicketIndexRecord,
  customerTicketIndex,
  deliveryCallbackBucket,
  deliveryCallbackReceipts,
  deliveryIdempotencyKey,
  maxDeliveryCallbacksPerBucket,
  pruneCustomerTicketIndex,
  recordDeliveryCallback,
  SupportDeskConflictError,
  supportPermissions,
  supportRecords,
  SupportDeskAuthorizationError,
  SupportDeskLimitError,
  SupportDeskNotFoundError,
  sweepDeliveryCallbackReceipts,
  sweepTerminalDeliveryJobs,
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

    expect(created.ticket.requester.principalId).toBe("customer-1");
    expect(created.messages.map((message) => message.body)).toEqual([
      "The plan page stays blank.",
    ]);
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

    expect(repeated.ticket.revision).toBe(2);
    expect(repeated.messages).toHaveLength(2);
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
    expect(view.ticket.revision).toBe(5);
    expect(view.messages.map((message) => message.id).sort()).toEqual([
      "message-1",
      "message-2",
      "message-3",
      "message-4",
      "message-5",
    ]);
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

    const view = await application.readCustomerTicket(caller, "ticket");
    expect(view.messages.map((message) => message.id)).toEqual(["public"]);
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
      status: "delivered" as const,
      occurredAt: "2026-07-27T12:01:00.000Z",
    };

    const first = await recordDeliveryCallback(store, callback, callbackClock);
    const repeated = await recordDeliveryCallback(
      store,
      callback,
      callbackClock,
    );

    expect(first.duplicate).toBe(false);
    expect(first.job?.status).toBe("delivered");
    expect(repeated).toEqual({ duplicate: true, job: null });
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

  it("keeps delivered and dead-letter jobs terminal under late callbacks", async () => {
    const store = createMemoryStore();
    const application = createSupportDeskApplication({
      store,
      clock: fixedClock("2026-07-27T12:00:00.000Z"),
    });
    const createWithJob = async (ticketId: string, maxAttempts: number) =>
      application.createCustomerTicket(
        access("customer", allCustomerPermissions),
        {
          commandId: `create-${ticketId}`,
          correlationId: `correlation-${ticketId}`,
          ticketId,
          ticketNumber: ticketId === "delivered" ? 1 : 2,
          messageId: `message-${ticketId}`,
          subject: "Question",
          body: "Start.",
          notification: {
            id: "notify",
            recipientRef: "support",
            templateId: "staff.new-ticket",
            templateVersion: 1,
            variables: {},
            subject: "[Ticket #1] Question",
            outboundMessageId: `<support.${ticketId}@example.test>`,
            maxAttempts,
          },
        },
      );
    await createWithJob("delivered", 2);
    await createWithJob("dead", 1);

    await recordDeliveryCallback(
      store,
      {
        provider: "test",
        providerEventId: "delivered-first",
        ticketId: "delivered",
        deliveryJobId: "notify",
        status: "delivered",
        occurredAt: "2026-07-27T12:01:00.000Z",
      },
      callbackClock,
    );
    const lateFailure = await recordDeliveryCallback(
      store,
      {
        provider: "test",
        providerEventId: "failed-late",
        ticketId: "delivered",
        deliveryJobId: "notify",
        status: "failed",
        occurredAt: "2026-07-27T12:02:00.000Z",
      },
      callbackClock,
    );

    const deadClaim = await claimDeliveryJob(store, {
      ticketId: "dead",
      deliveryJobId: "notify",
      workerId: "worker",
      now: "2026-07-27T12:01:00.000Z",
      leaseExpiresAt: "2026-07-27T12:02:00.000Z",
    });
    expect(deadClaim?.claimToken).toBeDefined();
    await completeDeliveryAttempt(store, {
      ticketId: "dead",
      deliveryJobId: "notify",
      workerId: "worker",
      claimToken: deadClaim?.claimToken ?? "",
      now: "2026-07-27T12:01:01.000Z",
      outcome: {
        accepted: false,
        failureCategory: "provider_unavailable",
        retryAt: "2026-07-27T12:01:02.000Z",
      },
    });
    const lateSuccess = await recordDeliveryCallback(
      store,
      {
        provider: "test",
        providerEventId: "delivered-late",
        ticketId: "dead",
        deliveryJobId: "notify",
        status: "delivered",
        occurredAt: "2026-07-27T12:03:00.000Z",
      },
      callbackClock,
    );

    expect(lateFailure.job?.status).toBe("delivered");
    expect(lateSuccess.job?.status).toBe("dead_letter");
  });

  it("uses trusted callback processing time for retry and terminal retention", async () => {
    const store = createMemoryStore();
    const application = createSupportDeskApplication({
      store,
      clock: fixedClock("2026-07-27T12:00:00.000Z"),
    });
    const createWithJob = async (ticketId: string, maxAttempts: number) =>
      application.createCustomerTicket(
        access("customer", allCustomerPermissions),
        {
          commandId: `create-${ticketId}`,
          correlationId: `correlation-${ticketId}`,
          ticketId,
          ticketNumber:
            ticketId === "retry" ? 1 : ticketId === "delivered" ? 2 : 3,
          messageId: `message-${ticketId}`,
          subject: "Question",
          body: "Start.",
          notification: {
            id: "notify",
            recipientRef: "support",
            templateId: "staff.new-ticket",
            templateVersion: 1,
            variables: {},
            subject: "[Ticket] Question",
            outboundMessageId: `<support.${ticketId}@example.test>`,
            maxAttempts,
          },
        },
      );
    await createWithJob("retry", 3);
    await createWithJob("delivered", 3);
    await createWithJob("dead", 1);

    const deadClaim = await claimDeliveryJob(store, {
      ticketId: "dead",
      deliveryJobId: "notify",
      workerId: "worker",
      now: "2026-07-27T12:01:00.000Z",
      leaseExpiresAt: "2026-07-27T12:02:00.000Z",
    });
    await completeDeliveryAttempt(store, {
      ticketId: "dead",
      deliveryJobId: "notify",
      workerId: "worker",
      claimToken: deadClaim?.claimToken ?? "",
      now: "2026-07-27T12:01:01.000Z",
      outcome: {
        accepted: true,
        providerMessageRef: "provider-dead",
        acceptedDeadlineAt: "2026-07-27T13:01:01.000Z",
      },
    });

    const processedAt = "2026-07-27T12:30:00.000Z";
    const processingClock = fixedClock(processedAt);
    const retrying = await recordDeliveryCallback(
      store,
      {
        provider: "test",
        providerEventId: "future-failure",
        ticketId: "retry",
        deliveryJobId: "notify",
        status: "failed",
        occurredAt: "2099-01-01T00:00:00.000Z",
      },
      processingClock,
    );
    expect(retrying.job?.status).toBe("retrying");
    expect(retrying.job?.availableAt).toBe(processedAt);
    expect(
      await claimDeliveryJob(store, {
        ticketId: "retry",
        deliveryJobId: "notify",
        workerId: "worker",
        now: processedAt,
        leaseExpiresAt: "2026-07-27T12:31:00.000Z",
      }),
    ).not.toBeNull();

    const delivered = await recordDeliveryCallback(
      store,
      {
        provider: "test",
        providerEventId: "old-delivery",
        ticketId: "delivered",
        deliveryJobId: "notify",
        status: "delivered",
        occurredAt: "2000-01-01T00:00:00.000Z",
      },
      processingClock,
    );
    const dead = await recordDeliveryCallback(
      store,
      {
        provider: "test",
        providerEventId: "old-failure",
        ticketId: "dead",
        deliveryJobId: "notify",
        status: "failed",
        occurredAt: "2000-01-01T00:00:00.000Z",
      },
      processingClock,
    );
    expect(delivered.job?.deliveredAt).toBe(processedAt);
    expect(delivered.job?.terminalAt).toBe(processedAt);
    expect(dead.job?.status).toBe("dead_letter");
    expect(dead.job?.terminalAt).toBe(processedAt);

    for (const ticketId of ["delivered", "dead"]) {
      expect(
        await sweepTerminalDeliveryJobs(store, {
          ticketId,
          terminalBefore: "2026-07-27T12:29:59.999Z",
        }),
      ).toBe(0);
      expect(
        await sweepTerminalDeliveryJobs(store, {
          ticketId,
          terminalBefore: "2026-07-27T12:30:00.001Z",
        }),
      ).toBe(1);
    }
  });

  it("rejects invalid direct lease and completion boundaries", async () => {
    const store = createMemoryStore();
    expect(() =>
      deliveryIdempotencyKey("x".repeat(256), "delivery:notify"),
    ).toThrow(/safe provider format/);
    await expect(
      claimDeliveryJob(store, {
        ticketId: "ticket",
        deliveryJobId: "notify",
        workerId: "worker",
        now: "not-a-time",
        leaseExpiresAt: "2026-07-27T12:02:00.000Z",
      }),
    ).rejects.toThrow(/canonical ISO timestamp/);
    await expect(
      claimDeliveryJob(store, {
        ticketId: "ticket",
        deliveryJobId: "notify",
        workerId: "worker",
        now: "2026-07-27T12:02:00.000Z",
        leaseExpiresAt: "2026-07-27T12:02:00.000Z",
      }),
    ).rejects.toThrow(/later than now/);
    await expect(
      completeDeliveryAttempt(store, {
        ticketId: "ticket",
        deliveryJobId: "notify",
        workerId: "worker",
        claimToken: "claim",
        now: "2026-07-27T12:02:00.000Z",
        outcome: {
          accepted: false,
          failureCategory: "Error: provider leaked a secret",
          retryAt: "2026-07-27T12:01:00.000Z",
        },
      }),
    ).rejects.toThrow(/retryAt/);
    await expect(
      completeDeliveryAttempt(store, {
        ticketId: "ticket",
        deliveryJobId: "notify",
        workerId: "worker",
        claimToken: "claim",
        now: "2026-07-27T12:02:00.000Z",
        outcome: {
          accepted: false,
          failureCategory: "Error: provider leaked a secret",
          retryAt: "2026-07-27T12:03:00.000Z",
        },
      }),
    ).rejects.toThrow(/coarse safe token/);
  });

  it("fences stale completion even when the same worker reclaims the job", async () => {
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
    const first = await claimDeliveryJob(store, {
      ticketId: "ticket",
      deliveryJobId: "notify",
      workerId: "same-worker",
      now: "2026-07-27T12:01:00.000Z",
      leaseExpiresAt: "2026-07-27T12:02:00.000Z",
    });
    const second = await claimDeliveryJob(store, {
      ticketId: "ticket",
      deliveryJobId: "notify",
      workerId: "same-worker",
      now: "2026-07-27T12:03:00.000Z",
      leaseExpiresAt: "2026-07-27T12:04:00.000Z",
    });
    expect(first?.claimToken).not.toBe(second?.claimToken);

    expect(
      await completeDeliveryAttempt(store, {
        ticketId: "ticket",
        deliveryJobId: "notify",
        workerId: "same-worker",
        claimToken: first?.claimToken ?? "",
        now: "2026-07-27T12:03:01.000Z",
        outcome: {
          accepted: true,
          providerMessageRef: "stale",
          acceptedDeadlineAt: "2026-07-28T12:03:01.000Z",
        },
      }),
    ).toBeNull();
    const completed = await completeDeliveryAttempt(store, {
      ticketId: "ticket",
      deliveryJobId: "notify",
      workerId: "same-worker",
      claimToken: second?.claimToken ?? "",
      now: "2026-07-27T12:03:02.000Z",
      outcome: {
        accepted: true,
        providerMessageRef: "current",
        acceptedDeadlineAt: "2026-07-28T12:03:02.000Z",
      },
    });
    expect(completed?.status).toBe("accepted");
    expect(completed?.providerMessageRef).toBe("current");
  });

  it("recovers a crashed reconciliation lease without making it sendable", async () => {
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
    const sendClaim = await claimDeliveryJob(store, {
      ticketId: "ticket",
      deliveryJobId: "notify",
      workerId: "sender",
      now: "2026-07-27T12:01:00.000Z",
      leaseExpiresAt: "2026-07-27T12:01:30.000Z",
    });
    await completeDeliveryAttempt(store, {
      ticketId: "ticket",
      deliveryJobId: "notify",
      workerId: "sender",
      claimToken: sendClaim?.claimToken ?? "",
      now: "2026-07-27T12:01:01.000Z",
      outcome: {
        accepted: true,
        providerMessageRef: "provider",
        acceptedDeadlineAt: "2026-07-27T12:02:00.000Z",
      },
    });

    const crashedReconciliation = await claimAcceptedDeliveryJob(store, {
      ticketId: "ticket",
      deliveryJobId: "notify",
      workerId: "reconciler-a",
      now: "2026-07-27T12:02:00.000Z",
      leaseExpiresAt: "2026-07-27T12:03:00.000Z",
    });
    expect(crashedReconciliation?.leasePurpose).toBe("reconcile");

    expect(
      await claimDeliveryJob(store, {
        ticketId: "ticket",
        deliveryJobId: "notify",
        workerId: "sender",
        now: "2026-07-27T12:04:00.000Z",
        leaseExpiresAt: "2026-07-27T12:05:00.000Z",
      }),
    ).toBeNull();
    const recovered = await claimAcceptedDeliveryJob(store, {
      ticketId: "ticket",
      deliveryJobId: "notify",
      workerId: "reconciler-b",
      now: "2026-07-27T12:04:00.000Z",
      leaseExpiresAt: "2026-07-27T12:05:00.000Z",
    });
    expect(recovered?.leasePurpose).toBe("reconcile");
    expect(recovered?.claimToken).not.toBe(crashedReconciliation?.claimToken);
  });

  it("makes a post-acceptance failure actionable but never regresses confirmed delivery", async () => {
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
    const claim = await claimDeliveryJob(store, {
      ticketId: "ticket",
      deliveryJobId: "notify",
      workerId: "worker",
      now: "2026-07-27T12:01:00.000Z",
      leaseExpiresAt: "2026-07-27T12:02:00.000Z",
    });
    const accepted = await completeDeliveryAttempt(store, {
      ticketId: "ticket",
      deliveryJobId: "notify",
      workerId: "worker",
      claimToken: claim?.claimToken ?? "",
      now: "2026-07-27T12:01:01.000Z",
      outcome: {
        accepted: true,
        providerMessageRef: "provider",
        acceptedDeadlineAt: "2026-07-28T12:01:01.000Z",
      },
    });
    expect(accepted?.status).toBe("accepted");

    const failed = await recordDeliveryCallback(
      store,
      {
        provider: "test",
        providerEventId: "failed",
        ticketId: "ticket",
        deliveryJobId: "notify",
        status: "failed",
        occurredAt: "2026-07-27T12:02:00.000Z",
      },
      callbackClock,
    );
    expect(failed.job?.status).toBe("retrying");

    const delivered = await recordDeliveryCallback(
      store,
      {
        provider: "test",
        providerEventId: "delivered",
        ticketId: "ticket",
        deliveryJobId: "notify",
        status: "delivered",
        occurredAt: "2026-07-27T12:03:00.000Z",
      },
      callbackClock,
    );
    const lateFailure = await recordDeliveryCallback(
      store,
      {
        provider: "test",
        providerEventId: "late-failure",
        ticketId: "ticket",
        deliveryJobId: "notify",
        status: "failed",
        occurredAt: "2026-07-27T12:04:00.000Z",
      },
      callbackClock,
    );
    expect(delivered.job?.status).toBe("delivered");
    expect(lateFailure.job?.status).toBe("delivered");
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

    await recordDeliveryCallback(
      store,
      {
        provider: "test",
        providerEventId: "delivered",
        ticketId: "ticket-1",
        deliveryJobId: "notify",
        status: "delivered",
        occurredAt: "2026-07-27T12:01:00.000Z",
      },
      callbackClock,
    );
    expect(
      await sweepTerminalDeliveryJobs(store, {
        ticketId: "ticket-1",
        terminalBefore: "2026-07-27T14:01:00.000Z",
      }),
    ).toBe(1);
    expect(
      (await store.collection(supportRecords).list("ticket-1")).some(
        (record) => record.kind === "delivery_job",
      ),
    ).toBe(false);

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
