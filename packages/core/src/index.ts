import type {
  CreateTicketInput,
  IsoTimestamp,
  Ticket,
  TicketChannel,
  TicketEvent,
  TicketPriority,
  TicketRequester,
} from "@pegma/support-desk-contracts";

export type {
  CreateTicketInput,
  IsoTimestamp,
  MessageAuthorKind,
  MessageFormat,
  MessageId,
  MessageVisibility,
  PrincipalId,
  RequesterAssociation,
  Ticket,
  TicketChannel,
  TicketEvent,
  TicketId,
  TicketMessage,
  TicketPriority,
  TicketRequester,
  TicketStatus,
} from "@pegma/support-desk-contracts";

export class TicketWorkflowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TicketWorkflowError";
  }
}

const TICKET_CHANNELS: readonly TicketChannel[] = ["web", "email", "api"];
const TICKET_PRIORITIES: readonly TicketPriority[] = [
  "low",
  "normal",
  "high",
  "urgent",
];

function requireText(value: unknown, field: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
}

function requireOneOf<T extends string>(
  value: T,
  allowed: readonly T[],
  field: string,
): void {
  if (!allowed.includes(value)) {
    throw new TypeError(`${field} must be one of: ${allowed.join(", ")}`);
  }
}

function timestamp(value: IsoTimestamp, field: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new TypeError(`${field} must be a valid canonical ISO timestamp`);
  }
  return parsed;
}

function validateRequester(requester: TicketRequester): void {
  if (requester.principalId !== undefined) {
    requireText(requester.principalId, "requester.principalId");
  }
  if (requester.email !== undefined) {
    requireText(requester.email, "requester.email");
  }

  if (
    requester.association === "authenticated" &&
    requester.principalId === undefined
  ) {
    throw new TypeError(
      "authenticated requester must include requester.principalId",
    );
  }

  if (
    requester.association === "matched_email" &&
    (requester.principalId === undefined || requester.email === undefined)
  ) {
    throw new TypeError(
      "matched_email requester must include principalId and email",
    );
  }

  if (requester.association === "unverified" && requester.email === undefined) {
    throw new TypeError("unverified requester must include requester.email");
  }

  if (
    requester.association === "unverified" &&
    requester.principalId !== undefined
  ) {
    throw new TypeError(
      "unverified requester must not include requester.principalId",
    );
  }
}

function activeTicket(ticket: Ticket): Omit<Ticket, "resolvedAt" | "closedAt"> {
  const { resolvedAt: _resolvedAt, closedAt: _closedAt, ...active } = ticket;
  return active;
}

function freezeTicket(ticket: Ticket): Ticket {
  return Object.freeze({
    ...ticket,
    requester: Object.freeze({ ...ticket.requester }),
  });
}

function nextRevision(
  ticket: Ticket,
  occurredAt: IsoTimestamp,
  options: { readonly customerVisible: boolean },
): Pick<Ticket, "revision" | "updatedAt" | "customerUpdatedAt"> {
  const eventTime = timestamp(occurredAt, "event.occurredAt");
  const currentTime = timestamp(ticket.updatedAt, "ticket.updatedAt");

  if (eventTime < currentTime) {
    throw new TicketWorkflowError(
      "event.occurredAt must not be earlier than ticket.updatedAt",
    );
  }

  return {
    revision: ticket.revision + 1,
    updatedAt: occurredAt,
    customerUpdatedAt: options.customerVisible
      ? occurredAt
      : ticket.customerUpdatedAt,
  };
}

/** Create an open ticket from host-supplied identifiers and requester facts. */
export function createTicket(input: CreateTicketInput): Ticket {
  requireText(input.id, "id");
  requireText(input.subject, "subject");
  requireOneOf(input.channel, TICKET_CHANNELS, "channel");
  if (input.priority !== undefined) {
    requireOneOf(input.priority, TICKET_PRIORITIES, "priority");
  }
  if (input.category !== undefined) {
    requireText(input.category, "category");
  }
  timestamp(input.createdAt, "createdAt");
  validateRequester(input.requester);

  if (!Number.isSafeInteger(input.number) || input.number <= 0) {
    throw new TypeError("number must be a positive safe integer");
  }

  return freezeTicket({
    id: input.id,
    number: input.number,
    revision: 1,
    subject: input.subject,
    ...(input.category === undefined ? {} : { category: input.category }),
    channel: input.channel,
    status: "open",
    priority: input.priority ?? "normal",
    requester: input.requester,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    customerUpdatedAt: input.createdAt,
  });
}

/**
 * Apply one already-authorized, deduplicated event to current ticket state.
 *
 * Persistence layers should use `revision` for optimistic concurrency and
 * record the event in an append-only audit log.
 *
 * `revision` is the concurrency authority. As an additional audit-ordering
 * guard, an event whose `occurredAt` is earlier than `ticket.updatedAt` is
 * rejected, so hosts must generate `occurredAt` from a trusted server clock
 * and keep it monotonic per ticket — for example by clamping to the stored
 * `updatedAt` — rather than relying on synchronized clocks across servers.
 */
export function applyTicketEvent(ticket: Ticket, event: TicketEvent): Ticket {
  if (event.type === "customer_replied") {
    if (event.actorId !== undefined) {
      requireText(event.actorId, "event.actorId");
    }
  } else {
    requireText(event.actorId, "event.actorId");
  }

  switch (event.type) {
    case "customer_replied":
      return freezeTicket({
        ...activeTicket(ticket),
        ...nextRevision(ticket, event.occurredAt, { customerVisible: true }),
        status: "waiting_on_support",
      });

    case "support_replied":
      return freezeTicket({
        ...activeTicket(ticket),
        ...nextRevision(ticket, event.occurredAt, { customerVisible: true }),
        status: "waiting_on_customer",
      });

    case "note_added":
      return freezeTicket({
        ...ticket,
        ...nextRevision(ticket, event.occurredAt, { customerVisible: false }),
      });

    case "resolved":
      if (ticket.status === "closed") {
        throw new TicketWorkflowError(
          "closed ticket must be reopened before it can be resolved",
        );
      }
      return freezeTicket({
        ...activeTicket(ticket),
        ...nextRevision(ticket, event.occurredAt, { customerVisible: true }),
        status: "resolved",
        resolvedAt: event.occurredAt,
      });

    case "closed":
      if (ticket.status !== "resolved") {
        throw new TicketWorkflowError("only a resolved ticket can be closed");
      }
      return freezeTicket({
        ...ticket,
        ...nextRevision(ticket, event.occurredAt, { customerVisible: true }),
        status: "closed",
        closedAt: event.occurredAt,
      });

    case "reopened":
      if (ticket.status !== "resolved" && ticket.status !== "closed") {
        throw new TicketWorkflowError(
          "only a resolved or closed ticket can be reopened",
        );
      }
      return freezeTicket({
        ...activeTicket(ticket),
        ...nextRevision(ticket, event.occurredAt, { customerVisible: true }),
        status: "waiting_on_support",
      });

    case "assigned": {
      if (event.assigneeId !== null) {
        requireText(event.assigneeId, "event.assigneeId");
      }
      const revision = nextRevision(ticket, event.occurredAt, {
        customerVisible: false,
      });
      const { assignedTo: _assignedTo, ...unassigned } = ticket;
      return freezeTicket(
        event.assigneeId === null
          ? { ...unassigned, ...revision }
          : { ...unassigned, ...revision, assignedTo: event.assigneeId },
      );
    }

    case "priority_changed":
      requireOneOf(event.priority, TICKET_PRIORITIES, "event.priority");
      return freezeTicket({
        ...ticket,
        ...nextRevision(ticket, event.occurredAt, { customerVisible: false }),
        priority: event.priority,
      });

    default:
      throw new TicketWorkflowError(
        `unsupported ticket event type: ${String(
          (event as { readonly type?: unknown }).type,
        )}`,
      );
  }
}
