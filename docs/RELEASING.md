# Release operations

Support Desk publishes four public packages as a synchronized exact set:

1. `@pegma/support-desk-contracts`
2. `@pegma/support-desk-core`
3. `@pegma/support-desk-templates`
4. `@pegma/support-desk-application`

There are two publication paths:

1. a one-time manual first publication of each package name (required before
   npm trusted publishing can be configured on a package that does not exist
   yet); and
2. every later advertised release through the environment-protected GitHub
   OIDC workflow on a signed annotated `vX.Y.Z` tag.

Merging a pull request never publishes. The publish workflow has no token
fallback and no `workflow_dispatch` path.

## Required external configuration

Before OIDC releases work for a package:

- publish that package once under the reviewed version (first package bootstrap
  or first `0.1.0` set, see below);
- configure each public package on npm with the GitHub Actions trusted
  publisher for organization `pegma-dev`, repository `support-desk`, workflow
  `publish.yml`, environment `npm-publish`, and allowed action `npm publish`;
- create the GitHub `npm-publish` environment;
- set the Actions variable `RELEASE_ALLOWED_SIGNERS` to the reviewed Git SSH
  allowed-signers entry for the maintainer's release key; and
- create an active tag ruleset targeting `v*` that prevents tag updates and
  deletions and limits tag creation to the release maintainer.

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

## First synchronized `0.1.0` publication

Nothing under `@pegma/support-desk-*` is on the public registry yet. Brand-new
package names cannot use trusted publishing until the package exists
(https://github.com/npm/cli/issues/8544).

After the release-candidate change that pins all four packages to `0.1.0` is
merged:

1. Check out the exact `origin/main` commit that carries `0.1.0`.
2. Run the complete gate and `npm run release:check`.
3. Prepare tarballs on a clean tree:

   ```sh
   npm run release:pack -- -- --require-clean --output .release
   ```

4. Interactively authenticate to npm with 2FA (do not store a token in the
   repository, shell history, or CI secrets).
5. Publish the four prepared tarballs in dependency order with public access:

   ```sh
   npm publish ./.release/pegma-support-desk-contracts-0.1.0.tgz --access public
   npm publish ./.release/pegma-support-desk-core-0.1.0.tgz --access public
   npm publish ./.release/pegma-support-desk-templates-0.1.0.tgz --access public
   npm publish ./.release/pegma-support-desk-application-0.1.0.tgz --access public
   ```

6. Immediately configure trusted publishing for each package against
   `publish.yml` and environment `npm-publish`.
7. Create the protected signed annotated tag `v0.1.0` at that exact commit only
   after the packages are visible with the expected integrity (or create the
   tag first and use a later OIDC release only when trusted publishing is
   already configured — for this first ship, manual publish of the prepared
   tarballs is the bootstrap).

Hosts must not install until `npm view @pegma/support-desk-application version`
returns `0.1.0` for all four packages.

## Later OIDC releases (`0.1.1` and beyond)

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
ancestry, complete gate, package inventory, and tarball integrity. Only the
final `npm-publish` job receives `id-token: write`; it installs no
dependencies and publishes the exact prepared tarballs with provenance in
dependency order.

## Partial-publish recovery

The workflow is globally serialized. Re-run failed release jobs against the
same unchanged tag:

- an absent version is published;
- an existing version with identical `dist.integrity` is verified and skipped;
- a different integrity, or any registry error other than `E404`, stops before
  later packages publish.
