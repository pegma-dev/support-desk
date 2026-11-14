# Synthetic optional AI composition

Run `pnpm ai:example` from the repository root after installing the reviewed
dependencies. The root command builds the SDK and these TypeScript files,
then runs `run.ts` from its compiled output. Node 22 and 24 are supported.

The example uses public package entry points, an actual Storage Core Store,
and all four optional Support Desk coordinators from synchronized `0.2.11`.
It pins exact verified public KB application/contracts `0.1.8`. Both Node 22/24
release gates exercised this source example; the separate published `0.2.11`
qualification passed a clean public consumer. This example uses no provider
SDK, network client, mail provider, host framework, or production credentials.
Its scripted `github.createIssue` throws; the engineering flow only links an
existing fictional issue privately.

Two fictional tickets exercise the boundaries:

1. A customer receives an answer from an approved guide, requests a person,
   and is taken over by staff. Staff resolve the issue and the customer confirms
   success. Verified learning transfers a checked private KB draft. Support's
   staff review records the actual target; the draft remains unpublished and
   absent from approved retrieval.
2. Staff reproduce an export failure and approve an exact checked existing-issue
   association. A scripted current deployment mapping queues one follow-up.
   Workers prepare a customer draft, an actual KB-target change proposal, and
   advisory retest requests. Staff explicitly post one authenticated web notice;
   exact replay returns the same notice without changing ticket status.

The only publication is explicit synthetic administrator setup of the initial
answer guide. Coordinator actors receive no KB publication permission or
publication method. Follow-up does not execute tests, submit KB evidence,
publish changes, send email, or resolve the bug ticket.

`runSyntheticAiExample({ store?, clock?, idPrefix? })` is exported from
`composition.ts`. Tests inject the actual memory and Azurite adapters; the
clean-consumer check compiles and runs these same files against packed public
packages. Each run needs a fresh Store namespace or a distinct safe prefix.
The whole example is not a replayable workflow command; its individual posting
command is replayed explicitly inside the run.

The returned result contains opaque outcomes, actual retrieval IDs, private
provenance counts, and bounded captures of the four fictional provider inputs
so tests can check note exclusion independently. `run.ts` prints only counts
and outcomes. Do not use these diagnostic captures with real customer data.

The HMAC receipts, model responses, calibration, privacy controls, independent
checks, issue identity, and deployment facts are synthetic host ports. They
demonstrate contract binding, not real ZDR acceptance, staging evidence,
deployment verification, durable billing, or production readiness. Real hosts
must supply their own current authorities, verified provider route and
evaluations, release attesters, usage ledger, and operational controls.
Separate instances keep their own Store, configuration, cursors, and secrets.

The current synchronized Support Desk `0.2.11` release is published and strictly verified;
see the [publication receipt](../../docs/RELEASING.md#verified-0211-publication-2026-11-14).
Its published AI package pins KB `0.1.8`. The historical
[`0.2.8` receipt](../../docs/RELEASING.md#verified-028-publication-2026-11-12)
retains its KB `0.1.6` graph. Production adoption retains its own host
acceptance gates.
See [the existing human-support example](../composition/README.md),
[host composition](../../docs/HOST_COMPOSITION.md), and the individual
[assistant](../../docs/ASSISTANT_COORDINATION.md),
[learning](../../docs/RESOLUTION_LEARNING.md),
[engineering](../../docs/ENGINEERING_EXPORT.md), and
[follow-up](../../docs/ENGINEERING_FOLLOWUP.md) guides.
