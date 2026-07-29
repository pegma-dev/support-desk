# Support Desk buildout runbook

This is the execution guide for the next implementation work. `PROJECT_PLAN.md`
owns the roadmap, `ARCHITECTURE.md` owns the boundaries, `MVP_SPEC.md` owns
product behavior, and `COLLECTIONS.md` owns durable layouts. This document turns
those decisions into small pull requests that can be handed to an agent one at
a time.

Do not give an implementation agent the whole roadmap and ask it to "build the
help desk." Give it exactly one task below.

## Rules for every task

1. Start from current `origin/main` on a new `claude/*` branch.
2. Read `AGENTS.md`, this task, and only the linked sections needed for it.
3. Change one repository only. A Support Desk pull request never edits a host
   or sibling Pegma repository, and a host pull request never copies Support
   Desk internals.
4. Use exact `0.x` dependency versions. Do not use ranges, Git branches, local
   filesystem dependencies, or copied sibling source.
5. Add or change a public contract only when the task explicitly says to.
6. Write the failing test first for a behavioral change. Use public entry
   points in integration tests.
7. Do not add a framework, provider SDK, persistence implementation, access
   model, session model, or private rate limiter here.
8. Run `npm run format:check`, `npm run check`, and `npm test` before stopping.
9. Update the relevant documentation in the same pull request. If code and
   docs disagree, the task is not complete.
10. Stop instead of improvising when a stop condition below is reached.

Each task is one pull request unless its task card explicitly says otherwise.
Merge it and return to green `main` before starting the next task.

## Launch topology

The first launch is **two isolated Support Desk instances using the same
packages**, not one multi-tenant service:

| Concern           | retiregolden.org                   | pegma.dev                                                      |
| ----------------- | ---------------------------------- | -------------------------------------------------------------- |
| Purpose           | Private customer support           | Product feedback, bug reports, feature requests, and questions |
| Runtime           | Existing Azure host                | Existing Cloudflare Worker                                     |
| Store             | Host-created Azure Tables `Store`  | Host-created D1 `Store`                                        |
| Identity          | Host-verified Auth0/BFF session    | Host-verified Pegma Identity/Sessions session                  |
| Create permission | Paid-product entitlement policy    | Authenticated-user default policy                              |
| Data              | RetireGolden-only namespace        | pegma.dev-only namespace                                       |
| Staff queue       | RetireGolden operator surface      | Pegma operator surface                                         |
| Mail and branding | RetireGolden channel and templates | Pegma channel and templates                                    |

The instances do not share a database, queue, ticket-number sequence, mailbox,
retention policy, worker cursor, secret, or authorization cache. Ticket numbers
are instance-scoped and their subject markers identify the instance, for
example `[RG-1042]` and `[PEG-1042]`.

A unified operator inbox, cross-instance search, shared ticket service, and
multi-brand administration are post-MVP work. Do not create a `tenantId`,
remote Support Desk service, cross-cloud database, or replication pipeline to
simulate them.

## Pegma dependency map

| Package                                               | Support Desk rule                                                                                                                                                                                              |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@pegma/spine@0.1.1`                                  | Use its identity, time, logger, and event contracts. Its in-process event bus is never the durable notification path.                                                                                          |
| `@pegma/storage-core@0.4.0`                           | Support Desk declares collections and accepts a host `Store`. Azure and D1 adapters stay in Storage Core and the hosts.                                                                                        |
| `@pegma/authorization-core@0.1.2`                     | Application services consume `AccessContext`; hosts resolve roles and entitlements. Support Desk owns permission names and resource checks.                                                                    |
| `@pegma/audit@0.1.0`                                  | Owns the generic audit event and transaction action. Support Desk embeds it in the ticket partition; it does not keep a parallel audit shape.                                                                  |
| `@pegma/mail@0.1.0`                                   | Owns provider-neutral outbound state, claims, retries, reconciliation, and terminal states. Support Desk owns templates and the projection into ticket records.                                                |
| `@pegma/rate-limit@0.1.0`                             | Hosts apply its durable tier before expensive create and reply commands. Support Desk does not wrap or reimplement it.                                                                                         |
| `@pegma/sessions@0.1.0`                               | A host may use it to resolve a browser session to a `PrincipalId`. Support Desk never reads cookies or sessions.                                                                                               |
| `@pegma/identity` and authorization identity adapters | pegma.dev host concerns. Only a trusted `PrincipalId` and resolved `AccessContext` cross into Support Desk.                                                                                                    |
| `@pegma/webhooks`                                     | Do not substitute it for Support Desk inbound-mail or delivery-callback receipts. Its generic sequential ledger permits overlapping processing and lacks Support Desk's channel, message, and result bindings. |
| Pegma logger adapters and health                      | Host composition concerns. Support Desk emits through Spine `Logger`; hosts expose worker and dependency health.                                                                                               |

If a sibling package cannot express a required guarantee, stop and open a
small issue or conformance case in that sibling. Do not hide the gap behind a
Support Desk wrapper.

## Product profiles

Both launch profiles use the same ticket, message, lifecycle, permission, and
audit contracts.

RetireGolden policy grants customer permissions from paid-product
entitlements. pegma.dev policy grants create/read-own/reply-own to an
authenticated account without requiring a paid entitlement. Permission
resolution belongs to each host; no plan name, role name, or issuer appears in
Support Desk.

Both web surfaces require an authenticated session for the first launch.
Anonymous browser submission is deliberately absent. Unknown people can enter
through verified inbound email after the inbound-mail task ships; an email
match never authenticates them.

`category` is an optional, host-configured opaque identifier on a ticket.
Controllers present an allowlisted choice and the application service validates
it. Initial pegma.dev values are:

- `feedback`
- `bug`
- `feature_request`
- `documentation`
- `question`

RetireGolden chooses its own allowlist at its composition root. Category never
establishes identity, permission, priority, or assignment. Bug reports are not
automatically copied to GitHub Issues: tickets may contain account or security
details. A later staff-only export must require an explicit redaction and
confirmation step.

## Shared package work

### Task 1 — align with Audit and current Authorization Core

**Goal:** Remove the last duplicate ecosystem contract before more commands
depend on it.

**Allowed scope:** `packages/application`, its tests and README,
`package-lock.json`, `COLLECTIONS.md`, and status prose.

**Required changes:**

- pin `@pegma/authorization-core` to exact `0.1.2`;
- add exact `@pegma/audit@0.1.0`;
- replace the private `AuditRecord` fields with an embedded Pegma
  `AuditEvent`;
- define the Support Desk audit projection with `defineAudit`, in
  `support-desk.records.v1` and the ticket partition;
- create audit actions with `defineAudit(...).action(...)` inside the same
  customer create/reply transactions as the state changes;
- use stable Support Desk action names, ticket ID as subject, ticket revision
  as sequence, the command/correlation identifiers in details, and the trusted
  application time;
- keep domain `TicketEvent` separate: it is the pure workflow command, while
  `AuditEvent` is the durable record of the accepted change;
- read audit history through the Audit package rather than a second custom
  sorter.

There is no production Support Desk data and no package is published, so this
pre-release record-shape replacement does not need a migration. Do not rename
the collection merely to avoid updating its codec and tests.

**Tests that must exist:**

- create and reply commit the state and Audit action together;
- a refused transaction leaves neither the state change nor an orphan audit
  event;
- replay of the same command does not append a second audit event;
- audit history orders by ticket revision even when timestamps are equal;
- customer views still expose no audit records.

**Stop if:** `@pegma/audit` cannot carry a required safe field. Confirm the
field is genuinely shared, then change Audit with its own conformance case.
Do not fork its event type here.

The audit action registry is closed for the MVP:

- `support.ticket.created`
- `support.ticket.customer_replied`
- `support.ticket.staff_replied`
- `support.ticket.note_added`
- `support.ticket.assigned`
- `support.ticket.unassigned`
- `support.ticket.priority_changed`
- `support.ticket.resolved`
- `support.ticket.closed`
- `support.ticket.reopened`

Use the command ID as the Audit event ID, the ticket ID as subject, and the
resulting ticket revision as sequence. Do not generate a second random ID for
the same accepted command.

### Task 2 — finish the dual-host customer contract

**Goal:** Make the already implemented customer slice accurately support both
launch profiles without introducing tenancy.

**Allowed scope:** contracts, core, application, tests, package READMEs, and
the four architecture/product docs.

**Required changes:**

- add optional `category` to `Ticket` and `CreateTicketInput`;
- add `category` to `CreateCustomerTicketCommand`;
- add `customerUpdatedAt` to `Ticket`; create and customer-visible messages or
  lifecycle changes advance it, while notes, assignment, and priority changes
  advance only staff-facing `updatedAt`;
- add a frozen, deduplicated `allowedCategories` application option with a
  maximum of 32 values matching `^[a-z][a-z0-9_]{0,31}$`;
- reject a supplied category that is not configured;
- include category in the command snapshot and idempotency fingerprint;
- preserve category unchanged through every lifecycle transition;
- replace customer methods that return the full authoritative `Ticket` with
  explicit customer summary/detail DTOs that omit requester evidence, priority,
  assignee, staff-facing `updatedAt`, revision, and every other staff field;
- add RetireGolden-like and pegma.dev-like policy fixtures that prove the same
  service works when permission comes from an entitlement or an authenticated
  user default;
- keep authenticated web creation as the only customer create command.

The browser may choose a category value from a form, but the server supplies
principal, requester association, channel, priority, identifiers, timestamps,
and notification routing.

**Tests that must exist:**

- both host policy profiles can create, list, read, and reply;
- a pegma.dev user without a paid entitlement can act only because its policy
  granted the exact permissions;
- unknown, duplicate, oversized, accessor-backed, and control-character
  categories fail before persistence;
- category changes alter an idempotency fingerprint;
- no category changes authorization or initial priority.
- internal notes, assignment, and priority transitions do not change
  `customerUpdatedAt`, while staff replies and customer-visible lifecycle
  changes do;
- customer list and detail values contain no requester email or association,
  priority, assignee, audit data, storage revision, or staff-only update time.

**Stop if:** the implementation needs a `tenantId`, host name, provider claim,
or plan name in a Support Desk contract. The two stores are the isolation
boundary.

### Task 3 — own instance-scoped ticket-number reservation

**Goal:** Stop making every controller invent a durable ticket-number
allocator.

**Allowed scope:** application, collection tests, `COLLECTIONS.md`, and public
package documentation.

**Required changes:**

- declare `support-desk.ticket-numbers.v1`;
- keep one `{ lastIssued }` counter record at constant partition `instance` and
  ID `ticket-number` in the host's Support Desk namespace;
- reserve the next positive safe integer with `update` and a decider;
- remove `ticketNumber` from browser/controller input;
- reserve before ticket creation and accept gaps when a later operation fails;
- make command replay return the ticket number already committed, never reserve
  another number after the ticket exists;
- leave ticket IDs and command IDs as server-minted cryptographically random
  identifiers supplied by the controller.

Numbers are unique only inside one Support Desk instance. They are display and
threading aids, not secrets or authorization capabilities.

**Tests that must exist:**

- concurrent reservations are unique and monotonic;
- a failed create may leave a gap but never a duplicate;
- a replay returns the original number;
- exhaustion fails closed before ticket persistence;
- Azure-backed behavior matches memory behavior.

**Stop if:** uniqueness appears to require the counter and ticket to share one
transaction. Reservation plus tolerated gaps is the intended design.

### Task 4 — implement staff detail and mutation services

**Goal:** Complete staff work on a known ticket before building queue
discovery.

**Allowed scope:** contracts only when a public command/view type is needed,
core, application, tests, and docs. Do not build HTTP routes or UI here.

**Required permissions:**

- `support.queue.read`
- `support.ticket.reply.any`
- `support.ticket.note`
- `support.ticket.assign`
- `support.ticket.manage`
- `support.audit.read`

**Required services:**

- read one staff ticket by ID;
- append a customer-visible staff reply;
- append an internal note;
- assign or unassign;
- change priority;
- resolve, close, and reopen;
- read ticket audit history only with `support.audit.read`.

Every mutation uses a server-minted command ID, request fingerprint, bounded
conflict retry, trusted monotonic ticket time, a canonical message when
applicable, an Audit action, and an optional Mail action in the one ticket
transaction. Internal notes never create customer mail and never appear in a
customer view. Assignment and priority changes do not change lifecycle status.

**Tests that must exist:**

- a permission matrix with one denial test for every service;
- every mutation is idempotent and conflict-safe;
- a staff reply is customer-visible and moves to
  `waiting_on_customer`;
- a note is internal, creates no customer delivery, and does not change
  status;
- lifecycle rules match `MVP_SPEC.md`;
- customer views and rendered notifications cannot include internal notes;
- unknown and cross-instance ticket IDs reveal no ticket content.

**Stop if:** a method starts accepting roles, plans, sessions, queue membership
assertions, or browser-supplied actor IDs. It accepts an `AccessContext` and
checks the authoritative resource.

### Task 5 — implement the staff queue as a repairable projection

**Goal:** Discover active work without pretending a cross-partition index is
atomic or authoritative.

**Allowed scope:** application, tests, `COLLECTIONS.md`, architecture/product
docs, and package README.

**Required layout and behavior:**

- declare `support-desk.queue-index.v1`;
- store one projection row per ticket, partitioned by ticket ID so no queue
  partition grows without bound;
- include ticket ID, projected revision, active/inactive state, status,
  priority, category, requester association, channel, assignee, and update
  time—never a message body or email address;
- expose projection by ticket ID only: every projector invocation loads the
  authoritative ticket immediately before deriving the entire row and never
  accepts a caller-supplied `Ticket` snapshot;
- after a successful ticket transaction, invoke that projector; its update
  accepts only a newer revision or an identical replay;
- never report an already committed ticket command as uncommitted because the
  projection write failed; log the safe failure, expose projection health, and
  let repair converge it;
- scan authoritative `support-desk.records.v1` ticket rows in a repeating,
  cursor-aware reconciliation worker so a crash between the ticket commit and
  projection write cannot hide work permanently;
- scan queue projections in bounded pages, confirm every candidate against the
  authoritative ticket, then filter and sort in application memory;
- configure hard maxima for physical rows scanned, pages scanned, and confirmed
  active rows materialized by one request; count every adapter-returned
  physical scan record before authoritative confirmation or application
  filtering, and fail the page safely on a codec error;
- if any maximum is reached before `nextCursor: null`, return an operational
  capacity error and metric with no partial queue result;
- persist the repair worker cursor at the host after each complete page;
- make an online queue read start at a null cursor, consume one complete scan
  cycle with request-local cursors, then filter and sort the bounded result;
- represent removal with an inactive revisioned row;
- use one configured terminal-retention cutoff in projection, repair, and
  sweeping: an authoritative resolved/closed ticket older than the cutoff
  causes the projector/repair worker to keep the projection absent or
  conditionally delete it, never recreate an inactive row;
- sweep an old inactive row only after reloading the authoritative ticket and
  confirming that it is still terminal and beyond that same cutoff, then use
  `deleteIfUnchanged`.

The queue may be briefly stale. It must converge after a complete
reconciliation cycle, may never authorize access, and may never return a row
without checking the ticket. Online staff requests do not scan the
heterogeneous authoritative collection; only the repair worker does.

**Tests that must exist:**

- a crash after ticket commit and before projection is repaired next cycle;
- projection failure does not roll back or duplicate the committed command;
- stale projection writes cannot overtake a newer revision;
- a delayed projector invocation after reclamation derives current
  authoritative state and cannot resurrect an old active/inactive snapshot;
- inactive and corrupted rows do not expose a ticket;
- every filter and both sort directions operate after authoritative
  confirmation;
- scan pages may repeat and are not ordered or snapshots;
- the repair cursor is persisted only after a whole page succeeds, while a
  queue request never reuses another request's cursor;
- physical-row, page, and active-result budgets each fail in a bounded,
  observable way without returning a partial queue;
- repair does not recreate a reclaimed terminal projection, and reopening a
  reclaimed ticket recreates an active projection;
- memory and real Azurite tests agree.

**Stop if:** queue correctness requires cross-collection atomicity, a
server-side query, or using the projection as permission/ownership evidence.

### Task 6 — close the host-neutral release candidate

**Status (Task 6):** Source complete in this repository: public composition
tests, host composition docs, release pack lane, and exact `0.1.0` package
versions. Registry publication and trusted-publisher configuration remain the
activation steps in `docs/RELEASING.md` before Tasks 7–8.

**Goal:** Produce a package release candidate that hosts can compose without
depending on unpublished filesystem paths.

**Required changes:**

- add public-entry-point integration tests for the complete customer and staff
  flows;
- add a tested example composition with a memory `Store`, synthetic
  `AccessContext` values, fixed `Clock`, fake mail provider, persisted worker
  cursor stub, and no framework;
- document error categories for host HTTP mapping without defining routes;
- document all host-owned schedulers: mail send, reconciliation, terminal
  sweep, customer-index prune, receipt sweeps, queue reconciliation, and queue
  inactive-row sweep;
- verify package contents with `npm pack --dry-run` for every workspace;
- complete the release security and documentation checklist that applies to
  the implemented surface;
- publish the first synchronized exact `0.x` package set before a host
  deployment depends on it.

Do not add Express, Hono, Astro, Auth0, Cloudflare, Azure, Resend, or another
provider to a published Support Desk package. Reference adapters used only by
tests remain root dev dependencies.

The host mapping contract is:

| Outcome                                                            | HTTP behavior                               |
| ------------------------------------------------------------------ | ------------------------------------------- |
| malformed command or identifier                                    | `400` with a stable host error code         |
| missing permission                                                 | `403`                                       |
| missing or non-owned ticket                                        | the same `404` response                     |
| command ID reused with different input or exhausted conflict retry | `409`                                       |
| subject/body shape exceeds its byte or character limit             | `413`                                       |
| per-principal ticket or per-ticket message capacity reached        | `409`                                       |
| durable request limit refused                                      | `429` with bounded `Retry-After`            |
| staff queue scan or materialization budget exhausted               | `503`; never return a partial queue         |
| required Store or provider dependency unavailable                  | `503`                                       |
| unexpected failure                                                 | content-free `500` plus safe correlation ID |

Never send raw exception messages, storage keys, email addresses, permission
sets, or provider diagnostics to a browser.

**Stop if:** a host would need an unpublished tarball, Git dependency, copied
source, or `file:` dependency. Finish the release lane first.

## Host work

Tasks 7 and 8 are separate pull requests in their respective host repositories.
They begin only after Task 6 publishes exact versions.

### Task 7 — retiregolden.org customer support

**Host responsibilities:**

- construct a namespaced Azure Tables `Store`;
- resolve the existing trusted session and current Authorization Core policy;
- grant customer permissions from the intended paid entitlements;
- apply durable principal-keyed create/reply limits before calling Support
  Desk;
- mint command, correlation, ticket, and message IDs on the server;
- configure the RetireGolden category allowlist, URLs, subject marker, and
  template pack;
- implement same-origin, CSRF-protected customer routes and pages;
- map missing or non-owned tickets to the same response;
- run all maintenance schedules with independently persisted cursors;
- add health and metrics without message content;
- document retention and staff access before production data is accepted.

The first RetireGolden pull request proves customer create/list/read/reply
against a durable store. Staff UI and mail provider activation are later host
pull requests; do not combine them with the storage wiring.

### Task 8 — pegma.dev feedback

**Host responsibilities:**

- construct a separate namespaced D1 `Store`;
- reuse the site's existing Identity, Sessions, Authorization, rate-limit,
  mail, logger, and health composition;
- grant customer permissions to authenticated accounts through pegma.dev
  policy defaults, not a fake paid entitlement;
- configure the five pegma.dev categories, `[PEG-…]` marker, links, and Pegma
  templates;
- add an authenticated feedback form and an own-ticket tracking page;
- use the existing same-origin Worker session and CSRF boundary;
- keep all submitted content private to the requester and authorized staff;
- run separate Support Desk mail and maintenance cursors from Identity mail
  cursors, even when both use the same provider account;
- prove the flow against real local D1 and the production-shaped Worker.

The public roadmap and GitHub issue tracker do not become ticket views. No
ticket is public merely because it describes an open-source project.

## Provider and production work

### Task 9 — staff surfaces

Build one small staff surface per host over Task 4 and Task 5 services. Reuse
UI behavior, not deployment state. The compose mode must make public reply and
internal note visually distinct and require an explicit selection. Do not
build a shared control plane.

### Task 10 — outbound provider operation

Each host supplies the provider adapter, credentials, sender domain, callback
verification, URL generation, cursor persistence, schedules, alerts, and
dead-letter acknowledgement. Support Desk continues to project exact
`@pegma/mail` state. Prove outage, ambiguous acceptance, late callback,
reconciliation, retry-generation, and poison-job recovery before activation.

### Task 11 — inbound mail

Implement this in Support Desk only after both authenticated web paths and
staff queues are operating. The task must include authenticated provider input,
bounded MIME normalization, opaque reply routing, threading indexes, the
reserved inbound receipt lifecycle, account-email matching as a host port,
unknown/ambiguous routing, bounce and auto-reply controls, and hostile-content
tests. Provider SDK and HTTP verification remain host adapters.

### Task 12 — first production-ready release

Complete retention, export, redaction, deletion, recovery, operational
dashboards, threat modeling, focused security review, upgrade notes, and
conformance documentation. Production readiness is an evidence gate, not just
a version number.

## Definition of launch complete

The initial buildout is complete only when:

- both hosts run the same exact published Support Desk versions;
- Azure and D1 host tests exercise the same public application contracts;
- authenticated users can create and track only their own tickets;
- authorized staff can work each isolated queue;
- internal notes are absent from every customer response and mail rendering;
- durable rate limits protect create and reply endpoints;
- state changes, Audit actions, and Mail actions share the ticket transaction;
- all worker cursors survive restarts and no cursor is shared between loops or
  instances;
- provider outage and duplicate delivery tests pass;
- retention, recovery, privacy, and operator procedures exist for each host;
- no host imports a Support Desk internal module or reads a Support Desk
  collection directly from an HTTP controller.
