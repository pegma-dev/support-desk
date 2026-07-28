# Support Desk

[![CI](https://github.com/pegma-dev/support-desk/actions/workflows/ci.yml/badge.svg)](https://github.com/pegma-dev/support-desk/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A composable, open-source support queue for web and email.

> [!IMPORTANT]
> Support Desk is in early `0.x` development. Its public API is not stable, its
> packages are not published, and it is not ready for production use.

Implemented in source today: the customer-facing application services and
declared collections, Authorization Core permission boundaries, transactional
audit and mail projections, provider-neutral outbound workers and callbacks,
and safe versioned templates. The durable reference deployment, customer UI,
staff queue, inbound mailbox, and first package release remain future phases.

## What it will do

Support Desk is intended to provide:

- authenticated customer ticket creation and follow-up;
- a central queue for support staff;
- threaded web and email replies;
- inbound support-email ingestion;
- branded notification templates;
- provider-neutral identity, authorization, mail, and storage boundaries;
- an eventual knowledge pipeline and AI support assistant.

The first release will stay deliberately smaller than that vision. See the
[MVP specification](docs/MVP_SPEC.md) and
[project plan](docs/PROJECT_PLAN.md).

## How the pieces fit

```text
Customer web form ───┐
                     ├──> Ticket + message core ──> Support queue
Inbound email ───────┘               │
                                     ├──> Branded notifications
Authorization Core ──> permissions ──┘
                                     │
Resolved tickets ────────────────────┴──> Future knowledge pipeline
```

## Part of Pegma

Support Desk is one component of **Pegma**, a family of MIT-licensed packages
that a host application composes. It deliberately does not build everything it
needs:

| Concern                                    | Comes from                                                                     |
| ------------------------------------------ | ------------------------------------------------------------------------------ |
| Persistence                                | [`@pegma/storage-core`](https://github.com/pegma-dev/storage-core)             |
| Identity and permissions                   | [`@pegma/authorization-core`](https://github.com/pegma-dev/authorization-core) |
| Durable mail delivery                      | [`@pegma/mail`](https://github.com/pegma-dev/mail)                             |
| `PrincipalId`, clock, logger, typed events | [`@pegma/spine`](https://github.com/pegma-dev/spine)                           |

Support Desk declares collections against `@pegma/storage-core` and takes a
`Store` from the host, so the backend is the host's choice rather than this
project's. It asks Authorization Core whether a principal holds a permission;
it has no access model of its own. It projects `@pegma/mail` jobs into the
ticket partition and leaves provider and content-preparation adapters to the
host. Support-owned template snapshots remain beside their messages.

The organization profile is at
[github.com/pegma-dev](https://github.com/pegma-dev).

## Design principles

- **One conversation model:** Web and email messages join the same ticket
  thread.
- **Provider-neutral boundaries:** Mail, notifications, and templates are
  adapters. Persistence and permissions are sibling Pegma packages.
- **Permission-based access:** Applications authorize actions, not plan or role
  names.
- **Untrusted content by default:** Sender identity, HTML, links, attachments,
  and quoted email text require explicit handling.
- **Auditability:** Staff actions and state changes must be attributable.
- **Embeddable first:** The initial product is a library and reference API, not
  a hosted multi-tenant service.
- **Human support first:** AI may suggest or retrieve; it does not silently
  become the authority for customer-impacting actions.

## Current packages

| Package                           | Purpose                                                      |
| --------------------------------- | ------------------------------------------------------------ |
| `@pegma/support-desk-contracts`   | Provider-neutral ticket, message, requester, and event types |
| `@pegma/support-desk-core`        | Pure ticket creation and workflow transitions                |
| `@pegma/support-desk-application` | Authorized customer services, collections, audit, and outbox |
| `@pegma/support-desk-templates`   | Safe versioned templates and optional host-branded packs     |

Packages publish under the `@pegma` scope. Nothing here is published yet.

There is deliberately no storage package and no access package. Staff queue,
inbound email, and the knowledge pipeline remain future work; see the
[project plan](docs/PROJECT_PLAN.md) and
[declared-collection reference](docs/COLLECTIONS.md).

## Example

```ts
import { applyTicketEvent, createTicket } from "@pegma/support-desk-core";

const ticket = createTicket({
  id: "ticket_01",
  number: 1042,
  subject: "I cannot access my subscription",
  channel: "web",
  priority: "normal",
  requester: {
    association: "authenticated",
    principalId: "account_123",
    email: "customer@example.com",
  },
  createdAt: "2026-07-24T13:00:00.000Z",
});

const waiting = applyTicketEvent(ticket, {
  type: "support_replied",
  occurredAt: "2026-07-24T13:05:00.000Z",
  actorId: "staff_456",
});

// waiting.status === "waiting_on_customer"
```

The core is pure: it performs no I/O and makes no authorization decision. The
host authenticates, resolves permissions through Authorization Core, supplies a
`@pegma/storage-core` `Store`, and loads the current ticket revision before
applying an event. Durability, idempotency, and message delivery are the
application layer's job, built on declared collections rather than on a storage
layer written here.

## Development

Support Desk requires Node.js 22 or newer.

```sh
npm ci
npm run check
npm test
npm run format:check
```

## Documentation

- [MVP specification](docs/MVP_SPEC.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Project plan](docs/PROJECT_PLAN.md)
- [Declared collections](docs/COLLECTIONS.md)

## Contributing and security

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) before
opening a pull request.

Support conversations can contain sensitive information. Do not report
vulnerabilities in public issues; follow [SECURITY.md](SECURITY.md).

## Origin

Support Desk was created by [RetireGolden](https://retiregolden.org) as a
reusable support component for modern SaaS applications. The core project is
intentionally not retirement-specific.

## License

[MIT](LICENSE) © 2026 RetireGolden, LLC
