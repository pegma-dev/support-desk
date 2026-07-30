# Release operations

Support Desk publishes four public packages as a synchronized exact set:

1. `@pegma/support-desk-contracts`
2. `@pegma/support-desk-core`
3. `@pegma/support-desk-templates`
4. `@pegma/support-desk-application`

Every release goes through the environment-protected GitHub OIDC workflow on
a signed annotated `vX.Y.Z` tag. The one-time manual bootstrap that first
created the package names is complete (see the historical record below) and
must not be repeated.

Merging a pull request never publishes. The publish workflow has no token
fallback and no `workflow_dispatch` path.

## Standing external configuration

The following is configured and must stay in place for OIDC releases to work:

- each public package on npm has the GitHub Actions trusted publisher for
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

## Common source requirements

Every published artifact comes from a protected, signed, annotated `vX.Y.Z`
tag whose commit is already contained in `origin/main`.

Run `npm run format:check`, `npm run check`, and `npm test` on Node 22 and 24.
Additionally:

```sh
npm run release:check
```

The packer builds once, runs `npm pack` for every public workspace, verifies
that tarballs contain only `package.json`, `README.md`, `LICENSE`, and `dist/**`,
checks npm's SHA-1 and SHA-512 values, and imports every public export from a
clean consumer install of those tarballs.

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
comparison, and the skip-on-identical-integrity path. It did not perform a
live trusted-publisher publication: the first OIDC `npm publish` with
provenance remains unexercised until the next version ships through the
workflow.

No further manual `npm publish` is needed for the existing four package
names. Only a brand-new package name added to the set requires a bootstrap:
one manual 2FA publish of the prepared tarball, then configure trusted
publishing for it before the next tagged release.

## OIDC releases (`0.1.1` and beyond)

Update package versions, internal exact pins, the lockfile, and
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
receives `id-token: write`; it installs no dependencies and publishes the
exact prepared tarballs with provenance in dependency order.

## Partial-publish recovery

The workflow is globally serialized. Re-run failed release jobs against the
same unchanged tag:

- an absent version is published;
- an existing version with identical `dist.integrity` is verified and skipped;
- a different integrity, or any registry error other than `E404`, stops before
  later packages publish.
