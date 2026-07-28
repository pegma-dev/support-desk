# @pegma/support-desk-application

Authorized customer ticket services and provider-neutral durable outbox
records for Support Desk. The host supplies an `@pegma/storage-core` `Store`
and a trusted Authorization Core access context.

Customer create uses `support.ticket.create`; list and read both use the
documented `support.ticket.read.own` permission and then confirm authoritative
ownership; reply uses `support.ticket.reply.own`.

This package implements persistence coordination, not persistence. It has no
provider SDK and no role, plan, or entitlement model.

Delivery callback recording also requires the host `Clock`: provider
`occurredAt` remains event data, while receipt retention and the enforced
30-day deduplication horizon use trusted host processing time. Retry
availability and delivery-job terminal retention use that same trusted time,
so a provider timestamp cannot stall work or make it immediately reclaimable.
