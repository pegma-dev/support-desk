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

- `@pegma/spine@0.1.1`
- `@pegma/storage-core@0.4.0`
- `@pegma/authorization-core@0.1.2`
- `@pegma/audit@0.1.0`
- `@pegma/mail@0.1.0`

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

`TicketWorkflowError` from lifecycle transitions is a refused state change; hosts
typically map it to `409` after the caller was already authorized.

## Host-owned schedulers

Every loop below is host-scheduled. Persist one opaque cursor per loop after
each complete page succeeds. Never share a cursor across loops or across
Support Desk instances. Crash before cursor persistence may repeat a page;
claims and conditional writes make that safe.

| Loop                            | Entry point                                                                                     | Cursor                                    | Notes                                                                               |
| ------------------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------- |
| Mail send                       | `supportMail.worker(...).runSendPage`                                                           | host key `mail.send` (name is host-local) | Claims pending jobs and calls the host provider                                     |
| Mail reconciliation             | `supportMail.worker(...).runReconciliationPage`                                                 | separate from send                        | Resolves ambiguous acceptance                                                       |
| Mail terminal sweep             | `supportMail.sweep(records, { terminalBefore, cursor, limit })`                                 | separate from send/reconcile              | Deletes acknowledged terminal jobs older than the cutoff                            |
| Customer-index prune            | `pruneCustomerTicketIndex(store, principalId, { reservedBefore })`                              | optional host bookmark by principal/time  | Drops stale reservations; confirmed ownership is rechecked                          |
| Inbound receipt sweep           | `sweepInboundReceipts(store, clock, { bucket, processedBefore })`                               | per-bucket host plan                      | Inbound processing is still a later buildout task; the collection and sweeper exist |
| Delivery-callback receipt sweep | `sweepDeliveryCallbackReceipts(store, clock, { bucket, processedBefore })`                      | per-bucket host plan                      | Retains the 30-day dedupe horizon                                                   |
| Queue reconciliation / repair   | `repairQueueProjectionPage({ store, clock, terminalRetentionMilliseconds, cursor, limit })`     | host key `queue.repair`                   | Scans authoritative tickets and rewrites projection rows                            |
| Queue inactive-row sweep        | `sweepInactiveQueueProjections({ store, clock, terminalRetentionMilliseconds, cursor, limit })` | host key `queue.inactive-sweep`           | Conditionally deletes inactive projection rows only after reloading the ticket      |

Projection, repair, and inactive sweep must share the same
`terminalRetentionMilliseconds` value configured on the application.

Online staff queue reads (`listStaffQueue`) start at a null cursor and use only
request-local cursors. They never resume another request's scan and never
authorize access from the projection alone.

## What hosts still own

- authentication and CSRF for browser forms;
- Authorization Core policy that grants Support Desk permission names;
- durable `@pegma/rate-limit` policies on create and reply;
- mail provider credentials, callback verification, and sender domains;
- template packs and public ticket URLs;
- health metrics without message content;
- retention, export, redaction, and operator access procedures.
