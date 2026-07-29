import { describe, expect, it } from "vitest";

import {
  applyTicketEvent,
  createTicket,
  TicketWorkflowError,
} from "./index.js";

function ticket() {
  return createTicket({
    id: "ticket-1",
    number: 1001,
    subject: "Cannot access my subscription",
    channel: "web",
    requester: {
      association: "authenticated",
      principalId: "customer-1",
      email: "customer@example.com",
    },
    createdAt: "2026-07-24T13:00:00.000Z",
  });
}

describe("createTicket", () => {
  it("creates an immutable open ticket with safe defaults", () => {
    const created = ticket();

    expect(created).toEqual({
      id: "ticket-1",
      number: 1001,
      revision: 1,
      subject: "Cannot access my subscription",
      channel: "web",
      status: "open",
      priority: "normal",
      requester: {
        association: "authenticated",
        principalId: "customer-1",
        email: "customer@example.com",
      },
      createdAt: "2026-07-24T13:00:00.000Z",
      updatedAt: "2026-07-24T13:00:00.000Z",
      customerUpdatedAt: "2026-07-24T13:00:00.000Z",
    });
    expect(Object.isFrozen(created)).toBe(true);
    expect(Object.isFrozen(created.requester)).toBe(true);
  });

  it("preserves an optional category and sets both update timestamps", () => {
    const created = createTicket({
      id: "ticket-1",
      number: 1001,
      subject: "Cannot access my subscription",
      channel: "web",
      category: "bug",
      requester: {
        association: "authenticated",
        principalId: "customer-1",
      },
      createdAt: "2026-07-24T13:00:00.000Z",
    });

    expect(created.category).toBe("bug");
    expect(created.customerUpdatedAt).toBe(created.createdAt);
    expect(created.updatedAt).toBe(created.createdAt);
  });

  it("requires association evidence appropriate to the requester", () => {
    expect(() =>
      createTicket({
        id: "ticket-2",
        number: 1002,
        subject: "Checkout question",
        channel: "email",
        requester: {
          association: "matched_email",
          email: "customer@example.com",
        },
        createdAt: "2026-07-24T13:00:00.000Z",
      }),
    ).toThrowError(
      "matched_email requester must include principalId and email",
    );
  });

  it("rejects a principal ID for an unverified requester", () => {
    expect(() =>
      createTicket({
        id: "ticket-2",
        number: 1002,
        subject: "Checkout question",
        channel: "email",
        requester: {
          association: "unverified",
          principalId: "customer-1",
          email: "customer@example.com",
        },
        createdAt: "2026-07-24T13:00:00.000Z",
      }),
    ).toThrowError(
      "unverified requester must not include requester.principalId",
    );
  });

  it("rejects an unknown channel at runtime", () => {
    expect(() =>
      createTicket({
        id: "ticket-2",
        number: 1002,
        subject: "Checkout question",
        channel: "sms" as never,
        requester: {
          association: "authenticated",
          principalId: "customer-1",
        },
        createdAt: "2026-07-24T13:00:00.000Z",
      }),
    ).toThrowError("channel must be one of: web, email, api");
  });

  it("rejects an unknown priority at runtime", () => {
    expect(() =>
      createTicket({
        id: "ticket-2",
        number: 1002,
        subject: "Checkout question",
        channel: "web",
        priority: "URGENT" as never,
        requester: {
          association: "authenticated",
          principalId: "customer-1",
        },
        createdAt: "2026-07-24T13:00:00.000Z",
      }),
    ).toThrowError("priority must be one of: low, normal, high, urgent");
  });

  it.each([
    "0",
    "07/24/2026",
    "2026-02-30T13:00:00.000Z",
    "2026-07-24T13:00:00Z",
  ])("rejects the non-canonical timestamp %s", (createdAt) => {
    expect(() =>
      createTicket({
        id: "ticket-2",
        number: 1002,
        subject: "Checkout question",
        channel: "web",
        requester: {
          association: "authenticated",
          principalId: "customer-1",
        },
        createdAt,
      }),
    ).toThrowError("createdAt must be a valid canonical ISO timestamp");
  });
});

describe("applyTicketEvent", () => {
  it("moves a support reply to waiting on the customer", () => {
    const updated = applyTicketEvent(ticket(), {
      type: "support_replied",
      actorId: "support-1",
      occurredAt: "2026-07-24T13:05:00.000Z",
    });

    expect(updated.status).toBe("waiting_on_customer");
    expect(updated.revision).toBe(2);
  });

  it("reopens a resolved ticket when the customer replies", () => {
    const resolved = applyTicketEvent(ticket(), {
      type: "resolved",
      actorId: "support-1",
      occurredAt: "2026-07-24T13:05:00.000Z",
    });
    const replied = applyTicketEvent(resolved, {
      type: "customer_replied",
      actorId: "customer-1",
      occurredAt: "2026-07-24T13:10:00.000Z",
    });

    expect(replied.status).toBe("waiting_on_support");
    expect(replied.resolvedAt).toBeUndefined();
  });

  it("explicitly reopens resolved and closed tickets", () => {
    const resolved = applyTicketEvent(ticket(), {
      type: "resolved",
      actorId: "support-1",
      occurredAt: "2026-07-24T13:05:00.000Z",
    });
    const reopenedResolved = applyTicketEvent(resolved, {
      type: "reopened",
      actorId: "support-1",
      occurredAt: "2026-07-24T13:06:00.000Z",
    });
    const closed = applyTicketEvent(resolved, {
      type: "closed",
      actorId: "support-1",
      occurredAt: "2026-07-24T13:06:00.000Z",
    });
    const reopenedClosed = applyTicketEvent(closed, {
      type: "reopened",
      actorId: "support-1",
      occurredAt: "2026-07-24T13:07:00.000Z",
    });

    expect(reopenedResolved).toMatchObject({
      status: "waiting_on_support",
      revision: 3,
    });
    expect(reopenedResolved.resolvedAt).toBeUndefined();
    expect(reopenedClosed).toMatchObject({
      status: "waiting_on_support",
      revision: 4,
    });
    expect(reopenedClosed.resolvedAt).toBeUndefined();
    expect(reopenedClosed.closedAt).toBeUndefined();
  });

  it("rejects reopening an active ticket", () => {
    expect(() =>
      applyTicketEvent(ticket(), {
        type: "reopened",
        actorId: "support-1",
        occurredAt: "2026-07-24T13:05:00.000Z",
      }),
    ).toThrowError("only a resolved or closed ticket can be reopened");
  });

  it("requires resolution before closure", () => {
    expect(() =>
      applyTicketEvent(ticket(), {
        type: "closed",
        actorId: "support-1",
        occurredAt: "2026-07-24T13:05:00.000Z",
      }),
    ).toThrowError(TicketWorkflowError);
  });

  it("supports assignment and unassignment without changing status", () => {
    const assigned = applyTicketEvent(ticket(), {
      type: "assigned",
      actorId: "admin-1",
      assigneeId: "support-1",
      occurredAt: "2026-07-24T13:05:00.000Z",
    });
    const unassigned = applyTicketEvent(assigned, {
      type: "assigned",
      actorId: "admin-1",
      assigneeId: null,
      occurredAt: "2026-07-24T13:06:00.000Z",
    });

    expect(assigned.assignedTo).toBe("support-1");
    expect(unassigned.assignedTo).toBeUndefined();
    expect(unassigned.status).toBe("open");
  });

  it("changes priority without changing status", () => {
    const updated = applyTicketEvent(ticket(), {
      type: "priority_changed",
      actorId: "support-1",
      priority: "high",
      occurredAt: "2026-07-24T13:05:00.000Z",
    });

    expect(updated.priority).toBe("high");
    expect(updated.status).toBe("open");
    expect(updated.revision).toBe(2);
  });

  it("advances customerUpdatedAt only for customer-visible changes", () => {
    const base = createTicket({
      id: "ticket-1",
      number: 1001,
      subject: "Question",
      channel: "web",
      category: "question",
      requester: {
        association: "authenticated",
        principalId: "customer-1",
      },
      createdAt: "2026-07-24T13:00:00.000Z",
    });

    const noted = applyTicketEvent(base, {
      type: "note_added",
      actorId: "support-1",
      occurredAt: "2026-07-24T13:05:00.000Z",
    });
    expect(noted.updatedAt).toBe("2026-07-24T13:05:00.000Z");
    expect(noted.customerUpdatedAt).toBe("2026-07-24T13:00:00.000Z");
    expect(noted.category).toBe("question");

    const assigned = applyTicketEvent(noted, {
      type: "assigned",
      actorId: "admin-1",
      assigneeId: "support-1",
      occurredAt: "2026-07-24T13:06:00.000Z",
    });
    expect(assigned.updatedAt).toBe("2026-07-24T13:06:00.000Z");
    expect(assigned.customerUpdatedAt).toBe("2026-07-24T13:00:00.000Z");
    expect(assigned.category).toBe("question");

    const prioritized = applyTicketEvent(assigned, {
      type: "priority_changed",
      actorId: "support-1",
      priority: "high",
      occurredAt: "2026-07-24T13:07:00.000Z",
    });
    expect(prioritized.updatedAt).toBe("2026-07-24T13:07:00.000Z");
    expect(prioritized.customerUpdatedAt).toBe("2026-07-24T13:00:00.000Z");
    expect(prioritized.priority).toBe("high");
    expect(prioritized.category).toBe("question");

    const staffReplied = applyTicketEvent(prioritized, {
      type: "support_replied",
      actorId: "support-1",
      occurredAt: "2026-07-24T13:08:00.000Z",
    });
    expect(staffReplied.updatedAt).toBe("2026-07-24T13:08:00.000Z");
    expect(staffReplied.customerUpdatedAt).toBe("2026-07-24T13:08:00.000Z");
    expect(staffReplied.category).toBe("question");

    const resolved = applyTicketEvent(staffReplied, {
      type: "resolved",
      actorId: "support-1",
      occurredAt: "2026-07-24T13:09:00.000Z",
    });
    expect(resolved.customerUpdatedAt).toBe("2026-07-24T13:09:00.000Z");
    expect(resolved.category).toBe("question");
  });

  it("clones and freezes requesters on transitioned persisted tickets", () => {
    const persisted = {
      ...ticket(),
      requester: { ...ticket().requester },
    };
    const updated = applyTicketEvent(persisted, {
      type: "note_added",
      actorId: "support-1",
      occurredAt: "2026-07-24T13:05:00.000Z",
    });

    expect(updated.requester).not.toBe(persisted.requester);
    expect(Object.isFrozen(updated.requester)).toBe(true);
  });

  it("allows a customer reply without an actor principal", () => {
    const updated = applyTicketEvent(ticket(), {
      type: "customer_replied",
      occurredAt: "2026-07-24T13:05:00.000Z",
    });

    expect(updated.status).toBe("waiting_on_support");
  });

  it("rejects a staff event without an actor at runtime", () => {
    expect(() =>
      applyTicketEvent(ticket(), {
        type: "support_replied",
        occurredAt: "2026-07-24T13:05:00.000Z",
      } as never),
    ).toThrowError("event.actorId must be a non-empty string");
  });

  it("rejects an empty assignee at runtime", () => {
    expect(() =>
      applyTicketEvent(ticket(), {
        type: "assigned",
        actorId: "admin-1",
        assigneeId: " ",
        occurredAt: "2026-07-24T13:05:00.000Z",
      }),
    ).toThrowError("event.assigneeId must be a non-empty string");
  });

  it("rejects an unknown priority change at runtime", () => {
    expect(() =>
      applyTicketEvent(ticket(), {
        type: "priority_changed",
        actorId: "support-1",
        priority: "critical" as never,
        occurredAt: "2026-07-24T13:05:00.000Z",
      }),
    ).toThrowError("event.priority must be one of: low, normal, high, urgent");
  });

  it("fails fast for an unknown runtime event type", () => {
    expect(() =>
      applyTicketEvent(ticket(), {
        type: "deleted",
        actorId: "support-1",
        occurredAt: "2026-07-24T13:05:00.000Z",
      } as never),
    ).toThrowError("unsupported ticket event type: deleted");
  });

  it("rejects stale events", () => {
    const current = applyTicketEvent(ticket(), {
      type: "note_added",
      actorId: "support-1",
      occurredAt: "2026-07-24T13:10:00.000Z",
    });

    expect(() =>
      applyTicketEvent(current, {
        type: "priority_changed",
        actorId: "support-1",
        priority: "high",
        occurredAt: "2026-07-24T13:09:59.000Z",
      }),
    ).toThrowError(
      "event.occurredAt must not be earlier than ticket.updatedAt",
    );
  });
});
