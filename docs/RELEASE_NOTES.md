# Release notes

## 0.2.2 — opt-in staged retrieval (unreleased)

All five source packages are synchronized at `0.2.2` for this unpublished
candidate. [Opt-in staged retrieval](ASSISTANT_COORDINATION.md#opt-in-durable-staged-retrieval)
splits preparation and paid generation across separate physical invocations;
see the [AI package guide](../packages/ai/README.md#opt-in-staged-retrieval-022-candidate).
Omission retains the monolithic path. Preparation consumes an existing attempt,
so both application and verified-configuration caps must allow at least two
attempts, without resetting counters or raising caps. After `prepared`, the
host must return and resume only in a subsequent physical invocation.

The candidate requires its own full current-head Node 22/24 gates, review,
trusted publication and strict registry/consumer verification. Host adoption
separately requires measured invocation/CPU acceptance; this protocol establishes
no universal Free-plan budget.
The current qualified release remains `0.2.1`; its receipt and history below
are unchanged.

## 0.2.1 — assistant-answering read batching, 2026-11-10

This published synchronized patch advances contracts, core, templates, application,
and optional `@pegma/support-desk-ai` to `0.2.1`, with matching exact internal
Support pins. The application groups independent answering reads for Store
adapters that can batch them while retaining current authority, ticket and
assistant-turn fences and customer/private-message boundaries.

The base application remains independent of KB and model providers. The
optional AI package retains exact KB application and contracts `0.1.2` pins.
No universal query or CPU budget, host activation, or live-provider acceptance
is established by SDK publication.

All five exact `0.2.1` packages completed Node 22/24 validation, review,
packed-consumer checks, trusted publication and strict registry verification.
The [2026-11-10 publication receipt](RELEASING.md#verified-021-publication-2026-11-10)
binds their signed source, original prepared artifacts and final verification.
The dated `0.2.0` receipt and earlier immutable artifacts below are unchanged;
host adoption and activation retain their own acceptance gates.

## 0.2.0 — synchronized optional AI workflows (SD-06), 2026-11-08

All five packages are published and strictly verified at exact `0.2.0`:
contracts, core, templates, application, and optional `@pegma/support-desk-ai`.
The [publication receipt](RELEASING.md#verified-sd-06-publication-2026-11-08)
records the exact signed source, original artifacts and registry verification.
The original four published `0.1.1` artifacts remain immutable. Hosts consume
the verified synchronized registry set and retain their own activation gates.

The release includes the merged source phases:

| Phase | Source and behavior                                                                                                                                                                                                               |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SD-01 | [PR #34](https://github.com/pegma-dev/support-desk/pull/34): optional assistant handling, deterministic human controls, bounded handoffs, and explicit customer success confirmation.                                             |
| SD-02 | [PR #38](https://github.com/pegma-dev/support-desk/pull/38): bounded assistant jobs, current-source/authority fences, durable usage recovery, and exact answer or human-handoff commit.                                           |
| SD-03 | [PR #39](https://github.com/pegma-dev/support-desk/pull/39): private resolution evidence and learning drafts, independent delivery checks, exact KB requests, review/publication source gates, and conditional cleanup.           |
| SD-04 | [PR #40](https://github.com/pegma-dev/support-desk/pull/40): verified bug evidence, bounded repository policy and routing, exact sanitized export review, one physical issue-create attempt, and uncertain-result reconciliation. |
| SD-05 | [PR #41](https://github.com/pegma-dev/support-desk/pull/41): trusted issue/deployment observations, private reassessment proposals, optional advisory retests, and explicit staff-reviewed web notices.                           |

Historical Phase 5 source validation at
`eddd3526f8bec3a1a80cc7aacd3a4cdcdb950cfe` recorded **2,173 tests across 48
test files**, with separate release-metadata, five-package pack, and example
receipts. That receipt describes the merged SD-05 source. It does not certify
the new SD-06 artifacts, registry-to-candidate migration, or publication.

The base application remains independent of KB, model providers, and GitHub.
Human support works with optional AI disabled. The optional AI package uses
exact verified KB `0.1.2`; the release uses Authorization Core `0.4.0` and
Spine `0.1.2`. New permissions, trusted ports, finite reserves, current proof,
and host-owned scheduling are explicit opt-ins. No workflow automatically
publishes KB content, resolves a ticket from a release, or grants host roles.

The new AI name has a separate manual registration-only `0.1.1`
[bootstrap](AI_BOOTSTRAP.md). It has no OIDC provenance and is not host-usable:
the older registry application `0.1.1` lacks required newer exports. That
registration is separate from the advertised five-package `0.2.0` release.

Read [upgrading](UPGRADING.md) before writing new rows. The clean-consumer
upgrade proof must start with the actual old published application; it does
not promise that older codecs can read new records. The operational fallback
is human support on the new SDK with generation/export disabled, while
recovery and reconciliation remain available. See [AI operations](AI_OPERATIONS.md)
and the individual [answer](ASSISTANT_COORDINATION.md),
[learning](RESOLUTION_LEARNING.md), [export](ENGINEERING_EXPORT.md), and
[follow-up](ENGINEERING_FOLLOWUP.md) handbooks.

The [publication receipt](RELEASING.md#verified-sd-06-publication-2026-11-08)
records the completed SDK gates, original artifacts, consumers and strict
stable verification. Subsequent changes need their own current-head gates and
reviews; SDK release evidence does not establish host provider configuration.
Actual host login/Admin consent, requested clients, privacy controls, staging,
durable-store production evidence, full workflows, and supervised pilots remain
separate host gates. Synthetic SDK examples use fictional data and close none
of those acceptance gates.

## Merged source history — handling and deterministic controls (SD-01)

Implemented via [PR #34](https://github.com/pegma-dev/support-desk/pull/34)
without a publication change at that time; included in the release above.
Task 12's host production-evidence gates remain open.

- Optional web-only assistant handling requires trusted host opt-in and
  dedicated permissions. Assistant attribution and exact ticket revision,
  handling generation, and triggering-message checks prevent stale replies;
  assistant messages never satisfy the first staff response milestone.
- Human queue selection confirms current authoritative handling. Owned
  request-person, staff takeover, and escalation work without a model; handoff
  state, compact transcript references, bounded work, Audit, and receipts
  commit together. Staff reopen routes explicit handling to human-pending.
- Explicit owned customer success confirmation binds the latest visible
  message and resolves with private structured evidence in the same
  transaction. Internal revisions, notes, and evidence stay out of customer
  responses. Repeating an already satisfied control adds no rows.
- Disabling assistant handling blocks fresh assistant starts and replies.
  Previously accepted create/reply commands can still replay after current
  permission and resource checks. Human controls and escalation remain
  available under their own checks.
- Handoff summaries are capped at 2,000 UTF-16 code units; attempted guides at
  16 opaque IDs of 200 units each. Complete serialized handoff and assistant
  message records are capped at 60,000 UTF-16 bytes before commit. Managed
  quotas preserve 12 physical rows and one human message slot across ordinary
  writes until the first staff response; controls retain a four-row/one-message
  tail for that reply. Hard partition limits still apply.

Upgrade: omitted legacy handling remains implicit human-pending without a
stored migration; existing omitted-option fingerprints and quota limits are
preserved. Explicit takeover records human-active handling. Fresh email stays
human-handled, and verified email joining assistant chat hands off to humans.
Run the existing queue repair cycle. See
[host composition](HOST_COMPOSITION.md#optional-handling-and-deterministic-controls-sd-01)
and [capacity details](COLLECTIONS.md#sd-01-handling-and-handoff-layout-checkpoint).

SD-01 alone added no model integration, KB dependency, or new package.
Subsequent phases are included in the synchronized release above. Producer
publication and host acceptance are distinct; the
[producer evidence](HOST_COMPOSITION.md#kb-authoring-producers) does not replace
actual host login/Admin consent, requested-client, privacy, full-workflow, or
pilot evidence.

## Merged source history — lifecycle extras (Buildout Task 13)

Additive package work originally made against source `0.1.1`, without a
publication change then; included in the release above. Task 12 remains
pending on the hosts' durable-store production evidence.

- Optional bounded host `allowedTags` and `maxTagsPerTicket`; staff `setTags`
  with `support.ticket.manage`, normalized idempotency, transactional
  `support.ticket.tags_changed` Audit action, and staff-time-only changes.
- Optional `ResponseTargetPolicy` on application and inbound processing;
  canonical first-response/resolution due dates, one-time first staff response,
  current-resolution milestones, and confirmed queue tag/target filters and due
  sorting. Hosts own calendars and presence. Customer DTOs and automatic
  customer mail omit the new staff fields.
- Optional `expectedRevision` on every staff mutation and content-safe
  `SupportDeskStaleRevisionError` (HTTP 409). Exact new staff receipts replay
  the original ticket and message revision cutoff even after later edits.

Upgrade: existing tickets and receipts remain readable. Missing tags mean no
tags; absent targets do not match due filters; first-response milestones are
not inferred from history. Configure the same target policy on web and inbound
composition, and run a complete queue repair cycle to enrich legacy projection
rows. No automatic target backfill or new worker is introduced. See
[host composition](HOST_COMPOSITION.md#optional-lifecycle-extras-task-13).

## Merged source history — inbound mail (Buildout Task 11)

Originally additive to the `0.1.1` source surface without publication;
included in the synchronized release above.

- `@pegma/support-desk-application`: `createInboundMailProcessor` with the
  `InboundEmailInput`, `InboundAccountMatcher`, `InboundRoutingPolicy`, and
  `InboundNotificationPolicy` ports; the implemented inbound receipt
  lifecycle; the new `support-desk.thread-index.v1` collection with
  `repairThreadIndexPage` and `sweepThreadIndexPage`; optional
  `replyRoutingToken` on `NotificationInput` and `DeliveryContent`; optional
  receipt fields for reserved identifiers, routing, and outcome. Existing
  email-backed ticket joins also require the snapshotted host sender result to
  pass for the same normalized address. Receipt fingerprints use that same
  case-insensitive address equivalence, `host_identity` rejects DMARC-only
  alignment fields, and a repeated inbound `Message-ID` precedes the
  subject-marker fallback.
- `@pegma/support-desk-contracts`: `InboundSenderAuthentication`, optional
  staff-only `Ticket.relatedTicketId`, and
  `CreateTicketInput.relatedTicketId`.
- `@pegma/support-desk-core`: `createTicket` validates and preserves
  `relatedTicketId`.

Upgrade note: after deploying, run one complete `repairThreadIndexPage` cycle
so tickets and notifications recorded earlier gain threading rows. Hosts must
populate `senderAuthentication` before email-backed tickets can accept replies;
email-less tickets retain their high-entropy routing-token flow. Processing
receipts carrying an older reply route are rechecked before ticket work, while
an already committed command retains its replay result. A nonqualifying older
route first claims a resumable `rerouting` receipt. Reply normalization reserves
one permanent fence in the named ticket partition; the fence counts toward
`maxRecordsPerTicket` and is refused when the partition has no remaining record
capacity. Related-conversation normalization uses a temporary command-key fence
that the normalized create consumes. Receipts without the canonical replay
field recognize only the exact earlier payload shapes and atomically bind the
current replay fingerprint; their immutable payload fingerprint continues to
identify ticket work already committed before receipt finalization.

## 0.1.1 — dependency alignment

A dependency-only release of the synchronized four-package set.
`@pegma/support-desk-application` advances `@pegma/audit` to `0.2.0`,
`@pegma/authorization-core` to `0.2.0`, and `@pegma/mail` to `0.1.1`, so the
dependency tree resolves a single `@pegma/storage-core@0.4.0` — previously
audit's transitive `storage-core@0.3.0` split hosts' trees into two
incompatible `Store` types. The application package already required a
storage-core `0.4.0` `Store`; runtime behavior and the public API of all four
packages are unchanged.

## 0.1.0 — first advertised supported release

Status: published. All four packages are on the public npm registry at exact
`0.1.0`, and the signed annotated `v0.1.0` tag and its GitHub release mark
the release commit. Hosts may depend on the published packages; a Git branch,
copied source, local path, or unpublished tarball remains forbidden as a
production dependency.

### Packages

| Package                           | Version |
| --------------------------------- | ------- |
| `@pegma/support-desk-contracts`   | `0.1.0` |
| `@pegma/support-desk-core`        | `0.1.0` |
| `@pegma/support-desk-templates`   | `0.1.0` |
| `@pegma/support-desk-application` | `0.1.0` |

### Surface

- provider-neutral ticket, message, requester, and lifecycle contracts;
- pure ticket creation and revisioned workflow transitions;
- authorized customer create/list/read/reply with safe customer DTOs;
- authorized staff detail, mutations, audit history, and repairable queue
  projection;
- transactional `@pegma/audit@0.1.0` accepted-change records and
  `@pegma/mail@0.1.0` delivery projection in the ticket partition;
- safe versioned templates with an optional RetireGolden-branded pack export;
- host-owned worker entry points for mail send/reconcile/sweep, queue repair
  and inactive-row sweep, customer-index prune, and receipt sweeps.

### Exact dependencies

- `@pegma/spine@0.1.1`
- `@pegma/storage-core@0.4.0`
- `@pegma/authorization-core@0.1.2`
- `@pegma/audit@0.1.0`
- `@pegma/mail@0.1.0`

### Host integration

See [HOST_COMPOSITION.md](HOST_COMPOSITION.md) for error-to-HTTP mapping and
scheduler ownership, [RELEASING.md](RELEASING.md) for publication, and
[examples/composition](../examples/composition/README.md) for a memory-backed
end-to-end composition with no framework.
