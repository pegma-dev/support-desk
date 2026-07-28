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
changes embed `@pegma/audit` actions in the ticket transaction. Buildout Task 1
replaces the remaining pre-release private audit row before any staff command
is added. Expensive HTTP entry points use the host's
`@pegma/rate-limit` durable tier; Support Desk keeps only record size and
capacity limits.

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

**Human support first.** AI may summarize, retrieve, and draft for staff. It is
never the authority for a customer-impacting action, it cannot increase a
caller's permissions, and customer-visible generation or account actions need
their own permission, evaluation, audit, and human handoff. Internal notes never
enter customer-visible output — that separation is load-bearing, not stylistic.

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
The gate is `npm run format:check`, `npm run check`, `npm test` — all three must
pass, and CI runs them on Node 22 and 24.

Publishing is trusted-publisher only: no tokens exist. A release is
`gh release create vX.Y.Z`, which runs the same gate and publishes every
changed workspace package with a provenance attestation. A brand-new package
cannot use trusted publishing for its first version and needs one manual
`npm publish` plus a trusted-publisher configuration afterwards.

Nothing in this repository is published yet. A host production dependency must
wait for the exact public release described by Buildout Task 6; Git branches,
copied source, unpublished tarballs, and local filesystem dependencies are not
release substitutes.

## Where things stand

Foundation plus the customer-facing Phase 1/2 application services are
implemented in source: declared collections, authorized use cases,
transactional audit and outbox actions, replay receipts, cursor-aware workers,
and memory/Azurite tests. Phase 2's durable abuse limits and host-owned cursor
persistence remain composition work. Phase 6's provider-neutral outbound-mail
source is implemented against exact `@pegma/mail@0.1.0`, with Support-owned
projection, templates, threading metadata, and callback receipts.

Nothing in this repository is published. The remaining private audit row must
move to exact `@pegma/audit@0.1.0` and Authorization Core must align to exact
`0.1.2` before staff work. Customer services must also stop returning the full
authoritative ticket shape before a host route uses them. Phases 3–5 still
require Azure and D1 host compositions, two customer web experiences, and
isolated staff queues; provider selection and operation remain host work.

This project was developed under the `@support-desk` scope and moved into Pegma
on 2026-07-26. The git history begins at that move, nothing was published under
the former name, and the planned storage, Azure, and EntitleKit-access packages
were deleted rather than renamed.

## Reading order

`docs/PROJECT_PLAN.md` is the source of truth for scope, phases, and decisions
already made. `docs/BUILDOUT.md` is the one-task-per-pull-request implementation
handoff; give an implementation agent one task from it, never the whole
roadmap. Then read `docs/ARCHITECTURE.md` for boundaries and persistence,
`docs/MVP_SPEC.md` for product behavior, and `docs/COLLECTIONS.md` before any
durable layout change.

Siblings: [storage-core](https://github.com/pegma-dev/storage-core),
[authorization-core](https://github.com/pegma-dev/authorization-core),
[spine](https://github.com/pegma-dev/spine), and the organization profile at
[github.com/pegma-dev](https://github.com/pegma-dev).
