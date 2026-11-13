# @pegma/support-desk-application

Source preparation, 2026-11-13, selects synchronized `0.2.10`. Verify publication
through the [release operations](../../docs/RELEASING.md#source-version-0210)
before host adoption. The patch adds optional final browser/authority guards
and cancellation to customer success confirmation and resolution evidence.
`ConfirmCustomerSuccessOptions` and `SubmitResolutionEvidenceOptions` are
optional third arguments with `signal` and `verifyBeforeCommit`; existing
two-argument calls and return types stay valid. The host callback follows all
asynchronous proof/planning, freshly per CAS attempt, with its optional
synchronous assertion at the transaction boundary. Exact accepted receipts
recover first under current permissions and customer ownership where required,
before obsolete proof, guard or abort checks. See the
[exact options and recovery contract](../../docs/RESOLUTION_LEARNING.md#final-human-success-and-evidence-guards-0210)
and [release notes](../../docs/RELEASE_NOTES.md#0210-final-success-evidence-guards).

The verified `0.2.9` publication added optional per-attempt engineering
model-planning/completion, proposal and dispatch observations through existing
guarded kernels. Current authority, fresh proof and opaque-version checks
remain; older structural ports keep their standalone fallback. See the
[dated notes](../../docs/RELEASE_NOTES.md#029-engineering-worker-observations)
and [worker contract](../../docs/ENGINEERING_EXPORT.md#candidate-029-worker-observations).

The application exposes the optional SDK-owned
`stagedResolutionLearningDelivery` capability with its exact own `prepare`,
`write` and `complete` methods. It retains one immutable KB request, historical
acknowledgement, current target checks and atomic claim release at delivery
checkpoints. Fresh authority, Source/Work/Ticket versions, claim and deadline
fences remain required. The AI option `deliveryMode: 'staged'` requires the
original capability and methods before claiming work. Existing inline delivery
remains available to structural ports. See [staged draft delivery](../../docs/RESOLUTION_LEARNING.md#opt-in-staged-draft-delivery-029-candidate).
Complete Native Workers Free 50/100 host qualification remains pending.

The application also accepts optional `EngineeringMutationOptions` on
`submitEngineeringFollowupRetestResult` after its existing command. New writes
retain current retest evidence, signal and final host guards. Exact accepted
receipts recover under current authorization before new mutable proof.
See the [retest controls](../../docs/ENGINEERING_FOLLOWUP.md#candidate-029-retest-and-provider-controls).

Authorized customer ticket services and provider-neutral durable outbox
records for Support Desk. The host supplies an `@pegma/storage-core` `Store`
and a trusted Authorization Core access context.
The Task 15 source addition accepts optional `cannedResponses`
configuration and exposes `listCannedResponses` and pure `renderCannedResponse`.
Existing explicit staff reply/note commands accept `cannedResponse` selections
with exact preview validation and transactional content-free Audit provenance.
See [bounds, permissions and replay](../../docs/HOST_COMPOSITION.md#staff-canned-responses-task-15-source-candidate).
The host server supplies `correlationId` on commands; the application validates
and propagates it and never generates it.

The verified `0.2.9` publication includes
changes beyond the immutable `0.1.0`/`0.1.1` artifacts. SD-01 first shipped
handling/handoff foundations in `0.2.0` without model generation or a KB
dependency. See its dated
[publication receipt](../../docs/RELEASING.md#verified-029-publication-2026-11-13).
Host adoption retains its own activation gates; source checkouts and
overwritten registry versions are not release substitutes.

The published synchronized `0.2.1` patch groups independent Store reads for
assistant answering while retaining current authority, ticket and turn fences.
This package gains no KB or provider dependency. The historical
[0.2.1 receipt](../../docs/RELEASING.md#verified-021-publication-2026-11-10)
records that patch's exact artifacts; later releases retain those guards. Grouped reads do not establish a universal host query or CPU
budget.

Published `0.2.3` includes the final engineering review guards described in
the [engineering guide](../../docs/ENGINEERING_EXPORT.md). Published `0.2.4` adds
admitted customer intake, final learning draft checks, bounded assistant finish
reads and release follow-up staff checks. Published `0.2.5` adds attachments
and opt-in staged human learning reviews. See the
[release notes](../../docs/RELEASE_NOTES.md); host adoption retains its own gates.

SD-02's merged source adds opt-in `assistantTurns` and the
`AssistantTurnApplication` methods `scanAssistantTurnCandidates`,
`claimAssistantTurn`, `prepareAssistantTurnAttempt`, `completeAssistantTurn`,
and `finishAssistantTurnAttempt`. These keep bounded causal turn work beside
the ticket and expose fixed answer/escalation completion with a read-only
validation guard. They add no KB or provider dependency to this package;
the optional `@pegma/support-desk-ai` coordinator owns those integrations.
Lease/preparation/retry metadata do not bump Ticket revision, exact receipts recover
ambiguous commits, and request-person/takeover remain provider-independent.
See the [layout checkpoint](../../docs/COLLECTIONS.md#sd-02-assistant-turn-layout-checkpoint)
and [coordination guide](../../docs/ASSISTANT_COORDINATION.md). SDK validation
and publication do not establish host activation.

SD-03's merged source adds opt-in `resolutionLearning` and fixed evidence,
work, exact staff review, withdrawal, and reconciliation operations. The
[resolution learning guide](../../docs/RESOLUTION_LEARNING.md) documents the
`support.learning.*` permissions, trusted evidence ports, 13-row human reserve
plus two withdrawal rows, and source retention requirements. The public AI
learning coordinator and KB delivery integration live in the optional AI
package. This application
package still has no KB or model-provider dependency.

SD-04's merged source adds optional `engineering` evidence/work services and
bounded `engineeringPolicy` configuration. Repository policy has its own
declared collection and atomic Audit/receipts. Engineering source/work records
share the ticket partition, with independent withdrawal and terminal-result
capacity reserved before external dispatch. The optional AI package supplies
model and GitHub coordination through host ports. See the
[engineering guide](../../docs/ENGINEERING_EXPORT.md). Host adoption retains
its own activation gates after verified SDK publication.

SD-05's merged source adds optional `engineeringFollowup` services
through `EngineeringFollowupApplication`. Signed allowlisted input and current
confirmed fix-to-product/build/deployment mapping establish bounded private
follow-up work; issue closure or a release tag alone does not. Independent
issue/deployment generations and captured source/destination revocation epochs
fence stale associations. Default four, hard maximum eight semantic work sets
share the existing ticket partition; delivered work never rearms.

`prepareEngineeringFollowupBundle` requires mode `prepare` or
`staff_reassessment`. `rejectEngineeringFollowupBundle` is a local staff review
with a reason, independent of provider/export availability. The combined
`approveAndPostEngineeringFollowupWebUpdate` commits one authenticated web
notice, quota, Audit/receipt, and delivered marker while preserving status,
handling, and first-staff-response facts. No worker or email sends a notice.
Five prepaid rows and one message slot cover bundle preparation and posting;
parent engineering withdrawal scrubs children using its existing privacy reserve.
Admission checks each actual stage: exact model manifests and their completion
states before paid work, then actual bundle/request counts and later retest/post
states at bundle preparation. Retest Audit/receipts use ordinary capacity.
`recoverEngineeringFollowupPreparation` returns only an opaque accepted result
bound to the current staff actor and exact recovery intent before live work or
proof reads, preventing duplicate preparation after a lost acknowledgement.
`retryEngineeringFollowupWork` explicitly readmits held/superseded or expired
draftless model work under fresh same-semantic proof, retaining its ID and
lifetime attempt cap and reserving five rows plus a slot. Its two Audit/receipt
rows use ordinary capacity. `abandonEngineeringFollowupWork` locally holds
undelivered work without provider/proof ports, spends its own two funded rows or
ordinary capacity, and releases the remaining tail/slot while preserving history.
Both use current review and queue authority; parent withdrawal remains the
privacy-erasure operation.
The optional coordinator additionally needs follow-up read and queue grants for
new private processing/review; direct base operations retain their purpose
permissions. Metadata-only receipt replay remains available under each base
operation's current grants. Zero-row stale/unchanged/unavailable observations
are live reevaluated reads, with no persisted command receipt.
See the [release follow-up guide](../../docs/ENGINEERING_FOLLOWUP.md) for trusted
ports, explicit retry/reassessment, private KB/retest handoffs, and capacity rules.
SDK validation and publication are recorded in the receipt above; host
acceptance remains separate.

Customer create uses `support.ticket.create`; list and read both use the
documented `support.ticket.read.own` permission and then confirm authoritative
ownership; reply uses `support.ticket.reply.own`.

<a id="admitted-customer-intake-next-candidate"></a>

## Admitted customer intake (published 0.2.4)

The factory's additional `AdmittedCustomerTicketApplication` capability exposes
`createAdmittedCustomerTicket(access, command, options?)`. It returns
`{view, initialMode}`, where the recorded initial mode is `human` or
`assistant`. The view reflects current customer-visible state, so a replay
after human handoff can report initial mode `assistant` and current handling
`human-pending`.

Both fresh intake and receipt recovery require current `support.ticket.create`
and `support.ticket.read.own` authority for the original principal. The command
contains the existing command/correlation, ticket and message IDs, subject,
body, optional category and requester email, plus required preference `human`
or `assistant_if_available` and optional `disclosureVersion`. This is a closed
own-data packet. The SDK copies its permitted fields before normalization.
Notification and `initialHandling` belong to the existing
`createCustomerTicket` command.

A fresh command requires `CreateAdmittedCustomerTicketOptions.verifyBeforeCommit`.
After Store preparation, this trusted read-only callback receives the chosen
mode and returns a synchronous `() => true` assertion. The host bounds the
callback, verifies the original browser credential and current permissions for
that mode, and makes the assertion check the remaining authority and deadline.
The application requires exactly `true` immediately before its ticket
transaction. Options may also supply an abort signal.

Human preference, absent disclosure, disabled assistant handling, unconfigured
assistant turns, or an absent/null `resolveAssistantStart` result select human
support. An assistant decision requires that optional resolver to return fresh
same-principal create/read authority plus `support.ticket.assistant.start`. The host
qualifies the offered disclosure and processing path before returning that
authority. A thrown resolver error propagates. The existing handling and turn
defaults still govern the resulting ticket.

Retain the original command, ticket and message IDs, content, preference and
disclosure for exact retry. Correlation remains server tracing metadata.
Accepted replay precedes fresh routing, disclosure and worker qualification,
and can omit options. It recovers the receipt's initial mode and current owned
view. An unknown transaction result stays pending until exact replay resolves
it. A late refusal can leave the existing customer-index reservation and a
number gap. Retry reuses the reservation, and existing fenced pruning handles
an abandoned reservation.

The two-argument `createCustomerTicket` contract keeps its notification,
permission, fingerprint and historical replay behavior. Its interface remains
available to existing structural implementations. Callers using the factory's
inferred return type can also see the added capability.

Staff services use the same application factory and ticket partition:

| Method                   | Permission(s)                                     | Effect                                                                                                                                  |
| ------------------------ | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `readStaffTicket`        | `support.queue.read`                              | Authoritative ticket plus every message (including internal notes)                                                                      |
| `listStaffQueue`         | `support.queue.read`                              | Bounded projection scan; confirm each row; filter/sort in memory                                                                        |
| `listCannedResponses`    | `support.queue.read`                              | New frozen catalog snapshot per call, with frozen definitions filtered by `support.ticket.reply.any` / `support.ticket.note`; no writes |
| `queueProjectionHealth`  | (none; process-local)                             | Consecutive projection failures and last failure metadata                                                                               |
| `replyAsStaff`           | `support.queue.read` + `support.ticket.reply.any` | Customer-visible staff reply → `waiting_on_customer`; optional mail                                                                     |
| `addNote`                | `support.queue.read` + `support.ticket.note`      | Internal note; no mail; status and `customerUpdatedAt` unchanged                                                                        |
| `assignTicket`           | `support.queue.read` + `support.ticket.assign`    | Assign or unassign; status unchanged                                                                                                    |
| `changePriority`         | `support.queue.read` + `support.ticket.manage`    | Priority only; status unchanged                                                                                                         |
| `resolveTicket`          | `support.queue.read` + `support.ticket.manage`    | → `resolved` (closed tickets must reopen first)                                                                                         |
| `closeTicket`            | `support.queue.read` + `support.ticket.manage`    | → `closed` (resolved only)                                                                                                              |
| `reopenTicket`           | `support.queue.read` + `support.ticket.manage`    | resolved/closed → `waiting_on_support`                                                                                                  |
| `setTags`                | `support.queue.read` + `support.ticket.manage`    | Replace staff tags; status, customer time, and mail unchanged                                                                           |
| `readTicketAuditHistory` | `support.audit.read`                              | Ordered Audit history for one ticket                                                                                                    |

### Optional handling and human controls (SD-01)

The factory's `assistantHandlingEnabled` defaults to false. Explicit trusted
web create with `initialHandling: "assistant"` requires both create and
`support.ticket.assistant.start`. Legacy omission remains human handling with
no rewrite. No model or KB is configured by enabling these source commands.
Turning the flag off refuses new assistant creation/replies. Exact committed
replays remain available after current command permissions and customer
ownership checks, without new rows or reservations; receipts do not restore
revoked access.

| Method                             | Permission and boundary                                                                                          |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `readAssistantConversation`        | `support.ticket.assistant.read`; service-only safe messages plus revision/handling/customer-trigger fences       |
| `replyAsAssistant`                 | `support.ticket.assistant.reply`; exact revision/handling/trigger, attributed plain-text reply, no mail          |
| `escalateToHuman`                  | `support.ticket.assistant.escalate`; exact fences plus bounded handoff work                                      |
| `requestPerson`                    | `support.ticket.request_person.own` and ownership; deterministic human request with current customer-safe result |
| `takeOverTicket`                   | Queue read plus `support.ticket.take_over`; exact revision/handling fences and historical staff result           |
| `confirmCustomerSuccess`           | `support.ticket.confirm_success.own` and ownership/current visible-message proof; always resolves                |
| `readCustomerSuccessConfirmations` | Queue read plus audit read; private text-free confirmation evidence                                              |

`readHandoffWork(access, ticketId)` requires queue read and returns bounded
staff-only work DTOs with summary/guide IDs/transcript references, separate
from historical staff replay and customer/assistant results.

Assistant reads omit internal notes and requester identity. Their extra
revision/generation metadata is service-only. Assistant commits require the
latest visible message to remain the triggering customer message; new input
or human handling defeats stale work. Only a public staff reply establishes
`firstStaffRespondedAt`. Staff reopen enters human-pending for explicit
handling; fresh inbound mail and verified email into assistant chat use humans.

Customer confirmation supplies `lastSeenVisibleMessageId`, never internal
revision/generation or free-form evidence. It always resolves (no optional
flag), requires reopening closed work, and stores proof privately. Already
human active requests and repeated accepted resolved proof add no rows.
Assistant reply/escalation return only bounded `HandlingCommandResult` fields.
Ticket change, work/evidence, Audit, and replay receipt commit together;
handoff stores bounded summary/guide IDs and transcript references, not copied
transcripts, notes, or mail jobs.

Default `listStaffQueue` uses `handling: "human"`; `"assistant"`/`"all"`
are explicit supervision views. Quota `assistantManaged` reserves 12 ordinary
rows and one human message slot until the first staff response; controls keep
a four-row/one-message tail. Legacy quotas retain their limits. Repeated
no-ops avoid churn, but finite control cycles remain subject to named capacity.
See [host composition](../../docs/HOST_COMPOSITION.md#optional-handling-and-deterministic-controls-sd-01)
and [collections](../../docs/COLLECTIONS.md#sd-01-handling-and-handoff-layout-checkpoint)
for exact admission, replay, and source/release boundaries.

Handoff summaries are limited to 2,000 UTF-16 code units with
`SupportDeskLimitError` field `handoff_summary`. Complete serialized assistant
message/handoff records, including wrappers, are limited to 60,000 UTF-16
bytes with field `serialized_record`; refusal occurs before commit.

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

A valid positive older active hint can discover a newer active canonical
ticket, including a human handoff, without waiting for projection repair.
Malformed, nonpositive, future-revision, and inactive hints are refused;
canonical fields alone govern handling/filter/sort. Missing or inactive hints
can still cause a temporary repair gap.

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

Accepted-change history is exact `@pegma/audit@0.2.0` projected into the
ticket partition with `defineAudit`. Customer create/reply and every staff
mutation drop Audit transaction actions beside the state change; history is
read through `readTicketAuditHistory` / Audit, not a private sorter. Domain
`TicketEvent` remains pure workflow input and is not stored as a second audit
shape. Authorization Core is exact `0.4.0`.

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
`@pegma/mail@0.1.1`. Support Desk keeps its `delivery:*` physical record and
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
