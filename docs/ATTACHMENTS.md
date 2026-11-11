# Attachments (Buildout Task 14)

These additive APIs are unpublished source work. A separately verified release
is required before host adoption. No blob implementation,
cloud SDK, new dependency, package, or release is supplied. Hosts opt in with
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
   First commit a `deleting` fence, receipt and Audit; then delete host bytes;
   then commit a `deleted` tombstone, receipt and Audit. Failures retain the
   non-downloadable fence; repeat the same command to resume. Tombstones preserve
   identity, digest, replay and audit facts. The blob is removed before the final
   tombstone. Concurrent downloads already delivered cannot be recalled.

   A redundant deletion fence or tombstone is a no-op: it adds no Audit or
   receipt for a state that did not change. A resumed command that actually
   completes deletion is recorded in the final tombstone Audit and receipt.
   Concurrent commands converge on the tombstone without a false conflict.

`sweepExpiredAttachments` scans one physical page (default 20, maximum 100) and
uses an authorized host worker identity to resume deleting or expire attachments.
Hosts schedule recurring full cursor cycles and persist progress after success.
Individual deletion failures are returned in a bounded `failures` list containing
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
physical capacity for their two new records, so lowering a budget below the
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
