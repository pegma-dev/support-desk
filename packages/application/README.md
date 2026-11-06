# @pegma/support-desk-application

Authorized customer ticket services and provider-neutral durable outbox
records for Support Desk. The host supplies an `@pegma/storage-core` `Store`
and a trusted Authorization Core access context.

Customer create uses `support.ticket.create`; list and read both use the
documented `support.ticket.read.own` permission and then confirm authoritative
ownership; reply uses `support.ticket.reply.own`.

Staff services use the same application factory and ticket partition:

| Method                   | Permission(s)                                     | Effect                                                              |
| ------------------------ | ------------------------------------------------- | ------------------------------------------------------------------- |
| `readStaffTicket`        | `support.queue.read`                              | Authoritative ticket plus every message (including internal notes)  |
| `listStaffQueue`         | `support.queue.read`                              | Bounded projection scan; confirm each row; filter/sort in memory    |
| `queueProjectionHealth`  | (none; process-local)                             | Consecutive projection failures and last failure metadata           |
| `replyAsStaff`           | `support.queue.read` + `support.ticket.reply.any` | Customer-visible staff reply → `waiting_on_customer`; optional mail |
| `addNote`                | `support.queue.read` + `support.ticket.note`      | Internal note; no mail; status and `customerUpdatedAt` unchanged    |
| `assignTicket`           | `support.queue.read` + `support.ticket.assign`    | Assign or unassign; status unchanged                                |
| `changePriority`         | `support.queue.read` + `support.ticket.manage`    | Priority only; status unchanged                                     |
| `resolveTicket`          | `support.queue.read` + `support.ticket.manage`    | → `resolved` (closed tickets must reopen first)                     |
| `closeTicket`            | `support.queue.read` + `support.ticket.manage`    | → `closed` (resolved only)                                          |
| `reopenTicket`           | `support.queue.read` + `support.ticket.manage`    | resolved/closed → `waiting_on_support`                              |
| `setTags`                | `support.queue.read` + `support.ticket.manage`    | Replace staff tags; status, customer time, and mail unchanged       |
| `readTicketAuditHistory` | `support.audit.read`                              | Ordered Audit history for one ticket                                |

### Optional lifecycle extras

`setTags` requires queue read plus `support.ticket.manage`. Configure
`allowedTags` (at most 32 raw entries, normalized, deduplicated, sorted) and
`maxTagsPerTicket` (default 8, maximum 32). Tags follow the category identifier
discipline after trimming and lowercasing; each raw label is at most 64
characters with no controls. `[]` clears tags. This command updates staff time
and revision only, with an atomic `support.ticket.tags_changed` audit action
and receipt, and no messages or mail. Queue query `tag` matches one label.

Pass optional `responseTargetPolicy: { computeTargets(context) }` to both
`createSupportDeskApplication` and `createInboundMailProcessor`. The host
returns canonical ISO `firstResponseDueAt` / `resolutionDueAt` fields as a
complete replacement on create, customer follow-up (web/email), and priority
changes. Omitted result fields clear targets; absent policy preserves them.
The frozen context is content-free and hooks must tolerate retries. First
public staff reply sets `firstStaffRespondedAt` once. `resolvedAt` describes
the current resolution cycle; reopen/reply clears it and re-resolution sets
it again. Calendars, business hours, and presence remain host responsibilities.

Queue queries select `target: "first_response" | "resolution"` (resolution
by default), `targetState: "overdue" | "due_soon"`, and the latter's required
`dueSoonMilliseconds` (0 to 30 days, rejected otherwise). Sort by `due_soonest` or `due_latest`,
with completed/missing targets last and ticket ID tie-breaking. All values
come from authoritative confirmation within existing scan budgets. Tags,
targets, and milestones stay out of customer DTOs and automatic customer mail.

Every staff mutation accepts optional `expectedRevision`. A mismatch fails
before ticket changes with `SupportDeskStaleRevisionError`, exposing only
`currentRevision` and `updatedAt` for HTTP 409. Omission retains existing
conflict retries. Replay detection precedes revision checking; new receipts
return the original result using a ticket snapshot and message revision cutoff.
Legacy receipts retain current-detail replay. Run queue repair after upgrade
to enrich old rows; no automatic target or historical milestone backfill runs.
See [host composition](../../docs/HOST_COMPOSITION.md#optional-lifecycle-extras-task-13)
for complete retry, lifecycle, and HTTP semantics.

### Staff queue projection

`support-desk.queue-index.v1` holds one projection row per ticket (partition =
ticket ID, id = `queue`). After every successful ticket-changing command the
application calls `projectTicketToQueue`, which reloads the authoritative
ticket and writes a revision-fenced row. Projection failure is logged and
reflected in `queueProjectionHealth`; it never rolls back the committed
command.

Online `listStaffQueue` starts at a null cursor, scans the projection for one
complete cycle with request-local cursors only, confirms every candidate
against the ticket, then filters and sorts in memory. Separate budgets
(`queueScanBudgets`: physical rows, pages, active results) fail closed with
`SupportDeskQueueCapacityError` and no partial result. Hosts schedule
`repairQueueProjectionPage` (authoritative `support-desk.records.v1` ticket
scan; persist cursor after each complete page) and
`sweepInactiveQueueProjections` (reload ticket, then `deleteIfUnchanged` when
still terminal beyond the shared cutoff). Both workers require an explicit
`terminalRetentionMilliseconds` — hosts must pass the same value configured on
the application so projection, repair, and sweep share one cutoff. The
projection is never ownership or permission evidence.

Staff reads return `StaffTicketView` (full `Ticket` and all `TicketMessage`
rows). Mutations that return that view also require `support.queue.read` so a
narrow write permission cannot bypass the staff-detail boundary. They do not
require queue membership claims or browser-supplied actor IDs—only an
`AccessContext` and the authoritative ticket id. Unknown ticket IDs throw the
same content-free not-found error used for customer ownership misses. A staff
reply to a closed ticket moves it directly to `waiting_on_customer` without a
separate reopen event (MVP lifecycle rule). Lifecycle commands may include an
optional customer-visible system message and notification so resolution mail
commits in the same ticket transaction as the status change. Partition reads
and mutations also enforce `limits.maxRecordsPerTicket` (default 512).

Customer create, list, read, and reply return explicit safe DTOs
(`CustomerTicketSummary` / `CustomerMessage` / `CustomerTicketView`), not the
authoritative `Ticket` or `TicketMessage`. Summaries include id, number,
subject, optional category, status, channel, `createdAt`, and
`customerUpdatedAt`. They omit requester evidence, priority, assignee,
staff-facing `updatedAt`, revision, audit history, and delivery state.
Customer messages omit principal IDs and provider threading metadata. List
order uses `customerUpdatedAt`. Internal notes never appear in customer views
or customer-visible notification content.

Hosts pass a frozen, deduplicated `allowedCategories` option (at most 32
values matching `^[a-z][a-z0-9_]{0,31}$`). A supplied create category must be
on that allowlist; category never changes authorization or initial priority
and is part of the create idempotency fingerprint. Category is preserved for
the ticket life.

Ticket numbers are reserved by the application from
`support-desk.ticket-numbers.v1` (`instance` / `ticket-number`) before create.
Controllers supply server-minted ticket and command IDs but not ticket numbers.
Replay returns the committed number without reserving another; gaps after a
failed create are accepted; exhaustion fails closed before ticket persistence.
When a create includes a notification, Support Desk sets the
`ticket_number` variable to the reserved number and substitutes
`{{ticket_number}}` in the notification subject.

`customerUpdatedAt` advances on create and on customer-visible messages or
lifecycle changes. Internal notes, assignment, and priority changes advance
only staff-facing `updatedAt` (in core workflow events).

Accepted-change history is exact `@pegma/audit@0.1.0` projected into the
ticket partition with `defineAudit`. Customer create/reply and every staff
mutation drop Audit transaction actions beside the state change; history is
read through `readTicketAuditHistory` / Audit, not a private sorter. Domain
`TicketEvent` remains pure workflow input and is not stored as a second audit
shape. Authorization Core is exact `0.1.2`.

Customer and staff commands are snapshotted from own data properties exactly
once before validation, idempotency fingerprinting, or persistence. Accessors
are rejected without being executed. Each mutation uses a server-minted
command ID, a SHA-256 request fingerprint, bounded conflict retry, and
trusted ticket time clamped so it never moves backward. Optional requester email is a contact
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

### Inbound mail

`createInboundMailProcessor({ store, clock, accountMatcher, routingPolicy,
notificationPolicy?, subjectMarkerPrefix?, supportAddresses?, ... })` returns
`processInboundEmail(input)`. The host calls it only after verifying the
provider event and normalizing bounded MIME into `InboundEmailInput` (safe
text, sender address, host-evaluated `senderAuthentication`, threading headers,
candidate reply token, and loop signals). There is no permission check: the
caller is a trusted worker, and the input has no principal, role, plan,
priority, or session field.

For a ticket with `requester.email`, every reply locator requires the
case-insensitive normalized `from` address to equal that email and a passing
sender result bound to the same `from`. DMARC requires aligned DKIM or aligned
SPF; `host_identity` represents an equivalent host-authenticated identity.
Missing, failed, unaligned, or differently bound results create a new
unverified related ticket and leave the named ticket unchanged. A ticket
without a requester email retains the opaque routing-token flow; headers and
subject markers alone remain insufficient. Sender authentication never selects
a principal or grants web access.

Processing reserves the `support-desk.inbound-receipts.v1` receipt with
`insertIfAbsent` before ticket work (256 hash slots per partition), suppresses
bounce and auto-reply loops, persists one routing decision on the receipt,
and then creates or replies in one ticket-partition transaction with an Audit
event (`system` actor `support-desk.inbound-email`), a command receipt, and an
optional notification. Retries and concurrent duplicates return the first
delivery's result and identifiers. Earlier receipts without a canonical replay
fingerprint recognize only their exact prior payload shapes, bind the current
fingerprint before continuing, and retain their original ticket-command
fingerprint. Matching order is reply token,
`In-Reply-To`/`References`, then subject marker, all through
`support-desk.thread-index.v1` key lookups confirmed against authoritative
records. A repeated inbound message's own `Message-ID` is checked for duplicate
delivery first; when it does not qualify, its ticket precedes the subject
marker as the related-ticket fallback. Unsafe or ambiguous matches create a new
unverified ticket with the staff-only `Ticket.relatedTicketId`. A unique account
match creates a `matched_email` ticket that stays invisible to customer web
services.

Notifications may carry an optional `replyRoutingToken` (22 to 128 URL-safe
characters) for the host to render into the reply address. The application
indexes it by SHA-256, with each notification `Message-ID` and every ticket
number, after commit. Schedule `repairThreadIndexPage` and
`sweepThreadIndexPage` with the same `threadIndexRetentionMilliseconds` as the
processor. Terminal receipt retention uses trusted processing time, a 30-day
deduplication horizon, and version-conditional deletion; in-flight receipts
are never swept.

## Host composition

Map application errors to HTTP and schedule host-owned workers using
[docs/HOST_COMPOSITION.md](../../docs/HOST_COMPOSITION.md). A complete
memory-backed example is under
[examples/composition](../../examples/composition/README.md).
