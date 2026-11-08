# @pegma/support-desk-ai

Optional, provider-neutral Support Desk answer, learning, engineering, and
release follow-up coordination.
This source candidate is `0.1.1`; it has not been published. A synchronized
Support Desk release is required before host adoption. Its KB dependencies are
the exact verified published `0.1.2` application and contracts packages.

The base Support Desk application works without this package, a KB, or a model.
Customer request-person and staff takeover remain deterministic application
commands during provider outages. Email remains human support. This package
provides separate answer, resolution-learning, engineering, and release follow-up
coordinators. Answering only
replies or escalates. Learning prepares private KB drafts and reconciles source
withdrawal through separate retirement authority. Engineering prepares verified
bug proposals and approval-controlled issue exports. Follow-up prepares private
release bundles and posts an exact web notice only through current staff approval.
These coordinators cannot
resolve tickets, change accounts, or publish knowledge.

`createSupportDeskLearning` and `createSupportDeskLearningSourceVerifier` are
merged SD-03 source. See the
[resolution learning guide](../../docs/RESOLUTION_LEARNING.md) for exact proof,
permission, draft, review, privacy, and recovery boundaries. Host adoption
requires the synchronized SD-06 release.

`createSupportDeskEngineering` is merged SD-04 source. It uses verified
failure evidence, current admin repository policy, independently calibrated
routing, exact sanitized export checks, and staff approval. A durable dispatch
fence precedes one physical GitHub creation attempt; uncertain acceptance
requires reconciliation. See the [engineering guide](../../docs/ENGINEERING_EXPORT.md).
Host adoption still requires the synchronized SD-06 release and its activation
gates.

`createSupportDeskReleaseFollowup` is the SD-05 implementation candidate, with
four methods: `scanCandidates`, `processWork`, `prepareStaffReassessment`, and
`approveAndPostWebUpdate`. Generation uses the separate
`support_release_followup` purpose and current evaluated model/data-control
configuration. Provider input contains customer-visible conversation and
host-approved public release facts; operational IDs, private KB content, and
internal notes stay outside it.

`processWork` checks current `engineeringFollowupProcess`,
`engineeringFollowupRead`, and `queueRead` before claim or paid preparation.
Body-free `scanCandidates` instead accepts process authority alone, or
`engineeringFollowupReview` plus `queueRead`, without private read or implied
processing rights. New staff reassessment needs follow-up read/review and queue
grants; new posting also needs `replyAny`. The base APIs retain their narrower
purpose permissions.

The host supplies current release evidence, target selection, independent
whole-bundle checks, and usage accounting. Optional KB access exposes only actual
`getDraft` and `getValidationRequirements` reads, or an explicit `none` target.
KB change proposals and retests remain private handoffs with no KB write or new
resolution-learning proof. Staff reassessment and posting recheck current proof
without generation configuration; rejection remains a base-application command.
Staff reassessment first attempts narrow actor/intent-bound opaque preparation
recovery before proof or private-work reads. Paid preparation admits the exact
manifest and maximum accounting/candidate states; success compacts that attempt
to an opaque usage tombstone and acknowledgement. The actual checked bundle has
separate admission for its body, request count, retest, posting, and scrub states.
Retest Audit/receipt rows use ordinary capacity outside the prepaid posting tail.
Accepted preparation recovery needs only current review/queue authority, and
accepted post replay retains review/queue/reply authority. These opaque metadata
acknowledgements need no read grant or private work/proof calls. The application
also exposes explicit draftless `retryEngineeringFollowupWork` with fresh proof,
unchanged lifetime attempts, and five-row/one-slot readmission, plus local
`abandonEngineeringFollowupWork` that releases reservations without provider
ports. Neither expands this coordinator's four-method factory or replaces
parent privacy withdrawal. Stale/unchanged/unavailable observations that change
no durable state remain live reads with no persisted receipt.
There is no automatic notification or email path. See the
[release follow-up guide](../../docs/ENGINEERING_FOLLOWUP.md) and
[port contracts](src/release-followup-ports.ts). Current-head validation/review,
publication, and host acceptance remain open.

## Composition

`createSupportDeskAssistant(options)` takes the existing
`AssistantTurnApplication`, the KB application's `retrieveAnswerSources` and
`confirmAnswerSources` methods, a fresh service-access resolver, a Spine clock,
and explicit host ports exported from this package:

- `AssistantConfigurationPort` resolves current, verified configuration.
- `AssistantCustomerAuthorityPort` independently rechecks the active customer's
  current access, audience/policy versions, collection IDs, applicability, and
  opaque usage scope. Assistant permissions never establish the KB audience.
- `AssistantModelPort` performs one provider request outside storage retries.
- `AssistantUsagePort` durably reserves and reconciles operation/customer/site
  token, cost, and attempt limits. The host supplies its limiter and ledger.
- `AssistantTokenCounter` counts locally using the selected model's tokenizer.
- Optional `AssistantEscalationPolicy` adds trusted site topic, security, or
  repeated-unsuccessful-suggestion rules. Built-in boundaries escalate missing
  approved guidance, configured turn/attempt limits, invalid results, unavailable
  authority/configuration, and exhausted budgets.

`scanCandidates({cursor?, limit})` delegates one bounded physical scan page;
the host persists its opaque cursor. `processTurn(command, {signal?})` accepts
`ProcessAssistantTurnCommand`: ticket/turn, worker ID, and lease duration.
Each physical invocation generates its own fresh internal claim ID. Concurrent
scheduler callbacks cannot replay one live execution's claim and call the
provider twice. An invocation encountering a live owner returns `not_claimed`;
it neither settles that owner's reservation nor finishes its attempt. The result
is `not_claimed`, `completed`, `finished`, or `pending` with a storage stage. The
host repeats bounded discovery; recovery waits for the prior lease to expire.
Claims and jobs are durable application state, not an in-package queue or
database. The underlying application's claim API remains idempotent for its
trusted direct callers; the coordinator owns a separate ID for each execution.

The host resolves and verifies actual documented ZDR account/project, endpoint,
model, feature, exception, and every intermediary setting before returning
`ready`. `AssistantDataControls` holds opaque references, configuration version
binding, verification time, and expiry. It contains no credentials. Disabled,
unavailable, expired, mismatched, and unverified configurations fail closed;
there is no retention-mode or provider fallback. The resolver must recheck
current configuration on every invocation, including final validation. These
typed evidence references do not independently verify a provider's settings.

## Model boundary

The first `generate` argument is the entire allowed model input: trusted
instructions, customer-visible customer/assistant/support message text, and
the KB's **unchanged canonical `serializedSources`** envelope. The adapter must
treat message/document text as untrusted data and must not forward the second
argument's server context or configuration proof references into prompts or
content logs. No internal notes, requester identities, principal IDs, usage
scopes, ticket fences, private provenance, or operational identifiers are added
to model-visible input. The host prompt and adapter must request this exact
JSON schema:

```ts
type Output =
  | { kind: "answer"; text: string; citations: AnswerSourceReference[] }
  | {
      kind: "escalate";
      reason:
        | "no_guidance"
        | "unsuccessful"
        | "capacity"
        | "provider_failure"
        | "other";
      text: string;
    };
```

References use all eight KB fields, including policy and application/governance/
validation generations. Answers require at least one exact supplied reference.
A source-backed clarifying question is an answer; unsupported or conflicting
guidance should escalate. Extra output fields and unsupported outcomes fail.
The adapter returns raw `outputJson` with separate provider/model/request
identity and usage. Bytes are bounded **before** parsing, then structure,
citations, token/cost budgets, and expected provider/model identity are checked.
Provider/model/request IDs, currency, configuration/version IDs and other
scalar metadata reject every C0 control character and DEL, including tabs and
line breaks, matching the application's persisted metadata boundary. Actual
instructions, messages, answer text and handoff summaries remain multiline.
Only safe confirmed KB labels are appended as plain text citations. No article
URL is inferred, including for bot-only collections. No unchecked text streams
to customers. Runtime schema checks do not prove factual support: maintain
versioned source-grounded evaluations and host acceptance evidence.

## Durable execution and recovery

The coordinator claims, resolves fresh configuration/customer authority,
retrieves permitted approved whole articles, fingerprints the complete bounded
request, and prepares its immutable generic binding on the existing job row.
That binding retains versions, every full source reference, applicability/
audience hash, deadline, fingerprint, and a predetermined usage reservation ID;
it contains no prompt dump. Only then does the host reserve usage. After that
awaited reservation, the coordinator rechecks its live fence through identical
preparation and freshly resolves customer authority, confirms every supplied
source, and verifies identical current configuration immediately before its
single provider call. Disabled or changed processing controls cause zero model
calls and `not_called` reservation reconciliation, followed by human handoff.

Immediately before **each** completion CAS, the application's trusted read-only
guard resolves current configuration and customer authority and confirms
**all** supplied sources, including uncited sources. Changed configuration,
authority, applicability, references, or source envelope rejects the result.
The application rechecks lease/deadline and ticket/handling/trigger fences after
the guard, atomically committing reply/escalation, terminal job, receipt, Audit,
and handoff/quota effects. KB confirmation is a current observation; it is not
a cross-store lease or transaction.

Identical preparation retries within an invocation reuse the same binding.
A new invocation waits until the live owner's lease expires, then claims a
fresh fenced generation and bounded attempt. Prior prepared provider execution
is conservatively unknown; a restart never blindly repeats that attempt's
provider request. Old unknown reservation references remain available for host
reconciliation, and bounded attempts or automatic exhaustion handoff prevent
unbounded calls. Provider acceptance can be uncertain, so this makes no
exactly-once paid-call guarantee.

Lost completion acknowledgment retries the **same command, body, and
fingerprint**. If acceptance remains uncertain, the result is `pending` at
`complete`; no finish or model regeneration occurs in that invocation. Later
claims observe an accepted terminal job, or conservatively recover a remaining
prepared attempt. Usage reserve/reconcile operations must be durable,
idempotent for operation/attempt/fingerprint/reservation identity, and retain
unknown reservations until conservatively settled. Failed reconciliation does
not imply free usage or authorize an unbounded retry.

## Limits and host obligations

The invocation defaults to at most 25 seconds with a one-second completion
reserve, below the host scheduler's default 30-second lease. Generation is also
bounded by the actual job lease, fixed turn deadline, and configured duration
(at most 20 seconds). An AbortSignal and independent bounded wait reject late
provider output even if an adapter ignores cancellation. Cleanup remains
bounded and can reconcile usage and attempt human handoff after cancellation.
Storage commands retry identically at most three times (default two).
Pre-provider customer/configuration/source reads share the earlier generation
deadline, preserving the completion reserve. Final commit validation can use
the full attempt deadline; late results never authorize a provider call or CAS.

Set the trusted `maxMessageCharacters` factory option to the application's
actual message cap (default 20,000; integer 1–20,000). The application API does
not expose its configured limit, so a host with a lower limit must pass the
same value here. Before preparation, reservation, or a paid request, the
coordinator reserves the complete worst-case citation footer using all supplied
approved labels. At least 256 UTF-16 code units must remain for useful answer
text, or it hands off before calling the model. Effective
`AssistantAttemptBudgets.maxMessageCharacters` and `maxAnswerTextCharacters`
are passed in server context; the answer allowance is also appended to the
trusted model instructions. That complete prompt and the effective budgets
are fingerprinted before preparation. Oversized output is rejected with human
handoff; procedural answers are never silently truncated. The final rendered
body, including its actual citation footer, must fit the same application cap.

Every deployment supplies explicit `AssistantBudgets`. Hard ceilings are 100
visible messages, 256 KiB encoded input, 65,536 input tokens, 131,072 total
context tokens, 64 KiB output, 8,192 output tokens, ten attempts, and 100
assistant turns; deployments normally choose lower measured bounds. Local
counting includes the complete encoded prompt/conversation/source envelope,
the trusted adapter `framingTokens` allowance, and output token reserve against
the context ceiling. The host must verify its framing allowance, pricing,
provider request limits, and conservative ledger behavior. KB's independent
whole-source ceilings still apply (five sources, four collections, 64 KiB and
8,192 source tokens); exact applicability has no wildcard fallback.

Source preparation is not deployment evidence. Host ZDR verification,
disclosure, retention/export/deletion, production durable-store operation,
evaluations, complete-workflow acceptance, and supervised pilots remain their
separate activation gates. Provider SDKs, credentials, model selection, HTTP,
customer UI, schedulers, and operational content logging remain host work.
