# Engineering assessment and export: SD-04 source contracts

SD-04's source merged in [PR #40](https://github.com/pegma-dev/support-desk/pull/40)
and first shipped in the verified synchronized
[`0.2.0` release](RELEASING.md#verified-sd-06-publication-2026-11-08).
The current synchronized release is `0.2.6`; see its
[publication receipt](RELEASING.md#verified-026-publication-2026-11-11).
This handbook describes released contracts, explicitly marked source-candidate
changes, and host responsibilities, not host activation. There is no runnable host recipe here. Scope comes from the
[approved plan](KNOWLEDGE_AI_PLAN.md#bug-evaluation-routing-and-github-export)
and the [collection checkpoint](COLLECTIONS.md#sd-04-engineering-layout-checkpoint).

## Entry points and authority

Source candidate `0.2.7` adds optional
`readEngineeringContext(access, EngineeringSourceFence)`, returning
`EngineeringReadContext` with `source` and optional `work`. The combined read
shares authorized Source/Ticket hydration. Source access, privacy and matching
eligibility/fence checks precede protected Work reads. A terminal or different
Source returns Source alone; a withdrawn Source also skips the Ticket read.
Later opaque Source/Work confirmations remain after protected reads. The
exported `matchesEngineeringSourceFence` supplies the shared fence predicate.

The standalone readers retain their conditional Source-first reads. After the
same fresh service-authority and policy boundary, the AI coordinator selects
the optional context, or uses its original sequential Source-validation/Work
read fallback when the structural application port omits it. No observation
crosses an external proof boundary, and accepted receipts still precede new
proof reads. This adds no permission, cache, Store primitive or atomic-snapshot
guarantee. The candidate AI package pins exact verified public KB
application/contracts `0.1.6`; see the
[current source dependency contract](RELEASING.md#source-version-027).
Hosts must measure the complete invocation, including their own authentication,
proofs, limiter and closing checks; grouped reads do not establish a universal
Workers query or CPU budget.

`createSupportDeskApplication` exposes the fixed operations in
[EngineeringApplication and EngineeringPolicyApplication](../packages/application/src/engineering-types.ts).
The optional `createSupportDeskEngineering` coordinator follows the
[AI port contracts](../packages/ai/src/engineering-ports.ts): `scanCandidates`,
`processWork`, `reviewProposal`, and `reconcileSource`. The base application has
no GitHub client, model-provider dependency, or source-code execution facility.

The host supplies current Authorization Core `AccessContext` values. Permission
names add no roles, Admin inheritance, installation rights, or Agent Access
scopes. Staff operations require queue access and their dedicated evidence,
review, withdrawal, or policy permission. Restricted material requires its
separate read permission; ordinary engineering read/process authority must not
make security reports available to the normal assessment path. Processing and
reconciliation have distinct named permissions and service authority.

Application completion, proposal, review, dispatch, and reconciliation operations
use exact fences and the required read-only guards for current external facts.
A guard must not call a model, create an issue, or perform another external
mutation inside a storage retry. A historical receipt remains subject to current
authorization and does not establish current policy or remote authority.

<a id="026-candidate-guarded-engineering-controls"></a>

## 0.2.6: guarded engineering controls

These controls are published and strictly verified in `0.2.6` and retained by
the local unpublished `0.2.7` source candidate.
The optional third `EngineeringMutationOptions` argument applies to
`enrollEngineeringSource`, `submitEngineeringEvidence`,
`selectEngineeringRepository`, `withdrawEngineeringSource`,
`invalidateEngineeringSource`, `putRepositoryPolicy` and
`disableEngineeringExports`. Existing two-argument callers remain compatible.
This adds no AI coordinator method or public engineering route.

The SDK captures `signal` and `verifyBeforeCommit` once at entry and rejects
invalid option/guard shapes. For each new conditional transaction attempt, the
read-only host callback runs after SDK external proof/planning awaits and
before the synchronous final fences and CAS. It can return a synchronous
`() => true` assertion; the assertion and captured signal are checked at the
transaction call. Every OCC retry runs the live callback again. The host
supplies current original-actor/session/role checks and bounds any external
reads with its own deadline-backed signal. The callback must not perform an
external mutation.

An exact accepted receipt returns under current method permissions without
invoking a new guard or external proof. Host admission and delivery checks
remain current. Abort before transaction handoff prevents a new commit;
abort after handoff cannot undo an accepted write, so uncertain results retain
the exact command for recovery. This is a bounded fresh observation of external
authority, not cross-store atomicity. Hosts measure the added reads within their
complete physical request budgets. See the
[upgrade guidance](UPGRADING.md#unpublished-026-guarded-engineering-controls).

## A verified failure is the input

Engineering enrollment and `submitEngineeringEvidence` establish a separate
source from resolution learning. Evidence can qualify while a ticket is open.
A customer success confirmation, resolved status, successful test, inactivity,
or model assertion does not establish a bug.

Accepted evidence is either an explicit staff-verified failure or a relevant
trusted failing-test receipt. It binds expected and actual behavior,
reproduction steps, immutable visible-message references, the submitting actor,
the current ticket/source fence, and trusted product/version/build facts.
`EngineeringProductContextPort` supplies product facts;
`EngineeringTestReceiptPort` authenticates the opaque execution receipt against
the report and product. These bounded ports neither execute submitted code nor
fetch caller-provided URLs. Missing or mismatched trust holds assessment.

The model receives bounded customer-visible conversation, the relevant report,
and allowlisted descriptive repository material. Private notes, actor IDs,
receipt identities, installation authority, and private source references stay
outside provider content and operational logs. `restricted` and `uncertain`
security classifications stay outside ordinary export. A human routing choice
does not clear security classification or replace failure evidence.

## Repository policy and routing

[engineering-policy.ts](../packages/application/src/engineering-policy.ts)
owns `support-desk.engineering-policy.v1`, partition `instance`. The absent
policy is disabled with an empty allowlist. `readRepositoryPolicy` returns the
current generation, hash, and policy. `putRepositoryPolicy` and
`disableEngineeringExports` require stable command/correlation IDs and the
expected generation; their compact acknowledgements identify the accepted
generation/hash. On a stale generation, read the head and retry deliberately.
`createEngineeringPolicyServices().resolve` supplies the fresh keyed policy
read used by other services.

Admins configure immutable repository IDs plus current owner/name, visibility,
responsibilities, product/component/version descriptions, permitted labels and
templates, and per-repository enablement. The only initial publication mode is
`approval_required`; automatic filing is unavailable. Credentials and GitHub App
installation configuration remain host-owned. Policy edits commit the head,
Audit event, and replay receipt together. Policy and ticket partitions have no
shared transaction: workers must check current policy again at each affected
boundary.

The allowlist describes destinations; it is not a deterministic routing rule.
`EngineeringRoutingPort` supplies independently verifiable calibration tied to
reviewed evaluation evidence, the model/prompt/parser versions, normalized
routing, and the current policy. A model confidence score is insufficient.
Unknown, competing, out-of-scope, or insufficiently calibrated choices hold for
staff. `selectEngineeringRepository` records the authorized choice and reason
against the exact work and policy; it does not bypass export checks or approval.

`engineeringPolicy.enabled` is the export kill switch. The policy partition
reserves two physical rows for its emergency disable Audit and receipt even
when ordinary edits have exhausted admission. Replaying an accepted disable,
or disabling an already-disabled current head, adds no rows. A disabled policy
does not erase accepted failure evidence or resolve uncertain remote writes.

Schedule `pruneRepositoryPolicyHistory(access, { limit, cursor? })` with current
policy-management and queue-read authority. `engineeringPolicy.historyRetentionMilliseconds`
defaults to 30 days and must be a positive safe integer. Each invocation scans
one physical page of at most 64 rows, including the head and unrelated history
before filtering. Persist its unmodified `nextCursor`, and start another cycle
after it reaches `null`; scans are not snapshots. The result counts physical
rows, examined pairs, removed rows/pairs, and incomplete cleanup.

Only expired policy Audit/receipt pairs and interrupted cleanup remnants are
removed, including the latest
accepted change's history once it reaches the retention horizon. The current
generation/hash/policy head is never removed. Thus an exhausted partition can
disable immediately, retain history for the configured interval, then reclaim
history and re-enable through a fresh expected-generation policy command.
Receipts are removed before their Audit rows using their opaque storage
versions, with current head and authorization checks. These two removals are
not atomic: a conflict or interruption may leave an Audit row for a later
cycle. New receipts carry their own acceptance timestamp so an expired receipt
orphan can also be removed; an older receipt without a readable paired Audit
timestamp is retained.

Policy command replay is guaranteed only while its receipt remains retained.
After expiry, the original command's older `expectedGeneration` cannot change
the newer head. Read the current head and use a fresh command ID for a new
intent. Export historical Audit externally before pruning if a host requires a
longer record of policy changes; pruning does not supply an archival service.

## Prepare and review the complete disclosure

`EngineeringGitHubPort.getMetadata` supplies current immutable identity,
owner/name, visibility, and active installation authority. A repository
transfer, visibility change, allowlist removal, changed installation binding,
or policy edit requires reassessment and fresh approval.

Duplicate searches are outbound disclosures too. The current
`EngineeringProposalPort.duplicateQuery` receives the configured repository
descriptor and returns trusted configured query text. Do not substitute raw
ticket text, failure reports, or unchecked candidates. Any sanitized-query
extension needs an independent disclosure check before search. A missing trusted
query holds preparation as `duplicate_query_unavailable`; it does not stand in
for an empty search result. Search results and physical counts are bounded; an
empty result is neither exhaustive duplicate proof nor evidence that an earlier
create was rejected.

Proposal construction is server-local. `prepareEngineeringProposal` persists
the exact sanitized operation, repository observation, title/body, labels,
template, evidence references, and opaque export marker. Independent privacy,
factual, security, and public-reproduction checks bind that complete request,
candidate, source/evidence, routing, and policy. A model's own assessment is not
verification. Inspect hidden text and Markdown comments as part of the body.

Public issues require synthetic reproduction details and approved public
evidence. Remove private ticket links, customer identifiers, secrets, internal
notes, account-specific values, and restricted product details. Private
repositories still receive only the necessary sanitized content. Uncertainty
holds the proposal for restricted human handling.

`reviewEngineeringProposal` records staff approval or rejection of the exact
proposal. Approval binds its content and request hashes, source generation,
repository identity/current metadata and visibility, policy, routing, and check
results. Editing any bound fact requires fresh checks and review. The coordinator
rechecks current authority and remote facts immediately before dispatch.

**Published `0.2.3` review guard.** For a new decision, pass a trusted
read-only `verifyBeforeCommit` callback in the coordinator's
`reviewProposal(access, command, { signal, verifyBeforeCommit })` options. Use
it to check the original browser session and current staff role. Approval
finishes its external proof and current repository and policy observations
before the callback. Rejection checks the current invocation and reviewer,
with no export proof requirement. Direct application callers may omit the
rejection guard.

The coordinator bounds the callback by the invocation's signal and deadline.
After the guard, the application checks reviewer permissions, source and proof
expiry and capacity synchronously before its conditional transaction. When the
coordinator receives a precommit callback refusal on its first attempt, it
returns the safe `verification_unavailable` category without a retry. An
earlier uncertain write can still yield `review_acknowledgement_unknown`. The
partition transaction protects its own record versions. Authority in separate
stores can change after observation.

An exact accepted receipt is returned before the mutation guard or external
proof, subject to current review and queue permissions. Hosts still check
current authority when admitting the request and before returning its result.

### Candidate 0.2.7 approval observation

For a new approval attempt, the Application may supply an optional
`EngineeringReviewObservation` argument to `EngineeringReviewCommitGuard`.
It is lazy and valid only until that guard settles. `readWork(access)` enforces
the standalone read/queue/private grants. `read(access)` retains those checks
and uses the existing policy-access rule: `engineeringProcess` or
`engineeringPolicyRead` plus `queueRead`. It returns that attempt's already
loaded Source/Work and the fresh policy observed immediately before the guard.
The AI coordinator uses current service access for these reads; the object
supplies no authority.

After external proof awaits, the coordinator resolves fresh service access,
reads fresh policy and calls `confirm(access)`, which confirms the original
opaque Source version before the Work version. Opaque versions stay inside
the Application. The existing transaction still compares Ticket/Source/Work
versions, and a conflict creates a new attempt observation. Final policy,
late host and closing authority checks remain at their existing boundaries.
The observation is never a cross-attempt cache or an atomic host snapshot.
Existing guards may ignore the optional argument. Older structural application
ports omit it and retain the original standalone read/authority path. Hosts
still measure their complete invocation; this source optimization establishes
no universal query/CPU allowance or Native host qualification.

`link_existing_issue` records a private Support association with the approved
existing issue. It sends no comment, changes no external issue, and grants no
permission to make later public edits. Those actions require a separate exact
approval boundary.

## Dispatch once, then reconcile uncertainty

An approved request must already be durable. `beginEngineeringDispatch` commits
the fenced `dispatch_started` state before the one physical `createIssue` POST.
Each physical worker invocation uses a fresh claim identity. A replacement
worker that finds possible dispatch performs reconciliation only; a lost begin
acknowledgement is not permission to create based on a later read.

A crash or failed final authority check can consume the durable start without
making a POST. That dispatch may remain unresolved until authoritative
no-acceptance proof becomes available. Replacements preserve this uncertainty
and its destination capacity; the service promises at most one physical POST,
not eventual filing.

The export marker correlates acceptance; it does not make GitHub idempotent.
After any potentially accepted error, preserve the exact repository, dispatch
identity, request hash, and marker. `EngineeringGitHubPort.reconcile` and
`EngineeringDispatchResultVerifier` must establish unique acceptance or an
authoritative no-acceptance result. Empty searches, missing issues, timeouts,
elapsed age, and unavailable metadata remain unknown. They never authorize a
second POST. A confirmed rejection closes that dispatch; any later request must
pass its own current approval boundary.

Generation uses its own `support_bug_assessment` configuration, verified data
controls, budgets, tokenizer, and durable usage accounting. Disabling that
provider route stops new generation; it does not invalidate accepted bug facts
or require a model call to review an existing exact proposal or dispatch an
already-approved request. Those steps still require current source, policy,
calibration/check receipts, remote metadata, and installation authority.
`reconciliationAccess` is separate from generation service access and remains
usable for bounded read/proof reconciliation after processing is disabled.

## Invalidation, retention, and finite work

Visible-message changes, reopening, and explicit evidence/product/check-policy
revocation invalidate the persisted engineering source even when a later host
configuration omits engineering. Notes and administrative metadata do not become
new failure evidence. Claims, attempts, and receipts do not advance the Ticket's
domain revision. New evidence never silently revives an old approval.
Automatic invalidation commits with the triggering ticket command's Audit and
replay receipt; its source/work updates share that same transaction.

Call `withdrawEngineeringSource` before deleting ticket bodies or revoking
source access, and withdraw other enrolled derivation workflows independently.
Permanent withdrawal removes private evidence, manifests, and proposal copies,
stops new export, and retains the minimal opaque destination/request identity
and usage tombstones needed for reconciliation. `readEngineeringReconciliation`
and `recordEngineeringReconciliation` support that retained state without
claiming that a deleted source remains readable. Withdrawal cannot retract
content already exported to GitHub; external privacy remediation remains
separately authorized host work.

Repository policy defaults to eight entries, with a hard maximum of twenty;
its physical history defaults to 256 rows, with a hard maximum of 1,024. Complete
encoded records stay within 60,000 conservative UTF-16 JSON bytes. Ticket generations, destinations,
proposals, attempts, leases, and worker lifetimes are independently bounded.
Paid and outbound work needs room for its largest legal later states, including
escaped metadata, acknowledgements, and replacement claims. Unknown or live
destinations cannot be evicted to admit another request.

Engineering admission preserves the existing human support reserve. A learning
source's two withdrawal rows and an engineering source's two withdrawal rows
are separate: when both are enrolled, four rows remain reserved for those two
independent commands. Engineering work also prepays its own two terminal
Audit/receipt rows. Ordinary mutations cannot spend these reserves. Saturation
holds new derivation rather than silently raising the ticket cap or removing
uncertain work.

The host owns durable scan cursors and scheduler retries. `scanEngineeringCandidates`
returns one bounded physical page and its unmodified continuation. `candidates`
identify processing work; `reviewSources` identify sources needing attention,
including missing-evidence and restricted cases with no processable work.
`reviewCandidates` supplies exact work keys for human routing, proposal review,
and restricted review. `reconciliationSources` identifies possible remote writes.
Count every adapter-returned row before filtering. Confirm hints through
`readEngineeringSource` and `readEngineeringWork`; discovery grants no authority.

Restricted review hints require current `engineeringRestrictedRead`, `engineeringReview`,
and `queueRead` permissions. Revoking any of them hides those hints. Restriction
can advance the source generation while its retained binding still identifies
the older classified work key. Fresh security-reviewed ordinary evidence changes
that binding and removes the old case from current review attention; retained
old work still requires restricted read authority. These are bounded discovery
hints, with no new queue collection, hidden query, or event-bus delivery guarantee.
