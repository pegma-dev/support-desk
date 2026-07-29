# @pegma/support-desk-core

Pure ticket creation and revisioned workflow transitions. This package performs
no I/O, authorization, mail delivery, or persistence.

Create accepts optional `category` and sets both `updatedAt` and
`customerUpdatedAt`. Customer-visible events (replies and lifecycle) advance
both timestamps; notes, assignment, and priority advance only `updatedAt`.
Category is preserved unchanged through every transition.
