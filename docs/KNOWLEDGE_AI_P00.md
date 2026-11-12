# P-00: baseline and implementation handoff

## Current publication status

All five synchronized Support Desk packages are published and strictly
verified at `0.2.6`. Optional AI pins Knowledge Base application and contracts
to exact `0.1.5`. This host composition selects all four verified Knowledge
Base `0.1.5` packages and Agent Access `0.1.1`. Version statements in the dated
sections below describe their recorded checkpoints. [Support Desk publication receipt](RELEASING.md#verified-026-publication-2026-11-11) · [Knowledge Base release](https://github.com/pegma-dev/knowledge-base/releases/tag/v0.1.5)

The engineering review guard correction shipped in `0.2.3`. Published `0.2.5`
adds attachments and opt-in staged human learning reviews. Host adoption,
actual login and
client flows, provider controls, operations and pilots have separate gates.
[Engineering review guide](ENGINEERING_EXPORT.md)

## Publication update: 2026-11-08

All five Support Desk packages are now published and strictly verified at
synchronized `0.2.0`; see the
[publication receipt](RELEASING.md#verified-sd-06-publication-2026-11-08).
The frozen 2026-11-06 baseline and dated 2026-11-07 inventory/checkpoints below
retain their original source, registry and readiness observations. Their
references to an unpublished candidate or future SD-06 release describe those
earlier checkpoints, not the current publication state. The baseline JSON,
dependency tuples, numeric oracles and capacity envelope are unchanged.
Actual two-host login/client, provider/ZDR, staging, operations and pilot
acceptance remain separate gates.

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

### Historical readiness as of 2026-11-06

| Next work                                  | Readiness after the P-00 checks pass                                                                    |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| KB-01 contracts/core                       | Ready to implement against released foundations; recheck names when creating the repository/manifests.  |
| SD-01 ticket handling                      | Ready to implement against current source, preserving legacy behavior and capacity reserves.            |
| KB-04 and private host authoring           | Credential and protected-resource proofs are required; public catalog connectivity is insufficient.     |
| Host adoption of new Support Desk behavior | Requires a new published package version and exact consumer pins.                                       |
| Real customer-content model calls          | Require verified provider/ZDR/intermediary configuration and host activation evidence.                  |
| Production pilots                          | Require the full dual-host acceptance and existing Task 12 evidence, with each host's rollout approval. |

This readiness table is historical. The current sequencing below separates
KB-04's source exit from retained real-host acceptance; missing host proof does
not block transport source validation or reviewed artifact publication.

## Frozen baseline and naming

The checked-in [baseline snapshot](../test/knowledge-ai/baseline.json) records
its observation time, source revision/manifests, registry versions and exact
dependency tuples, artifact integrity/shasum, tarball URLs, and proposed package
publication state. Refresh it deliberately with
[`scripts/knowledge-ai-baseline.mjs`](../scripts/knowledge-ai-baseline.mjs)
when a task changes its baseline. `pnpm run knowledge-ai:baseline origin/main`
selects a fetched source ref; omitting the ref selects `origin/main`. Fetch
`origin main` first. The selected commit must belong to fetched `origin/main`.
Manifests are
read from that immutable commit, including when the working tree is dirty.
The snapshot is reviewed handoff evidence, not a CI version selector. CI does
not run the refresh command or query npm/catalog metadata for these tests.
Snapshot accuracy is reviewed when refreshing it; the harness does not
authenticate historical registry metadata or detect later registry changes.
The refresh retries transient registry failures once, reports all failed names,
and leaves the prior snapshot unchanged if any lookup fails. The public npm
registry is intentional; private mirrors are not publication authority here.

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
Spine 0.1.1. At this snapshot, source was also labeled 0.1.1 but pinned
Authorization Core 0.4.0 and Spine 0.1.2 and contained later source work.
Published contracts 0.1.1 likewise pin Spine 0.1.1. At that checkpoint Support
Desk source was the unpublished synchronized `0.2.0` candidate, retaining
Authorization Core 0.4.0 and Spine 0.1.2. Installing published 0.1.1 did not
prove that source behavior. Verified new publication must precede adoption; never
overwrite 0.1.1 or conceal the difference with overrides or copied source.

Freeze the proposed repository name as `pegma-dev/knowledge-base` and package
names as `@pegma/knowledge-base-contracts`, `@pegma/knowledge-base-core`,
`@pegma/knowledge-base-application`, and `@pegma/knowledge-base-mcp`.
The [repository](https://github.com/pegma-dev/knowledge-base) was created for
KB-01 after the initial availability check. The proposed npm package names
remain unpublished at the refreshed snapshot. This is an availability
observation, not a reservation or proof of publishing rights.
Create each package only when its implementation starts. The optional
`@pegma/support-desk-ai` name is likewise unpublished; SD-02 owns its creation.

## Post-baseline dependency inventory (2026-11-07)

This inventory is historical; its source/publication labels are observations
from that checkpoint. The publication update above records the later release.

This dated inventory adds the approved producers after the 2026-11-06 snapshot.
It does not refresh or modify `test/knowledge-ai/baseline.json`, whose source,
registry observations, dependency tuples, and integrities remain historical.
This table incorporates the later verified KB `0.1.2` selection; the
dated `0.1.1` producer receipts below, source-preparation PRs, and registry
observations remain historical evidence.

| Producer                                                                                             | Source state at checkpoint                                                                                                                                                                                                                                            | Production dependency decision                                                                                  |
| ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `@pegma/agent-access`                                                                                | Verified trusted `0.1.1` registry release after [AUTH-01 source #1](https://github.com/pegma-dev/agent-access/pull/1), [release preparation #2](https://github.com/pegma-dev/agent-access/pull/2), and [release #4](https://github.com/pegma-dev/agent-access/pull/4) | Exact verified registry `0.1.1` is the public producer; actual two-host login/client acceptance remains open.   |
| `@pegma/knowledge-base-contracts`, `@pegma/knowledge-base-core`, `@pegma/knowledge-base-application` | Verified trusted `0.1.2` registry releases in the synchronized [KB v0.1.2 release](https://github.com/pegma-dev/knowledge-base/releases/tag/v0.1.2)                                                                                                                   | The optional Support Desk AI candidate consumes exact KB `0.1.2`; the base application has no KB dependency.    |
| `@pegma/knowledge-base-mcp`                                                                          | Verified trusted `0.1.2` registry release in the same synchronized four-package set                                                                                                                                                                                   | Exact verified registry `0.1.2` is available for host assembly; retained actual-client acceptance remains open. |
| Support Desk package set                                                                             | Unpublished synchronized `0.2.0` source candidate, distinct from the four base registry `0.1.1` packages                                                                                                                                                              | Verified SD-06 publication precedes adoption; existing registry versions remain immutable.                      |

The recorded PG-01/RG-01 assembly selected **both Agent Access and KB published
artifacts** at exact verified Agent Access `0.1.1` and KB `0.1.2`. All five names had returned HTTP 404 at
the earlier 2026-11-07 preparation checkpoint; that observation is historical
and was superseded by manual bootstrap and the strictly verified trusted
releases below. AUTH-01 source/SDK proof, KB-04 source exit, and both producers'
release preparation remain separate historical source evidence. The completed
manual maintainer-2FA `0.1.0` bootstrap supplied no OIDC provenance; the later
reviewed trusted releases provide it. Keep subsequent registry checks
and source/release verification in the owning producer's release workflow.
Actual two-host existing-login/current-Admin consent and client/mode proof
stays with PG-01/RG-01 before activation or pilots. Publication closes only the
producer release gates, not any host gate. The current producer roles are also in
the [buildout dependency map](BUILDOUT.md#pegma-dependency-map) and
[host composition guide](HOST_COMPOSITION.md#kb-authoring-producers).

### Verified producer update (2026-11-07T23:35:31Z)

At this dated checkpoint, the inventory selected verified trusted `0.1.1`
releases for all four KB packages and Agent Access. Agent Access
[release PR #4](https://github.com/pegma-dev/agent-access/pull/4), signed
`v0.1.1` at `ffe4d8616632ce9d057caaf65124746f03d4d349`, passed its
[strict verify job](https://github.com/pegma-dev/agent-access/actions/runs/42420302775/job/128549453970)
on attempt 2 at 22:32:42Z. KB
[release PR #8](https://github.com/pegma-dev/knowledge-base/pull/8), signed
`v0.1.1` at `32086e4374f2ef45044cd09c371e506d10b88d64`, passed its
[strict verify job](https://github.com/pegma-dev/knowledge-base/actions/runs/42424148244/job/128564059833)
on attempt 5 at 23:35:31Z. The jobs verified exact registry bytes/dependencies,
signatures, repository/workflow/tag/commit provenance, and clean consumers for
one and four packages respectively. Canonical artifact identities and manual
`0.1.0` bootstrap receipts remain in the
[KB release handoff](https://github.com/pegma-dev/knowledge-base/blob/main/docs/BOOTSTRAP.md)
and [Agent Access handoff](https://github.com/pegma-dev/agent-access/blob/main/docs/BOOTSTRAP.md).
Manual bootstrap had no OIDC provenance; the later trusted releases supply it.

These releases closed the producer publication prerequisite for SD-02 at that
checkpoint. Its optional AI package then used exact KB `0.1.1`; the base
application remained KB/provider-independent. The checkpoint's KB protocol
proof used four packed KB packages and registry Agent Access `0.1.1`;
the earlier source fixture remains historical. This update changes neither the
frozen baseline nor any synthetic case or its expected result. It does not
close existing-login/current-Admin consent, any actual requested client/mode
on either host, real provider/ZDR/intermediary settings, Task 12, operations,
full-workflow acceptance, or pilots. New Support Desk behavior still needs a
future synchronized verified SD-06 release. Follow the
[current ledger](KNOWLEDGE_AI_PLAN.md#status-and-reading-order) and
[assistant coordination candidate](ASSISTANT_COORDINATION.md).

The subsequent KB `0.1.2` producer checkpoint was the verified trusted four-package release
at source `004044bfa836b74a61fb5defa49d5ebab1fe37dd`, confirmed by strict
[registry/consumer verification](https://github.com/pegma-dev/knowledge-base/actions/runs/42436081951/job/128617897564).
The released `@pegma/support-desk-ai@0.2.0` retains exact KB `0.1.2` runtime
dependencies. A later standalone authoring recipe selected all four KB `0.1.4`
packages with Agent Access `0.1.1`. [Producer receipts](HOST_COMPOSITION.md#kb-authoring-producers)
These publication updates do not refresh the frozen P-00 snapshot or close
any host activation gate.

## Open prerequisites and activation gates

An open operational prerequisite does not block unrelated pure source work.
It blocks the specific consumer or activation named below. Record private
configuration and evidence in each host's own handoff, using the checklist at
the end of this document.

| ID / current status                                        | Owner                                                                                         | Gate                                                                                        | Evidence needed to close                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P00-CREDENTIAL / AUTH-01 source merged; host proof missing | Agent Access owner for lifecycle source; each host identity/integration owner for composition | PG-01/RG-01 private authoring activation; retained KB-04 host acceptance before A-01/pilots | Existing-login/current-Admin consent, audience/client-bound draft/evidence scopes, expiry, revocation, and current-authority checks through every actual requested client/mode on both hosts. Explicitly prove initial agent credentials cannot publish, submit/read reviews, act as staff/Admin, manage collections/validation policy, read collections/evidence/private provenance, or link/manage grants. Agent Access/KB publication and exact verified registry dependencies precede host assembly. |
| P00-MCP / host protected-boundary proof missing            | Each host API/MCP owner                                                                       | PG-01/RG-01 private API/MCP activation; A-01/pilots                                         | Every actual requested client/mode proves protected discovery and supported authentication, or a supported bridge using an actual host credential, against published dependencies; wrong-audience, expired, revoked, and excessive-scope cases fail.                                                                                                                                                                                                                                                     |
| P00-POLICY / host permission mapping unproven              | KB contract owner and host authorization owner                                                | Any protected KB operation                                                                  | New permission names map into existing Authorization Core policy; collection inheritance, author/reviewer/publisher separation, and customer/bot audiences pass.                                                                                                                                                                                                                                                                                                                                         |
| P00-PUBLISH / source differs from registry                 | Support Desk release owner                                                                    | Hosts consume new Support Desk behavior                                                     | Reviewed version change, exact packed artifact, normal signed-tag/trusted-publisher release, and exact public consumer pins. Existing 0.1.1 remains immutable.                                                                                                                                                                                                                                                                                                                                           |
| P00-DEPLOYMENT / missing applicability mapping             | Each host release owner, consumed by SD-05                                                    | Fix-related follow-up preparation/activation                                                | Authenticated issue-to-fix-to-release-to-deployed-build mapping with affected product/version applicability and rollback handling. Issue closure or a release announcement alone is insufficient.                                                                                                                                                                                                                                                                                                        |
| P00-ZDR / unverified                                       | Each host AI/provider owner                                                                   | Every real customer-content processing path                                                 | Recorded actual provider account/project, endpoint/model/features, documented exceptions, intermediary handling, and configuration-change checks. Incompatible/unverified settings disable model calls while human support remains available.                                                                                                                                                                                                                                                            |
| P00-OPERATIONS / enhancement proof pending                 | Each host support/operations owner                                                            | Task 12 closure and supervised pilot                                                        | Current durable-store lifecycle, retention/export/deletion, access review, recovery, handoff, maintenance/backlog, and rollback evidence for this workload. Source inspection and historic general launch records do not establish it.                                                                                                                                                                                                                                                                   |
| P00-LIMITS / proposed fixture bounds                       | KB and Support Desk owners; host operations owner approves deployment settings                | Admission/worker design, then live activation                                               | Bounded physical rows/pages/actions, retained revisions/evidence, messages, tokens/time/cost, retries, and reserved completion/handoff capacity; actual host measurements support chosen production values.                                                                                                                                                                                                                                                                                              |

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
token, refresh flow, or local-agent login. The approved AUTH-01 sibling below
owns that credential lifecycle; KB remains a resource server.

### Resolved credential decision; merged source and open host proof

On 2026-11-07 the credential owner was selected as the separate MIT
[Agent Access component](https://github.com/pegma-dev/agent-access), inserted as
AUTH-01 before KB-04. AUTH-01 lifecycle source and synthetic protocol proof are
merged, followed by KB-04's transport source exit and both producers' release
preparation. Their historical verified trusted `0.1.1` releases are recorded in the
[dated producer update](#verified-producer-update-2026-11-07t233531z).
Publication does not refresh the frozen package snapshot above or close
P00-CREDENTIAL/P00-MCP's actual host acceptance.

Use existing host logins; only current Admins approve and manage their grants.
Support the RFC 8628 device grant with a human user code, explicit polling
interval, and `slow_down` handling. The authorization-code grant requires
S256 PKCE. Agent access intersects current principal/approval authority with
explicit selected scopes, carries no Admin role or session cookie, and fails
closed when current authority is missing or unavailable. Initial scopes cover
instance-wide draft read/write and test-evidence submission. Initial tools are
`getDraft`, `createDraft`, `updateDraft`, `getValidationRequirements`, and
`submitEvidence`; collection/evidence reads, review submission, publishing,
admin actions, and private provenance are excluded. New capabilities and
collection-specific grants require explicit policy and fresh consent.

Hosts own browser consent protection, durable limiters, and evidence attesters.
An authenticated agent's claim is not proof of a working test: the attester
must verify actor, runner, exact revision/hash, target build, and execution
receipt, failing closed on missing/unverifiable proof. Source units and a
synthetic actual-SDK flow may use reviewed test tarballs before publication.
AUTH-01's source/SDK fixture and KB-04's transport source exit have passed:
actual-SDK draft/evidence parity and rejected credential/attestation cases in
a test-only synthetic composition, plus their source/review gates. Their
release-preparation follow-ups also passed; exact evidence is in the
[current status ledger](KNOWLEDGE_AI_PLAN.md#status-and-reading-order).
Full KB-05 still owns actual reviewed artifact publication and hard-blocks
SD-02; Agent Access has a separate publication handoff. Actual host proof is
not a prerequisite for those source releases. PG-01/RG-01 assemble exact
published Agent Access/KB dependencies and prove existing-login/current-Admin
consent and actual-client flows. Retained KB-04 host acceptance and P00-CREDENTIAL/P00-MCP remain open
until both hosts pass every original authoring/evidence and failure scenario;
those results are required before activation, A-01, and pilots. Source exit or
SDK success cannot close them. Publication and retained host acceptance remain
open even though the source slices are merged.

The initial compatibility targets are Codex, Claude Code, Grok Bot, and
T3 Code. Grok Bot means the desktop application with its hosted agent, not
Grok Build CLI. T3 Code targets Codex-provider mode first; other providers are
unproven. Actual per-client runs remain required and unproven; the official
SDK synthetic protocol proof cannot stand in for compatibility with any target.

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
2. Existing-login/current-Admin consent, credential issuer/client/resource
   boundary, selected-scope intersection, expiry/refresh/revocation proof,
   current principal/approval checks, and actual protected MCP or bridge client
   proof. Include exact released Agent Access/KB pins and trusted evidence
   attestation results. Store only secret references in the record.
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

## Progress after the frozen baseline

The snapshot, package versions, readiness table, and capacity envelope above
remain historical P-00 handoff evidence from 2026-11-06. This reconciliation
does not refresh or rewrite the baseline. The ten merged-source entries,
including P-00, KB-01/02/03, SD-01, partial KB-05, AUTH-01, KB-04, and both
producers' release preparation, with verified gate results and remaining
dependencies, are recorded in the plan's
[current status ledger](KNOWLEDGE_AI_PLAN.md#status-and-reading-order).
AUTH-01 lifecycle source, synthetic SDK proof, KB-04 transport source exit,
and both producers' release preparation are merged. The earlier Support Desk
AI `0.2.1` package retains its exact KB `0.1.2` runtime dependencies and dated
verification record. The publication status above identifies the selected
`0.2.6` graph.
[Historical `0.2.1` receipt](RELEASING.md#verified-021-publication-2026-11-10) · [Current publication status](#current-publication-status)
PG-01/RG-01 consume their reviewed exact verified registry sets. Retained KB-04 real two-host
acceptance under P00-CREDENTIAL/P00-MCP and
PG-01/RG-01, and the named host/ZDR, production-operation, deployment-mapping,
and pilot gates remain open. Source/SDK evidence does not close host activation.
