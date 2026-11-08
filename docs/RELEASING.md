# Release operations

The SD-06 synchronized release candidate is **0.2.0** for all five public
packages, in dependency order:

1. `@pegma/support-desk-contracts`
2. `@pegma/support-desk-core`
3. `@pegma/support-desk-templates`
4. `@pegma/support-desk-application`
5. Optional `@pegma/support-desk-ai`

This is release preparation, not a publication receipt. The original four
package names have published `0.1.0`/`0.1.1` artifacts. Newer source at `0.1.1`
contains merged SD-01 through SD-05 behavior and must not overwrite those
versions. The new AI name has a separate registration-only
[0.1.1 bootstrap](AI_BOOTSTRAP.md); that artifact is not host-usable and is not
the first advertised synchronized release.

Merging a PR, preparing tarballs, or creating a tag does not establish a
verified release. Host adoption waits for exact published artifacts, strict
verification, and each host's own acceptance. See [release notes](RELEASE_NOTES.md),
[upgrading](UPGRADING.md), and [AI operations](AI_OPERATIONS.md).

## Two distinct release paths

| Path                            | Authority and artifact                                                                                                                                                                                                          |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AI name registration            | Manual maintainer 2FA publication of only the prepared AI `0.1.1` tarball from signed `v0.1.1-ai-bootstrap` at frozen SD-05 commit `eddd3526f8bec3a1a80cc7aacd3a4cdcdb950cfe`. No GitHub release or bootstrap OIDC publish job. |
| Advertised synchronized `0.2.0` | All five exact artifacts from reviewed main, protected signed annotated `v0.2.0`, and the environment-protected GitHub OIDC workflow, followed by strict registry verification.                                                 |

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
manifest and five tarballs. Current receipts must bind their artifacts and
head; historical SD-05 results do not certify SD-06, and a clean memory consumer
does not certify a host's durable migration.

## Stable tag and workflow

After the reviewed release PR is merged and every current-head gate is green,
the authorized maintainer creates the protected signed annotated stable tag at
the exact `origin/main` commit, pushes it, and creates its verified GitHub
release. For the selected candidate, the release identity is `v0.2.0`.
Do not create a GitHub release for `v0.1.1-ai-bootstrap`.

`.github/workflows/publish.yml` prepares from the exact stable release identity.
It verifies signer/tag/main ancestry and release-event commit, runs its gates,
and uploads the immutable prepared inventory. Preserve the artifact ID/digest,
independently recorded manifest SHA-256, workflow run/attempt, source commit,
and reviewed tool/workflow identity. An expected digest must not come only
from the same untrusted downloaded manifest it is supposed to authenticate.

The strict CLI is:

```text
node scripts/release-verification.mjs <preflight|publish|verify> --manifest .release/package-manifest.json --manifest-sha256 SHA256 --release-tag v0.2.0 --expected-release-commit COMMIT
```

The package scripts `release:preflight`, `release:publish`, and `release:verify`
select the corresponding subcommand. The workflow supplies the exact manifest
digest/tag/commit and the reviewed npm runtime through `RELEASE_NPM_CLI` and
`RELEASE_NPM_VERSION` (`11.18.0`). Do not substitute pnpm's `npm_execpath` or an
unreviewed npm executable.

`publish` is for the trusted GitHub release runtime and protected environment,
not a local manual stable-release command. Only its minimal publish job receives
`id-token: write`; it publishes the prepared bytes in dependency order. No
source rebuild, dependency installation, provider credential, or token fallback
belongs in that privileged job. The unprivileged `verify` operation still binds
the expected repository, workflow, tag, and commit; lack of publish authority
does not weaken artifact/provenance verification.

Strict verification must establish all five exact registry versions, bytes,
file inventory, dependency tuples, cryptographic signatures, and source/workflow
provenance, then exercise clean consumers. Record actual dist-tags as observed.
The release is not complete because a package page exists or npm returned a
successful publish response. Keep the canonical manifest and strict verification
receipt with the release handoff before changing host pins.

## Partial publication and recovery

Keep the release tag, commit, manifest, and tarballs unchanged. Re-run only the
appropriate trusted workflow jobs:

- a genuinely absent exact version may be published;
- an existing identical artifact is verified and skipped;
- mismatched bytes/dependencies, unverifiable provenance, or a registry error
  other than the recognized absent-version case stops recovery.

Never unpublish/reuse a version, move a tag, rebuild a different artifact under
the same identity, or manually fill a stable-release gap. A failed final verify
leaves the release unverified even if some packages were accepted. Preserve
receipts and diagnose the actual failed stage before another attempt.

## Historical original-name bootstrap

The first four names were manually registered at `0.1.0` on 2026-07-29 from
prepared tarballs at release-candidate commit `6f1d539`. Signed `v0.1.0` and its
GitHub release then exercised signature/gate/preparation and registry-integrity
skip behavior. That historical bootstrap had no OIDC provenance and did not
prove a live trusted-publisher upload. It must not be repeated for those names.

Their later published `0.1.1` artifacts remain immutable historical releases.
The new five-package `0.2.0` verification and host adoption gates are separate.
