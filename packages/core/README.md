# @pegma/support-desk-core

Pure ticket creation and revisioned workflow transitions. This package performs
no I/O, authorization, mail delivery, or persistence.

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
