# Upgrading to the synchronized 0.2.2 release

`0.2.2` is the current verified published synchronized release; it does not
certify a host's deployment or acceptance. See the
[publication receipt](RELEASING.md#verified-022-publication-2026-11-10).
The original SD-06 `0.2.0` release has its separate
[historical receipt](RELEASING.md#verified-sd-06-publication-2026-11-08).
The original four Support Desk packages were published at `0.1.1`. Before
SD-06, source also used `0.1.1` while accumulating additional behavior; those
source changes shipped in `0.2.0`. Registry versions are immutable.
Use the exact synchronized artifacts recorded by
[release verification](RELEASING.md), using published packages rather than
branches, copied source, local paths, or candidate tarballs in production.

The optional AI package has a separate registration-only `0.1.1`
[bootstrap](AI_BOOTSTRAP.md). It is not a supported installation target: its
registry application dependency lacks the new source exports. The five local
bootstrap tarballs prove an isolated source assembly, not a usable registry
dependency tree.

## Package and host boundary

The released inventory is `@pegma/support-desk-contracts`, `-core`,
`-templates`, `-application`, and optional `-ai`, all at exact `0.2.2` with
matching internal pins. Keep one coherent set. The base application remains
usable without AI, KB, a model provider, or GitHub.

Current ecosystem pins are Spine `0.1.2`, Storage Core `0.4.0`, Authorization
Core `0.4.0`, Audit `0.2.0`, and Mail `0.1.1`. Only the optional AI package
uses the verified KB application/contracts `0.1.5`. A host must independently
verify its complete published lockfile and consumer before deployment.

The source changes are described in [release notes](RELEASE_NOTES.md).
Each host still owns authentication, current permission resolution, durable
Store/namespace, mail transport, model and usage ports, KB authority, GitHub
installation, release proof, schedulers, retention, and UI. Package methods
grant no roles, Admin inheritance, or Agent Access scopes.

## Migration to published 0.2.2

The optional AI runtime dependencies on KB application/contracts advance to
exact `0.1.5`, with matching repository development/test pins. Keep the resolved
KB graph coherent; structural type compatibility does not establish runtime
error identity across versions or duplicate module instances. Remove obsolete
KB `0.1.2` constructor aliases or translation shims when adopting the verified
`0.2.2` graph, and test the actual host installation and bundle. Published
`0.2.1` manifests and their KB `0.1.2` dependencies remain immutable history.
The [0.2.2 receipt](RELEASING.md#verified-022-publication-2026-11-10) qualifies
the exact SDK artifacts; host adoption is a separate observed result.

The release adds [opt-in staged retrieval](ASSISTANT_COORDINATION.md#opt-in-durable-staged-retrieval)
while retaining the monolithic runtime default. Its exported
`AssistantProcessResult` return union always includes the new `prepared` member;
exhaustive TypeScript switches or matchers must add a case even when callers
omit `stagedRetrieval` or set it to `false`. Runtime opt-in does not narrow the
public return type.

Only opt-in staging can produce `prepared`, with `ticketId`, `turnId`,
`preparationAttemptId` and `nextAttemptAt`. Return from that physical invocation
and schedule a genuine later request, queue delivery or scheduler invocation
at or after `nextAttemptAt`. Do not call `processTurn` again or use `waitUntil`
inside the same invocation as a substitute. Both existing attempt caps must
allow at least two attempts; preparation consumes one without resetting counters
or raising caps, and staging permits only one paid opportunity.

Both resolvers must freshly validate current inputs while preserving full
validated configuration and customer-authority snapshot values across phases.
Matching version labels are insufficient: `dataControls.verifiedAt`,
`dataControls.validUntil` and opaque `usageScopeRef` all participate. Re-attestation
or scope renewal changes intentionally fail closed to finish/handoff before
new usage reservation or a model call, even with unchanged logical settings.
Do not normalize these fields away or cache stale evidence; the paid phase's
live configuration, authority, source and final-CAS checks still apply.

The release also adds [exact learning review intent recovery](RESOLUTION_LEARNING.md#exact-review-intent-recovery-022).
Use read-only `prepareReviewIntent`, then retain the entire intent and original
command/decision packet before submission. `submitReviewIntent`,
`readReviewReceipt` and explicit `cancelReview` accept that exact packet.
Receipt recovery precedes stale source/target checks; a null read is not a
terminal refusal. Cancellation competes atomically with approval, returns the
accepted winner when already committed, and never undoes it. Keep unknown
packets until an exact accepted/cancelled acknowledgement; never clear them
from a 409, GET or elapsed deadline alone. New submissions retain current proof
and authority guards; cancellation requires its current-human guard and bounded
Audit/receipt admission. Existing full-command `reviewProposal` remains usable.

No receipt rewrite is required. Legacy accepted command fingerprints and the
generic receipt layout remain unchanged; new intent commands add optional
`intentBinding`, and cancellation occupies the same command key with a separate
fingerprint domain. Older `0.2.1` reviewers reject the new field or cancellation
fingerprint, rather than accepting a cancelled review. They cannot interpret
the new acknowledgement union. Preserve receipts and rehearse actual downgrade
behavior instead of deleting them or claiming universal rollback compatibility.

SDK `0.2.2` publication and strict verification are complete. Host invocation/CPU
measurements and activation retain their separate gates; an SDK migration is
not live acceptance.

## Unpublished 0.2.3 engineering guard candidate

This checkout synchronizes all five source packages and internal Support pins
at `0.2.3`, retaining exact AI KB application/contracts `0.1.5`. The candidate
finishes repository/policy observations before the supplied approval commit
guard and honors a supplied final rejection guard. The coordinator supplies a
current-staff rejection guard; direct application rejection may still omit one.
Accepted receipts remain receipt-first under current review/queue authority.
These are bounded observations around the existing partition CAS, not
cross-store atomicity or continuous authority. See the
[engineering guide](ENGINEERING_EXPORT.md). This correction is not in `0.2.2`;
full current-head gates, review, trusted publication and strict verification
remain required before hosts rely on `0.2.3`.

## Rehearse the actual 0.1.1-to-0.2.0 upgrade

The SD-06 rehearsal below is retained as historical migration evidence. For
current `0.2.2` adoption, repeat the rehearsal against the exact selected `0.2.2`
artifacts and record a new receipt; a `0.2.0` result does not qualify changed
artifacts or a host's durable-store migration.

The required migration proof starts with records produced by the actual
published `0.1.1` application, then reads and mutates them with the packed
`0.2.0` artifacts in a clean consumer. Its receipt must record the exact
old and new artifacts, dependencies, runtime, Store adapter, operations, and
outcomes. The packer's separate `<output>-consumer-verification.json` receipt
(by default `.release-consumer-verification.json`) identifies synthetic
base/forward-migration scenarios with AI options omitted and disabled, plus
the optional AI public composition check. It records
`previousPublishedVersion: "0.1.1"`, `legacyMigrationScope: "web-records-only"`,
`emailWriter: "candidate"`, and `reverseRollbackProven: false`. The old SDK
writes the web records; inbound email is exercised only through the candidate,
because the published old SDK has no inbound-email processor.
The receipt binds `sourceRepository`/`sourceCommit` and all five actual archive
names, sizes, SHA-256, SHA-1, and SHA-512 integrity values, recomputed from the
bytes. Its base consumer records the genuine previous installation's official
registry URL and lockfile integrity in `previousArtifact`, alongside its own
resolved dependency pins. `runtime` records Node/V8, platform, and architecture;
`store` identifies Storage Core `0.4.0`'s `createMemoryStore` with `durable: false`.
Compare those bindings with the independently selected commit and prepared
archives, rather than accepting a matching candidate version alone.
The stable workflow retains consumer evidence separately from its strict
six-file release artifact. Keep the independent receipt/manifest hashes and
both upload IDs/archive digests with the release handoff, and preserve the
evidence before the workflow's 30-day retention expires. See
[release retention and recovery](RELEASING.md#stable-tag-and-workflow).

The publication receipt records the passed clean memory-Store upgrade proof.
Those scenarios do not establish production-store migration or rollback readiness.

A partial registry publication is not an adoption-ready release. Recovery
must reuse the original prepared artifacts and freshly authenticate the
already-present subset in the unprivileged registry preflight before any
remaining uploads. The publisher requires the independently bound preflight
receipt, the original preparation artifact ID/archive digest, and matching
release/subset bindings. Observation time has no arbitrary expiry limit.
Fresh whole-five-package checks before each upload allow only the authenticated
subset plus that invocation's own confirmed writes; drift or unavailable
evidence blocks further uploads. Only the final complete-set verification permits release
handoff; see [partial publication recovery](RELEASING.md#partial-publication-and-recovery).

Before enabling new capabilities:

1. Back up the instance and rehearse restore with the host's durable adapter.
   Record the configured physical row/message caps and retention policies.
2. Verify old customer/staff reads, human replies, Audit/receipt replay, mail,
   and queue behavior with every AI workflow disabled on the new SDK.
3. Run complete bounded queue and thread-index repair cycles as required by
   [host composition](HOST_COMPOSITION.md). Persist opaque cursors only after
   a page succeeds; a scan is not a snapshot.
4. Explicitly configure new permissions and worker authority. Use current
   named grants; do not treat a role name or an old session as a permission.
5. Check human, privacy, terminal, and follow-up capacity reserves before
   admitting new generation or outbound work. Saturation must hold derivation
   without spending another workflow's reserved completion capacity.
6. Rehearse cancellation, exact lost-acknowledgement replay, unknown usage,
   external reconciliation, source withdrawal, and deletion before rollout.

Omitted legacy handling remains human support. Missing lifecycle fields are
not evidence of a historical milestone. Existing quotas retain their limits;
new optional enrollment must not rewrite old success receipts into learning
or bug evidence. Missing legacy follow-up authority epochs hold eligibility;
fresh proof does not silently authorize an old issue association.

The candidate keeps new records in the layouts documented in
[COLLECTIONS.md](COLLECTIONS.md). The separate engineering policy collection
also has finite history and an authorized retention/pruning contract. Record
those policies in the host's upgrade plan rather than manually deleting rows
to make admission pass.

## Disable capability before considering a package downgrade

The supported operational fallback is human support on the new SDK with AI
generation and export controls disabled. Keep the current codecs, deterministic
request-person/takeover/reply paths, and the minimal workers needed to finish
or reconcile persisted work. Turning off generation does not settle unknown
provider usage, retract a GitHub issue, or complete KB cleanup.

Do not assume published `0.1.1` readers can decode rows written by this
candidate. No backward package-downgrade guarantee follows from additive
TypeScript types or AI-off behavior. A package rollback requires its own tested
storage compatibility or a host-approved restore/recovery plan. Do not erase
unknown work or replay receipts to force an older codec to accept the store.

## Withdraw sources before deleting bodies

Call `withdrawResolutionLearningSource` and `withdrawEngineeringSource` for
their independently enrolled sources before deleting ticket bodies or revoking
source access. Engineering withdrawal also scrubs its bounded follow-up
children using the parent privacy reserve, even if later composition omits
follow-up options. There is no separate follow-up privacy-withdrawal command.

Retain minimal usage and destination/request identities while acceptance or
external cleanup remains unresolved. Learning and engineering reconciliation
have dedicated authority and body-free retained views after ticket deletion.
Withdrawal is not a physical KB purge or GitHub retraction; external privacy
remediation remains separately authorized host work. Already sent canonical
messages follow ordinary ticket retention.

## Release evidence and open host handoffs

| Owner                   | Evidence and remaining responsibility                                                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Release owner           | Retain the verified SD-06 publication, original package and clean-consumer evidence recorded in the release receipt.                                   |
| Package maintainer      | AI registration and stable publication are complete; recheck actual dist-tags, policy and trusted-publisher configuration for each subsequent release. |
| Each host owner         | Durable-store upgrade/restore and AI-off fallback, current access/data controls, retention/recovery, and complete workflow acceptance.                 |
| Client and pilot owners | Actual requested-client authentication/authoring results, approved staging smoke, cross-host acceptance, and supervised pilot sign-off.                |

Source receipts and a successful package install do not close the host, client,
staging, or pilot handoffs. Follow [AI operations](AI_OPERATIONS.md) during the
host's separately approved rollout.
