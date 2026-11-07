import { describe, expect, it } from "vitest";

import {
  applyTicketEvent,
  createTicket,
  effectiveTicketHandling,
  TicketWorkflowError,
  type Ticket,
  type TicketEvent,
} from "./index.js";

const now = "2026-11-07T10:00:00.000Z";
const later = "2026-11-07T10:05:00.000Z";

function ticket(assistant = false): Ticket {
  return createTicket({
    id: "ticket",
    number: 1,
    subject: "Help with export",
    channel: "web",
    requester: { association: "authenticated", principalId: "customer" },
    createdAt: now,
    ...(assistant ? { initialHandling: "assistant" as const } : {}),
  });
}

function fenced(
  current: Ticket,
  type: "assistant_replied" | "human_escalated" | "human_taken_over",
): TicketEvent {
  return {
    type,
    actorId: type === "human_taken_over" ? "staff" : "assistant-service",
    occurredAt: later,
    expectedRevision: current.revision,
    expectedHandlingGeneration: effectiveTicketHandling(current).generation,
  };
}

describe("ticket handling", () => {
  it("keeps legacy human handling implicit through existing transitions", () => {
    const legacy = ticket();
    expect(effectiveTicketHandling(legacy)).toEqual({
      state: "human-pending",
      generation: 0,
    });
    expect(Object.hasOwn(legacy, "handling")).toBe(false);
    for (const event of [
      { type: "customer_replied", actorId: "customer", occurredAt: later },
      { type: "support_replied", actorId: "staff", occurredAt: later },
      { type: "note_added", actorId: "staff", occurredAt: later },
    ] as const) {
      expect(Object.hasOwn(applyTicketEvent(legacy, event), "handling")).toBe(
        false,
      );
    }
  });

  it("starts explicit assistant handling only with web host opt-in", () => {
    const created = ticket(true);
    expect(created.handling).toEqual({ state: "assistant", generation: 1 });
    expect(Object.isFrozen(created.handling)).toBe(true);
    for (const channel of ["email", "api"] as const) {
      expect(() =>
        createTicket({
          id: "other",
          number: 2,
          subject: "Help",
          channel,
          requester: { association: "authenticated", principalId: "customer" },
          createdAt: now,
          initialHandling: "assistant",
        }),
      ).toThrow(/web/);
    }
    expect(() =>
      createTicket({
        id: "other",
        number: 2,
        subject: "Help",
        channel: "web",
        requester: { association: "authenticated", principalId: "customer" },
        createdAt: now,
        initialHandling: "human-active" as never,
      }),
    ).toThrow(TypeError);
  });

  it("attributes an assistant transition without satisfying the staff milestone", () => {
    const created = ticket(true);
    const replied = applyTicketEvent(
      created,
      fenced(created, "assistant_replied"),
    );
    expect(replied).toMatchObject({
      status: "waiting_on_customer",
      revision: 2,
      handling: { state: "assistant", generation: 2 },
      customerUpdatedAt: later,
    });
    expect(replied.firstStaffRespondedAt).toBeUndefined();
    const human = applyTicketEvent(replied, {
      type: "support_replied",
      actorId: "staff",
      occurredAt: later,
    });
    expect(human.firstStaffRespondedAt).toBe(later);
    expect(human.handling).toEqual({ state: "human-active", generation: 3 });
  });

  it.each([
    "assistant_replied",
    "human_escalated",
    "human_taken_over",
  ] as const)("requires both exact causal fences for %s", (type) => {
    const created = ticket(true);
    for (const overrides of [
      { expectedRevision: 0 },
      { expectedRevision: created.revision + 1 },
      { expectedHandlingGeneration: 0 },
      { expectedHandlingGeneration: 2 },
      { expectedHandlingGeneration: undefined },
    ]) {
      expect(() =>
        applyTicketEvent(created, {
          ...fenced(created, type),
          ...overrides,
        } as never),
      ).toThrow();
    }
  });

  it("a newer customer reply invalidates a pending completion", () => {
    const created = ticket(true);
    const pending = fenced(created, "assistant_replied");
    const newer = applyTicketEvent(created, {
      type: "customer_replied",
      actorId: "customer",
      channel: "web",
      occurredAt: later,
    });
    expect(newer.handling).toEqual({ state: "assistant", generation: 2 });
    expect(() => applyTicketEvent(newer, pending)).toThrow(TicketWorkflowError);
  });

  it.each(["email", "api"] as const)(
    "moves an assistant conversation to humans for a trusted %s reply",
    (channel) => {
      const created = ticket(true);
      const newer = applyTicketEvent(created, {
        type: "customer_replied",
        channel,
        occurredAt: later,
      });
      expect(newer.handling).toEqual({ state: "human-pending", generation: 2 });
      expect(newer.status).toBe("waiting_on_support");
      expect(() =>
        applyTicketEvent(newer, fenced(newer, "assistant_replied")),
      ).toThrow(TicketWorkflowError);
    },
  );

  it("private notes invalidate exact revision without changing handling or public time", () => {
    const created = ticket(true);
    const noted = applyTicketEvent(created, {
      type: "note_added",
      actorId: "staff",
      occurredAt: later,
    });
    expect(noted.handling).toEqual(created.handling);
    expect(noted.customerUpdatedAt).toBe(now);
    expect(() =>
      applyTicketEvent(noted, fenced(created, "assistant_replied")),
    ).toThrow(TicketWorkflowError);
  });

  it("requesting a person fences the assistant and repeated human requests are no-ops", () => {
    const created = ticket(true);
    const pending = applyTicketEvent(created, {
      type: "human_requested",
      actorId: "customer",
      occurredAt: later,
    });
    expect(pending).toMatchObject({
      status: "waiting_on_support",
      revision: 2,
      handling: { state: "human-pending", generation: 2 },
    });
    expect(() =>
      applyTicketEvent(pending, fenced(created, "assistant_replied")),
    ).toThrow(TicketWorkflowError);
    expect(
      applyTicketEvent(pending, {
        type: "human_requested",
        actorId: "customer",
        occurredAt: later,
      }),
    ).toEqual(pending);
    expect(
      applyTicketEvent(ticket(), {
        type: "human_requested",
        actorId: "customer",
        occurredAt: later,
      }).revision,
    ).toBe(1);
  });

  it("customer request-person reopens terminal work without enabling an assistant", () => {
    for (const assistant of [false, true]) {
      const resolved = applyTicketEvent(ticket(assistant), {
        type: "resolved",
        actorId: "staff",
        occurredAt: later,
      });
      const closed = applyTicketEvent(resolved, {
        type: "closed",
        actorId: "staff",
        occurredAt: later,
      });
      const requested = applyTicketEvent(closed, {
        type: "human_requested",
        actorId: "customer",
        occurredAt: later,
      });
      expect(requested.status).toBe("waiting_on_support");
      expect(effectiveTicketHandling(requested).state).toBe("human-pending");
      expect(requested.resolvedAt).toBeUndefined();
      expect(requested.closedAt).toBeUndefined();
      if (!assistant) expect(Object.hasOwn(requested, "handling")).toBe(false);
    }
  });

  it("staff reopen returns explicit handling to the human queue without rewriting legacy tickets", () => {
    const assistant = ticket(true);
    const activeHuman = applyTicketEvent(assistant, {
      type: "support_replied",
      actorId: "staff",
      occurredAt: later,
    });
    for (const current of [ticket(), assistant, activeHuman]) {
      const resolved = applyTicketEvent(current, {
        type: "resolved",
        actorId: "staff",
        occurredAt: later,
      });
      const reopened = applyTicketEvent(resolved, {
        type: "reopened",
        actorId: "staff",
        occurredAt: later,
      });
      expect(effectiveTicketHandling(reopened).state).toBe("human-pending");
      expect(reopened.status).toBe("waiting_on_support");
      if (current.handling === undefined) {
        expect(Object.hasOwn(reopened, "handling")).toBe(false);
      } else {
        expect(reopened.handling?.generation).toBe(
          current.handling.generation + 1,
        );
      }
    }
  });

  it("escalates with an exact assistant fence and takes over without claiming a staff reply", () => {
    const created = ticket(true);
    const pending = applyTicketEvent(
      created,
      fenced(created, "human_escalated"),
    );
    expect(pending.handling).toEqual({ state: "human-pending", generation: 2 });
    const taken = applyTicketEvent(
      pending,
      fenced(pending, "human_taken_over"),
    );
    expect(taken.handling).toEqual({ state: "human-active", generation: 3 });
    expect(taken.firstStaffRespondedAt).toBeUndefined();
    expect(() =>
      applyTicketEvent(taken, fenced(taken, "assistant_replied")),
    ).toThrow(TicketWorkflowError);
    expect(
      applyTicketEvent(ticket(), fenced(ticket(), "human_taken_over")).handling,
    ).toEqual({ state: "human-active", generation: 1 });
  });

  it.each(["assistant_replied", "human_escalated"] as const)(
    "rejects %s on a terminal assistant ticket",
    (type) => {
      const resolved = applyTicketEvent(ticket(true), {
        type: "resolved",
        actorId: "staff",
        occurredAt: later,
      });
      expect(() => applyTicketEvent(resolved, fenced(resolved, type))).toThrow(
        TicketWorkflowError,
      );
    },
  );

  it("customer confirmation resolves explicitly without becoming a staff response", () => {
    const confirmed = applyTicketEvent(ticket(true), {
      type: "customer_success_confirmed",
      actorId: "customer",
      occurredAt: later,
    });
    expect(confirmed.status).toBe("resolved");
    expect(confirmed.resolvedAt).toBe(later);
    expect(confirmed.firstStaffRespondedAt).toBeUndefined();
    const closed = applyTicketEvent(confirmed, {
      type: "closed",
      actorId: "staff",
      occurredAt: later,
    });
    expect(() =>
      applyTicketEvent(closed, {
        type: "customer_success_confirmed",
        actorId: "customer",
        occurredAt: later,
      }),
    ).toThrow(/reopened/);
  });

  it("clones nested handling and rejects malformed persisted generations", () => {
    const mutable = {
      ...ticket(true),
      handling: { state: "assistant" as const, generation: 1 },
    };
    const noted = applyTicketEvent(mutable, {
      type: "note_added",
      actorId: "staff",
      occurredAt: later,
    });
    mutable.handling.generation = 10;
    expect(noted.handling).toEqual({ state: "assistant", generation: 1 });
    expect(Object.isFrozen(noted.handling)).toBe(true);
    for (const generation of [0, -1, 1.5, Number.NaN]) {
      expect(() =>
        effectiveTicketHandling({
          handling: { state: "assistant", generation },
        }),
      ).toThrow(TypeError);
    }
  });
});
