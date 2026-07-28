# Support Desk MVP Specification

## Purpose

The MVP provides a small support desk for a host application:

- authenticated users with the host-defined permission can create and follow
  their own tickets on the website;
- authorized staff can work the host instance's queue;
- customers and staff receive branded email notifications;
- replies to those emails join the existing ticket thread;
- new mail sent directly to a support address creates an unverified ticket when
  it cannot be safely associated with a known account.

This specification describes product behavior. It does not require Auth0,
Stripe, a particular cloud, or a particular email provider. It does require the
Pegma boundaries: permissions from `@pegma/authorization-core`, a
`@pegma/storage-core` `Store` supplied by the host, and shared identity, clock,
logger, and event types from `@pegma/spine`.

The initial proof is two isolated compositions of the same packages:
retiregolden.org provides paid customer support on Azure, while pegma.dev
collects authenticated product feedback on Cloudflare. They do not share
tickets, queues, numbers, mail channels, or storage.

## Terminology

- **Authenticated requester:** A host application has verified the requester's
  identity and linked it to a stable principal ID.
- **Matched-email requester:** An inbound sender address uniquely matches a
  known account. This improves routing but does not authenticate the sender.
- **Unverified requester:** The sender has no safe account association.
- **Unverified queue:** A staff-only queue for tickets from unverified senders.
  It is never publicly readable despite sometimes being described as a
  "public support queue."
- **Ticket thread:** The ordered customer-visible and internal messages
  associated with one ticket.

## Actors

### Authenticated requester

An authenticated principal with the host-defined permission to open tickets.
RetireGolden derives that permission from paid-product policy. pegma.dev grants
it to authenticated accounts through its own policy defaults.

### Support staff

An authenticated principal who can view and work tickets within an authorized
queue.

### Administrator

An authenticated principal who can manage support settings, templates, queues,
and staff capabilities.

### Email sender

A person sending mail to the configured support address. An email sender may be
matched to an account for routing, but is not thereby authenticated.

### System

Trusted background workers that ingest provider events, send notifications,
process delivery callbacks, and perform maintenance.

## Required permissions

Support Desk asks the host authorization provider for permissions. It does not
assign business meaning to plan or role names.

| Permission                 | Purpose                                   |
| -------------------------- | ----------------------------------------- |
| `support.ticket.create`    | Create an authenticated customer ticket   |
| `support.ticket.read.own`  | Read a ticket after ownership is verified |
| `support.ticket.reply.own` | Reply to an owned ticket                  |
| `support.queue.read`       | View authorized staff queues              |
| `support.ticket.reply.any` | Send a customer-visible staff reply       |
| `support.ticket.note`      | Add an internal note                      |
| `support.ticket.assign`    | Assign or unassign a ticket               |
| `support.ticket.manage`    | Change priority and lifecycle state       |
| `support.settings.manage`  | Manage channels and templates             |
| `support.audit.read`       | Review support audit records              |

Possessing `support.ticket.read.own` does not establish ownership. The
application must also prove that the authenticated principal matches the
ticket's requester principal.

At launch, retiregolden.org and pegma.dev use the same permission names but
different policy inputs. Support Desk never asks whether a requester is paid,
which identity provider authenticated them, or which host it is running in.

## Customer web experience

### Create

An authorized authenticated requester can submit:

- subject;
- plain-text or constrained Markdown message;
- a category from the host's configured allowlist.

The server supplies the principal ID, verified account email snapshot, channel,
ticket ID, ticket number, creation time, and initial priority. Browser-provided
identity, plan, role, priority, and assignment fields are ignored.

Category is an optional opaque Support Desk field. The application validates it
against the frozen host configuration, and the server may require it for a
particular form. It never changes identity, authorization, priority, or
assignment. pegma.dev initially configures `feedback`, `bug`,
`feature_request`, `documentation`, and `question`; RetireGolden owns its own
allowlist.

On success, the customer sees the ticket number and receives a confirmation
email.

### List and read

A customer can list and read only tickets linked to their authenticated
principal ID. The initial message and all customer-visible replies are shown in
chronological order. Internal notes and staff-only metadata are excluded.

Customer APIs return an explicit safe summary, not the authoritative `Ticket`
record. It includes ID, number, subject, optional category, status, channel,
creation time, and `customerUpdatedAt`. It excludes requester email and
association evidence, priority, assignee, staff-facing `updatedAt`, revision,
audit history, command state, and delivery state.

`customerUpdatedAt` advances for customer-visible messages and lifecycle
changes. Internal notes, assignment, and priority changes update staff queue
ordering but do not change this customer-visible timestamp, so their existence
cannot be inferred from an own-ticket list.

The customer's ticket index is one bounded summary record keyed by
`PrincipalId`. It is a hint: listing follows each referenced ticket ID to the
authoritative ticket partition and re-checks the requester principal. Messages
for one ticket share that ticket's partition and are sorted after reading from
their explicit committed revision ordinal, because partition reads have no
specified order.

### Follow up

A customer can add a web reply to an open, waiting, resolved, or closed ticket.
A reply to a resolved or closed ticket reopens it as `waiting_on_support`.

### Cancellation and deletion

The MVP does not allow customers to erase individual support messages.
Retention and account-deletion behavior must be defined by the host's privacy
policy and implemented as a controlled administrative workflow.

## Staff queue

The initial queue presents, and lets staff narrow by:

- newest and oldest updates;
- status;
- priority;
- requester association;
- source channel;
- assignee;
- unassigned-only;
- known-customer and unverified.

None of this is a database query. Storage offers reads by key and reads of a
whole partition, with no server-side filtering, ordering, or secondary index.
The open queue is therefore a separate projection with one row partitioned by
ticket ID. A bounded collection-wide scan discovers projection rows; every
candidate is confirmed against the authoritative ticket before filtering or
display. Staff narrowing and sort order are applied in application memory after
that confirmation. Separate hard budgets cap physical rows, scan pages, and
confirmed active results; reaching one before a complete scan returns an
operational error rather than a partial queue.

The projection cannot share the ticket transaction because it is a different
collection. The application attempts to update it immediately after a ticket
commit, and a repeating cursor-aware worker repairs omissions from
authoritative ticket rows. Resolved and closed tickets project inactive rows,
which are later reclaimed conditionally under the same terminal-retention
cutoff used by repair. Repair does not recreate reclaimed terminal rows. A
temporary gap is allowed; permanent loss after a complete repair cycle is not.

An index row is a pointer, never proof. Loading the ticket it names and
re-checking revision, status, assignment, and scope against the ticket record
is the authoritative step.

Staff can:

- read the full ticket and audit context;
- reply publicly;
- add an internal note;
- assign or unassign;
- change priority;
- resolve, close, or reopen.

The UI should make customer-visible replies visually distinct from internal
notes and require an explicit choice before sending.

## Ticket lifecycle

| Status                | Meaning                                                     |
| --------------------- | ----------------------------------------------------------- |
| `open`                | Newly created and not yet triaged                           |
| `waiting_on_support`  | The customer has replied or the ticket was reopened         |
| `waiting_on_customer` | Staff replied and expects customer follow-up                |
| `resolved`            | Staff believes no further action is needed                  |
| `closed`              | A resolved conversation has been administratively finalized |

Rules:

- A customer reply moves any ticket to `waiting_on_support`.
- A staff reply moves any ticket to `waiting_on_customer`.
- A closed ticket must be reopened before staff resolves it again.
- Only a resolved ticket can be closed.
- Internal notes, assignment, and priority changes do not change status.
- Every transition increments the ticket revision and creates an audit event.
- Customer replies, staff replies, resolution, closure, and reopening advance
  both staff `updatedAt` and `customerUpdatedAt`; notes, assignment, and
  priority changes advance staff `updatedAt` only.

These rules intentionally mean that a staff reply to a `closed` ticket returns
it directly to `waiting_on_customer` without a separate reopen event. The
explicit reopen requirement applies only to resolving a closed ticket again.

## Priority and requester routing

Initial host policy for the RetireGolden reference integration:

| Request source                                 | Association   | Initial priority |
| ---------------------------------------------- | ------------- | ---------------- |
| Authenticated paid web customer                | Authenticated | Normal           |
| Email uniquely matching a paid account         | Matched email | Normal           |
| Email uniquely matching a known unpaid account | Matched email | Low              |
| Unknown or ambiguous email                     | Unverified    | Low              |

Support Desk core does not hardcode this table. The host supplies routing and
priority policy.

No inbound message automatically receives `urgent` priority based only on its
subject, sender, sentiment, or AI classification.

pegma.dev uses the same generic rules but has no paid/unpaid distinction for
authenticated web feedback. Its category choice does not raise priority.

## Email notifications

The MVP sends transactional email for:

- ticket creation confirmation;
- staff reply to customer;
- customer reply notification to assigned staff or queue;
- assignment notification when enabled;
- resolution notification.

Every customer email has:

- plain-text and branded HTML alternatives;
- an allowlisted set of template variables;
- a stable ticket marker such as `[SD-1042]` in the subject;
- a link to the authenticated web ticket when available;
- reply instructions;
- no sensitive account or billing detail beyond the ticket conversation.

Templates are data, not executable code. Values are escaped according to output
context, and administrators can preview both representations before activation.
RetireGolden and Pegma activate separate template packs, subjects, URLs, and
sender configuration in their isolated instances.

## Inbound email

### New conversation

Mail sent directly to the support address creates a ticket. The mail adapter:

1. verifies the provider webhook or delivery mechanism;
2. deduplicates the provider event;
3. parses bounded MIME content;
4. normalizes a safe plain-text representation;
5. identifies the sender address;
6. asks the host account matcher for zero, one, or multiple matches;
7. creates a matched-email or unverified requester;
8. applies host routing and priority policy;
9. persists the ticket and message atomically or through an idempotent workflow.

Multiple account matches must be treated as unverified rather than guessed.

### Reply to an existing ticket

Thread matching uses, in order:

1. a valid opaque routing token in the reply address or provider metadata;
2. stored `Message-ID`, `In-Reply-To`, and `References` relationships;
3. a well-formed ticket marker in the subject as a fallback.

Steps 1 and 2 are key lookups, not searches. An external `Message-ID` resolves
to a ticket through an index collection keyed by that identifier, written when
the outbound message is recorded.

The message headers follow the threading fields defined by
[RFC 5322 section 3.6.4](https://www.rfc-editor.org/rfc/rfc5322#section-3.6.4).
A subject ticket number is useful to people but is not authorization and is
insufficient by itself to expose or modify an account.

If matching is ambiguous or unsafe, the adapter creates a new unverified ticket
and links the possible relationship for staff review.

### Deduplication

Inbound processing stores:

- provider event ID;
- mailbox or channel ID;
- external `Message-ID` when present;
- normalized payload hash as a bounded fallback;
- processing result.

The receipt is written with `insertIfAbsent` at a stable SHA-256-derived
channel/event bucket and 8-bit slot before the ticket work begins. A second
delivery reaches the same bounded slot, reports `inserted: false`, and returns
the existing receipt, which names the ticket and message the first delivery
produced. Terminal receipts are retained against trusted processing time for
the deduplication horizon and reclaimed with a version-conditional sweep.

Provider retries must not create duplicate tickets or messages.

## Message content

The canonical MVP message is plain text or constrained Markdown. Raw MIME and
HTML may be retained separately only when the host has a justified retention
need and appropriate controls.

Rendered content must:

- escape unsafe HTML;
- block scripts, forms, embedded credentials, and active content;
- proxy or suppress remote images when privacy requires it;
- make suspicious links visible;
- limit message size and quoted-history expansion.

Attachments are excluded from the first production release. Their later
introduction requires size and type allowlists, malware scanning, isolated
object storage, authorization checks, and retention controls.

## API surface

Exact routes are host-specific, but the reference API should demonstrate:

```text
POST   /support/tickets
GET    /support/tickets
GET    /support/tickets/{ticketId}
POST   /support/tickets/{ticketId}/messages

GET    /support/admin/queue
POST   /support/admin/tickets/{ticketId}/messages
POST   /support/admin/tickets/{ticketId}/notes
PATCH  /support/admin/tickets/{ticketId}

POST   /support/channels/email/inbound
POST   /support/channels/email/events
```

Customer and administrative routes use separate authorization middleware even
when they share application services.

## Data and audit requirements

The MVP stores:

- current ticket state and revision;
- canonical messages;
- append-only `@pegma/audit` accepted-change events;
- channel-delivery and deduplication records;
- template version used for each outbound message;
- queue and threading index rows Support Desk maintains itself;
- outbox rows for every outbound notification;
- actor principal ID for staff actions;
- timestamps generated or accepted by trusted server components.

Everything above is a declared `@pegma/storage-core` collection. Accepted
change history uses `@pegma/audit` events embedded in the Support Desk record
union. A ticket, its messages, its audit events, and its outbox rows share one
partition so that a state change and the records it causes commit in a single
`transact`. Index and receipt collections are keyed by what looks them up and
are separate, so they are non-authoritative and repairable.

Logs should use ticket IDs, event IDs, and redacted recipient identifiers.
Message bodies, access tokens, webhook secrets, and full email addresses should
not appear in routine logs.

## Explicit MVP exclusions

- File attachments
- Live chat and presence
- SLAs and business-hours calendars
- Macros and automation rules
- Customer satisfaction surveys
- A shared multi-brand or multi-tenant deployment; separate branded host
  instances are the launch design
- Public knowledge-base editing
- AI-generated customer replies
- AI actions against customer accounts
- Automatic priority escalation from sentiment
- Hosted Support Desk control plane
- Automatic publication of pegma.dev tickets to a roadmap or GitHub Issues
- Any persistence layer or access model inside this repository

## Acceptance criteria

The MVP is complete when:

1. An eligible RetireGolden customer and an authenticated pegma.dev user can
   each create, list, read, and reply to their own ticket in isolated instances
   but cannot access another requester's ticket.
2. Support staff can work each host instance's queue using explicit
   permissions.
3. Internal notes never appear in customer responses or notifications.
4. A staff reply sends a branded notification and an email reply joins the
   original ticket.
5. A direct email from an unknown sender creates a low-priority unverified
   ticket.
6. Duplicate provider deliveries create only one message.
7. Customer replies reopen resolved and closed tickets.
8. Every staff action and state change is auditable.
9. Content rendering remains safe with hostile HTML and links.
10. The implementation runs on the storage-core in-memory `Store` and a test
    permission source, with no Auth0, Stripe, Identity, Sessions, cloud, or
    mail-provider dependency.
11. Azure Tables and D1 host compositions change no Support Desk code.
12. Each host applies durable create/reply limits at its HTTP boundary with no
    private limiter inside Support Desk.
13. A queue projection missed after a ticket commit converges after a complete
    authoritative repair cycle.
