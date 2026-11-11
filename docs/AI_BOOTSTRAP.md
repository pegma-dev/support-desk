# AI package name registration

This records the completed one-time npm name registration for `@pegma/support-desk-ai@0.1.1`,
not a supported host installation or the synchronized release. The immutable
registry application `0.1.1` lacks exports required by this newer AI source.
Importing five local source tarballs proves only that isolated assembly.
Hosts use the separately verified published five-package `0.2.4` release.
Its optional AI package pins Knowledge Base application and contracts to
exact `0.1.5`. The engineering review guard correction shipped in `0.2.3`;
this checkout's `0.2.5` source remains an unpublished candidate for attachments
and staged human learning reviews. Host adoption
and activation have separate gates.
[Publication receipt](RELEASING.md#verified-024-publication-2026-11-11) · [Engineering review guide](ENGINEERING_EXPORT.md)

AI's `0.1.1` registration artifact remains immutable. At the `0.2.1`
verification checkpoint on 2026-11-10, the mutable dist-tags were
`bootstrap: 0.1.1` and `latest: 0.2.1`. The later `0.2.2` verification observed
`bootstrap: 0.1.1` and `latest: 0.2.2`. Do not repeat registration or replace
the bootstrap artifact to repair its registry dependency tree.

## Fixed identity and limited authority

| Field                       | Required value                                                          |
| --------------------------- | ----------------------------------------------------------------------- |
| Repository                  | `pegma-dev/support-desk`                                                |
| Frozen source commit        | `eddd3526f8bec3a1a80cc7aacd3a4cdcdb950cfe` (merged SD-05)               |
| Signed annotated source tag | `v0.1.1-ai-bootstrap`                                                   |
| Preparation workflow        | `.github/workflows/prepare-ai-bootstrap.yml` from reviewed main tooling |
| Eligible publication        | Only `pegma-support-desk-ai-0.1.1.tgz`                                  |
| Manifest purpose            | `npm-name-registration-only`                                            |
| Receipt flags               | `hostUsable: false`, `oidcProvenance: false`                            |

The source tag is distinct from historical `v0.1.1`. Do not move either tag
or create a GitHub release for the bootstrap tag. The preparation workflow has
read-only repository permissions, no OIDC authority, and no publish job.
Manual maintainer 2FA registration does not gain OIDC provenance because its
input came from Actions.

The workflow prepares all five local `0.1.1` source tarballs and imports that
complete context. The other four tarballs are never eligible for publication;
their registry versions already exist and cannot be replaced. The bootstrap
does not change the stable release's trusted-publisher-only policy.

## Prepare and authenticate the handoff

Use the reviewed main tooling and a separate clean checkout of the fixed
source tag. Verify the signed annotated tag, approved signer, exact commit,
and protected main ancestry before executing source install/build scripts.
The workflow performs this ordering. Tool and workflow commit identities are
separate from the frozen source commit and must match the reviewed main run.

Unprivileged preparation checks the fresh public active `v*` rules for tag
creation, updates, deletion, and non-fast-forward changes. Anonymous ruleset
responses can omit `bypass_actors`; omission means unknown, not verified empty.
Unexpected actors are rejected if exposed. Preparation does not verify the
complete bypass policy and never publishes.

Before creating the tag or dispatching preparation, the release owner must
read the complete current policy outside the build using existing authenticated
GitHub CLI access, for example:

```sh
gh api repos/pegma-dev/support-desk/rulesets/20011989
```

Confirm the active tag scope, required rules, and only the expected configured
maintainer bypass authority. Retain a private operations receipt; do not add
credentials or a stale policy receipt to the unprivileged workflow. Repeat
this full readback immediately before manual publication and include its
current result in the maintainer's 2FA handoff.

The bootstrap code intentionally pins the configured ruleset identity and
the expected maintainer bypass actor/type/mode. Rotating that authority or
ruleset requires a reviewed update to `verifyPublicTagRules` in
`scripts/ai-bootstrap.mjs`, its policy fixtures/tests, and the live policy.
Update signer configuration where required as well; changing only
`RELEASE_ALLOWED_SIGNERS` does not rotate this separate policy binding.

The CLI has only `verify-source`, `prepare`, `preflight`, and `postflight`.
For a separately approved preparation, its interface is:

```sh
node scripts/ai-bootstrap.mjs verify-source --source-root "$BOOTSTRAP_SOURCE_ROOT" --tool-root "$BOOTSTRAP_TOOL_ROOT"
node scripts/ai-bootstrap.mjs prepare --source-root "$BOOTSTRAP_SOURCE_ROOT" --tool-root "$BOOTSTRAP_TOOL_ROOT" --output "$BOOTSTRAP_PREPARED_DIR"
```

The source and tool roots must be separate clean checkouts; the output must be
outside both. Preparation emits `bootstrap-manifest.json`, its SHA-256, and
`context/package-manifest.json`. The bootstrap manifest binds the signed tag
object, frozen source, tool/workflow commits, full-context manifest digest,
five local imports, and the AI-only tarball's bytes, hashes, dependency tuple,
and file inventory.

After upload, retain the workflow run/attempt, artifact ID, manifest SHA-256,
and upload action's artifact ZIP SHA-256 independently of the downloaded
archive. The ZIP digest cannot be embedded in its own manifest. Download that
exact artifact by ID and preserve the original ZIP as well as its extraction.
Do not use a mutable artifact name or a hash asserted only by the downloaded
manifest as independent authentication.

## Maintainer registration and postflight

Using the independently retained values, run preflight against the extracted
handoff and original downloaded ZIP:

```sh
node scripts/ai-bootstrap.mjs preflight --prepared-dir "$BOOTSTRAP_PREPARED_DIR" --manifest-sha256 "$BOOTSTRAP_MANIFEST_SHA256" --expected-tool-commit "$BOOTSTRAP_TOOL_COMMIT" --artifact-archive "$BOOTSTRAP_ARTIFACT_ZIP" --artifact-sha256 "$BOOTSTRAP_UPLOAD_SHA256"
```

Preflight validates the complete handoff and registry identity. A genuinely
absent exact version permits `action: "publish"`; an identical visible version
returns `action: "skip"`. Mismatched content or other registry errors stop the
handoff. A skip does not prove the package is host-usable.

There is no publish subcommand. Only after reviewing the concrete artifact
and preflight receipt does the authorized maintainer use its
`maintainerCommand`, replacing `PREPARED_DIRECTORY` with that verified
directory. The command publishes only the AI tarball, with `--access public`,
`--ignore-scripts`, the official npm registry, and `--tag bootstrap`. It omits
`--provenance` and requires the maintainer's interactive 2FA authority. Do not
add a token-based automation path or manually publish any sibling tarball.

Then run the same binding through postflight:

```sh
node scripts/ai-bootstrap.mjs postflight --prepared-dir "$BOOTSTRAP_PREPARED_DIR" --manifest-sha256 "$BOOTSTRAP_MANIFEST_SHA256" --expected-tool-commit "$BOOTSTRAP_TOOL_COMMIT" --artifact-archive "$BOOTSTRAP_ARTIFACT_ZIP" --artifact-sha256 "$BOOTSTRAP_UPLOAD_SHA256"
```

Postflight requires the exact visible registry bytes and records the actual
`distTags`. Preserve that receipt even if registry visibility needs a later
retry. Timeout or an uncertain publish response does not authorize a different
artifact or version reuse. `hostUsable` and `oidcProvenance` remain false.

## Required handoff before the stable release

The package maintainer must separately verify actual npm ownership, 2FA and
publication policy, dist-tags, and the new name's trusted publisher for the
stable workflow/repository/environment. A bytes receipt does not attest those
account settings. Do not infer them from the intended configuration.

Retain the source/tag object, tool/workflow commits, run/attempt, artifact ID,
both independently recorded digests, tarball hashes, preflight/postflight
receipts, actual dist-tags, and the settings verification. Those are required
records for the completed registration, not a substitute for synchronized
trusted-release verification. The `0.2.0` and `0.2.1` releases have dated
receipts. Name registration closes no host, client, staging, or pilot
acceptance gate. [Historical `0.2.0` receipt](RELEASING.md#verified-sd-06-publication-2026-11-08) · [Historical `0.2.1` receipt](RELEASING.md#verified-021-publication-2026-11-10)
