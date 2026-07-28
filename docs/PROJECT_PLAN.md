# Support Desk Project Plan

## Status

**Stage:** The customer-facing Phase 1/2 application slice and the source
portion of Phase 6 are implemented. Ecosystem alignment, staff services,
host-applied abuse limits, and every deployment phase remain open; every
`@pegma/support-desk-*` package is unpublished.

**Initial reference applications:** retiregolden.org for paid customer support
on Azure, and pegma.dev for authenticated product feedback on Cloudflare. The
two hosts compose isolated Support Desk instances; shared packages do not imply
shared data or a multi-tenant service.

**License:** MIT

**Naming:** This project was developed under the `@support-desk` scope. On
2026-07-26 it moved into the Pegma component ecosystem, publishing under
`@pegma` as `@pegma/support-desk-*`. The git history begins at that move, and
nothing was ever published under the former name.

**Persistence:** Support Desk does not build a storage layer. It declares
collections against
[`@pegma/storage-core`](https://github.com/pegma-dev/storage-core) (published
`0.4.0`) and takes a `Store` from the host. The planned storage-port and Azure
adapter packages were removed on 2026-07-26; a durable deployment supplies a
`Store` rather than another adapter package here. If storage cannot express
something Support Desk needs, that is a gap to fix in `storage-core` with
conformance cases, not to work around here.

**Access:** Permissions come from
[`@pegma/authorization-core`](https://github.com/pegma-dev/authorization-core)
rather than a bespoke access package. Buildout Task 1 upgrades the repository's
current exact `0.1.0` dependency to the next planned exact target, `0.1.2`. The
planned EntitleKit access adapter was removed on 2026-07-26; EntitleKit is now
Authorization Core.

**Audit:** Durable accepted-change records come from
[`@pegma/audit`](https://github.com/pegma-dev/audit) and are embedded in the
ticket partition. Buildout Task 1 adds the next planned exact dependency,
`0.1.0`, and replaces the current pre-release private audit-row shape before
staff commands are added.

**Shared types:** `PrincipalId`, the clock, the logger, and typed event
definitions come from [`@pegma/spine`](https://github.com/pegma-dev/spine).
Support Desk does not redeclare them.

The project starts as embedded TypeScript packages and a reference
implementation. It may become independently deployable later, but the MVP
should not introduce another always-on service merely to separate repositories.

### Implementation status (2026-07-28)

The repository now proves the customer-facing Phase 1/2 application slice and
the provider-neutral Phase 6 outbound-mail integration:

- `@pegma/support-desk-application` declares one authoritative heterogeneous
  collection whose ticket, messages, audit events, command receipts, and
  delivery jobs share the ticket partition. Customer create and reply commit
  their complete record set in one transaction.
- Create, list, read, and reply consume an Authorization Core
  `AccessContext`, require Support Desk's exact permission names, and confirm
  requester ownership against the authoritative ticket rather than trusting
  the principal index.
- The current pre-release customer methods still expose the authoritative
  `Ticket` shape, including staff metadata. Buildout Task 2 replaces that with
  explicit safe customer DTOs and a customer-visible update timestamp before
  any host route is built.
- Customer commands are idempotent by command ID and a SHA-256 request
  fingerprint. Reply transactions use an opaque version read immediately
  before the transaction and retry conflicts without losing messages.
- Subject and message-body size limits are configurable application seams.
  Durable request limiting remains host composition work using published exact
  `@pegma/rate-limit@0.1.0`; this repository does not build a private limiter.
- `@pegma/support-desk-templates` implements immutable versioned templates,
  explicit variable allowlists, HTML-context escaping, and synthetic preview.
  The RetireGolden-branded pack is a separate export from the generic renderer.
- `@pegma/support-desk-application` consumes published exact `@pegma/mail`
  `0.1.0`. Its projection keeps generic mail state in Support Desk's existing
  `delivery:*` rows, while immutable template, subject, and `Message-ID`
  metadata stays on the causal message record in the same ticket transaction.
- The generic worker discovers committed jobs with Storage Core's bounded
  authoritative collection-wide scan. Hosts persist send and reconciliation
  cursors independently after each complete page. Physical keys, conditional
  claims, submission generations, and provider idempotency keys remain
  authoritative.

Phases 3, 4, and 5 are not complete. There is no durable reference deployment,
customer web UI, or staff queue/API in this repository yet. Phase 6 source is
implemented, but selecting and operating a provider adapter remains host work,
and no package is published yet. The ordered implementation handoff is
[`BUILDOUT.md`](BUILDOUT.md); it must be followed one task and one pull request
at a time.

## Vision

Support Desk will be a composable open-source customer-support system that
begins with trustworthy tickets and email, then grows into a reviewed knowledge
pipeline and responsible AI assistance.

The system should be useful to a small SaaS with one support person while
preserving the boundaries needed by a larger support team:

- customers can move between web and email without splitting the conversation;
- staff work one auditable queue per isolated host instance;
- hosts choose identity, billing, and mail providers, supply permissions
  through Authorization Core, and supply a storage-core `Store`;
- unknown prospective customers can still reach support;
- solved conversations can improve future self-service without exposing private
  customer data.

## Product principles

1. **Simple operations first.** One queue and a few explicit statuses before
   SLAs, macros, automation, and analytics.
2. **Known and unknown requesters coexist safely.** Unknown email belongs in
   the staff queue, not in an authenticated customer account.
3. **Messages are channel-neutral.** Web and email are transports for one
   conversation model.
4. **Authorization is external and explicit.** Support Desk consumes
   permissions from `@pegma/authorization-core` and `PrincipalId` values from
   `@pegma/spine`. It has no access model of its own.
5. **Persistence is external and declared.** Support Desk declares collections
   against `@pegma/storage-core` and takes a `Store`. It has no storage layer
   of its own.
6. **Delivery is asynchronous and idempotent.** Provider retries and outages do
   not duplicate or lose messages.
7. **Sensitive by default.** Assume customers will send information they should
   not have sent.
8. **AI earns responsibility gradually.** Retrieval and drafts precede
   customer-visible automation or account actions.
9. **Reuse code, isolate deployments.** RetireGolden and pegma.dev use the same
   packages with separate stores, queues, mail channels, policies, secrets,
   cursors, and retention rules. Multi-tenancy is not an MVP shortcut.

## Repository strategy

The project remains a monorepo until contracts stabilize.

| Package                           | Responsibility                                         | Earliest phase |
| --------------------------------- | ------------------------------------------------------ | -------------- |
| `@pegma/support-desk-contracts`   | Ticket, message, event, and adapter contracts          | Foundation     |
| `@pegma/support-desk-core`        | Pure creation and lifecycle transitions                | Foundation     |
| `@pegma/support-desk-application` | Authorized use cases, declared collections, and outbox | Phase 1        |
| `@pegma/support-desk-templates`   | Safe, versioned notification rendering                 | Phase 6        |
| `@pegma/support-desk-knowledge`   | Reviewed knowledge-item pipeline                       | Phase 10       |

Packages publish under the `@pegma` scope, one repository per Pegma component.
They should be created only when implementation begins and remain unpublished
until the applicable release criteria are met.

There is deliberately no storage package and no Azure package. Persistence is
`@pegma/storage-core`: the application package declares its collections and
receives a `Store`, and a durable deployment is a `Store` the host constructs.
There is likewise no access package. Permissions come from
`@pegma/authorization-core`, and shared identity, clock, logging, and event
types come from `@pegma/spine`.

## Delivery phases

These phases group product outcomes; they are not the safe commit order. Phase
6 source already preceded Phases 3–5. Follow `BUILDOUT.md` for dependency order,
including the early exact package release required before either separate host
repository can consume Support Desk without an unpublished dependency.

### Foundation — repository and domain core

**Goal:** Establish project boundaries and executable workflow behavior.

- [x] MIT license
- [x] Node.js and TypeScript workspace
- [x] Provider-neutral ticket and message contracts
- [x] Ticket creation and revisioned state transitions
- [x] Requester association states
- [x] Workflow and rejection tests
- [x] MVP, architecture, security, and contribution documentation
- [x] CI, dependency updates, and CodeQL
- [ ] Validate the contracts against both launch profiles in `BUILDOUT.md`

**Exit criterion:** Tests can represent an authenticated web ticket, an
unverified email ticket, staff replies, customer follow-up, assignment,
resolution, closure, and reopening without importing provider SDKs.

### Phase 1 — application services and declared collections

**Goal:** Make ticket behavior durable and safe under concurrency and retries
without building a storage layer here.

- Define authorized application-service ports.
- Declare the ticket, message, event, inbound-receipt, and outbox collections
  against `@pegma/storage-core`, and take a `Store` from the host.
- Choose partition keys deliberately: everything one transaction must change
  together has to share one collection and one partition.
- Implement optimistic concurrency with `update` and a decider that re-runs on
  every conflict, plus `putIfUnchanged` where the version came from an earlier
  request.
- Implement idempotency for customer commands and provider events with
  `insertIfAbsent` keyed by the external identifier.
- Define customer/detail reads as key lookups or whole-partition reads. A
  second access path is an explicit bounded projection with authoritative
  confirmation and a cursor-aware repair loop.
- Add structured audit events written in the same transaction as the state
  change they describe.

**Exit criterion:** A test API running on the storage-core in-memory `Store`
can create and update tickets concurrently without lost updates, duplicate
messages, or provider dependencies.

### Phase 2 — Authorization Core access and customer ticket API

**Goal:** Let authorized authenticated requesters exercise ticket operations
end-to-end against reference adapters.

- Consume `@pegma/authorization-core` permissions and `@pegma/spine`
  `PrincipalId` values.
- Map RetireGolden paid entitlements to `support.ticket.create` in RetireGolden
  policy, not here.
- Grant pegma.dev's authenticated accounts the same exact customer permissions
  through pegma.dev policy defaults, not a fake paid entitlement.
- Add create, list, read, and reply endpoints.
- Enforce permission plus requester ownership.
- Apply published `@pegma/rate-limit` at each host's HTTP boundary and retain
  Support Desk's own size and per-principal/ticket storage bounds.

**Exit criterion:** Against the in-memory `Store`, both host policy profiles
can work only their own tickets, an unpaid RetireGolden account cannot open a
gated web ticket, an authenticated pegma.dev account can submit feedback, and
authorization tests cover cross-account access attempts.

### Phase 3 — durable deployment

**Goal:** Run the same application contracts against durable `Store` instances
supplied by both hosts.

- Measure access patterns from the reference API and its tests, and confirm
  every one of them is a key read, a partition read, or a maintained index.
- Use Azure Tables for retiregolden.org and D1 for pegma.dev, with each host
  constructing and namespacing its own `Store`.
- Document provisioning, namespace binding, and configuration for the reference
  deployment.
- Report any expressiveness gap to `storage-core` as a conformance case rather
  than working around it here.

**Exit criterion:** The same public application tests run against the Azure and
D1 compositions with no lost updates under concurrent load and no Support Desk
code that knows which backend it is.

### Phase 4 — customer web experience

**Goal:** Let authenticated users use Support Desk through both launch hosts.

- Add paid-customer support UI within retiregolden.org.
- Add authenticated feedback, bug, feature-request, documentation, and question
  submission and tracking within pegma.dev.
- Add safe message rendering.
- Verify abuse limits end-to-end.
- Keep tickets private; pegma.dev feedback is not automatically a public
  roadmap item or GitHub Issue.

**Exit criterion:** An eligible RetireGolden customer and an authenticated
pegma.dev user can each create, follow, and reply to their own tickets in
separate durable instances.

### Phase 5 — staff queue

**Goal:** Provide the minimum useful per-instance operator experience.

- Add detail endpoints and a bounded, scanned queue projection that is repaired
  from authoritative ticket rows.
- Add Support and Admin permission integration.
- Apply status, priority, category, association, channel, and assignee filtering
  only after the projection row is confirmed against the authoritative ticket.
- Implement public replies and internal notes.
- Implement assignment, priority, resolution, closure, and reopening.
- Add safe audit views.
- Add basic operational metrics without message content.

**Exit criterion:** Authorized staff can work each host's isolated queue
without direct database or mailbox access, projection gaps converge after a
complete repair cycle, and internal notes never reach customers.

### Phase 6 — outbound email and branded templates

**Goal:** Notify customers and staff without coupling to one mail provider.

- Define mail-delivery and callback ports.
- Consume published exact `@pegma/mail@0.1.0` for delivery state, workers,
  authenticated callback application, and terminal sweeping.
- Implement outbox-backed delivery jobs, writing the state change and its
  outbox record in one `transact` call on the ticket's partition.
- Create versioned plain-text and HTML templates.
- Add a safe variable allowlist and template preview.
- Add stable ticket subject markers and web links.
- Generate and store outbound `Message-ID` metadata.
- Add delivery callbacks, bounded retry, and dead-letter handling.
- Supply a RetireGolden-branded template pack outside the generic core.
- Supply a Pegma-branded template pack and keep both packs outside the generic
  renderer.

**Exit criterion:** Ticket creation and replies succeed even during a mail
provider outage, and retries do not duplicate customer messages.

### Phase 7 — inbound support mailbox

**Goal:** Turn direct and reply email into safe queue messages.

- Select an inbound mail provider for the reference deployment.
- Verify provider events and constrain payload size.
- Normalize MIME into canonical message content.
- Implement opaque reply routing and standards-based threading headers.
- Add subject marker fallback without treating ticket numbers as secrets.
- Deduplicate provider retries and external message IDs.
- Add account-email matching as a host port.
- Route unmatched and ambiguous senders to the low-priority unverified queue.
- Detect bounces, delivery failures, and auto-reply loops.

**Exit criterion:** Replies join the correct ticket, direct unknown mail creates
one unverified ticket, duplicate deliveries are harmless, and email matching
cannot grant website access.

### Phase 8 — release and production hardening

**Goal:** Operate the core ticket system safely at modest production volume.

- Complete a threat model and focused security audit.
- Add retention, export, redaction, and deletion workflows.
- Add queue and delivery health dashboards.
- Test provider outage and poison-message recovery.
- Document backup and restore expectations for the host-supplied `Store`.
- Publish mail and template adapter conformance tests. Storage conformance
  belongs to `storage-core`.
- Document installation and provider integration.
- Configure npm publishing access and publish a signed exact `0.x` package set
  with provenance before either host deployment depends on it.
- Do not make a host use a Git branch, copied source, local path, or unpublished
  tarball as its production dependency.

**Exit criterion:** Both launch deployments have documented recovery, privacy,
and incident procedures and install exact public versions from public
documentation.

### Phase 9 — attachments and operational features

**Goal:** Add features only after the message path is stable.

Candidate work:

- attachment upload and inbound extraction;
- isolated object storage and authorized downloads;
- type and size policies plus malware scanning;
- response templates or macros;
- tags and category changes beyond the launch allowlists;
- collision indicators for staff;
- configurable queue routing;
- business hours and simple response targets;
- customer satisfaction collection;
- additional mail adapters.

Each capability needs its own acceptance criteria and security review. This
phase is intentionally not one large release.

### Phase 10 — knowledge pipeline

**Goal:** Convert recurring solved problems into reviewed, reusable knowledge.

- Define knowledge-item contracts and provenance.
- Select eligible resolved tickets.
- redact customer and account-specific information;
- cluster recurring questions;
- draft articles or approved answers;
- require human review and publication;
- version and retire knowledge items;
- measure whether articles actually resolve future questions.

Raw solved tickets remain private. Public knowledge is a separate reviewed
artifact.

**Exit criterion:** A reviewer can publish a useful answer derived from solved
tickets without exposing personal data or treating model output as fact.

### Phase 11 — AI assistance

**Goal:** Reduce repetitive support work while retaining human control.

Progression:

1. Staff-only ticket summary.
2. Knowledge retrieval for staff.
3. Staff-only reply draft with citations to approved knowledge.
4. Customer self-service retrieval before ticket creation.
5. Carefully evaluated customer-visible generation.
6. Separately authorized, user-approved product actions if ever justified.

Required foundations:

- redaction and data-classification rules;
- provider and retention decisions;
- prompt-injection and tool-authorization boundaries;
- evaluation sets from synthetic and approved historical cases;
- hallucination and escalation measurements;
- model and prompt version audit;
- clear handoff to a human;
- per-action permission and confirmation.

**Exit criterion:** AI measurably reduces support work without increasing
privacy incidents, incorrect resolutions, or barriers to human help.

### Stable `1.0`

`1.0` requires:

- at least two real host applications or one host plus an independent adapter;
- stable ticket, message, and mail contracts, and stable declared collections;
- upgrade and migration documentation;
- mail and template adapter conformance suites;
- a published threat model and completed security review;
- semantic-versioning and deprecation policies;
- production evidence that retry, deduplication, authorization, and retention
  behave as documented.

## RetireGolden integration decisions

The RetireGolden host owns:

- Auth0 session validation;
- Stripe-derived paid entitlements;
- Authorization Core policy and permission resolution;
- Pro and Advisor support eligibility;
- staff role assignment;
- initial routing and priority policy;
- brand assets and template content;
- the `@pegma/storage-core` `Store` and the resources behind it;
- the `support@retiregolden.org` mailbox;
- privacy and retention policy;
- any retirement-specific ticket categories or knowledge.

Support Desk owns generic ticket, message, queue, channel, and adapter behavior.

## pegma.dev integration decisions

The pegma.dev host owns:

- first-party Identity verification and server-side Sessions resolution;
- Authorization Core policy that grants customer permissions to authenticated
  accounts without inventing a paid entitlement;
- staff role assignment;
- the D1-backed `@pegma/storage-core` `Store` and a Support Desk-only namespace;
- durable `@pegma/rate-limit` policies at create and reply endpoints;
- Pegma brand assets, template content, URLs, and the `[PEG-…]` subject marker;
- the feedback, bug, feature-request, documentation, and question category
  allowlist;
- provider credentials, callbacks, worker schedules, and Support Desk-specific
  cursors that are not shared with Identity mail;
- privacy and retention policy for submitted feedback.

pegma.dev tickets remain private conversations. Publication to the roadmap,
documentation, or GitHub Issues is a later explicit staff action with
redaction and confirmation, never an automatic side effect.

The two launch hosts do not share a Store, ticket-number counter, queue,
mailbox, template activation, authorization cache, retention job, or worker
cursor. A unified operator surface is deferred until it can be designed as a
separately authorized service rather than as accidental multi-tenancy.

## Security milestones

Before web production:

- cross-account authorization tests;
- safe Markdown/text rendering;
- rate and size limits;
- audit logging without conversation content;
- documented retention baseline.

Before inbound email:

- provider signature verification;
- MIME parser limits;
- duplicate and replay tests;
- reply-token threat analysis;
- auto-reply and bounce-loop controls.

Before attachments:

- isolated storage origin;
- scan and quarantine workflow;
- authorized download design;
- preview isolation;
- deletion and expiration behavior.

Before AI:

- data inventory and provider assessment;
- redaction pipeline;
- prompt-injection threat model;
- evaluation and rollback plan;
- human escalation guarantee.

## Documentation deliverables

Before the first public package release:

- installation guide;
- data model and API reference;
- host wiring guide covering the `Store`, the permission source, and the clock;
- declared-collection reference: partitions, keys, and codecs;
- template and branding guide;
- complete local example with synthetic data;
- migration and upgrade policy.

Before the first production-ready release:

- mail adapter and worker-operations guide;
- security model and deployment checklist;
- RetireGolden and pegma.dev reference integrations;
- retention, recovery, export, redaction, and deletion procedures;
- provider outage and poison-message recovery evidence.

## Open questions

These should be resolved through the two reference implementations:

- Which inbound and outbound mail provider offers the simplest reliable
  RetireGolden adapter? pegma.dev already proves outbound Resend composition,
  but provider choice remains a host decision rather than a Support Desk
  contract.
- Should matched-email tickets appear in an authenticated account only after a
  separate verification or customer claim flow?
- How long should resolved tickets remain reopenable by email?
- What retention period is appropriate for sensitive support conversations?
- Which evidence would justify a separately deployed, multi-host Support Desk
  service instead of the two isolated embedded instances?

## Near-term backlog

Execute [`BUILDOUT.md`](BUILDOUT.md) in order:

1. align with Audit and current Authorization Core;
2. finish the dual-host customer contract;
3. own instance-scoped ticket-number reservation;
4. implement staff detail and mutation services;
5. implement the staff queue as a repairable projection;
6. close the host-neutral release candidate;
7. integrate retiregolden.org customer support;
8. integrate pegma.dev feedback;
9. build the two isolated staff surfaces;
10. operate each host's outbound provider;
11. implement inbound mail;
12. complete the first production-ready release.

One numbered Buildout task is one pull request. Do not parallelize adjacent
tasks that change the same public contract or durable record union.
