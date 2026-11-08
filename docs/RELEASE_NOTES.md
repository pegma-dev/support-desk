# Release notes

## Source candidate — optional assistant coordination (SD-02)

Implementation is in progress at source `0.1.1`; current-head validation,
code/security review, and publication have not completed. The source release
inventory now includes optional `@pegma/support-desk-ai` as a fifth package,
with exact published KB `0.1.1` dependencies. The existing application remains
KB/provider-independent and works with AI disabled. This candidate adds
bounded same-ticket turn jobs and five fixed application operations around
external model work, current-authority/full-source checks, durable host usage,
and exact answer/human-handoff commit. See
[assistant coordination](ASSISTANT_COORDINATION.md).

Both KB and Agent Access have strictly verified trusted `0.1.1` registry
releases; [producer receipts](HOST_COMPOSITION.md#kb-authoring-producers)
close SD-02's publication prerequisite. Their historical manual `0.1.0`
bootstrap supplied no OIDC provenance. No Support Desk source version is
published or overwritten by this work: future synchronized verified SD-06
publication, new AI package bootstrap/trusted-publisher setup, and all real
host login/client/privacy/Task 12/full-workflow/pilot gates remain open.

## Unreleased — handling and deterministic controls (SD-01)

Implemented in source via
[PR #34](https://github.com/pegma-dev/support-desk/pull/34), with no version,
tag, or publication change. Source `0.1.1` contains unreleased behavior beyond
registry `0.1.1`; hosts must wait for the synchronized release. Task 12's host
production-evidence gates remain open.

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

This adds no model integration, KB dependency, or new package. The
[implementation ledger](KNOWLEDGE_AI_PLAN.md#status-and-reading-order) records
merged standalone KB-01 through KB-04, AUTH-01 Agent Access, partial KB-05 source
preparation ([KB #4](https://github.com/pegma-dev/knowledge-base/pull/4)), and
both producers' final release preparation. Both producers subsequently
completed strictly verified trusted `0.1.1` publication. SD-02 is now an
in-progress source candidate, described above. PG-01/RG-01 consume both exact
verified published producers and still require actual existing-login/Admin
consent and requested-client proof before activation or pilots. Synthetic
SDK/source proof uses no actual customer data and does not close host privacy,
operations, full-workflow, or pilot gates. See the
[producer evidence and bootstrap handoff](HOST_COMPOSITION.md#kb-authoring-producers).

## Unreleased — lifecycle extras (Buildout Task 13)

Additive package work against `0.1.1`; no versions, tags, or publication change.
Task 12 remains pending on both hosts' durable-store production evidence.

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

## Unreleased — inbound mail (Buildout Task 11)

Additive to the `0.1.1` public surface; package versions are unchanged until
the next synchronized release.

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
