# P-00: baseline and implementation handoff

## What this task establishes

Snapshot date: 2026-11-06. The [approved plan](KNOWLEDGE_AI_PLAN.md) owns
product scope and implementation order. P-00 establishes the starting package
identity, synthetic acceptance inputs/oracles, capacity assumptions, and named
prerequisites for its next tasks.

This is test infrastructure and an implementation handoff. Passing its corpus
integrity/evaluator tests does not demonstrate a working KB, authenticated
authoring endpoint, model integration, host deployment, or production pilot.
Those tasks must run their actual adapters against the corpus and gather the
additional evidence in the plan.

| Next work                                  | Readiness after the P-00 checks pass                                                                    |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| KB-01 contracts/core                       | Ready to implement against released foundations; recheck names when creating the repository/manifests.  |
| SD-01 ticket handling                      | Ready to implement against current source, preserving legacy behavior and capacity reserves.            |
| KB-04 and private host authoring           | Credential and protected-resource proofs are required; public catalog connectivity is insufficient.     |
| Host adoption of new Support Desk behavior | Requires a new published package version and exact consumer pins.                                       |
| Real customer-content model calls          | Require verified provider/ZDR/intermediary configuration and host activation evidence.                  |
| Production pilots                          | Require the full dual-host acceptance and existing Task 12 evidence, with each host's rollout approval. |

## Frozen baseline and naming

The checked-in [baseline snapshot](../test/knowledge-ai/baseline.json) records
its observation time, source revision/manifests, registry versions and exact
dependency tuples, artifact integrity/shasum, tarball URLs, and proposed package
publication state. Refresh it deliberately with
[`scripts/knowledge-ai-baseline.mjs`](../scripts/knowledge-ai-baseline.mjs)
when a task changes its baseline. `pnpm run knowledge-ai:baseline origin/main`
selects a fetched source ref; omitting the ref selects `HEAD`. Manifests are
read from that immutable commit, including when the working tree is dirty.
The snapshot is reviewed handoff evidence, not a CI version selector. CI does
not run the refresh command or query npm/catalog metadata for these tests.
Snapshot accuracy is reviewed when refreshing it; the harness does not
authenticate historical registry metadata or detect later registry changes.

The source snapshot is
[`5278440`](https://github.com/pegma-dev/support-desk/tree/527844007c6dd8083a6747879414d5b9159d46c2),
which includes the planning merge and the subsequently merged verified-sender
inbound-mail fix. The capacity tests exercise this source's web/staff commands;
the formula below does not describe inbound-mail receipts or host projections.
A registry artifact and a source checkout are separate baselines, even when
their version fields match.

| Verified released foundation                                      | Version at snapshot |
| ----------------------------------------------------------------- | ------------------- |
| Spine                                                             | 0.1.2               |
| Storage Core / Azure Tables adapter                               | 0.4.0 / 0.4.0       |
| D1 adapter                                                        | 0.4.1               |
| Audit                                                             | 0.2.0               |
| Authorization contracts/core/policy/storage/tokens/admin/identity | 0.4.0               |
| Identity                                                          | 0.1.2               |
| Sessions / Rate Limit                                             | 0.2.0 / 0.2.0       |
| Mail / Webhooks                                                   | 0.1.1 / 0.1.1       |
| Scheduler / Cloudflare scheduler adapter                          | 0.1.0 / 0.1.0       |
| Storage Blobs                                                     | 0.2.0               |
| Existing four Support Desk packages                               | 0.1.1               |

Published `support-desk-application@0.1.1` pins Authorization Core 0.2.0 and
Spine 0.1.1. Current source is also labeled 0.1.1 but pins Authorization Core
0.4.0 and Spine 0.1.2 and contains later source work. Published contracts 0.1.1
likewise pin Spine 0.1.1 while source contracts pin 0.1.2. Installing published
0.1.1 does not prove the current source behavior. The release owner must publish
a new version before hosts adopt these additions; never overwrite 0.1.1 or
conceal the difference with overrides or copied source.

Freeze the proposed repository name as `pegma-dev/knowledge-base` and package
names as `@pegma/knowledge-base-contracts`, `@pegma/knowledge-base-core`,
`@pegma/knowledge-base-application`, and `@pegma/knowledge-base-mcp`.
The repository was not found through the authenticated GitHub connection and
the proposed package names were unpublished at the snapshot. This is an
availability observation, not a reservation or proof of publishing rights.
KB-01 rechecks availability and organization conventions before creation.
Create each package only when its implementation starts. The optional
`@pegma/support-desk-ai` name is likewise unpublished; SD-02 owns its creation.

## Open prerequisites and activation gates

An open operational prerequisite does not block unrelated pure source work.
It blocks the specific consumer or activation named below. Record private
configuration and evidence in each host's own handoff, using the checklist at
the end of this document.

| ID / current status                            | Owner                                                                                     | Gate                                                                 | Evidence needed to close                                                                                                                                                                                                                      |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P00-CREDENTIAL / missing proof                 | Each host identity/integration owner, or its selected external authorization server owner | KB-04 real-client proof and PG-01/RG-01 private authoring activation | A supported local-agent flow with target audience/client binding, scoped permissions, expiry, revocation, and current permission checks. An author can submit drafts/evidence but cannot publish.                                             |
| P00-MCP / missing protected boundary           | Each host API/MCP owner                                                                   | Private API/MCP authoring                                            | Protected-resource discovery and supported client authentication, or a supported local bridge using an actual host credential; wrong-audience, expired, revoked, and excessive-scope cases fail.                                              |
| P00-POLICY / future permission mapping         | KB contract owner and host authorization owner                                            | Any protected KB operation                                           | New permission names map into existing Authorization Core policy; collection inheritance, author/reviewer/publisher separation, and customer/bot audiences pass.                                                                              |
| P00-PUBLISH / source differs from registry     | Support Desk release owner                                                                | Hosts consume new Support Desk behavior                              | Reviewed version change, exact packed artifact, normal signed-tag/trusted-publisher release, and exact public consumer pins. Existing 0.1.1 remains immutable.                                                                                |
| P00-DEPLOYMENT / missing applicability mapping | Each host release owner, consumed by SD-05                                                | Fix-related follow-up preparation/activation                         | Authenticated issue-to-fix-to-release-to-deployed-build mapping with affected product/version applicability and rollback handling. Issue closure or a release announcement alone is insufficient.                                             |
| P00-ZDR / unverified                           | Each host AI/provider owner                                                               | Every real customer-content processing path                          | Recorded actual provider account/project, endpoint/model/features, documented exceptions, intermediary handling, and configuration-change checks. Incompatible/unverified settings disable model calls while human support remains available. |
| P00-OPERATIONS / enhancement proof pending     | Each host support/operations owner                                                        | Task 12 closure and supervised pilot                                 | Current durable-store lifecycle, retention/export/deletion, access review, recovery, handoff, maintenance/backlog, and rollback evidence for this workload. Source inspection and historic general launch records do not establish it.        |
| P00-LIMITS / proposed fixture bounds           | KB and Support Desk owners; host operations owner approves deployment settings            | Admission/worker design, then live activation                        | Bounded physical rows/pages/actions, retained revisions/evidence, messages, tokens/time/cost, retries, and reserved completion/handoff capacity; actual host measurements support chosen production values.                                   |

The public pegma.dev MCP endpoint serves unauthenticated catalog facts. It
cannot prove private authoring authentication and must remain separate from
the protected KB boundary. Existing browser sessions also do not establish a
local-agent credential flow. Both hosts can resolve authorization after the
caller has been authenticated; that does not supply the missing credential.

Preserve component refusals: [Identity](https://github.com/pegma-dev/identity/blob/392c9a357f071a01d4d7c37657b6b94b78747f39/AGENTS.md)
does not serve OAuth/OIDC, and [Sessions](https://github.com/pegma-dev/sessions/blob/62f8c2f49f316d96024ab13037392e3bafbdca7a/AGENTS.md)
does not own authentication/token logic. Authorization's
[access-grant profile](https://github.com/pegma-dev/authorization-core/blob/ac514f3553b657ea12b1f9888c97d72a48cdc971/docs/ACCESS_GRANTS.md)
is a short-lived, single-use profile with a maximum nominal lifetime of 30
seconds and consume-on-verify semantics. It is not a reusable OAuth access
token, refresh flow, or local-agent login. The host/external authorization
server owns that boundary; KB remains a resource server.

## Synthetic corpus and evaluation contract

Use the [fixture README](../test/knowledge-ai/README.md),
[types](../test/knowledge-ai/types.ts), [corpus](../test/knowledge-ai/corpus.ts),
[observation evaluator](../test/knowledge-ai/evaluate.ts), and
[scripted model](../test/knowledge-ai/fake-model.ts). These are harness-only
types and oracles, not exported production APIs. They describe observations
that later real adapters must produce.

Every suffix below expands to both `workshop/<suffix>` and
`observatory/<suffix>`: 40 templates produce 80 concrete cases covering the
plan's 18 acceptance scenarios. These wholly fictional instances have distinct
principals, collections, source revisions, tickets, repository allowlists,
and private sentinels. Similar display names make accidental cross-instance
mixing detectable. Expected outcomes are authored independently of application
policy code; the fake provider must not return an oracle as its answer.

| Decisions / acceptance obligation                                | Case suffixes                                                                                                                     | Real implementation owner                          |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| API/MCP authoring and article-appropriate evidence               | `author-explanation`, `tested-walkthrough`, `wrong-evidence`                                                                      | KB-02/KB-04, then PG-01/RG-01                      |
| Collection audiences, bot-only knowledge, isolation              | `collection-audiences`, `foreign-instance`, `credential-scope`, `credential-audience`, `credential-expired`, `credential-revoked` | KB-02/KB-03/KB-04 and host auth owners             |
| Exact revision approval, draft/retired exclusion                 | `draft-revision`, `edited-approval`, `retired-source`                                                                             | KB-02/KB-03                                        |
| Ticket from first message; durable human handoff                 | `ticket-first-message`, `human-request`, `takeover-race`, `new-message-race`                                                      | SD-01/SD-02, then PG-02/RG-02                      |
| Supported answers and configured escalation                      | `unsupported-guidance`, `conflicting-guidance`, `provider-failure`                                                                | SD-02 and each host                                |
| Verified learning, private provenance, reassessment              | `resolution-learning`, `unverified-resolution`, `reopened-source`, `deleted-source`                                               | SD-03 and KB review adapters                       |
| Reproduction evidence and AI confidence-gated routing            | `unverified-bug`, `verified-bug`, `confident-repository`, `ambiguous-repository`, `out-of-scope-repository`                       | SD-04 and repository configuration owner           |
| Reviewed sanitized export and stricter public destination checks | `public-export`, `private-export`, `visibility-change`, `security-review`, `ambiguous-export-acceptance`                          | SD-04 and host GitHub adapter                      |
| Confirmed deployment, approved follow-up, replay/rollback        | `released-fix`, `issue-closed-only`, `release-rollback`, `duplicate-release`                                                      | SD-05 and host release adapters                    |
| Physical bounds and disclosed verified ZDR processing            | `physical-row-budget`, `zdr-unverified`, `sensitive-submitted-context`                                                            | KB/Support Desk admission and host provider owners |

The [fixture tests](../tests/knowledge-ai-fixtures.test.ts) must prove that
the evaluator rejects seeded staff/provenance leaks, foreign or wrong revision
sources, duplicate committed messages, unapproved exports/notifications, and
invalid observations. Deferred fake completions must support takeover and
out-of-order tests without copying expected outcomes into the fake.

Passing these tests establishes corpus integrity and evaluator discrimination.
Later task adapters must supply actual observations for the same cases.
Semantic answer correctness, citation support, privacy of generalized prose,
and routing calibration require a reviewed rubric and actual model outputs;
canary or substring checks cannot establish those qualities alone.

Before model or routing-gate tuning, the owning task records versioned cases
and rubrics for answer/citation support, unsupported-answer escalation,
retrieval coverage, derived-draft privacy, routing accuracy/ambiguity, human
handoff success, latency, and cost. Permission leaks, private-note disclosure,
unapproved publication, and unauthorized actions are blocking activation
failures. Numeric quality, latency, and budget thresholds require measured
host-owner sign-off; P-00 does not invent percentage targets.

## Model-port and approval requirements

The production port is implemented in SD-02, not P-00. Preserve these
requirements through that design:

- Requests identify purpose, stable operation/attempt, causal revision and
  handling/source generation, prompt/model/configuration version, effective
  audience/policy version, bounded customer-visible context and approved
  article revision references, deadline/cancellation, and usage budgets.
- Provider/ZDR configuration references come from the trusted host. Customer
  text, retrieved articles, and model output cannot select a retention mode,
  expand an audience, or grant tool/publication authority.
- Responses use bounded structured answer/escalation outcomes, supplied
  revision references, provider/model request identity, usage, and coarse
  failure categories. Citation and authority checks remain in code.
- Claims, retry counters, leases/fences, expiry, input fingerprint, and terminal
  result references are durable bounded operation state. A scheduler lease
  does not replace ticket/turn fencing. The scheduler's default 30-second lease
  needs an explicit compatible deadline/job design before long model calls.
- Fakes cover supported answers, unsupported/conflicting guidance, malformed
  citations, provider failure, deferred/duplicate/stale completions, and
  unavailable data-control configuration. They do not perform network calls.

Approval must bind exact content hash/revision, collection and audience-policy
revision, product/staging build applicability, validation-policy revision,
evidence IDs/hashes, reviewer principal/time, and relevant source ticket
revision/resolution generation. Export approval additionally binds immutable
repository ID, current visibility, destination-policy revision, and exact
outbound content. Follow-up work additionally binds confirmed deployment/build
mapping and current source generations. Changes invalidate pending approval;
reopen, revocation, rollback, or stale completion cannot reuse old authority.

## Capacity envelope and reserve

The current source defaults to 100 messages and 512 physical rows per ticket.
All auxiliary rows count toward the same physical cap. For successful
web/staff history before deletion, the reviewed row accounting is:

```text
R = 3 + 3M + D + 2N + E

3 = fixed ticket, quota, reservation
M = all customer/staff/internal/system messages
D = retained delivery rows (at most one per message in these commands)
N = successful metadata/lifecycle commands without a message
E = assistant, learning, export, follow-up, and other auxiliary rows
```

Fresh create inserts six rows, plus one optional delivery. Replies and notes
append three rows, plus an optional delivery for replies; ticket/quota writes
are updates. A lifecycle command without a message appends two rows. Identical
receipt replay adds no authoritative ticket rows, though it may repair hints
elsewhere. This is source accounting, not a claim that every store write is
free or that a queue projection is authoritative.

At `M=100`, `D=100`, and no auxiliary or metadata commands, `R=403`.
The conservative synthetic design allowance adds 20 metadata-only commands
and 20 assistant turns with at most two retained auxiliary rows each:
`403 + 40 + 40 = 483`, leaving 29 of the default 512 physical rows.
The [capacity tests](../tests/knowledge-ai-capacity.test.ts) preserve this
envelope and discriminate additions that exceed it.

The remaining capacity is a reserve, not permission to append arbitrary work.
Admission must account for every other auxiliary row and reserve both rows and
message slots for the pending completion and human handoff. Escalate before
exhaustion; an escalation must not require capacity that the bot consumed.
Claims/retries update bounded existing records instead of appending unlimited
attempt history. KB-02 likewise needs explicit retained-revision/evidence and
article-partition limits before using whole-partition history reads.

The corpus uses deliberately tiny page/row/candidate/retry budgets to expose
boundary bugs. These values and the capacity design allowance are synthetic
test inputs, not production defaults or measured host capacity. P00-LIMITS
requires an explicit deployment setting and measurement record before live
activation. Existing host create/reply throttles do not bound model token,
cost, evidence-upload, or worker usage.

## Private host handoff template

Keep one independent record per host in its own private destination. This
public template contains no commercial routes, source paths, customer data,
credentials, or operational configuration values. Record:

1. Observed source revision and deployed build, distinguishing stale local
   checkout, current main, staging, and production evidence.
2. Credential issuer/client/resource boundary, credential scope intersection,
   expiry/revocation proof, current permission mapping, and protected MCP or
   bridge client proof. Store only secret references in the record.
3. Collection audience assignments and draft/evidence/reviewer/publisher
   permissions, with wrong-audience and revocation scenario results.
4. Actual provider/ZDR/intermediary capabilities, documented exceptions,
   configuration owner, last verification, and disable/fallback behavior.
5. Repository allowlist/visibility/publication modes, routing evaluation data,
   security-review destination, and approved synthetic reproduction handling.
6. Issue/fix/release/deployment applicability evidence and rollback/reopen
   behavior for follow-up drafts.
7. Retention/export/deletion, durable-store lifecycle/recovery, evidence
   artifacts, bounded worker/checkpoint/backlog observations, budgets, and
   reserved handoff capacity.
8. Each prerequisite ID's owner, evidence reference, verification date, state,
   affected activation gate, and reviewer/approver.

An unverified item stays open. Existing account features, general launch
acceptances, public discovery documents, or successful package tests do not
silently close enhancement-specific gates. A-01 requires real workflow evidence
from both hosts; the pilots additionally require the existing production and
host release/business gates.
