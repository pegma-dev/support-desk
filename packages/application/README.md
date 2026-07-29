# @pegma/support-desk-application

Authorized customer ticket services and provider-neutral durable outbox
records for Support Desk. The host supplies an `@pegma/storage-core` `Store`
and a trusted Authorization Core access context.

Customer create uses `support.ticket.create`; list and read both use the
documented `support.ticket.read.own` permission and then confirm authoritative
ownership; reply uses `support.ticket.reply.own`.

Customer create, list, read, and reply return explicit safe DTOs
(`CustomerTicketSummary` / `CustomerMessage` / `CustomerTicketView`), not the
authoritative `Ticket` or `TicketMessage`. Summaries include id, number,
subject, optional category, status, channel, `createdAt`, and
`customerUpdatedAt`. They omit requester evidence, priority, assignee,
staff-facing `updatedAt`, revision, audit history, and delivery state.
Customer messages omit principal IDs and provider threading metadata. List
order uses `customerUpdatedAt`.

Hosts pass a frozen, deduplicated `allowedCategories` option (at most 32
values matching `^[a-z][a-z0-9_]{0,31}$`). A supplied create category must be
on that allowlist; category never changes authorization or initial priority
and is part of the create idempotency fingerprint. Category is preserved for
the ticket life.

`customerUpdatedAt` advances on create and on customer-visible messages or
lifecycle changes. Internal notes, assignment, and priority changes advance
only staff-facing `updatedAt` (in core workflow events).

Accepted-change history is exact `@pegma/audit@0.1.0` projected into the
ticket partition with `defineAudit`. Create and reply drop Audit transaction
actions beside the state change; history is read through Audit, not a private
sorter. Domain `TicketEvent` remains pure workflow input and is not stored as
a second audit shape. Authorization Core is exact `0.1.2`.

Create and reply commands are snapshotted from own data properties exactly
once before validation, idempotency fingerprinting, or persistence. Accessors
are rejected without being executed. Optional requester email is a contact
snapshot, never an identity key: surrounding whitespace is removed, the DNS
domain is lowercased, and plain-address syntax, controls, markup, and a
254-character maximum are enforced.
Pruning and receipt-retention inputs use the same rule. Partition keys and
cutoffs therefore cannot change between a read and its conditional write or
delete.
Outbound `Message-ID` values must be at most 254 ASCII characters with a
dot-atom local part, a valid DNS domain, and no controls or malformed dots.

Outbound state is the application projection of published exact
`@pegma/mail@0.1.0`. Support Desk keeps its `delivery:*` physical record and
stores immutable template, subject, and `Message-ID` content on the causal
message in the same transaction. The generic package owns claims, provider
idempotency, submission generations, retry/reconciliation transitions,
terminal acknowledgement, authoritative collection-wide scans, and sweeping.
Hosts resolve a job's `contentRef` from the message record and keep send,
reconciliation, and terminal-sweep scan cursors separate.

This package implements persistence coordination, not persistence. It has no
provider SDK and no role, plan, or entitlement model.

Delivery callback recording also requires the host `Clock`: provider
`occurredAt` remains event data, while receipt retention and the enforced
30-day deduplication horizon use trusted host processing time. Every callback
also carries the provider submission generation before it is delegated to
`@pegma/mail`, fencing delayed events from newer submissions.
Reply timestamps are sampled and validated on every transaction attempt, then
clamped to the stored ticket's `updatedAt` so clock skew cannot move a
conversation backward.

Inbound processing remains a future phase, but its declared receipt collection
is already hard-bounded to 256 hash slots per partition. Terminal receipt
retention uses trusted processing time, a 30-day deduplication horizon, and
version-conditional deletion; in-flight receipts are never swept.
