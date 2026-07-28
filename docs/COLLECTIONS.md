# Declared collections

Support Desk declares storage through `@pegma/storage-core`; it does not
implement a backend.

This file names both implemented and approved planned layouts so an
implementation agent does not invent another access path:

| Collection                                   | State                                                                              |
| -------------------------------------------- | ---------------------------------------------------------------------------------- |
| `support-desk.records.v1`                    | Implemented; private audit member is replaced by `@pegma/audit` in Buildout Task 1 |
| `support-desk.customer-ticket-index.v1`      | Implemented                                                                        |
| `support-desk.inbound-receipts.v1`           | Declared and tested; processing arrives with inbound mail                          |
| `support-desk.delivery-callback-receipts.v1` | Implemented                                                                        |
| `support-desk.ticket-numbers.v1`             | Planned in Buildout Task 3                                                         |
| `support-desk.queue-index.v1`                | Planned in Buildout Task 5                                                         |
| Inbound threading indexes                    | Not declared until Buildout Task 11                                                |

The approved target is not permission to create all planned collections at
once. A collection is added only in its named task with its codec, limits,
memory tests, and real-adapter tests.

## Authoritative records

`support-desk.records.v1` is a heterogeneous collection partitioned by ticket
ID. One partition contains:

- `ticket`: current ticket state;
- `quota`: conflict-safe message count for the hard per-ticket cap;
- `reservation`: committed or cancelled customer-index reservation fence;
- `message:<message-id>`: canonical customer or internal messages, including
  an immutable Support-owned outbound-content snapshot when applicable;
- `event:<revision>:<command-id>`: current pre-release private audit rows;
  Buildout Task 1 replaces this member with an `@pegma/audit` event keyed by
  `auditRecordId(event.id)`;
- `command:<command-id>`: idempotency receipts with request fingerprints;
- `delivery:<notification-id>`: durable outbound jobs.

This layout is load-bearing. It lets a customer state change, its canonical
message, its audit event, its command receipt, and its outbound job commit in
one single-partition transaction. Ticket updates use `putIfUnchanged` with the
opaque storage version read for that attempt; conflicts re-read, re-decide,
and retry.

Each message stores the resulting ticket revision from the transaction that
committed it as an explicit ordinal. Reads validate that ordinals are present
and unique, then sort by them; caller-supplied message IDs never determine
conversation order.

Each `delivery:*` record is the Support Desk projection of an exact
`@pegma/mail@0.1.0` `MailJob`. The nested generic job owns submission
generations, claims, retries, reconciliation, acknowledgements, and terminal
state. Its `contentRef` resolves the immutable rendering metadata on the
causal `message:*` record. The projection preserves Support-owned physical
identity and message metadata through every generic transition.

Mail's worker discovers jobs with the collection-wide authoritative `scan`;
the physical scan key must match both the decoded Support record key and the
projection key. Hosts persist send and reconciliation continuations
independently after completing each page and repeat complete scan cycles.
Provider idempotency keys include the ticket partition, logical job ID, and
submission generation, so notification IDs cannot collide across tickets. A
new generation after confirmed failure cannot collide with the failed
submission; a retry after an ambiguous send call intentionally keeps the same
generation and key.

The configurable message cap is enforced by conditionally updating `quota` in
the same transaction as every reply. Messages, command receipts, audit events,
and optional delivery jobs therefore remain bounded together. The default and
hard configuration maximum are 100 messages per ticket, message bodies are at
most 20,000 characters, and each job's complete variable map has at most 32
safe-name string values and 8,192 UTF-8 bytes across those values. The
application snapshots own data properties before idempotency fingerprinting
and persistence; accessors are rejected rather than executed. A maximally
filled conversation is therefore in the low tens of megabytes even under
worst-case JSON escaping; ordinary plain-text records are under roughly 3 MB.
The generic mail sweep scans authoritatively and uses
`deleteIfUnchanged`; dead-letter and terminal-unknown rows must be explicitly
acknowledged before they become eligible.

Accepted-change audit history uses `@pegma/audit` in the target layout. Its
event lives inside this same record union and ticket partition, and its
transaction action lands beside the ticket mutation. The pure domain
`TicketEvent` is not persisted as a second audit contract.

## Read hints and receipts

`support-desk.customer-ticket-index.v1` stores one bounded summary record per
principal rather than one ever-growing partition of rows. The configurable
default cap is 100 ticket IDs. It is a cross-partition hint, never an ownership
answer: customer list reads confirm each referenced ticket and authenticated
requester principal against the authoritative ticket partition.

The hint is reserved with a timestamp and random token before ticket creation
so concurrent creates cannot exceed the cap. Ticket creation atomically
inserts the same token into its ticket partition, then confirms the index
entry. To reclaim an expired crash-stale reservation,
`pruneCustomerTicketIndex` first writes that reservation token into a
cancellation fence at the same ticket-partition key. A retry cannot clear or
reuse a cancelled token while the index removal is pending. Every reservation
also carries a monotonic generation derived from the durable fence. After
removal a retry reserves the next generation, and ticket creation may
conditionally replace only a strictly older cancelled fence in the same
transaction as the ticket. A concurrent prune likewise only advances the
fence generation. Stale creates and prunes can therefore never overtake newer
fences, so pruning cannot hide a committed ticket or free in-flight capacity.

`support-desk.inbound-receipts.v1` reserves the Phase 7 provider-event
deduplication contract; this does not claim inbound mail processing is
implemented. Its declared layout already hashes channel and provider event ID
with SHA-256 and uses the same 120-bit bucket plus 8-bit slot pattern as
delivery callbacks. A partition therefore has exactly 256 possible keys
instead of growing with every message received by a channel. Receipts carry
trusted `receivedAt` and terminal `processedAt` times.
`sweepInboundReceipts` conditionally deletes at most 1,000 terminal receipts
per call with `deleteIfUnchanged`; it never deletes `processing` receipts and
enforces a 30-day deduplication horizon even if the caller supplies a newer
cutoff.

`support-desk.delivery-callback-receipts.v1` hashes provider and provider event
ID with SHA-256 and uses 128 bits as a stable location: the first 120 bits name
the bucket and the final 8 bits select one of exactly 256 slots. The location
never depends on callback payload fields such as `occurredAt`; reuse always
reaches the same slot, while a digest collision is rejected rather than
misprocessed. This gives every partition a hard 256-record ceiling without a
globally growing shard. A receipt is inserted before applying its normalized
callback. Its `processedAt` comes from the host clock, not the provider's
`occurredAt`, and lets a retry resume safely if a process stops between receipt
insertion and delivery-job update.
`sweepDeliveryCallbackReceipts` reclaims at most 1,000 processed receipts per
call with `deleteIfUnchanged`. The application enforces a 30-day deduplication
horizon against trusted processing time even if `processedBefore` is newer,
because an event can be accepted again after its receipt is removed.
Authenticated callbacks include the provider submission generation, so a
delayed event cannot mutate a newer submission. Generic mail state uses trusted
processing time; provider `occurredAt` remains evidence and cannot schedule a
retry or accelerate deletion.

## Ticket numbers

Buildout Task 3 declares `support-desk.ticket-numbers.v1` with one
`{ lastIssued }` counter record at constant partition `instance` and ID
`ticket-number` in the Support Desk instance's storage namespace. Reservation
is an `update` decider that returns the next positive safe integer.

The counter and ticket cannot share a transaction and do not need to. A number
is reserved first; if the later ticket transaction fails, the gap remains.
Gaps are allowed, duplicates are not. Command replay returns the number on the
already committed ticket and never reserves a replacement.

Numbers are instance-scoped display values. RetireGolden and pegma.dev may both
have ticket `1042`; their separate stores and subject markers distinguish them.
A number is never a lookup capability or authorization fact.

## Staff queue projection

Buildout Task 5 declares `support-desk.queue-index.v1`. It stores one row per
ticket with:

- partition: ticket ID;
- ID: `queue`;
- projected ticket revision;
- active or inactive projection state;
- status, priority, optional category, requester association, channel,
  assignee, and update time.

It stores no message content, requester email, routing token, or permission
decision.

The projection is a separate collection, so it cannot commit atomically with
the ticket. After a ticket transaction succeeds, the application attempts a
revision-fenced projection write. A repeating cursor-aware worker scans
authoritative `ticket` records in `support-desk.records.v1` and repairs missed
writes. Older projection revisions cannot replace newer ones; an equal
revision with different content is corruption and fails closed.

Staff queue reads scan this projection in bounded pages, load every candidate
ticket by authoritative key, discard stale or inactive candidates, then filter
and sort under a configured hard materialization limit. The read scan cursor
is request-local: every queue request starts without one and consumes one
complete scan cycle. The authoritative repair cursor is host-persisted after
complete pages. A projection row never grants access.

Resolved and closed tickets receive an inactive row at their resulting
revision. A later sweep removes sufficiently old inactive rows with
`deleteIfUnchanged`; a row changed after enumeration survives.

## Outbox discovery

The mail worker uses Storage Core's bounded collection-wide `scan` to enumerate
the authoritative committed rows. It filters decoded delivery jobs locally,
derives candidate identity from the returned physical key, and confirms every
candidate with a conflict-safe lease claim in the authoritative ticket
partition before a provider call occurs. There is no separate scheduling write
after `transact`, so a crash after the application commit cannot strand work.

Delivery execution uses two independent complete scan loops: `runSendPage`
with its own persisted send cursor, and `runReconciliationPage` with a
separately persisted reconciliation cursor. Terminal sweeping, when
scheduled, keeps a third independent cursor. Each adapter-issued cursor is
opaque and belongs only to its loop; cursors are never shared or translated.
For each loop, the host
persists a non-null continuation only after handling the whole page, starts
the next cycle without a cursor after `nextCursor: null`, and repeats complete
cycles. Pages may duplicate rows and are neither ordered nor snapshots; a row
changed behind an in-flight cursor can wait for that loop's next cycle.
Repetition is safe because claims are conditional and provider sends use the
durable idempotency key.

The send loop claims pending, retrying, and expired send leases. The
reconciliation loop claims accepted rows past their callback deadline and
expired reconciliation leases for read-only provider status checks. A crash
after provider acceptance or during reconciliation therefore leaves
repeatable authoritative work in the reconciliation loop, not an
undiscoverable or blindly resubmitted state.

The physical key also remains the claim and completion target. Before calling
a provider, the worker checks that duplicated identity fields in the decoded
job agree with that key. An incoherent row fails closed through bounded
delivery handling instead of completing another partition or repeating an
external call forever.

Every claim receives a fresh random fencing token. Completion requires both
worker ID and that exact token, so a stale invocation cannot complete after
the same named worker reclaims an expired lease.

Provider acceptance carries a bounded callback deadline. After that deadline,
the worker claims the accepted job specifically for provider reconciliation;
it never blindly resends it. An authenticated failure callback or a
reconciled confirmed failure clears the prior acceptance, increments the
submission generation, derives a distinct provider idempotency key, and
returns the job to the send loop when attempts remain. By contrast, an
ambiguous send-call failure retries the same generation and key, allowing
provider idempotency to collapse a submission that may already have been
accepted. Confirmed delivery becomes terminal, while an unresolvable status or
reconciliation adapter failure becomes the explicit retainable
`terminal_unknown` state rather than entering the send loop. Expired
reconciliation leases remain reconciliation-only when reclaimed.
