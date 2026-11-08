import {
  applyTicketEvent,
  createTicket,
  type Ticket,
} from "../packages/core/src/index.js";
import { describe, expect, it } from "vitest";

const createdAt = "2026-11-08T12:00:00.000Z";
const firstAt = "2026-11-08T12:01:00.000Z";
const resolvedAt = "2026-11-08T12:02:00.000Z";
const closedAt = "2026-11-08T12:03:00.000Z";
const noticeAt = "2026-11-08T12:10:00.000Z";

function ticket(managed = false): Ticket {
  return createTicket({
    id: "followup-ticket",
    number: 17,
    subject: "Synthetic export failure",
    channel: "web",
    priority: "normal",
    requester: { association: "authenticated", principalId: "customer" },
    createdAt,
    ...(managed ? { initialHandling: "assistant" as const } : {}),
  });
}

function responded(): Ticket {
  return applyTicketEvent(ticket(true), {
    type: "support_replied",
    actorId: "staff",
    occurredAt: firstAt,
  });
}

function resolved(withStaffResponse: boolean): Ticket {
  return applyTicketEvent(withStaffResponse ? responded() : ticket(true), {
    type: "resolved",
    actorId: "staff",
    occurredAt: resolvedAt,
  });
}

const scenarios: readonly [string, () => Ticket][] = [
  ["legacy implicit human handling", () => ticket()],
  ["active assistant handling", () => ticket(true)],
  [
    "human-pending handling",
    () =>
      applyTicketEvent(ticket(true), {
        type: "human_requested",
        actorId: "customer",
        occurredAt: firstAt,
      }),
  ],
  [
    "human-active handling before a staff reply",
    () => {
      const current = ticket(true);
      return applyTicketEvent(current, {
        type: "human_taken_over",
        actorId: "staff",
        occurredAt: firstAt,
        expectedRevision: current.revision,
        expectedHandlingGeneration: current.handling!.generation,
      });
    },
  ],
  ["waiting on a customer", responded],
  ["resolved without a staff response", () => resolved(false)],
  ["resolved with a staff response", () => resolved(true)],
  [
    "closed without a staff response",
    () =>
      applyTicketEvent(resolved(false), {
        type: "closed",
        actorId: "staff",
        occurredAt: closedAt,
      }),
  ],
  [
    "closed with a staff response",
    () =>
      applyTicketEvent(resolved(true), {
        type: "closed",
        actorId: "staff",
        occurredAt: closedAt,
      }),
  ],
];

describe("informational customer notice Core transition", () => {
  it.each(scenarios)(
    "changes only revision and update timestamps for %s",
    (_name, build) => {
      const before = build();
      const original = structuredClone(before);
      const result = applyTicketEvent(before, {
        type: "customer_notice_added",
        actorId: "reviewing-staff",
        occurredAt: noticeAt,
      });
      expect(result).toStrictEqual({
        ...before,
        revision: before.revision + 1,
        updatedAt: noticeAt,
        customerUpdatedAt: noticeAt,
      });
      expect(before).toStrictEqual(original);
      expect(result.status).toBe(before.status);
      expect(result.handling).toEqual(before.handling);
      expect(Object.hasOwn(result, "handling")).toBe(
        Object.hasOwn(before, "handling"),
      );
      expect(result.resolvedAt).toBe(before.resolvedAt);
      expect(result.closedAt).toBe(before.closedAt);
      expect(result.firstStaffRespondedAt).toBe(before.firstStaffRespondedAt);
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.requester)).toBe(true);
      if (result.handling !== undefined)
        expect(Object.isFrozen(result.handling)).toBe(true);
    },
  );

  it("increments revision at the same timestamp without satisfying the first staff response milestone", () => {
    const before = ticket(true);
    const result = applyTicketEvent(before, {
      type: "customer_notice_added",
      actorId: "staff",
      occurredAt: createdAt,
    });
    expect(result.revision).toBe(before.revision + 1);
    expect(result.updatedAt).toBe(createdAt);
    expect(result.firstStaffRespondedAt).toBeUndefined();
    expect(result.handling).toEqual(before.handling);
  });

  it.each(["", "   "])("rejects an empty staff actor %j", (actorId) => {
    expect(() =>
      applyTicketEvent(ticket(), {
        type: "customer_notice_added",
        actorId,
        occurredAt: noticeAt,
      }),
    ).toThrow(TypeError);
  });

  it.each(["not-a-date", "2026-11-08", "2026-11-08T12:10:00Z"])(
    "retains the canonical timestamp validation for %s",
    (occurredAt) => {
      expect(() =>
        applyTicketEvent(ticket(), {
          type: "customer_notice_added",
          actorId: "staff",
          occurredAt,
        }),
      ).toThrow(TypeError);
    },
  );

  it("rejects a notice older than the current ticket without changing the terminal state", () => {
    const before = applyTicketEvent(resolved(true), {
      type: "closed",
      actorId: "staff",
      occurredAt: closedAt,
    });
    const original = structuredClone(before);
    expect(() =>
      applyTicketEvent(before, {
        type: "customer_notice_added",
        actorId: "staff",
        occurredAt: firstAt,
      }),
    ).toThrow(/earlier/);
    expect(before).toStrictEqual(original);
  });
});
