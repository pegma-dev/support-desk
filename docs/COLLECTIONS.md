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

### SD-04 engineering layout checkpoint

This checkpoint precedes SD-04 production changes. It records a source design,
not implementation, publication, or host acceptance. SD-03 merged in
[PR #39](https://github.com/pegma-dev/support-desk/pull/39) before this work began.

An explicitly enrolled ticket has one `engineering-source` record and bounded
`engineering-work:<sourceGeneration>` records in `support-desk.records.v1`.
Their accepted changes, Audit actions, command receipts, source invalidations,
export requests, and remote acknowledgements share the ticket partition.
Engineering evidence can apply to open tickets; successful resolution evidence
never establishes a bug. Staff-verified reproduction or a trusted relevant
failing-test receipt must bind expected/actual behavior, reproduction/test,
actor, trusted product/build, and source generation. Source rows contain no
copied conversation archive. Restricted or uncertain security cases cannot
enter ordinary export.

`support-desk.engineering-policy.v1`, partition `instance`, contains a bounded
current repository policy, its Audit events, and command receipts. Each entry
uses immutable repository identity and current owner/name, visibility,
responsibilities, product/component/version descriptions, allowed labels and
templates, and approval-required publication authority. Credentials remain
host-owned. No initial automatic-filing mode is enabled. The policy partition
has a finite row budget and reserves two rows for an emergency disable action.
Its own transaction cannot atomically commit with a ticket transaction.

The optional AI package uses a separate assessment purpose and bounded current
allowlisted descriptors. A trusted independently verifiable calibration gate
binds normalized routing decisions to versioned evaluated model/prompt/parser
and allowlist facts. Self-reported confidence is not calibration. Unknown,
competing, or ambiguous targets require authorized human selection. Independent
privacy, factual, security, and public-reproduction checks bind the complete
sanitized outbound request. Duplicate discovery uses only trusted configured
queries or independently checked sanitized text, with bounded physical results.

Staff approval binds exact title/body/labels/template/evidence/opaque marker,
source and evidence generation, repository immutable ID/current metadata and
visibility, policy generation, routing and check results. Source, policy,
installation authority, and remote metadata are checked again before dispatch.
Changes invalidate approval without relying on projection repair. These are
fresh cross-partition checks, not a global atomic snapshot.

An approved request is durable before its one physical issue-creation call.
A fenced `dispatch-started` transition must precede the call. A replacement
worker observing possible dispatch performs reconciliation only. An opaque
marker correlates remote acceptance; it does not make GitHub idempotent.
Absence, timeout, and age never authorize another create. Retain unresolved
request identity and destination through later source invalidation or deletion.
Linking an existing issue creates only a private Support association; external
comments or edits require their own exact approval boundary.

Evidence/proposal generations, model attempts, targets, claims, review history,
and complete encoded records are finite. Construct the largest reachable later
completion/reconciliation states before paid work, preserving the 60,000-byte
record cap. Engineering consumes ordinary capacity and preserves the existing
human reserve. Independently withdrawable engineering sources reserve their
own two Audit/receipt rows; they cannot reuse learning's withdrawal reserve.
Relevant visible-message/reopen changes invalidate persisted sources even if
new composition options omit engineering. Worker changes do not increment the
ticket domain revision. Metadata and notes are not new bug evidence.

Permanent withdrawal scrubs private evidence, model manifests and draft copies,
stops new export, and retains only required opaque reconciliation identity.
Hosts withdraw every derivation workflow before deleting ticket bodies.
Withdrawal does not claim to retract already exported GitHub content; external
privacy remediation remains separately authorized host work.

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

### SD-03 resolution-learning layout and API checkpoint

This checkpoint records the agreed design before SD-03 production changes.
It is not implementation, validation, publication, or host activation evidence.
SD-03 extends this ticket partition and the optional AI coordinator; the base
application acquires no KB or provider dependency. KB's merged `0.1.2` producer
work became consumable after its exact public artifacts, signatures,
provenance, and clean consumer were verified in
[release run 42436081951](https://github.com/pegma-dev/knowledge-base/actions/runs/42436081951).
The optional delivery adapter now pins the verified public `0.1.2` producers;
current Support Desk integration validation and review remain separate gates.

#### Enrollment, source authority, and evidence

Learning is a separate host opt-in from assistant answering. An enrolled ticket
has exactly one `learning-source` row (`resolution_learning_source`). A
learning-enabled create preallocates this row with the ticket, quota, first
message, Audit, and receipt. An existing ticket requires an explicit authorized
enrollment command under ordinary admission; configuration does not reinterpret
old success receipts or silently enroll historical tickets. No historical
confirmation becomes eligible merely because learning was enabled later.

The source row owns its resolution cycle, monotonic source generation, current
eligibility, current evidence binding, and bounded destination/reconciliation
metadata. It begins at cycle one. A resolved/closed-to-active transition advances
the cycle and source generation, invalidates the prior proof, and holds derived
work. Closing retains the cycle; assignment, priority, tags, and internal notes
do not create a new cycle. New accepted evidence, a changed trusted product
binding, and withdrawal advance source generation. Worker leases, attempts,
receipts, and review metadata never advance Ticket domain revision.

Assistant/learning kill switches and provider/configuration outages control new
processing, not the truth of already accepted working facts or approved KB
guidance. Source eligibility is governed by source facts, explicit invalidation,
withdrawal, exact review, and current resource authority independently of those
switches. Product/test receipt validity authenticates acceptance as of the proof
time; historical working facts do not silently expire just because the receipt
is now old. An explicit `invalidateResolutionEvidence` command distinguishes
`evidence_revoked`, `product_binding_revoked`, and `check_policy_revoked` from
privacy withdrawal: it advances source generation, holds work, and durably
requests reassessment without privacy scrubbing.

`ResolutionSourceFence` identifies `ticketId`, `resolutionCycle`,
`sourceGeneration`, and `sourceBindingHash`. The hash binds the accepted
evidence and trusted product fingerprints. Evidence retains its accepted ticket revision and
resolution time as facts. Current eligibility additionally requires a terminal
ticket in that same cycle, the exact current source/evidence/product binding,
and no withdrawal. An unrelated metadata revision does not turn old evidence
into new evidence or invalidate an otherwise unchanged cycle.

`ResolutionEvidence` is a closed union:

- Authenticated customer confirmation: the application derives the owner,
  accepted revision/time, and exact last-visible-message proof through the
  existing owned confirmation command.
- Staff-verified fix: a currently authorized staff principal explicitly
  verifies a solution bound to immutable customer-visible solution message
  references and the current resolution/product fence.
- Successful relevant test: an opaque execution receipt is verified by the
  trusted host against the submitting actor, runner, relevant test, result,
  execution time, current resolution fence, and exact product/version/build.

Resolved status, inactivity, model assertions, a customer's claimed build, and
a submitted `passed` string are insufficient. `ResolutionProductContextPort`
supplies trusted product ID, version, build ID, context version, verification
receipt, and validity times bound to the exact ticket revision/cycle. The
separate `ResolutionTestReceiptPort` verifies test execution; it does not run
arbitrary code or fetch submitted URLs. Both ports receive content-free bound
facts and opaque references, have bounded waits, and are safe to call again.

Missing/unavailable product or test trust, disabled learning, and saturated
learning capacity must preserve customer confirmation, ordinary resolution,
replies, and human handoff. The causal human transaction still records its
normal proof, Audit, and receipt. An existing source row records a compact held
reason and current proof reference, without partially accepting eligible
evidence or inserting a partial job. A later eligibility decision requires
fresh current-cycle verification and its own atomic evidence/work/Audit/receipt
transaction. It cannot infer a historical product build from current settings
or promote an old-cycle confirmation. Provider or KB outages leave accepted
durable learning work pending without preventing human support.

A genuinely duplicate resolution proof within the same cycle/product binding
does not advance source generation or create another job. Customer proof
identity includes the authenticated owner and last-visible-message ID; test
identity includes the trusted execution identity. Stable semantic proof identity
uses cycle, stable product identity and stable test execution identity; it
excludes acceptance timestamps and refreshed attestation receipt IDs. It is
distinct from command identity. Exact command replay continues to return
the already accepted result, subject to current authorization.
For a staff-verified fix, `verificationReference` is the stable explicit proof
ID and participates in semantic identity: the same reference coalesces, while
a different verification reference creates a new generation. It is separate
from refreshable product/test attestation receipt IDs. A permanently withdrawn
source preserves its original privacy/access/deletion reason across reopening,
re-resolution, and later held confirmation attempts.

#### Records, rows, and the human reserve

| Record                                                                | Durable contents and boundary                                                                                                                                                                                                                                            |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `learning-source`                                                     | Constant versioned authority row; current cycle/generation/evidence/product fence, held/withdrawn state, bounded target article registry/review-binding counter, and minimal pending reconciliation. No conversation body.                                               |
| `resolution-learning:<sourceGeneration>` (`resolution_learning_work`) | One evidence plus durable learning job for a genuinely new eligible generation. Immutable source fence, structured proof, compact input manifest, bounded model attempts, unapproved generalized candidate, fixed KB delivery request/receipt states, and fenced claims. |
| Existing `success:<commandId>`                                        | Preserved customer confirmation proof and compatibility read behavior. Learning does not replace it or expose its private fields to customers.                                                                                                                           |
| Audit and command receipt                                             | Evidence acceptance, enrollment, withdrawal, and staff review commit their causal Audit/receipt in the same ticket partition. Existing human changes keep their causal Audit/receipt.                                                                                    |
| `learning-review:<bindingHash>`                                       | Authoritative latest staff decision for an exact source generation/binding, actual KB target binding, and policy. Historical publication approvals survive separate reviews of newer unpublished drafts.                                                                 |

Accepted eligibility, its one generation job, source update, Audit, and receipt
share one transaction. The source is read with `getVersioned` on every conflict
attempt; a `list` value is insufficient for its conditional replacement.
Standalone evidence/worker transactions conditionally rewrite the unchanged
ticket where needed to serialize with lifecycle changes, without inventing a
domain transition or increasing its revision. Job/claim changes use the source
and work versions for their own fencing.

The preallocated source adds one physical row to create admission. With durable
assistant turns and learning enabled, creation needs at least eight rows plus
the reserve without mail, or nine plus the reserve with mail. Legacy enrollment
adds source, Audit, and receipt under ordinary admission. An eligible customer
confirmation now adds four rows: existing success proof, generation work,
Audit, and receipt. A held confirmation adds the existing three and changes its
source in place. Standalone eligible evidence adds work, Audit, and receipt.

For enrolled assistant-managed tickets, the reserve is explicitly re-budgeted
to **13 physical rows and one human message** before the first staff response:
handoff three, takeover two, eligible confirmation four, first human reply with
delivery four. Handling controls must preserve the four-row/one-message reply
tail. Unenrolled assistant tickets retain the existing 12-row reserve. This
changes neither the host's configured partition cap nor its allowed maximum
(current default 512, configurable maximum 2,000). Every physical row counts
before filtering. Additional cycles remain finite and can exhaust the ordinary
documented capacity limits; learning cannot consume the reserved human tail.

Every enrolled, nonwithdrawn source additionally retains **two separate rows**
for permanent privacy/access/deletion withdrawal's Audit and receipt. Ordinary,
learning, handling, and first-human-reply admission preserve these rows;
permanent withdrawal consumes them. An enrolled assistant create therefore
needs at least 8 + 13 + 2 = 23 rows without mail, or 9 + 13 + 2 = 24 with mail.
A nonassistant enrolled create also preserves the withdrawal reserve. Already
withdrawn sources cannot silently re-enroll/reactivate, and repeated/no-op
withdrawal adds no rows. Nonprivacy evidence/policy invalidations use ordinary
finite capacity and can explicitly fail; a failed command has not revoked the
source. There is no partial revocation claim.

One private ticket-mutation planner owns the single ticket CAS plus any source
invalidation actions and reports exact net added rows. Admission occurs after
the final updated ticket is known, using that total. All five executors use the
same terminal-before/active-after predicate:

1. Handling changes, including request-person on a terminal ticket.
2. Customer web reply, after any second `human_escalated` transition.
3. Staff public reply.
4. Staff lifecycle changes, including explicit reopen.
5. Inbound email append.

Each storage retry reloads and recomputes the plan. No executor adds a second
action for the ticket or source key. Inbound admission failures retain their
existing typed limit-to-rejection mapping. Invalidation changes the existing
source row in place, so reopening/replying does not need a new learning row.

#### Fixed application API and private DTOs

`ResolutionLearningApplication` extends the existing application through fixed
operations; it accepts neither caller-supplied Store actions nor a generic
transaction callback:

| Operation                                                                        | Required binding and result                                                                                                                                                                                                       |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enrollResolutionLearning`                                                       | Command/correlation/ticket identity and current staff revision; creates the constant source under ordinary admission.                                                                                                             |
| `submitResolutionEvidence`                                                       | Exact current ticket revision/cycle, structured staff proof or opaque trusted test receipt; accepts one source generation atomically or returns a held outcome.                                                                   |
| `readResolutionLearningSource`, `readResolutionLearningWork`                     | Current authorized staff access; private source, proof, reviewer, candidate/check, and reconciliation DTOs.                                                                                                                       |
| `withdrawResolutionLearningSource`                                               | Stable command identity and privacy-withdrawal/access-revocation/deletion reason; immediately denies source eligibility, holds work, and schedules durable reconciliation.                                                        |
| `invalidateResolutionEvidence`                                                   | Explicit evidence/product-binding/check-policy revocation; advances source generation and holds/reassesses work without privacy scrubbing.                                                                                        |
| `scanResolutionLearningCandidates`                                               | One bounded physical scan page, physical row count, opaque continuation, work candidates, and separate `reconciliationSources` ticket IDs from source rows. All candidates are hints.                                             |
| `claimResolutionLearningWork`                                                    | Ticket/generation/work identity, fresh worker/claim ID and bounded lease; returns the current source fence and stage, or no claim.                                                                                                |
| `prepareResolutionLearningStep`                                                  | Exact claim/source fence and `step: "model"` or `step: "kb_delivery"`. Persists the immutable request identity and bounded state before external work.                                                                            |
| `completeResolutionLearningStep`                                                 | Exact prepared step ID/fingerprint and corresponding closed step result, with a read-only final authority/source/check guard. Stores the candidate or exact remote acknowledgement; cannot publish.                               |
| `finishResolutionLearningWork`                                                   | Exact claim/step fence and bounded retry, held, unknown, or superseded disposition/accounting.                                                                                                                                    |
| `reviewResolutionLearningProposal`                                               | Current staff decision bound to the exact actual KB draft revision/content and full source snapshot, source/evidence/product fence, policy/check versions, and reasons before KB review/publication. Cannot approve a later edit. |
| `confirmResolutionLearningSource`                                                | Service-only exact opaque source/version confirmation for the KB's current-source and publication callbacks; returns no source body.                                                                                              |
| `confirmResolutionLearningTargetReview`                                          | Service-only exact keyed target/policy review confirmation plus current source authority; independent of processing switches.                                                                                                     |
| `readResolutionLearningReconciliation`, `recordResolutionLearningReconciliation` | Service-only least-data destination view and in-place closed reconciliation result under source-generation/work-generation and destination step/hash fences; work remains usable after deletion of the ticket body.               |

Candidate scans omit expired work deadlines and work whose authoritative source
is missing, ineligible, or no longer matches its generation/cycle/binding. A
per-call cache reads at most one current source key per ticket represented by
work on the physical page; cache entries and extra source reads cannot exceed
that page's physical row count. Every adapter row still counts before filtering,
and the original opaque continuation is preserved. Current claimed/prepared
work remains a hint subject to authoritative claim checks. Omitted historical
work and unknown writes remain stored; filtering invents no terminal receipt.
Separate `reconciliationSources` discovery remains available for pending
destination work after generation expiry or source withdrawal.

The common work key is `{ ticketId, sourceGeneration }`.
`ResolutionLearningClaimFence` adds worker ID, claim ID, and monotonic claim
generation. Server-returned claim metadata binds the cycle/source fingerprint,
work generation, stage, lease, and deadline. Each physical coordinator
invocation creates a fresh cryptographic claim ID;
duplicate deliveries cannot borrow another live claim. Preparation is
idempotent only for the same fence and exact input. Expired claims cannot
complete, and a replacement claim retains prepared/unknown external work.
Prepared `stepId` is independent of claim identity. A new model attempt is
counted only when preparing a new provider request; claiming a prepared KB
delivery reuses its original step, command, and expected generation instead of
regenerating the model request. Complete/finish commands bind that step ID and
fingerprint; unknown model accounting and unknown KB acceptance remain distinct.
Finishing work before a step was prepared updates no earlier attempt's
accounting. An explicit step/hash can affect only its owning invocation's
processing data; a replacement claim cannot overwrite previously known usage.
Step ID and request hash must be supplied together. A step-less finish cannot
cancel a model preparation owned by that same live claim or any exact prepared
KB delivery; a later claim with only an older model attempt may still finish
its own pre-preparation budget/failure path without altering that old attempt.
External calls occur outside Store retry loops. Current permission checks also
protect historical receipt replay.

A model preparation binds input fingerprint/manifest hash, configuration,
prompt, model and check-policy versions, budget hash, predetermined usage
reservation, and deadline. Its compact manifest binds immutable visible-message
IDs/ordinals, working-solution references, and product context; the complete
input is rebuilt and fingerprint-checked before a call. A model completion
stores the structured candidate and bounded processing/accounting metadata;
the application computes the candidate hash. Its manifest durably includes
visible message IDs/ordinals, authoritative working-solution IDs, and stable
product fields. Preparation returns a 16,000-byte conservative UTF-16 JSON
candidate allowance and constructively reserves that complete later candidate.
Completion/finish return bounded key/step/hash/status acknowledgements; their
durable receipts never copy candidate bodies. A KB preparation binds candidate
hash, independently verified check receipt, and the complete canonical
create/update request. A KB completion
records request hash, historical acknowledgement (article ID, generation,
article revision, content hash, state), and the separately observed current
target binding. A historical acknowledgement is recovery evidence, never
current authority; disagreement holds work.

The dedicated application registry permissions are `learningRead`,
`learningEvidenceSubmit`, `learningProcess`, `learningReview`, and
`learningWithdraw`, under the `support.learning.*` namespace. Staff private
reads/review/evidence/withdrawal also require current queue access; processing
authority is separate from assistant answering. Existing owner confirmation
keeps its existing permission and resource ownership check. No role, Admin
inheritance, Agent Access scope, or local-agent publication authority is added.

Source references, evidence, customer identity, reviewer details, and remote
reconciliation metadata remain private. The learning model receives only the
bounded customer-visible conversation and relevant visible solution content;
internal notes and private provenance/evidence metadata are excluded.
Customer-visible system-authored text is labeled `notification` in the
conversation data, distinct from staff `support` text; it never becomes a
trusted model system-role instruction. Learning
processing requires its own current verified data controls and purpose binding;
the existing `support_answer` request contract is unchanged.

#### Independent checks before transfer and exact staff publication review

Model completion stores an **unapproved** generalized candidate only in Support
Desk. The candidate contains generalized problem, applicability, steps,
solution, and validation requirements. Its structural validity or model-declared
privacy result cannot approve it. Before any candidate body transfers to KB,
independent verified privacy, factual, applicability, and duplication checks
must be bound to that exact candidate hash/revision, source/evidence/product
fence, current policy, and proposed create/update target. Missing, failed,
unavailable, or stale checks hold the proposal in Support Desk.

The optional coordinator obtains a receipt from the host's independent check
pipeline (`LearningChecksPort.check` can accept the generalized candidate,
safe working solution, and target comparison). The application receives only
the trusted read-only verification capability. Check execution and external
calls run outside storage retry loops; verification repeats before each
affected CAS.

`LearningChecksPort.verify` is the independent pre-transfer gate. It verifies an
opaque receipt against exact candidate/source/policy/applicability and target
decision/request hashes, including the original target base generation/content/
provenance binding. It returns verified privacy/factual/applicability/duplication
results, verifier receipt identity, and expiry. All four checks must pass.
Unverified, mismatched, unknown, failed, or expired checks hold the candidate
privately in Support Desk. The processing worker cannot manufacture a positive
receipt or treat the model's own assessment as independent verification.

Successful independently verified checks allow automatic private KB draft
creation/update; there is no mandatory human pre-transfer review. Held cases
can receive staff remediation. A changed candidate, source/evidence binding,
target, applicability, inherited references, original expected generation,
policy, or check version requires fresh exact checks. Human `learningReview`
authority applies to the actual resulting KB draft before KB review/publication.

Delivery records the deterministic article ID, create/update choice, collection,
exact candidate payload/hash, full ordered private-source reference set,
original expected KB generation, and stable per-step command IDs before a KB
call. These parts form one canonical replayable request; the body is stored
once, never duplicated into prompts, manifests, or receipts. An update replaces
this ticket's stable source reference at its existing position and preserves
every other source reference and its order. Missing/unverifiable other-source
provenance holds the update instead of dropping references.

The verified KB `0.1.2` contract must atomically bind that **complete** source
reference list with both create and update in the article transaction. Its
dedicated provenance-write permission and per-reference current read checks
apply on every CAS/replay/postcommit path. Learning never splits delivery into
a draft write followed by `setProvenance`. `getProvenance` remains the authorized
read for full current and published inherited-source comparison.

KB publication remains a separate current staff approval of the exact actual
KB revision/hash, collection/audience, evidence/check versions, and all current
source bindings. Before KB review submission,
`reviewResolutionLearningProposal` records command/correlation identity,
expected work generation, approve/reject with reasons, actual article
ID/revision/content hash/collection, full source snapshot and its
generation/hash/ordered-reference hash, and current review/check-policy version.
The staff decision reviews privacy/factual/applicability/duplication for that
actual draft. A mandatory read-only target-confirmation guard checks
generation-consistent KB draft/full provenance and every source's current
eligibility before each review CAS. Transfer-time candidate hash and automated
receipt remain historical bindings; they cannot prevent staff from reviewing a
later local-agent edit of the actual draft. It intentionally does not bind a
lasting approval to KB's
aggregate generation or `KBReviewSnapshot`: evidence/governance changes remain
KB's own review responsibility. Its source callback receives the actual article
revision and source snapshot. Local draft edits need a fresh target review;
KB evidence changes independently invalidate KB approval.

Each exact review is stored at a deterministic `learning-review:<bindingHash>`
key, including source generation/binding, target revision/content/collection,
source snapshot hashes/generation/order, and policy. The source owns a bounded
review-binding count. A new exact binding adds review, Audit, and receipt
(three rows); changing approve/reject on an existing exact binding conditionally
updates it with Audit/receipt (two new rows). All use ordinary admission and
preserve both reserves. Review rows are never evicted because newer unpublished
drafts were reviewed. Confirmation reads the one exact key and current source
authority. A published revision one's approval remains valid while revisions
two and three receive separate reviews; a new source generation invalidates
every old review key. The source stores only the bounded review count; exact
keyed rows hold all review authority.
The KB integration must fail closed for an unbound intermediate draft
and recheck every source at review/publication; Support's worker cannot grant
publication by writing an empty provenance list or approving its own output.

#### Physical, request, attempt, and history bounds

| Bound                                    | Default / hard maximum or invariant                                                                                          |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Complete source or work record           | 60,000 conservative serialized UTF-16 JSON bytes, including all wrappers and escaping.                                       |
| Complete model candidate                 | 16,000 serialized UTF-16 JSON bytes; reserved before paid model work.                                                        |
| Retained generation work rows per ticket | Four / eight; exhausting this budget holds new learning without dropping a trigger or blocking the human command.            |
| Retained target articles per source      | Two / four, coalescing generations only after exact unresolved requests remain safely retained in their work rows.           |
| Exact review bindings per source         | Sixteen / 64, enforced by a constant source counter; no automatic eviction of potentially live publication approvals.        |
| Model attempts per generation            | Two / four, retained inline; no per-attempt physical rows.                                                                   |
| Claim lease                              | 60,000 / 300,000 milliseconds; actual invocation and final commit must fit the requested lease.                              |
| Worker lifetime                          | 300,000 / 3,600,000 milliseconds for active generation; expiry holds work, and never discards ambiguous external acceptance. |
| Physical scan page                       | At most Storage Core's `MAX_SCAN_PAGE_SIZE`; all adapter rows count before filtering.                                        |
| Transaction                              | At most 100 actions and exactly one action per physical key, within the configured ticket row cap.                           |
| Conflict attempts                        | Existing application setting: default four, hard maximum 20.                                                                 |

KB delivery performs one fixed create/update with atomic complete source
binding. Distinct reconciliation/retirement operations handle invalidation.
There is no separate provenance-write step, arbitrary command sequence, or
unbounded retry history.
Known/unknown acceptance and the original exact request survive a new worker
claim; an absent read does not reset the sequence or authorize a new create.
At the maximum eight generation rows and 64 review bindings, one withdrawal
scrubs those 72 rows plus ticket/source/Audit/receipt in at most 76 actions.

Preparation uses the actual complete record encoder and constructs the largest
legal subsequent completion, finish/receipt, and replacement-claim states,
including maximum JSON-escaped Unicode, IDs, timestamps, metadata, and already
retained attempts. Paid model or outbound KB work is inadmissible unless every
reachable state remains within 60,000 bytes. This is stronger than checking the
current row alone. Model candidate/finish/replacement envelopes are constructed
separately from KB acknowledgement/target envelopes: the candidate has already
been replaced by the exact KB payload at delivery preparation. Source registry
entries keep minimal destination/step/acceptance/reconciliation identities;
complete accepted target/acknowledgement bindings remain on their work row.
A legal KB request can include 32 source references and
still exceed Support's tighter record envelope; oversized proposals hold
without truncating references/text or raising the cap. The implementation must
mechanize this admission before source completion can be claimed.

#### Unknown acceptance, withdrawal, and retention

A known accepted KB operation records its original request fingerprint,
stable command identity, actual article/revision/content hash, source snapshot,
and bounded acknowledgement. After uncertain acceptance, recovery reads or
replays the **identical** prepared operation with its original expected
generation; it never recalculates that generation against newer KB state and
silently overwrites another writer. A read-only absence is not proof that a
timed-out write cannot arrive later. New generation/target admission cannot
evict an unresolved or live binding to make room.
Preparing a new generation for an article with an older ambiguous write holds
until that write has a terminal receipt, cancellation, or revision-fence proof;
it cannot replace the registry entry and erase the late-write fence. Replaying
the already prepared identical request under its own eligible generation is
the separate recovery path.

Reopen immediately makes prior source versions ineligible through authoritative
callbacks while durable work converges pending drafts to held and creates
reassessment work for published guidance. Current staff permission can still
authorize reading a historical private reference; it does not make that
reference current validation. KB source IDs are stable per ticket and carry
opaque version tokens bound to cycle/generation/evidence/product. They are not
capabilities and expose no copied conversation or credential.

Any source ineligibility fences further derivation model calls and KB draft
writes, including identical write replay after reopen or evidence revocation.
Prepared unknown writes instead retain their destination and enter read-only
reconciliation/targeted retirement; a new claim cannot resume obsolete derivation.

The host must invoke withdrawal before deleting source records or revoking
source access. The accepted transaction immediately tombstones source
eligibility, clears readable private source/evidence/candidate bodies, and
retains only the opaque source identity, minimal destination/request bindings,
withdrawal reason/time, and unresolved reconciliation state. It must not delete
the source/destination tombstone while a possible late write or dependent
published revision remains unresolved. No new outbound draft-write replay is
permitted after withdrawal; recovery is reconciliation, holding, and retirement.

Privacy withdrawal retires affected published revisions and invalidates
retrieval hints through KB's authoritative retirement flow. Reconciliation
obtains generation-consistent draft/provenance observations and checks the
**published** source snapshot: an invalid source in only a pending draft must
not retire an independently sourced published revision. Missing or unreadable
complete provenance blocks targeted cleanup and retains its mapping. Any decision to
retain independently generalized guidance requires explicit documented host
review. Source deletion/access revocation triggers the corresponding private
reference/evidence reassessment. No copied deleted ticket bodies are retained
to simplify recovery. Unknown work remains retainable until an authoritative
terminal receipt, effective cancellation/fence, or trusted reconciliation proves
that no later write can arrive; it is never cleared solely by age or absence.

Reconciliation records only `blocked`, `retired`, `unaffected_publication`, or
`write_rejected`. Every nonblocked result requires a trusted terminal receipt,
revision fence, or cancellation binding and a mandatory read-only guard over
current generation-consistent full provenance/published membership and late
write safety. There is no absent/aged-out success disposition. A compact latest
result fingerprint stays inline at the existing destination; source CAS fences
concurrent invalidation or replacement. Unknown write bodies are never replayed
after source ineligibility. Privacy withdrawal retains body-free request
identity and usage tombstones while scrubbing candidate/evidence/product copies
and private review reasons.

The reconciliation read projects each destination's minimal `requestIdentity`
from its retained prepared/withdrawn work row: exact `operation`, `commandId`,
`articleId`, and `originalExpectedGeneration`. It reads at most four work keys
per source pass, confirms the work's physical key, source generation, step,
request hash, and article identity, then rechecks the source version before
returning. A concurrent source change retries within the configured bound.
Missing or mismatched work returns an unavailable identity and requires blocked
reconciliation; no body, source-reference list, or candidate is exposed and no
identity is guessed. This path does not require the deleted ticket row.

The source's constructive future envelope reserves the longest reachable
destination acceptance/reconciliation literals (`accepted`, `confirmed`) and
the longer top-level `reconciliationPending: false` spelling, alongside maximal
receipt proof and withdrawal metadata. Earlier destination objects stay intact.

There is no cross-store atomicity. KB has no reverse-source catalog, so Support
must retain every necessary bounded destination mapping and repeat durable
reconciliation scans. A required producer operation that cannot preserve other
sources, fence an unbound intermediate draft, or safely reconcile withdrawal is
an explicit integration gap to close before enabling delivery. Source tests,
fake providers, and this checkpoint do not close host privacy, release,
full-workflow, or pilot gates.

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
