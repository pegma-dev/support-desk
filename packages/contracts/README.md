# @pegma/support-desk-contracts

The current verified synchronized registry release is `0.2.5`; see the
[publication receipt](../../docs/RELEASING.md#verified-025-publication-2026-11-11).
The synchronized `0.2.5` release includes the
[application/AI additions](../../docs/RELEASE_NOTES.md). Host adoption retains
its own composition and activation gates.

Provider-neutral ticket, requester, message, and event contracts shared by
Support Desk packages and host applications.

`InboundSenderAuthentication` carries a host-evaluated result bound to one
normalized inbound address. DMARC passes require aligned DKIM or aligned SPF;
`host_identity` represents an equivalent host-authenticated identity. The
result permits existing-ticket email routing only and never establishes web
identity or access.

`Ticket` carries optional host-configured `category` and dual timestamps:
staff-facing `updatedAt` and customer-visible `customerUpdatedAt`. Category is
an opaque allowlisted label and never establishes identity, permission,
priority, or assignment.

Task 13 adds optional staff-only `tags`, `firstResponseDueAt`,
`resolutionDueAt`, and `firstStaffRespondedAt` on `Ticket`, plus the
`tags_changed` workflow event. The existing `resolvedAt` records the current
resolution cycle: reopening clears it and re-resolution sets a new value.
First staff response survives reopen. Optional fields keep legacy tickets
readable; customer DTOs and customer mail must omit this metadata.

## Optional handling (SD-01 source)

`Ticket.handling?: { state, generation }` is independent of `TicketStatus`.
States are `assistant`, `human-pending`, and `human-active`. Only omission is
legacy human handling: core's `effectiveTicketHandling` reads it as
human-pending/generation zero without writing a migration. An explicitly
stored handling generation must be a positive safe integer; malformed
objects/states/generations, including explicit zero, fail closed rather than
being treated as legacy. TypeScript types alone do not validate untrusted JSON.

`CreateTicketInput.initialHandling: "assistant"` is a trusted web-only opt-in
starting generation one. Messages add an explicit `assistant` author kind.
Assistant output never impersonates staff or satisfies `firstStaffRespondedAt`.
`assistant_replied`, `human_escalated`, and `human_taken_over` carry exact
`expectedRevision` and `expectedHandlingGeneration` fences. `human_requested`
and `customer_success_confirmed` require actor/time inputs from the trusted
application; the latter is resolution, not assistant authority.

Contracts define vocabulary, not authorization or persistence. The application
checks permissions/ownership and current visible-message proof, commits
Audit/receipts/work, and keeps private handling generations and evidence out
of customer DTOs. Core performs pure transitions and validates its handling
inputs. These changes first shipped in verified synchronized `0.2.0` and remain
in current `0.2.5`, with no model or KB dependency. See the current
[publication receipt](../../docs/RELEASING.md#verified-025-publication-2026-11-11);
host activation retains its own acceptance gates.
