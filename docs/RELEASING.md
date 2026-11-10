# Release operations

The current verified synchronized release is **0.2.1** for all five public
packages, in dependency order:

1. `@pegma/support-desk-contracts`
2. `@pegma/support-desk-core`
3. `@pegma/support-desk-templates`
4. `@pegma/support-desk-application`
5. Optional `@pegma/support-desk-ai`

The synchronized `0.2.1` assistant-answering read-batching patch is published
and strictly verified. All five package versions and internal Support pins
advance together; optional AI retains exact KB application/contracts `0.1.2`
dependencies. Its dated receipt follows. The verified `0.2.0` receipt remains
historical evidence for those exact artifacts; SDK release qualification does
not establish either host's adoption or acceptance.

The original four package names retain their published `0.1.0`/`0.1.1`
artifacts. Pre-SD-06 source also
used `0.1.1` while accumulating SD-01 through SD-05 behavior; those additions
shipped in `0.2.0` and must not overwrite existing registry
versions. The new AI name has a separate registration-only
[0.1.1 bootstrap](AI_BOOTSTRAP.md); that artifact is not host-usable and is not
the first advertised synchronized release.

Merging a PR, preparing tarballs, or creating a tag does not establish a
verified release. Host adoption waits for exact published artifacts, strict
verification, and each host's own acceptance. See [release notes](RELEASE_NOTES.md),
[upgrading](UPGRADING.md), and [AI operations](AI_OPERATIONS.md).

## Verified 0.2.1 publication: 2026-11-10

The protected signed [`v0.2.1` release](https://github.com/pegma-dev/support-desk/releases/tag/v0.2.1)
binds reviewed main source
[`7959d0ee6e31c2b1f9df21a8d85cb7e7c555120e`](https://github.com/pegma-dev/support-desk/commit/7959d0ee6e31c2b1f9df21a8d85cb7e7c555120e)
and tag object `031dd9827ff67f6542477722dc33081665e960a5`.
[Run 42821527940](https://github.com/pegma-dev/support-desk/actions/runs/42821527940)
finished successfully on attempt 4, with all seven job records successful.
Original Node `22.23.4` and `24.22.2` lanes each passed 2,531 tests across 55
files with zero skips, plus formatting, types, examples and packed public
consumers. Recovery carried the four original identity/Node/preparation
executions; it did not rerun their gates or repack the release. Attempt 4 ran
fresh preflight, publication and final verification jobs.

| Original release binding   | Value                                                              |
| -------------------------- | ------------------------------------------------------------------ |
| Preparation artifact ID    | `13766827356`                                                      |
| Preparation ZIP SHA-256    | `b13c2c10157b38132745b21f4d16f6fd642c833f54106f5602a5a1be84337b2e` |
| Canonical manifest SHA-256 | `fd23ea992c6722038e1f39e001e5e2cf0732ff780e9d2d6466f7158e980c5fd6` |

The repository retains the byte-exact [original manifest](releases/v0.2.1/package-manifest.json)
and complete public GitHub API snapshots for the
[preparation artifact](releases/v0.2.1/prepared-artifact.json) and
[successful verification job](releases/v0.2.1/verification-job.json).
The job snapshot preserves GitHub's returned step numbers and conclusions;
no missing step records are invented or renumbered.

Permanent release assets retain the unchanged original evidence:

- [Original Actions ZIP](https://github.com/pegma-dev/support-desk/releases/download/v0.2.1/support-desk-v0.2.1-original-artifact-13766827356.zip):
  asset `731731211`, 480,342 bytes; its API SHA-256 is the preparation ZIP digest
  above. It contains exactly the original manifest and five tarballs, with 231
  regular tar members across those packages.
- [Original manifest](https://github.com/pegma-dev/support-desk/releases/download/v0.2.1/package-manifest.json):
  asset `731731215`; its API SHA-256 is the canonical manifest digest above.
- [Public verification receipt](https://github.com/pegma-dev/support-desk/releases/download/v0.2.1/registry-verification.json):
  asset `731731216`; API SHA-256
  `d7203df90c3fc33fda97d431e42286bca4a0fe0598dfb986666a1158f3125962`.
  This small receipt records results and bindings; it is not raw npm audit or
  consumer output.

Hash the original ZIP before extraction and compare it with the independent
ZIP digest above, then compare the extracted manifest with its recorded digest.
A digest obtained only from a downloaded artifact cannot authenticate itself.

Recovery preserved the original source, tag, manifest and all five tarballs.
Attempts 1 and 3 failed bounded registry visibility confirmation; attempt 2's
generic npm-command failure cause remains unknown. All three failures remain
recorded. Genuine authenticated provenance binds the original physical writers:

- Contracts and Core: [attempt 1 publisher 129849928539](https://github.com/pegma-dev/support-desk/actions/runs/42821527940/job/129849928539),
  whose later visibility check failed.
- Templates and Application: [attempt 3 publisher 129865523941](https://github.com/pegma-dev/support-desk/actions/runs/42821527940/job/129865523941),
  whose later visibility check also failed.
- AI: [attempt 4 publisher 129874651529](https://github.com/pegma-dev/support-desk/actions/runs/42821527940/job/129874651529),
  which succeeded and skipped the other four exact packages.

The failed jobs are not relabeled successful or replaced as original writers.
The [final verification job 129878788518](https://github.com/pegma-dev/support-desk/actions/runs/42821527940/job/129878788518)
and a retained independent check passed exact registry bytes/dependencies,
genuine npm `11.18.0` signature and Sigstore verification, certificate and
source/workflow/tag/original-writer bindings, then clean registry installation
with lifecycle scripts disabled and all six public exports imported. The
independent check used Node `24.18.0`; no invalid or missing signatures remained.
Observed npm `latest` tags were `0.2.1` for all five, with AI's registration-only
`bootstrap: 0.1.1` retained. Dist-tags are mutable observations; original bytes
and authenticated source bindings identify the release.

This receipt qualifies the SDK release. Existing `0.2.0` host-adoption evidence
remains specific to those pins. Host KB/AI activation, actual-client acceptance,
provider/privacy controls, evaluations, operations and supervised pilots remain
separate gates. Grouped reads establish no universal Workers Free query or CPU
bound.

## Verified SD-06 publication: 2026-11-08

The signed [`v0.2.0` release](https://github.com/pegma-dev/support-desk/releases/tag/v0.2.0)
published reviewed main source
[`efc9d733b3d305d24cf4197444e1d76c99bdb777`](https://github.com/pegma-dev/support-desk/commit/efc9d733b3d305d24cf4197444e1d76c99bdb777).
[Run 42494797076](https://github.com/pegma-dev/support-desk/actions/runs/42494797076)
verified the approved signed tag and main ancestry. Each Node 22/24 lane passed
2,449 tests across 53 test files with zero skips, plus formatting,
types, synthetic examples, five-package pack/import and clean-consumer gates.
The retained synthetic consumer includes actual published application `0.1.1`
forward migration with AI omitted/disabled and optional AI public composition;
it does not certify host durable migration or live-provider behavior.

| Original release binding   | Value                                                              |
| -------------------------- | ------------------------------------------------------------------ |
| Preparation artifact ID    | `13622923209`                                                      |
| Preparation ZIP SHA-256    | `95d87a72bcc5167331a51521173312d959394f1629a019798dd49d0401b81cdd` |
| Canonical manifest SHA-256 | `7c5ccec571711df2f3003d4ea97a19a6a60cba584de05a0ab72636e55ab9e06d` |

The repository retains the [original CI manifest](releases/v0.2.0/package-manifest.json)
without reformatting, plus actual GitHub API snapshots for the
[preparation artifact](releases/v0.2.0/prepared-artifact.json) and
[successful verification job](releases/v0.2.0/verification-job.json).
These corroborate the source, run/job/artifact identifiers and digests above;
they are evidence snapshots, not newly generated release artifacts.

The verification-job snapshot preserves the complete GitHub API response,
including its step numbers: setup `1`, verification steps `2`–`6`, and runner
post steps `11`–`13`. The immutable release's
[`verify` job definition](https://github.com/pegma-dev/support-desk/blob/efc9d733b3d305d24cf4197444e1d76c99bdb777/.github/workflows/publish.yml#L459)
declares five explicit steps; each appears in the snapshot with a successful
conclusion. GitHub's returned numbering is preserved without inserting
records for numbers `7`–`10` or renumbering the post steps.

The [preserved original preparation ZIP](https://github.com/pegma-dev/support-desk/releases/download/v0.2.0/sd06-v0.2.0-artifact-13622923209.zip)
is retained on the existing `v0.2.0` release as asset `724580443` (478,270
bytes). It is the unchanged original Actions archive, not a repack or a new
package publication. Its server-recorded SHA-256 matches the preparation ZIP
digest above.

For a later audit:

1. Download that exact original ZIP and compute its SHA-256 **before extraction**.
   Compare it with the independently recorded preparation ZIP digest above;
   stop on any mismatch.
2. Extract the verified ZIP into an empty directory, recompute SHA-256 for
   `package-manifest.json`, and compare it with the canonical manifest digest
   above. A digest copied only from the downloaded archive cannot authenticate
   that same archive.
3. Retain its five original tarballs and use the immutable release source's
   verification procedure below to check inventory, dependencies and registry
   bytes. This asset does not contain raw postflight audit or consumer output.

The [attempt 1 publisher](https://github.com/pegma-dev/support-desk/actions/runs/42494797076/job/128775870798)
stopped after contracts publication when bounded registry visibility confirmation
expired. Its successful upload response was not treated as a complete release.
Recovery reran the unprivileged
[registry preflight](https://github.com/pegma-dev/support-desk/actions/runs/42494797076/job/128782073644)
and its dependents against the same original preparation. Fresh preflight
authenticated the now-visible exact contracts artifact; the
[attempt 2 publisher](https://github.com/pegma-dev/support-desk/actions/runs/42494797076/job/128782155561)
skipped it and published the remaining four original tarballs. Preparation,
source, tag, manifest and package versions were preserved.

The [strict verification job](https://github.com/pegma-dev/support-desk/actions/runs/42494797076/job/128785494994)
then passed on Node `24.18.0` with the hash-pinned npm `11.18.0` CLI: exact
registry bytes/dependencies, cryptographic registry signatures and Sigstore
source/workflow/tag provenance, a clean registry installation and public-export
imports for all five packages. Its actual dist-tag readback recorded
`latest: 0.2.0` for all five and retained AI's `bootstrap: 0.1.1`. The supported
advertised tuple advances to synchronized `0.2.0`; the registration-only AI
artifact remains immutable and is not a compatibility claim for application
`0.1.1`. No unpublish, version reuse or bootstrap deletion is part of this
roll-forward.

The final verification result is retained in the job log. This workflow does
not upload its raw npm audit output, installed lockfile or a separate postflight
consumer artifact. Preserve the log and original release/consumer/preflight
artifacts under the release owner's retention policy. SDK publication closes
the release gate; both hosts' actual-client, privacy, operations, provider/ZDR,
staging and supervised-pilot acceptance remain separate work.

## Two distinct release paths

| Path                            | Authority and artifact                                                                                                                                                                                                          |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AI name registration            | Manual maintainer 2FA publication of only the prepared AI `0.1.1` tarball from signed `v0.1.1-ai-bootstrap` at frozen SD-05 commit `eddd3526f8bec3a1a80cc7aacd3a4cdcdb950cfe`. No GitHub release or bootstrap OIDC publish job. |
| Advertised synchronized `0.2.1` | All five exact artifacts from reviewed main, protected signed annotated `v0.2.1`, and the environment-protected GitHub OIDC workflow, followed by strict registry verification.                                                 |

The bootstrap's other four local tarballs are import-test context only. They
are never eligible for manual publication. The existing four names do not
need another manual bootstrap. Do not use bootstrap as a token/manual fallback
for the stable release.

## Required configuration and evidence

The release owner must verify the actual current configuration, rather than
relying on historical setup:

- all five npm packages have the intended GitHub trusted publisher for
  `pegma-dev/support-desk`, `publish.yml`, environment `npm-publish`, and the
  allowed publish operation;
- `npm-publish` has the required maintainer approval protection;
- `RELEASE_ALLOWED_SIGNERS` contains the reviewed SSH allowed-signers entries;
- active `v*` tag rules cover creation, updates, deletion, and non-fast-forward
  changes, with only the expected configured maintainer bypass authority;
- npm ownership, publication policy, and actual dist-tags are correct,
  including after the new AI name registration.

The stable workflow uses npm trusted-publisher OIDC only. Do not add
`NODE_AUTH_TOKEN`, an automation token, or another credential fallback.
The single manual AI registration is documented separately and supplies no
OIDC provenance.

Anonymous ruleset responses may omit `bypass_actors`. Public preparation
checks cannot establish the full bypass policy; an omitted field remains
unknown. The release owner must independently read the complete current
policy through existing authenticated GitHub CLI access outside the build
before tag creation/preparation dispatch and again before the manual AI
registration. For the configured ruleset:

```sh
gh api repos/pegma-dev/support-desk/rulesets/20011989
```

Confirm the active tag scope, required rules, and expected maintainer bypass
actors. Retain the full readback privately with the activation/2FA handoff.
Do not pass an authenticated token or a stale policy receipt into unprivileged
preparation; that workflow never publishes and does not verify omitted bypass
actors. Stable publication retains its separate protected OIDC workflow gates.

The registration-only bootstrap intentionally pins the configured ruleset and
expected maintainer bypass actor/type/mode in `verifyPublicTagRules` within
`scripts/ai-bootstrap.mjs`. Authority or ruleset rotation requires reviewed
code and policy-fixture/test changes together with the live policy update;
updating `RELEASE_ALLOWED_SIGNERS` alone is insufficient. Keep the independent
authenticated policy readback even when the visible policy matches that pin.

Before a release is advertised, the current head must pass format, type,
runtime, real-store integration, and release checks on Node 22 and 24, plus
required code/security review. The source commands include:

```sh
pnpm run format:check
pnpm run check
pnpm test
pnpm run release:check
pnpm run release:pack -- --require-clean --output .release/candidate
pnpm run ai:example
```

The packer builds the exact five packages, checks file/export/dependency
inventory and tarball hashes, and imports the prepared set in a clean consumer.
The separate `<output>-consumer-verification.json` receipt (by default
`.release-consumer-verification.json`) records synthetic base/forward-migration
scenarios from the actual published `0.1.1` application with AI options omitted
and disabled, plus the optional AI public composition's type/runtime checks.
It explicitly records that reverse rollback is unproven. Keep this receipt
outside the strict artifact directory, which contains only the canonical
manifest and five tarballs. The receipt binds the source repository/commit,
each actual candidate archive's name/size/SHA-256/SHA-1/SHA-512 integrity,
the genuine previous installation's registry URL and lockfile integrity,
resolved dependencies, actual Node/V8/platform/architecture, and the explicit
nondurable Storage Core memory adapter. The migration scope is old web records
only; inbound email is candidate-only. Historical SD-05 results do not certify
SD-06, and a clean memory consumer does not certify a host's durable migration.

## Stable tag and workflow

After the reviewed release PR is merged and every current-head gate is green,
the authorized maintainer creates the protected signed annotated stable tag at
the exact `origin/main` commit, pushes it, and creates its verified GitHub
release. The current verified release identity is `v0.2.1`; SD-06's `v0.2.0`
identity remains historical.
Do not create a GitHub release for `v0.1.1-ai-bootstrap`.

`.github/workflows/publish.yml` prepares from the exact stable release identity.
It verifies signer/tag/main ancestry and release-event commit, runs its gates,
and uploads the immutable prepared inventory. Preserve the artifact ID/digest,
independently recorded manifest SHA-256, workflow run/attempt, source commit,
and reviewed tool/workflow identity. An expected digest must not come only
from the same untrusted downloaded manifest it is supposed to authenticate.

Consumer evidence is retained separately for 30 days in
`support-desk-consumer-<run_id>-<run_attempt>`. Before uploading it, the prepare
job independently hashes the receipt's actual bytes and validates its source,
archive, runtime, and Store bindings against that preparation. Its outputs are
`consumer-receipt-sha256`, `consumer-artifact-id`, and
`consumer-artifact-digest`. The job summary records those values beside the
original release artifact ID/archive SHA-256, independent manifest SHA-256,
and source tag/commit. Record these independent values before environment
approval; a digest copied only from a downloaded receipt does not authenticate
that receipt.

Each Node validation lane also retains its own manifest and receipt for 30
days in `support-desk-validation-consumer-node<node-version>-<run_id>-<run_attempt>`,
with the source identity, independent manifest/receipt hashes, and upload
artifact ID/digest in its summary. Those lane reports supplement the original
prepare evidence; they do not replace its exact five tarballs. Download the
separate artifacts by their immutable IDs and check the independently recorded
archive and file digests before matching receipt bindings to the selected
commit and archives. Preserve the release evidence under the owner's retention
policy before Actions retention expires. Missing or mismatched evidence blocks
approval; an unchanged version string cannot substitute for it.

The unprivileged `registry-preflight` job runs after `identity` and `prepare`,
without a protected environment or OIDC authority. It downloads the original
prepared artifact and uses the pinned npm CLI to authenticate the complete
already-present candidate subset before further uploads. The subset must be
dependency-closed. A fresh registry installation with scripts disabled performs
the actual npm signature/Sigstore and source-provenance checks, without
importing those packages. If all five versions are absent, the receipt records
that no audit occurred (`npmVersion: null`); absence is not authenticated
publication evidence.

The common independent CLI bindings are:

```text
node scripts/release-verification.mjs <preflight|publish|verify> --manifest .release/package-manifest.json --manifest-sha256 SHA256 --release-tag vX.Y.Z --expected-release-commit COMMIT
```

Both `preflight` and `publish` also require
`--prepared-artifact-id ORIGINAL_ID --prepared-artifact-sha256 ORIGINAL_ZIP_SHA`.
These bind the original preparation's immutable upload ID/archive digest from
trusted `needs.prepare` outputs. The receipt's `preparedArtifact: { id, sha256 }`
must match those independently supplied values; it cannot authenticate itself.

`preflight` emits its authenticated observation as JSON. The workflow retains
`registry-preflight.json` for 30 days in the separate immutable artifact
`support-desk-registry-preflight-<run_id>-<run_attempt>`. Its outputs are
`receipt-sha256`, `artifact-id`, and `artifact-digest`. The summary binds those
independent values to the source tag/commit, original manifest SHA-256, and
original prepared artifact ID/archive digest. Keep this evidence outside the
strict six-file directory.

`publish` additionally requires the downloaded receipt and its independently
recorded file digest:

```text
node scripts/release-verification.mjs publish --manifest .release/package-manifest.json --manifest-sha256 SHA256 --release-tag vX.Y.Z --expected-release-commit COMMIT --prepared-artifact-id ORIGINAL_ID --prepared-artifact-sha256 ORIGINAL_ZIP_SHA --preflight-receipt PREFLIGHT_DOWNLOAD/registry-preflight.json --preflight-receipt-sha256 TRUSTED_PREFLIGHT_SHA256
```

The package scripts `release:preflight`, `release:publish`, and `release:verify`
select the corresponding subcommand. The workflow supplies the exact manifest
digest/tag/commit and the reviewed npm runtime through `RELEASE_NPM_CLI` and
`RELEASE_NPM_VERSION` (`11.18.0`). Do not substitute pnpm's `npm_execpath` or an
unreviewed npm executable.

`publish` is for the trusted GitHub release runtime and protected environment,
not a local manual stable-release command. Only its minimal publish job receives
`id-token: write`; it publishes the prepared bytes in dependency order after
the separate unprivileged registry preflight succeeds. It authenticates the
separately downloaded receipt against the trusted file digest and original
release/artifact identity. The receipt's `authenticatedAt` is canonical
observation metadata, not an age-based expiry gate. Staleness means a mismatch
in source, tag, commit, manifest, original artifact, or existing registry subset.
Before each upload, fresh whole-five-package checks allow only the authenticated
existing subset plus this invocation's own confirmed writes. An unverifiable
or newly present package, or any binding/subset drift, blocks further uploads
and requires fresh preflight; newly present packages are not silently skipped.
The receipt's own upload ID/archive digest and independent file SHA-256 remain
external trusted bindings, never self-embedded proof.
No source rebuild, dependency installation, signature audit, provider credential,
or token fallback belongs in the privileged publish job. The unprivileged `verify` operation still binds
the expected repository, workflow, tag, and commit; lack of publish authority
does not weaken artifact/provenance verification.

Strict verification must establish all five exact registry versions, bytes,
file inventory, dependency tuples, cryptographic signatures, and source/workflow
provenance, then exercise clean consumers. Record actual dist-tags as observed.
The release is not complete because a package page exists or npm returned a
successful publish response. Keep the canonical manifest and strict verification
receipt with the release handoff before changing host pins.

## Partial publication and recovery

Keep the release tag, commit, manifest, and tarballs unchanged, retaining the
original prepare outputs and both the release and consumer-evidence artifacts.
For a publication failure or uncertain upload, re-run the unprivileged
`registry-preflight` job and its publication/verification dependents against
that original preparation. Re-running only the failed publish job can reuse an
obsolete observation; refresh preflight rather than treating it as recovery. Do not
re-run `prepare`, re-run all jobs, repack, or create another tag for recovery:

- a genuinely absent exact version may be published;
- an existing identical artifact is authenticated in the fresh unprivileged
  preflight and skipped only while its receipt's exact set still matches;
- mismatched bytes/dependencies, unverifiable provenance, or a registry error
  other than the recognized absent-version case stops recovery.

Never unpublish/reuse a version, move a tag, rebuild a different artifact under
the same identity, or manually fill a stable-release gap. A failed final verify
leaves the release unverified even if some packages were accepted. Preserve
receipts and diagnose the actual failed stage before another attempt.
If publication succeeded and only final registry verification failed, re-run
`verify` alone with the original preparation; no further uploads are authorized.

## Historical original-name bootstrap

The first four names were manually registered at `0.1.0` on 2026-07-29 from
prepared tarballs at release-candidate commit `6f1d539`. Signed `v0.1.0` and its
GitHub release then exercised signature/gate/preparation and registry-integrity
skip behavior. That historical bootstrap had no OIDC provenance and did not
prove a live trusted-publisher upload. It must not be repeated for those names.

Their later published `0.1.1` artifacts remain immutable historical releases.
The later five-package `0.2.0` publication is recorded above; host adoption
retains its separate acceptance gates.
