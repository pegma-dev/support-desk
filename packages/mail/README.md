# @pegma/support-desk-mail

Provider-neutral outbound mail contracts and an outbox delivery worker.
Adapters must honor the supplied idempotency key, so retrying an uncertain
send cannot create a duplicate message. The stored key includes both ticket
and job identity, is provider-safe, and cannot collide across ticket
partitions.
Worker options, candidates, and per-job inputs are snapshotted from own data
properties before use; accessors are rejected without being executed.
Generated `Message-ID` values share the application boundary's strict
254-character ASCII dot-atom and DNS-domain validation.

This package does not contain a provider SDK, recipient directory, MIME parser,
or identity logic.

Storage Core intentionally cannot enumerate partitions. A delivery worker
therefore requires a host-supplied `DeliveryCandidateSource` backed by durable
host scheduling state. Candidates are only hints: the outbox lease claim is
the authority, and duplicate candidates are harmless.

A successful provider `send` means `accepted`, not delivered. Only a normalized
authenticated delivery callback may mark a job `delivered`. A later failure
callback moves an accepted job back to retry/dead-letter handling, while a
confirmed delivered job never regresses. Dead-letter is also terminal. Every
lease has a unique fencing token, including when the same worker ID reclaims
expired work.

The worker also requires a trusted host `Clock`. The candidate timestamp is
used for the lease claim, while accepted/retry completion timestamps and the
callback deadline are calculated from the clock only after the provider call
returns. Reconciliation likewise samples the clock after the provider status
call, so delivery, retry, and terminal retention timestamps reflect actual
completion. Provider results are decoded as own data properties before they
are persisted; accessors and malformed or unbounded references fail closed.

Acceptance has a bounded callback deadline. Hosts must supply a
`MailReconciliationPort`; after the deadline, `reconcile` checks the provider
without sending again. A known failure returns to retry with the original
idempotency key, delivery becomes terminal, and an unresolved outcome becomes
`terminal_unknown` for explicit operational review and retention. An expired
reconciliation lease can only be reclaimed by the reconciliation path; the
send path categorically refuses it.
