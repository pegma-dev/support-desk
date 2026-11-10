# Optional AI operations

This runbook describes the merged SD-01 through SD-05 contracts assembled by
the current verified published synchronized `0.2.1` release; see its
[publication receipt](RELEASING.md#verified-021-publication-2026-11-10).
SDK publication does not establish production deployment, verified host data
controls, or pilot acceptance. Use exact published artifacts and complete each
host's own [upgrade rehearsal](UPGRADING.md).

The workflows are separate: [answers](ASSISTANT_COORDINATION.md),
[resolution learning](RESOLUTION_LEARNING.md),
[engineering export](ENGINEERING_EXPORT.md), and
[release follow-up](ENGINEERING_FOLLOWUP.md). The base application remains
usable with all optional AI capabilities disabled.

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
