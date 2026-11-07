# Knowledge base and AI support implementation plan

## Status and reading order

Approved product decisions: 2026-11-06. The source work below is merged;
package publication, authenticated author transport, model integration, and
host activation remain separately gated.
Use the [P-00 handoff](KNOWLEDGE_AI_P00.md) for the frozen package baseline,
acceptance corpus, capacity assumptions, and owned activation prerequisites.
This plan covers a standalone Pegma knowledge base, an optional Support Desk
AI agent and engineering workflow, and working integrations on both launch
hosts. RetireGolden is the primary use case; pegma.dev is the simpler early
integration. Completing one host does not complete this enhancement.

**Merged-source status: 2026-11-07.**

| Source work                      | Merged evidence                                                                                                                                                           | Delivered source                                                                                            |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| P-00                             | [Support #33](https://github.com/pegma-dev/support-desk/pull/33) · [`fcf5a68`](https://github.com/pegma-dev/support-desk/commit/fcf5a68f83d335b9867a6975443c03d3a86e3c4f) | Frozen baseline, synthetic acceptance oracles, and capacity checks                                          |
| KB-01                            | [KB #1](https://github.com/pegma-dev/knowledge-base/pull/1) · [`2830be7`](https://github.com/pegma-dev/knowledge-base/commit/2830be77b246683c16bbc22da2cbc260dae904be)    | Standalone contracts/core, validation, and exact approval                                                   |
| KB-02                            | [KB #2](https://github.com/pegma-dev/knowledge-base/pull/2) · [`bc74cb1`](https://github.com/pegma-dev/knowledge-base/commit/bc74cb1eccc61416de6146702886b6cfd584e635)    | Authorized services, bounded persistence, private DTOs, and atomic Audit/receipts/work                      |
| KB-03                            | [KB #3](https://github.com/pegma-dev/knowledge-base/pull/3) · [`8caecbe`](https://github.com/pegma-dev/knowledge-base/commit/8caecbee5968d7ee1d4a8707727381d94b288ac0)    | Bounded retrieval, authoritative confirmation, safe citations, and repair                                   |
| SD-01                            | [Support #34](https://github.com/pegma-dev/support-desk/pull/34) · [`593006e`](https://github.com/pegma-dev/support-desk/commit/593006e5a5e64b223cc7525447b3813a20ff90dd) | Optional handling, attributed replies, deterministic human controls, and private success proof; no model    |
| KB-05 partial source preparation | [KB #4](https://github.com/pegma-dev/knowledge-base/pull/4) · [`ed530cb`](https://github.com/pegma-dev/knowledge-base/commit/ed530cb318f222ace6f392748bb19c9d8c83d96e)    | Shared memory/Azurite/real local D1 conformance and a public synthetic composition; full KB-05 remains open |

Latest verified source gates: Support Desk passed 399 tests; KB passed 340,
including its three-backend suites and synthetic example. Both passed Node
22/24 validation, CodeQL/security checks, current-head code review, and
clean-consumer import checks. These are source and local-consumer results,
not live credential, production-performance, deployment, or pilot evidence.
The three KB packages remain unpublished at source `0.1.0`. Current Support
Desk `0.1.1` source includes unreleased changes and is not the registry artifact
at that version; new synchronized publication is required before adoption.

**Next gates:** Host identity/API owners must prove scoped, revocable,
audience-bound author credentials and the protected-resource/real-client flow
for KB-04. Complete KB-04, then the full KB-05 release, first publication,
trusted-publisher setup, and verified released consumers before SD-02 and
dependent host work. Task 12, provider/ZDR/intermediary verification,
issue-to-deployed-build mapping, operations, dual-host acceptance, and supervised
pilots remain open. The independent partial KB-05 work does not close those gates.

Read the decision record and boundaries below, then give an implementation
agent exactly one task card. `PROJECT_PLAN.md` remains the roadmap and
`BUILDOUT.md` remains the existing Support Desk runbook. This plan replaces
their earlier knowledge/AI execution outline, including the staff-only scope
of proposed Task 18. It does not mark those features implemented or waive
Buildout Task 12's production-evidence gate.

The public plan contains reusable contracts and launch requirements. Keep
commercial documentation, actual customer data, private repository routing
configuration, credentials, and host operational details in their owning
private systems. Do not copy them into this repository or pegma.dev.

## Accepted decisions

| Decision             | Initial delivery                                                                               | Boundary or later extension                                     |
| -------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Hosts                | Both sites; isolated data and configuration                                                    | No shared control plane in this plan                            |
| Product scope        | Working KB, signed-in chat, essential staff/admin controls on both sites                       | Richer publishing and support interfaces                        |
| KB boundary          | Standalone Pegma component for product documentation and support knowledge                     | Other hosts can compose the same component                      |
| Authoring            | Authenticated API/MCP; KB owns content and revision history                                    | GitHub may be an agent's optional source, never a KB dependency |
| Guide verification   | Article-appropriate checks; local agents test instructions against staging and submit evidence | Additional validators as needed                                 |
| Access               | Collection-level audience permissions, inherited by every article                              | Explicitly enable public collections later                      |
| Bot knowledge        | Customer-readable collections plus collections approved for bot answers to that audience       | No access to staff-only collections through customer chat       |
| Agent authority      | Answer, ask questions, and escalate; customer/staff control resolution                         | Evaluated, explicitly configured automatic lifecycle handling   |
| Conversation         | Ticket from the first message; human queue entry on escalation                                 | Same conversation across later transports                       |
| Escalation           | Shared defaults with site-specific rules; customer can always request a person                 | Policy tuning from evaluated outcomes                           |
| Channels             | Signed-in web chat on both sites                                                               | Public chat and automated email support                         |
| AI processing        | Disclose AI use; process customer-submitted support text through a verified ZDR configuration  | Host-selectable compatible providers                            |
| Learning             | Automatically prepare drafts; staff approve before bot/customer use                            | Selective automatic publication after evidence supports it      |
| Eligibility          | Customer confirmation, staff-verified fix, or successful relevant test                         | Reopened tickets hold drafts for reassessment                   |
| Provenance           | Private source references and verification evidence for authorized staff                       | No copied raw-ticket archive in KB                              |
| Bug validity         | Verified reproduction or relevant test evidence; otherwise human review                        | Autonomous source-code investigation                            |
| Repository selection | AI chooses from an admin allowlist; ambiguity/insufficient confidence requires a human         | Calibrated routing improvements                                 |
| Issue publication    | Per-repository authority; every repository initially requires approval                         | Selective automatic filing; stricter checks for public trackers |
| Release follow-up    | Prepare customer updates, KB changes, and retests; staff approve sends/publication             | Automatic notifications after release tracking proves reliable  |
| Acceptance           | Full workflow scenarios on both sites                                                          | Supervised production pilot before wider rollout                |

The initial authorization covers customer-visible AI answers and ticket
escalation. It does not authorize AI account changes, financial calculations,
automatic ticket resolution, autonomous repository execution, or automatic
publication. RetireGolden answers must follow the host's existing product and
educational decision-support boundaries.

## Component and deployment boundaries

### Standalone knowledge base

The MIT [knowledge-base repository](https://github.com/pegma-dev/knowledge-base)
now contains `@pegma/knowledge-base-contracts`, `@pegma/knowledge-base-core`,
and `@pegma/knowledge-base-application` source. They remain unpublished; the
optional MCP adapter is still KB-04 work. Create a package only when its
implementation begins, with its own README, LICENSE,
build-on-pack behavior, and compiled-test exclusion.

The KB owns collections, article revisions, validation requirements and
evidence, approval/publication, retirement, and bounded retrieval. Its base
packages require neither Support Desk, GitHub, nor an LLM. The host supplies
Storage Core, Authorization Core access contexts, Spine clock/logger, Audit,
HTTP/session/token boundaries, scheduling, and optional blob/search adapters.
Role names and entitlements remain host policy. Do not add an access model,
database implementation, or shared-error taxonomy here or in Spine.

### Support Desk and optional integrations

Keep ticket workflow and queue semantics in the existing contracts/core/
application packages. Implement the coordinator in an optional
`@pegma/support-desk-ai` package in this repository when SD-02 starts. It
composes public Support Desk and KB APIs and host model/GitHub/release ports.
The ticket application must continue to work without that optional package,
a KB, an LLM, or GitHub. Provider SDKs and framework types stay out of domain
contracts. Split implementation into small modules rather than extending the
large application entry point with all orchestration code.

A third, general-purpose AI repository is deferred until another component
demonstrates a shared requirement. The KB has no reverse dependency on this
integration. Support Desk owns ticket-derived work and GitHub export; KB owns
approved knowledge. Model and connector credentials belong to each host.

### Hosts

| Concern                  | pegma.dev                                                                                           | RetireGolden                                                                                 |
| ------------------------ | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Runtime/store            | Existing Cloudflare Worker and D1-backed Storage Core                                               | Existing Azure host and Azure Tables-backed Storage Core                                     |
| Identity                 | Existing Identity/Sessions and Authorization Core composition                                       | Existing host authentication and Authorization Core composition                              |
| Existing support surface | Reuse `worker/src/support-desk.ts`, `support-api.ts`, `support-access.ts`, and staff/customer pages | Extend the existing account/support composition; record exact private paths in its host task |
| Release inputs           | Existing authenticated release ingestion/reconciliation can supply normalized signals               | Host supplies authenticated deployment/release evidence                                      |
| Content/configuration    | Pegma guides, audiences, repo allowlist, staff policy                                               | Separately owned product guides, audiences, repo allowlist, staff policy                     |

Share released code and synthetic conformance cases. Keep stores, namespaces,
search indexes, audiences, source references, tickets, queues, model projects,
credentials, budgets, GitHub installations, evidence, and worker checkpoints
independent. No `tenantId`, cross-host search, copied private product content,
or shared operator inbox is introduced.

These are source integration points, not claims of production readiness.
Refresh each host's current main and instructions before its task begins.

## Knowledge lifecycle and API/MCP

### Articles, collections, and publication

An article has a stable ID, a collection, immutable content revisions, product
and applicability metadata, an article kind, validation requirements, and a
published-revision pointer. Start with explanation, walkthrough, troubleshooting,
and developer-reference kinds. A walkthrough requires workflow evidence;
an explanation may need content/reference checks only. Support product/build
identifiers and optional locale without building translation management.

Collections define audience permissions and independent portal/bot use.
Examples are customer portal, customer-safe bot answers, and staff knowledge.
Bot-answer collections must explicitly name their permitted audience even when
portal browsing is disabled. There are no per-article access overrides. Moving
an article between collections is a reviewed audience change.

Default collections to private. Future anonymous portal access is represented
in collection policy but disabled on both hosts initially. An administrator
must preview and explicitly approve a collection becoming public. Public KB
access and anonymous support chat are separate capabilities.

Use draft, in-review, published, and retired states. Approval binds the exact
revision/hash, collection and audience-policy version, applicable product
version, required check results, and evidence versions. Editing content,
changing audience, or replacing evidence invalidates pending approval.
Published revisions are immutable; an update is a new reviewed revision.
Retirement and collection revocation remove the item from retrieval, with
authoritative checks protecting against stale search entries.

### Agent-facing operations

Define a versioned API contract and matching MCP tools for:

- listing authorized collections and reading/searching approved articles;
- creating/updating a draft using an expected revision;
- reading validation requirements for an article kind;
- submitting bounded verification evidence for an exact draft revision;
- submitting a revision for staff review and reading its review/check status.

Staff-only commands approve/publish, reject with reasons, retire, manage
collections/audiences, and manage validation policy. Local authoring credentials
initially receive draft/evidence permissions, not publication authority. Use
one application-service implementation for API, MCP, and staff UI. Validation,
authorization, idempotency, and conflict behavior must agree across transports.

Hosts authenticate agents with supported delegated/scoped credentials and map
them to principal IDs and permissions. HTTP MCP must validate resource audience
and issuer and support the applicable protected-resource discovery flow. A
local stdio bridge is acceptable when it uses a host-supported credential
flow. Neither transport may borrow GitHub credentials or turn a browser cookie
into an undocumented machine-authentication scheme. Prove both hosts' agent
authentication in P-00; a missing credential primitive is an explicit sibling
or host prerequisite, not a new identity system inside KB.

Evidence contains the article revision/hash, staging build, test kind/steps,
result, execution time, runner identity, and bounded artifact references.
Evidence is an attestation, not an instruction to execute arbitrary code.
Local agents do the browser/API/example execution against authorized staging
with synthetic data, following the same approach as product-demo verification.
The KB verifies schema, submitting permission, binding, and freshness; a
self-reported `passed` string alone does not satisfy publication policy.

Keep staff evidence and safe publishable illustrations separate. Use a host
blob adapter for protected screenshots when needed, with authorized upload/
download, size/type limits, and retention. Do not fetch arbitrary submitted
URLs, launch test code in the KB, or depend on Support Desk attachments shipping
first. Start with constrained Markdown/plain text; no executable MDX or raw
HTML in articles. Validate links and render through the host's safe renderer.

### Retrieval

Provide collection-scoped bounded retrieval with a maintained, repairable
projection. Start with lexical/title/tag retrieval and evaluate it on real
product question paraphrases. Declare physical row/page/candidate/body/token
bounds, deterministic ranking, and a safe no-result outcome. Request handlers
must not scan the entire corpus. Search projections are derived hints, backed
by Storage Core or a host search adapter, never a parallel authoritative store.
Semantic retrieval is optional behind the same port if evaluations require it;
model use must satisfy the host's data controls.

Authorize the effective customer audience before candidate material reaches
the model. A broad service credential must not widen that audience. Recheck
authoritative publication, applicability, and collection permissions before
returning content or committing an answer; retry or escalate on changed inputs.
Scope cache/index keys by host, audience/policy version, and article revision.

Customer-readable citations may link to the article. Bot-only citations use an
approved source label without exposing a staff URL or a browse capability.
Drafts, evidence, internal notes, and provenance are absent from model-facing
customer retrieval DTOs. Test titles, snippets, counts, errors, and stale cache
results for the same access boundary as full article bodies.

## Ticket-backed support agent

### One conversation and an explicit handoff

The first customer message creates the canonical ticket and first message in
the existing transaction. Add an optional handling state independent of
`TicketStatus`: assistant, human-pending, or human-active. Legacy tickets and
non-AI channels default to human handling; migrations must never hide existing
work. Human queue filtering confirms handling from the authoritative ticket.
Staff can separately inspect assistant conversations for supervision.

Introduce explicit assistant author attribution and an assistant-reply domain
transition. Assistant messages do not impersonate a staff principal or satisfy
first-human-response milestones. Define dedicated permissions and audit actions
for assistant reply and escalation. Preserve customer/staff/internal DTO
separation and the existing conversation ordinal/revision rules.

Shared escalation defaults include customer request, no suitable approved
guidance, conflicting guidance, repeated unsuccessful suggestions, and limits
on turns/time. Site configuration can add topic and security/bug triggers.
The Request a person control calls an authenticated deterministic command; it
works during model outages and cannot be vetoed by the model. Handoff changes
handling and records its reason, transcript references, safe summary, attempted
guides, and durable notification/work in the ticket transaction. Staff takeover
fences all outstanding assistant turns.

The bot may answer and ask clarifying questions in assistant handling. It may
request escalation, but may not resolve/close tickets, change account state,
grant permissions, run customer calculations, or send release follow-ups.
Customer confirmation can record success and explicitly resolve an owned
ticket through a separately authorized customer command; staff retain their
existing lifecycle commands. Mere inactivity is not resolution evidence.

### Durable generation and data controls

Commit an assistant-turn job with the causal customer message. Claim bounded
jobs with leases/fencing; load only the customer-visible conversation and
permitted approved knowledge. Record model/prompt/config versions, article
revisions, trigger revision, and safe processing metadata. Treat ticket text
and retrieved documents as untrusted data; they cannot change tool authority,
repo allowlists, or collection permissions. Tool choices are enforced by code.

Commit one complete validated reply against the still-current ticket revision,
handling state, and turn fence before exposing it. A newer customer message,
human takeover, escalation, or revoked source invalidates an old completion.
Do not stream unchecked model text to customers. Duplicate jobs/callbacks must
not append duplicate messages. Bound retries, generation time, input/output
tokens, per-user/site usage, and cost; provider failure or exhausted budget
keeps the ticket usable and offers human handoff.

Require structured output with only supplied article-revision references and
supported answer/escalation outcomes. Validate citation IDs and applicability
in code; evaluate factual support against approved sources in the versioned
test set. Model assertions that an answer is safe or correct do not substitute
for those checks. Missing support or conflicting guidance follows escalation
policy, with a useful explanation to the customer.

Disclose AI processing and describe what the application stores. Users choose
what support information they submit. Routine answering does not require a
human privacy classification or a promise of perfect pre-redaction. Keep
unneeded profiles, secrets, private staff notes, and unrelated records out of
customer-generation inputs and content out of operational logs/traces.

Require documented ZDR-compatible provider account/project, endpoint, model,
features, documented exceptions, and intermediary settings for every
customer-content processing path, including drafting/classification. Verify
them before activation and after
relevant configuration changes. Disable AI and retain human support when the
requirement cannot be met; never silently fall back to another retention mode.
ZDR is provider configuration with endpoint/feature limitations, not merely a
model label. It does not govern the host's own durable ticket/KB retention.

## Resolved-ticket learning

Record structured eligibility evidence bound to ticket revision, resolution
cycle, and product/build: authenticated customer confirmation, staff-verified
solution, or relevant successful test. A status of resolved or an LLM's claim
of success is insufficient on its own.

The eligible resolution transaction records durable draft work. The worker
rechecks eligibility, compares existing articles, and proposes an update when
appropriate instead of creating repeated near-duplicates. It removes customer
identifiers, account-specific values, secrets, and identifying circumstances
and produces a generalized problem, applicability, steps, solution, and
validation requirements. Privacy and factual checks run on the derived draft;
ZDR processing permission does not authorize publishing customer information.

Keep source references, resolution evidence, and reviewer notes in a private
staff DTO. The KB stores opaque references and structured evidence rather than
raw conversation snapshots. Reading a reference requires current permission
to the source ticket. API responses, search, citations, and model prompts for
customers never expose it.

Staff review privacy, correctness, applicability, duplication, and required
tests before approving the exact revision. Local agents can obtain the draft,
test it against staging, and attach evidence through the same API/MCP workflow.

Reopening a source ticket durably invalidates that resolution cycle and holds
its pending drafts for reassessment. Re-resolution requires fresh evidence.
Check source eligibility again at review/publication. Cross-component
invalidation is durable and reconciled, not a cross-store atomic transaction:
test publication/reopen races and converge stale drafts to held. Previously
published guidance receives a staff reassessment task; do not silently treat
the reopened source as fresh validation.

Source deletion/access revocation must revoke the private reference and flag
dependent evidence for reassessment according to host retention policy. Do not
copy deleted ticket bodies into KB to preserve history. A privacy withdrawal
retires affected published revisions and invalidates retrieval/cache hints.
Whether independently generalized guidance can remain is a documented host
review decision, not an inference by the model.

## Storage, replay, and essential controls

KB-02 documents the declared collection codecs and physical limits before
adding durable operations. Keep an article's revisions, publication pointer,
evidence metadata, command receipts, Audit actions, and causal worker jobs in
one article partition. Collection policy has its own authoritative partition;
search/catalog entries are separately maintained hints confirmed against the
article and current policy. Policy revocation cannot depend on a projection
update having completed. Blob uploads use pending references and orphan cleanup
because blob bytes and record commits do not share a transaction.

Support Desk keeps assistant turns, escalation work, eligibility evidence,
draft/export/follow-up receipts, and their causal Audit actions in the ticket
partition whenever they must commit with that ticket change. External jobs
carry stable operation IDs and source generations. Cross-component delivery
uses durable outbox/receipts, bounded workers, and repair checkpoints. The
Spine event bus remains best-effort; no required learning, escalation, export,
or invalidation may rely on a subscriber being called. No cross-partition or
cross-collection atomicity is assumed.

Both sites must provide these essential controls using their existing design
and role-administration surfaces:

- Customer: signed-in collection navigation/search, article reading, attributed
  ticket-backed chat, source labels, request-person, and explicit success
  confirmation. Preserve the conversation through human takeover.
- Staff: human queue plus a separate view for supervising assistant work,
  ticket takeover/reply/notes, draft text/preview, check/evidence status,
  source references, approve/reject with reasons, and reopened-source holds.
- Engineering review: missing-evidence queue, routing choices/reasons,
  restricted security review, current destination/visibility, exact outbound
  preview, duplicate suggestions, and approve/reject/reconcile actions.
- Admin: collection audiences and portal/bot use, article-kind validation
  requirements, scoped agent access, escalation rules, repository allowlist/
  descriptions/confidence gate/publication mode, provider/ZDR configuration
  status and secret references, budgets, and rollout/kill switches.
- Follow-up: release applicability, customer-update drafts, KB revision/retest
  requests, test results, and explicit approval through the owning workflow.

Use a simple text/Markdown edit form and preview initially. This scope does
not require a rich editor, analytics suite, cross-host console, or a new roles
model. Keep controls permission-gated through Authorization Core and record
configuration revisions in Audit. Credentials stay in host secret storage.

## Bug evaluation, routing, and GitHub export

### Evidence and configuration

A model can identify a suspected bug and request missing information. Only a
verified reproduction or relevant failing-test record can promote it to a
valid bug. Evidence must identify expected/actual behavior, product/build,
reproduction steps or test, submitting principal, and staff/runner verification.
Source-code access and autonomous execution are deferred. Reuse protected
evidence handling; never forward live customer datasets as reproduction data.

Admins maintain an allowlist keyed by immutable repository ID, with current
owner/name, responsibilities, product/component/version descriptions, permitted
labels/templates, visibility, and publication mode. Credentials and installation
scope remain host-owned. This is descriptive input for AI routing, not a rule
engine that deterministically chooses every repository.

AI proposes the allowed repository, alternatives, and supporting reasons.
Calibrate the acceptance gate against labeled routing examples and ambiguous/
out-of-scope reports. A model's self-assigned confidence percentage is not
sufficient evidence. Low-confidence, closely competing, unknown, or disallowed
targets require staff selection. Bound the candidate allowlist and verify the
selected ID again in code. Configuration changes invalidate prior proposals.

### Publication and security boundary

Every repository starts in approval-required mode. Store future automatic
filing capability per repository, disabled initially. Enabling it is a separate
audited admin action backed by the pilot evidence below; this plan does not
enable it. Public repositories receive stricter privacy/reproduction checks.

Before export, prepare an exact sanitized title/body/labels/evidence bundle and
show staff the destination and current visibility. Public reports use synthetic
reproductions and approved public evidence, with private ticket links, customer
identifiers, internal notes, and restricted product details removed. Private
repositories still use minimum necessary sanitized content. Suspected security
reports, secrets, and uncertain sensitivity enter a restricted human queue;
they never become ordinary GitHub issues automatically.

Approval binds the content hash, evidence version, repository ID, visibility,
configuration version, and gate results. Immediately before sending, re-read
repository metadata and publication authority. Visibility changes, especially
private-to-public, removals, transfers, or content edits require reassessment
and fresh approval. A public repository containing private source comments is
still public exposure; previews and checks must cover the entire outbound body.

Search for duplicates within the allowed destination and propose linking an
existing issue. Attach multiple private tickets to one engineering issue in
Support Desk. Adding public comments or changing an existing issue follows the
same export/approval boundary as creation.

Use a host GitHub App adapter with only required installation/repository
permissions. No organization-wide personal token or source-code permission is
required for this release. Keep the KB functional when GitHub is disconnected.
An approved export becomes durable work before the outbound call. Record a
stable opaque export marker and the remote issue ID on acceptance. On timeout
after possible acceptance, reconcile or hold for staff; do not blindly repeat
issue creation or claim exactly-once delivery from an API without that
guarantee. Rate limits, revoked installations, and unavailable metadata leave
the proposal visible for operator action.

## Release follow-up

Track the many-ticket-to-one-issue relationship privately. Normalize signed,
allowlisted webhook events and reconciled remote status through a host port.
A closed issue, merged PR, tag, or package release alone is not proof that the
fix is available in the affected customer's deployed product version.

Require a confirmed fix-to-product/build/deployment mapping, supplied by host
release evidence or explicit staff verification. Reuse pegma.dev's release
ingestion where useful; it still needs this mapping. Prepare affected-ticket
customer updates, KB revision proposals, and retest requests. Bind them to the
release/build, issue, source article, and current ticket state. Duplicate and
out-of-order events must not repeat work or revive obsolete drafts.

Staff approve each outbound message through the existing reply flow and each
article revision through KB publication. Agent retests submit evidence through
API/MCP. Failed retests, rolled-back releases, or reopened issues hold pending
follow-up for reassessment. No automatic customer notification is enabled in
the initial release.

## Task cards and dependency order

Each row is one repository-scoped PR. Read its listed prerequisite and the
relevant design section above. Add failing behavioral tests first, update the
owning contracts/layout/host docs in the same PR, and run that repository's
required gates. Cross-repository consumers wait for published exact versions;
never bridge phases with copied source, Git dependencies, local paths, or an
unpublished production tarball. A task may be split further if its review scope
is too large, preserving the dependency and exit criteria.

### Foundation and standalone KB

| ID / owner          | Depends on             | Deliverable                                                                                                                                                                                                                                                                | Evidence to finish                                                                                                                                                                            |
| ------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P-00 / Support Desk | This plan              | Refresh source/registry baseline; define synthetic dual-host fixtures, bounded workload limits, evaluation cases, approval fields, model-port requirements, and private host prerequisite checklist. Identify credential/release/ZDR gaps before consumers depend on them. | Decision-to-test mapping exists; no invented package pins; each unresolved operational input has an owner and activation gate.                                                                |
| KB-01 / new KB repo | P-00                   | Create repo and implement contracts/core for collections, article kinds, immutable revisions, validation requirements, and exact approval. Establish CI and release documentation; no empty adapter packages.                                                              | Pure transition, stale approval, collection inheritance, and malformed-content tests; Node 22/24 gate.                                                                                        |
| KB-02 / KB repo     | KB-01                  | Implement authorized authoring/review/publication/evidence services and declared collections using Storage Core and Audit. Document partition layout, limits, replay, and source-reference privacy.                                                                        | Public-entry memory and real-Azurite tests cover concurrency, atomic audit/jobs, private DTOs, revoked access, and idempotent evidence/review.                                                |
| KB-03 / KB repo     | KB-02                  | Implement bounded retrieval projection, authoritative confirmation, repair/retirement, and audience-aware citation DTOs.                                                                                                                                                   | Retrieval evaluation passes on representative paraphrases; stale index/access, physical scan bounds, bot-only collections, and draft exclusion cases pass.                                    |
| KB-04 / KB repo     | KB-03; P-00 auth proof | Implement optional MCP transport adapter and versioned HTTP/tool contract over the same services; document local-agent staging workflow and protected evidence integration.                                                                                                | A real local client creates/updates a draft and submits bound test evidence; expired/wrong-audience/revoked credentials fail; API/MCP behavior agrees.                                        |
| KB-05 / KB repo     | KB-04                  | Release candidate, runnable synthetic host composition, D1 consumer conformance fixture, pack/import checks, and new-package bootstrap/trusted-publisher setup.                                                                                                            | Azure Tables and D1 pass the same public contracts; artifacts exclude tests and include README/LICENSE; release owner publishes approved exact artifacts before host dependency installation. |

### Support Desk extensions

| ID / owner           | Depends on               | Deliverable                                                                                                                                                                                                                                 | Evidence to finish                                                                                                                                                                                            |
| -------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SD-01 / Support Desk | P-00                     | Ticket handling state, assistant attribution/transition, human queue filtering, deterministic request-person/takeover commands, and explicit customer success confirmation. No model integration yet.                                       | Legacy tickets remain visible; escalation is atomic/replay-safe; staff metrics exclude bot replies; customer commands enforce ownership; stale assistant completion cannot beat takeover.                     |
| SD-02 / Support Desk | SD-01; KB-05 publication | Implement optional AI package, host model port, durable turn jobs/claims, bounded permitted retrieval, exact answer commit, shared/configurable escalation rules, and audit metadata. Update release inventory when the new package exists. | Fake-provider public-entry tests prove all races, budgets/outages, prompt injection boundaries, source revocation, and internal-note exclusion; deterministic handoff remains available without the provider. |
| SD-03 / Support Desk | SD-02                    | Structured resolution evidence, durable KB draft/update workflow, private provenance, reopen/deletion invalidations, and source eligibility rechecks.                                                                                       | Repeated workers create one draft per source generation; reopening holds drafts; edit/evidence changes invalidate approval; raw/private data does not enter customer retrieval.                               |
| SD-04 / Support Desk | SD-03                    | Evidence-gated bug assessment, repository admin policy, calibrated AI routing, reviewable sanitized export, duplicate proposals, and host GitHub port/receipts.                                                                             | Unverified and security-sensitive reports stay private; ambiguous routing needs staff; public/private visibility changes invalidate approval; ambiguous outbound acceptance never blindly retries.            |
| SD-05 / Support Desk | SD-04                    | Normalized issue/release input port, confirmed deployment mapping, follow-up drafts, KB retest requests, and rollback/reopen invalidation.                                                                                                  | Duplicate/out-of-order events create one work set; issue closure alone never sends; all outbound updates and KB publication require current staff approval.                                                   |
| SD-06 / Support Desk | SD-05                    | Publishable synchronized package set, optional integration composition example, migration notes, worker/retention/kill-switch runbooks, and clean-consumer pack checks.                                                                     | Required Node 22/24 gates and real-store integration pass; existing hosts work with AI disabled; release owner publishes exact artifacts before host adoption.                                                |

### Host integrations and acceptance

| ID / owner                | Depends on                           | Deliverable                                                                                                                                                                                            | Evidence to finish                                                                                                                                                |
| ------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PG-01 / pegma.dev         | KB-05 publication                    | Compose KB Store/access/services, agent authentication, API/MCP endpoints, staging evidence, essential collection/draft/review controls, and signed-in guide/search pages.                             | Local agent author-test-review-publish loop works on D1; browser and tool audience checks agree; existing roles/support remain usable.                            |
| RG-01 / RetireGolden host | KB-05 publication                    | Equivalent KB integration in the existing Azure account/support host; record private source paths, staging configuration, and deployment requirements in that repository.                              | Same public contract scenarios pass on Azure Tables; existing account/entitlement and feature gates remain intact.                                                |
| PG-02 / pegma.dev         | PG-01; SD-06 publication             | Compose ZDR model adapter, ticket-backed chat, human queue/takeover, learning review, repo/export controls, and release follow-up review. Adapt existing release ingestion rather than duplicating it. | Complete acceptance matrix below passes on this host with fake connectors and an approved live-provider staging smoke.                                            |
| RG-02 / RetireGolden host | RG-01; SD-06 publication             | Equivalent essential customer/staff/admin workflows, isolated model/GitHub configuration, and confirmed release input.                                                                                 | Same acceptance matrix passes, with host-specific product/evidence cases kept private.                                                                            |
| A-01 / Support Desk       | PG-02; RG-02                         | Publish the generic cross-host acceptance report and evaluation summary; private host artifacts remain private.                                                                                        | Both hosts attest the same released component versions and scenario outcomes; all blocking failures fixed; no production-readiness claim from source tests alone. |
| R-PG / pegma.dev          | A-01; existing Task 12 host evidence | Run the supervised pilot using its host rollout controls.                                                                                                                                              | Staff sign off pilot observations and rollback rehearsal before widening access.                                                                                  |
| R-RG / RetireGolden host  | A-01; existing Task 12 host evidence | Run its separately controlled supervised pilot.                                                                                                                                                        | Equivalent host sign-off, with independent customer/data/operations policy.                                                                                       |

The merged-source ledger above records completed source slices, including
SD-01 and independent partial KB-05 preparation. The remaining critical path
is KB-04 credential/client proof and full KB-05 publication before SD-02 and
dependent host adoption. PG-01 can deliver the early KB win once its released
dependencies exist; RG-01 follows the same contracts. Host PRs are separate
and must each satisfy their own review/CI/deployment rules. No shared-package
PR edits a host. Do not create all task branches/packages in advance.

## Full-workflow build acceptance

Run every scenario on both hosts using the same released package set and
synthetic users/data, with host-specific staging guides where appropriate.
Use deterministic fake connectors for faults/races and separately record a
small approved live-provider staging smoke. Required evaluations apply to the
actual model, prompt, configuration, and retrieval versions being activated.

| Scenario                            | Required result                                                                                                                                                                           |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent-authored explanation          | Local MCP/API agent creates a draft; appropriate content checks and staff approval publish it without requiring GitHub.                                                                   |
| Agent-tested walkthrough            | Agent follows the guide on staging and submits evidence; wrong revision/build/runner or stale evidence blocks approval.                                                                   |
| Collection audiences                | Signed-in users see only allowed portal collections; bot-answer collections can inform permitted answers while staying unbrowsable; staff-only content never reaches customer generation. |
| Exact publication                   | Drafts and edits remain unavailable until staff approve that exact revision and audience; retirement/revocation defeats stale search/cache results.                                       |
| Ticket-backed answer                | First message durably creates one ticket; approved knowledge supports the attributed answer; bot-handled work stays out of the human queue.                                               |
| Human request and takeover          | Customer request works during provider failure; transcript/attempts reach staff; pending bot completions cannot answer after takeover.                                                    |
| Unsupported or conflicting guidance | Configured policy escalates with useful context; the bot does not invent a supported solution or change account state.                                                                    |
| Learning                            | Verified success creates one generalized draft/update with private provenance; staff approve before bot/customer use.                                                                     |
| Reopen and deletion                 | Reopened source holds pending drafts; deletion/revocation removes private references and triggers reassessment without copying raw source bodies.                                         |
| Bug validity                        | A report lacking verified evidence enters review; a reproduced/tested mismatch becomes an eligible bug proposal.                                                                          |
| AI routing                          | Clear cases select an allowlisted repository; ambiguous/out-of-scope cases require staff selection; injected repository instructions cannot bypass the allowlist.                         |
| Private/public export               | Staff approve the exact sanitized outbound bundle; current visibility is rechecked; public exports contain no private identifiers, links, or restricted evidence.                         |
| Security uncertainty                | Suspected security issues and uncertain sensitivity stay in restricted review with no ordinary issue export.                                                                              |
| External-call failures              | Provider outage, GitHub rate limits, ambiguous acceptance, and duplicate worker deliveries leave recoverable work without duplicate committed answers/known exports.                      |
| Released fix                        | Confirmed deployed fix prepares customer/KB/retest work; issue closure alone is insufficient; staff approval is required to send/publish.                                                 |
| Out-of-order and rollback           | Repeated/stale release events and rollback/reopen hold obsolete follow-ups and cannot send stale notifications.                                                                           |
| Capacity and isolation              | Configured row/page/token/job/usage limits hold; hosts cannot read or route each other's tickets, knowledge, evidence, or credentials.                                                    |
| ZDR and disclosure                  | User-facing disclosure matches verified provider features and application retention; incompatible configuration disables AI while human support remains available.                        |

P-00 records evaluation datasets and acceptance criteria before model tuning:
answer correctness/citation support, unsupported-answer escalation, retrieval
coverage, privacy leakage in derived drafts, routing accuracy/ambiguity,
handoff success, latency, and cost. Permission leaks, private-note disclosure,
unapproved publication, and unauthorized actions are blocking failures. Other
quality/latency/budget thresholds require host-owner sign-off based on measured
baselines; do not invent a percentage target or treat self-reported model
confidence as calibration. A model/prompt/retrieval change reruns affected
evaluations before activation.

Existing repository gates remain mandatory: Support Desk format/type/test on
Node 22 and 24, real-Azurite conformance, and the applicable security/review
checks. KB adopts equivalent gates and a real-D1 fixture. Host gates include
their existing build, feature-gating, authentication, and review checks. Docs
and package release checks are updated in the same owning PR.

## Supervised rollout and later automation

The build finishes at A-01. Broad production availability follows supervised
pilots, not automatically from merging shared packages. Existing Task 12
production evidence and host release/business gates remain prerequisites.

Each host first verifies the provider's actual ZDR configuration, scoped local
agent credentials, staff assignments, collections, test evidence handling,
repo descriptions/visibility, retention/deletion jobs, release mapping,
budgets, disclosures, and operator runbook. Record real values privately.
Begin with staff accounts and then a limited customer cohort; staff monitor
answers, takeovers, draft privacy/accuracy, routing suggestions, and costs.
Keep publication, issue exports, and release notifications approval-required.

Provide independently operable switches for assistant generation, learning,
issue export, and release follow-up. Disabling generation routes new work to
humans without losing tickets; disabling a worker retains visible pending
work. Test rollback to the previous released packages/configuration and repair
of projections/checkpoints before expanding the cohort. Monitor failures and
dead work without logging ticket text or full prompts.

Pilot exit requires reviewed scenario evidence, no unresolved blocking privacy
or authorization failures, successful human handoff/rollback, and host-owner
acceptance of measured quality/cost. Record observation period and cohort size
in each host rollout record. The component does not choose them silently.

Later, separately evaluated changes can enable selected automatic issue filing,
KB publication, notifications, and ticket lifecycle actions. Each capability
needs an audited admin opt-in, its own permissions/gates, current-head tests,
evaluation/pilot evidence, and rollback. Public issue trackers keep stricter
export controls. Anonymous chat, automated email, rich editors, general CMS
features, autonomous source investigation, and a shared multi-host control
plane remain outside this first delivery.

## Technical references

Recheck these primary sources when implementing adapters; they establish
provider/protocol behavior rather than choose a vendor for either host:

These links were fetched successfully on 2026-11-06. At that check, the MCP
`latest` authorization URL resolved to the dated revision below. P-00 records
the supported client/protocol versions and provider data-control requirements;
KB-04 rechecks compatibility before adopting them. A reference snapshot is not
a promise that a future client supports that revision.

- [Pegma composition catalog](https://pegma.dev/catalog.json): component
  boundaries, publication availability, and exact currently advertised pins.
- [MCP authorization specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization):
  resource-server discovery and token issuer/audience handling. Verify the
  current supported version against the actual local clients in KB-04.
- [OpenAI API data controls](https://developers.openai.com/api/docs/guides/your-data):
  one provider's ZDR approval, configuration, and endpoint/feature limitations;
  verify equivalent documentation for the provider actually selected.
- [GitHub issue API](https://docs.github.com/en/rest/issues/issues#create-an-issue)
  and [GitHub App permissions](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps):
  outbound request/response contracts and required installation permissions.
