# @pegma/support-desk-contracts

Provider-neutral ticket, requester, message, and event contracts shared by
Support Desk packages and host applications.

`Ticket` carries optional host-configured `category` and dual timestamps:
staff-facing `updatedAt` and customer-visible `customerUpdatedAt`. Category is
an opaque allowlisted label and never establishes identity, permission,
priority, or assignment.
