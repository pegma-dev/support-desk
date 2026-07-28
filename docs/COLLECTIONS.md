# Declared collections

Support Desk declares storage through `@pegma/storage-core`; it does not
implement a backend.

## Authoritative records

`support-desk.records.v1` is a heterogeneous collection partitioned by ticket
ID. One partition contains:

- `ticket`: current ticket state;
- `quota`: conflict-safe message count for the hard per-ticket cap;
- `reservation`: committed or cancelled customer-index reservation fence;
- `message:<message-id>`: canonical customer or internal messages;
- `event:<revision>:<command-id>`: append-only audit events;
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

Delivery jobs remain as terminal records after confirmed delivery, exhausted
retry, or terminal-unknown reconciliation. A later retention sweep uses
`listVersioned` and `deleteIfUnchanged`.
Each job stores a provider idempotency key composed from its ticket partition
and job ID. Both parts are URI-encoded and the final key is format-checked and
limited to 255 characters, so the same notification ID on two tickets cannot
collide at the provider.

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
`sweepTerminalDeliveryJobs` safely reclaims old terminal outbox rows.

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
Delivery retry availability and terminal retention timestamps also use that
trusted processing time; provider `occurredAt` remains evidence on the receipt
and cannot delay a retry or accelerate deletion.

## Outbox discovery

Storage Core deliberately cannot enumerate partitions. The mail worker
therefore accepts candidates from a durable host-owned
`DeliveryCandidateSource`. The source may repeat or lag: every candidate is
confirmed by a conflict-safe lease claim in the authoritative ticket
partition before a provider call occurs.

Every claim receives a fresh random fencing token. Completion requires both
worker ID and that exact token, so a stale invocation cannot complete after
the same named worker reclaims an expired lease.

Provider acceptance carries a bounded callback deadline. After that deadline,
the worker claims the accepted job specifically for provider reconciliation;
it never blindly resends it. Confirmed failure returns to retry with the same
global idempotency key, confirmed delivery becomes terminal, and an
unresolvable provider response becomes the explicit retainable
`terminal_unknown` state. Transport failures remain accepted and schedule
bounded read-only reconciliation retries; exhaustion dead-letters without
making the job sendable. Expired reconciliation leases remain
reconciliation-only when reclaimed and are never eligible for a send claim.
