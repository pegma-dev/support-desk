# Resolution learning: SD-03 source contracts

SD-03's source merged in [PR #39](https://github.com/pegma-dev/support-desk/pull/39)
and first shipped in the verified synchronized
[`0.2.0` release](RELEASING.md#verified-sd-06-publication-2026-11-08).
The current verified synchronized release is `0.2.10`; its dated
[publication receipt](RELEASING.md#verified-0210-publication-2026-11-13) records
the public graph and final success/evidence guards. Source metadata prepares
unpublished synchronized `0.2.11`; see the
[source handoff](RELEASING.md#source-version-0211) before host adoption.
The ticket application implements enrollment, structured resolution evidence,
durable work, exact staff review, invalidation, withdrawal, and reconciliation
records. The optional AI package adds bounded model processing, KB draft
delivery, exact staff review, and source retirement/reconciliation through
`createSupportDeskLearning`, with read-only callbacks from
`createSupportDeskLearningSourceVerifier`. The published AI `0.2.9` release
consumes the application and contracts packages from the verified
[KB `0.1.8` release](https://github.com/pegma-dev/knowledge-base/releases/tag/v0.1.8).
The historical AI `0.2.8` graph retains exact KB `0.1.6`.
The initial SD-03 release consumed
[KB `0.1.2`](https://github.com/pegma-dev/knowledge-base/releases/tag/v0.1.2).
SDK validation and publication do not establish host activation. No host has
activated this behavior.

This document describes the implemented source boundary, not a released host
integration. The approved scope remains in
[KNOWLEDGE_AI_PLAN.md](KNOWLEDGE_AI_PLAN.md#resolved-ticket-learning), with the
durable layout and producer prerequisites in the
[SD-03 collection checkpoint](COLLECTIONS.md#sd-03-resolution-learning-layout-and-api-checkpoint).
The base application has no KB or model-provider dependency.

Published `0.2.9` adds [opt-in staged draft delivery](#opt-in-staged-draft-delivery-029-candidate).
Its complete Native host qualification under 50 D1 calls and 100 SQL parameters
remains pending.

<a id="final-human-success-and-evidence-guards-0210"></a>

## Final human success and evidence guards (0.2.10)

`confirmCustomerSuccess` and `submitResolutionEvidence` add optional third
arguments named `ConfirmCustomerSuccessOptions` and
`SubmitResolutionEvidenceOptions`. Their public declarations are:

```ts
interface ConfirmCustomerSuccessOptions {
  readonly signal?: AbortSignal;
  readonly verifyBeforeCommit?: () =>
    void | (() => true) | Promise<void | (() => true)>;
}

interface SubmitResolutionEvidenceOptions {
  readonly signal?: AbortSignal;
  readonly verifyBeforeCommit?: () =>
    void | (() => true) | Promise<void | (() => true)>;
}
```

Both are exported by the application package. Existing two-argument calls
remain valid, with unchanged `CustomerTicketView` and
`ResolutionLearningSourceResult` return types. This is a contract declaration,
not a complete host composition example.

The host callback is a trusted, read-only check of the original live browser
session and current purpose-specific authority, including entitlement where
the host requires it. It runs after all asynchronous product/test/KB proof,
reads and mutation planning, freshly for each actual CAS attempt. It may
return a synchronous assertion that must return the literal `true` at the
conditional transaction boundary. No asynchronous SDK work follows the final
awaited callback. The SDK closes with that assertion, the original signal,
captured actor/full serialized grant and required permissions; customer
confirmation also checks ticket ownership. A callback is not an access grant
and must not mutate the supplied context or perform side effects.

An aborted signal prevents new writes, including abort during product, test or
guard waits. It cannot roll back an already committed transaction. Exact
accepted-command recovery still requires current original permissions and,
for customer confirmation, ticket ownership; it precedes obsolete product/test
proof, the optional final guard and abort checks. Keep the original actor,
command identity and packet after an unknown acknowledgement. A lost ACK is
not permission to create another command or paid attempt. These options add
no role, storage/access port, record migration or model call. Publication and
host qualification remain governed by the dated release and host receipts.

## Enrollment and working facts

Learning is a separate opt-in from assistant answering.
`resolutionLearning.enabled: true` preallocates one `learning-source` record
when a new customer ticket is created. An older ticket requires the explicit
`enrollResolutionLearning` command with its current staff revision. Enabling
configuration does not enroll historical tickets or qualify old success
receipts. Enrollment, its Audit event, and its receipt share the ticket
transaction.

A source starts at resolution cycle one and source generation zero. It can
become eligible only through one of these proofs:

| Proof                               | Application binding                                                                                                                                                                      |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authenticated customer confirmation | The existing `confirmCustomerSuccess` command verifies resource ownership and the exact last visible message. The application derives the actor, accepted revision, and resolution time. |
| Staff-verified fix                  | `submitResolutionEvidence` requires a current terminal ticket revision/cycle and an immutable customer-visible solution message. The application derives the staff actor.                |
| Successful relevant test            | `submitResolutionEvidence` supplies an opaque receipt. The trusted host verifies the actor, execution, runner, relevant test, result, resolution fence, and exact product/build.         |

`ResolutionProductContextPort.resolve` receives content-free ticket revision,
cycle, actor, resolution time, and acceptance time. It supplies the trusted
product ID, version, build, stable binding, context version, receipt, and
validity interval. `ResolutionTestReceiptPort.verify` verifies an opaque test
receipt against those facts and the trusted product. These ports must be safe
to repeat and honor the bounded wait; they neither run submitted code nor
fetch caller-provided URLs.

Resolved status, inactivity, an LLM's success assertion, a client-claimed build,
and a submitted `passed` flag do not qualify. Missing, expired, unavailable, or
mismatched trust holds new learning. The normal human confirmation still
commits its success proof, Audit event, and receipt, with a compact held
reference on an enrolled source. Saturated learning capacity has the same
human-support boundary. A later decision needs fresh current-cycle
verification; it cannot infer an old build from today's settings.

A genuinely new eligible proof atomically updates the source and inserts one
generation work row with Audit and receipt. Equivalent proofs within the same
cycle and stable product binding coalesce despite refreshed attestations or a
different command ID. Exact command replay adds no records and still requires
current authorization. Receipt age alone does not invalidate a fact accepted
while its attestation was valid.

A staff `verificationReference` is the stable identity of that explicit proof.
Repeating the same reference coalesces; a different reference records a new
verification. Refreshed product-attestation receipt IDs do not change the
stable product identity.

These boundaries are exercised through real memory and Azurite stores in
[the evidence suite](../tests/resolution-learning-evidence.test.ts).

## Permissions and current authority

Support Desk declares permission names; Authorization Core and the host own
their assignment. These permissions add no role, Admin inheritance, Agent
Access scope, or publication authority.

| Operations                                                                                             | Required permission                  | Additional resource or access check                                                                                        |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `confirmCustomerSuccess`                                                                               | `support.ticket.confirm_success.own` | Authenticated ticket owner and exact last visible message.                                                                 |
| `enrollResolutionLearning`, `submitResolutionEvidence`                                                 | `support.learning.evidence.submit`   | Current `support.queue.read`; exact revision/cycle where required.                                                         |
| `readResolutionLearningSource`, `readResolutionLearningWork`                                           | `support.learning.read`              | Current `support.queue.read`.                                                                                              |
| `reviewResolutionLearningProposal`                                                                     | `support.learning.review`            | Current `support.queue.read`, source/work fence, and exact actual target.                                                  |
| `invalidateResolutionEvidence`, `withdrawResolutionLearningSource`                                     | `support.learning.withdraw`          | Current `support.queue.read`.                                                                                              |
| Scan, claim, prepare, complete, finish, source/review confirmation, and reconciliation reads/recording | `support.learning.process`           | Current authoritative source and the operation's exact fences. Processing permission is separate from assistant answering. |

Application calls take the host's current `AccessContext`; a historical receipt
is not an access grant. The internal model executor re-resolves service
authority through `LearningServiceAccessPort`, including authority version and
usage scope. It rechecks authority, source, configuration, and check policy
after awaited boundaries and before committing a result.

Completion, staff review, and reconciliation have mandatory read-only final
guards for their current external facts. They are fixed application operations,
not arbitrary storage callbacks or caller-supplied transaction actions. The
guards must not perform a model call, KB write, or other external mutation
inside a storage retry. The
[work suite](../tests/resolution-learning-work.test.ts) exercises final-guard
denial, conflict retries, and current permissions.

## Cycles, invalidation, and switches

Every terminal-to-active transition advances both resolution cycle and source
generation in the same transaction as the ticket change. All five executors
use the same source planner: handling/request-person, customer web reply,
staff reply, lifecycle/reopen, and inbound append. Customer web reply plans
against the final ticket after any second `human_escalated` transition. One
transaction has exactly one action for the ticket key and one for the source
key. Conflicts reload and recompute both.

Closing a resolved ticket retains its cycle. Assignment, priority, tags, and
internal notes do not change the accepted resolution binding. Reopening holds
the old source; resolving it again does not revive the old proof. A source
fence binds ticket ID, cycle, source generation, and `sourceBindingHash`.
Confirmation rechecks source authority across awaited reads, so a concurrent
reopen cannot return a stale positive confirmation.

SD-05 adds one explicit visible-change cause: an approved release follow-up
notice holds an enrolled learning source and advances its source generation,
while preserving its resolution cycle. The notice changes the exact last
visible-message binding used by resolution evidence. Ordinary visible replies
retain the existing terminal-to-active invalidation behavior; the shared
planner enables this extra cause only for the trusted follow-up notice.

`invalidateResolutionEvidence` records `evidence_revoked`,
`product_binding_revoked`, or `check_policy_revoked`. It advances generation
and holds the source without privacy scrubbing. This is distinct from permanent
withdrawal. Nonprivacy invalidation uses ordinary finite admission; a rejected
transaction has not accepted a revocation.

The processing switch stops new claims and step preparations, and it prevents
new enrollment. It does not erase enrolled working facts or exact reviews. An
enrolled source with genuinely new verified evidence and available trust ports
can retain pending work while processing is off. An application with the
learning options omitted cannot qualify genuinely new evidence without those
trust ports. Its persisted enrollment still enforces invalidation and capacity
reserves. Missing providers, disabled workers, or old attestation timestamps
alone do not revoke previously accepted facts.

[The invalidation suite](../tests/resolution-learning-invalidation.test.ts)
covers resolved and closed sources, all five executors, the two-transition
customer reply, atomic failures and real CAS conflicts, switch-off
re-resolution, and the paused-list/source-confirmation race.

## Durable work and finite admission

The ticket partition contains the constant source authority row,
`resolution-learning:<sourceGeneration>` work rows, exact
`learning-review:<bindingHash>` review rows, and causal Audit/command receipts.
The source counts retained generations and exact review bindings. Worker
changes serialize against the source, work, and unchanged ticket without
incrementing the ticket's domain revision.

`scanResolutionLearningCandidates` reads one bounded physical page and returns
work hints, separate `reconciliationSources` hints, physical row count, and an
opaque continuation. Every adapter-returned row counts before filtering. A host
worker must persist and advance its cursor and confirm hints through the fixed
application APIs; a scan result never establishes source eligibility.

| Limit                               | Default / hard maximum or invariant                                                    |
| ----------------------------------- | -------------------------------------------------------------------------------------- |
| Ticket physical rows                | 512 / 2,000, counting every record.                                                    |
| Complete source or work record      | 60,000 conservative serialized UTF-16 JSON bytes, including escaping and envelopes.    |
| Complete model candidate            | 16,000 serialized UTF-16 JSON bytes, reserved before paid work.                        |
| Retained generation jobs per ticket | Four / eight.                                                                          |
| Retained target articles per source | Two / four; unresolved identities cannot be evicted to make space.                     |
| Exact review bindings per source    | Sixteen / 64; later draft reviews do not evict a live publication's review.            |
| Model attempts per generation       | Two / four, retained inline.                                                           |
| Claim lease                         | 60,000 / 300,000 milliseconds.                                                         |
| Active generation lifetime          | 300,000 / 3,600,000 milliseconds; expiry does not discard unknown external acceptance. |
| Product/test trust wait             | 250 / 1,000 milliseconds.                                                              |
| Transaction                         | At most 100 actions; one action per physical key.                                      |

For an enrolled assistant ticket with durable assistant turns, creation needs
at least **23 rows without mail or 24 with mail**: eight or nine initial rows,
13 rows and one message reserved for the human path, and two separate rows for
permanent withdrawal. The 13-row reserve covers handoff three, takeover two,
eligible confirmation four, and first human reply with delivery four. Controls
preserve the four-row/one-message reply tail. Unenrolled assistant tickets keep
the existing 12-row human reserve.

Every enrolled, nonwithdrawn source also preserves the two withdrawal rows
through ordinary, learning, handling, and first-human-reply admission. Permanent
withdrawal spends those rows on Audit and receipt. A held customer confirmation
adds the existing three human rows; an eligible one adds four including work.
A new exact review adds review, Audit, and receipt; changing the decision on an
existing exact binding adds only Audit and receipt. These operations do not
increase the configured partition cap.

Preparation constructs the complete legal later candidate, completion,
finish/receipt, and replacement-claim envelopes before admitting paid work.
It counts JSON escaping and retained history, not just the currently stored
row. A request that cannot fit is held or rejected before external work rather
than truncated. See [the capacity suite](../tests/resolution-learning-capacity.test.ts)
for real-store row reserves, saturated job/target/review budgets, and complete
record bounds.

## Private model stage and provider recovery

The internal `createLearningModelExecutor` in
[learning-model.ts](../packages/ai/src/learning-model.ts) accepts an already
authoritative claim. It is not exported from the package's public index and
does not itself scan, claim, deliver to KB, or publish. The public
`createSupportDeskLearning` coordinator owns those bounded stages and creates
the fresh physical claim for every `processWork` invocation.

Each physical invocation needs a fresh cryptographic claim ID. Preparation
persists the exact visible-message/ordinal manifest, authoritative working
solution references, trusted product fields, input hash, configuration/prompt/
model/check-policy versions, budgets, predetermined usage reservation, and
deadline. A prepared step ID is independent of a claim. Replacement workers
cannot borrow a live claim or turn a recovered model preparation into a second
provider call. Recovery keeps unknown billing conservatively reserved and
requires a bounded new attempt when another call is appropriate.

Learning has its own `support_learning` purpose, current verified data controls,
configuration, tokenizer, and usage budget. The provider-visible input contains
bounded customer-visible conversation and solution text plus trusted
instructions. Private notes, requester profiles, ticket/principal/message
identifiers, proof receipts, provenance, and billing context are excluded from
provider content. Customer-submitted
conversation text still requires the host's verified processing/privacy path;
this boundary is not a claim that customer-visible text contains no personal
information. Customer DTOs do not expose the private source, work, proof,
reviewer, or reconciliation records.

The executor persists preparation before usage admission and calls the provider
outside storage retries. Lost preparation/completion acknowledgements retry the
exact storage command, not the provider call. Usage reconciliation distinguishes
`not_called`, known usage, and unknown usage; malformed or unavailable accounting
does not become a fabricated zero-cost observation. Unknown usage remains
reserved independently of KB acceptance.

Input bytes/tokens, serialized output tokens, raw UTF-8 output bytes, candidate
JSON bytes, attempts, cost, and duration have separate checks. Effective
deadlines include lease, work, prepared request, configuration/check-policy
validity, and invocation limits. Elapsed real time also bounds phases when the
host clock is frozen or moves backward. Late abort-ignorant output cannot
commit after the deadline. These cases, duplicate dispatch, in-flight source
changes, and provider-call counts are covered by
[the model suite](../tests/resolution-learning-model.test.ts).

## Draft transfer and exact staff review

Model completion stores an **unapproved private candidate** in Support Desk.
Before any candidate body transfers to KB, trusted independent privacy,
factual, applicability, and duplication results must all pass. Verification
binds the exact candidate/source/product/policy, target decision, and complete
request hashes. A model's own assessment cannot provide those checks. Missing,
failed, stale, or mismatched verification holds the candidate privately.

The application implements fixed KB preparation/completion contracts and their
receipt/fence tests. Delivery preparation stores one immutable create/update
request: article, collection, draft payload, complete ordered source references,
original expected generation, and stable command/correlation identities. The
candidate body is replaced rather than duplicated into that delivery state.
Completion records a historical acknowledgement separately from the observed
current target; disagreement holds work. Prepared recovery repeats the original
request, expected generation, reference order, and command identity while the
source remains eligible. An invoked error can follow acceptance, so recovery
does not regenerate a request or infer rejection from the exception.

Discovery uses a trusted configured scope/query, never private candidate or
ticket text. It reads at most five approved published matches and five explicit
authorized draft IDs. Bounded search is not exhaustive duplicate detection;
uncertain target or duplicate decisions hold. An update requires an exact
merged draft from the target port. A newer unpublished draft must have been
explicitly supplied to selection; it cannot be silently replaced. Current and
published provenance must be fully readable, and other contributors remain
intact in their original order. An older published snapshot may be stale while
its corrected draft is being prepared; readability does not assert eligibility.

Independent checks receive the exact rendered request as server-only data and
must assess every field that will cross into KB. Their provider-visible content
must exclude source references, identities, and operational context. Advisory
model validation requirements do not replace KB's actual guide requirements.
Check-receipt and source-publication policy expiry also count elapsed time from
the start of the invocation, including time spent awaiting verification ports.

<a id="candidate-scoped-comparison-evidence"></a>

### Published 0.2.9 scoped comparison evidence

The published `0.2.9` OpenRouter controller requires genuine comparison
evidence before signing a new-create check. Selection carries the actual
bounded published matches, explicit draft versions and configured scope into
the exact request. These are hints, not a completeness assertion. A caller's
empty array, an unused new article ID, or ordinary lossy search cannot establish
that no matching guidance exists.

The controller loads KB's optional `publishedSearchObservations` capability
from the declared verified public KB `0.1.8` graph only during deferred
background precomputation. Inline calls never enumerate the corpus. Missing, partial,
unavailable, changed or over-limit comparisons hold before provider admission.
The complete search scope is the authorized collection, exact applicability
and trusted lexical query over approved titles, summaries and tags. It is not
body or synonym search and makes no global duplicate or atomic absence claim.

Before and after model work, the controller checks the real comparison
resources and current authority. It consumes the same-instance KB observation
once after the model and current Source/target checks. The signed `ic2` receipt's
new `c` flag binds the observed scope, timestamp, digest and retained resource
versions and collection policy generation/hash without increasing the
200-character receipt limit. Full proof stays
in the existing bounded check-attempt record. Only authored comparison content
reaches the provider; article IDs, provenance, source references, actors and
opaque observation handles do not.

A later receipt verification reads only the retained resources and current
authority; it does not enumerate the corpus in the write path. Existing
resource edits, retirement, collection policy changes or access withdrawal
invalidate that snapshot, including when the observed result set was empty.
The background `observe`, `confirm`, keyed `readScope` and keyed `readArticle`
use existing article-read plus draft-read staff authoring authority and require
an enabled collection channel. They retain actual publication approval,
evidence, source and policy checks; customer portal/bot audiences do not grant
or restrict this separate staff authoring access. Ordinary portal/bot retrieval
keeps its audience checks. The controller never substitutes portal-only reads
or a caller-supplied empty list for the real authoring capability. These ports
expose no collection administration metadata or additional permissions.
AI delivery and App preparation can pass the optional
fourth verification context's `comparisonScope.collectionId` to schedule fresh
proof-head and scope reads together. The signed scope must match before the
result is used. This hint is not evidence or a cache; the third abort signal and
legacy two-argument callers retain their contracts and the full cold fallback.
New scope members added after observation are evaluated in the next background
comparison. Source, request, policy, target and final write guards still apply,
and staff must approve the actual resulting draft before publication.

Every learning receipt verifier, including the App-facing SDK verifier, requires
the issuer's retained checked entry, exact receipt and proof in the controller's
attempt Store namespace. A reconstructed controller must retain access to that
Store. This also applies to legacy learning update proofs without comparison
data. Their proof format remains supported. A verifier whose Store lacks that
entry cannot authenticate from the MAC alone. The engineering SDK proof helper
retains its existing read-free behavior. These Store reads preserve the
existing Source, Work, target, authority and final write guards.

An old learning `l` receipt without comparison evidence cannot authorize a new
create. Exact historical completion may use an accepted ACK independently read from the
Support Work row; the optional recovery input is not caller authority and the
App's ordinary two-argument verifier cannot grant this exception. If KB accepted
but Support never retained its ACK, KB `0.1.8` has no read-only draft-write receipt
lookup: the attempt stays unknown/held without a speculative create replay.
SDK publication adds no Native query/CPU or host activation qualification.

Successful independent checks permit private draft transfer without routine
human pre-transfer approval. Staff approval applies to the **actual KB draft**
before KB review/publication. `reviewResolutionLearningProposal` binds the
actual article revision, content hash, collection, complete source snapshot
generation/hash/order, policy, and current source binding. Its final guard
confirms current target/provenance and source eligibility. A local edit needs
fresh exact review. Reviewing later drafts retains the earlier published
revision's separate review; a new source generation invalidates all reviews
bound to the old source.

Since published `0.2.4`, staff can prepare a review intent for a strictly newer
draft of the delivered article in the same collection when the complete ordered
source provenance still matches the delivery. The returned intent names that
exact newer revision and content hash. An old unaccepted intent becomes stale
after another edit, while an accepted exact receipt remains recoverable.

The `0.2.4` release compares the complete current KB draft again after the
late policy and authority observations. Both `prepareReviewIntent` and each
new review proof require canonical equality with the draft already inspected.
A changed revision, generation, publication state or other draft field stops
that operation. Exact accepted receipt recovery keeps its precedence over
obsolete live target checks.

Support approval cannot publish. KB retains its own current collection/audience,
evidence, governance, review, and publication gates. An old transfer receipt,
candidate hash, or historical KB acknowledgement is not current publication
authority. The exact-target and recovery contracts are exercised in
[the work suite](../tests/resolution-learning-work.test.ts) and the
[released-KB integration suite](../tests/resolution-learning-kb.test.ts).

<a id="exact-review-intent-recovery-unpublished-022-candidate"></a>
<a id="opt-in-staged-draft-delivery-029-candidate"></a>

## Opt-in staged draft delivery (published 0.2.9)

Set `deliveryMode: 'staged'` on `createSupportDeskLearning` to separate delivery
work across physical invocations. Forward the exact SDK-owned
`application.stagedResolutionLearningDelivery` object and its original own
`prepare`, `write` and `complete` methods. If that capability is absent, copied,
wrapped or changed, `processWork` returns `held` with
`staged_delivery_unavailable` before a claim.
Omitting `deliveryMode` retains inline delivery for existing structural ports.

| Physical phase | Durable progress                                                                                                         | Coordinator result                                       |
| -------------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------- |
| Candidate      | Existing model attempt and usage rules retain a private candidate.                                                       | `candidate`                                              |
| Prepare        | Saves the immutable KB request and releases the claim atomically.                                                        | `pending` / `delivery` with `checkpoint: 'prepared'`     |
| Write          | Rechecks current proof, performs the exact KB create/update and saves its historical acknowledgement with claim release. | `pending` / `delivery` with `checkpoint: 'acknowledged'` |
| Complete       | Reads the current KB target/provenance, applies closing checks and conditionally completes Support Work.                 | `delivered` or `held`                                    |

The optional `checkpoint` field extends the existing pending-delivery result.
It attests durable App progress and claim release. The SDK makes no
`model.generate` call in that checkpoint invocation. A custom `checks.check`
port may perform paid external work
under the caller's billing policy. The reference host's source composition
defers independent checks to a separate invocation and uses receipt verification
in delivery checkpoint phases. The marker establishes no universal cost budget.

End the current physical invocation after each checkpoint and resume the same
Work in a genuine later invocation with a fresh claim. The host owns bounded
scheduling and opaque cursor/resume hints. Preserve the original Work deadline,
request identity and generation-attempt limits. Unknown pending delivery omits
the checkpoint field. An uncertain KB response can follow an accepted write.
Recovery reuses the identical KB command/correlation IDs, original expected
generation, payload and ordered source references so the existing KB receipt
can recover that acceptance.

Both staged and inline delivery recheck current Support/KB authority, Source
contributors, target scope, validation requirements, configuration and independent
policy/receipt. After late KB target readback, closing policy, receipt and
configuration checks run again. The application retains opaque
Ticket/Source/Work confirmation, claim/lease and deadline fences at its
conditional write boundary. Callback observations expire with their owning
application call. The [staged delivery suite](../tests/resolution-learning-delivery-stages.test.ts)
exercises these phases and inline closing checks. SDK publication is verified;
complete host Native Workers Free 50/100 qualification remains pending.

In staged mode, `reconcileSource` processes one unconfirmed durable destination
per invocation and skips confirmed entries. After one exact KB retirement
attempt, including an unknown ACK, it yields through the existing
reconciliation result. A later physical invocation freshly observes KB and
records verified retirement or unaffected publication for that destination.
Final fresh retirement authority and Source-view reads remain required. This
path retains separate retirement authority with generation OFF. Inline
reconciliation keeps its existing bounded retries. The reconciliation result
union is unchanged.

## Exact review intent recovery (0.2.2)

Published `0.2.2` adds a read-only
`prepareReviewIntent(access, {ticketId, sourceGeneration})` operation. It derives
an immutable `intent` and the actual private `draft` through the current Support
work, KB/provenance and independent policy ports. The intent includes its
reviewer, exact source/work generations, target and full policy snapshot. It is
neither approval nor authority: a new `submitReviewIntent` rechecks the current
source, target, policy and commit guard.

Before any submission, retain the entire returned intent together with the
original command/correlation IDs, decision and optional reason. Submit, receipt
read and explicit cancellation take this same `LearningReviewCommand`; never
rebuild it from a later draft, policy or source. Its complete intent participates
in the command fingerprint. Mutating only a policy timestamp, decision, actor or
other bound coordinate cannot recover a different command's acknowledgement.
`reviewProposal` remains available for existing full-command integrations.

Exact receipt lookup precedes obsolete live source/KB/policy checks. Thus an
accepted review can recover its historical acknowledgement after reopening or
withdrawal without approving the changed source or publishing anything.
`readReviewReceipt` returns `null`, `{outcome: "accepted", result}` or
`{outcome: "cancelled", ticketId, commandId}`. **Null is nonterminal:** an earlier
in-flight request can still commit. Neither a conflict response, a GET, age nor
a timeout establishes nonacceptance.

A deliberate `cancelReview` takes the original packet and a trusted read-only
`verifyBeforeCommit` human-authority guard. It either recovers the already
accepted result or atomically stores cancellation and Audit at the existing
ticket partition's command key. The review and cancellation compete for the
same receipt insert and ticket version, so a committed cancellation fences a
late original review; an accepted review is never undone. Cancellation does not
need the obsolete KB target to remain current. Keep the packet unresolved on
errors, capacity failures, timeouts or lost cancellation acknowledgements;
retry its exact cancellation/recovery, not a new approval. Only a verified
accepted/cancelled acknowledgement permits clearing that pending intent.

Both operations retain named human review and queue permissions and ticket
resource checks. Cancellation uses existing bounded partition admission for its
receipt plus Audit and can fail closed at capacity; it does not consume human or
withdrawal reserves. No store, permission, automatic resubmission, model call or
publication capability is added. Hosts must preserve current session/permission
fences around awaits and private DTOs. These operations need no model readiness.

The existing generic receipt fields and accepted fingerprints are unchanged for
legacy commands. New intent commands add optional `intentBinding`; cancellation
uses a separate fingerprint domain at the same receipt key, without a new row
kind or stored-data rewrite. A `0.2.1` caller rejects the new intent field, and
its legacy reviewer treats a cancellation fingerprint as a conflict rather than
an approval. This fail-closed behavior is not a claim that older clients can
understand the new acknowledgement union. Preserve receipts through normal
retention; deleting one could revive an old command. Host adoption
still requires its separate gates. See the
[real Store recovery race suite](../tests/resolution-learning-review-recovery.test.ts).

<a id="opt-in-staged-human-review-source-candidate"></a>

## Opt-in staged human review (published 0.2.5)

Published `0.2.5` adds staged human reviews. The default
`createSupportDeskLearning` factory executes inline reviews. Hosts
can select the optional staged capability by setting
`resolutionLearning.stagedReviews: true` and constructing
`createSupportDeskStagedLearningReviews`. Structural application ports expose
this additive capability through an optional property. Host integration and
activation retain their own acceptance gates.

The host first prepares and retains the complete `LearningReviewCommand`.
`admitReviewIntent(access, command, {verifyBeforeCommit})` requires a fresh
original-browser guard checking the same actor's current review, queue and KB
permissions. Admission records the pending request, Audit and canonical command
reservation together. Final review or cancellation replaces the reservation
with the terminal receipt. A host returns **202 pending** after durable
admission to acknowledge the recorded
human command. Unknown admission ACKs recover that exact command.

A durably admitted human command remains active across browser logout until
explicit cancellation or completion settles it. Each worker resolves the
original human's current account activity and host-owned roles through
`resolveActor({principalId, signal})`. The retained actor, action, target and
permission ceiling constrain every fresh resolution. New review proofs require
current Support review/queue and KB draft/provenance grants. Browser credentials
stay within the host authentication boundary. Hosts requiring original-session
validity through the eventual commit use the inline review path.

`scanPending` resolves processing authority and returns one bounded physical
page with `candidates`, `physicalRows`, `pages: 1` and `nextCursor`. Every returned
physical row counts before filtering. The host persists its opaque cursor and
redispatches pending work, including recovery after admission-before-send
crashes. Queue messages carry opaque wakeup keys. The application's retained
metadata supplies the authoritative reviewer identity.
`processReview({ticketId, commandId, workerId, leaseMilliseconds})` creates a
fresh claim ID for that physical invocation.

- **P1** claims the proof phase, performs the complete live proof and retains
  compact source/work/target/policy bindings and their expiry. `prepared` ends
  the physical invocation. A later physical delivery performs P2.
- **P2** acquires a new commit claim and performs an independent complete proof.
  It checks every current and published source-readability reference, the full
  contributor aggregate, own raw source, current policy, fresh human authority
  and late complete draft equality. The application atomically commits the
  review, source/work fences, Audit, canonical receipt and terminal attempt
  under the exact claim version.

Each claim or phase mutation has one conditional transaction attempt. Conflicts
and uncertain ACKs retain the original command for another physical invocation.
The final synchronous `() => true` assertion runs after the last awaited guard
and enforces the minimum invocation, original intent, P1 proof and claim expiry.

`readReviewStatus` and `cancelReview` take the original full command. Canonical
accepted/cancelled receipts precede live source, policy and KB checks. Current
human review/queue authority governs recovery. Cancellation and P2 contend in
the same partition. An accepted review retains its accepted result. Missing
receipts, pending responses, timeouts and conflicts retain unknown ownership.
`not_pending` carries its outcome string as the queue-settlement signal.
Hosts pair it with the retained dispatch key and recover human results through
`readReviewStatus`.
`not_claimed`, `pending` and `held` retain the queue pointer. A `pending` result
uses phase `dispatch` before a claim and preserves a coarse authorization or
availability reason. `held` reports an authoritative dispatch hold. `prepared`
schedules a later invocation, and `completed` carries the terminal receipt. KB review and
publication proceed through their separate staff-authorized workflow.

For the known real SDK read-only graph, optional `readScheduling: "sdk"` enables
bounded settled waves of at most 32 source reads. Current and published sets,
foreign aggregate callbacks, refreshed authority, final source confirmations
and late draft checks retain their phase ordering. Every launched result is
consumed. Custom structural ports use serial callbacks by default. Publication
verification also uses serial callbacks. The source-verifier option schedules
independent contributor read/confirm chains within those phases.

Pending and held attempts retain exact command ownership through expiry and
privacy withdrawal. `maxStagedReviewAttempts` defaults to eight with a hard
maximum of 24 retained rows, including terminal requests. At capacity, admission
reports the bounded limit error and retains earlier ownership. Hosts own
physical retention and durable rediscovery. See the
[attempt layout and reserves](COLLECTIONS.md#staged-human-review-attempts-source-candidate).
The focused [staged AI cases](../tests/resolution-learning-staged-ai.test.ts) and
[read-wave cases](../tests/resolution-learning-read-waves.test.ts) exercise the
real application/KB graph on Memory and Azurite. Native D1 query, CPU, whole-host,
provider and deployment acceptance require their own observed qualification.

## Composition and worker entry points

Construct the read-only source verifier over the Support application first.
Supply it to KB's `privateSources` option and pass the same verifier as the
learning coordinator's `sources`. Its callbacks do not call KB, so publication
and retrieval cannot recurse through the bridge. Unknown source namespaces
fail closed unless an explicit additional verifier checks the full unchanged
context. Mixed-source publication requires every contributor current and at
least one exact Support aggregate review; a foreign approval cannot substitute.

The host supplies current Support processing authority, separate KB draft and
retirement authority, trusted target scope/selection, independent checks,
model configuration, usage accounting, tokenizer, and clock. Permission ports
grant nothing themselves. Source truth and publication policy stay independent
of the model processing switch and provider configuration.

- `scanCandidates` returns one physical page and reconciliation hints. The host
  persists and repeats the cursor loop.
- `processWork` creates a fresh claim and performs one model or KB delivery
  stage. It never accepts a reusable caller claim ID.
- `reviewProposal` verifies the actual draft/provenance and records Support's
  exact staff decision. The host separately invokes KB's existing evidence,
  submit, review, and publish commands with current staff authority.
- `reconcileSource` uses the separate retirement authority and durable
  destinations to reconcile source invalidation. It cannot publish guidance.

Use `learningTargetBinding` with actual KB draft and provenance reads when
building the expected staff-review target. Source-verifier behavior is tested
in [the source suite](../tests/resolution-learning-sources.test.ts).

## Permanent withdrawal and reconciliation after deletion

The host must call `withdrawResolutionLearningSource` **before** deleting the
ticket body or revoking source access. `privacy_withdrawal`,
`source_access_revoked`, and `source_deleted` permanently tombstone eligibility.
The accepted transaction advances generation, holds work, scrubs private
evidence/product/candidate and draft-body copies, clears model input manifests
and private review reasons, and retains minimal usage/request identities.
Repeated withdrawal adds no rows. Enrollment or fresh evidence cannot
reactivate that withdrawn source.

The host owns physical ticket deletion and retention. Support's withdrawal is
not a physical KB purge. The source/destination tombstone and body-free request
metadata must survive while a late write or dependent publication is unresolved.
`reconciliationPending` tracks destinations needing external cleanup; an
invalidated source with no destinations has no external reconciliation to run.

`readResolutionLearningReconciliation` remains usable after the ticket row is
deleted. It projects each retained destination's exact operation, command ID,
article ID, and original expected generation from at most four work keys. It
checks physical keys, source generation, step/request hash, article identity,
and the final source version. The service view exposes no draft payload,
candidate, conversation, or full source-reference list. Missing or mismatched
identity is unavailable and requires blocked reconciliation.

Source ineligibility fences new derivation and KB draft writes, including
identical outbound write replay. Unknown acceptance is reconciled through
read-only observations and targeted cleanup, never cleared just because a read
is absent or enough time passed. Recording a nonblocked result requires a
trusted terminal receipt, revision fence, or cancellation binding, plus a
mandatory final guard over generation-consistent full provenance, published
source membership, and late-write safety. The closed results are `blocked`,
`retired`, `unaffected_publication`, and `write_rejected`; there is no
absent/aged-out success result.

Cleanup must inspect the **published** source snapshot. An invalid ticket
reference in only a pending draft does not justify retiring an independently
sourced publication. Unreadable complete provenance blocks cleanup and retains
the destination. `reconcileSource` performs conditional KB retirement and
records an established proof through the Support application. Its command
identity binds the durable destination, observed KB generation, and source
snapshot hash. Equal observations repeat the same conditional request; a newer
generation fences older requests and requires fresh published-provenance
inspection. This is convergent conditional recovery, not an exactly-once claim.
It does not retire an unrelated draft or publication merely to force a
generation advance.

[The work suite](../tests/resolution-learning-work.test.ts) covers retained
unknown destinations, permanent nonreactivation, body scrubbing, and the minimal
reconciliation read after real ticket-row deletion. Source tests do not close
producer publication, host privacy/operations, full-workflow, or activation
gates.
