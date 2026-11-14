# Upgrading synchronized Support Desk packages

## Unreleased source: SD05 checker provider-group opt-in

The source SD05 independent checker now accepts the existing explicit group
route, matching static allowlist scope and current Admin scope approval, with
the complete hash-bound `providerMaxPrice` policy. This is not a generator
capability or a default selector change. Its separate SD05 purpose/wire
evidence and receipt MAC, current Source/Work checks, native usage accounting
and finite approval/attempt lifetimes are retained. Benign approval-date
renewals cannot widen group scope or prices or replace a queued route hash.

There is no new version or published artifact in this source change. Hosts
must preserve the public `0.2.12` SD05 group refusal until a separately
verified release supplies the feature. Requalify the actual model, route hash,
full SYSTEM/USER wire, token counter and framing, provider-group privacy,
native cost and host Free CPU; do not relabel prior endpoint evidence or
activate customer AI from source tests. See the [adapter contract](../packages/ai/README.md#unreleased-source-sd05-independent-check-provider-groups).

The current verified synchronized release is `0.2.12`; see its
[publication receipt](RELEASING.md#verified-0212-publication-2026-11-14).
Hosts must qualify the [new checker wire](../packages/ai/README.md#optional-openrouter-adapter)
and its route-policy hash before use. SDK publication does not establish
factual model quality. Host deployment and acceptance gates are separate.
The original SD-06 `0.2.0` release has its separate
[historical receipt](RELEASING.md#verified-sd-06-publication-2026-11-08).
The original four Support Desk packages were published at `0.1.1`. Before
SD-06, source also used `0.1.1` while accumulating additional behavior; those
source changes shipped in `0.2.0`. Registry versions are immutable.
Use the exact synchronized artifacts recorded by
[release verification](RELEASING.md), using published packages rather than
branches, copied source, local paths, or candidate tarballs in production.

The optional AI package has a separate registration-only `0.1.1`
[bootstrap](AI_BOOTSTRAP.md). It is not a supported installation target: its
registry application dependency lacks the new source exports. The five local
bootstrap tarballs prove an isolated source assembly, not a usable registry
dependency tree.

<a id="0210-final-success-and-evidence-guards"></a>

## 0.2.10 final success and evidence guards

Synchronize all five public package versions and exact internal Support pins.
The optional AI package and repository development pins retain exact public KB
application/contracts `0.1.8`; `zod@4.6.7` and other external selections are
unchanged. The root remains private at `0.0.0`.

The unchanged `@pegma/authorization-core@0.4.0` dependency already exports
`serializeAccessContext`. Its [original public tarball](https://registry.npmjs.org/@pegma/authorization-core/-/authorization-core-0.4.0.tgz)
contains the named JavaScript export at `dist/index.js:121` and its declaration
at `dist/index.d.ts:22`. The original archive SHA-256 is
`1e449abf4815b99984f1991cb03be3a337edd1b092e523723b3eff8ed07625aa`;
its [lockfile](../pnpm-lock.yaml) integrity is
`sha512-GkagQwyDfKokB2Nm9EAo6cvKB8c90VN6Or6IdaWeMwCeuseOxDZ8ccxKqccW9YorByE6rHhr2nbxjsNWorZTHQ==`.
Installed public JavaScript/declaration bytes matched that archive, and direct
named ESM imports resolved to a function on Node 22.18.0 and 24.18.0.
The [candidate CI run](https://github.com/pegma-dev/support-desk/actions/runs/43383002448)
at [`f7bae286`](https://github.com/pegma-dev/support-desk/commit/f7bae28648cb760c6ee69430cdf3cf92b7b612da)
passed 4,171 tests in each Node 22/24 lane and the normal packed-consumer checks
([Node 22 artifact](https://github.com/pegma-dev/support-desk/actions/runs/43383002448/artifacts/14016684868),
[Node 24 artifact](https://github.com/pegma-dev/support-desk/actions/runs/43383002448/artifacts/14017652633)).
These calls use an existing public export; the dependency pin stays `0.4.0`.

Forward the optional third argument on `confirmCustomerSuccess` and
`submitResolutionEvidence` through host adapters. Its exported type is
`ConfirmCustomerSuccessOptions` or `SubmitResolutionEvidenceOptions`, with
`signal?: AbortSignal` and a read-only `verifyBeforeCommit` callback that may
return a synchronous literal-true assertion. See the
[exact declarations and commit/recovery contract](RESOLUTION_LEARNING.md#final-human-success-and-evidence-guards-0210).
Existing two-argument signatures and return types remain supported.

Current-authority checks also govern acknowledgements. `confirmCustomerSuccess` rechecks current
authority before and after its post-commit customer-view read, including for
two-argument callers. If access changes during that read, the SDK can refuse
the view and surface an error after the confirmation transaction was accepted.
That error does not roll back the accepted transaction or prove the command
failed. Retain the exact original command and retry receipt recovery only with
restored/current access and the required customer ownership; do not issue a
replacement command to explain the missing acknowledgement.

Supply the original browser/entitlement guard for new host mutations, after
body admission. The SDK awaits it after asynchronous proof/planning, freshly
on every actual CAS attempt, then makes its final synchronous checks without
another SDK await. An abort prevents new acceptance and does not undo a
commit. Do not place receipt lookup behind an obsolete product/test proof or
an already aborted signal: exact accepted receipts recover first under current
original permissions and customer ownership where required. Preserve the
original command after an unknown ACK. No record migration, permission,
storage/access port, paid retry or automatic activation is introduced.
Qualify the combined source and each host independently; metadata and type
checks alone do not establish the runtime guard or deployed-session behavior.

<a id="unpublished-029-kb-018-alignment"></a>

## Published 0.2.9 KB 0.1.8 alignment

The published `0.2.9` AI manifest and repository development pins select exact
verified public KB application/contracts `0.1.8`. Its
[dated release receipt](RELEASING.md#verified-029-publication-2026-11-13) records
strict qualification of that graph. Use normal registry resolution and frozen
installs. Earlier `0.2.9`/KB `0.1.6` source-checkpoint results did not qualify
this dependency alignment.

The historical verified Support Desk `0.2.8` tuple retains exact KB `0.1.6`.
All five published `0.2.9` versions and internal Support pins advanced together;
the root stayed private at `0.0.0`. This alignment changed no Support Desk runtime
source, API surface, record layout or host activation decision. Earlier release
artifacts and receipts keep their original identities.

<a id="unpublished-task-15-canned-responses"></a>

## Task 15 canned responses

Omitting `cannedResponses` preserves manual staff replies/notes and their original
fingerprints. Hosts may supply a bounded deployment catalog and explicitly pass
`cannedResponse` on reply/note commands after preview and staff approval. Forward
`listCannedResponses` when implementing the full `SupportDeskApplication`
interface; it requires queue read and filters by target permissions. The pure
`renderCannedResponse` helper is available from application and core.

No collection, record migration, permission or dependency change is needed.
The existing reply/note Audit details gain only template ID/version on selected
uses. Keep catalog versions immutable across deployments. Withdrawn definitions
refuse new uses; exact accepted commands replay under current permissions even
after withdrawal. Do not remove or change their selection when retrying an
uncertain commit. Use verified published artifacts and keep host acceptance
separate from source readiness for production use.
See [bounds and send semantics](HOST_COMPOSITION.md#staff-canned-responses-task-15-source-candidate).

<a id="unpublished-029-engineering-worker-observations"></a>

## Published 0.2.9 engineering worker observations

All five published `0.2.9` versions and internal Support pins advanced together. The
optional application methods are `prepareEngineeringModelPlanned`,
`prepareEngineeringModelObserved`, `completeEngineeringModelObserved`,
`prepareEngineeringProposalObserved` and `beginEngineeringDispatchObserved`.
Forward those capabilities through structural adapters to use the shared
kernels; omitting them retains the existing standalone path. No existing
required method or coordinator entry point changes.

Observations belong to one application-owned attempt. Do not cache their data
as authority. Current proof and service access, fresh Source/Work confirmation,
final expiry checks and conditional writes remain required. Exact completion
ACK recovery still requires the original command and current processing
permission. Unknown outcomes retain the original identity and conservative
usage handling. There is no record migration or new paid opportunity. See the
[worker observation contract](ENGINEERING_EXPORT.md#candidate-029-worker-observations).
Host invocation/CPU and release qualification remain separate from source tests.

Reconfirming an already-prepared model through the guarded observation path is
read-only: after the guard returns, the application confirms the opaque Ticket,
Source and Work versions and applies the final proof, claim and expiry checks.
New preparation and the unguarded legacy path retain their conditional writes.
The AI physical-call shortcut applies only to the exact built-in application
object with its unchanged observed methods. Spread objects, proxies and wrapped
methods receive independent current checks and their additional bounded reads
after returning; forwarding an observation does not certify an adapter's later
awaits or confer permissions. Completion ACK recovery
preserves a current held or superseded result instead of reporting a candidate.

<a id="unpublished-029-staged-learning-delivery"></a>

## Published 0.2.9 staged learning delivery

Omitting `deliveryMode` preserves inline delivery. To select
`deliveryMode: 'staged'`, forward the exact SDK-owned
`application.stagedResolutionLearningDelivery` capability with its original own
`prepare`, `write` and `complete` methods. Missing or changed capabilities hold
before claim. Older structural ports can retain inline delivery.

Handle optional `checkpoint: 'prepared' | 'acknowledged'` on the existing
`pending`/`delivery` result and end that physical invocation. Resume the same
Work in a later physical call with its original deadline and request identity.
Preserve identical KB command/correlation IDs, payload, ordered references and
original expected generation when recovering an uncertain ACK. The marker
attests durable App progress and claim release. The SDK makes no `model.generate`
call in that checkpoint invocation. Custom
`checks.check` ports retain their billing policy. The reference host's source
composition uses deferred checks and receipt-only verification in these phases.
Both inline and staged completion perform final policy/receipt/configuration
checks after late KB reads. Current Source, role, target and opaque-version
fences still apply. See [the staged contract](RESOLUTION_LEARNING.md#opt-in-staged-draft-delivery-029-candidate).
SDK publication does not establish complete Native Workers Free 50/100 host
qualification, which remains pending.

The same staged option bounds `reconcileSource` to one unconfirmed destination
per invocation. A retirement attempt yields to later physical readback and
verified reconciliation, including after an unknown ACK. Keep scheduling the
existing reconciliation result under fresh retirement authority while durable
destinations remain pending. Inline reconciliation retains its bounded retries.

<a id="unpublished-029-follow-up-version-reads"></a>

## Published 0.2.9 follow-up version reads

Closing follow-up version checks start up to five independent Store reads
together and wait for the whole wave to settle. Results retain their original
order, so an earlier stale version or read failure keeps precedence over a later
failure. Later reads can already have completed when that result is returned.
This reduces serial round-trip latency while spending reads that an early-exit
sequence could avoid. Late authority or cancellation rechecks can also wait for
the started wave. Current permission, proof, version and commit guards remain.
Include every started read in host invocation budgets and measure latency on
the actual adapter.

<a id="unpublished-029-optional-openrouter-entry"></a>

## Published 0.2.9 optional OpenRouter entry

Import provider adapters explicitly from `@pegma/support-desk-ai/openrouter`.
The AI root remains provider-neutral. Its manifest declares exact direct
`zod@4.6.7` and `@pegma/storage-core@0.4.0` dependencies.
`createSupportIndependentCheckModel` and `createSupportIndependentChecks` each
require the original options object and a second logical host string matching
current route evidence. Keep authority, application, route/privacy and
receipt-key callbacks current. Pegma retains its existing route hashes, `ic2`
encoding and `pegma.dev.support-independent-checks.v2` MAC domain. RetireGolden
binds its own logical host and retains separate stores, keys, funding pools and
privacy/configuration evidence. See [the adapter contract](../packages/ai/README.md#optional-openrouter-adapter).

Learning receipt verification requires the issuer's retained checked-attempt
record in the same durable Store namespace, including legacy update proofs
without comparison data. Reconstructing a verifier against an empty Store
cannot authenticate those receipts from the MAC alone. Preserve that Store
alongside current authority, route and receipt-key wiring. See the
[comparison contract](RESOLUTION_LEARNING.md#candidate-scoped-comparison-evidence)
and the adapter's finite funding and record-capacity limits.

## Published 0.2.8 follow-up host guards

The `0.2.8` source additions, retained by `0.2.9`, add optional `EngineeringMutationOptions`
to non-post follow-up observation, retry, abandon, rejection and bundle
preparation. Existing calls may omit the options. Bundle preparation retains
its existing proof guard before the new options argument. AI
`prepareStaffReassessment` forwards optional `signal` and `verifyBeforeCommit`,
composing the caller assertion with its existing staff/invocation and checked
proof deadline fences. Exact accepted receipts retain current authorization and bypass new proof/late
guard work; each new transaction attempt checks the late host guard after SDK
proof/planning awaits and applies its synchronous assertion and original signal
at handoff. The AI invocation retains its existing `run.signal` behavior,
including receipt reads. Web posting retains its existing proof/host guard and
delivery contract; the candidate adds an optional
`EngineeringFollowupPostObservation` to its proof guard for authorized reads
and final opaque-version confirmation. Forward the optional observation
argument through adapters; older ports keep their standalone fallback. The
application also exposes `reassessEngineeringFollowupBundle` with an
`EngineeringFollowupReassessmentObservation` planner. Its command retains the
immutable intent identity; its fourth argument accepts the mutation options.
The existing AI staff helper uses this optional application port when present.
Structural ports may omit it to retain the full legacy path. Do not replace
receipt recovery or fresh proof with retained observation data. See the
[follow-up contract](ENGINEERING_FOLLOWUP.md#candidate-028-followup-host-guards).

The dated verified `0.2.9`/KB `0.1.8` tuple supersedes the historical
`0.2.8`/KB `0.1.6` checkpoint for producer adoption. Verified `0.2.10` and
current public `0.2.12` retain the same external graph. The
[0.2.12 receipt](RELEASING.md#verified-0212-publication-2026-11-14) records its
completed SDK release gates; actual wire-v2 host qualification remains separate.
No record migration is added.

<a id="unpublished-027-source-candidate"></a>

## Published 0.2.7 engineering reads

The verified five-package `0.2.7` tuple retains the guarded engineering controls
from published `0.2.6` and adds optional
`EngineeringApplication.readEngineeringContext(access, fence)`, returning
`{source, work?}`. Structural application ports may omit the method; the AI
coordinator retains its sequential Source-validation/Work read fallback. See
the [read contract](ENGINEERING_EXPORT.md#entry-points-and-authority).

`EngineeringReviewCommitGuard` also accepts an optional
`EngineeringReviewObservation` for a new approval attempt. Existing callbacks
may ignore it. Wrappers can forward the argument to retain the optimized path;
older structural application ports keep the original standalone-read fallback.
The observation is callback-scoped and retains current read, queue and privacy
grants. Policy access uses the existing resolver rule: `engineeringProcess` or
`engineeringPolicyRead` plus `queueRead`. It supplies no retained authority or
permission to skip later proofs. See the
[approval observation contract](ENGINEERING_EXPORT.md#candidate-027-approval-observation).

The published `0.2.7` tuple uses exact KB application/contracts `0.1.6`
from the [verified public KB release](https://github.com/pegma-dev/knowledge-base/releases/tag/v0.1.6).
Qualify the complete consumer graph for the host. The older `0.2.6`/KB `0.1.5`
artifacts remain unchanged. See the
[publication handoff](RELEASING.md#verified-027-publication-2026-11-11).

<a id="unpublished-026-guarded-engineering-controls"></a>

## Published 0.2.6 guarded engineering controls

The synchronized five-package `0.2.6` tuple is published and strictly verified.
When upgrading from `0.2.5`, synchronize all five Support versions and exact
internal pins. The optional AI package keeps exact KB application/contracts
`0.1.5`.

The seven controls listed in the
[engineering guide](ENGINEERING_EXPORT.md#026-candidate-guarded-engineering-controls)
accept optional `EngineeringMutationOptions` as their third argument. Existing
callers that omit options keep their behavior. Browser hosts can supply a
bounded read-only current-session/role guard and a deadline-backed signal; the
guard can return a synchronous `() => true` assertion checked at the final
transaction call. Refresh authority on every invocation and OCC retry. Do not
retain a prior guard result as permission for a later command.

Keep the exact original command through cancellation or an uncertain response.
A transaction already handed to the Store cannot be undone by aborting the
caller. Exact accepted receipts do not invoke the new callback or proof, but
current method permissions and the host's current admission/delivery checks
still apply. Invalid JavaScript option/guard shapes fail closed. Qualification
must include the host's real authority reads and storage budget; the SDK release
establishes no universal query/CPU allowance.

## Published 0.2.4 intake and final checks

The synchronized `0.2.4` release is published and strictly verified. Hosts
retain their own adoption and activation gates.

The optional `createAdmittedCustomerTicket` capability returns
`{view, initialMode}`. Fresh intake needs current create/read-own authority
and a trusted late `verifyBeforeCommit(mode)` callback returning a synchronous
`() => true` assertion. Preserve the closed original packet through unknown
acknowledgements and recover it before another assistant decision. Accepted
replay can omit options and returns the historical initial mode with the
current owned view. The existing two-argument create API and its historical
fingerprints keep their behavior. See the
[application contract](../packages/application/README.md#admitted-customer-intake-next-candidate).

The factory's return type includes the additive capability. Existing
`SupportDeskApplication` implementations keep their interface, while mocks
typed from the factory's full return type may need the added method. Exhaustive
switches over stored command types must cover `create_admitted_customer_ticket`;
its accepted receipt includes `initialMode`.

Staff can prepare a fresh intent for an edited draft of the same delivered
article and collection when its complete ordered provenance still matches.
Retain each intent's exact revision and content hash through submission and
unknown acknowledgements. See the [learning guide](RESOLUTION_LEARNING.md).

The `0.2.4` release also confirms the complete current KB draft after late policy
and authority reads during learning intent preparation and new review proofs.
A changed draft stops the new operation. Exact accepted receipt recovery keeps
its original precedence. The
[release follow-up guide](ENGINEERING_FOLLOWUP.md) describes the added optional
late staff check and synchronous proof assertion for posting. A follow-up
adapter must forward the supplied release proof guard's return value to the
application.

<a id="unpublished-025-attachments-and-staged-learning-reviews"></a>

## Published 0.2.5 attachments and staged learning reviews

The synchronized `0.2.5` release is published and strictly verified. The
[attachment contract](ATTACHMENTS.md) adds optional
immutable blob storage, scan and download fences, and bounded cleanup. Hosts
supply private storage, scanners and retention operations.

### Optional staged learning review capability

Published `0.2.5` adds optional
`ResolutionLearningApplication.stagedResolutionLearningReviews` when
`resolutionLearning.stagedReviews: true`. The separate AI factory
`createSupportDeskStagedLearningReviews` coordinates staff review through this
capability, a current original-actor resolver and read-only source/KB/policy
ports. Hosts explicitly select durable human-command semantics.

Admission's fresh original-browser guard precedes durable pending acceptance.
The admitted command remains active across browser logout until explicit
cancellation or completion settles it. Later workers resolve the same human's
current account/roles within the fixed operation ceiling. P1 returns
`prepared`, ending that physical invocation. A separate delivery performs P2.
Preserve the immutable command through status, unknown ACKs and cancellation.
Current review/queue authority governs receipt/cancel recovery. New mutation
proofs additionally require current KB authority. Each stage has a single CAS
attempt, fresh independent proof and final synchronous minimum-expiry fence.
`maxStagedReviewAttempts` defaults to eight with a hard maximum of 24 retained
rows across pending, held and terminal states. Expired unknown commands retain
their ownership and history.

Typed handlers for `SupportDeskLimitError.field` must handle the added
`staged_review_attempts` value. It reports the configured retained-attempt
admission limit. Stored-record consumers must handle
`resolution_learning_review_reservation`, the canonical command slot created
with the pending attempt and Audit. Completion conditionally replaces this
slot with the terminal receipt. The attempt reserves two future review/Audit
rows after its three-row admission. Typed consumers of the optional factory
must also handle `not_pending`, `not_claimed`, `prepared`, `completed`, `pending`
and `held`.
`not_pending` carries its outcome string as the queue-settlement signal.
The host pairs it with the retained dispatch key and uses `readReviewStatus`
for the canonical human result.
`completed` carries the canonical accepted/cancelled receipt. Pending, busy and
held outcomes retain the original command and queue pointer, while `prepared`
requires a later physical invocation. `pending.phase` includes `dispatch` for
pre-claim availability and authority-resolution failures. Authorization failures
retain the coarse `authorization_unavailable` reason. `prepared.status` contains
a pending status, and a terminal P1 result returns `completed` with its receipt.

The optional `readScheduling: "sdk"` mode schedules bounded read waves for the
known real read-only SDK graph. All three learning factories validate the
runtime option as `"sdk"` or omission. Custom structural ports execute serial
callbacks by default. Follow the
[full staged-review contract](RESOLUTION_LEARNING.md#opt-in-staged-human-review-source-candidate)
and [declared attempt layout](COLLECTIONS.md#staged-human-review-attempts-source-candidate).
Release qualification and actual Native D1/CPU, host queue, customer AI/provider
route and deployment acceptance remain required before their activation.

## Package and host boundary

The released inventory is `@pegma/support-desk-contracts`, `-core`,
`-templates`, `-application`, and optional `-ai`, all at exact `0.2.6` with
matching internal pins. Keep one coherent set. The base application remains
usable without AI, KB, a model provider, or GitHub.

Current ecosystem pins are Spine `0.1.2`, Storage Core `0.4.0`, Authorization
Core `0.4.0`, Audit `0.2.0`, and Mail `0.1.1`. Only the optional AI package
uses the verified KB application/contracts `0.1.5`. A host must independently
verify its complete published lockfile and consumer before deployment.

The source changes are described in [release notes](RELEASE_NOTES.md).
Each host still owns authentication, current permission resolution, durable
Store/namespace, mail transport, model and usage ports, KB authority, GitHub
installation, release proof, schedulers, retention, and UI. Package methods
grant no roles, Admin inheritance, or Agent Access scopes.

## Migration to published 0.2.2

The optional AI runtime dependencies on KB application/contracts advance to
exact `0.1.5`, with matching repository development/test pins. Keep the resolved
KB graph coherent; structural type compatibility does not establish runtime
error identity across versions or duplicate module instances. Remove obsolete
KB `0.1.2` constructor aliases or translation shims when adopting the verified
`0.2.2` graph, and test the actual host installation and bundle. Published
`0.2.1` manifests and their KB `0.1.2` dependencies remain immutable history.
The [0.2.2 receipt](RELEASING.md#verified-022-publication-2026-11-10) qualifies
the exact SDK artifacts; host adoption is a separate observed result.

The release adds [opt-in staged retrieval](ASSISTANT_COORDINATION.md#opt-in-durable-staged-retrieval)
while retaining the monolithic runtime default. Its exported
`AssistantProcessResult` return union always includes the new `prepared` member;
exhaustive TypeScript switches or matchers must add a case even when callers
omit `stagedRetrieval` or set it to `false`. Runtime opt-in does not narrow the
public return type.

Only opt-in staging can produce `prepared`, with `ticketId`, `turnId`,
`preparationAttemptId` and `nextAttemptAt`. Return from that physical invocation
and schedule a genuine later request, queue delivery or scheduler invocation
at or after `nextAttemptAt`. Do not call `processTurn` again or use `waitUntil`
inside the same invocation as a substitute. Both existing attempt caps must
allow at least two attempts; preparation consumes one without resetting counters
or raising caps, and staging permits only one paid opportunity.

Both resolvers must freshly validate current inputs while preserving full
validated configuration and customer-authority snapshot values across phases.
Matching version labels are insufficient: `dataControls.verifiedAt`,
`dataControls.validUntil` and opaque `usageScopeRef` all participate. Re-attestation
or scope renewal changes intentionally fail closed to finish/handoff before
new usage reservation or a model call, even with unchanged logical settings.
Do not normalize these fields away or cache stale evidence; the paid phase's
live configuration, authority, source and final-CAS checks still apply.

The release also adds [exact learning review intent recovery](RESOLUTION_LEARNING.md#exact-review-intent-recovery-022).
Use read-only `prepareReviewIntent`, then retain the entire intent and original
command/decision packet before submission. `submitReviewIntent`,
`readReviewReceipt` and explicit `cancelReview` accept that exact packet.
Receipt recovery precedes stale source/target checks; a null read is not a
terminal refusal. Cancellation competes atomically with approval, returns the
accepted winner when already committed, and never undoes it. Keep unknown
packets until an exact accepted/cancelled acknowledgement; never clear them
from a 409, GET or elapsed deadline alone. New submissions retain current proof
and authority guards; cancellation requires its current-human guard and bounded
Audit/receipt admission. Existing full-command `reviewProposal` remains usable.

No receipt rewrite is required. Legacy accepted command fingerprints and the
generic receipt layout remain unchanged; new intent commands add optional
`intentBinding`, and cancellation occupies the same command key with a separate
fingerprint domain. Older `0.2.1` reviewers reject the new field or cancellation
fingerprint, rather than accepting a cancelled review. They cannot interpret
the new acknowledgement union. Preserve receipts and rehearse actual downgrade
behavior instead of deleting them or claiming universal rollback compatibility.

SDK `0.2.2` publication and strict verification are complete. Host invocation/CPU
measurements and activation retain their separate gates; an SDK migration is
not live acceptance.

## Migration to published 0.2.3 engineering guards

The five verified packages and internal Support pins use exact `0.2.3`,
retaining exact AI KB application/contracts `0.1.5`. The application finishes
repository/policy observations before the supplied approval commit guard and
honors a supplied final rejection guard. The coordinator supplies a current-staff
rejection guard; direct application rejection may still omit one. Approval
retains the earliest verified proof expiry across the awaited host check and
the synchronous assertion at the existing partition CAS. Forward that assertion
when wrapping the application guard. Accepted receipts remain receipt-first
under current review/queue authority. See the
[engineering guide](ENGINEERING_EXPORT.md) and
[verified release receipt](RELEASING.md#verified-023-publication-2026-11-10).
Hosts must validate their exact installed graph and current session/role
boundaries before exposing the review surface.

## Rehearse the actual 0.1.1-to-0.2.0 upgrade

The SD-06 rehearsal below is retained as historical migration evidence. For
any later adoption, repeat the rehearsal against the exact selected verified
published artifacts and record a new receipt; a `0.2.0` result does not qualify changed
artifacts or a host's durable-store migration.

The required migration proof starts with records produced by the actual
published `0.1.1` application, then reads and mutates them with the packed
`0.2.0` artifacts in a clean consumer. Its receipt must record the exact
old and new artifacts, dependencies, runtime, Store adapter, operations, and
outcomes. The packer's separate `<output>-consumer-verification.json` receipt
(by default `.release-consumer-verification.json`) identifies synthetic
base/forward-migration scenarios with AI options omitted and disabled, plus
the optional AI public composition check. It records
`previousPublishedVersion: "0.1.1"`, `legacyMigrationScope: "web-records-only"`,
`emailWriter: "candidate"`, and `reverseRollbackProven: false`. The old SDK
writes the web records; inbound email is exercised only through the candidate,
because the published old SDK has no inbound-email processor.
The receipt binds `sourceRepository`/`sourceCommit` and all five actual archive
names, sizes, SHA-256, SHA-1, and SHA-512 integrity values, recomputed from the
bytes. Its base consumer records the genuine previous installation's official
registry URL and lockfile integrity in `previousArtifact`, alongside its own
resolved dependency pins. `runtime` records Node/V8, platform, and architecture;
`store` identifies Storage Core `0.4.0`'s `createMemoryStore` with `durable: false`.
Compare those bindings with the independently selected commit and prepared
archives, rather than accepting a matching candidate version alone.
The stable workflow retains consumer evidence separately from its strict
six-file release artifact. Keep the independent receipt/manifest hashes and
both upload IDs/archive digests with the release handoff, and preserve the
evidence before the workflow's 30-day retention expires. See
[release retention and recovery](RELEASING.md#stable-tag-and-workflow).

The publication receipt records the passed clean memory-Store upgrade proof.
Those scenarios do not establish production-store migration or rollback readiness.

A partial registry publication is not an adoption-ready release. Recovery
must reuse the original prepared artifacts and freshly authenticate the
already-present subset in the unprivileged registry preflight before any
remaining uploads. The publisher requires the independently bound preflight
receipt, the original preparation artifact ID/archive digest, and matching
release/subset bindings. Observation time has no arbitrary expiry limit.
Fresh whole-five-package checks before each upload allow only the authenticated
subset plus that invocation's own confirmed writes; drift or unavailable
evidence blocks further uploads. Only the final complete-set verification permits release
handoff; see [partial publication recovery](RELEASING.md#partial-publication-and-recovery).

Before enabling new capabilities:

1. Back up the instance and rehearse restore with the host's durable adapter.
   Record the configured physical row/message caps and retention policies.
2. Verify old customer/staff reads, human replies, Audit/receipt replay, mail,
   and queue behavior with every AI workflow disabled on the new SDK.
3. Run complete bounded queue and thread-index repair cycles as required by
   [host composition](HOST_COMPOSITION.md). Persist opaque cursors only after
   a page succeeds; a scan is not a snapshot.
4. Explicitly configure new permissions and worker authority. Use current
   named grants; do not treat a role name or an old session as a permission.
5. Check human, privacy, terminal, and follow-up capacity reserves before
   admitting new generation or outbound work. Saturation must hold derivation
   without spending another workflow's reserved completion capacity.
6. Rehearse cancellation, exact lost-acknowledgement replay, unknown usage,
   external reconciliation, source withdrawal, and deletion before rollout.

Omitted legacy handling remains human support. Missing lifecycle fields are
not evidence of a historical milestone. Existing quotas retain their limits;
new optional enrollment must not rewrite old success receipts into learning
or bug evidence. Missing legacy follow-up authority epochs hold eligibility;
fresh proof does not silently authorize an old issue association.

The candidate keeps new records in the layouts documented in
[COLLECTIONS.md](COLLECTIONS.md). The separate engineering policy collection
also has finite history and an authorized retention/pruning contract. Record
those policies in the host's upgrade plan rather than manually deleting rows
to make admission pass.

## Disable capability before considering a package downgrade

The supported operational fallback is human support on the new SDK with AI
generation and export controls disabled. Keep the current codecs, deterministic
request-person/takeover/reply paths, and the minimal workers needed to finish
or reconcile persisted work. Turning off generation does not settle unknown
provider usage, retract a GitHub issue, or complete KB cleanup.

Do not assume published `0.1.1` readers can decode rows written by this
candidate. No backward package-downgrade guarantee follows from additive
TypeScript types or AI-off behavior. A package rollback requires its own tested
storage compatibility or a host-approved restore/recovery plan. Do not erase
unknown work or replay receipts to force an older codec to accept the store.

## Withdraw sources before deleting bodies

Call `withdrawResolutionLearningSource` and `withdrawEngineeringSource` for
their independently enrolled sources before deleting ticket bodies or revoking
source access. Engineering withdrawal also scrubs its bounded follow-up
children using the parent privacy reserve, even if later composition omits
follow-up options. There is no separate follow-up privacy-withdrawal command.

Retain minimal usage and destination/request identities while acceptance or
external cleanup remains unresolved. Learning and engineering reconciliation
have dedicated authority and body-free retained views after ticket deletion.
Withdrawal is not a physical KB purge or GitHub retraction; external privacy
remediation remains separately authorized host work. Already sent canonical
messages follow ordinary ticket retention.

## Release evidence and open host handoffs

| Owner                   | Evidence and remaining responsibility                                                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Release owner           | Retain the verified SD-06 publication, original package and clean-consumer evidence recorded in the release receipt.                                   |
| Package maintainer      | AI registration and stable publication are complete; recheck actual dist-tags, policy and trusted-publisher configuration for each subsequent release. |
| Each host owner         | Durable-store upgrade/restore and AI-off fallback, current access/data controls, retention/recovery, and complete workflow acceptance.                 |
| Client and pilot owners | Actual requested-client authentication/authoring results, approved staging smoke, cross-host acceptance, and supervised pilot sign-off.                |

Source receipts and a successful package install do not close the host, client,
staging, or pilot handoffs. Follow [AI operations](AI_OPERATIONS.md) during the
host's separately approved rollout.
