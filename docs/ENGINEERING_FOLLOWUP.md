# Release follow-up: SD-05 source contracts

SD-05's source merged in [PR #41](https://github.com/pegma-dev/support-desk/pull/41)
and first shipped in the verified synchronized
[`0.2.0` release](RELEASING.md#verified-sd-06-publication-2026-11-08).
The current synchronized release is `0.2.8`; see its
[publication receipt](RELEASING.md#verified-028-publication-2026-11-12).
This handbook describes its contracts and host responsibilities, not deployment
or host acceptance. SD-04 merged in
[PR #40](https://github.com/pegma-dev/support-desk/pull/40). Scope comes from the
[approved release follow-up plan](KNOWLEDGE_AI_PLAN.md#release-follow-up)
and [collection checkpoint](COLLECTIONS.md#sd-05-release-follow-up-layout-checkpoint).
There is no runnable host recipe here.

## Entry points and trusted release facts

`createSupportDeskApplication` exposes
[EngineeringFollowupApplication](../packages/application/src/engineering-followup-types.ts).
The host calls `observeEngineeringFollowup` with a registered repository/issue
association and an opaque input reference. `EngineeringFollowupReleaseEvidencePort`
verifies signed, allowlisted normalized input and confirms current issue and
deployment heads plus the fix-to-product/build/deployment mapping. A webhook is
a refresh hint. Issue closure, a merged PR, a tag, or a package release alone
does not prove that the affected customer has the fix.

Issue and deployment generations advance independently. Lower generations are
stale; equal generations with different hashes conflict. A rollback to an older
build still needs a newer deployment generation. Reconfirm the exact mapping
and current heads at model preparation, bundle preparation, reassessment, and
staff posting. These are versioned observations across systems, without an
atomic transaction with the provider or deployment platform.

Stale, unchanged, and proof-or-association-unavailable observations that change
no durable state are live reads. They append no receipt and reserve no command
ID; retrying them reevaluates current authority and proof. This zero-row
coalescing keeps repeated webhook hints from consuming finite ticket capacity.
Exact replay receipts acknowledge committed changes, rather than caching every
observation result.

`scanEngineeringFollowups` returns one bounded physical page with association,
processing, review, and source-attention hints. Every adapter-returned row
counts before filtering. The host persists the unmodified `nextCursor`, repeats
scan cycles, and confirms work through `readEngineeringFollowupWork`. A hint
grants no authority. Current access and restricted-read boundaries still apply.

The optional `createSupportDeskReleaseFollowup` follows the
[AI port contracts](../packages/ai/src/release-followup-ports.ts):

| Method                     | Boundary                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------- |
| `scanCandidates`           | Delegates bounded application discovery; the host owns cursors.                             |
| `processWork`              | Prepares a private candidate and checked bundle under a fresh physical claim.               |
| `prepareStaffReassessment` | Rechecks retained content or explicit staff edits with fresh proof and whole-bundle checks. |
| `approveAndPostWebUpdate`  | Rechecks the exact bundle and current staff authority before the atomic web notice.         |

The coordinator uses these current `supportPermissions` grants:

- `scanCandidates`: `engineeringFollowupProcess`, or
  `engineeringFollowupReview` plus `queueRead`. This body-free scan needs no
  private-read grant and gives reviewers no processing permission.
- `processWork`: `engineeringFollowupProcess`, `engineeringFollowupRead`, and
  `queueRead`, checked before claiming, preparation, usage reservation, or a
  provider call.
- New staff reassessment: `engineeringFollowupRead`,
  `engineeringFollowupReview`, and `queueRead`.
- New staff posting: the same read/review/queue grants plus `replyAny`.

The additional read grants cover the coordinator's private detail reads; direct
base application operations retain their narrower named purpose permissions.
Permission names imply no role inheritance.

The base application remains independent of a model, GitHub client, and KB.
`rejectEngineeringFollowupBundle` records an exact private staff rejection with
a reason under current review and queue authority. It needs no provider,
export service, or model configuration.

<a id="candidate-028-followup-host-guards"></a>

## Published 0.2.8 follow-up host guards

These `0.2.8` source additions, retained in `0.2.9`, reuse `EngineeringMutationOptions` for optional
`signal` and trusted read-only `verifyBeforeCommit` control on these calls:

| Application method                  | Options position                                |
| ----------------------------------- | ----------------------------------------------- |
| `observeEngineeringFollowup`        | Third argument                                  |
| `retryEngineeringFollowupWork`      | Third argument                                  |
| `abandonEngineeringFollowupWork`    | Third argument                                  |
| `rejectEngineeringFollowupBundle`   | Third argument                                  |
| `prepareEngineeringFollowupBundle`  | Fourth argument, after the existing proof guard |
| `reassessEngineeringFollowupBundle` | Fourth argument, after the reassessment planner |

The optional AI `prepareStaffReassessment` options forward the signal and late
host guard to bundle preparation. The AI coordinator composes the caller
assertion with its original staff, invocation and checked-proof deadline fences,
including after the host wait. These options do not replace SDK release,
privacy or whole-bundle proof. For every new transaction attempt, the late host
callback follows awaited proof and planning; its optional synchronous
`() => true` assertion and the original signal are checked at transaction
handoff with current permissions. A conflict obtains a fresh guard result.

At the application boundary, exact accepted receipts still require current
authorization and return before new mutable proof, the late host guard and the
new mutation-options cancellation check. The AI invocation retains its existing
`run.signal` cancellation behavior, including receipt reads. Existing omitted
options and void-returning guards remain supported. Delegating adapters must
forward the new options argument and any returned synchronous assertion
unchanged when adopting these controls. Read-only coalesced
observations retain their existing zero-row semantics. Cancellation bounds
new work and cannot undo an already committed change. Web posting retains its
existing proof, host guard and delivery guarantees, with the optional read
observation below. No role, permission, record layout, model call or automatic
customer notification is added.

### Candidate 0.2.9 retest and provider controls

The unpublished candidate adds optional `EngineeringMutationOptions` as the
third argument to `submitEngineeringFollowupRetestResult`. A new retest write
checks its original signal and late host guard after awaited evidence and at
transaction handoff. Current-authorized exact accepted receipts recover before
new mutable evidence or host controls. The existing trusted retest receipt
still binds the actual request, bundle, product/build, execution and runner.

The optional [SD05 OpenRouter adapter](../packages/ai/README.md#release-follow-up-provider-ports)
provides purpose-specific generator/evaluation/usage and whole-bundle check
ports. Its route, privacy, tokenizer and checker qualification stay explicit;
provider and host activation remain pending. Retest requests remain advisory
until the owning trusted evidence workflow verifies their actual execution.

<a id="candidate-029-followup-invocations"></a>

### Candidate 0.2.9 physical invocation phases

Set `invocationMode: 'staged'` on the AI coordinator to separate durable model
planning, one provider attempt and candidate completion. The actual application
must expose `planEngineeringFollowupModel`, `beginEngineeringFollowupModel` and
`recordEngineeringFollowupModel`. The checks port must expose its non-provider
`prepare` capability. Missing capabilities hold before claiming. Omitting the
option preserves the existing monolithic flow.

| Physical invocation                               | Durable result                                                      | Provider entry             |
| ------------------------------------------------- | ------------------------------------------------------------------- | -------------------------- |
| Plan the exact bounded input                      | `pending`, `checkpoint: 'model_planned'`, `callState: 'not_called'` | None                       |
| Conditionally begin and retain the bounded result | `pending`, `checkpoint: 'model_recorded'`, `callState: 'recorded'`  | At most one generator call |
| Complete the retained candidate with fresh guards | `candidate`                                                         | None                       |

Planning releases the claim with an explicit not-called attempt. The next
invocation freshly checks authority, configuration, evaluation, policy, release
facts and the original Source binding. Its conditional begin marks the attempt
possibly called before the provider callback. A lost begin or provider ACK
keeps unknown accounting and holds that attempt. It cannot become not-called or
automatically invoke the provider again. A retained result grants no bundle or
posting authority. Completion requires fresh guards and the exact retained
candidate. A lost planning or result-recording ACK resumes the same durable
state. Existing ambiguous `model_prepared` rows retain their unknown meaning.

Each staged mutation supplies a callback-only `EngineeringFollowupModelObservation`.
Its optional `readProof(access)` returns an immutable snapshot of that mutation's
fresh App proof under the same caller and read permissions. It expires with the
guard. The coordinator compares its exact Work and public facts, then retains
fresh policy, evaluation, configuration, authority and final opaque-version
checks. The claim proof supplies planning input only. Older structural
observations retain the full proof-read fallback.

All three model invocations share one configured model-attempt identity. A
configured application and model ceiling of one remains supported. Staging
preserves lease limits, lifetime attempt counts, usage reservations and the
original Work deadline. The host must schedule each continuation in a later
physical invocation within those bounds.

The optional `./openrouter` checks controller accepts `deferred: true` for
`forWork`. Its `prepare` persists a bounded private request and returns a
body-free deferred operation. `scanPending` returns at most 32 operation hints
with scope, expiry and `provider` or `receipt` phase. `precomputePending` first
conditionally owns one provider attempt, performs the real fresh pre-fetch
checks, accounts actual usage and durably records a received verdict. Its
`received` outcome carries no `sf1` receipt. A later invocation freshly confirms
the Source, authority, policy, configuration and key before committing a checked
receipt. A checked replay also revalidates current proof and invokes no provider.
Unknown or claimed attempts cannot generate again.

The coordinator returns `checks_planned` with `callState: 'not_called'` for a
queued operation and `checks_recorded` with `callState: 'recorded'` for a received
verdict. Both include only the operation ID and expiry. The controller retains
the distinct `sf1` domain and the existing independent-check funding pool.
`forReassessment` preserves the existing inline path with its explicit current
staff resolver. A background worker must never impersonate that reviewer.

Prewrite a bounded body-free continuation before every possible provider phase,
including a phase whose planning ACK might be lost. A `model_recorded` result
may follow a provider call in that invocation. A later `not_claimed` invocation
reaches neither the generator nor checks entry point and can drain a scheduling
hint. Durable SDK state and accounting remain authoritative after unknown ACKs.
The host owns bounded retries, scheduling fairness and capacity. Generic host
proof callbacks retain their own billing policy.

`createSupportReleaseFollowupCheckCleanup({store, clock})` exposes
`discardTicket` and `purgeExpired` without model configuration, credentials or
funding. Each handles the existing bounded head through at most two conditional
update attempts. Deferred private requests default to 60 seconds of retention
and accept an explicit bound from 1 through 300,000 milliseconds. Erasure keeps
body-free intent tombstones, preventing expiry from authorizing another paid
call. Wire ticket erasure into Source withdrawal and expiry erasure into existing
maintenance even when paid configuration is removed. Application withdrawal
also scrubs retained staged model output.

Retest receipt ports may supply `observe` in addition to their existing
`verify`. Its preliminary metadata is snapshotted immediately and remains
untrusted until its live `confirm` closure succeeds. Opening report observation
may overlap independent release verification after Source and association
admission. Closing confirmation joins the original opaque-version checks. The
original browser guard follows both, and any returned synchronous assertion runs
at the transaction handoff. Each conditional retry opens a fresh observation.
An unavailable supplied observation holds without falling back to `verify`.
Omitting `observe` retains legacy verification, and exact accepted receipt
recovery precedes either callback. Observation handles never cross requests or
enter stored records.

These source contracts do not qualify a host's physical D1 or CPU budget.
Actual Workers Free 50-call and 100-parameter qualification remains separate.

### Candidate post observation

For each new application post attempt, the proof guard may receive an optional
`EngineeringFollowupPostObservation`. `readWork(access)` lazily enforces the
original caller, follow-up read/queue and private-read requirements before
returning that attempt's Work snapshot. `confirm(access)` rechecks opaque
Source, accepted association, Work, Head and Ticket versions after proof awaits.
The observation expires when that proof guard settles; versions remain inside
the Application. It is not a cross-attempt cache or an atomic host snapshot.

The AI coordinator uses this snapshot and final confirmation when supplied.
Existing application late checks and CAS, current staff authority, release,
target, check-policy and receipt proofs remain. Structural ports that omit the
observation retain the standalone fallback. Delegating proof-guard adapters
forward its optional argument and returned assertion unchanged. Hosts must
measure their complete invocation; this read optimization establishes no
universal Workers call or CPU qualification.

### Candidate reassessment observation

`reassessEngineeringFollowupBundle` lets the Application own an entire staff
reassessment attempt. Its immutable `ReassessEngineeringFollowupBundleCommand`
binds `ticketId`, `workId`, `commandId`, `correlationId`,
`expectedWorkGeneration` and `recoveryIntentHash`.
Exact accepted recovery comes before the planner or private proof work, under
current review and queue authority. The Application freshly confirms Source
after its initial release-proof await before exposing the planner view.

The planner receives an `EngineeringFollowupReassessmentObservation`. Its
`read(access)` provides that attempt's authorized
`EngineeringFollowupReassessmentView`; `confirm(access)` checks opaque Source,
accepted association, Work, Head and Ticket versions after fresh proof. The
observation remains live through the planner and its returned guard, then
expires when that guard settles before the late host callback. A conflict
retry gets a new observation. It grants no new permission, retained authority,
cross-attempt cache or cross-store atomicity.

The planner returns an `EngineeringFollowupReassessmentPlan` with the checked
candidate/bundle, check receipt and policy version, and its commit guard. The Application carries these through its
existing private preparation, late checks and CAS. Release, target, check
policy, check receipt, staff authority and host guard remain current. The AI
`prepareStaffReassessment` signature is unchanged: it uses this optional
application port when present; older structural ports retain the full legacy
read/preparation path. A complete host invocation still needs measured
qualification against its configured limits.

## Association authority and duplicate work

Follow-up requires an exact ordinary accepted engineering association with
matching source and destination `followupRevocationEpoch` values. A destination
captures the current epoch at durable dispatch start, before a possible GitHub
POST. Late acknowledgements and reconciliation preserve that captured epoch.
Missing legacy epochs hold eligibility; there is no blanket backfill.

Explicit evidence, product, or check-policy revocation, current-source security
restriction, and permanent withdrawal advance the source epoch. Ordinary
conversation, reopening, provider disablement, and fresh ordinary proof preserve
it. New proof therefore cannot silently grant authority to an old association.
When appropriate, an explicitly checked and staff-approved new
`link_existing_issue` association can capture fresh authority through the
existing engineering workflow, subject to its destination and marker bounds.
It does not restamp the old destination.

One semantic work ID binds immutable repository/issue identity, semantic mapping
identity, and deployment epoch. Ticket revisions, refreshed attestations,
association replacement, and authority epochs do not create another notice for
that identity. Delivered work never rearms or posts again. Each ticket has one
follow-up head, at most four registered associations and eight deployment
contexts, and a default of four lifetime work sets with a hard maximum of eight.

## Prepare the complete private handoff

Admit work only for an authenticated web ticket. The optional coordinator uses
purpose `support_release_followup`, current verified data controls, evaluated
model/prompt/parser versions, local token counting, and durable usage accounting.
Each physical invocation uses a fresh claim identity. A prepared attempt and
its exact input binding survive ambiguous acknowledgements; recovery preserves
unknown usage instead of blindly repeating that paid request. No exactly-once
provider guarantee is implied.

Provider-visible input contains bounded customer-visible conversation and
host-approved public release facts with request-local references. Server-only
issue, deployment, ticket, KB, receipt, and authority identities stay outside the
prompt and content logs. Internal notes and private KB content are excluded.
The model's first input argument is the complete disclosure boundary; adapters
must keep its server context and configuration proof outside provider content.

The candidate contains a customer draft, an optional KB change proposal, and
advisory retest requests. `ReleaseFollowupTargetPort` chooses an explicit article
or `none`; unavailable target authority holds preparation. For an article, the
coordinator uses only the actual released KB SDK's `getDraft` and
`getValidationRequirements` with current KB authority. These private reads bind
the article revision, content, and requirements; they do not enter provider
input. KB access is optional when the explicit target is `none`.

Independent checks cover the entire exact bundle: customer text, KB proposal,
target baseline, validation requirements, retest steps, expected behavior, and
product binding. The receipt binds the candidate and bundle hashes, work and
source authority, current issue/deployment heads, and check-policy version.
Model self-assessment cannot replace privacy, factual, applicability, or
security checks.

KB changes and retests remain Support-private handoffs. SD-05 adds no KB write,
publication, source verifier, or fabricated SD-03 resolution-learning proof.
The owning KB/API/MCP workflow retains its evidence and publication gates.
`submitEngineeringFollowupRetestResult` authenticates a receipt against the exact
request, bundle, product/build, execution, and runner. A passing retest alone
does not unhold work or authorize a notice.

## Staff posting and reassessment

`prepareEngineeringFollowupBundle` requires mode `prepare` or
`staff_reassessment`. Normal preparation cannot quietly revive held or expired
work. Explicit reassessment uses current staff authority, fresh complete release
proof, fresh whole-bundle checks, and new capacity admission. It preserves the
semantic ID, paid-attempt counters, and bundle revision limits. It cannot clear
withdrawal, restricted evidence, revoked association authority, or delivery.
The staff coordinator helpers use current proof, target, and check ports
independently of generation configuration and provider availability.

Before reading current proof or private work, `prepareStaffReassessment`
recovers an accepted preparation through `reassessEngineeringFollowupBundle`
when the optional application port is present, or through
`recoverEngineeringFollowupPreparation` on the legacy structural-port path.
This narrow read binds the current staff actor, exact work/command identity,
and recovery-intent hash, returning only an opaque acknowledgement or `null`.
It requires current review and queue authority and grants no new approval.
An exact accepted intent therefore does not prepare twice after a lost
acknowledgement, even if live proof or source bodies later become unavailable.
Accepted preparation recovery needs review and queue authority without a read
grant. Accepted posting replay needs review, queue, and reply authority without
a read grant. Both return metadata only and bypass private work reads and live
proof calls; the stronger coordinator grants apply when a new operation reaches
its private preflight.

For draftless model work, `retryEngineeringFollowupWork` provides a separate
explicit staff retry. It accepts only ordinary, undelivered, nonwithdrawn model
work that is held, superseded, or expired, with no candidate or prepared bundle.
Current review and queue authority, exact work generation, fresh association and
same-semantic deployment proof, and remaining lifetime attempt capacity are
required. It retains the work ID and accounting/history, removes the old claim
and step, and returns work to pending with a fresh deadline. Readmission restores
five future rows and one message slot; its own two Audit/receipt rows use
ordinary capacity. It does not reset the paid-attempt limit or repeat an old
unknown provider call.

`abandonEngineeringFollowupWork` locally holds undelivered work under exact work
generation, current review and queue authority, and a reason. It needs no
provider, configuration, release proof, or check ports. Its two Audit/receipt
rows use its own funded tail or ordinary capacity, then release the remaining
tail and message slot. Identity, private retained content, and accounting/history
remain; abandonment is not privacy erasure. Delivered and withdrawn work cannot
be abandoned. Both lifecycle commands recover exact accepted receipts before
new proof or generation checks, with current authority and the original actor.

`approveAndPostEngineeringFollowupWebUpdate` binds the exact checked bundle,
work generation, ticket revision, association authority, and live staff actor.
It requires current review, queue, and staff reply authority. Its read-only
commit guard rechecks release applicability and independent whole-bundle proof
after awaited work. Guards never perform a provider call or external mutation
inside a storage retry.

The optional web update options accept a signal and a trusted, read-only
verifyBeforeCommit callback. Hosts use this callback to refresh the original
staff session and permissions for a new notice after the last awaited
application version read. The application bounds the callback with its trust
timeout, then checks named permissions and proof expiry before invoking the
ticket transaction. The AI coordinator's release guard supplies a synchronous
final proof assertion. It checks the exact verified proof, check receipt,
check policy and invocation deadline after the late authority result reaches
the application. Direct trusted release guards may still return void. A
delegating adapter forwards the guard's result unchanged. Exact accepted
replay skips new-write authority and proof checks under the normal current
receipt grants. Hosts still authenticate the original browser
on admission and before returning results. A session read and the ticket
transaction are separate operations. Cancellation during a transaction can
leave an unknown acknowledgement and requires exact-command recovery.

Approval and posting form one ticket transaction: the canonical web message,
message quota, Audit, replay receipt, and delivered work marker commit together.
The Core `customer_notice_added` event advances revision and customer-visible
update time while preserving ticket status, handling, resolution/closure, and
`firstStaffRespondedAt`. It sends no email and does not resolve tickets or act
on accounts. Its trusted cause completes its own work, preserves the parent
engineering association, and holds other stale follow-ups; other affected
source proofs retain their normal invalidation rules. This approved notice
newly holds enrolled resolution learning as a visible-source change without
advancing its resolution cycle. SD-05 leaves ordinary replies' existing learning
behavior unchanged.

## Holds, capacity, and withdrawal

Reopened issues, rollbacks, failed retests, and relevant ticket conversation or
reopening hold stale unsent follow-up work. Duplicate observations coalesce.
A negative observation can fund its two Audit/receipt rows from one affected prepaid work
set, then hold all affected work and release their remaining reservations in
the same transaction. Without a funded affected work set, ordinary capacity
may reject the observation. Current proof guards still prevent stale posting;
an unrecorded observation is not permission to use old proof.

Admission reserves five future physical rows and one future message slot before
paid work, beyond the actual head/work/causal records. Checked bundle preparation
spends two rows and leaves three plus the slot. Staff posting spends those
three on the message, Audit, and receipt. Normal and control operations preserve
every other work set's tail and the existing human, learning, engineering
privacy, and terminal reserves. A human conversation change releases the held
follow-ups' reservations before admitting its own message.

Paid model attempts default to two with a hard maximum of four; bundle revisions
default to four with a hard maximum of eight. One retained candidate or complete
bundle fits a combined 16,000 conservative UTF-16 JSON bytes, and complete
physical records fit 60,000. Admission follows each stage's immutable input.
Observation checks the actual work and its hold/scrub states; it does not reserve
an arbitrary future bundle. Before a paid model call, preparation checks the
exact manifest with maximum accounting/finish metadata and maximum candidate
completion/replacement-claim states. Successful completion compacts that attempt
to its opaque usage tombstone and exact completion acknowledgement. Unresolved
preparation retains its manifest, and the lifetime attempt bound counts the
unique union of full attempts and tombstones. Unknown usage remains reserved
in the host ledger.

Exact bundle preparation separately admits its actual body and retest request
count with maximum future retest summaries, post, hold, and scrub states.
An arbitrary later bundle needs its own admission. Verified retest results are
stored as bounded hashes and private ledger references. Their Audit/receipt
rows require ordinary capacity; the five-row tail funds bundle preparation and
posting. Saturation holds new derivation within the configured physical ticket
cap.

Call the parent `withdrawEngineeringSource` before deleting source bodies. Its
existing two-row privacy reserve scrubs the follow-up head and at most eight
work rows, including private manifests, drafts, KB/retest details, even if later
composition omits follow-up options. There is no child withdrawal command or
extra privacy reserve. Retain only opaque delivery/recovery metadata; already
sent canonical messages follow ordinary ticket retention. Late output cannot
restore withdrawn private content.
