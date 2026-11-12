# Working in this repository

Read this before changing anything. It is short on purpose.

## What this is part of

Support Desk is one component of **Pegma**, a family of MIT-licensed packages
that a host application composes: a support queue for web and email here,
identity and permissions in `@pegma/authorization-core`, persistence in
`@pegma/storage-core`, shared contracts in `@pegma/spine`. They publish under
the `@pegma` scope, one repository per component.

The governing principle, which every rule below follows from:

> **Optimize for a fresh agent context window.** How much must be read to make
> a correct change, and how does the change prove itself correct? Minimize the
> first, mechanize the second.

That is why contracts are typed and narrow, why conformance suites exist, why
wiring is explicit rather than discovered, and why the code is deliberately
ordinary. Novel structure is harder for both people and models to read.

## Hard rules

**Never build persistence in this repository.** Declare collections against
`@pegma/storage-core` and take a `Store` from the host. The port surface is
keyed access, `update` with a decider that re-runs on every conflict,
`putIfUnchanged` and `deleteIfUnchanged` for a version read earlier,
`list`/`listVersioned` over one partition, bounded opaque-cursor `scan`, and
`transact(partition, actions)` scoped to one collection and one partition.
There is deliberately no cross-partition atomicity and no version-conditional
delete inside a transaction; a conditional removal is a `putIfUnchanged` to a
tombstone your codec understands. If storage cannot express something you
need, that is a gap to fix in `storage-core` with conformance cases, not to work
around here. A private repository, a cache with its own file, a "just for
tests" in-memory table — all of those are the same mistake wearing different
names.

**Never build an access model in this repository.** Ask
`@pegma/authorization-core` whether a `PrincipalId` holds a named permission.
Support Desk owns permission _names_ — they are part of its public contract —
and owns the resource check that follows, because `support.ticket.read.own`
never proves a ticket belongs to the caller. It does not own roles, plans,
entitlements, policy, or an access port. EntitleKit is now Authorization Core;
if you find the old name anywhere, it is stale.

**Never build a second audit contract or request limiter here.** Accepted
changes embed `@pegma/audit` actions in the ticket transaction. Expensive HTTP
entry points use the host's `@pegma/rate-limit` durable tier; Support Desk
keeps only record size and capacity limits.

**Do not redeclare what `@pegma/spine` already names.** `PrincipalId`,
`IsoTimestamp`, `Clock`, `Logger`, and event definitions come from spine and
are re-exported by `@pegma/support-desk-contracts`. A locally declared
`PrincipalId` type-checks fine and quietly ends the guarantee that the
principal Authorization Core resolved is the principal this queue stores. This
repository already declared its own once; it was replaced on 2026-07-26.

**Reads are explicit and bounded.** There is no server-side filtering,
ordering, or secondary index, and a listed partition or scanned collection is
not a snapshot. Customer and detail reads are one key or one whole partition.
Collection-wide scans are repeating cursor-aware worker or queue-projection
loops, never hidden queries. Filtering happens in the application after the
read. A second access path is a maintained projection that Support Desk writes
and repairs itself, and a projection row is a hint confirmed against the
authoritative record — never ownership or authorization evidence. A read that
can grow without a configured bound is a design error now, not a scaling
problem later. A scan bound counts every adapter-returned physical record and
page before application filtering; counting only returned matches is not a
bound.

**Everything a state change must commit with, it must share a partition with.**
A ticket, its messages, its Audit events, and its outbox rows live together for
exactly this reason: `transact` is what makes a reply and the notification it
triggers one commit. If a new record needs to land atomically with a ticket
change and cannot share that partition, the partition layout is wrong — do not
reach for a second transaction and hope.

**Treat all inbound content as hostile.** Sender identity, HTML, links,
attachments, and quoted email text are attacker-controlled. An email address
match assists routing and never authenticates: it must not enter the
verified-session path, grant account access, or select a principal. Raw MIME
and unsanitized HTML never reach a stored contract, a staff page, or a customer
page. A ticket number is safe to show and is not a secret, not a capability,
and not sufficient to read or modify anything.

**One conversation model for web and email.** Channels are transports. Do not
add an email-shaped ticket, an email-only status, or a parallel message type. A
customer moving between the website and their inbox stays in one thread.

**The first two hosts are isolated instances, not tenants.** retiregolden.org
and pegma.dev use the same exact packages with separate stores, namespaces,
queues, number counters, mail channels, policies, secrets, cursors, and
retention. Do not add `tenantId`, a cross-cloud database, or a shared control
plane to join them.

**Human support first.** The approved enhancement in
`docs/KNOWLEDGE_AI_PLAN.md` permits optional, evaluated customer-visible AI
answers and escalation through dedicated permissions, audit, and human handoff.
Those capabilities remain disabled until their implementation and activation
gates pass. AI must never increase a caller's permissions. The initial AI agent
cannot resolve tickets or act on accounts. Knowledge publication, GitHub export,
and release follow-up require staff approval initially; later automation needs the
plan's separate opt-in and evidence gates. Internal notes never enter
customer-visible output — that separation is load-bearing, not stylistic.

**Do not create a package before its implementation begins.** An empty adapter
package makes a compatibility promise while supplying nothing. Package
directories stay short (`packages/contracts`, `packages/core`) even though the
published names are long (`@pegma/support-desk-contracts`).

**Do not weaken a documented guarantee to make an implementation easier.**
Idempotent inbound processing, retry-safe delivery, revision-based concurrency,
and the internal-note boundary are load-bearing. A design that quietly breaks
one is wrong even when it is smaller. If a guarantee genuinely should change,
change the documentation deliberately and say so in the pull request.

**Never write literal control characters into source.** Write them as escape
sequences such as backslash-u-0000 through backslash-u-001F in regular
expressions, and verify the bytes after any tool-assisted edit. This matters
more here than in most repositories: email content, MIME headers, and subject
markers are exactly where a control character will be parsed rather than
matched. The Write tool has silently turned those escapes into actual control
characters, producing a regex that reads correctly and matches the wrong thing.

## Workflow

Work on a `claude/*` branch and open a pull request; `main` is protected by CI.
The gate is `pnpm run format:check`, `pnpm run check`, `pnpm test` — all three must
pass, and CI runs them on Node 22 and 24.

Publishing is trusted-publisher only: no tokens exist. Releases use a protected
signed annotated tag already on `origin/main` and a verified GitHub release,
with the complete gate and provenance workflow in `docs/RELEASING.md`. A brand-new package
cannot use trusted publishing for its first version and needs one maintainer
2FA `npm publish` without OIDC provenance, plus trusted-publisher configuration
afterwards. For new KB and Agent Access names, that unadvertised `bootstrap`
release is separate from the reviewed first advertised release in their
public bootstrap handoffs.

Buildout Task 6 prepared the first exact `0.1.0` set; its bootstrap is complete.
A host production dependency must wait for its required release on the public registry;
Git branches, copied source, unpublished tarballs, and local filesystem
dependencies are not release substitutes. Follow `docs/RELEASING.md` for the
first publish and later OIDC releases.

## Where things stand

Buildout Task 14 attachments are published in `0.2.5`: host-owned immutable blobs, transactional message metadata, digest-bound scan callbacks, authorized clean-only downloads, deletion fences, bounded expiration and fenced orphan reconciliation. Inbound mail still drops attachments. See `docs/ATTACHMENTS.md`; host activation remains gated on private isolated storage, scanner and retention wiring.

Foundation plus the customer-facing Phase 1/2 application services, staff
detail/mutation services (Buildout Task 4), the staff queue repairable
projection (Buildout Task 5), and the host-neutral release candidate (Buildout
Task 6) are implemented in source: declared collections, authorized customer
and staff use cases, transactional audit and outbox actions, replay receipts,
cursor-aware workers (including queue repair and inactive-row sweep),
memory/Azurite tests, a framework-free composition example, host error and
scheduler documentation, and the release pack lane for exact `0.1.0`. Phase 2's
durable abuse limits and host-owned cursor persistence remain composition work.
Phase 6's provider-neutral outbound-mail source is implemented against exact
`@pegma/mail@0.1.1`, with Support-owned projection, templates, threading
metadata, and callback receipts. The Support Desk slice of Buildout Task 11
(inbound mail processing, receipt lifecycle, and the threading index) is
implemented in source; inbound provider adapters remain host work.

Buildout Task 13 lifecycle extras are implemented in source: bounded host
allowlisted staff tags, host-supplied response targets and durable milestones,
confirmed queue tag/target filtering and due sorts, and optional staff revision
collision hints. Customer DTOs and automatic customer mail omit these fields.
Calendars and presence stay host-owned. Task 12 remains pending on both hosts'
durable-store production evidence. Source work does not publish a package.

The five local manifests and exact internal Support pins target unpublished
`0.2.9`. It adds optional per-attempt model-planning/completion, proposal and
dispatch observations while retaining fresh proof, authority, opaque-version
confirmation and exact ACK recovery. Legacy structural ports keep their full
fallback. See the [candidate notes](docs/RELEASE_NOTES.md#029-engineering-worker-observations)
and [worker contract](docs/ENGINEERING_EXPORT.md#candidate-029-worker-observations).
The candidate now pins exact verified public KB application/contracts `0.1.7`.
Its changed dependency graph requires fresh SDK qualification; published
`0.2.8` retains its exact KB `0.1.6` pins. The
root stays private at `0.0.0`; source or candidate packs do not qualify registry
publication or a host's complete query/CPU budget.

The unpublished `0.2.9` candidate also adds opt-in
[`deliveryMode: 'staged'`](docs/RESOLUTION_LEARNING.md#opt-in-staged-draft-delivery-029-candidate)
with durable prepare/write checkpoints that release the claim and a later
physical completion phase.
Staged reconciliation advances one unconfirmed destination per invocation and
yields after one retirement attempt for later fresh readback.
Closing policy/receipt checks apply to inline delivery too. The optional
[`./openrouter` entry](packages/ai/README.md#optional-openrouter-adapter-source-candidate)
keeps the AI root provider-neutral and requires explicit host binding with
separate host stores, keys and current privacy/configuration evidence. Native
Workers Free 50/100 qualification remains pending.

All five packages have verified published `0.2.8` versions. The synchronized
`0.2.1` and `0.2.0` artifacts remain immutable history. The original four names also retain
their published `0.1.0`/`0.1.1` artifacts; the AI name's `0.1.1` is a separate
registration-only bootstrap. Follow the
[publication receipt](docs/RELEASING.md#verified-028-publication-2026-11-12)
and release operations. Customer services return safe DTOs; staff
services return the authoritative ticket for authorized staff only, and the
staff queue scans a confirmed projection that is never authorization evidence.
Authorization Core is pinned to exact `0.4.0` and accepted-change history uses
exact `@pegma/audit@0.2.0`. Host Tasks 7–8 consume exact verified published artifacts
and retain their own deployment and acceptance gates.
Provider selection and operation remain host work.

The synchronized `0.2.1` assistant-answering read-batching patch is published
and strictly verified across all five packages. Its internal Support pins
advance together; the optional AI package retains exact KB `0.1.2` pins. The
[2026-11-10 publication receipt](docs/RELEASING.md#verified-021-publication-2026-11-10)
binds the original artifacts, completed Node 22/24 gates and strict registry
verification. Earlier release receipts and host activation gates are unchanged;
grouped reads do not establish a universal query or CPU budget.

Published `0.2.2` adds [opt-in durable staged retrieval](docs/ASSISTANT_COORDINATION.md#opt-in-durable-staged-retrieval)
and exact learning review-intent recovery. Its optional AI package and matching
repository development/test pins use exact KB application/contracts `0.1.5`.
The default remains monolithic. Preparation consumes an existing attempt;
both application and verified-configuration caps must allow at least two,
without resetting counters or raising caps. Exhaustive `AssistantProcessResult`
handlers must accept the added `prepared` union member even when opt-in is OFF.
After `prepared`, the host must return from that physical invocation and resume
only in a subsequent one. Stable complete configuration/authority snapshots and
fresh live guards remain required. Publication does not establish Free-plan or
host invocation/CPU acceptance.

Published `0.2.3` contains the [engineering review guard correction](docs/ENGINEERING_EXPORT.md).
Approval runs the supplied commit guard after current repository/policy
observations; supplied rejection guards run at the final mutation boundary.
Direct application rejection may still omit its guard, and receipt-first replay
retains current review/queue authority. The release receipt records its original
preparation, registry propagation failures, and verified attempt-three recovery.

Published `0.2.4` adds admitted customer intake, edited-draft learning review,
final draft and staff follow-up checks, and grouped assistant finish reads.
Published `0.2.5` adds attachments and opt-in staged human learning reviews.
The dated receipt binds its executed gates, authenticated publication recovery
and strict registry verification. Host adoption and activation retain their
own composition, deployment, provider/privacy and client acceptance gates.

SD-01 is implemented in source via
[PR #34](https://github.com/pegma-dev/support-desk/pull/34): optional handling
defaults legacy tickets to human support, explicitly attributes assistant
messages with exact completion fences, and adds deterministic owned
request-person, staff takeover, private success evidence, human queue
selection, and bounded atomic handoff work. It adds no model, KB dependency,
or package; its behavior first shipped in synchronized `0.2.0` and remains in
current `0.2.8`. Do not overwrite registry `0.1.1` or install a source substitute. Host adoption retains its own
activation gates after verified SDK publication.
Standalone KB-01 through KB-04, AUTH-01 Agent Access, partial KB-05 source
preparation ([KB #4](https://github.com/pegma-dev/knowledge-base/pull/4)), and
both producers' final release preparation are merged. The
[standalone authoring recipe](docs/HOST_COMPOSITION.md#kb-authoring-producers)
selects all four strictly verified KB `0.1.6` packages and verified Agent
Access `0.1.1`. The trusted releases close the producer publication gates.
Their manual `0.1.0` bootstrap receipts remain historical and have no OIDC
provenance. SD-02
merged in [PR #38](https://github.com/pegma-dev/support-desk/pull/38), adding
optional `@pegma/support-desk-ai` and bounded turn work to the existing ticket
partition. SD-03 merged in [PR #39](https://github.com/pegma-dev/support-desk/pull/39),
adding verified resolution learning and KB draft delivery. SD-04 merged in
[PR #40](https://github.com/pegma-dev/support-desk/pull/40), adding verified
engineering export and reconciliation; see [its guide](docs/ENGINEERING_EXPORT.md).
SD-05 merged in [PR #41](https://github.com/pegma-dev/support-desk/pull/41),
adding confirmed-deployment release follow-up; see
[its guide](docs/ENGINEERING_FOLLOWUP.md).
SD-06's synchronized `0.2.0` release is published and strictly verified from
signed `v0.2.0` at `efc9d733b3d305d24cf4197444e1d76c99bdb777`; see
`docs/RELEASING.md` for the dated receipt. Its public composition example lives in `examples/ai`;
the migration and operations handbooks are `docs/UPGRADING.md` and
`docs/AI_OPERATIONS.md`. The base application has no KB or provider dependency; actual KB
`0.1.6` application/contracts dependencies belong only to the current
optional AI `0.2.8` package. Older `0.2.0` and
`0.2.1` AI manifests retain their original `0.1.2` pins. See [assistant coordination](docs/ASSISTANT_COORDINATION.md)
and its [layout checkpoint](docs/COLLECTIONS.md#sd-02-assistant-turn-layout-checkpoint).
PG-01/RG-01 consume exact verified published producers and still require actual
existing-login/Admin consent and requested-client proof before activation or
pilots. Synthetic
SDK/source proof uses no actual customer data and does not close host privacy,
operations, full-workflow, or pilot gates. Follow the
[implementation ledger](docs/KNOWLEDGE_AI_PLAN.md#status-and-reading-order)
and [producer handoff](docs/HOST_COMPOSITION.md#kb-authoring-producers)
for merged-source evidence and remaining gates.

This project was developed under the `@support-desk` scope and moved into Pegma
on 2026-07-26. The git history begins at that move, nothing was published under
the former name, and the planned storage, Azure, and EntitleKit-access packages
were deleted rather than renamed.

## Reading order

`docs/PROJECT_PLAN.md` is the source of truth for scope, phases, and decisions
already made. `docs/BUILDOUT.md` is the one-task-per-pull-request implementation
handoff; give an implementation agent one task from it, never the whole
roadmap. For the approved standalone KB and AI enhancement, use one task from
`docs/KNOWLEDGE_AI_PLAN.md`; it supersedes the earlier knowledge package and
staff-only Task 18 outline without marking those capabilities implemented.
P-00's baseline and test infrastructure are in `docs/KNOWLEDGE_AI_P00.md` and
`test/knowledge-ai`; its open prerequisites block their named activation gates,
not unrelated pure source work. The corpus must be exercised through actual
adapters in later tasks; its harness tests are not feature acceptance.
Then read `docs/ARCHITECTURE.md` for boundaries and persistence,
`docs/MVP_SPEC.md` for product behavior, and `docs/COLLECTIONS.md` before any
durable layout change.

Siblings: [storage-core](https://github.com/pegma-dev/storage-core),
[authorization-core](https://github.com/pegma-dev/authorization-core),
[spine](https://github.com/pegma-dev/spine), and the organization profile at
[github.com/pegma-dev](https://github.com/pegma-dev).
