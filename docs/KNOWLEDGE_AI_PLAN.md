# Knowledge base and AI support implementation plan

## Status and reading order

Approved product decisions: 2026-11-06; scoped-agent-access decision added
2026-11-07. The ten entries in the ledger below are merged source, including
AUTH-01, KB-04's transport source exit, and both producers' release preparation.
The current verified producer versions are KB `0.1.2` for all four packages
and Agent Access `0.1.1`, closing SD-02's KB-05 prerequisite. The dated ledger
below is historical. Support Desk's synchronized `0.2.0` release is now
published and strictly verified for all five packages; see the
[publication receipt](RELEASING.md#verified-sd-06-publication-2026-11-08).
Actual two-host authenticated authoring, model activation, and pilots remain
separate gates.
Use the [P-00 handoff](KNOWLEDGE_AI_P00.md) for the frozen package baseline,
acceptance corpus, capacity assumptions, and owned activation prerequisites.
This plan covers a standalone Pegma knowledge base, an optional Support Desk
AI agent and engineering workflow, and working integrations on both launch
hosts. RetireGolden is the primary use case; pegma.dev is the simpler early
integration. Completing one host does not complete this enhancement.

**Historical merged-source ledger: 2026-11-07.** Publication was still pending
at these ten source checkpoints; the later verified releases
are recorded separately below.

| Source work                      | Merged evidence                                                                                                                                                              | Delivered source                                                                                                               |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| P-00                             | [Support #33](https://github.com/pegma-dev/support-desk/pull/33) · [`fcf5a68`](https://github.com/pegma-dev/support-desk/commit/fcf5a68f83d335b9867a6975443c03d3a86e3c4f)    | Frozen baseline, synthetic acceptance oracles, and capacity checks                                                             |
| KB-01                            | [KB #1](https://github.com/pegma-dev/knowledge-base/pull/1) · [`2830be7`](https://github.com/pegma-dev/knowledge-base/commit/2830be77b246683c16bbc22da2cbc260dae904be)       | Standalone contracts/core, validation, and exact approval                                                                      |
| KB-02                            | [KB #2](https://github.com/pegma-dev/knowledge-base/pull/2) · [`bc74cb1`](https://github.com/pegma-dev/knowledge-base/commit/bc74cb1eccc61416de6146702886b6cfd584e635)       | Authorized services, bounded persistence, private DTOs, and atomic Audit/receipts/work                                         |
| KB-03                            | [KB #3](https://github.com/pegma-dev/knowledge-base/pull/3) · [`8caecbe`](https://github.com/pegma-dev/knowledge-base/commit/8caecbee5968d7ee1d4a8707727381d94b288ac0)       | Bounded retrieval, authoritative confirmation, safe citations, and repair                                                      |
| SD-01                            | [Support #34](https://github.com/pegma-dev/support-desk/pull/34) · [`593006e`](https://github.com/pegma-dev/support-desk/commit/593006e5a5e64b223cc7525447b3813a20ff90dd)    | Optional handling, attributed replies, deterministic human controls, and private success proof; no model                       |
| KB-05 partial source preparation | [KB #4](https://github.com/pegma-dev/knowledge-base/pull/4) · [`ed530cb`](https://github.com/pegma-dev/knowledge-base/commit/ed530cb318f222ace6f392748bb19c9d8c83d96e)       | Shared memory/Azurite/real local D1 conformance and a public synthetic composition; publication was pending at this checkpoint |
| AUTH-01 source                   | [Agent Access #1](https://github.com/pegma-dev/agent-access/pull/1) · [`a444e21`](https://github.com/pegma-dev/agent-access/commit/a444e2113db98455b638b2ef8aa7c2faccb16b62) | Scoped credential lifecycle, bounded durable grants, host HTTP ports, and synthetic protocol proof                             |
| KB-04 transport source exit      | [KB #5](https://github.com/pegma-dev/knowledge-base/pull/5) · [`b61fc77`](https://github.com/pegma-dev/knowledge-base/commit/b61fc77aedd22e888ac7292c3597f93e54fcda8e)       | Five-operation optional MCP adapter, versioned HTTP contract, and authenticated actual-SDK synthetic draft/evidence parity     |
| KB-05 release preparation        | [KB #6](https://github.com/pegma-dev/knowledge-base/pull/6) · [`7f5eee6`](https://github.com/pegma-dev/knowledge-base/commit/7f5eee68be692b5489de3965f3f5ede7ef7a812d)       | Four-package artifact/release tooling and first-publication handoff; publication was pending at this checkpoint                |
| Agent Access release preparation | [Agent Access #2](https://github.com/pegma-dev/agent-access/pull/2) · [`eddddd5`](https://github.com/pegma-dev/agent-access/commit/eddddd5e333ce16b6a4a8233b84656b3ac784947) | Packed types/API/SDK checks, artifact/release tooling, and separate first-publication handoff                                  |

Support Desk's [Node 22/24 CI](https://github.com/pegma-dev/support-desk/actions/runs/42347759445)
passed 399 tests per lane; its [review check](https://github.com/pegma-dev/support-desk/actions/runs/42347759580)
was clean and [PR #34's security report](https://github.com/pegma-dev/support-desk/pull/34#issuecomment-6703506061)
reported no findings. Four-package pack/import validation was a **local check**
recorded in [PR #34](https://github.com/pegma-dev/support-desk/pull/34).

KB's historical [Node 22/24 CI](https://github.com/pegma-dev/knowledge-base/actions/runs/42350344635)
passed 340 tests per lane, its synthetic example, and three-package
clean-consumer imports. Its [review check](https://github.com/pegma-dev/knowledge-base/actions/runs/42350344641)
was clean and [PR #4's security report](https://github.com/pegma-dev/knowledge-base/pull/4#issuecomment-6703808221)
reported no findings. Both source PRs also record passed CodeQL checks.

[AUTH-01 source](https://github.com/pegma-dev/agent-access/pull/1) recorded
123 runtime tests; [KB-04 source](https://github.com/pegma-dev/knowledge-base/pull/5)
recorded 372 runtime tests per Node 22/24 lane and the authenticated official-SDK
synthetic protocol proof. Those are historical source results.
[KB #6](https://github.com/pegma-dev/knowledge-base/pull/6) passed 372 runtime
and 128 release tests on **each** Node 22/24 lane with zero skips, plus the full
five-package SDK proof (four KB packages and Agent Access). Its
[OpenRouter round 3 review](https://github.com/pegma-dev/knowledge-base/pull/6#pullrequestreview-5814111477)
was clean with zero open findings, and its
[security report](https://github.com/pegma-dev/knowledge-base/pull/6#issuecomment-6710997171)
reported no findings. [Agent Access #2](https://github.com/pegma-dev/agent-access/pull/2)
passed 123 runtime and 136 release tests on **each** Node 22/24 lane with zero
skips, including packed types/API/SDK example checks. Its
[OpenRouter round 3 review](https://github.com/pegma-dev/agent-access/pull/2#pullrequestreview-5814178148)
was clean in both reviewer lanes with zero open findings, and its
[security report](https://github.com/pegma-dev/agent-access/pull/2#issuecomment-6711125916)
reported no findings. Source, emulator, and synthetic SDK results do not prove
actual host login/client compatibility, production performance, deployment,
model calls, or pilots.

**Historical verified producer releases: 2026-11-07.** Agent Access
[PR #4](https://github.com/pegma-dev/agent-access/pull/4) merged
[`ffe4d86`](https://github.com/pegma-dev/agent-access/commit/ffe4d8616632ce9d057caaf65124746f03d4d349)
and signed `v0.1.1`; its [strict verify job](https://github.com/pegma-dev/agent-access/actions/runs/42420302775/job/128549453970)
passed on run attempt 2 at 22:32:42Z for one registry package and its clean
consumer. KB [PR #8](https://github.com/pegma-dev/knowledge-base/pull/8) merged
[`32086e4`](https://github.com/pegma-dev/knowledge-base/commit/32086e4374f2ef45044cd09c371e506d10b88d64)
and signed `v0.1.1`; its [strict verify job](https://github.com/pegma-dev/knowledge-base/actions/runs/42424148244/job/128564059833)
passed on run attempt 5 at 23:35:31Z for all four registry packages and clean
consumers. These jobs verify exact bytes/dependencies, cryptographic signatures,
and source repository/workflow/tag/commit provenance. Canonical original
artifact identities and manual `0.1.0` bootstrap receipts remain in the
[KB release handoff](https://github.com/pegma-dev/knowledge-base/blob/main/docs/BOOTSTRAP.md)
and [Agent Access release handoff](https://github.com/pegma-dev/agent-access/blob/main/docs/BOOTSTRAP.md).
Manual bootstrap had no OIDC provenance; the later trusted releases close the
publication gates. Earlier registry 404s and the `a444e21` source fixture are
historical. Current KB protocol proof uses four packed KB packages plus
registry `@pegma/agent-access@0.1.1`. The frozen P-00 snapshot remains unchanged.
The current four-package KB producer is the verified trusted
[`0.1.2` release](https://github.com/pegma-dev/knowledge-base/releases/tag/v0.1.2),
source `004044bfa836b74a61fb5defa49d5ebab1fe37dd`, with strict
[registry/consumer verification](https://github.com/pegma-dev/knowledge-base/actions/runs/42436081951/job/128617897564).
The dated `0.1.1` receipts above are retained history, not current KB pins.

**Verified Support Desk publication: 2026-11-08.** The signed
[`v0.2.0` release](https://github.com/pegma-dev/support-desk/releases/tag/v0.2.0)
binds reviewed source
[`efc9d733`](https://github.com/pegma-dev/support-desk/commit/efc9d733b3d305d24cf4197444e1d76c99bdb777).
[Release run 42494797076](https://github.com/pegma-dev/support-desk/actions/runs/42494797076)
passed 2,449 tests across 53 test files on each Node 22/24 lane with zero skips,
plus formatting, types, examples, five-package pack/import and
clean-consumer gates. Attempt 2 completed publication, and its
[strict registry verification](https://github.com/pegma-dev/support-desk/actions/runs/42494797076/job/128785494994)
passed exact original bytes, dependencies, registry signatures, workflow/tag/source
provenance and clean public imports for all five packages. Their observed
`latest` tags are `0.2.0`; AI's registration-only `bootstrap` remains `0.1.1`.
The [release handbook](RELEASING.md#verified-sd-06-publication-2026-11-08)
records the original artifact identities and recovery without repacking.

**Current version facts and next gates:** All five Support Desk packages are
published at verified `0.2.0`. The optional `@pegma/support-desk-ai` package uses
exact KB `0.1.2` runtime dependencies; the base application remains independent
of KB and providers. The [coordination design](ASSISTANT_COORDINATION.md) and
[layout checkpoint](COLLECTIONS.md#sd-02-assistant-turn-layout-checkpoint)
record its five public application operations, bounded same-partition turns,
authority/data controls, and replay contract. Public-entry memory/Azurite tests
with the actual KB and a fake provider, Node 22/24 gates, and code/security
review support this SDK release; they do not establish host activation.
Existing registry versions remain immutable. PG-01/RG-01 use exact verified
published dependencies. Actual existing-login/current-Admin consent and every
requested client/mode on both hosts remain unproven activation gates tracked
by P-00 and PG-01/RG-01. Publication and source/SDK results do not close them.
Task 12, provider/ZDR/intermediary verification,
issue-to-deployed-build mapping, operations, dual-host acceptance, and supervised
pilots remain open. Verified SDK publication does not close
those gates.

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

| Decision             | Initial delivery                                                                                                         | Boundary or later extension                                     |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| Hosts                | Both sites; isolated data and configuration                                                                              | No shared control plane in this plan                            |
| Product scope        | Working KB, signed-in chat, essential staff/admin controls on both sites                                                 | Richer publishing and support interfaces                        |
| KB boundary          | Standalone Pegma component for product documentation and support knowledge                                               | Other hosts can compose the same component                      |
| Authoring            | Authenticated API/MCP; KB owns content and revision history                                                              | GitHub may be an agent's optional source, never a KB dependency |
| Agent linking        | Existing host login; current Admin consents through the RFC 8628 device grant or authorization-code grant with S256 PKCE | No agent Admin role; new capabilities require fresh consent     |
| Authoring scopes     | Instance-wide draft read/write and test-evidence submission only                                                         | Collection-specific consent is a future extension               |
| Guide verification   | Article-appropriate checks; local agents test instructions against staging and submit evidence                           | Additional validators as needed                                 |
| Access               | Collection-level audience permissions, inherited by every article                                                        | Explicitly enable public collections later                      |
| Bot knowledge        | Customer-readable collections plus collections approved for bot answers to that audience                                 | No access to staff-only collections through customer chat       |
| Agent authority      | Answer, ask questions, and escalate; customer/staff control resolution                                                   | Evaluated, explicitly configured automatic lifecycle handling   |
| Conversation         | Ticket from the first message; human queue entry on escalation                                                           | Same conversation across later transports                       |
| Escalation           | Shared defaults with site-specific rules; customer can always request a person                                           | Policy tuning from evaluated outcomes                           |
| Channels             | Signed-in web chat on both sites                                                                                         | Public chat and automated email support                         |
| AI processing        | Disclose AI use; process customer-submitted support text through a verified ZDR configuration                            | Host-selectable compatible providers                            |
| Learning             | Automatically prepare drafts; staff approve before bot/customer use                                                      | Selective automatic publication after evidence supports it      |
| Eligibility          | Customer confirmation, staff-verified fix, or successful relevant test                                                   | Reopened tickets hold drafts for reassessment                   |
| Provenance           | Private source references and verification evidence for authorized staff                                                 | No copied raw-ticket archive in KB                              |
| Bug validity         | Verified reproduction or relevant test evidence; otherwise human review                                                  | Autonomous source-code investigation                            |
| Repository selection | AI chooses from an admin allowlist; ambiguity/insufficient confidence requires a human                                   | Calibrated routing improvements                                 |
| Issue publication    | Per-repository authority; every repository initially requires approval                                                   | Selective automatic filing; stricter checks for public trackers |
| Release follow-up    | Prepare customer updates, KB changes, and retests; staff approve sends/publication                                       | Automatic notifications after release tracking proves reliable  |
| Acceptance           | Full workflow scenarios on both sites                                                                                    | Supervised production pilot before wider rollout                |

The initial authorization covers customer-visible AI answers and ticket
escalation. It does not authorize AI account changes, financial calculations,
automatic ticket resolution, autonomous repository execution, or automatic
publication. RetireGolden answers must follow the host's existing product and
educational decision-support boundaries.

## Component and deployment boundaries

### Standalone knowledge base

The MIT [knowledge-base repository](https://github.com/pegma-dev/knowledge-base)
now contains `@pegma/knowledge-base-contracts`, `@pegma/knowledge-base-core`,
`@pegma/knowledge-base-application`, and optional `@pegma/knowledge-base-mcp`
source. All four have verified trusted `0.1.2` registry releases; KB-04's
transport source exit and KB-05 release preparation remain historical source
evidence. Any future package is created only
when its implementation begins, with its own README, LICENSE, build-on-pack
behavior, and compiled-test exclusion.

The KB owns collections, article revisions, validation requirements and
evidence, approval/publication, retirement, and bounded retrieval. Its base
packages require neither Support Desk, GitHub, nor an LLM. The host supplies
Storage Core, Authorization Core access contexts, Spine clock/logger, Audit,
HTTP/session boundaries, Agent Access credential validation, scheduling, and
optional blob/search adapters.
Role names and entitlements remain host policy. Do not add an access model,
database implementation, or shared-error taxonomy here or in Spine.

### Agent Access credential prerequisite

AUTH-01 belongs to the separate MIT
[Agent Access repository](https://github.com/pegma-dev/agent-access). Its
`@pegma/agent-access@0.1.1` has a verified trusted registry release after its
merged lifecycle source and release preparation. Identity and Sessions retain their
authentication/OAuth refusals; Authorization Core's fixed short-lived
consume-on-verify grants remain unchanged. KB is the resource
server, and its optional MCP package owns transport over KB services.

Hosts reuse their existing human login and current Admin-only linking policy.
Agent Access owns the RFC 8628 device grant with a human user code, explicit
polling interval, and `slow_down` handling. Its authorization-code grant
requires S256 PKCE. Both flows use explicit client/resource/scope binding,
opaque credentials hashed at rest, rotating refresh families, replay
revocation, and bounded grant storage. Current principal status, current
approval authority, and current permissions are rechecked on use and refresh;
missing/unavailable authority
fails closed. Agent permissions intersect that authority with the consented
scope snapshot; Admin roles, entitlements, and browser cookies are not inherited.
Only selected scope definitions are fingerprinted: unrelated new scopes cannot
widen or invalidate existing consent, while changed selected definitions need
fresh consent. Owners manage grants through current Admin browser authority.

Browser consent remains a host route with existing-session authentication,
CSRF/same-origin protection, and durable limiters. Agent bearers cannot approve
new grants. Each host independently configures and validates issuer/resource,
clients, redirects, scopes, revocation, retention, and protected discovery.
Source tests and a synthetic SDK example can precede publication using
test-only packed artifacts. Production assembly consumes exact published
dependencies, and actual two-host existing-login/client proof is a separate
activation gate tracked by P-00 and PG-01/RG-01. KB-04's merged source exit
establishes transport release readiness only; it cannot close that host
acceptance. No host login composition or deployment is performed by AUTH-01 source work.

Initial client compatibility targets are Codex, Claude Code, Grok Bot, and
T3 Code. Grok Bot means the desktop application with its hosted agent, not
Grok Build CLI. T3 Code targets its Codex-provider mode first; other providers
remain unproven. Each target requires an actual per-client run against the
supported host flow; compatibility is unproven until recorded. The official
SDK synthetic protocol proof does not establish that these applications work.
Record unsupported or unavailable client flows as open acceptance gaps.

### Support Desk and optional integrations

Keep ticket workflow and queue semantics in the existing contracts/core/
application packages. SD-02's merged coordinator lives in the optional
`@pegma/support-desk-ai` package in this repository. It composes public Support
Desk and KB APIs and host model, configuration, authority, and usage ports.
Engineering and release coordination are merged SD-04/SD-05 source;
live adapters remain host work. Read the
[coordination guide](ASSISTANT_COORDINATION.md) before changing it.
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

Define a versioned API contract and optional matching MCP adapter initially
exposing exactly `getDraft`, `createDraft`, `updateDraft`,
`getValidationRequirements`, and `submitEvidence`. Writes use an expected
revision and stable operation identity. The agent transport provides no
collection reading/listing, evidence reading, review submission, publication,
admin commands, or private provenance. Existing authorized retrieval and staff
services remain separate; future agent operations need explicit scopes and
fresh consent.

Map the host's selected OAuth scopes to the existing KB public-service
permissions exactly; the transport does not create a second permission model:

| Agent operation              | Existing KB permission required      |
| ---------------------------- | ------------------------------------ |
| `getDraft`                   | `draftRead`                          |
| `createDraft`, `updateDraft` | `draftWrite`                         |
| `submitEvidence`             | `evidenceSubmit`                     |
| `getValidationRequirements`  | `draftWrite` **or** `evidenceSubmit` |

For `getValidationRequirements`, `draftRead` alone and `validationManage` alone
must fail at the initial agent boundary; do not use either as a fallback.
Source parity and retained host acceptance test the permitted alternatives
and these denied cases. Staff validation-policy management remains separate.

Staff-only commands approve/publish, reject with reasons, retire, manage
collections/audiences, and manage validation policy. Local authoring credentials
initially receive draft/evidence permissions, not publication authority. Use
one application-service implementation for API, MCP, and staff UI. Validation,
authorization, idempotency, and conflict behavior must agree across transports.

Hosts authenticate agents through AUTH-01 and map the restricted context to
KB principal IDs and permissions. HTTP MCP must validate resource audience
and issuer and support the applicable protected-resource discovery flow. A
local stdio bridge is acceptable when it uses a host-supported credential
flow. Neither transport may borrow GitHub credentials or turn a browser cookie
into a machine credential. AUTH-01 supplies the separate credential lifecycle;
KB-04 tests its transport with actual-SDK synthetic composition, while
PG-01/RG-01 must prove both hosts' existing-login and actual-client composition
using published dependencies before authoring activation.
Initial authoring scopes are instance-wide. Per-collection delegated grants
remain a future seam, without changing collection audience checks.

Evidence contains the article revision/hash, staging build, test kind/steps,
result, execution time, runner identity, and bounded artifact references.
Evidence is an attestation, not an instruction to execute arbitrary code.
Local agents do the browser/API/example execution against authorized staging
with synthetic data, following the same approach as product-demo verification.
The KB verifies schema, submitting permission, binding, and freshness. Agent
authentication does not prove execution: a trusted host attester must verify
the submitting actor, runner, exact revision/hash, target build, and execution
receipt before constructing accepted evidence. Missing or unverifiable
attestation fails closed; a self-reported `passed` string alone does not
satisfy publication policy.

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
required gates. Production cross-repository consumers wait for published exact
versions; never bridge production phases with copied source, Git dependencies,
local paths, or an unpublished tarball. A source-only synthetic test may use a
reviewed test tarball before publication; that is not production assembly or
real host acceptance. A task may be split further if its review scope
is too large, preserving the dependency and exit criteria.

### Foundation and standalone KB

| ID / owner             | Depends on                           | Deliverable                                                                                                                                                                                                                                                                | Evidence to finish                                                                                                                                                                                                                                                        |
| ---------------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P-00 / Support Desk    | This plan                            | Refresh source/registry baseline; define synthetic dual-host fixtures, bounded workload limits, evaluation cases, approval fields, model-port requirements, and private host prerequisite checklist. Identify credential/release/ZDR gaps before consumers depend on them. | Decision-to-test mapping exists; no invented package pins; each unresolved operational input has an owner and activation gate.                                                                                                                                            |
| KB-01 / new KB repo    | P-00                                 | Create repo and implement contracts/core for collections, article kinds, immutable revisions, validation requirements, and exact approval. Establish CI and release documentation; no empty adapter packages.                                                              | Pure transition, stale approval, collection inheritance, and malformed-content tests; Node 22/24 gate.                                                                                                                                                                    |
| KB-02 / KB repo        | KB-01                                | Implement authorized authoring/review/publication/evidence services and declared collections using Storage Core and Audit. Document partition layout, limits, replay, and source-reference privacy.                                                                        | Public-entry memory and real-Azurite tests cover concurrency, atomic audit/jobs, private DTOs, revoked access, and idempotent evidence/review.                                                                                                                            |
| KB-03 / KB repo        | KB-02                                | Implement bounded retrieval projection, authoritative confirmation, repair/retirement, and audience-aware citation DTOs.                                                                                                                                                   | Retrieval evaluation passes on representative paraphrases; stale index/access, physical scan bounds, bot-only collections, and draft exclusion cases pass.                                                                                                                |
| AUTH-01 / Agent Access | P-00; approved agent-access decision | Implement the separate RFC 8628 device grant and authorization-code grant with S256 PKCE, using exact released foundations, current Admin consent, opaque hashed credentials, bounded refresh/replay state, discovery, and host HTTP ports.                                | Node 22/24 source/pack/review gates and synthetic actual-SDK proof; first publication and actual two-host login/client acceptance remain separate gates.                                                                                                                  |
| KB-04 / KB repo        | KB-03; AUTH-01 source/SDK fixture    | Implement the five-operation optional MCP adapter and versioned HTTP contract over the same services; integrate protected host-attested evidence without exposing staff/provenance operations.                                                                             | Source exit: real SDK against a test-only synthetic composition creates/updates/reads drafts and submits bound evidence; API/MCP parity, rejected credential/evidence cases, Node 22/24 and clean review pass. Real-host acceptance remains open in P-00 and PG-01/RG-01. |
| KB-05 / KB repo        | KB-04 source exit                    | Release candidate, runnable synthetic host composition, D1 consumer conformance fixture, pack/import checks, and new-package bootstrap/trusted-publisher setup.                                                                                                            | Azure Tables and D1 pass the same public contracts; all source/review gates pass; artifacts exclude tests and include README/LICENSE; publish approved exact artifacts before host installation. Source release readiness does not close host acceptance.                 |

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

| ID / owner                | Depends on                             | Deliverable                                                                                                                                                                                                  | Evidence to finish                                                                                                                                                                                                                                                                                               |
| ------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PG-01 / pegma.dev         | AUTH-01 publication; KB-05 publication | Consume exact published dependencies; compose existing-login/Admin consent, KB Store/access/services, protected API/MCP, trusted evidence attestation, essential controls, and signed-in guide/search pages. | Actual requested clients in their target modes complete draft/read/write/evidence flows on D1; current-authority/revocation/audience failures and rejected evidence pass; staff review/publication and existing roles/support remain usable. Close this host's retained KB-04/P-00 acceptance before activation. |
| RG-01 / RetireGolden host | AUTH-01 publication; KB-05 publication | Equivalent released-dependency KB integration in the existing Azure account/support host; record private paths, staging configuration, and deployment requirements privately.                                | Same actual-client, existing-login/Admin consent, protected transport, evidence, and failure scenarios pass on Azure Tables; account/entitlement and feature gates remain intact. Close this host's retained KB-04/P-00 acceptance before activation.                                                            |
| PG-02 / pegma.dev         | PG-01; SD-06 publication               | Compose ZDR model adapter, ticket-backed chat, human queue/takeover, learning review, repo/export controls, and release follow-up review. Adapt existing release ingestion rather than duplicating it.       | Complete acceptance matrix below passes on this host with fake connectors and an approved live-provider staging smoke.                                                                                                                                                                                           |
| RG-02 / RetireGolden host | RG-01; SD-06 publication               | Equivalent essential customer/staff/admin workflows, isolated model/GitHub configuration, and confirmed release input.                                                                                       | Same acceptance matrix passes, with host-specific product/evidence cases kept private.                                                                                                                                                                                                                           |
| A-01 / Support Desk       | PG-02; RG-02                           | Publish the generic cross-host acceptance report and evaluation summary; private host artifacts remain private.                                                                                              | Both hosts attest the same released component versions and scenario outcomes; all blocking failures fixed; no production-readiness claim from source tests alone.                                                                                                                                                |
| R-PG / pegma.dev          | A-01; existing Task 12 host evidence   | Run the supervised pilot using its host rollout controls.                                                                                                                                                    | Staff sign off pilot observations and rollback rehearsal before widening access.                                                                                                                                                                                                                                 |
| R-RG / RetireGolden host  | A-01; existing Task 12 host evidence   | Run its separately controlled supervised pilot.                                                                                                                                                              | Equivalent host sign-off, with independent customer/data/operations policy.                                                                                                                                                                                                                                      |

The merged-source ledger above records completed source slices, including
AUTH-01, SD-01, KB-04's transport source exit, and both producers' release
preparation. The current producer publication gates are closed by strictly
verified trusted KB `0.1.2`, Agent Access `0.1.1`, and the synchronized Support
Desk `0.2.0` release recorded above. PG-01 and RG-01 must consume those
published dependencies and prove actual
existing-login and requested-client draft/evidence flows. KB-04's merged source
exit closes only its source slice; retained actual two-host acceptance remains pending in P-00,
PG-01/RG-01, and A-01 until those real runs pass. Source/SDK success cannot close
it. SD-01 through SD-06 SDK source and publication do not claim host activation.
Host PRs are separate and must each satisfy their review/CI/deployment rules.
No shared-package PR edits a host. Do not create all task branches/packages in
advance.

The retained host acceptance includes every original authoring obligation:
actual client discovery and existing-login/current-Admin consent, scoped
draft read/create/update and host-attested exact-revision evidence, matching
API/MCP behavior, expiry/wrong-audience/revocation/excess-scope rejection,
current principal/permission changes, and wrong revision/build/runner or stale
evidence rejection. Explicit negative tests must prove initial agent credentials
cannot publish, submit/read reviews, act as staff or Admin, manage collections
or validation policy, read collections/evidence/private provenance, or link or
manage grants. They must also verify the exact tool-permission alternatives
above, including denial of `getValidationRequirements` with only `draftRead`
or only `validationManage`. Both hosts and every initial requested client/mode
must have recorded results. Staff approval/publication, privacy, isolation, bounded
work, and all full-workflow scenarios below remain required activation gates
before A-01 and either pilot; a synthetic SDK run waives none of them.

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
KB-04 rechecks SDK/protocol compatibility before adopting them; PG-01/RG-01
verify actual requested clients. A reference snapshot is not
a promise that a future client supports that revision.

- [Pegma composition catalog](https://pegma.dev/catalog.json): component
  boundaries, publication availability, and exact currently advertised pins.
- [MCP authorization specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization):
  resource-server discovery and token issuer/audience handling. Verify the
  current supported version against the KB-04 source fixture and actual
  requested clients in PG-01/RG-01.
- [OpenAI API data controls](https://developers.openai.com/api/docs/guides/your-data):
  one provider's ZDR approval, configuration, and endpoint/feature limitations;
  verify equivalent documentation for the provider actually selected.
- [GitHub issue API](https://docs.github.com/en/rest/issues/issues#create-an-issue)
  and [GitHub App permissions](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps):
  outbound request/response contracts and required installation permissions.
