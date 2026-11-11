# Attachments (Buildout Task 14)

These additive APIs are published in `0.2.5`. Host storage, scanning and
retention acceptance remain required before activation. No blob implementation,
cloud SDK, new dependency or package is supplied. Hosts opt in with
`createSupportDeskApplication({ store, clock, attachments: { blobs, ...limits } })`.
The composition example includes a synthetic in-memory host blob adapter and
an explicit scan callback flow. That adapter is not production storage.

## Write and replay contract

Customer create/reply, staff reply, and internal notes accept `attachments`:
`{ filename, contentType, bytes: Uint8Array, sha256 }[]`. The service snapshots
bytes before awaiting, verifies lowercase hex SHA-256, and fingerprints ordered
normalized descriptors (including size, MIME, name and digest). Empty input
preserves existing command fingerprints. Changed descriptors conflict; exact
committed retries do not upload again, even after scan or deletion. Replay
reflects current attachment safety state, never resurrecting deleted bytes.

Fingerprint names use a fixed 255-character normalization, independent of host
display limits. Stored names use the configured display limit. This deliberate
separation keeps exact retries stable after a host changes filename or byte
limits. Hosts must not reconstruct command fingerprints from stored DTOs.
Snapshotting enforces fixed 10 MiB/file and 20 MiB/command allocation caps;
current host byte/type/count policies are enforced for new commits after replay
detection. Lowering an upload limit does not invalidate an older receipt.

Metadata is embedded in `TicketMessage.attachments`; these are the authoritative
attachment records and references. There is no separate cross-partition catalog.
The message, ticket, quota, Audit event, command receipt and optional mail outbox
are committed by the existing ticket-partition transaction. Attachment counts
include tombstones, preserving a lifetime per-ticket bound. Ticket revision
conditions serialize concurrent additions against that bound.

The host blob port implements create-only immutable `put(key, bytes, context)`
(return `"exists"` without writing on collision, otherwise resolve void),
bounded `get(key, maximumBytes)` and idempotent `delete(key)`. Support Desk mints
random UUID keys under `support-attachments/`; names, ticket IDs and message IDs
never enter paths. The context supplies ticket/message IDs for host inventory
reconciliation. A host can adapt a published exact storage-blobs version without
changing Support Desk. The host must prevent overwrite and public access.

Confirmed transaction refusals and upload failures trigger best-effort deletion
of that attempt's unique keys, including a partially failed upload. A thrown
transaction may have committed: its blobs are preserved. Retry the command to
discover the receipt. Upload failures, process crashes and failed cleanup can
leave orphan candidates in the host inventory.

`cleanupUnreferencedAttachmentBlobs` accepts at most 100 inventory candidates
with their original put-time ticket/message context. Its required host
`withUploadsPaused` callback must stop admission and drain all attachment writes
across every process, including resolving uncertain transaction outcomes, until
the callback finishes. Only then can absence of a message reference prove a
candidate is orphaned. It confirms each candidate by key lookup before deletion.
Persist host inventory cursors outside Support Desk and repeat bounded pages.
An age cutoff alone is insufficient; never run this cleanup concurrently with
uploads. Hosts without distributed fencing can use a stopped-writer maintenance
window. Inventory context is trusted host metadata, never browser input.

## Bounds and content safety

Defaults: 3 attachments/message, 20 lifetime attachments/ticket, 2 MiB/file,
5 MiB/message, 120 display filename characters, 30 days retention. Configurable
hard maxima: 10/message, 100/ticket, 10 MiB/file, 20 MiB/message, 255 filename
characters, 365 days retention. No empty files. The MIME allowlist defaults to
`text/plain`, `image/png`, `image/jpeg`, with at most 32 exact lowercase types.
Hosts must explicitly opt into other types, including PDF, HTML or SVG. MIME is
a declaration, not proof of content: the trusted scanner must inspect bytes.
Filename normalization removes controls, path separators, header delimiters,
leading dots, bidi controls and malformed surrogate sequences; it bounds input
to 4096 characters. Display names never select blob keys.

New attachments always start `pending_scan`. The host scanner reads private
storage directly using its own restricted credentials; normal ticket downloads
cannot retrieve pending or quarantined files. A trusted scanner callback calls
`recordAttachmentScanResult` with the attachment ID, SHA-256, `clean` or
`quarantined`, command ID and correlation ID. It requires queue-read plus manage
permission, and commits state, ticket revision, receipt and Audit together.
Only pending attachments accept a first verdict. Exact callback retries replay;
conflicting final verdicts fail closed. There is no quarantine-release API.
Synchronous scanners can submit this same callback immediately after commit;
the attachment stays unavailable until the callback transaction commits.

## Five activation milestones

1. **Isolated storage origin:** host storage is private, isolated from the app
   origin and denies anonymous object reads. Supply credentials only to host
   services. Never return a blob URL/key as a download capability.
2. **Scan and quarantine:** use immutable objects and digest-bound verdicts;
   scanner failure leaves pending metadata. Staff sees state but normal download
   paths refuse quarantined and pending bytes. Scanner access is a separate
   host service capability, not a browser bypass.
3. **Authorized download:** `downloadAttachment` requires queue-read for staff,
   or read-own plus authenticated ticket ownership for customers. Customers can
   only read non-internal messages. Only clean, unexpired attachments are returned.
   Downloads verify size/digest, then recheck Ticket and Message versions and
   the original named read permission after fetching.
   Hosts must bind AccessContext to a verified session and apply rate limits.
4. **Preview isolation:** there is no preview API. Apply every returned header:
   `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`, and
   `Cache-Control: private, no-store`, with the declared content type. The
   disposition uses a fixed ASCII fallback and an encoded sanitized UTF-8 name.
   Never embed returned HTML/SVG in an iframe or render content on the app origin.
5. **Deletion/expiration:** `deleteAttachment` requires queue-read plus manage.
   The first transaction CASes Ticket and Message into a `deleting` fence,
   appends its Audit and reserves `command:<caller-command-id>` with a bounded
   pending deletion receipt. It binds the original actor, message, attachment,
   correlation and command fingerprint before any blob removal. An occupied
   command ID rejects without changing metadata or deleting bytes.

   Only the same actor and exact command can resume that pending operation.
   A different command or actor is refused while it is pending. Exact concurrent
   retries converge on the same receipt. After idempotent blob removal, one
   transaction CASes Ticket, Message and the pending receipt into the deleted
   tombstone, completed receipt and completion Audit. Unknown blob or transaction
   acknowledgements retain durable recovery state. Retry the original packet
   instead of inventing a new command. A completed exact retry does not remove
   bytes again. An already-deleted target with a fresh unused ID is a no-op.

   The original receipt row is updated, so the lifecycle does not need more
   managed rows. A new deletion uses two fence rows and one completion Audit row.
   Six/four/two cleanup reservations remain conservative ceilings. Historical
   completed receipts without the optional phase retain completed semantics.
   For a pending receipt, the existing timestamp records acceptance of the fence
   and the phase remains authoritative until completion updates it.
   Legacy deleting metadata can be adopted only with the original matching fence
   receipt and actor-bound Audit. Older attachment writers must not run while
   new pending receipts exist. There is no automatic rewrite or migration.
   Tombstones preserve identity, digest, replay and Audit facts. Concurrent
   downloads already delivered cannot be recalled.

New fence Audit events use the SDK-only `\u0000support.attachment.fence:`
event-ID domain plus the original command ID. Caller command IDs forbid C0
controls. The existing Audit encoder escapes both controls and literal `%`, so
these physical keys remain distinct from all ordinary caller Audit keys,
including IDs beginning with literal `%00`. Audit details retain the original
command ID. Legacy fence Audit and receipt keys remain readable for recovery;
no existing row is rewritten.

Clock observations and stored expiry timestamps must use canonical ISO UTC
form. Sweeps validate the clock before page work. Downloads validate both their
initial and final clock observations, including after blob I/O. Invalid clock
values fail closed instead of being compared as raw strings.

`sweepExpiredAttachments` scans one physical page (default 20, maximum 100) and
uses an authorized host worker identity to expire attachments and resume its own
exact pending deletion commands.
Hosts schedule recurring full cursor cycles and persist progress after success.
A worker reports another actor's pending deletion as a failure so the original
actor can resume its retained command. Individual deletion failures are returned
in a bounded `failures` list containing
only ticket/message/attachment IDs; they do not prevent other attachments or
later pages from progressing. Alert on persistent failures and revisit them on
the next full cycle. Scan failures still reject the page and leave its cursor
unchanged. Expiry gates downloads immediately even before sweep. Reserve
partition capacity for scan/deletion Audit and receipts (six additional records
per attachment for one verdict and one deletion). The application includes these
reserved slots when admitting other commands, so ordinary mutations cannot spend
cleanup capacity. Configure consistent limits on the application and inbound
processor. Attachment-count and partition-record limits are independent upper
bounds, not a promise that either can be reached under every combination. A
100-attachment configuration needs a larger record budget if all scans remain
pending together. Reads count physical records only; safety transitions check
physical capacity for their remaining new records, so lowering a budget below the
virtual reservation does not itself strand cleanup. Never lower it below the
actual physical rows plus the remaining cleanup writes; restore sufficient
capacity before cleanup if an external writer or config change violates that
physical bound. Delete attachments before purging ticket records, and finish
orphan reconciliation before dropping inventory.

## DTOs, mail and inbound

Customer DTOs expose only ID, normalized display name, declared MIME, size,
expiry and scan state on visible messages. Blob keys and digests stay server-side;
internal notes and their attachments never enter customer views. Existing mail
projections contain neither attachment bytes nor private keys. Hosts must link
to authenticated ticket downloads rather than inserting private storage URLs.

Inbound mail deliberately continues dropping attachments. Hosts bound MIME
parts, decoded bytes and total message bytes before normalization, discard every
attachment, and pass only safe plain text and existing provider metadata. Task 14
does not infer attachments from unknown inbound fields or store MIME/HTML.
Inbound attachment extraction is a future explicit integration using the same
message and safety model; no email-specific message type or parallel queue.
