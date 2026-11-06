# Knowledge and AI acceptance fixtures (P-00)

This is unpublished test infrastructure, not a KB, AI coordinator, model
adapter, authentication service, or production acceptance result. P-00 verifies
the corpus and evaluator. Later KB/Support Desk/host tasks must run these cases
through their actual public services and connectors to establish acceptance.
No live provider, GitHub connection, customer data, or host secrets are used.

`workshop` and `observatory` are wholly fictional isolated instances. They are
not aliases for the launch hosts or a proposed tenant model. Both intentionally
use the same article IDs/titles while their instance references, principals,
private details, and canaries differ. A real host runs both fixture profiles
independently against its own integration to expose accidental shared-state or
cache collisions. Never populate these profiles with commercial host data.

## Files and observations

- `types.ts` defines harness-only input/observation vocabulary and proposed
  model-port requirements. These are not exported package interfaces.
- `corpus.ts` contains 40 authored case templates expanded to 80 cases,
  covering all 18 acceptance scenarios from the approved plan. Each case has
  stable IDs, owner tasks, setup data, steps, and explicit expected outcomes.
- `evaluate.ts` compares captured logical artifacts to those authored oracles.
- `fake-model.ts` records request snapshots and returns an independent script.
- `../../tests/knowledge-ai-fixtures.test.ts` exercises corpus integrity and
  proves the evaluator detects deliberately incorrect observations.

Adapters interpret case inputs and steps using their real APIs. For example,
`portal`, `bot_only`, and `staff_only` denote collections to create through the
KB services with the stated audience/use policy. An adapter must not implement
a second permission engine or return canned expected observations. It records
actual model calls, committed logical messages, and external connector sends.
Observe message commits and jobs once per logical ID, not each storage retry.
For `new-message-race`, capture assistant commits only, as its steps specify.
Record each message's `committedTurn` from its actual committed job/receipt:
operation ID, ticket ID, triggering revision, and generation. Trusted
instrumentation may map generated IDs to the case's logical IDs using the
jobs captured when each turn starts; it must not assign the expected newer
cause to whichever message happened to commit. The evaluator requires the
exact authored committed-turn set and matches it to the actual request trace.

Artifact labels are assigned by trusted test instrumentation at the actual
boundary. A model output may not label a public send as `private`. Private
staff evidence can contain its own private canaries; model requests, customer
artifacts, drafts, publications, issues, and notifications have the explicit
forbidden-value checks in each case. The model-call trace includes full
request text and source metadata so a hidden canary in either is detected.

Reference comparison uses instance/article/revision tuples; object property
order is irrelevant. Model requests, portal artifacts, and message artifacts
have separate source expectations. A bot-only source cannot move into portal
results while the message drops that citation to preserve an aggregate union.
Repeated citations to one revision are permitted. Counts
are exact only where the oracle specifies them. Unspecified incidental counts
are not constrained. Every initial case prohibits publication, issue export,
and notifications unless its explicit oracle permits that output.

Each instance supplies distinct immutable repository IDs and allowlist
descriptions. Routing proposals and issue sends record `repositoryId` from
the selected proposal or actual connector call, not model-provided artifact
labels. Target-aware cases compare the exact artifact-kind/repository-ID
set, including a high-confidence guide-repository proposal that must fail if
another allowed repository is selected.

The evaluator checks outcomes, selected counts, duplicate artifact IDs,
instance IDs, per-sink source sets, committed-turn identities, exact repository
targets, and known leak canaries. Other-instance customer details are forbidden
at model and customer boundaries even when local instance labels are retained.
The current customer's submitted context remains permitted in the verified-ZDR
case. The evaluator does not
establish factual correctness, comprehensive anonymization, real token issuer
validation, provider ZDR status, timing guarantees, or complete workflow
acceptance. Those require the owning implementation, connector instrumentation,
versioned semantic rubrics, and host evidence described by the plan. In
particular, synthetic canary detection is not a general PII detector.

## Case IDs and ownership

Every suffix below appears as both `workshop/<suffix>` and
`observatory/<suffix>`; `ownerTasks` in the corpus gives the responsible task.
Steps that list independent mutations or evidence kinds are repeated by the
later real adapter for each listed variant.

| Plan scenario                    | Case suffixes                                                                                                 |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Agent-authored explanation       | `author-explanation`                                                                                          |
| Agent-tested walkthrough         | `tested-walkthrough`, `wrong-evidence`                                                                        |
| Collection audiences             | `collection-audiences`, `credential-scope`, `credential-audience`, `credential-expired`, `credential-revoked` |
| Exact publication                | `draft-revision`, `edited-approval`, `retired-source`                                                         |
| Ticket-backed answer             | `ticket-first-message`, `new-message-race`                                                                    |
| Human request and takeover       | `human-request`, `takeover-race`                                                                              |
| Unsupported/conflicting guidance | `unsupported-guidance`, `conflicting-guidance`                                                                |
| Learning                         | `resolution-learning`, `unverified-resolution`                                                                |
| Reopen/deletion                  | `reopened-source`, `deleted-source`                                                                           |
| Bug validity                     | `unverified-bug`, `verified-bug`                                                                              |
| AI routing                       | `confident-repository`, `ambiguous-repository`, `out-of-scope-repository`                                     |
| Private/public export            | `public-export`, `private-export`, `visibility-change`                                                        |
| Security uncertainty             | `security-review`                                                                                             |
| External-call failures           | `ambiguous-export-acceptance`, `provider-failure`                                                             |
| Released fix                     | `released-fix`, `issue-closed-only`                                                                           |
| Out-of-order/rollback            | `release-rollback`, `duplicate-release`                                                                       |
| Capacity/isolation               | `physical-row-budget`, `foreign-instance`                                                                     |
| ZDR/disclosure                   | `zdr-unverified`, `sensitive-submitted-context`                                                               |

`sensitive-submitted-context` deliberately allows ordinary customer-entered
financial context to reach the verified provider after disclosure, without
routine human privacy screening. Derived drafts and exports still have their
own private-detail checks. `zdr-unverified` expects no model call. A symbolic
`verified_zdr` input is fixture setup, not operational proof of a provider's
settings; the real host supplies that proof before activation.

`unverified-resolution` supplies a resolved status without customer
confirmation, staff verification, or a successful test. It requires human
review and zero learning model calls/drafts; status alone is not eligibility.

## Model double and budgets

The proposed request metadata includes operation ID, purpose, instance,
ticket revision/generation, prompt/configuration versions, provider-verification
reference, conversation, supplied source revisions, token limits, and deadline.
Response metadata includes structured outcome, text, citations, model/request
IDs, usage, and optional routing suggestions. Confidence is a hint, never
permission to route, publish, or act. Approval-binding field names are recorded
in `approvalBindingFields`; later domain tasks must define the actual codecs.

The fake model supports immediate reply, rejection, and explicitly deferred
completion. Supply a script independently of the corpus oracle. Complete
deferred calls in any order to test takeover/new-message races in a real
coordinator later. Request snapshots and replies are cloned; the test double
does not redact, authorize, validate citations, retry, commit messages, or
enforce provider retention. A missing step fails loudly instead of inventing
a response. Tests must settle/reject every deferred call they start.

`fixtureBudgets` contains tiny values for boundary tests, not production
defaults or performance targets. The physical-row case counts adapter-returned
rows, including nonmatches. Later adapters must instrument actual rows/pages,
token usage, retries, and deadlines alongside the outcome assertion. Deployment
limits and quality/cost targets require measured host-owner acceptance.

Run the local checks from the repository root:

```sh
pnpm exec vitest run tests/knowledge-ai-fixtures.test.ts
pnpm run check
```

The normal repository test command also includes this suite and the existing
real-Azurite setup. Running this P-00 suite alone does not satisfy either host's
later D1/Azure acceptance or production-evidence gates.
