# @pegma/support-desk-application

Authorized customer ticket services and provider-neutral durable outbox
records for Support Desk. The host supplies an `@pegma/storage-core` `Store`
and a trusted Authorization Core access context.

Customer create uses `support.ticket.create`; list and read both use the
documented `support.ticket.read.own` permission and then confirm authoritative
ownership; reply uses `support.ticket.reply.own`.

Create and reply commands are snapshotted from own data properties exactly
once before validation, idempotency fingerprinting, or persistence. Accessors
are rejected without being executed. Optional requester email is a contact
snapshot, never an identity key: surrounding whitespace is removed, the DNS
domain is lowercased, and plain-address syntax, controls, markup, and a
254-character maximum are enforced.
Delivery claim, completion, reconciliation, pruning, and retention inputs use
the same rule, including nested outcome objects. Partition keys and cutoffs
therefore cannot change between a read and its conditional write or delete.
Outbound `Message-ID` values must be at most 254 ASCII characters with a
dot-atom local part, a valid DNS domain, and no controls or malformed dots.

This package implements persistence coordination, not persistence. It has no
provider SDK and no role, plan, or entitlement model.

Delivery callback recording also requires the host `Clock`: provider
`occurredAt` remains event data, while receipt retention and the enforced
30-day deduplication horizon use trusted host processing time. Retry
availability and delivery-job terminal retention use that same trusted time,
so a provider timestamp cannot stall work or make it immediately reclaimable.
Reply timestamps are sampled and validated on every transaction attempt, then
clamped to the stored ticket's `updatedAt` so clock skew cannot move a
conversation backward.

Inbound processing remains a future phase, but its declared receipt collection
is already hard-bounded to 256 hash slots per partition. Terminal receipt
retention uses trusted processing time, a 30-day deduplication horizon, and
version-conditional deletion; in-flight receipts are never swept.
