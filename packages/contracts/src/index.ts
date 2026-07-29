import type { IsoTimestamp, PrincipalId } from "@pegma/spine";

/**
 * Identity and time are ecosystem-wide, not Support Desk's to define.
 *
 * A principal resolved by `@pegma/authorization-core` has to be the same value
 * Support Desk stores on a ticket, authorizes a reply against, and writes into
 * an audit event. Declaring the type locally would make that agreement a
 * coincidence rather than something the compiler checks, so both come from
 * `@pegma/spine` and are re-exported here for convenience.
 */
export type { IsoTimestamp, PrincipalId };

export type TicketId = string;
export type MessageId = string;

export type TicketChannel = "web" | "email" | "api";
export type TicketPriority = "low" | "normal" | "high" | "urgent";
export type TicketStatus =
  "open" | "waiting_on_support" | "waiting_on_customer" | "resolved" | "closed";

/**
 * Describes how a requester was associated with an account.
 *
 * `matched_email` is useful for routing and context, but is explicitly not an
 * authenticated identity.
 */
export type RequesterAssociation =
  "authenticated" | "matched_email" | "unverified";

export interface TicketRequester {
  readonly association: RequesterAssociation;
  readonly principalId?: PrincipalId;
  readonly email?: string;
  readonly displayName?: string;
}

/** Current ticket state stored with optimistic-concurrency revision. */
export interface Ticket {
  readonly id: TicketId;
  readonly number: number;
  readonly revision: number;
  readonly subject: string;
  /**
   * Optional host-configured opaque label (for example `bug` or `feedback`).
   * Never establishes identity, permission, priority, or assignment.
   */
  readonly category?: string;
  readonly channel: TicketChannel;
  readonly status: TicketStatus;
  readonly priority: TicketPriority;
  readonly requester: TicketRequester;
  readonly assignedTo?: PrincipalId;
  readonly createdAt: IsoTimestamp;
  /** Staff-facing update time; advances on every accepted ticket change. */
  readonly updatedAt: IsoTimestamp;
  /**
   * Customer-visible update time. Advances for customer-visible messages and
   * lifecycle changes; notes, assignment, and priority leave it unchanged.
   */
  readonly customerUpdatedAt: IsoTimestamp;
  readonly resolvedAt?: IsoTimestamp;
  readonly closedAt?: IsoTimestamp;
}

export type MessageAuthorKind = "customer" | "staff" | "system";
export type MessageVisibility = "customer" | "internal";
export type MessageFormat = "plain_text" | "markdown";

/**
 * One canonical message in a ticket conversation.
 *
 * Mail adapters should convert and sanitize provider content before producing
 * this contract. Raw MIME payloads and unsafe HTML do not belong here.
 */
export interface TicketMessage {
  readonly id: MessageId;
  readonly ticketId: TicketId;
  readonly authorKind: MessageAuthorKind;
  readonly authorPrincipalId?: PrincipalId;
  readonly channel: TicketChannel;
  readonly visibility: MessageVisibility;
  readonly format: MessageFormat;
  readonly body: string;
  readonly createdAt: IsoTimestamp;
  readonly externalMessageId?: string;
  readonly inReplyToExternalMessageId?: string;
}

export interface CreateTicketInput {
  readonly id: TicketId;
  readonly number: number;
  readonly subject: string;
  readonly channel: TicketChannel;
  readonly priority?: TicketPriority;
  /** Optional host-validated opaque category; preserved for the ticket life. */
  readonly category?: string;
  readonly requester: TicketRequester;
  readonly createdAt: IsoTimestamp;
}

interface TicketEventBase {
  readonly occurredAt: IsoTimestamp;
}

export type TicketEvent =
  | (TicketEventBase & {
      readonly type: "customer_replied";
      readonly actorId?: PrincipalId;
    })
  | (TicketEventBase & {
      readonly type: "support_replied";
      readonly actorId: PrincipalId;
    })
  | (TicketEventBase & {
      readonly type: "note_added";
      readonly actorId: PrincipalId;
    })
  | (TicketEventBase & {
      readonly type: "resolved";
      readonly actorId: PrincipalId;
    })
  | (TicketEventBase & {
      readonly type: "closed";
      readonly actorId: PrincipalId;
    })
  | (TicketEventBase & {
      readonly type: "reopened";
      readonly actorId: PrincipalId;
    })
  | (TicketEventBase & {
      readonly type: "assigned";
      readonly actorId: PrincipalId;
      readonly assigneeId: PrincipalId | null;
    })
  | (TicketEventBase & {
      readonly type: "priority_changed";
      readonly actorId: PrincipalId;
      readonly priority: TicketPriority;
    });
