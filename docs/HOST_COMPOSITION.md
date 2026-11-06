# Host composition guide

Support Desk is a library. Hosts authenticate callers, resolve
`AccessContext` values, supply a `@pegma/storage-core` `Store`, schedule
workers, and map application outcomes to HTTP. Support Desk never defines
routes, cookies, or provider SDKs.

See also the runnable example at
[examples/composition](../examples/composition/README.md).

## Public packages

Install the synchronized exact set (first advertised release):

```sh
npm install @pegma/support-desk-contracts@0.1.0 \
  @pegma/support-desk-core@0.1.0 \
  @pegma/support-desk-templates@0.1.0 \
  @pegma/support-desk-application@0.1.0
```

Also require exact peer ecosystem pins used by the application package:

- `@pegma/spine@0.1.2`
- `@pegma/storage-core@0.4.0`
- `@pegma/authorization-core@0.4.0`
- `@pegma/audit@0.1.0`
- `@pegma/mail@0.1.0`

For the seven direct host loops, pin the advertised durable coordinator:

- `@pegma/scheduler@0.1.0` (and `@pegma/scheduler-cloudflare@0.1.0` when the
  host uses Cloudflare Cron Triggers)

Do not depend on a Git branch, copied source, local path, or unpublished
tarball in a host production install.

## Constructing the application

```ts
import { createSupportDeskApplication } from "@pegma/support-desk-application";

const application = createSupportDeskApplication({
  store, // host-created Store
  clock, // trusted host Clock
  allowedCategories: [
    "feedback",
    "bug",
    "feature_request",
    "documentation",
    "question",
  ],
  allowedTags: ["needs_review", "follow_up"],
  maxTagsPerTicket: 8,
  responseTargetPolicy, // optional host port; also configure inbound processing
  queueTerminalRetentionMilliseconds: 30 * 86_400_000,
});
```

Mint command, correlation, ticket, and message IDs on the server. Controllers
never invent ticket numbers — create reserves them from
`support-desk.ticket-numbers.v1`.

## Error categories for HTTP mapping

Map thrown outcomes to stable host responses. Never send raw exception
messages, storage keys, email addresses, permission sets, or provider
diagnostics to a browser.

| Application outcome                                                                                                   | Host HTTP behavior                                  |
| --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Malformed command or identifier (`TypeError` from boundary validation)                                                | `400` with a stable host error code                 |
| `SupportDeskAuthorizationError` (missing permission)                                                                  | `403`                                               |
| `SupportDeskNotFoundError` (missing or non-owned ticket)                                                              | the same content-free `404` response for both cases |
| `SupportDeskConflictError` (command ID reused with different input, exhausted conflict retry, callback key collision) | `409`                                               |
| `SupportDeskLimitError` with field `subject` or `body`                                                                | `413`                                               |
| `SupportDeskLimitError` with field `customer_tickets`, `ticket_messages`, or `ticket_partition`                       | `409`                                               |
| Host durable request limit refused (`@pegma/rate-limit`)                                                              | `429` with bounded `Retry-After`                    |
| `SupportDeskQueueCapacityError` (staff queue scan/materialization budget exhausted)                                   | `503`; never return a partial queue                 |
| Required Store or provider dependency unavailable                                                                     | `503`                                               |
| Unexpected failure                                                                                                    | content-free `500` plus a safe correlation ID       |

`SupportDeskStaleRevisionError` maps to `409` with a stable host code and only
its safe `currentRevision` and `updatedAt` hint fields. It extends
`SupportDeskConflictError`; handle it before that broader class.

`TicketWorkflowError` from lifecycle transitions is a refused state change; hosts
typically map it to `409` after the caller was already authorized.

## Optional lifecycle extras (Task 13)

`allowedTags` is copied at construction, normalized by trimming surrounding
spaces and lowercasing, deduplicated, and sorted. It accepts at most 32 physical
entries before deduplication. Each input is at most 64 characters, has no
controls, and normalizes to `^[a-z][a-z0-9_]{0,31}$`, the category identifier
discipline. `maxTagsPerTicket` defaults to 8 with a hard maximum of 32.
`setTags(access, { commandId, correlationId, ticketId, tags, expectedRevision? })`
replaces all tags; `[]` clears them even when no allowlist is configured.
Adding tags requires an allowlist. Both `support.queue.read` and
`support.ticket.manage` are required. A normalized set is part of the command
fingerprint. The ticket, `support.ticket.tags_changed` Audit action, and receipt
commit together. Tags advance revision and staff `updatedAt` only; they never
change status, `customerUpdatedAt`, messages, or mail.

Configure the same optional `ResponseTargetPolicy` on the application and
inbound processor. The host supplies `computeTargets(context)` returning
`{ firstResponseDueAt?, resolutionDueAt? }` synchronously or asynchronously.
Values must be canonical ISO timestamps, for example `2026-11-01T12:00:00.000Z`.
The content-free, frozen context contains ticket ID, resulting revision,
priority, optional category, channel, created/occurrence times, existing targets,
and milestones. It contains no subject, body, requester identity, or tags.

The hook runs before commit on web or email creation, accepted customer
replies through either transport, and staff priority changes. Its reason is
`created`, `customer_replied`, or `priority_changed`. Its result completely
replaces the two due fields; omitted fields remove previous targets. Without
a hook, existing targets are preserved. Invalid output or a rejected hook
leaves the ticket command uncommitted; retry the same command/event after
fixing the dependency. Creation may leave a reserved ticket-number gap or
customer-index reservation, and inbound receipts remain processing. Hooks
may run again after a conflict or interrupted attempt, so keep them repeatable
and free of external side effects. Committed command/provider-event replay
does not run them. Calendars, business hours, holidays, and presence belong
entirely to the host; Support Desk stores dates and compares instants only.

`firstStaffRespondedAt` is set once by the first customer-visible staff reply
and survives resolution, closure, and reopening. Notes, assignment messages,
and lifecycle system messages do not set it. `resolvedAt` records entry into
resolved; resolving an already resolved ticket preserves it. Closure preserves
it. Explicit reopening or a customer/staff reply clears it; re-resolution sets
it to the new resolution time. Reopening preserves due timestamps until a
configured trigger replaces them; the host policy owns any reset decision.
Legacy tickets may omit tags, targets, and first-response milestones; there is
no inferred historical first response or automatic target backfill.

Queue fields are staff-only and come from authoritative confirmation. Query
`tag` matches one normalized tag. `target` selects `first_response` or
`resolution` (default); `targetState: "overdue"` means an unmet target strictly
before the host clock, while `"due_soon"` means from now through the inclusive
`dueSoonMilliseconds` horizon (required, 0 to 30 days, and rejected with any
other `targetState`). First-response targets
are unmet until `firstStaffRespondedAt`; resolution targets are unmet until
`resolvedAt`. Terminal tickets remain excluded from the active queue. Sorts
`due_soonest` and `due_latest` use the selected unmet target with missing or
completed targets last in both directions and ticket ID as tie-breaker.
Existing update sorts and physical-row/page/result budgets remain in force.
Run a complete queue repair cycle after upgrading; exact legacy rows can gain
the additive fields at the same revision after authoritative re-derivation.

All staff mutations (reply, note, assign/unassign, priority, tags, resolve,
close, reopen) accept an optional positive safe-integer `expectedRevision`.
Omitting it retains automatic conflict retries. Supplying it requires a match
after authorization and command-replay detection, on every attempt. A mismatch
fails before ticket writes or target-hook calls with the content-safe stale
error above. Reuse of a command ID with changed input, including a changed
revision hint, remains a command conflict. New staff receipts retain the result
ticket; immutable message ordinals reconstruct the original conversation up
to that revision. Exact committed retries return that result even after later
edits. Legacy receipts without a result ticket retain their earlier current-view
replay behavior. Controllers should reload staff detail after a stale response
or when they want the latest state following a replay.

Tags, due timestamps, and milestones never enter customer DTOs or automatic
customer mail projections. Hosts must keep these fields out of customer
notification variables and template bodies as well.

## Inbound mail

Support Desk owns provider-neutral processing after the host has verified a
provider event. The host mail worker owns everything before that:

1. **Verify authenticity.** Check the provider webhook signature or the
   delivery mechanism's credentials with the provider SDK or HTTP client in
   the host. Unverified requests never reach Support Desk.
2. **Evaluate the sender.** Produce `InboundSenderAuthentication` only from
   trusted post-verification provider evidence and bind its normalized `email`
   to the same address passed as `from`. A DMARC `pass` requires aligned DKIM
   or aligned SPF; `host_identity` requires an equivalent host-authenticated
   identity. Never trust raw, unparsed `Authentication-Results`, a provider
   webhook signature by itself, or SPF without alignment. Use `fail` or omit
   the result when the host cannot establish these semantics.
3. **Bound and normalize MIME.** Enforce message, part, header, and
   attachment size limits; decode the subject; reduce the body to safe plain
   text (or constrained Markdown) with quoted history trimmed below the
   configured body limit. Raw MIME and HTML are never passed in. Attachments
   are dropped until their own post-MVP task.
4. **Extract metadata.** Pass the sender address, optional display name, the
   message's own `Message-ID`, `In-Reply-To`, `References`, any candidate
   reply-routing token from the recipient address or provider metadata, and
   the loop signals (`Auto-Submitted`, `Precedence`,
   `X-Auto-Response-Suppress`, `X-Autoreply`-style headers, `List-Id`,
   top-level `Content-Type`, and the SMTP envelope sender).
5. **Mint identifiers.** Supply server-minted `ticketId`, `messageId`, and
   `correlationId` for every attempt. A retry may mint new ones; Support Desk
   reuses the first delivery's reserved identifiers.
6. **Apply durable limits.** Throttle by sender, domain, and channel with
   `@pegma/rate-limit` before calling Support Desk.

```ts
import { createInboundMailProcessor } from "@pegma/support-desk-application";

const inbound = createInboundMailProcessor({
  store,
  clock,
  accountMatcher, // { matchSenderEmail({ channelId, email }) } -> none | one | many
  routingPolicy, // { routeNewConversation({ association, ... }) } -> priority/category
  notificationPolicy, // optional staff alert committed with the message
  subjectMarkerPrefix: "SD", // enables [SD-1042] fallback
  supportAddresses: ["support@example.com"], // mail from these is a loop
  queueTerminalRetentionMilliseconds: 30 * 86_400_000,
  threadIndexRetentionMilliseconds: 365 * 86_400_000,
});

const result = await inbound.processInboundEmail(normalizedProviderEvent);
```

For tickets with `requester.email`, routing tokens, threading headers, and
subject markers join only when the case-insensitive normalized `from` address
equals that email and `senderAuthentication` passes for the same normalized
address. Missing, failed, unaligned, or differently bound results create a new
unverified ticket with a staff-only relationship hint; they never change or
reopen the named ticket. For tickets without a requester email, only the
high-entropy routing token remains a bearer write path. Threading headers and
subject markers alone do not join those tickets.

The account matcher answers whether a sender address matches zero, one, or
several accounts. Only a unique match yields a `matched_email` ticket, and
that ticket is still invisible to the account's web session: an email match
never authenticates, never selects an `AccessContext`, and never enters the
verified-session path. The routing policy receives only the association, an
optional matched principal, and an optional related ticket (never the subject
or body) and may return `low`, `normal`, or `high` plus an allowlisted
category. Inbound mail is never automatically `urgent`.

To make replies thread by key lookup, give outbound notifications a
cryptographically random `replyRoutingToken` (22 to 128 URL-safe characters)
and render it into the reply address, for example `support+<token>@example.com`.
Support Desk indexes its SHA-256 key and the notification `Message-ID` when
the command commits. Hosts must not acknowledge the sender when
`senderAcknowledgementAllowed` is false, and should not auto-acknowledge
unverified senders at all, to avoid backscatter.

Map inbound outcomes for the provider, not for a browser:

| Outcome                                                                               | Provider response                                                                                     |
| ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `created`, `replied`, `duplicate_message`, `suppressed`, `rejected`                   | success (acknowledge; retries return the same result)                                                 |
| `TypeError` or `SupportDeskLimitError` from input validation                          | acknowledge and dead-letter for review; do not retry the same payload                                 |
| `SupportDeskConflictError` (event-ID/content reuse or receipt/command slot collision) | acknowledge and alert; never reprocess as new mail                                                    |
| `SupportDeskConflictError` (concurrent ticket updates exhausted retries)              | non-success so the provider retries the same event; the receipt stays `processing` and resumes safely |
| Store unavailable or unexpected failure                                               | non-success so the provider retries                                                                   |

Inspect the conflict message: contention reports `Concurrent ticket updates
exhausted retries` and explicitly permits retrying the same event. Content
reuse and slot collisions retain their distinct diagnostics. Do not treat every
`SupportDeskConflictError` as poisoned content; other unexpected conflicts
also need a non-success response so the provider retries.

## Host-owned schedulers

The host owns wakeups (Cron Trigger, Timer, queue, or operator action). Wire
the seven direct loops through `@pegma/scheduler` at the composition root:
register static task ids once, map each domain page’s `nextCursor` to
`nextCheckpoint`, and let the scheduler own leases and durable checkpoints.
Never share a checkpoint across loops or Support Desk instances. Crash before
fenced completion may repeat a page; claims and conditional writes make that
safe. The example composition under `examples/composition` uses
`createScheduler` + `runManual` for these seven tasks.

Receipt and principal sweeps stay **outside** the static scheduler registry:
the host selects buckets/principals per invocation and must not invent dynamic
task ids per bucket.

| Loop                            | Entry point                                                                                     | Coordination                           | Notes                                                                                |
| ------------------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------ |
| Mail send                       | `supportMail.worker(...).runSendPage`                                                           | scheduler task `mail.send`             | Claims pending jobs and calls the host provider                                      |
| Mail reconciliation             | `supportMail.worker(...).runReconciliationPage`                                                 | scheduler task `mail.reconcile`        | Resolves ambiguous acceptance                                                        |
| Mail terminal sweep             | `supportMail.sweep(records, { terminalBefore, cursor, limit })`                                 | scheduler task `mail.terminal-sweep`   | Deletes acknowledged terminal jobs older than the cutoff                             |
| Customer-index prune            | `pruneCustomerTicketIndex(store, principalId, { reservedBefore })`                              | host-selected; not a scheduler task id | Drops stale reservations; confirmed ownership is rechecked                           |
| Inbound receipt sweep           | `sweepInboundReceipts(store, clock, { bucket, processedBefore })`                               | host-selected per bucket               | Terminal receipts only; never deletes `processing` or `rerouting` receipts           |
| Delivery-callback receipt sweep | `sweepDeliveryCallbackReceipts(store, clock, { bucket, processedBefore })`                      | host-selected per bucket               | Retains the 30-day dedupe horizon                                                    |
| Queue reconciliation / repair   | `repairQueueProjectionPage({ store, clock, terminalRetentionMilliseconds, cursor, limit })`     | scheduler task `queue.repair`          | Scans authoritative tickets and rewrites projection rows                             |
| Queue inactive-row sweep        | `sweepInactiveQueueProjections({ store, clock, terminalRetentionMilliseconds, cursor, limit })` | scheduler task `queue.inactive-sweep`  | Conditionally deletes inactive projection rows only after reloading the ticket       |
| Thread-index repair             | `repairThreadIndexPage({ store, clock, threadIndexRetentionMilliseconds, cursor, limit })`      | scheduler task `thread-index.repair`   | Re-derives `Message-ID`, reply-token, and ticket-number rows from authoritative rows |
| Thread-index sweep              | `sweepThreadIndexPage({ store, clock, threadIndexRetentionMilliseconds, cursor, limit })`       | scheduler task `thread-index.sweep`    | Conditionally deletes rows whose target is gone or past retention                    |

Projection, repair, and inactive sweep must share the same
`terminalRetentionMilliseconds` value configured on the application (and on
the inbound processor's `queueTerminalRetentionMilliseconds`). Thread-index
repair and sweep must share the inbound processor's
`threadIndexRetentionMilliseconds`. Run at least one complete thread-index
repair cycle after upgrading so tickets created earlier gain index rows.

Online staff queue reads (`listStaffQueue`) start at a null cursor and use only
request-local cursors. They never resume another request's scan and never
authorize access from the projection alone.

## What hosts still own

- authentication and CSRF for browser forms;
- Authorization Core policy that grants Support Desk permission names;
- durable `@pegma/rate-limit` policies on create and reply;
- mail provider credentials, callback verification, and sender domains;
- inbound webhook verification, MIME bounds and normalization, reply-address
  token rendering, sender evaluation, the account matcher, and the inbound
  routing policy;
- template packs and public ticket URLs;
- health metrics without message content;
- retention, export, redaction, and operator access procedures.
