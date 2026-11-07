# Support Desk

[![CI](https://github.com/pegma-dev/support-desk/actions/workflows/ci.yml/badge.svg)](https://github.com/pegma-dev/support-desk/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A composable, open-source support queue for web and email.

> [!IMPORTANT]
> Support Desk is in early `0.x` development. Source packages stay at exact
> `0.1.1`; lifecycle and SD-01 additions are unreleased and differ from the
> published artifacts at that version. Hosts must consume published
> versions and cannot substitute Git branches, copied source, or local paths.

Implemented in source today: the customer-facing and staff application
services, the repairable staff queue projection, declared collections,
Authorization Core permission boundaries, transactional audit and mail
projections, provider-neutral outbound workers and callbacks, safe versioned
templates, provider-neutral inbound mail processing with key-lookup threading
indexes and loop controls, and a host-neutral composition example. Staff-managed
tags, host-computed response targets and milestones, and revision collision hints are also implemented
(Buildout Task 13), with all new metadata limited to staff views. Durable host
deployments, customer UI, staff UI, inbound provider adapters, and production
hardening remain later buildout tasks. Task 12 stays pending on host durable-store
evidence; Task 13 changes are additive and package versions remain `0.1.1`.

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

The approved [knowledge-base and AI support implementation plan](docs/KNOWLEDGE_AI_PLAN.md)
defines the next enhancement: a standalone API/MCP-authored KB and an optional
ticket-backed support agent, with working integrations on both launch hosts.
It records the agreed scope and task sequence. SD-01 is implemented in source
via [PR #34](https://github.com/pegma-dev/support-desk/pull/34): optional web
assistant handling, explicit attribution and completion fences, deterministic
human controls and atomic handoff work, private customer success evidence,
and human queue separation. It includes no model or KB integration and has not
been published. Standalone KB-01 through KB-04, AUTH-01 Agent Access, and both
producers' release preparation are merged. The four KB packages and
`@pegma/agent-access` remain unpublished at source `0.1.0`; first-publisher
bootstrap and verified registry publication remain open. PG-01/RG-01 require
both published producers before host assembly and actual existing-login/Admin
consent and requested-client proof before activation or pilots. SD-02 waits
for KB-05 publication. Synthetic SDK/source proof uses no actual customer data
and does not close host privacy, operations, full-workflow, or pilot gates.
See the [producer evidence and bootstrap handoff](docs/HOST_COMPOSITION.md#kb-authoring-producers).
Use the [implementation ledger](docs/KNOWLEDGE_AI_PLAN.md#status-and-reading-order)
for merged-source evidence and the remaining release and activation gates.
The [P-00 handoff](docs/KNOWLEDGE_AI_P00.md) supplies the package baseline,
synthetic evaluation fixtures, capacity checks, and prerequisites for implementation.
Passing that harness does not establish a working KB, bot, or host deployment.

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
- **Human support first:** The approved enhancement permits evaluated AI
  answers and escalation with explicit permissions, audit, and human handoff.
  Staff initially approve knowledge publication, issue export, and release
  follow-up; AI can never increase a caller's permissions.

## Current packages

| Package                           | Purpose                                                      |
| --------------------------------- | ------------------------------------------------------------ |
| `@pegma/support-desk-contracts`   | Provider-neutral ticket, message, requester, and event types |
| `@pegma/support-desk-core`        | Pure ticket creation and workflow transitions                |
| `@pegma/support-desk-application` | Authorized customer services, collections, audit, and outbox |
| `@pegma/support-desk-templates`   | Safe versioned templates and optional host-branded packs     |

The first `0.1.0` set is published under the `@pegma` scope. Current source
packages remain at exact `0.1.1`; unreleased lifecycle/SD-01 source is not
registry-equivalent and does not publish a new set. A future synchronized
SD-06 release is required before enhancement adoption. Follow
[docs/RELEASING.md](docs/RELEASING.md) for releases. There is
deliberately no storage package and no access package. Inbound mail processing
is implemented (Buildout Task 11); host adapters, production hardening, and the
knowledge pipeline remain later work. See the
[project plan](docs/PROJECT_PLAN.md) and
[declared-collection reference](docs/COLLECTIONS.md).

## Example

A complete memory-backed composition (customer + staff + fake mail + worker
cursors, no framework) lives in
[examples/composition](examples/composition/README.md):

```sh
npm install -g corepack
corepack enable
pnpm install --frozen-lockfile
pnpm run example
```

Host HTTP mapping and scheduler ownership are documented in
[docs/HOST_COMPOSITION.md](docs/HOST_COMPOSITION.md).

Pure domain transitions remain available from core:

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

Support Desk requires Node.js 22 or newer. Corepack is bundled through
Node 24; on Node 25 or newer, install it first.

```sh
npm install -g corepack
corepack enable
pnpm install --frozen-lockfile
pnpm run check
pnpm test
pnpm run format:check
```

## Documentation

- [MVP specification](docs/MVP_SPEC.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Project plan](docs/PROJECT_PLAN.md)
- [Knowledge base and AI implementation plan](docs/KNOWLEDGE_AI_PLAN.md)
- [Declared collections](docs/COLLECTIONS.md)
- [Host composition](docs/HOST_COMPOSITION.md)
- [Release notes](docs/RELEASE_NOTES.md)
- [Releasing](docs/RELEASING.md)

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
