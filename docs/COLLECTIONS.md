# Declared collections

Support Desk declares storage through `@pegma/storage-core`; it does not
implement a backend.

This file names both implemented and approved planned layouts so an
implementation agent does not invent another access path:

| Collection                                   | State                          |
| -------------------------------------------- | ------------------------------ |
| `support-desk.records.v1`                    | Implemented                    |
| `support-desk.customer-ticket-index.v1`      | Implemented                    |
| `support-desk.inbound-receipts.v1`           | Implemented (Buildout Task 11) |
| `support-desk.delivery-callback-receipts.v1` | Implemented                    |
| `support-desk.ticket-numbers.v1`             | Implemented                    |
| `support-desk.queue-index.v1`                | Implemented                    |
| `support-desk.thread-index.v1`               | Implemented (Buildout Task 11) |

The approved target is not permission to create all planned collections at
once. A collection is added only in its named task with its codec, limits,
memory tests, and real-adapter tests.

## Authoritative records

`support-desk.records.v1` is a heterogeneous collection partitioned by ticket
ID. One partition contains:

- `ticket`: current ticket state, including optional host `category`, staff
  `updatedAt`, customer-visible `customerUpdatedAt`, optional staff-only `tags`,
  `firstResponseDueAt`, `resolutionDueAt`, and `firstStaffRespondedAt`, plus
  the existing current-cycle `resolvedAt`;
- `quota`: conflict-safe message count for the hard per-ticket cap;
- `reservation`: committed or cancelled customer-index reservation fence;
- `message:<message-id>`: canonical customer or internal messages, including
  an immutable Support-owned outbound-content snapshot when applicable;
- `audit|<event-id>`: `@pegma/audit@0.2.0` accepted-change events keyed by
  `auditRecordId(event.id)` (command ID is the event ID);
- `command:<command-id>`: idempotency receipts with request fingerprints
  (inbound mail uses `inbound:<receipt location>` command IDs); an older
  nonqualifying reply route may reserve this key with a bounded reroute fence;
- `delivery:<notification-id>`: durable outbound jobs.

The SD-02 source candidate adds bounded `assistant_turn` work to this same
ticket partition; its design checkpoint is below. It adds no collection or
storage implementation.

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
`@pegma/mail@0.1.1` `MailJob`. The nested generic job owns submission
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

Accepted-change audit history uses exact `@pegma/audit@0.2.0`. Support Desk
declares the projection with `defineAudit` against this collection and ticket
partition, embeds each `AuditEvent` in the record union, and drops
`defineAudit(...).action(...)` into the same `transact` as the ticket mutation.
History is read through Audit's `history` helper (sequence, then time, then
id). The pure domain `TicketEvent` is not persisted as a second audit contract.

Task 13 staff receipts add optional `resultTicket`, a bounded ticket snapshot
without conversation bodies. A replay selects immutable message rows whose
ordinal is at most that ticket revision. The optional revision hint is included
in new command fingerprints only when supplied, preserving older omitted-hint
fingerprints. Legacy receipts without snapshots still return current detail.
Tags and targets share the ticket transaction with its Audit action and receipt;
no new collection, storage implementation, or cross-partition transaction is
introduced. Tags have at most 32 safe identifiers (application default 8),
and each due date is a canonical ISO timestamp. First staff response persists
through reopen; resolution is cleared on reopen/reply and set on re-resolution.

### SD-01 handling and handoff layout checkpoint

This design was recorded before SD-01 added durable operations. The task extends
`support-desk.records.v1` in the existing ticket partition; it introduces no
collection, model integration, KB dependency, or package. The row layout below
is synchronized with the implementation agreement and public API. Source
tests and repository gates determine completion, not this checkpoint.

`Ticket.handling` is optional and separate from lifecycle `status`. Its state
is `assistant`, `human-pending`, or `human-active`, with a handling generation.
An omitted legacy value reads as human-pending/generation zero without a
stored migration. New assistant handling starts at generation one through an
explicit, authorized web-only choice. Assistant messages have their own author kind; they never count as a
first staff response. A new customer message, escalation, or takeover fences
older assistant work through current ticket revision/handling/trigger checks.

| Logical record family                      | Required binding and boundary                                                                                                          |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| Ticket and quota                           | Current revision/handling generation, bounded message/physical-row accounting, optional `quota.assistantManaged: true` marker          |
| Assistant message                          | Exact current revision, handling generation, and triggering customer message; explicit assistant attribution                           |
| `handoff:<commandId>` (`handoff_work`)     | Pending causal work, resulting handling fence, compact transcript reference, bounded safe summary and attempted guide IDs              |
| `success:<commandId>` (`customer_success`) | Authenticated owner/time and last customer-visible message proof, accepted revision/handling generation; private evidence without text |
| Audit and command receipt                  | Accepted transition and stable semantic command identity, committed with its causal records                                            |

Handoff changes, bounded work, Audit, and replay receipts commit atomically
with the ticket. They store neither copied transcripts nor raw internal notes
and create no automatic mail job. Request-person is a deterministic owned
command independent of model availability. Repeating a request on an already
human-handled active ticket adds no rows; repeating an accepted success proof
for the same last-visible message on a resolved ticket also adds no rows.
Human queue selection and assistant
supervision use separate authoritative handling checks, never projection-only
authority.

The handoff transcript reference contains only ticket ID, through-revision,
and last visible message ID. Its safe summary is at most 2,000 UTF-16 code
units and attempted guide IDs are at most 16 opaque strings of 200 UTF-16 code
units each. The
serialized handoff record is at most 60,000 UTF-16 bytes, fitting a bounded
native JSON property. The same complete-record bound applies to assistant
messages, including wrappers. Summary overflow is `SupportDeskLimitError`
field `handoff_summary` (maximum 2,000 code units); serialized overflow is field
`serialized_record` (maximum 60,000 UTF-16 bytes). Both fail before commit.
A new handoff or success confirmation adds three rows
(work/evidence, Audit, receipt); takeover adds two (Audit, receipt). Assistant
reply adds the existing message/Audit/receipt trio. There is no extra assistant
turn row or unbounded attempt history in SD-01.

Opted-in quotas reserve 12 physical rows and one human message slot across
non-control writes until `firstStaffRespondedAt` is established. Existing
quotas without that marker retain their previous limits. Only explicit
assistant creation sets `assistantManaged: true`. Assistant admission
requires at least two message slots and room for initial records plus the
reserve: at least 6 + 12 physical rows without delivery, or 7 + 12 with the
initial delivery. Count every physical row before filtering; no retries or
history may grow around the reserve. The final API distinguishes control
admission from ordinary writes without bypassing the hard partition cap.
The 12-row allowance covers a first handoff (3), takeover (2), confirmation
(3), and human reply with delivery (4). Before the first staff response,
handling controls must still leave four physical rows and one message slot;
the first staff reply may spend that tail. Additional control cycles can
exhaust finite capacity and return named limits. Deterministic handoff means
provider-independent, authenticated, and race-safe, not unlimited admission
or guaranteed success at the 512-row hard cap.

Fresh inbound email remains human-handled. A verified email reply joining an
assistant web conversation routes it to human-pending; email authentication
still grants no web principal or account access. SD-01 supplies handling and
deterministic controls only. AUTH-01, KB-04 transport source/SDK proof, partial
KB-05 source preparation ([KB #4](https://github.com/pegma-dev/knowledge-base/pull/4)),
and both producers' final release preparation are merged. All four KB packages
and Agent Access now have verified trusted `0.1.1` releases, closing the
publication prerequisite for SD-02's in-progress source candidate below.
PG-01/RG-01 consume exact verified published producers and retain actual two-host
existing-login/Admin consent and requested-client proof before activation or
pilots. Synthetic SDK proof uses no actual customer data and cannot close those
host gates. SD-02 current-head source validation/review and host privacy,
operations, full-workflow, activation, and pilot gates stay pending under the
[current implementation ledger](KNOWLEDGE_AI_PLAN.md#status-and-reading-order).

### SD-02 assistant-turn layout checkpoint

This checkpoint was written while the SD-02 implementation was in progress.
It describes the candidate contract, not a completed validation or release.
The optional `@pegma/support-desk-ai` coordinator consumes public application
operations; the application keeps no KB or provider dependency.

| Record or operation                          | Durable boundary                                                                                                                                                                                                                                                                                                   |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `assistant-turn:<turnId>` (`assistant_turn`) | One causal turn job in `support-desk.records.v1`, in the existing ticket partition. `turnId` is the 64-character lowercase SHA-256 of canonical `{ messageId }`. It binds the ticket, signed-in web customer trigger, handling generation, retry/deadline state, and current claim.                                |
| Customer ingress                             | The triggering message, turn job, Ticket/handling change, Audit, receipt, and quota accounting commit atomically. An email message does not create assistant work, even when the ticket's original channel is `web`.                                                                                               |
| Prepared attempt                             | A bounded inline array on the turn job stores attempt identity, input fingerprint, version bindings, opaque source/context bindings, deadline, predetermined usage reservation, and compact processing/accounting metadata. It stores no prompt, conversation dump, retrieved article body, or raw model response. |
| Claim and preparation                        | Claim identity/generation and the exact revision/handling/customer-trigger fence control ownership. Lease, preparation, and retry metadata do not advance the ticket revision or append attempt rows. Automatic fallback is a ticket transition with atomic handoff work.                                          |
| Answer or escalation                         | The application accepts only these fixed outcomes. It updates the turn together with the resulting assistant message or human handoff, Audit, replay receipt, Ticket, and quota work in one ticket transaction.                                                                                                    |

`AssistantTurnApplication` exposes exactly five operations:
`scanAssistantTurnCandidates`, `claimAssistantTurn`,
`prepareAssistantTurnAttempt`, `completeAssistantTurn`, and
`finishAssistantTurnAttempt`. The scan bounds physical adapter rows before
filtering and returns one page and an opaque continuation. Candidate rows are
hints; the claim rechecks the authoritative ticket and turn. The completion
guard is read-only source/authority validation, not a caller-supplied list of
transaction actions. Model calls never run inside a storage retry callback.
The coordinator generates a fresh internal claim ID per physical invocation;
its public `ProcessAssistantTurnCommand` omits `claimId`. The lower-level
application claim remains idempotent for the same worker/claim. A duplicate
coordinator callback leaves another live claim and its reservation untouched;
only after lease expiry can a new generation/attempt retain and conservatively
reconcile prior prepared/unknown metadata. After awaited usage reservation,
an identical prepare rechecks the live fence/deadline, followed immediately by
the full current customer/source/configuration guard before the provider call.
The same guard runs before every completion CAS.
Expired deadlines remain discoverable even under an old active lease.
Disabled handling, exhausted attempts/deadline, and retries at or beyond the
deadline take the bounded atomic human fallback. A customer reply while
handling is disabled, or a staff reopen of explicit assistant handling, commits
human handoff work in the same lifecycle transaction.

The assistant-managed 12-row and one-human-message reserve remains in force.
The SD-01 admission counts above exclude turn work. Enabling `assistantTurns`
adds one causal job row: assistant creation needs at least 7 + 12 rows without
delivery or 8 + 12 with delivery. Later signed-in web replies count their job
row in the same admission check as message, Audit, receipt, and quota effects.
Claims and inline attempts add no physical rows.
Preparation admits a turn only when its current row is within the 52,000-byte
ceiling and every constructed maximum reachable post-preparation state fits
the 60,000-byte hard record cap. The capacity check uses the actual encoder
and processing-state builder with maximum legal JSON-escaped metadata,
identifiers, fences, timestamps, duplicated metadata/receipts, and replacement
claim fields. It covers answer, escalation, retry, supersession, and the next
claim while preserving earlier bindings and metadata verbatim. Only the
current attempt's processing/accounting state changes; a later preparation
reserves again. Oversized preparation raises the typed limit before a provider
call and leaves the claim available for bounded human handoff. No unbounded
history or second private usage ledger is permitted. The implemented record
schema currently has these candidate caps:

| Bound                       | Default / hard maximum                                                                                                                             |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Attempts per turn           | 2 / 4; prepared attempts stay inline and cannot exceed the admitted turn budget                                                                    |
| Turn lifetime               | 300,000 / 3,600,000 milliseconds                                                                                                                   |
| Configured maximum lease    | 60,000 / 300,000 milliseconds; the worker's actual requested lease must also accommodate its bounded invocation                                    |
| Complete persisted turn row | 60,000 conservative serialized UTF-16 JSON bytes                                                                                                   |
| Row at preparation          | 52,000 serialized bytes, plus constructive admission requiring every maximum reachable completion/finish/replacement-claim row to fit 60,000 bytes |
| Complete attempt binding    | 12,000 serialized bytes, including at most 16 version entries and 32 opaque source references                                                      |
| Opaque reference binding    | 6,000 UTF-16 code units each, still subject to the whole-binding bound                                                                             |
| Processing strings          | At most 200 code units each; failure category 80; usage counters are nonnegative safe integers                                                     |

Byte accounting uses the complete JSON serialization, including escaping and
wrappers, multiplied by two; it is distinct from model input/output UTF-8
budgets. Job states are `pending`, `claimed`, `retry`, `completed`, `escalated`,
and `superseded`. No new per-attempt collection or physical row is created.

An unknown commit is recovered through the exact command receipt rather than
a second visible answer. A crashed worker may have called a provider even
when completion is absent; bounded retries and conservative host usage
reconciliation do not promise exactly-once provider calls or billing. Human
request-person and staff takeover remain independent of the provider and
invalidate stale completion through the existing handling fences.

See [assistant coordination](ASSISTANT_COORDINATION.md) for current authority,
full-source confirmation, data controls, and host usage ownership. Public-entry
memory/Azurite tests with the actual KB and a fake model, current-head Node
22/24 gates, and code/security review remain pending while implementation is
in progress. No source result closes host privacy, Task 12, or pilot gates.

## Ticket numbers

`support-desk.ticket-numbers.v1` holds one `{ lastIssued }` counter at
partition `instance` and id `ticket-number`. Customer create reserves the next
positive safe integer with `update` and a decider before the ticket
transaction. The counter does not share the ticket partition, so a failed
create may leave a gap; it must never issue a duplicate. Command replay returns
the already committed ticket number and does not reserve again. Exhaustion at
`Number.MAX_SAFE_INTEGER` fails closed before ticket persistence. Numbers are
instance-scoped display and threading aids, not secrets or capabilities.

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

`support-desk.inbound-receipts.v1` is the provider-event deduplication
contract for inbound mail (lifecycle below). Its layout hashes channel and
provider event ID
with SHA-256 and uses the same 120-bit bucket plus 8-bit slot pattern as
delivery callbacks. A partition therefore has exactly 256 possible keys
instead of growing with every message received by a channel. Receipts carry
trusted `receivedAt` and terminal `processedAt` times.
`sweepInboundReceipts` conditionally deletes at most 1,000 terminal receipts
per call with `deleteIfUnchanged`; it never deletes nonterminal `processing` or
`rerouting` receipts and enforces a 30-day deduplication horizon even if the
caller supplies a newer cutoff.

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

## Ticket number reservation

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

## Inbound receipts and the threading index

Buildout Task 11 implements inbound processing on top of the reserved
receipt layout and declares one more collection.

### Inbound receipt lifecycle

`createInboundMailProcessor(...).processInboundEmail` writes the
`support-desk.inbound-receipts.v1` receipt with `insertIfAbsent` at the
channel/event slot **before** any ticket work. The first delivery stores an
immutable payload fingerprint used by ticket-command replay and a canonical
replay fingerprint (normalized sender, optional host-evaluated sender result,
subject, body, threading headers, token, and loop signals, excluding
host-minted IDs), `receivedAt`, and the host-minted `reservedTicketId`,
`reservedMessageId`, and `correlationId`.

- A retry of the same channel/event reaches the same slot. A different
  canonical replay fingerprint or a digest collision fails closed with
  `SupportDeskConflictError` and does no ticket work.
- A receipt written before the canonical replay field recognizes only the
  exact earlier payload shapes, then atomically binds the canonical replay
  fingerprint before continuing. Its immutable payload fingerprint remains
  the ticket-command fingerprint so work committed before receipt finalization
  still resumes through the same command record.
- A `processing` or `rerouting` retry adopts the first delivery's reserved
  identifiers, not its own, so a crash at any point resumes the same ticket and
  message IDs.
- The routing decision (`route`: suppressed, duplicate message, reply to a
  ticket, or new conversation with association, priority, optional category,
  and optional related ticket) is written once with an `update` decider and
  never re-decided during ordinary replay. Processing routes recorded before
  sender authentication was enforced are normalized before ticket work; an
  already committed command wins, while a nonqualifying route becomes an
  unverified related conversation. The processor first claims the receipt with
  the resumable `rerouting` status, which prevents an older worker from
  finalizing the prior route while normalization is in progress.
- Before replacing an older reply route, the processor reserves its original
  `command:<command-id>` key with an `inbound_reply_reroute_fence` in the target
  ticket partition. The fence plus unchanged ticket and quota versions commit
  together, so a concurrent row-adding command cannot overtake its capacity
  check. This permanent tombstone counts toward `maxRecordsPerTicket`;
  insertion enforces the configured bound and fails closed when no record
  capacity remains.
- Before replacing an older matched related-conversation route, the processor
  reserves the new ticket's command key with an
  `inbound_create_reroute_fence`. The normalized create transaction
  conditionally replaces that temporary fence with its command record, so an
  older create cannot commit in parallel and the final partition size is
  unchanged.
- The ticket command ID is derived from the receipt location
  (`inbound:<120-bit bucket hash><slot>`), so the ticket-partition command
  receipt deduplicates concurrent or resumed processors.
- The receipt becomes `processed` (`created`, `replied`, or
  `duplicate_message`, with resulting `ticketId` and `messageId`) or
  `rejected` (`suppressed` with a loop/bounce reason, or a state-dependent
  refusal such as `ticket_messages_limit`) with trusted `processedAt`. A
  retry returns that terminal result.

`sweepInboundReceipts` is unchanged: it deletes only terminal receipts past
the 30-day horizon and never deletes nonterminal `processing` or `rerouting`
receipts.

### Threading index

`support-desk.thread-index.v1` makes inbound matching a key lookup. Every
partition holds exactly one row with ID `thread`:

| Partition      | Kind            | Written for                                                                                                             |
| -------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `mid:<sha256>` | `message_id`    | an outbound notification `Message-ID` (`source: outbound`) or an inbound message's own `Message-ID` (`source: inbound`) |
| `rt:<sha256>`  | `reply_token`   | an outbound notification's opaque `replyRoutingToken`                                                                   |
| `number:<n>`   | `ticket_number` | every ticket, for subject-marker fallback                                                                               |

A row stores the kind, ticket ID, causal message ID, `Message-ID` source,
and the authoritative creation time of the causal message or ticket. It
stores no message content, no email address, and never the reply token,
only its SHA-256 key.

The index cannot share the ticket transaction. After a committed command
that recorded a notification (or created a ticket, or accepted inbound
mail), the application inserts the implied rows with `insertIfAbsent`; a
failure is logged and never fails the command. First writer wins; a
different mapping for the same key is logged as a collision and kept.
`repairThreadIndexPage` is a repeating cursor-aware worker over
authoritative `support-desk.records.v1` rows that re-derives and inserts
missing rows. `sweepThreadIndexPage` scans the index and conditionally
deletes (`deleteIfUnchanged`) rows whose ticket or message is gone or no
longer derives them, or that are past retention.

Lookups never trust a row: each one reloads the ticket and causal message
by key and re-derives the row before using it. `Message-ID` and reply-token
rows older than the shared `threadIndexRetentionMilliseconds` (default 365
days) are treated as absent by lookups, are not recreated by repair, and are
removed by the sweep. Ticket-number rows live as long as their ticket.
Hosts pass the same retention value to the processor and both workers.

Tickets created before this layout existed have no rows until a complete
repair cycle runs; until then their replies fall back to later matching
steps or create a linked unverified ticket.

## Staff queue projection

`support-desk.queue-index.v1` stores one row per ticket with:

- partition: ticket ID;
- ID: `queue`;
- projected ticket revision;
- active or inactive projection state;
- status, priority, optional category, requester association, channel,
  assignee, and update time;
- optional staff-only tags, first-response/resolution due dates,
  `firstStaffRespondedAt`, and `resolvedAt`;
- optional handling state/generation for explicitly handled tickets.

It stores no message content, requester email, routing token, or permission
decision.

The projection is a separate collection, so it cannot commit atomically with
the ticket. `projectTicketToQueue` accepts a ticket ID, reloads the
authoritative ticket, and derives the entire row; it never accepts a
caller-supplied ticket snapshot. After a ticket transaction succeeds, the
application invokes that projector without failing the committed command when
the projection write fails (logged; exposed via `queueProjectionHealth`).
`repairQueueProjectionPage` is a repeating cursor-aware worker that scans
authoritative `ticket` records in `support-desk.records.v1` and repairs missed
writes. Older projection revisions cannot replace newer ones; an equal revision
with different content is corruption and fails closed, except exact legacy
rows missing all additive lifecycle fields may be enriched from the freshly
loaded authoritative ticket at the same revision. Run a complete queue repair
cycle after upgrading. Target/tag filtering and sorting use authoritative
fields, never the candidate row values.

Staff queue reads (`listStaffQueue`) scan this projection in bounded pages and
load candidates by authoritative key. A valid positive older active hint can
discover a freshly loaded active ticket; current handling/status/filter/sort
fields come only from that ticket. Malformed, nonpositive, future-revision,
and inactive hints are rejected, as is absent or terminal authority. One request has separate hard budgets for
physical rows, scan pages, and confirmed active results
(`queueScanBudgets`); every adapter-returned physical record counts before
authoritative confirmation or application filtering, while a codec failure
aborts the page safely. Reaching any budget before `nextCursor: null` returns
`SupportDeskQueueCapacityError` with no partial queue. The read scan cursor is
request-local: every queue request starts without one and consumes one complete
scan cycle only when it remains within all budgets. The authoritative repair
cursor is host-persisted after complete pages. A projection row never grants
access.

SD-01 queue queries default to human handling; assistant/all are explicit
supervision views. Returned staff items include effective handling state.
Legacy omission remains human-pending and filtering uses the confirmed
ticket, not the projection's optional handling snapshot.
An older active assistant hint can therefore reveal a newly human-handled
ticket without waiting for projection repair. Missing or inactive hints can
still cause a temporary repair gap; no cross-partition atomicity is implied.

Resolved and closed tickets receive an inactive row at their resulting
revision. Projection, repair, and `sweepInactiveQueueProjections` share one
configured terminal retention cutoff
(`queueTerminalRetentionMilliseconds`, default 30 days). Once the authoritative
ticket is still terminal beyond that cutoff, projection and repair keep its
queue row absent or conditionally delete one instead of recreating an inactive
row. The sweep reloads the authoritative ticket before using
`deleteIfUnchanged`; a row or ticket changed after enumeration survives.
Because every delayed projector reloads current authoritative state, it cannot
resurrect a reclaimed stale snapshot. Reopening the ticket makes current state
active and recreates the projection.

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
