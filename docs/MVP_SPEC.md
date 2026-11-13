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

| Permission                           | Purpose                                                              |
| ------------------------------------ | -------------------------------------------------------------------- |
| `support.ticket.create`              | Create an authenticated customer ticket                              |
| `support.ticket.read.own`            | Read a ticket after ownership is verified                            |
| `support.ticket.reply.own`           | Reply to an owned ticket                                             |
| `support.queue.read`                 | View authorized staff queues                                         |
| `support.ticket.reply.any`           | Send a customer-visible staff reply                                  |
| `support.ticket.note`                | Add an internal note                                                 |
| `support.ticket.assign`              | Assign or unassign a ticket                                          |
| `support.ticket.manage`              | Change priority, tags, and lifecycle state                           |
| `support.settings.manage`            | Manage channels and templates                                        |
| `support.audit.read`                 | Review support audit records                                         |
| `support.ticket.assistant.start`     | Start explicitly opted-in web handling alongside create permission   |
| `support.ticket.assistant.read`      | Read the service-only customer-visible assistant conversation        |
| `support.ticket.assistant.reply`     | Commit an attributed fenced assistant reply                          |
| `support.ticket.assistant.escalate`  | Commit a fenced human escalation                                     |
| `support.ticket.request_person.own`  | Request a person after ownership is verified                         |
| `support.ticket.take_over`           | Take over with queue read and exact handling/revision fences         |
| `support.ticket.confirm_success.own` | Confirm owned success and resolve with current visible-message proof |

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
creation time, `customerUpdatedAt`, and optional handling state. It excludes requester email and
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

### Optional handling and deterministic controls (SD-01)

Handling is separate from ticket status: `assistant`, `human-pending`, or
`human-active`. Missing legacy handling means human-pending, so upgrading does
not hide existing work. Only an explicit authorized signed-in web creation
starts assistant handling. The first customer message still creates the
canonical ticket and message together. Fresh inbound email stays human;
verified email joining an assistant conversation routes it to human-pending.
SD-01 supplies these foundations without a model, KB connection, or live chat
activation.

Assistant messages are visibly attributed to an assistant and never impersonate
staff or satisfy the first-human-response milestone. A later customer message,
human request, escalation, or staff takeover prevents an older assistant
completion from being committed through its ticket/handling/trigger fence.
The assistant cannot resolve tickets or act on customer accounts.
Staff reopening puts explicitly handled work into human-pending; a web
customer reply can instead supply the fresh trigger for an assistant
conversation. Legacy human handling remains the default.

An authenticated owner can request a person through a deterministic command
that does not consult a model. An active conversation already handled by humans
is unchanged by repeated requests; a terminal conversation can reopen for a
human. Authorized staff can take over the same thread. Handoff records a
bounded safe reason/summary, attempted guide IDs, and compact transcript
references with Audit and its replay receipt; it does not copy the transcript,
internal notes, or an automatic mail job into handoff work.

`confirmCustomerSuccess` is explicitly authorized by
`support.ticket.confirm_success.own`, checks ownership and the last
customer-visible message ID, and always resolves while recording private
evidence. There is no optional resolve flag. The application derives the
internal revision; browsers supply no staff revision or handling generation.
Inactivity is not success. A closed ticket must reopen before confirmation.
Repeated confirmation of the same visible message on an already resolved
ticket adds no evidence rows. Private success evidence is not returned in
customer conversation DTOs.

Default staff queue selection includes legacy and human-handled work.
`listStaffQueue` defaults to `handling: "human"`; `"assistant"` and `"all"`
are explicit supervision selections. Assistant conversations remain readable
to authorized staff without appearing in the default human work queue.
Filtering always confirms authoritative handling after loading a candidate;
an older active hint cannot impose its old handling on the current ticket.
Missing/inactive hints can still cause a temporary repair gap; no projection
authorizes assistant use.

Assistant-managed tickets reserve bounded capacity for a human handoff and
first staff reply. Ordinary writes may be refused before the hard ticket cap
to preserve that reserve. See [declared collections](COLLECTIONS.md#sd-01-handling-and-handoff-layout-checkpoint)
for physical bounds and [host composition](HOST_COMPOSITION.md) for commands,
permissions, and source/release gates.

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

An index row is a pointer, never proof. A valid positive active hint revision
at or below the ticket's current revision can discover that ticket. Future,
nonpositive, malformed, and inactive hints are refused. Current canonical
status, handling, assignment, and scope govern filtering, never hint fields.

Staff can:

- read the full ticket and audit context;
- inspect bounded handoff summaries, attempted guide IDs, and transcript references;
- reply publicly;
- add an internal note;
- assign or unassign;
- change priority;
- resolve, close, or reopen.

The UI should make customer-visible replies visually distinct from internal
notes and require an explicit choice before sending.

## Staff canned responses (Task 15 source candidate)

Hosts may configure a bounded catalog of immutable plain-text response versions.
Authorized staff preview substitutions and explicitly submit a reply or internal
note using the exact selected version and expanded body. A template cannot change
permissions, assignment, lifecycle or accounts. New uses of unknown/withdrawn
versions, changed previews, and reply/note target mismatches fail closed.
Existing reply/note permissions and revision checks still apply; exact accepted
retries recover the original result under current permissions.

Each accepted use records template ID/version through the existing reply/note
Audit action in the same transaction. Internal notes and provenance stay out of
customer DTOs and automatic mail. This unpublished source slice adds no package
version or durable layout change. See the
[composition contract](HOST_COMPOSITION.md#staff-canned-responses-task-15-source-candidate).

## Lifecycle extras (Buildout Task 13)

Staff may replace a ticket's bounded tags using the host's normalized allowlist.
This requires `support.ticket.manage` and queue read and records
`support.ticket.tags_changed` atomically with the ticket and command receipt.
Tags affect only staff update time and revision, with no message or mail.
They never enter customer summaries, detail, or automatic customer mail.

Hosts may supply canonical first-response and resolution due timestamps on
creation, web/email customer follow-up, and priority changes. Support Desk
records them, sets `firstStaffRespondedAt` once on the first public staff reply,
and tracks `resolvedAt` for the current resolution. Repeated resolution
preserves its timestamp; reopening through an explicit action or a reply clears
it, and resolving again records a new time. First response survives reopen.
Calendars, business hours, and presence remain host responsibilities.

Staff queues support tag filters, overdue and bounded due-soon filters, and
both due-date sort directions after authoritative confirmation. Completed or
absent targets do not match target-state filters. These dates and milestones
remain staff-only. All staff commands accept optional `expectedRevision`;
a mismatch returns a safe changed-since-load hint without a ticket change.
Exact committed replay wins over staleness and returns its original result.
See [host composition](HOST_COMPOSITION.md#optional-lifecycle-extras-task-13)
for exact bounds, replay compatibility, and queue semantics.

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
2. evaluates sender authentication and binds it to the normalized sender;
3. deduplicates the provider event;
4. parses bounded MIME content;
5. normalizes a safe plain-text representation;
6. identifies the sender address;
7. asks the host account matcher for zero, one, or multiple matches;
8. creates a matched-email or unverified requester;
9. applies host routing and priority policy;
10. persists the ticket and message atomically or through an idempotent workflow.

Multiple account matches must be treated as unverified rather than guessed.

Steps 1, 2, and 4 belong to the host adapter. Support Desk performs steps 3 and
5 through 10 in `createInboundMailProcessor`: it reserves the receipt,
re-normalizes control characters, enforces the subject and body limits, calls
the host account matcher and routing policy, and commits the ticket, first
message, Audit event, and optional staff notification in one ticket-partition
transaction. The routing policy never sees the subject or body and cannot
assign `urgent`.

### Reply to an existing ticket

Thread matching uses, in order:

1. a valid opaque routing token in the reply address or provider metadata;
2. stored `Message-ID`, `In-Reply-To`, and `References` relationships;
3. a well-formed ticket marker in the subject as a fallback.

Steps 1 and 2 are key lookups, not searches. An external `Message-ID` resolves
to a ticket through an index collection keyed by that identifier, written when
the outbound message is recorded. A repeated inbound message's own `Message-ID`
is checked for duplicate delivery first. If it does not qualify, that ticket is
the related-ticket candidate after routing-token and threading-header matches
but before the subject-marker fallback.

The message headers follow the threading fields defined by
[RFC 5322 section 3.6.4](https://www.rfc-editor.org/rfc/rfc5322#section-3.6.4).
A subject ticket number is useful to people but is not authorization and is
insufficient by itself to expose or modify an account.

A match for a ticket with a recorded requester address is safe to join only
when the case-insensitive normalized sender equals that address and the host
provides a passing sender result bound to the same normalized sender. DMARC
passes require aligned DKIM or aligned SPF; an equivalent host-authenticated
identity may also qualify. Raw, unparsed `Authentication-Results`, a provider
webhook signature alone, and unaligned SPF do not qualify. When the ticket has
no recorded address, only a valid high-entropy routing token may join it.
Routing tokens and `Message-ID` rows expire with the configured threading
retention.

If matching is ambiguous, or the sender result is missing, failed, unaligned,
or bound to another address, the processor creates a new unverified ticket and
links the possible relationship for staff review. The named ticket remains
unchanged. The link is the staff-only `relatedTicketId` field: never
authorization, never merge evidence, and never part of a customer view.

A confirmed reply is a customer reply: it moves any ticket, including a
resolved or closed one, to `waiting_on_support`.

### Loops, bounces, and auto-replies

Inbound processing records a suppressed receipt and creates no ticket or
message when any of these signals is present:

- `Auto-Submitted` with any value other than `no`
  ([RFC 3834](https://www.rfc-editor.org/rfc/rfc3834));
- `Precedence: bulk`, `junk`, `list`, or `auto_reply`;
- an `X-Autoreply`/`X-Autorespond`-style header (reported by the host);
- a null SMTP envelope sender or a `mailer-daemon` sender;
- a `multipart/report`, delivery-status, or disposition-notification body;
- a sender equal to one of the instance's own support addresses.

`X-Auto-Response-Suppress` (`All`, `OOF`, `AutoReply`) and `List-Id` keep the
message but tell the host not to acknowledge the sender. Suppressed mail never
triggers a notification, so a loop cannot grow the conversation.

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

Provider retries must not create duplicate tickets or messages. A retry
resumes the first delivery's reserved ticket and message identifiers and its
persisted routing decision, even after a crash. The same `Message-ID`
delivered under a different provider event from the same requester collapses
into the already recorded message.

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
SD-01 hosts additionally map owned request-person/success confirmation and
staff takeover to the named application commands. Routes remain host-owned;
service-only assistant revision/generation fences are not browser authority.

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

SD-01 also retains bounded handoff references/work and private customer
success evidence in the ticket partition with their causal Audit/receipt.

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

These describe the original ticket-only MVP. The approved post-MVP
[knowledge/AI implementation plan](KNOWLEDGE_AI_PLAN.md) adds evaluated
customer-visible support answers and reviewed knowledge/engineering workflows
through separate implementation and activation gates.

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

The original ticket-only MVP is complete when the criteria below pass. They do
not establish completion or activation readiness for the post-MVP KB/AI
enhancement: that additionally requires the
[full-workflow build acceptance](KNOWLEDGE_AI_PLAN.md#full-workflow-build-acceptance)
on both hosts, followed by its supervised rollout and existing production
evidence gates.

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

## Optional post-MVP attachments (Task 14)

Web create/reply and staff replies/notes may carry bounded host-allowlisted attachments. New files await a digest-bound clean scan before download. Customers see metadata only on their own visible messages; internal-note attachments remain staff-only. Normal downloads refuse pending, quarantined, deleting, deleted and expired files for everyone. Downloads always force attachment disposition; there is no preview. Deletion is resumable and expiry is enforced before physical cleanup. Inbound email continues dropping bounded MIME attachments. See [ATTACHMENTS.md](./ATTACHMENTS.md).
