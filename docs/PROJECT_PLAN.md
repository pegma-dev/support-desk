# Support Desk Project Plan

## Status

**Stage:** The customer-facing Phase 1/2 application slice and the source
portion of Phase 6 are implemented. Phase 2 abuse limits and all deployment
phases remain open; every `@pegma/support-desk-*` package is unpublished.

**Initial reference application:** RetireGolden

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
rather than a bespoke access package. The planned EntitleKit access adapter was
removed on 2026-07-26; EntitleKit is now Authorization Core.

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
- Customer commands are idempotent by command ID and a SHA-256 request
  fingerprint. Reply transactions use an opaque version read immediately
  before the transaction and retry conflicts without losing messages.
- Subject and message-body size limits are configurable application seams.
  Durable rate limiting remains intentionally pending integration with
  `@pegma/rate-limit`; this repository does not build a private limiter.
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
and no package is published before Phase 8.

## Vision

Support Desk will be a composable open-source customer-support system that
begins with trustworthy tickets and email, then grows into a reviewed knowledge
pipeline and responsible AI assistance.

The system should be useful to a small SaaS with one support person while
preserving the boundaries needed by a larger support team:

- customers can move between web and email without splitting the conversation;
- staff work one auditable queue;
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
- [ ] Validate the contracts against RetireGolden's intended support flow

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
- Define read paths that are key lookups or whole-partition reads, and
  maintain an explicit index collection wherever a second access path is
  needed.
- Add structured audit events written in the same transaction as the state
  change they describe.

**Exit criterion:** A test API running on the storage-core in-memory `Store`
can create and update tickets concurrently without lost updates, duplicate
messages, or provider dependencies.

### Phase 2 — Authorization Core access and customer ticket API

**Goal:** Let authorized paid customers exercise ticket operations end-to-end
against reference adapters.

- Consume `@pegma/authorization-core` permissions and `@pegma/spine`
  `PrincipalId` values.
- Map RetireGolden paid entitlements to `support.ticket.create` in RetireGolden
  policy, not here.
- Add create, list, read, and reply endpoints.
- Enforce permission plus requester ownership.
- Add rate and size limits.

**Exit criterion:** Against the in-memory `Store`, a paid customer can work
only their own tickets, an unpaid account cannot open a gated web ticket, and
authorization tests cover cross-account access attempts.

### Phase 3 — durable deployment

**Goal:** Run the reference API against a durable `Store` supplied by the host.

- Measure access patterns from the reference API and its tests, and confirm
  every one of them is a key read, a partition read, or a maintained index.
- Select the storage-core adapter the reference deployment will use and let the
  host construct the `Store`.
- Document provisioning, namespace binding, and configuration for the reference
  deployment.
- Report any expressiveness gap to `storage-core` as a conformance case rather
  than working around it here.

**Exit criterion:** The reference API runs unchanged against a durable `Store`
with no lost updates under concurrent load and no Support Desk code that knows
which backend it is.

### Phase 4 — customer web experience

**Goal:** Let paid customers use Support Desk through retiregolden.org.

- Add customer-facing UI within the existing site.
- Add safe message rendering.
- Verify abuse limits end-to-end.
- Launch to paid customers.

**Exit criterion:** A paid customer can create, follow, and reply to their own
tickets on retiregolden.org backed by a durable `Store`.

### Phase 5 — staff queue

**Goal:** Provide the minimum useful central operator experience.

- Add queue read and detail endpoints backed by partition reads and the queue
  index collection.
- Add Support and Admin permission integration.
- Apply status, priority, association, and assignee filtering in the
  application after reading a partition, and add an index collection for any
  access path a partition read cannot serve at the expected queue size.
- Implement public replies and internal notes.
- Implement assignment, priority, resolution, closure, and reopening.
- Add safe audit views.
- Add basic operational metrics without message content.

**Exit criterion:** One or more authorized staff members can work the queue
without direct database or mailbox access, and internal notes never reach
customers.

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

### Phase 8 — production hardening and first public release

**Goal:** Operate the core ticket system safely at modest production volume.

- Complete a threat model and focused security audit.
- Add retention, export, redaction, and deletion workflows.
- Add queue and delivery health dashboards.
- Test provider outage and poison-message recovery.
- Document backup and restore expectations for the host-supplied `Store`.
- Publish mail and template adapter conformance tests. Storage conformance
  belongs to `storage-core`.
- Document installation and provider integration.
- Configure npm publishing access and publish signed packages with provenance.
- Release the first useful `0.x` version.

**Exit criterion:** The RetireGolden deployment has documented recovery,
privacy, and incident procedures and can be installed from public
documentation.

### Phase 9 — attachments and operational features

**Goal:** Add features only after the message path is stable.

Candidate work:

- attachment upload and inbound extraction;
- isolated object storage and authorized downloads;
- type and size policies plus malware scanning;
- response templates or macros;
- tags and categories;
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
- mail adapter guide;
- template and branding guide;
- security model and deployment checklist;
- RetireGolden reference integration;
- complete local example with synthetic data;
- migration and upgrade policy.

## Open questions

These should be resolved through the reference implementation:

- Which partition layout keeps every transaction inside one collection and one
  partition while keeping queue reads a sensible size?
- Which secondary access paths justify a maintained index collection, and which
  are better served by filtering a partition read in the application?
- Should ticket numbers be global, tenant-scoped, or channel-scoped, given that
  minting one is a `transact` on whatever partition holds the counter?
- Which inbound and outbound mail provider offers the simplest reliable
  reference adapter?
- Should matched-email tickets appear in an authenticated account only after a
  separate verification or customer claim flow?
- How long should resolved tickets remain reopenable by email?
- Should internal notes and assignment changes update the customer-visible
  last-updated time, or only staff queue ordering?
- Which template format is expressive enough without becoming executable code?
- What retention period is appropriate for sensitive support conversations?
- When is a separate Support Desk deployment operationally worthwhile?

## Near-term backlog

1. Build the Phase 3 durable reference deployment against a host-supplied
   `Store` and run the existing application/mail suite without backend-aware
   Support Desk code.
2. Build the Phase 4 customer web experience against the implemented
   authorized customer services.
3. Build the Phase 5 staff queue and internal-note boundary.
4. Select and operate an outbound provider at the host composition root,
   exercising Support Desk's projection over published `@pegma/mail`,
   persisted cursors, callbacks, and dead-letter acknowledgement in the
   durable deployment.
5. Implement Phase 7 inbound mailbox verification, normalization, threading,
   deduplication, and bounce/auto-reply controls.
6. Begin Phase 8 release hardening only after the deployed phases provide
   recovery, privacy, retention, and operational evidence.

The backlog should remain intentionally small until the first integration
reveals which abstractions are reusable.
