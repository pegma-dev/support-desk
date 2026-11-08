# Upgrading to the synchronized 0.2.0 candidate

`0.2.0` is the SD-06 release candidate, not a published or host-approved release.
The original four Support Desk packages were published at `0.1.1`. Before
SD-06, source also used `0.1.1` while accumulating additional behavior; those
source changes now form the `0.2.0` candidate. Registry versions are immutable.
Upgrade only after the exact synchronized artifacts pass
[release verification](RELEASING.md), using published packages rather than
branches, copied source, local paths, or candidate tarballs in production.

The optional AI package has a separate registration-only `0.1.1`
[bootstrap](AI_BOOTSTRAP.md). It is not a supported installation target: its
registry application dependency lacks the new source exports. The five local
bootstrap tarballs prove an isolated source assembly, not a usable registry
dependency tree.

## Package and host boundary

The candidate inventory is `@pegma/support-desk-contracts`, `-core`,
`-templates`, `-application`, and optional `-ai`, all at exact `0.2.0` with
matching internal pins. Keep one coherent set. The base application remains
usable without AI, KB, a model provider, or GitHub.

Current ecosystem pins are Spine `0.1.2`, Storage Core `0.4.0`, Authorization
Core `0.4.0`, Audit `0.2.0`, and Mail `0.1.1`. Only the optional AI package
uses the verified KB application/contracts `0.1.2`. A host must independently
verify its complete published lockfile and consumer before deployment.

The source changes are described in [release notes](RELEASE_NOTES.md).
Each host still owns authentication, current permission resolution, durable
Store/namespace, mail transport, model and usage ports, KB authority, GitHub
installation, release proof, schedulers, retention, and UI. Package methods
grant no roles, Admin inheritance, or Agent Access scopes.

## Rehearse the actual registry-to-candidate upgrade

The required migration proof starts with records produced by the actual
published `0.1.1` application, then reads and mutates them with the packed
candidate in a clean consumer. Its current-head receipt must record the exact
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

This document does not mark that proof passed. These clean memory-Store
scenarios do not establish production-store migration or rollback readiness.

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

## Open handoffs

| Owner                   | Evidence still required                                                                                                                 |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Release owner           | Current SD-06 Node 22/24 gates, review, five packed consumers, actual old-registry upgrade proof, and verified publication.             |
| Package maintainer      | AI name registration, actual dist-tags/policy, trusted-publisher configuration, and final signed-tag release evidence.                  |
| Each host owner         | Durable-store upgrade/restore and AI-off fallback, current access/data controls, retention/recovery, and complete workflow acceptance.  |
| Client and pilot owners | Actual requested-client authentication/authoring results, approved staging smoke, cross-host acceptance, and supervised pilot sign-off. |

Source receipts and a successful package install do not close the host, client,
staging, or pilot handoffs. Follow [AI operations](AI_OPERATIONS.md) during the
host's separately approved rollout.
