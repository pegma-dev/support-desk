import type {
  CreateTicketInput,
  IsoTimestamp,
  Ticket,
  TicketChannel,
  TicketEvent,
  TicketHandling,
  TicketHandlingState,
  TicketPriority,
  TicketRequester,
} from "@pegma/support-desk-contracts";

export {
  defineCannedResponse,
  defineCannedResponseCatalog,
  renderCannedResponse,
  snapshotCannedResponseSelection,
} from "./canned-responses.js";
export type {
  CannedResponseDefinition,
  CannedResponseSelection,
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
  TicketHandling,
  TicketHandlingState,
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

/** Display text only; never use the result as a path or blob key. */
export function normalizeAttachmentFilename(
  value: string,
  maximum = 120,
): string {
  if (
    typeof value !== "string" ||
    value.length > 4096 ||
    !Number.isSafeInteger(maximum) ||
    maximum < 1 ||
    maximum > 255
  )
    throw new TypeError("Invalid attachment filename bounds");
  return (
    value
      .replace(/[\ud800-\udfff]/gu, "_")
      .normalize("NFKC")
      .replace(
        /[\u0000-\u001f\u007f-\u009f/\\";:\u202a-\u202e\u2066-\u2069]/g,
        "_",
      )
      .trim()
      .replace(/^\.+/, "")
      .trim()
      .slice(0, maximum)
      .replace(/[\ud800-\udfff]/gu, "_") || "attachment".slice(0, maximum)
  );
}

const TICKET_CHANNELS: readonly TicketChannel[] = ["web", "email", "api"];
const TICKET_PRIORITIES: readonly TicketPriority[] = [
  "low",
  "normal",
  "high",
  "urgent",
];
const TICKET_HANDLING_STATES: readonly TicketHandlingState[] = [
  "assistant",
  "human-pending",
  "human-active",
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

/** Legacy omission remains human work; this does not modify the ticket. */
export function effectiveTicketHandling(
  ticket: Pick<Ticket, "handling">,
): TicketHandling {
  const handling = ticket.handling;
  if (handling === undefined)
    return Object.freeze({ state: "human-pending", generation: 0 });
  if (
    handling === null ||
    typeof handling !== "object" ||
    Array.isArray(handling)
  )
    throw new TypeError("ticket.handling must be a handling object");
  requireOneOf(handling.state, TICKET_HANDLING_STATES, "ticket.handling.state");
  if (!Number.isSafeInteger(handling.generation) || handling.generation < 1)
    throw new TypeError(
      "ticket.handling.generation must be a positive safe integer",
    );
  return Object.freeze({ ...handling });
}

function freezeTicket(ticket: Ticket): Ticket {
  return Object.freeze({
    ...ticket,
    ...(ticket.handling === undefined
      ? {}
      : { handling: effectiveTicketHandling(ticket) }),
    ...(ticket.tags === undefined
      ? {}
      : { tags: Object.freeze([...ticket.tags]) }),
    requester: Object.freeze({ ...ticket.requester }),
  });
}

function advanceHandling(
  ticket: Ticket,
  state: TicketHandlingState,
): TicketHandling {
  const current = effectiveTicketHandling(ticket);
  if (current.generation === Number.MAX_SAFE_INTEGER)
    throw new TicketWorkflowError("ticket handling generation is exhausted");
  return { state, generation: current.generation + 1 };
}

function requireHandlingFence(
  ticket: Ticket,
  event: {
    readonly expectedRevision: number;
    readonly expectedHandlingGeneration: number;
  },
): TicketHandling {
  if (
    !Number.isSafeInteger(event.expectedRevision) ||
    event.expectedRevision < 1
  )
    throw new TypeError(
      "event.expectedRevision must be a positive safe integer",
    );
  if (
    !Number.isSafeInteger(event.expectedHandlingGeneration) ||
    event.expectedHandlingGeneration < 0
  )
    throw new TypeError(
      "event.expectedHandlingGeneration must be a nonnegative safe integer",
    );
  const handling = effectiveTicketHandling(ticket);
  if (
    ticket.revision !== event.expectedRevision ||
    handling.generation !== event.expectedHandlingGeneration
  )
    throw new TicketWorkflowError(
      "ticket revision or handling generation changed",
    );
  return handling;
}

function requireActiveAssistant(
  ticket: Ticket,
  handling: TicketHandling,
): void {
  if (
    handling.state !== "assistant" ||
    ticket.channel !== "web" ||
    ticket.status === "resolved" ||
    ticket.status === "closed"
  )
    throw new TicketWorkflowError(
      "assistant output requires an active assistant web ticket",
    );
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
  if (input.relatedTicketId !== undefined) {
    requireText(input.relatedTicketId, "relatedTicketId");
    if (input.relatedTicketId === input.id) {
      throw new TypeError("relatedTicketId must name a different ticket");
    }
  }
  if (input.initialHandling !== undefined) {
    if (input.initialHandling !== "assistant")
      throw new TypeError("initialHandling must be assistant when supplied");
    if (input.channel !== "web")
      throw new TicketWorkflowError(
        "assistant handling is available only for web tickets",
      );
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
    ...(input.initialHandling === undefined
      ? {}
      : { handling: { state: "assistant" as const, generation: 1 } }),
    ...(input.relatedTicketId === undefined
      ? {}
      : { relatedTicketId: input.relatedTicketId }),
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
    case "customer_replied": {
      if (event.channel !== undefined)
        requireOneOf(event.channel, TICKET_CHANNELS, "event.channel");
      const handling = effectiveTicketHandling(ticket);
      return freezeTicket({
        ...activeTicket(ticket),
        ...nextRevision(ticket, event.occurredAt, { customerVisible: true }),
        status: "waiting_on_support",
        ...(ticket.handling === undefined
          ? {}
          : {
              handling: advanceHandling(
                ticket,
                handling.state === "assistant" &&
                  event.channel !== undefined &&
                  event.channel !== "web"
                  ? "human-pending"
                  : handling.state,
              ),
            }),
      });
    }

    case "support_replied":
      return freezeTicket({
        ...activeTicket(ticket),
        ...nextRevision(ticket, event.occurredAt, { customerVisible: true }),
        status: "waiting_on_customer",
        firstStaffRespondedAt: ticket.firstStaffRespondedAt ?? event.occurredAt,
        ...(ticket.handling === undefined
          ? {}
          : { handling: advanceHandling(ticket, "human-active") }),
      });

    case "customer_notice_added":
      return freezeTicket({
        ...ticket,
        ...nextRevision(ticket, event.occurredAt, { customerVisible: true }),
      });

    case "assistant_replied": {
      const handling = requireHandlingFence(ticket, event);
      requireActiveAssistant(ticket, handling);
      return freezeTicket({
        ...ticket,
        ...nextRevision(ticket, event.occurredAt, { customerVisible: true }),
        status: "waiting_on_customer",
        handling: advanceHandling(ticket, "assistant"),
      });
    }

    case "human_requested": {
      const handling = effectiveTicketHandling(ticket);
      const revision = nextRevision(ticket, event.occurredAt, {
        customerVisible: true,
      });
      if (
        handling.state !== "assistant" &&
        ticket.status !== "resolved" &&
        ticket.status !== "closed"
      )
        return freezeTicket(ticket);
      return freezeTicket({
        ...activeTicket(ticket),
        ...revision,
        status: "waiting_on_support",
        ...(ticket.handling === undefined
          ? {}
          : { handling: advanceHandling(ticket, "human-pending") }),
      });
    }

    case "human_escalated": {
      const handling = requireHandlingFence(ticket, event);
      requireActiveAssistant(ticket, handling);
      return freezeTicket({
        ...ticket,
        ...nextRevision(ticket, event.occurredAt, { customerVisible: true }),
        status: "waiting_on_support",
        handling: advanceHandling(ticket, "human-pending"),
      });
    }

    case "human_taken_over": {
      const handling = requireHandlingFence(ticket, event);
      if (ticket.status === "resolved" || ticket.status === "closed")
        throw new TicketWorkflowError(
          "terminal ticket must be reopened before takeover",
        );
      const revision = nextRevision(ticket, event.occurredAt, {
        customerVisible: true,
      });
      if (handling.state === "human-active") return freezeTicket(ticket);
      return freezeTicket({
        ...ticket,
        ...revision,
        handling: advanceHandling(ticket, "human-active"),
      });
    }

    case "note_added":
      return freezeTicket({
        ...ticket,
        ...nextRevision(ticket, event.occurredAt, { customerVisible: false }),
      });

    case "resolved":
    case "customer_success_confirmed":
      if (ticket.status === "closed") {
        throw new TicketWorkflowError(
          "closed ticket must be reopened before it can be resolved",
        );
      }
      return freezeTicket({
        ...activeTicket(ticket),
        ...nextRevision(ticket, event.occurredAt, { customerVisible: true }),
        status: "resolved",
        resolvedAt:
          ticket.status === "resolved"
            ? (ticket.resolvedAt ?? event.occurredAt)
            : event.occurredAt,
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
        ...(ticket.handling === undefined
          ? {}
          : { handling: advanceHandling(ticket, "human-pending") }),
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

    case "tags_changed": {
      if (
        !Array.isArray(event.tags) ||
        event.tags.length > 32 ||
        Array.from(event.tags).some(
          (tag) =>
            typeof tag !== "string" || !/^[a-z][a-z0-9_]{0,31}$/.test(tag),
        ) ||
        new Set(event.tags).size !== event.tags.length
      ) {
        throw new TypeError(
          "event.tags must contain at most 32 unique safe identifiers",
        );
      }
      return freezeTicket({
        ...ticket,
        ...nextRevision(ticket, event.occurredAt, { customerVisible: false }),
        tags: event.tags,
      });
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
