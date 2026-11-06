# @pegma/support-desk-contracts

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
