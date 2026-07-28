# Support Desk Architecture

## Architectural style

Support Desk starts as an embedded set of TypeScript packages plus reference
compositions. The host application owns deployment, authentication, policy,
provider credentials, the `Store`, and product-specific configuration.

Support Desk is one component of **Pegma**, a family of MIT-licensed packages a
host composes. The ecosystem boundaries below are not Support Desk's to design:

- persistence is
  [`@pegma/storage-core`](https://github.com/pegma-dev/storage-core);
- permissions are
  [`@pegma/authorization-core`](https://github.com/pegma-dev/authorization-core);
- `PrincipalId`, the clock, the logger, and typed event definitions are
  [`@pegma/spine`](https://github.com/pegma-dev/spine).
- accepted-change audit records are
  [`@pegma/audit`](https://github.com/pegma-dev/audit);
- provider-neutral outbound delivery state is
  [`@pegma/mail`](https://github.com/pegma-dev/mail).

The architecture uses ports and adapters for what remains:

```text
                         ┌──────────────────────┐
Web/API controllers ───>│ Application services │<── Inbound mail worker
                         └──────────┬───────────┘
                                    │
                   ┌────────────────┼─────────────────┐
                   ▼                ▼                 ▼
             Ticket core      Authorization     Template service
                   │               Core                │
                   ▼                                   ▼
       Declared collections on               Mail delivery port
       a storage-core Store
```

No provider SDK types cross into the core contracts.

### Launch composition

retiregolden.org and pegma.dev embed the same published Support Desk packages
as two isolated instances. RetireGolden supplies Azure Tables, its existing
verified session and paid-entitlement policy, RetireGolden templates, and its
mail channel. pegma.dev supplies D1, its existing Identity/Sessions and
Authorization composition, Pegma templates, and its own mail channel.

They do not share a `Store`, namespace, ticket-number counter, queue, mailbox,
authorization cache, retention job, secret, or worker cursor. This proves
portability across Azure and Cloudflare without adding `tenantId` to every
contract or creating an always-on Support Desk service.

Both initial web entry points are authenticated. Unknown requesters enter
through verified inbound email later; anonymous browser submission is not part
of the first launch.

## Modules

### Contracts

Shared ticket, requester, message, event, and adapter types. Contracts are
JSON-compatible where practical so other languages can implement compatible
services later.

Contracts do not redeclare anything the ecosystem already names. `PrincipalId`,
`IsoTimestamp`, `Clock`, `Logger`, and event definitions are imported from
`@pegma/spine`, so a principal resolved by Authorization Core is the same value
Support Desk stores, authorizes, and audits.

### Core

Pure ticket creation and state transitions. Core functions:

- do not perform I/O;
- do not authenticate or authorize;
- do not send email;
- do not choose business-specific priorities;
- do not parse MIME;
- return deterministic state for the same input.

### Application services

Use cases coordinate authorization, storage, ticket revisions, messages, audit
events, and delivery jobs:

- create customer ticket;
- append customer message;
- list owned tickets;
- read the staff queue;
- append staff reply or note;
- assign and change state;
- ingest inbound email;
- deliver and track notifications.

### Permissions

Permissions come from `@pegma/authorization-core`. Support Desk asks whether a
`PrincipalId` holds a named permission; it does not model roles, plans,
entitlements, or policy, and it does not define an access port of its own.
Support Desk is a permission consumer, and its permission names are part of its
public contract.

The application service performs resource checks in addition to permission
checks. `support.ticket.read.own` alone never proves that a ticket belongs to
the principal.

Sessions and identity remain outside this boundary. A host resolves a trusted
session to `PrincipalId`, loads trusted role and entitlement facts, resolves an
`AccessContext`, and only then calls Support Desk. RetireGolden may grant create
from a paid entitlement while pegma.dev grants it as an authenticated-user
default; Support Desk sees only the resulting permission.

### Audit

Support Desk embeds `@pegma/audit`'s event in its heterogeneous ticket record
union and drops Audit's transaction action into the same ticket transaction as
the accepted state change. Audit owns no collection or Store, so this preserves
single-partition atomicity.

The pure core `TicketEvent` and durable `AuditEvent` are different concepts.
The first asks the workflow to transition. The second records that an
authorized, idempotent command was accepted. Support Desk must not maintain a
parallel private audit event shape.

### Abuse limits

Support Desk enforces record-shape and per-principal/ticket capacity limits.
Each host applies exact `@pegma/rate-limit` durable policies at its HTTP
boundary before expensive create and reply commands. The limiter key and
policy are host concerns; neither package owns HTTP middleware.

### Persistence

Support Desk does not implement storage. It declares collections against
`@pegma/storage-core` and receives a `Store` from the host, which decides what
is behind it. The available surface, and therefore the whole design space, is:

- `get` and `getVersioned` for one key;
- `insertIfAbsent`, the deduplication primitive for anything keyed by an
  external identifier;
- `put` for an unconditional whole-record write;
- `update(key, decide)`, which reads, decides, and writes atomically and
  **re-runs the decider against freshly read state on every conflict** — so
  every rule that depends on the current record belongs inside the decider,
  not around the call;
- `putIfUnchanged(value, version)` and `deleteIfUnchanged(key, version)` for a
  version read in an earlier request, which `update` cannot express because its
  decider sees the record but never the version;
- `list(partition)` and `listVersioned(partition)`, in unspecified order;
- bounded collection-wide `scan({ limit, cursor })`, with an opaque
  continuation and no filter, order, or snapshot guarantee;
- `delete(key)`;
- `transact(partition, actions)`, all of the actions or none.

Two limits are deliberate rather than temporary, and the design has to live
inside them:

- **No cross-partition atomicity.** A transaction covers exactly one collection
  and one partition. Anything that must commit together has to be co-located by
  the partition key, which makes partition choice a design decision rather than
  an implementation detail.
- **No version-conditional delete inside a transaction.** A conditional removal
  is expressed as a `putIfUnchanged` to a tombstone the codec understands.

Records are written whole; there is no partial merge. Codecs own the schema, so
nested objects, dates, and enums are Support Desk's business, not storage's.

If something genuinely cannot be expressed here, the fix is a conformance case
in `storage-core`, not a private persistence layer in this repository.

### Reads

There is no server-side filtering, ordering, or secondary index. Customer and
ticket-detail reads use one key or one whole partition, and a listed partition
is not a snapshot. Bounded collection-wide `scan` is reserved for repeating
workers and the staff queue's repairable projection; it is not a hidden query
language.

That has three consequences the design must respect:

1. A partition is sized by what a single read can reasonably return. A
   partition that grows without bound is a design error, not a scaling problem
   to solve later.
2. Filtering by status, priority, association, channel, or assignee happens in
   the application after a partition read.
3. Any access path a partition read cannot serve is a **maintained projection
   collection**. A different collection cannot share the ticket transaction,
   so Support Desk invokes projection by ticket ID after commit and repairs it
   from a repeating authoritative scan. The projector reloads current
   authoritative state rather than accepting a ticket snapshot, and revision
   fences prevent an old row from overtaking a new one. A projection is always
   a hint confirmed against the authoritative record, never authorization or
   ownership evidence.

A failed projection attempt is logged and reflected in projection health but
does not turn the already committed ticket command into a failure. Idempotent
command replay and the repair loop make recovery safe.

The initial staff queue stores one projection row partitioned by ticket ID and
uses a bounded collection-wide scan. It confirms every candidate ticket before
filtering and sorting in application memory. Separate configured maxima bound
physical rows, scan pages, and confirmed active results; every adapter-returned
physical record counts before authoritative confirmation or application
filtering, a codec failure aborts safely, and exhausting any budget returns no
partial result. A dedicated repair loop scans authoritative ticket rows and
converges any write missed between the ticket commit and projection update. The
repair cursor is host-persisted after complete pages. An online queue read
starts from a null cursor and consumes one complete projection scan with
request-local cursors only while all budgets hold; it never resumes another
request's scan.

Projection, repair, and inactive-row sweeping share one terminal-retention
cutoff. An authoritative resolved/closed ticket beyond it causes queue state to
remain absent or be deleted conditionally, not recreated as another inactive
row. A sweep reloads the ticket before deletion. A delayed projector also
reloads current state, so it cannot resurrect an old snapshot after
reclamation; a genuine later reopen recreates an active row.

Retention and deletion are sweeps: enumerate with `listVersioned` or a bounded
authoritative scan, then `deleteIfUnchanged` each record with the version that
enumeration returned, so a record that became live again before removal is left
alone.

### Mail ingestion adapter

The adapter verifies provider authenticity, constrains MIME parsing, normalizes
content, extracts threading metadata, and returns provider-neutral input.
Ticket matching and account association happen in application services under
explicit policy.

Support Desk's inbound receipts are not replaced with `@pegma/webhooks`.
Webhooks deliberately provides sequential deduplication while allowing
overlapping deliveries to process concurrently; inbound mail needs a
channel-bound processing reservation, external message binding, and a durable
ticket/message result that a retry can return.

Potential providers should be evaluated later; the core will not select one.

### Outbound mail projection

Support Desk consumes exact `@pegma/mail`. It projects generic mail jobs into
its ticket record union, resolves immutable rendered content from the causal
message, and delegates claims, submission generations, retries,
reconciliation, acknowledgements, and terminal states to Mail. Provider
adapters, credentials, authenticated callbacks, sender domains, and schedules
remain host concerns.

### Template service

Templates are versioned and branded by the host. Rendering:

- accepts only documented variables;
- escapes by output context;
- produces plain-text and HTML alternatives;
- records the template ID and version used;
- supports preview with synthetic data;
- does not execute arbitrary user code.

### Knowledge pipeline

Resolved tickets are not automatically public knowledge. A later pipeline may:

1. select eligible resolved tickets;
2. remove or mask personal and account-specific information;
3. group recurring problems;
4. draft an article or answer;
5. require human review;
6. publish a versioned knowledge item;
7. retain traceability to approved sources without exposing them to customers.

### AI assistant

AI is a consumer of reviewed knowledge and permitted product context, not a
privileged bypass around authorization.

The first AI capabilities should be retrieval, summarization, and staff-only
drafting. Customer-visible generation and tool execution require separate
approval, evaluation, audit, prompt-injection defenses, and data-processing
decisions.

## Persistence model

Support Desk uses current-state records plus append-only supporting records. It
does not require full event sourcing.

These are declared collections, not tables. The ticket, its messages, its
Audit events, and its outbox rows share one partition keyed by the ticket,
because a transaction reaches exactly one collection and one partition and
those records must commit together. Records that cannot share that transaction
— inbound receipts keyed by provider event, customer indexes, and staff queue
projections — are separate collections with their own consistency and repair
rules.

Ordering is the application's job. `list` returns a partition in unspecified
order, so anything that must read in sequence carries an explicit ordinal in
its record and is sorted after reading.

### Ticket

Current queue state:

- stable ticket ID;
- human-facing ticket number;
- requester association;
- status and priority;
- assignee;
- channel;
- creation, staff update, and customer-visible update timestamps;
- optimistic-concurrency revision.

The authoritative ticket is never returned directly from a customer
application service. Customer DTOs omit requester evidence, priority, assignee,
staff update time, revision, and operational state. `customerUpdatedAt`
advances only for customer-visible messages and lifecycle changes; internal
notes, assignment, and priority changes advance staff `updatedAt` only.

### Message

Canonical conversation content:

- ticket and message IDs;
- author kind and optional principal ID;
- customer or internal visibility;
- normalized body and format;
- source channel;
- external threading identifiers;
- creation time;
- explicit committed ticket-revision ordinal.

### Ticket event

Pure workflow input:

- event type;
- trusted occurrence time;
- actor principal when the event is a staff action;
- transition-specific values such as assignee or priority.

The durable accepted-change record is a generic `@pegma/audit` `AuditEvent`
with ticket ID as subject, resulting ticket revision as sequence, and
correlation/command information in bounded safe details.

### Delivery

One outbound attempt or provider callback:

- notification ID;
- ticket and message IDs;
- template version;
- recipient routing reference;
- provider-independent status;
- provider event reference;
- attempt count and timestamps;
- redacted failure category.

### Inbound receipt

Deduplication and processing record:

- bounded hash bucket and 8-bit slot;
- channel ID;
- provider event ID;
- external `Message-ID`;
- bounded payload fingerprint;
- processing status;
- trusted receipt and terminal-processing times;
- resulting ticket and message IDs;
- safe diagnostic details.

### Event time and concurrency

Ticket revision is the concurrency authority. As an additional audit-ordering
guard, the core rejects an event whose `occurredAt` is earlier than the
ticket's `updatedAt`. Hosts must therefore generate `occurredAt` from a
trusted server clock and keep it monotonic per ticket — for example by
clamping to the stored `updatedAt` — rather than trusting client timestamps
or relying on synchronized clocks across application servers. Events with
equal timestamps are ordered by revision, not by time.

The customer application performs that clamp again after every optimistic
transaction conflict, using the ticket version read for that attempt. A
backward-moving host clock therefore cannot invalidate a valid reply or write
timestamps earlier than the state it updates.

Storage versions are opaque and separate from the ticket revision. Revision is
the domain concept a transition increments and an audit event records; the
storage version is the backend's token for the write that landed. Do not parse,
compare, or order storage versions, and do not derive one from the other.

A ticket mutation also writes messages, Audit actions, command receipts, and
possibly Mail actions. It therefore reads the opaque ticket version, rebuilds
the whole proposed single-partition transaction from that authoritative
attempt, and uses `putIfUnchanged` for the ticket action. A conflict re-reads,
re-applies the domain transition, re-clamps time, and rebuilds the transaction.
An `update` decider remains correct for a truly single-record transition such
as a projection fence, because its rule re-runs against fresh state. Do not
read a ticket, decide once, then retry the same stale transaction.

## Transaction and delivery pattern

Creating or replying to a ticket must not depend on a synchronous mail-provider
success.

The flow is:

1. authorize the command;
2. write the ticket, message, event, and the outbound job in one
   `transact(partition, actions)` call;
3. deliver asynchronously;
4. record the result;
5. retry failures with bounded exponential backoff;
6. dead-letter exhausted jobs for staff inspection.

This is an outbox, and it is buildable today rather than aspirational.
`transact` is what makes step 2 one commit: the state change and the outbox
record land together or neither lands, so a provider outage cannot lose a
customer message and a retry cannot send a duplicate. That is the single
strongest reason the ticket and its outbox rows share a partition.

Discovery has no second-write gap. The delivery worker uses the Store adapter's
bounded collection-wide scan over the authoritative committed rows. A
separately persisted scheduling hint after `transact` is unnecessary and
forbidden: a crash between those writes would turn a durable outbox row into
undiscoverable work.

Delivery execution runs `runSendPage` and `runReconciliationPage` as two
independent complete scan loops, persisting one opaque cursor for each.
Terminal sweeping, when scheduled, keeps a third independent cursor. A cursor
belongs only to the loop that produced it and must never be shared or
translated. The host persists each non-null cursor only after handling that
loop's entire page. If it crashes first, the page repeats and conditional
claims make that safe. `nextCursor: null` closes that loop's cycle; the host
starts its next cycle without a cursor and repeats complete cycles so rows
inserted or updated behind a live continuation are eventually revisited.
Candidates use the adapter-returned physical key rather than payload copies of
that identity.

The send loop claims pending, retrying, and expired send leases for delivery.
The reconciliation loop claims accepted jobs whose callback deadline passed
and expired reconciliation leases for read-only provider status checks. A
row may be examined by both collection scans, but authoritative lane-specific
claims decide whether either loop may act; neither cursor can starve the other
operation's complete scan cycle.

Two constraints shape how it is written:

- Every action must target the same partition, and no key may appear twice.
  Both are rejected before anything is attempted. **There is no cross-partition
  atomicity**, so an outbox row for a different ticket, or a counter living
  elsewhere, is a separate operation with its own failure handling — not part
  of this commit.
- **There is no version-conditional delete inside a transaction.** A delivery
  job is not removed on success; it is written to a terminal state, and the
  sweep that reclaims terminal jobs uses `deleteIfUnchanged` outside the
  transaction with the version it read.

A refused precondition is an outcome, not an error: the result names the action
that was refused and why, which the application turns into its own domain
conflict. Genuine failures still throw.

The delivery worker claims jobs with `update` and a decider that refuses a job
already claimed by a live lease, so two workers reading the same partition
cannot both send. Every claim mints a unique fencing token, and completion
requires the token as well as the worker ID; a stale invocation cannot complete
after its lease was reclaimed.

Provider acceptance and confirmed delivery are distinct. A successful
idempotent `send` moves the job to `accepted`, where it cannot be claimed
again. Only an authenticated normalized callback moves it to `delivered`. A
failure callback remains actionable from `accepted` by moving the job to
retrying or dead-letter, but a confirmed `delivered` job never regresses.
Dead-letter is also terminal. Provider callbacks are idempotent through
`insertIfAbsent` at a stable SHA-256-derived provider/event slot. Each bucket
has exactly 256 possible slots, collisions fail closed, and receipt retention
uses a host-clock processing timestamp under a fixed 30-day deduplication
horizon rather than trusting the provider occurrence timestamp.

Accepted jobs carry a bounded callback deadline. If no callback arrives, a
separately fenced reconciliation claim asks the provider for status without
sending again. An authenticated failure callback or a reconciled known failure
clears the prior acceptance, advances the submission generation, and derives
a distinct provider idempotency key before a new send attempt. An ambiguous
send-call failure instead retries the same generation and key, so provider
idempotency can collapse an acceptance hidden by the failed call. An
unresolved status or reconciliation adapter failure becomes
`terminal_unknown` rather than remaining accepted forever, entering the send
path, or risking an untracked duplicate. If reconciliation crashes before
completion, only another reconciliation claim may recover its expired lease;
a send claim cannot convert that lease into a blind resend.

## Email threading

Each outbound email records its generated `Message-ID`. Replies are matched
using:

- opaque reply routing token or trusted provider metadata;
- `In-Reply-To` and `References`;
- ticket marker fallback.

The adapter must preserve enough metadata to produce standards-compatible
threads while keeping provider-specific payloads outside core records.

Ticket numbers are safe to display but are not secret. Routing tokens must be
random, scoped, revocable or expiring where practical, and useless for reading
ticket content without further authorization.

## Authorization sequence

### Customer operation

```text
verified session
  -> principal ID
  -> permission check
  -> ticket requester ownership check
  -> application command
```

### Staff operation

```text
verified session
  -> principal ID
  -> staff permission check
  -> optional queue/scope check
  -> application command
  -> audit event
```

### Inbound email

```text
verified provider event
  -> deduplication
  -> safe parsing
  -> routing/account association
  -> system command
  -> audit and notification jobs
```

Email sender matching never enters the verified-session path.

## Security boundaries

### Message rendering

Canonical plain text is safest. Constrained Markdown must render through a
well-maintained sanitizer. Raw inbound HTML is never inserted directly into
staff or customer pages. See the
[OWASP Cross Site Scripting Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cross_Site_Scripting_Prevention_Cheat_Sheet.html).

### Links and remote content

Staff interfaces should expose destination domains and avoid automatically
loading remote tracking images. Link scanning may be added as an adapter, but
operators should not be taught that scanning makes links trustworthy.

### Attachments

Attachments are a post-MVP capability with a separate threat model. Storage
keys are opaque, downloads require authorization, previews run in isolation,
and content is never served from the primary application origin.

### Inbound abuse

Mail and public-facing endpoints need:

- provider signature validation;
- rate and size limits;
- sender and domain throttling;
- duplicate suppression;
- bounce and auto-reply loop detection;
- maximum thread depth and quoted-text limits;
- abuse review without silently discarding legitimate signup or checkout
  problems.

### Privacy

Support messages may contain financial, health, identity, or account
information even when users are asked not to send it. The host needs explicit
retention, access-review, export, deletion, and legal-hold policies.

AI processing is disabled until the host has documented which fields may leave
the primary environment, selected suitable provider settings, and implemented
redaction and audit controls.

## Observability

Logging goes through the `@pegma/spine` `Logger` port and time through its
`Clock`, so a host maps them onto whatever it already runs and a test can fix
both. Notifications between components use spine event definitions; anything
that must not be lost belongs in the durable outbox, not on the in-process bus.

Structured events should include:

- operation and outcome;
- ticket ID and revision;
- actor type and stable principal ID when appropriate;
- correlation and idempotency IDs;
- channel and provider-independent failure category;
- latency and retry count.

They should exclude:

- message bodies;
- raw MIME;
- access and routing tokens;
- webhook signatures;
- provider credentials;
- full recipient addresses;
- attachment contents.

Suggested metrics:

- tickets created by association and channel;
- queue age by priority;
- first response and resolution duration;
- reopen rate;
- inbound deduplication count;
- delivery success, retry, and dead-letter count;
- authorization denials;
- unknown or ambiguous email association rate.

## Deployment evolution

### Initial

Embedded packages and handlers inside each host's existing API deployment:
Azure for retiregolden.org and Cloudflare Workers for pegma.dev. The
compositions are isolated even though their package versions match.

### Growing usage

Independent background workers for mail ingestion and delivery, sharing the
same application contracts and the same `Store`.

### Multiple applications

A separately deployed Support Desk API may become worthwhile only when evidence
shows that several host applications need one operator queue rather than merely
the same code. That service must accept narrowly scoped, short-lived access
grants rather than becoming a new identity provider. Do not pre-build it as a
shortcut for the two launch instances.

## Architectural invariants

1. Core packages perform no network or storage I/O.
2. Provider SDK types do not enter public core contracts.
3. This repository contains no persistence layer and no access model. Both
   belong to sibling packages.
4. Shared identity, time, logging, and event types are imported from
   `@pegma/spine` and never redeclared.
5. Accepted-change history uses `@pegma/audit` in the ticket transaction;
   Support Desk does not own a competing audit contract.
6. Browser fields never establish principal, role, entitlement, or priority.
7. Email matching assists routing but does not authenticate.
8. Internal notes never enter customer-visible output.
9. Duplicate provider events are safe.
10. Ticket updates go through an `update` decider that re-runs on conflict, or
    through `putIfUnchanged` with a version the caller supplied.
11. A state change and the outbox record it causes commit in one `transact` on
    one partition, or the design is wrong.
12. Outbox discovery comes from authoritative rows or an adapter-native
    transactionally maintained feed, never a separate post-commit hint.
13. Customer and detail reads are keyed or partition reads. Bounded scans are
    explicit cursor-aware loops; every projection remains a hint rather than an
    authorization answer.
14. Delivery is asynchronous and retry-safe.
15. Hosts apply durable request limits at the HTTP boundary; Support Desk does
    not implement a private limiter.
16. Authorization precedes resource loading or mutation where practical.
17. The two launch hosts share package code and no operational state.
18. AI cannot increase a caller's permissions.
