import { describe, expect, it } from "vitest";
import { applyTicketEvent, createTicket } from "./index.js";

describe("lifecycle extras", () => {
  const now = "2026-11-01T10:00:00.000Z";
  const ticket = () =>
    createTicket({
      id: "ticket",
      number: 1,
      subject: "Question",
      channel: "web",
      requester: { association: "authenticated", principalId: "customer" },
      createdAt: now,
    });
  it("freezes copied tags and changes only staff state", () => {
    const tags = ["review"];
    const result = applyTicketEvent(ticket(), {
      type: "tags_changed",
      actorId: "staff",
      occurredAt: now,
      tags,
    });
    tags.push("other");
    expect(result.tags).toEqual(["review"]);
    expect(Object.isFrozen(result.tags)).toBe(true);
    expect(result.status).toBe("open");
    expect(result.customerUpdatedAt).toBe(now);
    expect(result.revision).toBe(2);
  });
  it("sets first response once and preserves resolution time until a reopen", () => {
    const first = applyTicketEvent(ticket(), {
      type: "support_replied",
      actorId: "staff",
      occurredAt: now,
    });
    const later = "2026-11-01T11:00:00.000Z";
    expect(
      applyTicketEvent(first, {
        type: "support_replied",
        actorId: "staff",
        occurredAt: later,
      }).firstStaffRespondedAt,
    ).toBe(now);
    const resolved = applyTicketEvent(first, {
      type: "resolved",
      actorId: "staff",
      occurredAt: now,
    });
    expect(
      applyTicketEvent(resolved, {
        type: "resolved",
        actorId: "staff",
        occurredAt: later,
      }).resolvedAt,
    ).toBe(now);
    const reopened = applyTicketEvent(resolved, {
      type: "customer_replied",
      occurredAt: later,
    });
    expect(reopened.resolvedAt).toBeUndefined();
    expect(reopened.firstStaffRespondedAt).toBe(now);
  });
});
