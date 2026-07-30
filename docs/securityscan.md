# Security Scan — support-desk

Date: 2026-07-29
Scanner: security-scan skill (read-only; no source files were modified)

## Phase 0 — Recon

### Stack

- TypeScript (ESM), Node >= 22, npm workspaces (`packages/*`), vitest for tests.
- Packages: `@pegma/support-desk-contracts` (contracts), `packages/core` (pure
  ticket workflow), `packages/application` (application services, workers,
  queue projection, receipts, outbound mail — bulk of code), `packages/templates`
  (constrained email templates).
- External deps: `@pegma/storage-core` (persistence port), `@pegma/authorization-core`
  (permission checks), `@pegma/spine` (shared types), `@pegma/mail@0.1.0`,
  `@pegma/audit@0.1.0`. Dev-only: `@pegma/storage-azure-tables`, Azure Tables
  SDK, Azurite, prettier, typescript, vitest.
- No HTTP framework in-repo: this is a library; hosts compose HTTP entry points
  themselves (`examples/composition` is the framework-free, explicitly
  non-production example).

### Trust boundaries

- **Inbound email**: no MIME parsing exists in this repo; the contracts package
  documents that raw MIME/unsanitized HTML must never reach stored contracts.
  Inbound processing is host-adapter work (see Unverified list).
- **Customer-facing service calls**: command DTOs are boundary-validated
  (own-data-property snapshots, identifier/length/control-char checks) and
  authorized via `AccessContext` + resource-level ownership checks.
- **Staff-facing service calls**: permission checks against Authorization Core
  (`queueRead` plus the specific mutation permission).
- **Delivery callbacks**: `recordDeliveryCallback` trusts its caller; provider
  webhook signature verification is documented host work.
- **Outbound mail rendering**: attacker-influenced content (message bodies,
  notification variables) rendered through a constrained, validated template
  engine with full HTML escaping and HTTPS-only URL variables.
- **Storage adapter boundary**: all persistence via `@pegma/storage-core` port;
  keys derived from validated identifiers; no query language anywhere.
- **CI/release**: GitHub Actions (`ci.yml`, `codeql.yml`, `publish.yml`) with
  SHA-pinned actions, OIDC trusted publishing, signed-tag verification.

### Scope

In scope:

- `packages/{contracts,core,application,templates}/src/**/*.ts` (excluding `dist/`)
- `examples/composition/**`
- `scripts/release-packages.mjs`
- `tests/**`, `test/**` (test infrastructure, reviewed lightly)
- `.github/workflows/**`

Excluded:

- `node_modules/`, `package-lock.json` content, `dist/`, `.release/`, generated files
- `docs/**` (prose, except to confirm documented trust assignments)

## Phase 1 — Mechanized sweeps (raw results)

- **Dependency audit** (`npm audit`): 12 vulnerabilities (5 high, 7 moderate),
  **all** transitive through the dev-only `azurite` test emulator
  (`@opentelemetry/core`, `brace-expansion` via rimraf/glob, `uuid` via
  ms-rest-js/sequelize, `applicationinsights`). See Finding 1.
- **DOM XSS sinks** (`dangerouslySetInnerHTML`, `innerHTML`, `eval(`,
  `new Function`, `document.write`, `exec(`, `spawn(`): no sinks. Only regex
  `.exec()` calls (safe) and `spawn` in `test/azurite.ts` with a static
  argument array (Azurite path + fixed flags) — no untrusted input.
- **Secrets** (`AKIA…`, `PRIVATE KEY`, `AccountKey=`): the only hit is the
  well-known public Azurite emulator key (`devstoreaccount1` /
  `Eby8vdM02x…`) in `tests/*.ts` — a documented Microsoft development
  constant, not a credential. Not a finding.
- **CORS/redirects/SSRF**: no HTTP server code, no `fetch`/HTTP clients in
  `packages/**`. Nothing to review.
- **Weak randomness** (`Math.random`): none. Reservation tokens use
  `crypto.randomUUID()`; digests use `crypto.subtle` SHA-256.
- **Control bytes in source** (AGENTS.md hazard): byte-level check of all
  package source files found **0** raw control bytes; regexes use
  `\u0000`-style escapes as required.
- **CI workflow injection**: no untrusted-context interpolation in `run:`
  steps; release metadata flows through environment variables; all actions
  pinned by full-length SHA.

## Findings

### [LOW] Vulnerable transitive dependencies via dev-only Azurite test emulator

- **Location:** `package.json:31` (`"azurite": "^3.36.0"` devDependency); audit
  chains: `azurite → applicationinsights → @opentelemetry/core <2.8.0`
  (GHSA-8988-4f7v-96qf, moderate), `azurite → rimraf → glob → minimatch →
brace-expansion <=5.0.7` (GHSA-mh99-v99m-4gvg, high DoS), `azurite →
sequelize/@azure/ms-rest-js → uuid <11.1.1` (GHSA-w5hq-g745-h8pq, moderate).
- **Evidence:** `npm audit` reports "12 vulnerabilities (7 moderate, 5 high)";
  every chain terminates at `node_modules/azurite`.
- **Exploitability:** none in shipped artifacts. Published packages ship only
  their `dist/` allowlist (enforced by `scripts/release-packages.mjs`
  `verifyPackedFiles`) and have no dependency on azurite. The vulnerable code
  runs only in local/CI test processes against the emulator, with no attacker
  input path (test glob patterns and UUID usage are static). A compromised
  registry version of these dev packages could affect CI runners, which is a
  general supply-chain exposure rather than a specific exploitable flaw.
- **Confidence:** Confirmed (audit output), dev-only reachability.
- **Fix:** Upgrade `azurite` when a release with fixed transitive deps exists
  (`npm audit fix --force` currently downgrades azurite to 3.33.0 and is
  breaking — do not apply blindly). Keep Dependabot monthly grouping as-is;
  re-run `npm audit` on each dependency bump. No runtime/host action needed.
- ⚠️ Disputed 2026-07-29 — not a valid finding: every chain is dev-only,
  individually unreachable, and has no available remediation. No published
  package depends on `azurite` (checked all four `packages/*/package.json`), so
  none of this reaches a shipped artifact. Per advisory: GHSA-w5hq-g745-h8pq
  affects `uuid` `v3`/`v5`/`v6` with a caller-supplied `buf`, but
  `@azure/ms-rest-js` and `sequelize` call `v4` only; GHSA-8988-4f7v-96qf needs
  W3C Baggage extraction and nothing in the tree instantiates
  `W3CBaggagePropagator`; GHSA-mh99-v99m-4gvg is reached only via
  `rimrafAsync(this.lokiDBPath)` against the harness-created temp workspace,
  never an attacker-supplied brace pattern. There is also no fix to apply.
  `azurite@3.36.0` is already the newest published release. Running
  `npm audit fix --force` moves _backwards_ to `3.33.0`. Pinning the patched
  `brace-expansion@5.0.8` through `overrides` breaks `minimatch@3.1.5` with
  `expand is not a function`, because 5.x exports `{ expand }` instead of a
  callable module. Tracking guidance in **Fix** above stays correct; no code
  change is warranted.

## Phase 3 — Summary

### Severity counts

| Critical | High | Medium | Low |
| -------- | ---- | ------ | --- |
| 0        | 0    | 0      | 1   |

### Per-layer status

- **Contracts (`packages/contracts`):** Clean. Types only; documented rule that
  raw MIME/HTML never enters stored contracts. Identity types correctly come
  from `@pegma/spine`.
- **Core workflow (`packages/core`):** Clean. Pure validation + state machine;
  canonical-timestamp and monotonic-revision guards; frozen outputs.
- **Application services (`packages/application`):** Clean. Every public method
  checks permission before work; customer reads re-verify ownership against the
  authoritative ticket and return `NotFound` (no existence/capacity oracle —
  ownership is checked before partition-limit errors); customer DTOs omit
  requester evidence, principal IDs, internal notes, and staff timestamps;
  internal notes never enter customer views (asserted post-mutation and
  enforced by visibility filtering); replay/duplicate detection is fingerprinted
  and re-authorizes on replay; all reads are bounded (partition record caps,
  queue scan budgets fail closed with no partial results); queue projection
  rows are hints confirmed against authoritative tickets, never authorization
  evidence; all identifiers are control-char/length validated before becoming
  storage keys; idempotency buckets are hash-derived and length-capped.
- **Templates (`packages/templates`):** Clean. Strict HTML subset with balanced-
  tag validation, no literal `&`, all variables HTML-escaped, URL variables
  restricted to absolute HTTPS with no embedded credentials, re-validation at
  render time even for host-hydrated catalogs.
- **Examples (`examples/composition`):** Clean. Clearly marked NON-PRODUCTION;
  synthetic principals/templates; no real network surface.
- **Release tooling (`scripts/release-packages.mjs`):** Clean. Signed annotated
  tag + allowed-signers verification, main-ancestry check, timing-safe
  integrity comparisons, tarball allowlist verification, registry integrity
  confirmation, spawnSync with argument arrays (no shell interpolation),
  GitHub-release-only publish gate, trusted-publisher OIDC (no tokens).
- **CI (`.github/workflows`):** Clean. SHA-pinned actions, `contents: read`
  default, `id-token: write` only in the publish job's protected environment,
  no untrusted input in `run:` steps.
- **Tests (`tests/`, `test/`):** Clean. Azurite emulator on loopback with the
  public well-known dev key; temp workspaces are cleaned up.

### Unverified / Needs Manual Review

1. **Delivery-callback authenticity at the host boundary.**
   `recordDeliveryCallback` (`packages/application/src/index.ts:4486`) applies
   caller-supplied status/`occurredAt` to mail jobs and records dedupe
   receipts. The library intentionally performs no provider authentication;
   `docs/ARCHITECTURE.md` (lines 246, 470, 481, 569, 609) and
   `docs/HOST_COMPOSITION.md:108` assign provider signature/webhook
   verification to the host. When the first host implements its callback
   endpoint, verify it authenticates the provider before calling this
   function — otherwise an unauthenticated caller could forge delivered/failed
   outcomes. Not a code finding here; no host code exists to check.
2. **Inbound email path does not exist in this repo yet.** MIME parsing,
   HTML sanitization, and sender-matching are host-adapter work
   (`docs/ARCHITECTURE.md:227`). The AGENTS.md rules (email match never
   authenticates, raw MIME never reaches stored contracts) are enforced by
   contract/documentation here, but the future adapter must be scanned when
   implemented.
3. **`@pegma/*` sibling packages** (`storage-core`, `authorization-core`,
   `spine`, `mail`, `audit`) are separate repositories and out of scope; each
   needs its own scan. This review verified only how support-desk _uses_
   their ports.
4. **`pruneCustomerTicketIndex` async decider**
   (`packages/application/src/index.ts:4839`): the `update` decider performs
   I/O (ticket reads, reservation-fence writes) and re-runs on conflict. The
   fence writes are idempotent same-value tombstones, so no integrity flaw was
   identified, but the re-run semantics deserve a manual correctness review —
   flagged as a logic (not security) concern.
5. **Azurite binding in tests** (`test/azurite.ts`): fixed loopback port
   10112; a co-located malicious local process could squat the port and serve
   a fake emulator to tests. Local-dev nuisance only; no action proposed.

### Appendix — commands run

- `npm audit` / `npm audit --json` (12 vulnerabilities, all via `azurite`)
- Regex sweeps over `packages/**`: XSS sinks, `eval`/`new Function`,
  `exec(`/`spawn(`, secrets patterns, `AccountKey=`, `sanitize|escape|crypto|Math.random`,
  `fetch(`/HTTP clients, control-byte binary check (0 hits)
- Manual line-by-line review: all 4 package source files (≈5,700 lines),
  `examples/composition/composition.ts`, `scripts/release-packages.mjs`,
  all three workflows, `test/azurite.ts`
- Cross-check of documented trust assignments in `docs/ARCHITECTURE.md` and
  `docs/HOST_COMPOSITION.md`
