# Release operations

The historically published Support Desk set contains four packages. SD-02's
current source release inventory contains five, in dependency order:

1. `@pegma/support-desk-contracts`
2. `@pegma/support-desk-core`
3. `@pegma/support-desk-templates`
4. `@pegma/support-desk-application`
5. `@pegma/support-desk-ai` — new, optional, unpublished source candidate

Every release goes through the environment-protected GitHub OIDC workflow on
a signed annotated `vX.Y.Z` tag. The one-time manual bootstrap that first
created the original four package names is complete (see the historical record
below) and must not be repeated. The new AI package has its own first-name
bootstrap and trusted-publisher activation prerequisites before a future
advertised release; it is not covered by that historical completion.

Merging a pull request never publishes. The publish workflow has no token
fallback and no `workflow_dispatch` path.

Current source remains `0.1.1` and includes unreleased lifecycle, SD-01
handling/handoff, merged SD-02 coordination, and the SD-03 learning candidate beyond the
published artifacts at that version. SD-02 adds the optional AI package to
`RELEASE_PACKAGES` and pack checks; this is source inventory, not publication
or release authority. The enhancement needs a future reviewed synchronized
version under SD-06, with verified registry artifacts, before host adoption; never replace
the existing `0.1.1` registry artifacts. Source dependency pins and registry
baselines are recorded separately in [P-00](KNOWLEDGE_AI_P00.md).
The optional AI package consumes exact verified KB `0.1.2` dependencies;
[producer receipts](HOST_COMPOSITION.md#kb-authoring-producers) close that
prerequisite only. Current-head SD-03 gates and review remain required; SD-02's
source passed its gates before merging in PR #38.

## Standing external configuration

The following is configured and must stay in place for OIDC releases to work:

- each of the original four public packages on npm has the GitHub Actions trusted publisher for
  organization `pegma-dev`, repository `support-desk`, workflow `publish.yml`,
  environment `npm-publish`, and allowed action `npm publish`;
- the GitHub `npm-publish` environment exists and requires the release
  maintainer's approval before the publish job runs;
- the Actions variable `RELEASE_ALLOWED_SIGNERS` holds the reviewed Git SSH
  allowed-signers entry for the maintainer's release key; and
- the active "Protect release tags" ruleset targeting `v*` prevents tag
  updates and deletions and limits tag creation to the release maintainer.

Do not add `NODE_AUTH_TOKEN`, an npm automation token, or another credential
to this repository.

For the new `@pegma/support-desk-ai` name, the release owner must separately
review npm ownership, the exact immutable bootstrap version/artifact, manual
maintainer 2FA publication, and trusted-publisher configuration. The bootstrap
must remain distinct from the first advertised trusted release and supplies
no OIDC provenance. Confirm the new package's publisher entry and the existing
protected environment, signer, and immutable-tag rules for its advertised
release, then verify the full synchronized set's registry bytes, exact
dependencies, provenance, and clean consumers. This source PR authorizes none
of those external publishing actions and assigns no future tag or version.

## Common source requirements

Every published artifact comes from a protected, signed, annotated `vX.Y.Z`
tag whose commit is already contained in `origin/main`.

Run `pnpm run format:check`, `pnpm run check`, and `pnpm test` on Node 22 and 24.
Additionally:

```sh
pnpm run release:check
```

The packer builds once, runs `npm pack` for every public workspace, verifies
that tarballs contain only `package.json`, `README.md`, `LICENSE`, and `dist/**`,
checks npm's SHA-1 and SHA-512 values, and imports every public export from a
clean consumer install of those tarballs.
The current source check includes all five candidates, including optional AI.
It does not prove that AI is on the registry or authorize host installation.

Never unpublish and reuse a version.

## Completed `0.1.0` bootstrap (historical record)

Brand-new package names cannot use trusted publishing until the package
exists (https://github.com/npm/cli/issues/8544), so the first synchronized
`0.1.0` set was published manually by the release maintainer on 2026-07-29
from tarballs prepared with `npm run release:pack -- -- --require-clean` at
the `0.1.0` release-candidate commit (`6f1d539`).

The signed annotated tag `v0.1.0` and its GitHub release were then created at
that same commit. The resulting publish workflow run verified the tag
signature against the approved signers, ran the complete gate, confirmed
every registry tarball's `dist.integrity` matched the freshly prepared
tarballs, and skipped re-publishing all four packages. That run exercised
signed-tag verification, the gate, artifact preparation, integrity
comparison, and the skip-on-identical-integrity path. At that historical
checkpoint it did not perform a live trusted-publisher publication; the first
OIDC `npm publish` with provenance was still to be exercised by a later release.

No further manual `npm publish` is needed for the existing four package
names. Only a brand-new package name added to the set requires a bootstrap:
one manual 2FA publish of the prepared tarball, then configure trusted
publishing for it before the next tagged release.

## OIDC releases (`0.1.1` and beyond)

Update package versions, internal exact pins, `pnpm-lock.yaml`, and
[RELEASE_NOTES.md](RELEASE_NOTES.md) through a reviewed pull request. After
merge:

```sh
# at the exact origin/main commit
git tag --sign vX.Y.Z -m "Support Desk vX.Y.Z"
git push origin vX.Y.Z
gh release create vX.Y.Z --verify-tag
```

The preparation job verifies the signer, tag, release-event commit, main
ancestry, complete gate, package inventory, and tarball integrity. The run
then pauses at the `npm-publish` environment until the release maintainer
approves the deployment on the run page. Only the final `npm-publish` job
receives `id-token: write`; it installs no dependencies, does not download
pnpm, and publishes the exact prepared tarballs with provenance in
dependency order by invoking `node scripts/release-packages.mjs publish`.

## Partial-publish recovery

The workflow is globally serialized. Re-run failed release jobs against the
same unchanged tag:

- an absent version is published;
- an existing version with identical `dist.integrity` is verified and skipped;
- a different integrity, or any registry error other than `E404`, stops before
  later packages publish.
