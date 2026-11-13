# Release notes

<a id="029-engineering-worker-observations"></a>

## 0.2.9 candidate — per-attempt engineering worker observations

All five local package versions and exact internal Support pins target
unpublished `0.2.9`. Exact KB application/contracts now pin verified public
`0.1.7`, requiring fresh SDK graph qualification. Published `0.2.8` retains KB `0.1.6`; Authorization Core `0.4.0`
remains unchanged. The AI manifest adds exact direct
`zod@4.4.3` and `@pegma/storage-core@0.4.0` dependencies. The root stays private
at `0.0.0`.

Optional application model-planning, model preparation/completion, proposal
and dispatch methods share the existing mutation kernels. Their observations
are authorized and callback-scoped. Fresh proof, service authority, Source/Work
opaque-version confirmation and final deadline/transaction fences still run.
The AI coordinator selects these optional methods when supplied; older
structural ports retain the complete standalone fallback. No host may retain
an observation as authority for a later attempt.

Exact model completion retries recover the accepted command fingerprint under
current processing authority before obsolete Source/proof work. Permanent
withdrawal can avoid futile finish retries without converting pending work or
unknown usage to success. Existing known-usage accounting, approval, one-shot
issue creation and reconciliation contracts remain. There is no new record
layout, permission, model opportunity, queue or automatic activation.

See the [worker observation contract](ENGINEERING_EXPORT.md#candidate-029-worker-observations)
and [upgrade guidance](UPGRADING.md#unpublished-029-engineering-worker-observations).
These source changes do not establish a complete host query/CPU budget,
provider qualification or registry publication.

### Staff canned responses (Task 15 source addition)

The optional deployment-owned `cannedResponses` catalog supplies bounded,
immutable plain-text versions for staff preview and explicit reply/note commands.
`listCannedResponses` filters definitions by current target permissions;
`renderCannedResponse` expands literal allowlisted values. A command's optional
`cannedResponse` selection must match its body and target exactly. Existing
permissions, revision fences, capacity and exact replay remain in force.
The original reply/note Audit event records content-free ID/version provenance
atomically. Customer DTOs and automatic mail gain no staff metadata. Catalog
withdrawal refuses new uses while exact accepted receipts remain recoverable.
No package versions, dependency pins or collection layouts change. See
[host composition](HOST_COMPOSITION.md#staff-canned-responses-task-15-source-candidate).

### Staged resolution learning

The optional `deliveryMode: 'staged'` separates candidate, prepare, KB write and
completion invocations. The exact SDK-owned `stagedResolutionLearningDelivery`
capability is required before claim. Durable preparation and acknowledgement
release the claim and add optional `checkpoint: 'prepared' | 'acknowledged'`
to the existing `pending`/`delivery` result. Hosts resume in later physical
invocations. Inline delivery remains the default. Both paths retain final
policy/receipt/configuration checks after KB readback and current authority,
opaque-version and conditional-write fences. See [the delivery contract](RESOLUTION_LEARNING.md#opt-in-staged-draft-delivery-029-candidate).
The SDK makes no `model.generate` call in checkpoint invocations. Custom check ports
retain their own billing policy. Complete Native Workers Free 50/100
qualification remains pending.

Staged `reconcileSource` advances one unconfirmed destination per invocation
and yields after one exact retirement attempt, including unknown ACKs. Later
readback records verified reconciliation through the existing result union.
Fresh retirement authority and Source-view confirmation remain required.
Inline reconciliation retains its bounded retry behavior.

### Optional OpenRouter entry

The candidate adds `@pegma/support-desk-ai/openrouter` while keeping the AI root
provider-neutral. Both independent-check constructors require an explicit
second logical host string and current host callbacks. Pegma's existing `ic2`
encoding and `pegma.dev.support-independent-checks.v2` MAC domain are preserved.
RetireGolden uses its own host binding and separate stores, keys, funding and
privacy/configuration evidence. See [the adapter contract](../packages/ai/README.md#optional-openrouter-adapter-source-candidate).

<a id="028-followup-mutation-guards"></a>

## 0.2.8 — follow-up host guards and authorized reads, 2026-11-12

All five synchronized `0.2.8` packages are published and strictly verified.
Its published AI package retains exact KB application/contracts `0.1.6`.
The unpublished `0.2.9` candidate retains these controls and pins verified public
KB `0.1.7`, requiring fresh SDK graph qualification. See the
[publication receipt](RELEASING.md#verified-028-publication-2026-11-12).
Optional `EngineeringMutationOptions` add caller cancellation and a trusted
late `verifyBeforeCommit` guard to non-post follow-up mutations. Observation,
retry, abandon and rejection accept a third argument; bundle preparation
accepts a fourth after its existing proof guard. The AI staff reassessment
options forward the same signal and late guard.

For each new transaction attempt, the callback follows SDK proof/planning
awaits, and its optional synchronous assertion plus the original signal are
checked at the transaction handoff. Current permissions and exact accepted
receipt recovery remain required. Existing omitted-option callers retain
their contracts. Web posting adds an optional per-attempt application-owned
read observation while retaining its proof, authority and delivery guarantees;
older ports keep the standalone read fallback. The optional application
`reassessEngineeringFollowupBundle` entry point owns receipt recovery, an
authorized reassessment snapshot and final opaque-version confirmation; the
AI staff helper uses it when present and retains the full legacy fallback.
No new permission, record layout,
model call, automatic customer notice or host activation is added. See the
[follow-up guard contract](ENGINEERING_FOLLOWUP.md#candidate-028-followup-host-guards).

<a id="027-engineering-read-batching"></a>

## 0.2.7 — engineering read batching, 2026-11-11

All five synchronized `0.2.7` packages and exact internal Support pins are
published and strictly verified from signed source
[`9577ae2a5769e05fb16924e06f6e0e945b4ae2fc`](https://github.com/pegma-dev/support-desk/commit/9577ae2a5769e05fb16924e06f6e0e945b4ae2fc).
See the [publication handoff](RELEASING.md#verified-027-publication-2026-11-11).
The optional AI package pins exact public KB application/contracts `0.1.6`.
The earlier published `0.2.6` tuple retains its exact KB `0.1.5` dependencies.

The answer coordinator records valid, matching and representable actual
provider usage before enforcing answer budgets. An over-budget response is
rejected and handed to human support while its known usage is reconciled under
the existing reservation identity. Invalid identity/currency or nonfinite or
unrepresentable usage retains conservative unknown-usage handling. Budget caps
and public ports are unchanged.

The optional application method `readEngineeringContext(access, fence)`
returns an authorized `EngineeringReadContext` with `source` and optional
`work`. It shares Source/Ticket hydration while retaining Source-first
permission, privacy and fence checks before Work reads, plus later opaque
Source/Work confirmations. Standalone readers retain their conditional read
order. The AI coordinator uses the context when available and keeps its
sequential Source-validation/Work fallback for structural ports that omit it.
The shared `matchesEngineeringSourceFence` helper uses the same eligibility
and fence checks. Receipt-first recovery, independent export proofs, expiry
checks and conditional transactions remain unchanged. There is no new
permission, Store primitive, cache or atomic-snapshot promise.

Approval guards may receive an optional lazy `EngineeringReviewObservation`
for the same attempt's authorized Work, Source and pre-guard policy. The AI
coordinator uses current service access and confirms Source then Work after
external proof. The existing transaction still fences Ticket/Source/Work; final
policy, late host and closing authority checks remain. Existing guards may
ignore the argument, and older structural ports retain the standalone read
fallback. The observation expires when that guard settles.

The [engineering guide](ENGINEERING_EXPORT.md#entry-points-and-authority)
describes the read phases. This change does not establish a host's complete
Workers query/CPU budget, provider qualification, deployment or activation.

<a id="026-candidate--guarded-engineering-controls"></a>

## 0.2.6 — guarded engineering controls, 2026-11-11

All five synchronized packages and exact internal Support pins are published
and strictly verified at `0.2.6`. The
[publication receipt](RELEASING.md#verified-026-publication-2026-11-11)
records the unchanged original artifacts and authenticated recovery.

Seven engineering application controls accept an optional third
`EngineeringMutationOptions` argument: enrollment, evidence submission,
repository selection, withdrawal, invalidation, policy update and emergency
export disable. A caller can provide an `AbortSignal` and a trusted read-only
`verifyBeforeCommit` callback. For a new write, the callback runs after SDK
proof/planning awaits; its optional synchronous `() => true` assertion and the
original signal are checked at the conditional transaction boundary. Each OCC
retry obtains a fresh callback result. Existing callers can omit the options.

Exact accepted receipts retain their current permission checks and return
without invoking new guard/proof work. Cancellation before transaction handoff
excludes a new commit; an uncertain handoff still needs exact-command recovery.
This does not make independent host authority stores part of the Support
transaction. See the [engineering contract](ENGINEERING_EXPORT.md#026-candidate-guarded-engineering-controls)
and [upgrade guide](UPGRADING.md#unpublished-026-guarded-engineering-controls).
The release adds no layout, model/provider dependency or AI coordinator method.
Its exact KB pins remain `0.1.5`; host qualification and activation remain separate.

<a id="025-candidate--attachments-and-staged-human-learning-reviews"></a>

## 0.2.5 — attachments and staged human learning reviews, 2026-11-11

All five synchronized packages and internal Support pins are published and
strictly verified at `0.2.5`. The release combines the
[attachment APIs](ATTACHMENTS.md) with opt-in
[staged human learning reviews](RESOLUTION_LEARNING.md#opt-in-staged-human-review-source-candidate).
The default learning reviewer remains inline. Staged admission retains an exact
human command for a proof phase and a later commit phase, each with fresh
current authority and complete source, draft and policy checks. Unknown ACKs,
cancellation and exact receipt recovery retain their command ownership.

The [upgrade guide](UPGRADING.md#unpublished-025-attachments-and-staged-learning-reviews)
records the additive capability, record kinds, retained-attempt limit and typed
outcomes. Attachment storage, scanners and retention remain host-owned, and
inbound mail still drops attachments. AI keeps exact KB application/contracts
`0.1.5`. The [publication receipt](RELEASING.md#verified-025-publication-2026-11-11)
binds the original artifacts, executed gates and authenticated recovery.
SDK qualification establishes no universal query/CPU allowance or host activation.

## 0.2.4 — admitted intake and final host checks, 2026-11-11

An optional receipt-first customer create operation records the original
human/assistant mode in the existing atomic create receipt. New writes use a
closed own-data packet and a trusted final authority assertion. Exact replay
can recover after assistant qualification changes. Existing create callers
keep their two-argument API, notification and historical fingerprints.
[Application contract](../packages/application/README.md#admitted-customer-intake-next-candidate)

Staff can prepare a new learning review for an edited draft of the same article
and collection when the complete source provenance still matches its delivery.
Learning preparation and new review proofs compare the complete current KB
draft again after late policy and authority reads. Follow-up posting accepts
a bounded late staff-authority callback and retains the final proof assertion
through the application commit boundary. This release also groups bounded
assistant finish reads with the existing failure and replay ordering.
[Learning guide](RESOLUTION_LEARNING.md) · [Follow-up guide](ENGINEERING_FOLLOWUP.md)

All five exact `0.2.4` packages are published and strictly verified. The
[publication receipt](RELEASING.md#verified-024-publication-2026-11-11) binds the
original artifacts, executed gates and authenticated publication recovery.
Learning source, work and confirmation reads share one bounded versioned
partition observation within each read. Later proof phases take fresh views,
and source confirmation retains its final opaque-version check. Each host
still needs to measure its complete invocation against its configured limits.
Package qualification leaves host activation and whole-invocation/CPU
acceptance to their separate measured gates.

## 0.2.3 — final engineering review guards, 2026-11-10

All five exact `0.2.3` packages are published and strictly verified, with
matching internal Support pins. The optional AI package keeps exact KB
application/contracts `0.1.5` dependencies. The
[publication receipt](RELEASING.md#verified-023-publication-2026-11-10) binds the
original gates and artifacts, failed attempts, successful publication recovery
and final registry/consumer verification.

For new `reviewEngineeringProposal` approval, the application completes its
repository/policy observations before invoking the supplied commit guard, then
rechecks the original reviewer's permissions and verification expiry before
the existing partition CAS. Rejection honors a supplied guard at the final
boundary without requiring repository, routing, model or export proofs. The
coordinator supplies a current-staff rejection guard; trusted direct application
callers may still omit a rejection guard. Exact accepted receipts replay first
under current review/queue authorization.

Approval also preserves its earliest verified proof expiry across the awaited
host check and the synchronous commit assertion. The correction supplies bounded
fresh observations around a partition commit. See the
[engineering guide](ENGINEERING_EXPORT.md). Host/provider/client/privacy, Free
CPU and activation gates remain separate.

## 0.2.2 — staged retrieval and exact review recovery, 2026-11-10

All five exact `0.2.2` packages are published and strictly verified. The optional
AI package advances its exact KB application/contracts runtime dependencies to
`0.1.5`; repository development/test pins use the same versions. The release's
Node 22/24 gates, original prepared artifacts, trusted publication and strict
registry/consumer verification are bound in the
[2026-11-10 publication receipt](RELEASING.md#verified-022-publication-2026-11-10).
Published `0.2.1` artifacts retain their exact KB `0.1.2` dependencies and
immutable verification history.

[Opt-in staged retrieval](ASSISTANT_COORDINATION.md#opt-in-durable-staged-retrieval)
splits preparation and paid generation across separate physical invocations;
see the [AI package guide](../packages/ai/README.md#opt-in-staged-retrieval-022).
Omission retains the monolithic path. Preparation consumes an existing attempt,
so both application and verified-configuration caps must allow at least two
attempts, without resetting counters or raising caps. After `prepared`, the
host must return and resume only in a subsequent physical invocation.

`AssistantProcessResult` adds a public `prepared` union member with `ticketId`,
`turnId`, `preparationAttemptId` and `nextAttemptAt`. Exhaustive TypeScript
handlers must add this case when upgrading, even if `stagedRetrieval` is omitted
or `false`: the exported return type widens independently of runtime opt-in.
Only opt-in staging returns `prepared`. Return from that physical invocation
and schedule a genuine later invocation at or after `nextAttemptAt`; calling
again in the same invocation or through `waitUntil` is not a continuation.

Staged resume requires identical complete validated configuration and customer-
authority snapshots, not merely matching version labels. This includes
`dataControls.verifiedAt`, `dataControls.validUntil` and opaque `usageScopeRef`.
Renewed attestations or a reissued scope invalidate preparation even with
unchanged versions and logical settings. This intentionally fails closed to
finish/handoff before new usage reservation or a model call. Fresh live
validation remains required; do not ignore fields or reuse stale evidence to
force a match.

The release also adds [exact learning review recovery](RESOLUTION_LEARNING.md#exact-review-intent-recovery-022).
Read-only preparation returns the actual draft and full immutable intent;
submission, receipt read and explicit atomic cancellation share its original
actor/command/decision binding. Historical acceptance can replay after source
reopen/withdrawal. A null receipt read remains nonterminal. Cancellation either
recovers acceptance or fences a late original write at the same ticket command
key with Audit; it never revokes an accepted review or publishes guidance.
Current human authority, new-submission proof checks and finite admission remain.
Legacy accepted fingerprints and generic receipt rows are preserved; new intent
commands add optional `intentBinding`, and older callers fail closed on those
commands or cancellation fingerprints. Hosts must adopt the new union and keep
unknown packets until an exact accepted/cancelled acknowledgement.

This qualifies the exact SDK release. Host adoption separately requires its own
published dependency graph, invocation/CPU measurements and acceptance; the
protocol establishes no universal Free-plan budget. The dated `0.2.1` and
`0.2.0` receipts and original artifacts below remain unchanged.

## 0.2.1 — assistant-answering read batching, 2026-11-10

This published synchronized patch advances contracts, core, templates, application,
and optional `@pegma/support-desk-ai` to `0.2.1`, with matching exact internal
Support pins. The application groups independent answering reads for Store
adapters that can batch them while retaining current authority, ticket and
assistant-turn fences and customer/private-message boundaries.

The base application remains independent of KB and model providers. The
optional AI package retains exact KB application and contracts `0.1.2` pins.
No universal query or CPU budget, host activation, or live-provider acceptance
is established by SDK publication.

All five exact `0.2.1` packages completed Node 22/24 validation, review,
packed-consumer checks, trusted publication and strict registry verification.
The [2026-11-10 publication receipt](RELEASING.md#verified-021-publication-2026-11-10)
binds their signed source, original prepared artifacts and final verification.
The dated `0.2.0` receipt and earlier immutable artifacts below are unchanged;
host adoption and activation retain their own acceptance gates.

## 0.2.0 — synchronized optional AI workflows (SD-06), 2026-11-08

All five packages are published and strictly verified at exact `0.2.0`:
contracts, core, templates, application, and optional `@pegma/support-desk-ai`.
The [publication receipt](RELEASING.md#verified-sd-06-publication-2026-11-08)
records the exact signed source, original artifacts and registry verification.
The original four published `0.1.1` artifacts remain immutable. Hosts consume
the verified synchronized registry set and retain their own activation gates.

The release includes the merged source phases:

| Phase | Source and behavior                                                                                                                                                                                                               |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SD-01 | [PR #34](https://github.com/pegma-dev/support-desk/pull/34): optional assistant handling, deterministic human controls, bounded handoffs, and explicit customer success confirmation.                                             |
| SD-02 | [PR #38](https://github.com/pegma-dev/support-desk/pull/38): bounded assistant jobs, current-source/authority fences, durable usage recovery, and exact answer or human-handoff commit.                                           |
| SD-03 | [PR #39](https://github.com/pegma-dev/support-desk/pull/39): private resolution evidence and learning drafts, independent delivery checks, exact KB requests, review/publication source gates, and conditional cleanup.           |
| SD-04 | [PR #40](https://github.com/pegma-dev/support-desk/pull/40): verified bug evidence, bounded repository policy and routing, exact sanitized export review, one physical issue-create attempt, and uncertain-result reconciliation. |
| SD-05 | [PR #41](https://github.com/pegma-dev/support-desk/pull/41): trusted issue/deployment observations, private reassessment proposals, optional advisory retests, and explicit staff-reviewed web notices.                           |

Historical Phase 5 source validation at
`eddd3526f8bec3a1a80cc7aacd3a4cdcdb950cfe` recorded **2,173 tests across 48
test files**, with separate release-metadata, five-package pack, and example
receipts. That receipt describes the merged SD-05 source. It does not certify
the new SD-06 artifacts, registry-to-candidate migration, or publication.

The base application remains independent of KB, model providers, and GitHub.
Human support works with optional AI disabled. The optional AI package uses
exact verified KB `0.1.2`; the release uses Authorization Core `0.4.0` and
Spine `0.1.2`. New permissions, trusted ports, finite reserves, current proof,
and host-owned scheduling are explicit opt-ins. No workflow automatically
publishes KB content, resolves a ticket from a release, or grants host roles.

The new AI name has a separate manual registration-only `0.1.1`
[bootstrap](AI_BOOTSTRAP.md). It has no OIDC provenance and is not host-usable:
the older registry application `0.1.1` lacks required newer exports. That
registration is separate from the advertised five-package `0.2.0` release.

Read [upgrading](UPGRADING.md) before writing new rows. The clean-consumer
upgrade proof must start with the actual old published application; it does
not promise that older codecs can read new records. The operational fallback
is human support on the new SDK with generation/export disabled, while
recovery and reconciliation remain available. See [AI operations](AI_OPERATIONS.md)
and the individual [answer](ASSISTANT_COORDINATION.md),
[learning](RESOLUTION_LEARNING.md), [export](ENGINEERING_EXPORT.md), and
[follow-up](ENGINEERING_FOLLOWUP.md) handbooks.

The [publication receipt](RELEASING.md#verified-sd-06-publication-2026-11-08)
records the completed SDK gates, original artifacts, consumers and strict
stable verification. Subsequent changes need their own current-head gates and
reviews; SDK release evidence does not establish host provider configuration.
Actual host login/Admin consent, requested clients, privacy controls, staging,
durable-store production evidence, full workflows, and supervised pilots remain
separate host gates. Synthetic SDK examples use fictional data and close none
of those acceptance gates.

## Merged source history — handling and deterministic controls (SD-01)

Implemented via [PR #34](https://github.com/pegma-dev/support-desk/pull/34)
without a publication change at that time; included in the release above.
Task 12's host production-evidence gates remain open.

- Optional web-only assistant handling requires trusted host opt-in and
  dedicated permissions. Assistant attribution and exact ticket revision,
  handling generation, and triggering-message checks prevent stale replies;
  assistant messages never satisfy the first staff response milestone.
- Human queue selection confirms current authoritative handling. Owned
  request-person, staff takeover, and escalation work without a model; handoff
  state, compact transcript references, bounded work, Audit, and receipts
  commit together. Staff reopen routes explicit handling to human-pending.
- Explicit owned customer success confirmation binds the latest visible
  message and resolves with private structured evidence in the same
  transaction. Internal revisions, notes, and evidence stay out of customer
  responses. Repeating an already satisfied control adds no rows.
- Disabling assistant handling blocks fresh assistant starts and replies.
  Previously accepted create/reply commands can still replay after current
  permission and resource checks. Human controls and escalation remain
  available under their own checks.
- Handoff summaries are capped at 2,000 UTF-16 code units; attempted guides at
  16 opaque IDs of 200 units each. Complete serialized handoff and assistant
  message records are capped at 60,000 UTF-16 bytes before commit. Managed
  quotas preserve 12 physical rows and one human message slot across ordinary
  writes until the first staff response; controls retain a four-row/one-message
  tail for that reply. Hard partition limits still apply.

Upgrade: omitted legacy handling remains implicit human-pending without a
stored migration; existing omitted-option fingerprints and quota limits are
preserved. Explicit takeover records human-active handling. Fresh email stays
human-handled, and verified email joining assistant chat hands off to humans.
Run the existing queue repair cycle. See
[host composition](HOST_COMPOSITION.md#optional-handling-and-deterministic-controls-sd-01)
and [capacity details](COLLECTIONS.md#sd-01-handling-and-handoff-layout-checkpoint).

SD-01 alone added no model integration, KB dependency, or new package.
Subsequent phases are included in the synchronized release above. Producer
publication and host acceptance are distinct; the
[producer evidence](HOST_COMPOSITION.md#kb-authoring-producers) does not replace
actual host login/Admin consent, requested-client, privacy, full-workflow, or
pilot evidence.

## Merged source history — lifecycle extras (Buildout Task 13)

Additive package work originally made against source `0.1.1`, without a
publication change then; included in the release above. Task 12 remains
pending on the hosts' durable-store production evidence.

- Optional bounded host `allowedTags` and `maxTagsPerTicket`; staff `setTags`
  with `support.ticket.manage`, normalized idempotency, transactional
  `support.ticket.tags_changed` Audit action, and staff-time-only changes.
- Optional `ResponseTargetPolicy` on application and inbound processing;
  canonical first-response/resolution due dates, one-time first staff response,
  current-resolution milestones, and confirmed queue tag/target filters and due
  sorting. Hosts own calendars and presence. Customer DTOs and automatic
  customer mail omit the new staff fields.
- Optional `expectedRevision` on every staff mutation and content-safe
  `SupportDeskStaleRevisionError` (HTTP 409). Exact new staff receipts replay
  the original ticket and message revision cutoff even after later edits.

Upgrade: existing tickets and receipts remain readable. Missing tags mean no
tags; absent targets do not match due filters; first-response milestones are
not inferred from history. Configure the same target policy on web and inbound
composition, and run a complete queue repair cycle to enrich legacy projection
rows. No automatic target backfill or new worker is introduced. See
[host composition](HOST_COMPOSITION.md#optional-lifecycle-extras-task-13).

## Merged source history — inbound mail (Buildout Task 11)

Originally additive to the `0.1.1` source surface without publication;
included in the synchronized release above.

- `@pegma/support-desk-application`: `createInboundMailProcessor` with the
  `InboundEmailInput`, `InboundAccountMatcher`, `InboundRoutingPolicy`, and
  `InboundNotificationPolicy` ports; the implemented inbound receipt
  lifecycle; the new `support-desk.thread-index.v1` collection with
  `repairThreadIndexPage` and `sweepThreadIndexPage`; optional
  `replyRoutingToken` on `NotificationInput` and `DeliveryContent`; optional
  receipt fields for reserved identifiers, routing, and outcome. Existing
  email-backed ticket joins also require the snapshotted host sender result to
  pass for the same normalized address. Receipt fingerprints use that same
  case-insensitive address equivalence, `host_identity` rejects DMARC-only
  alignment fields, and a repeated inbound `Message-ID` precedes the
  subject-marker fallback.
- `@pegma/support-desk-contracts`: `InboundSenderAuthentication`, optional
  staff-only `Ticket.relatedTicketId`, and
  `CreateTicketInput.relatedTicketId`.
- `@pegma/support-desk-core`: `createTicket` validates and preserves
  `relatedTicketId`.

Upgrade note: after deploying, run one complete `repairThreadIndexPage` cycle
so tickets and notifications recorded earlier gain threading rows. Hosts must
populate `senderAuthentication` before email-backed tickets can accept replies;
email-less tickets retain their high-entropy routing-token flow. Processing
receipts carrying an older reply route are rechecked before ticket work, while
an already committed command retains its replay result. A nonqualifying older
route first claims a resumable `rerouting` receipt. Reply normalization reserves
one permanent fence in the named ticket partition; the fence counts toward
`maxRecordsPerTicket` and is refused when the partition has no remaining record
capacity. Related-conversation normalization uses a temporary command-key fence
that the normalized create consumes. Receipts without the canonical replay
field recognize only the exact earlier payload shapes and atomically bind the
current replay fingerprint; their immutable payload fingerprint continues to
identify ticket work already committed before receipt finalization.

## 0.1.1 — dependency alignment

A dependency-only release of the synchronized four-package set.
`@pegma/support-desk-application` advances `@pegma/audit` to `0.2.0`,
`@pegma/authorization-core` to `0.2.0`, and `@pegma/mail` to `0.1.1`, so the
dependency tree resolves a single `@pegma/storage-core@0.4.0` — previously
audit's transitive `storage-core@0.3.0` split hosts' trees into two
incompatible `Store` types. The application package already required a
storage-core `0.4.0` `Store`; runtime behavior and the public API of all four
packages are unchanged.

## 0.1.0 — first advertised supported release

Status: published. All four packages are on the public npm registry at exact
`0.1.0`, and the signed annotated `v0.1.0` tag and its GitHub release mark
the release commit. Hosts may depend on the published packages; a Git branch,
copied source, local path, or unpublished tarball remains forbidden as a
production dependency.

### Packages

| Package                           | Version |
| --------------------------------- | ------- |
| `@pegma/support-desk-contracts`   | `0.1.0` |
| `@pegma/support-desk-core`        | `0.1.0` |
| `@pegma/support-desk-templates`   | `0.1.0` |
| `@pegma/support-desk-application` | `0.1.0` |

### Surface

- provider-neutral ticket, message, requester, and lifecycle contracts;
- pure ticket creation and revisioned workflow transitions;
- authorized customer create/list/read/reply with safe customer DTOs;
- authorized staff detail, mutations, audit history, and repairable queue
  projection;
- transactional `@pegma/audit@0.1.0` accepted-change records and
  `@pegma/mail@0.1.0` delivery projection in the ticket partition;
- safe versioned templates with an optional RetireGolden-branded pack export;
- host-owned worker entry points for mail send/reconcile/sweep, queue repair
  and inactive-row sweep, customer-index prune, and receipt sweeps.

### Exact dependencies

- `@pegma/spine@0.1.1`
- `@pegma/storage-core@0.4.0`
- `@pegma/authorization-core@0.1.2`
- `@pegma/audit@0.1.0`
- `@pegma/mail@0.1.0`

### Host integration

See [HOST_COMPOSITION.md](HOST_COMPOSITION.md) for error-to-HTTP mapping and
scheduler ownership, [RELEASING.md](RELEASING.md) for publication, and
[examples/composition](../examples/composition/README.md) for a memory-backed
end-to-end composition with no framework.
