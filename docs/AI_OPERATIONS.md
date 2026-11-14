# Optional AI operations

This runbook describes the merged SD-01 through SD-05 contracts assembled by
the current verified published synchronized `0.2.11` release; see its
[publication receipt](RELEASING.md#verified-0211-publication-2026-11-14).
SDK publication does not establish production deployment, verified host data
controls, or pilot acceptance. Use exact published artifacts and complete each
host's own [upgrade rehearsal](UPGRADING.md).

The workflows are separate: [answers](ASSISTANT_COORDINATION.md),
[resolution learning](RESOLUTION_LEARNING.md),
[engineering export](ENGINEERING_EXPORT.md), and
[release follow-up](ENGINEERING_FOLLOWUP.md). The base application remains
usable with all optional AI capabilities disabled.

Published `0.2.6` introduced final host guards and cancellation on seven
engineering controls. Published `0.2.7` adds compatible approval observations
and authorized engineering reads, retaining fresh proof and host authority.
The current `0.2.11` tuple pins exact public KB application/contracts `0.1.8`
and passed strict registry, native cryptographic/source and clean public consumer qualification. Its checker policy/wire v2 correction requires actual
v2 route requalification before host use; SDK publication does not establish
factual model quality. See the
[release notes](RELEASE_NOTES.md#0211-trusted-independent-check-policy). The historical
[`0.2.8` receipt](RELEASING.md#verified-028-publication-2026-11-12) and its KB
`0.1.6` graph remain unchanged.

The `0.2.8` source additions retained in `0.2.9` add optional late host guards/cancellation to non-post
follow-up controls and forwards staff reassessment guards. Reassessment may
use the optional application-owned planner observation to share authorized
reads and confirm their opaque versions after fresh proof. Existing structural
ports keep the full legacy path. Use the existing
current-browser/permission/deadline fence; a guard is read-only and does not
replace SDK proof. Web posting retains its authorization/delivery guarantees
and can use a per-attempt application-owned read observation with fresh opaque
confirmations; the compatibility fallback remains. Use the verified `0.2.11`
tuple and qualify the host's actual composition separately.
See the [published 0.2.8 contract](ENGINEERING_FOLLOWUP.md#candidate-028-followup-host-guards)
and [current publication receipt](RELEASING.md#verified-0211-publication-2026-11-14).

## Controls and human fallback

| Control                                                   | Operational effect                                                                                                                                                                                                  |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Answer configuration and `assistantHandlingEnabled`       | Stop new assistant generation/starts under their own checks. Request-person, staff takeover, and human reply remain deterministic application operations.                                                           |
| Resolution-learning processing and provider configuration | Stop new learning work under their own admission checks. Accepted source facts and independently approved guidance do not become invalid merely because a provider is disabled.                                     |
| Engineering generation configuration                      | Stop new bug-model work. Existing exact proposals can be reviewed or dispatched without generation configuration, subject to current processing/export authority, source, policy, metadata, and independent checks. |
| `engineeringPolicy.enabled`                               | Dedicated export kill switch, including emergency disable using its reserved Audit/receipt rows. Disabling export does not resolve a possible earlier GitHub write.                                                 |
| Follow-up workflow and generation configuration           | Stop the corresponding new workflow/generation activity. Provider availability is separate from staff checks, local rejection/abandonment, and exact metadata replay. No automatic release notice is enabled.       |

Keep reconciliation authority available separately from model configuration
and ordinary processing authority. A generation kill switch must not strand
privacy cleanup or be treated as evidence that an earlier external call failed.
Use human support on the new SDK as the fallback; disabling AI is not a promise
that old published codecs can read newly written records.

Each host supplies current Authorization Core access, budgets, purpose-specific
configuration, and verified data controls. Ready configuration must bind the
actual account/project, endpoint, model/features, exceptions, intermediaries,
version, verification time, and expiry. Typed references alone do not verify
the provider's settings. Disabled, expired, unavailable, or changed proof holds
new work. There is no implicit provider or retention-mode fallback.

The source-only [provider-group checker option](../packages/ai/README.md#opt-in-provider-group-checks-source-only)
requires explicit route, static allowlist and Admin-approval scope selections,
plus a newly hash-bound price policy and current group privacy/qualification
evidence. It does not extend the published `0.2.11` contract or enable a host.
An Azure group may include eligible regions and variants; it does not establish
the exact region of a previous endpoint approval. Preserve ZDR-only routing,
disabled input/output logging and no-other-provider fallback. The prompt and
completion price filters are USD per million tokens, separate from total
spending caps and actual native charges. Retain durable unknown-usage holds and
require the host's independent approval and activation gates before live use.

## Bounded workers and durable recovery

Persist a separate opaque cursor for each scheduled scan loop and purpose.
Count all adapter-returned physical rows/pages before filtering, keep returned
continuations unchanged, and repeat cycles. Candidate/review/reconciliation
hints grant no authority; confirm exact source/work state through public
application operations. Do not replace these loops with a raw Store query or
an event-bus delivery assumption.

Use fresh physical claim identities for separate invocations. Never finish,
settle, or reuse another live worker's claim. Keep leases, elapsed deadlines,
commit reserves, cancellation, and retry bounds aligned with the scheduler.
Late output must not commit merely because the host clock is frozen or skewed.
Guards may repeat read-only verification during storage retries; they must not
call a provider or perform an external mutation.

Repeat an uncertain storage command with the same command ID, input, body,
hashes, and fences. An invoked RPC may still commit after its caller times out;
a later guard rejection does not prove that the earlier invocation failed.
Recognize the durable receipt before generating a replacement body or intent.
Historical replay still requires current operation permissions and returns only
the result allowed by that operation.

Provider execution and billing are a separate uncertainty. Reserve usage before
paid work, reconcile idempotently with the prepared operation/attempt identity,
and retain unknown reservations. Timeout, malformed accounting, an unavailable
ledger, or a failed reconciliation must not become fabricated zero usage.
A replacement claim must not blindly repeat a prepared provider request.
Finite attempt limits remain in force after retry or reassessment.

Follow-up admission is stage-specific: exact model manifests and maximum
completion/accounting states are checked before paid calls; actual checked
bundles separately admit their body, request count, and later retest/post/hold
states. Five future rows and one slot fund bundle preparation and staff posting;
retest Audit/receipt rows use ordinary capacity. Use explicit staff retry for
eligible draftless held/expired work, reassessment for retained drafts, or local
abandonment to release reservations. None clears parent privacy withdrawal.

Published `0.2.9` follow-up `invocationMode: 'staged'` separates durable
not-called planning, one conditional generator attempt and fresh completion.
Use deferred Work checks for their separate prepare, provider and receipt
invocations. A received verdict carries no check receipt. Original attempt
ceilings, claim limits and semantic expiry still apply across queue waits.
Unknown paid outcomes remain reserved and held without automatic paid retry.
Keep body-free continuations durable before a possible paid phase. A later
`not_claimed` Work invocation reaches neither generator nor checks and can
remove a scheduling hint. Current staff reassessment retains its inline path.
See the [invocation contract](ENGINEERING_FOLLOWUP.md#candidate-029-followup-invocations).

Optional retest `observe` opens a fresh confirmation closure for each real
application attempt. Snapshot preliminary metadata before awaits and confirm
the actual single-use report observation before the final original-browser
guard. Any returned synchronous assertion runs after that guard at CAS. A null
or failed supplied observation holds without legacy fallback. Accepted receipt
recovery precedes either observation or legacy verification. Never serialize,
clone or reuse an opaque report handle across requests.

## External acceptance and reconciliation

Learning KB delivery retains the exact prepared operation, original expected
generation, command identity, and reference ordering. Any invoked KB error may
follow acceptance. Recovery reuses that exact request and does not regenerate
the candidate or consume another model attempt to explain a missing ACK.

Source cleanup inspects generation-consistent complete provenance, including
published source membership. A ticket reference present only in a pending
draft does not justify retiring independently sourced published guidance.
Unreadable provenance or missing original request identity holds reconciliation.
Absence and age never clear an unknown create. Conditional revision fences,
trusted terminal receipts, or established cancellation evidence are required.

Engineering commits `dispatch_started` before its single physical issue-create
attempt. A crash or uncertain begin ACK can leave zero observed POSTs and still
require reconciliation: another invocation cannot infer that no old owner holds
a permit. An export marker correlates acceptance; it does not make GitHub
idempotent. Empty searches, a 404, elapsed age, and metadata outages do not
authorize another POST. Use the separate reconciliation access and trusted
result verifier; preserve minimal destination identity until a terminal result
is established.

Follow-up requires current signed/allowlisted issue and deployment observations
with a confirmed affected-product mapping. Closure, a tag, or a package release
alone is not deployment proof. Rollback/reopen/failed-retest holds need explicit
staff action under fresh proof. Stale/unchanged/unavailable observations that
change no state are live zero-row reads, not cached mutation acknowledgements.
Only explicit current staff review/reply authority can post the checked web
notice. Posting preserves ticket lifecycle/handling and first-staff-response
facts, and adds no automatic email, ticket resolution, or KB publication.

## Privacy, retention, and capacity

Before physical deletion or source-access removal, permanently withdraw each
enrolled learning and engineering source through its public command. Engineering
withdrawal also scrubs follow-up children. These persisted hooks still run when
later options omit a workflow. Do not spend one workflow's privacy reserve on
another or delete an unknown destination to admit new work.

For deferred SD05 checks, retain
`createSupportReleaseFollowupCheckCleanup({store, clock})` independently of paid
configuration. Call `discardTicket` during source forgetting and `purgeExpired`
from existing bounded maintenance. These methods require no route, key or
funding. They erase queued private requests while retaining body-free intent
tombstones. Expiry never authorizes another provider attempt.

Keep only required opaque delivery/usage/recovery identities after withdrawal.
The host owns canonical message retention, external privacy remediation,
physical deletion, backups, and operational content logging. Never log private
conversation, notes, KB drafts, prompts, credentials, or server proof envelopes.
Public examples and reports use fictional data; actual host configuration and
evidence stay private.

Monitor physical row/message headroom, unresolved reservations, claim age,
pending reconciliation, and held/restricted work using metadata. Human, privacy,
terminal, and prepaid follow-up tails are independent. Capacity errors are
explicit holds or rejections, not permission to raise caps silently, truncate a
valid request, evict live identities, or mark unknown work complete. Engineering
policy history has a separate authorized prune/receipt-retention horizon.

## Incident handoff

| Condition                                     | Response and recovery criterion                                                                                                            |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Provider/configuration/evaluation unavailable | Stop new generation; use human support and reconcile reserved usage. Resume only with current approved configuration and evidence.         |
| Source/check/authority changed                | Hold stale output and require fresh exact proof/review. Replaying old receipts does not grant new authority.                               |
| Possible KB/GitHub acceptance                 | Preserve the original identity and use its reconciliation workflow. Do not resend because search is empty or time passed.                  |
| Capacity exhausted                            | Stop new derivation, keep human/privacy paths, and complete or explicitly abandon eligible work under its public contract.                 |
| Privacy deletion requested                    | Withdraw enrolled sources first, retain minimal unresolved identities, then perform the host's separately authorized deletion/remediation. |

The [publication receipt](RELEASING.md#verified-sd-06-publication-2026-11-08)
records the completed SDK release gates and artifact/consumer bindings; the
release owner retains that evidence. Each host owner still owes durable-store
recovery, existing-login/Admin consent, actual requested-client results,
verified staging/provider/privacy controls, complete workflows, and pilot
sign-off. Package source tests do not close those gates.
