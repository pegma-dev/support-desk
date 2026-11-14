# @pegma/support-desk-core

The synchronized `0.2.12` release is published and strictly verified. See the
[publication receipt](../../docs/RELEASING.md#verified-0212-publication-2026-11-14),
[release notes](../../docs/RELEASE_NOTES.md#0212-opt-in-provider-group-checks)
and [engineering read phases](../../docs/ENGINEERING_EXPORT.md#entry-points-and-authority).
Task 15, published in `0.2.9`, exposes pure `defineCannedResponse`,
`defineCannedResponseCatalog`, `snapshotCannedResponseSelection` and
`renderCannedResponse` helpers. They validate bounded plain-text definitions
and literal value substitution; application services enforce staff permissions,
catalog selection and atomic Audit. See
[host composition](../../docs/HOST_COMPOSITION.md#staff-canned-responses-task-15-source-candidate).

The current verified synchronized registry release is `0.2.12`; see the
[publication receipt](../../docs/RELEASING.md#verified-0212-publication-2026-11-14).
The synchronized `0.2.12` release retains the
[application/AI additions](../../docs/RELEASE_NOTES.md). Host adoption retains
its own composition and activation gates.

Pure ticket creation, revisioned workflow transitions and bounded canned-response
definition, selection and rendering helpers. This package performs no I/O,
authorization, mail delivery, or persistence.

Create accepts optional `category` and sets both `updatedAt` and
`customerUpdatedAt`. Customer-visible events (replies and lifecycle) advance
both timestamps; notes, assignment, and priority advance only `updatedAt`.
Category is preserved unchanged through every transition.

`tags_changed` accepts at most 32 unique category-shaped identifiers, copies
and freezes the array, and advances only staff time and revision. Application
services enforce the host allowlist and smaller per-ticket cap. The first
`support_replied` sets `firstStaffRespondedAt` once, preserving it through
reopens. Repeated `resolved` preserves `resolvedAt`; closure preserves it;
reopening or a reply clears it, so re-resolution records the new timestamp.
Due dates are host-computed application policy; core does no calendar or
presence work. New ticket fields remain optional for compatibility.

## Optional handling (SD-01 source)

`Ticket.handling` is independent of lifecycle status. `effectiveTicketHandling`
maps only omission to human-pending/generation zero without rewriting the
ticket. Explicit handling requires a recognized state and positive safe-integer
generation; null, arrays, invalid states, and explicit zero/unsafe generations
throw `TypeError`, never silently becoming legacy data. Trusted web-only
`initialHandling: "assistant"` creates assistant generation one.

`assistant_replied`, `human_escalated`, and `human_taken_over` require exact
ticket revision and handling-generation fences. Invalid fence values throw
`TypeError`; stale fences or disallowed workflow throw `TicketWorkflowError`.
Assistant reply/escalation require active web assistant handling. Assistant
output never sets the first staff response milestone. The application
additionally verifies the latest visible
customer trigger; core has no conversation store to verify that proof.

Active already-human requests and already-active takeovers are no-ops only
after event actor, chronology, and required fences validate. An event earlier
than `ticket.updatedAt` is rejected even when its transition would be a no-op;
the application uses trusted server time clamped to that timestamp.
Requesting a person on terminal work deliberately reopens human-pending,
preserving assignment and the first-staff-response milestone. Staff reopen
also enters human-pending for explicit handling. A web customer reply may
instead reopen assistant handling with a fresh customer trigger; explicit non-web
input enters human handling.

Takeover of an omitted legacy value materializes human-active/generation one.
It does not opt that ticket into assistant quota management; only the
application's explicit assistant creation sets that reserve marker.
`customer_success_confirmed` follows resolution semantics, including reopening
closed work first; ownership and visible-message evidence are application
checks. Pure functions grant no permission, perform no model/KB work, and
commit no Audit, receipt, or handoff row. These SD-01 changes first shipped in
verified synchronized `0.2.0` and remain in current public `0.2.12`; see its
[publication receipt](../../docs/RELEASING.md#verified-0212-publication-2026-11-14).
Existing registry `0.1.1` artifacts remain immutable; host activation retains
its own acceptance gates.
