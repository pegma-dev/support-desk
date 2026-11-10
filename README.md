# Support Desk

[![CI](https://github.com/pegma-dev/support-desk/actions/workflows/ci.yml/badge.svg)](https://github.com/pegma-dev/support-desk/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A composable, open-source support queue for web and email.

> [!IMPORTANT]
> Support Desk is in early `0.x` development. The synchronized `0.2.1` release
> includes the optional AI workflows and is published and strictly verified.
> Hosts must consume published versions and satisfy their own activation gates;
> Git branches, copied source, or local paths are not release substitutes.

The synchronized `0.2.1` patch for assistant-answering read batching is
**published and strictly verified**; see the
[2026-11-10 publication receipt](docs/RELEASING.md#verified-021-publication-2026-11-10).
The optional AI package retains exact KB `0.1.2` dependencies. Grouped reads do
not establish a universal query or CPU budget or close host acceptance.

All five source packages are now synchronized at **unpublished `0.2.2` candidate**
versions for [opt-in staged retrieval](docs/ASSISTANT_COORDINATION.md#opt-in-durable-staged-retrieval),
documented in the [AI package guide](packages/ai/README.md#opt-in-staged-retrieval-022-candidate).
The default remains monolithic. Preparation uses an existing attempt, so both
application and verified-configuration caps must allow at least two attempts;
no counters or caps reset. After `prepared`, return from the physical invocation
and resume only in a subsequent one. This candidate requires its own full gates,
review, trusted publication and strict verification. Host adoption separately
requires measured whole-invocation/CPU acceptance. `0.2.1` remains the current
qualified release.

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
evidence; the current verified package release is `0.2.1`.

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
and human queue separation. That source slice includes no model or KB integration
and shipped in `0.2.0`. Standalone KB-01 through KB-04, AUTH-01 Agent Access, partial
KB-05 source preparation ([KB #4](https://github.com/pegma-dev/knowledge-base/pull/4)),
and both producers' final release preparation are merged. The four KB packages
have verified trusted `0.1.4` registry releases, and `@pegma/agent-access` has
a verified trusted `0.1.1` release;
the KB-05 publication prerequisite for SD-02 is closed. SD-02's optional
`@pegma/support-desk-ai` coordinator and bounded ticket-partition turn jobs
are merged in [PR #38](https://github.com/pegma-dev/support-desk/pull/38)
after review and validation and shipped in `0.2.0`. PG-01/RG-01 consume exact published
producers and still require actual existing-login/Admin consent and
requested-client proof before activation or pilots. Synthetic SDK/source proof uses no actual customer data
and does not close host privacy, operations, full-workflow, or pilot gates.
See the [producer evidence and bootstrap handoff](docs/HOST_COMPOSITION.md#kb-authoring-producers).
The [assistant coordination guide](docs/ASSISTANT_COORDINATION.md) and
[layout checkpoint](docs/COLLECTIONS.md#sd-02-assistant-turn-layout-checkpoint)
describe the SDK contracts. The base application works without AI; only
the optional coordinator depends on KB. Its released `0.2.1` manifest keeps
exact KB `0.1.2` dependencies; the separate standalone-authoring recipe selects
KB `0.1.4` and Agent Access `0.1.1` in the producer handoff above. The
[verified 0.2.1 publication receipt](docs/RELEASING.md#verified-021-publication-2026-11-10)
records the exact release; host adoption retains its own acceptance gates.
Use the [implementation ledger](docs/KNOWLEDGE_AI_PLAN.md#status-and-reading-order)
for source/release evidence and the remaining activation gates.
The [P-00 handoff](docs/KNOWLEDGE_AI_P00.md) supplies the package baseline,
synthetic evaluation fixtures, capacity checks, and prerequisites for implementation.
Passing that harness does not establish a working KB, bot, or host deployment.

SD-03's opt-in resolution-learning source merged in
[PR #39](https://github.com/pegma-dev/support-desk/pull/39).
Its ticket-side evidence, exact review, withdrawal, and recovery contracts
preserve human support and permanent privacy withdrawal capacity. See the
[resolution learning guide](docs/RESOLUTION_LEARNING.md) for permissions,
storage reserves, composition, implemented boundaries, and current validation gates.

SD-04's verified bug evidence, admin repository policy, calibrated routing,
exact staff-approved export and reconciliation source merged in
[PR #40](https://github.com/pegma-dev/support-desk/pull/40).
See the [engineering export guide](docs/ENGINEERING_EXPORT.md). These capabilities
shipped in `0.2.0`; host activation remains separate.

SD-05 merged in [PR #41](https://github.com/pegma-dev/support-desk/pull/41),
adding confirmed-deployment follow-up, private KB change/retest proposals
and staff-approved web notices. See the
[follow-up guide](docs/ENGINEERING_FOLLOWUP.md) for the current contracts and gates.

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

| Package                           | Purpose                                                                 |
| --------------------------------- | ----------------------------------------------------------------------- |
| `@pegma/support-desk-contracts`   | Provider-neutral ticket, message, requester, and event types            |
| `@pegma/support-desk-core`        | Pure ticket creation and workflow transitions                           |
| `@pegma/support-desk-application` | Authorized customer services, collections, audit, and outbox            |
| `@pegma/support-desk-templates`   | Safe versioned templates and optional host-branded packs                |
| `@pegma/support-desk-ai`          | Optional answers, resolution learning, engineering export and follow-up |

All five packages are published under the `@pegma` scope at verified
[`0.2.1`](https://github.com/pegma-dev/support-desk/releases/tag/v0.2.1), with
`latest` recorded at `0.2.1` during verification on 2026-11-10. The optional AI package's
registration-only `bootstrap` remains `0.1.1`; earlier registry versions are
immutable history. The [publication receipt](docs/RELEASING.md#verified-021-publication-2026-11-10)
records the original artifacts and strict verification. There is
deliberately no storage package and no access package. Inbound mail processing
is implemented (Buildout Task 11); host adapters, production hardening, and the
host activation remain later work. See the
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

The optional [AI composition](examples/ai/README.md) uses the public SDKs,
real Store services, and synthetic provider ports for answers, human handoff,
resolution learning, verified bug association, and staff-approved follow-up:

```sh
pnpm run ai:example
```

Read [upgrading](docs/UPGRADING.md) and [AI operations](docs/AI_OPERATIONS.md)
before composing these workflows in a host.

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
- [Assistant coordination](docs/ASSISTANT_COORDINATION.md)
- [Resolution learning](docs/RESOLUTION_LEARNING.md)
- [Engineering export](docs/ENGINEERING_EXPORT.md)
- [Release follow-up](docs/ENGINEERING_FOLLOWUP.md)
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
