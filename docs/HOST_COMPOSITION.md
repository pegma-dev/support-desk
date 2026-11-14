# Host composition guide

Support Desk is a library. Hosts authenticate callers, resolve
`AccessContext` values, supply a `@pegma/storage-core` `Store`, schedule
workers, and map application outcomes to HTTP. Support Desk never defines
routes, cookies, or provider SDKs.

See also the runnable example at
[examples/composition](../examples/composition/README.md).

<a id="unpublished-026-candidate-guarded-engineering-controls"></a>

## Published 0.2.6 guarded engineering controls

The current verified registry tuple is `0.2.11`, which retains these guarded
controls. Its [publication receipt](RELEASING.md#verified-0211-publication-2026-11-14)
qualifies the SDK artifacts; hosts retain their own acceptance gates. Published
`0.2.6` adds an optional third
`EngineeringMutationOptions` argument
to `enrollEngineeringSource`, `submitEngineeringEvidence`,
`selectEngineeringRepository`, `withdrawEngineeringSource`,
`invalidateEngineeringSource`, `putRepositoryPolicy` and
`disableEngineeringExports`. Hosts can supply a deadline-backed `AbortSignal`
and `verifyBeforeCommit` using the existing `EngineeringReviewCommitGuard`
representation. The [focused public-entry tests](../tests/engineering-mutation-guard.test.ts)
exercise these options with Memory and Azurite. Hosts adopt the exact
[published release](RELEASING.md#verified-026-publication-2026-11-11)
and qualify their own composition.

Published `0.2.7` separately supplies an optional per-attempt observation
to approval guards, with lazy authorized reads and a legacy standalone-read
fallback. It does not extend that observation to all seven controls. See the
[approval contract](ENGINEERING_EXPORT.md#candidate-027-approval-observation).
Its optional AI package pins exact verified public KB application/contracts
`0.1.6`. Published `0.2.9` instead pins exact verified public KB
application/contracts `0.1.8`; that graph passed strict registry and clean-consumer
qualification. Published `0.2.10` and current `0.2.11` retain those external pins. The `0.2.8` controls retained in `0.2.9`
add late host controls to the separate non-post follow-up methods and
optional callback-scoped reassessment/post read observations; see
the [published 0.2.8 follow-up contract](ENGINEERING_FOLLOWUP.md#candidate-028-followup-host-guards).
Qualify the complete published consumer graph for the host. See the
[current receipt](RELEASING.md#verified-0211-publication-2026-11-14).

Options use a plain object with the two named, enumerable own data fields.
Unknown keys, accessors and inherited options fail validation. The optional
synchronous proof succeeds with the literal `true` value. Hosts keep async
work in the callback that prepares that final synchronous assertion.

The scope is the seven controls listed above. `pruneRepositoryPolicyHistory`
is a separate maintenance API. Engineering follow-up ingestion, preparation,
review and delivery retain their own application and guard contracts. Hosts
resolve the current authority required by each separately invoked surface.

The SDK captures the signal and callback once at entry. Each new transaction
attempt runs the live host callback after its SDK proof and planning awaits.
The callback may return a synchronous `() => true` assertion for its authority
or deadline fence. That assertion and the original signal are checked at the
transaction call. Every OCC retry refreshes the callback. An exact accepted
receipt returns ahead of mutable proof, callback execution and cancellation,
under the method's current permission requirements. Hosts retain their current
browser, actor and permission checks when delivering that receipt.

Caller cancellation reaches the evidence product/test signals and bounds the
asynchronous host-guard wait. Hosts own bounded failure reporting inside their
authority callback, including work that finishes after the caller wait has
aborted. The SDK observes the callback's eventual rejection safely while the
caller retains its cancellation outcome. Existing policy observation ports keep their
SDK trust timeout and the final cancellation fence. A host callback uses its
own deadline-backed signal for bounded external authority reads. Cancellation
before transaction entry excludes a new commit. Once the Store accepts the
transaction handoff, hosts retain uncertain outcomes and recover them with the
exact original command. Support rows share their existing partition OCC
transaction. Host authority stores have their independent transaction boundary.

Hosts supply fresh original-account/session/role decisions and keep the
original command's action and target ceiling. The additional guard can perform
host storage reads. Each host measures those reads within its complete physical
request budget and qualifies its deployment separately.

## Public packages

This guide describes the verified published synchronized `0.2.11` release.
Use exact `0.2.11` for the five Support Desk packages, including optional AI; see
the [publication receipt](RELEASING.md#verified-0211-publication-2026-11-14).
The historical [`0.2.8` receipt](RELEASING.md#verified-028-publication-2026-11-12)
retains its original dependency graph and artifacts.
It retains the attachments and opt-in staged human learning reviews published
in `0.2.5`. Host composition and activation retain their own acceptance gates.
SD-01 through SD-05 first shipped in the
[historical `0.2.0` release](RELEASING.md#verified-sd-06-publication-2026-11-08).
The older base `0.1.1` packages remain immutable history. The
[P-00 baseline](KNOWLEDGE_AI_P00.md) preserves earlier source and registry
snapshots. Hosts must consume exact released packages and complete their own
acceptance; never overwrite an existing registry version. The KB-only host
path has its own producer receipts below.

Released manifests use these exact ecosystem pins:

- `@pegma/spine@0.1.2`
- `@pegma/storage-core@0.4.0`
- `@pegma/authorization-core@0.4.0`
- `@pegma/audit@0.2.0`
- `@pegma/mail@0.1.1`

For the seven direct host loops, pin the advertised durable coordinator:

- `@pegma/scheduler@0.1.0` (and `@pegma/scheduler-cloudflare@0.1.0` when the
  host uses Cloudflare Cron Triggers)

Do not depend on a Git branch, copied source, local path, or unpublished
tarball in a host production install.

### KB authoring producers

AUTH-01 and KB-04 source/SDK proof, partial KB-05 source preparation
([KB #4](https://github.com/pegma-dev/knowledge-base/pull/4)), and both producers'
final release preparation are merged. The evidence below is source validation with synthetic data only; no
actual customer data was used, and it does not establish an operational host.

| Merged change                                                                                                                                                                                                         | Source evidence                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AUTH-01 [Agent Access PR #1](https://github.com/pegma-dev/agent-access/pull/1), [`a444e21`](https://github.com/pegma-dev/agent-access/commit/a444e2113db98455b638b2ef8aa7c2faccb16b62)                                | 123 runtime tests and synthetic source/SDK proof.                                                                                                                                                                                                                                                                                                                                                                                                  |
| KB-04 [Knowledge Base PR #5](https://github.com/pegma-dev/knowledge-base/pull/5), [`b61fc77`](https://github.com/pegma-dev/knowledge-base/commit/b61fc77aedd22e888ac7292c3597f93e54fcda8e)                            | 372 runtime tests; official-SDK proof of the five-tool draft/evidence surface.                                                                                                                                                                                                                                                                                                                                                                     |
| KB-05 partial source preparation [Knowledge Base PR #4](https://github.com/pegma-dev/knowledge-base/pull/4), [`ed530cb`](https://github.com/pegma-dev/knowledge-base/commit/ed530cb318f222ace6f392748bb19c9d8c83d96e) | Shared memory/Azurite/real local D1 conformance and a public synthetic composition; historical 340 tests per Node 22/24 lane.                                                                                                                                                                                                                                                                                                                      |
| KB-05 release preparation [Knowledge Base PR #6](https://github.com/pegma-dev/knowledge-base/pull/6), [`7f5eee6`](https://github.com/pegma-dev/knowledge-base/commit/7f5eee68be692b5489de3965f3f5ede7ef7a812d)        | 372 runtime + 128 release tests (500 total) on each of Node 22 and 24, zero Linux CI skips; SDK composition proves all four KB packages plus Agent Access. The [final round-3 code review](https://github.com/pegma-dev/knowledge-base/pull/6#pullrequestreview-5814111477) was clean with zero open actionable findings; the [security receipt](https://github.com/pegma-dev/knowledge-base/pull/6#issuecomment-6710997171) reported no findings. |
| Agent Access release preparation [PR #2](https://github.com/pegma-dev/agent-access/pull/2), [`eddddd5`](https://github.com/pegma-dev/agent-access/commit/eddddd5e333ce16b6a4a8233b84656b3ac784947)                    | 123 runtime + 136 release tests (259 total) on each of Node 22 and 24, zero Linux CI skips; both code-review lanes clean, zero open actionable ledger findings, security review found no issues.                                                                                                                                                                                                                                                   |

Historical `0.1.1` publication receipts for the four KB packages (`@pegma/knowledge-base-contracts`,
`@pegma/knowledge-base-core`, `@pegma/knowledge-base-application`, and
`@pegma/knowledge-base-mcp`) and `@pegma/agent-access` are retained below.
The current standalone-authoring selection and later KB receipts follow the
historical releases below; the released AI consumer retains separate pins.

| Producer                          | Signed `v0.1.1` source                                                                                                                                                | Strict registry and clean-consumer verification                                                                                                                                                                                     |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent Access                      | [PR #4](https://github.com/pegma-dev/agent-access/pull/4), [`ffe4d86`](https://github.com/pegma-dev/agent-access/commit/ffe4d8616632ce9d057caaf65124746f03d4d349)     | [Run 42420302775, attempt 2, verify job 128549453970](https://github.com/pegma-dev/agent-access/actions/runs/42420302775/job/128549453970), 2026-11-07T22:32:42Z: verified registry release and clean consumer for one package.     |
| Knowledge Base, all four packages | [PR #8](https://github.com/pegma-dev/knowledge-base/pull/8), [`32086e4`](https://github.com/pegma-dev/knowledge-base/commit/32086e4374f2ef45044cd09c371e506d10b88d64) | [Run 42424148244, attempt 5, verify job 128564059833](https://github.com/pegma-dev/knowledge-base/actions/runs/42424148244/job/128564059833), 2026-11-07T23:35:31Z: verified registry release and clean consumer for four packages. |

These strict jobs verify exact artifact bytes and dependency tuples,
cryptographic signatures, source repository/workflow/tag/commit provenance,
and clean consumers. Canonical artifact identities and historical manual
`0.1.0` bootstrap receipts remain in the public
[KB release handoff](https://github.com/pegma-dev/knowledge-base/blob/main/docs/BOOTSTRAP.md)
and [Agent Access release handoff](https://github.com/pegma-dev/agent-access/blob/main/docs/BOOTSTRAP.md).
The completed manual bootstrap has no OIDC provenance; the separate trusted
`0.1.1` receipts supply historical verified producer evidence. Earlier npm
404 observations and the `a444e21` source fixture are historical only. The
recorded synthetic KB protocol proof used four packed KB packages with registry
`@pegma/agent-access@0.1.1`.

The KB-05 publication prerequisite for SD-02 is closed. The optional AI package
in the verified `0.2.11` tuple uses exact KB application/contracts `0.1.8`
dependencies. Its publication passed strict registry and clean public consumer
qualification. The base application has no KB
or provider dependency. SD-02 source passed validation/review and merged in
[PR #38](https://github.com/pegma-dev/support-desk/pull/38);
that behavior first shipped in verified synchronized `0.2.0` and remains in
current public `0.2.11`, whose publication receipt is linked above. Host acceptance remains required. Do not substitute branches, copied source,
local paths, or unpublished tarballs for production dependencies.

SD-03's atomic-provenance prerequisite is the verified trusted
[KB `0.1.2` release](https://github.com/pegma-dev/knowledge-base/releases/tag/v0.1.2),
source commit `004044bfa836b74a61fb5defa49d5ebab1fe37dd`. Both Node lanes passed
439 runtime and 128 release tests. Release run
[42436081951](https://github.com/pegma-dev/knowledge-base/actions/runs/42436081951)
verified all four exact registry artifacts, signatures/provenance, and a clean
consumer. The earlier SDK and `0.1.1` receipts above remain historical evidence.
The optional learning integration is documented in
[resolution learning](RESOLUTION_LEARNING.md); its current-head source and
host activation gates are separate from producer publication.

The later [KB `0.1.3` release](https://github.com/pegma-dev/knowledge-base/releases/tag/v0.1.3)
added shared test reports and staff confirmation. Its signed source is
[`8b4c25aa6a40f0c56be97f07e3b7b5ac6136a99b`](https://github.com/pegma-dev/knowledge-base/commit/8b4c25aa6a40f0c56be97f07e3b7b5ac6136a99b);
[strict verification job 128906942012](https://github.com/pegma-dev/knowledge-base/actions/runs/42533473529/job/128906942012)
passed on release run 42533473529, attempt 5. That release remains historical
evidence.

<a id="standalone-authoring-with-published-support-desk-028"></a>

#### Historical standalone authoring with Support Desk 0.2.8

The historical standalone authoring recipe alongside Support Desk `0.2.8` used these
exact packages. The optional AI package directly requires KB application/contracts;
MCP and Agent Access belong to the standalone authoring host.

- `@pegma/knowledge-base-contracts@0.1.6`
- `@pegma/knowledge-base-core@0.1.6`
- `@pegma/knowledge-base-application@0.1.6`
- `@pegma/knowledge-base-mcp@0.1.6`
- `@pegma/agent-access@0.1.1`

All four Knowledge Base `0.1.6` packages passed strict registry verification
against signed source `b2946e149078e0ef460f970c2271c196ea9fc759`. Each host
qualifies its installed dependency graph, permissions and actual client flows.
[Knowledge Base release](https://github.com/pegma-dev/knowledge-base/releases/tag/v0.1.6) · [Registry verification receipt](https://github.com/pegma-dev/knowledge-base/releases/download/v0.1.6/registry-verification.json)

#### Standalone authoring with published Support Desk 0.2.9

Published Support Desk `0.2.9` selects exact verified
public KB application/contracts `0.1.8`; standalone authoring aligns contracts,
core, application and MCP at `0.1.8`, with Agent Access unchanged at `0.1.1`.
All four KB packages passed strict public verification from signed source
`04d07b66cac18b7f6e0ca1530714878f3d66084d`:
[KB `0.1.8` release](https://github.com/pegma-dev/knowledge-base/releases/tag/v0.1.8) · [Registry verification](https://github.com/pegma-dev/knowledge-base/releases/download/v0.1.8/registry-verification.json).
[Retained asset identities and verification chronology](RELEASING.md#source-version-029)
record the original preparation, public asset IDs and SHA-256 digests.
This changes no published Support Desk `0.2.8` dependency or host activation.

The earlier authoring recipe selected the four Knowledge Base `0.1.4` packages
with Agent Access `0.1.1`.

The [KB `0.1.4` release](https://github.com/pegma-dev/knowledge-base/releases/tag/v0.1.4)
binds signed source
[`541e8c93fe1b15bee9345e59b36325f422f97c50`](https://github.com/pegma-dev/knowledge-base/commit/541e8c93fe1b15bee9345e59b36325f422f97c50).
[Strict verification job 129201837645](https://github.com/pegma-dev/knowledge-base/actions/runs/42576167664/job/129201837645)
passed on release run 42576167664, attempt 5, for all four registry packages:
exact archive/dependency checks, signatures/Sigstore, signed-source and original
writer provenance, and public consumers. The release retains the original
prepared artifact and documents recovery without another package write.
Agent Access `0.1.1` retains its source and strict verification receipt above.

The earlier standalone recipe and `@pegma/support-desk-ai@0.2.1` retained their
own dependency pins. The AI package's immutable
[published manifest](https://github.com/pegma-dev/support-desk/blob/v0.2.1/packages/ai/package.json)
pins `@pegma/knowledge-base-application@0.1.2` and
`@pegma/knowledge-base-contracts@0.1.2`. Adding a newer standalone SDK does not
replace those dependencies or establish mixed-version host acceptance. The
current verified AI `0.2.11` manifest explicitly pins KB application/contracts
`0.1.8`; hosts must adopt and qualify that coherent graph separately.

#### Qualified storage adapters

| Exact package                        | Signed release source                                                                                                                                                                                              | Strict registry/consumer verification                                                                                                |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `@pegma/storage-cloudflare-d1@0.4.6` | [`v0.4.6`](https://github.com/pegma-dev/storage-core/releases/tag/v0.4.6), [`35daa5e679d353fffc9fbf5afe73fe73198d8abf`](https://github.com/pegma-dev/storage-core/commit/35daa5e679d353fffc9fbf5afe73fe73198d8abf) | [Job 129478539115](https://github.com/pegma-dev/storage-core/actions/runs/42705318277/job/129478539115), run 42705318277, attempt 3. |
| `@pegma/storage-dynamodb@0.4.5`      | [`v0.4.5`](https://github.com/pegma-dev/storage-core/releases/tag/v0.4.5), [`a5a5d0bfe6355df89c049fcec3148845c5124735`](https://github.com/pegma-dev/storage-core/commit/a5a5d0bfe6355df89c049fcec3148845c5124735) | [Job 129386921895](https://github.com/pegma-dev/storage-core/actions/runs/42679292292/job/129386921895), run 42679292292, attempt 2. |

`@pegma/storage-core@0.4.0` and `@pegma/storage-azure-tables@0.4.0` retain their
original verified archives. The `v0.4.6`
[prepared manifest](https://github.com/pegma-dev/storage-core/releases/download/v0.4.6/package-manifest.json)
and [strict verification job 129478539115](https://github.com/pegma-dev/storage-core/actions/runs/42705318277/job/129478539115)
bind those reused archives together with
D1 `0.4.6` and the reused DynamoDB `0.4.5` archive; reused packages were not
rebuilt or republished. These producer receipts do not establish a live host's
durable deployment, platform quota, or operational acceptance.

The authoring recipe does not assert which versions either reference host has
deployed. PG-01/RG-01 separately prove
existing-login/current-Admin consent and actual draft/evidence flows through
Codex, Claude Code, Grok Bot's installed desktop application with its hosted
agent (not Grok Build CLI), and T3 Code in Codex-provider mode. Publication,
source tests, and SDK tests cannot close retained two-host acceptance,
staging privacy/provider/intermediary controls, operations, full workflows,
Task 12, or pilots. Follow the
[current implementation ledger](KNOWLEDGE_AI_PLAN.md#status-and-reading-order).

## Constructing the application

```ts
import { createSupportDeskApplication } from "@pegma/support-desk-application";

const application = createSupportDeskApplication({
  store, // host-created Store
  clock, // trusted host Clock
  allowedCategories: [
    "feedback",
    "bug",
    "feature_request",
    "documentation",
    "question",
  ],
  allowedTags: ["needs_review", "follow_up"],
  maxTagsPerTicket: 8,
  responseTargetPolicy, // optional host port; also configure inbound processing
  queueTerminalRetentionMilliseconds: 30 * 86_400_000,
});
```

Mint command, correlation, ticket, and message IDs on the server. Controllers
never invent ticket numbers — create reserves them from
`support-desk.ticket-numbers.v1`.
The host server supplies each command's `correlationId`; the application
validates and propagates it and never generates one.

## Error categories for HTTP mapping

Map thrown outcomes to stable host responses. Never send raw exception
messages, storage keys, email addresses, permission sets, or provider
diagnostics to a browser.

| Application outcome                                                                                                   | Host HTTP behavior                                  |
| --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Malformed command or identifier (`TypeError` from boundary validation)                                                | `400` with a stable host error code                 |
| `SupportDeskAuthorizationError` (missing permission)                                                                  | `403`                                               |
| `SupportDeskNotFoundError` (missing or non-owned ticket)                                                              | the same content-free `404` response for both cases |
| `SupportDeskConflictError` (command ID reused with different input, exhausted conflict retry, callback key collision) | `409`                                               |
| `SupportDeskLimitError` with field `subject`, `body`, `handoff_summary`, or `serialized_record`                       | `413`                                               |
| `SupportDeskLimitError` with field `customer_tickets`, `ticket_messages`, or `ticket_partition`                       | `409`                                               |
| Host durable request limit refused (`@pegma/rate-limit`)                                                              | `429` with bounded `Retry-After`                    |
| `SupportDeskQueueCapacityError` (staff queue scan/materialization budget exhausted)                                   | `503`; never return a partial queue                 |
| Required Store or provider dependency unavailable                                                                     | `503`                                               |
| Unexpected failure                                                                                                    | content-free `500` plus a safe correlation ID       |

`SupportDeskStaleRevisionError` maps to `409` with a stable host code and only
its safe `currentRevision` and `updatedAt` hint fields. It extends
`SupportDeskConflictError`; handle it before that broader class.

`TicketWorkflowError` from lifecycle transitions is a refused state change; hosts
typically map it to `409` after the caller was already authorized.

Keep revision/generation collision hints on trusted staff/assistant paths.
Customer deterministic controls use a content-free conflict response, never
an internal ticket revision, handling generation, or staff update hint.

`handoff_summary` has maximum 2,000 UTF-16 code units. `serialized_record` has
maximum 60,000 UTF-16 bytes of the complete JSON record, including its wrapper,
for assistant messages and handoff work. Both are named size failures before
commit, distinct from message/partition capacity limits.

## Optional lifecycle extras (Task 13)

`allowedTags` is copied at construction, normalized by trimming surrounding
spaces and lowercasing, deduplicated, and sorted. It accepts at most 32 physical
entries before deduplication. Each input is at most 64 characters, has no
controls, and normalizes to `^[a-z][a-z0-9_]{0,31}$`, the category identifier
discipline. `maxTagsPerTicket` defaults to 8 with a hard maximum of 32.
`setTags(access, { commandId, correlationId, ticketId, tags, expectedRevision? })`
replaces all tags; `[]` clears them even when no allowlist is configured.
Adding tags requires an allowlist. Both `support.queue.read` and
`support.ticket.manage` are required. A normalized set is part of the command
fingerprint. The ticket, `support.ticket.tags_changed` Audit action, and receipt
commit together. Tags advance revision and staff `updatedAt` only; they never
change status, `customerUpdatedAt`, messages, or mail.

Configure the same optional `ResponseTargetPolicy` on the application and
inbound processor. The host supplies `computeTargets(context)` returning
`{ firstResponseDueAt?, resolutionDueAt? }` synchronously or asynchronously.
Values must be canonical ISO timestamps, for example `2026-11-01T12:00:00.000Z`.
The content-free, frozen context contains ticket ID, resulting revision,
priority, optional category, channel, created/occurrence times, existing targets,
and milestones. It contains no subject, body, requester identity, or tags.

The hook runs before commit on web or email creation, accepted customer
replies through either transport, and staff priority changes. Its reason is
`created`, `customer_replied`, or `priority_changed`. Its result completely
replaces the two due fields; omitted fields remove previous targets. Without
a hook, existing targets are preserved. Invalid output or a rejected hook
leaves the ticket command uncommitted; retry the same command/event after
fixing the dependency. Creation may leave a reserved ticket-number gap or
customer-index reservation, and inbound receipts remain processing. Hooks
may run again after a conflict or interrupted attempt, so keep them repeatable
and free of external side effects. Committed command/provider-event replay
does not run them. Calendars, business hours, holidays, and presence belong
entirely to the host; Support Desk stores dates and compares instants only.

`firstStaffRespondedAt` is set once by the first customer-visible staff reply
and survives resolution, closure, and reopening. Notes, assignment messages,
assistant replies, and lifecycle system messages do not set it. `resolvedAt` records entry into
resolved; resolving an already resolved ticket preserves it. Closure preserves
it. Explicit reopening or a customer/staff reply clears it; re-resolution sets
it to the new resolution time. Reopening preserves due timestamps until a
configured trigger replaces them; the host policy owns any reset decision.
Legacy tickets may omit tags, targets, and first-response milestones; there is
no inferred historical first response or automatic target backfill.

Queue fields are staff-only and come from authoritative confirmation. Query
`tag` matches one normalized tag. `target` selects `first_response` or
`resolution` (default); `targetState: "overdue"` means an unmet target strictly
before the host clock, while `"due_soon"` means from now through the inclusive
`dueSoonMilliseconds` horizon (required, 0 to 30 days, and rejected with any
other `targetState`). First-response targets
are unmet until `firstStaffRespondedAt`; resolution targets are unmet until
`resolvedAt`. Terminal tickets remain excluded from the active queue. Sorts
`due_soonest` and `due_latest` use the selected unmet target with missing or
completed targets last in both directions and ticket ID as tie-breaker.
Existing update sorts and physical-row/page/result budgets remain in force.
Run a complete queue repair cycle after upgrading; exact legacy rows can gain
the additive fields at the same revision after authoritative re-derivation.

All staff mutations (reply, note, assign/unassign, priority, tags, resolve,
close, reopen) accept an optional positive safe-integer `expectedRevision`.
Omitting it retains automatic conflict retries. Supplying it requires a match
after authorization and command-replay detection, on every attempt. A mismatch
fails before ticket writes or target-hook calls with the content-safe stale
error above. Reuse of a command ID with changed input, including a changed
revision hint, remains a command conflict. New staff receipts retain the result
ticket; immutable message ordinals reconstruct the original conversation up
to that revision. Exact committed retries return that result even after later
edits. Legacy receipts without a result ticket retain their earlier current-view
replay behavior. Controllers should reload staff detail after a stale response
or when they want the latest state following a replay.

Tags, due timestamps, and milestones never enter customer DTOs or automatic
customer mail projections. Hosts must keep these fields out of customer
notification variables and template bodies as well.

<a id="staff-canned-responses-task-15-source-candidate"></a>

## Staff canned responses (Task 15, published 0.2.9)

This API is included in verified public `0.2.9`. Host adoption still requires
the host's own acceptance; no additional package or collection is introduced.
The host supplies `cannedResponses` when constructing the application:

```ts
const application = createSupportDeskApplication({
  store,
  clock,
  cannedResponses: [
    {
      id: "review",
      version: 1,
      title: "Review acknowledgement",
      target: "reply", // or "note"; target is immutable within a version
      variables: ["topic"],
      body: "We will review {{topic}}.",
    },
  ],
});
```

`listCannedResponses(access)` requires `support.queue.read` and returns a new frozen
array of frozen definitions filtered by current `support.ticket.reply.any` / `support.ticket.note`
permissions. An empty catalog is the default. Catalog access is staff-only;
never expose it through a customer or assistant endpoint. The host controls
catalog changes through its deployment review. This API provides no settings
editor, persistence, or automatic send.

Use `renderCannedResponse` from the application or core public entry for preview:

```ts
const [definition] = await application.listCannedResponses(staffAccess);
if (!definition || definition.target !== "reply")
  throw new Error("No response");
const values = { topic: "your question" };
const body = renderCannedResponse(definition, values);
// Show body as plain text. Only after the staff member explicitly chooses Send:
await application.replyAsStaff(staffAccess, {
  commandId,
  correlationId,
  ticketId,
  messageId,
  expectedRevision,
  body,
  cannedResponse: { id: definition.id, version: definition.version, values },
  // optional host-owned notification routing remains the normal reply contract
});
```

Import `renderCannedResponse` alongside `createSupportDeskApplication`.
For notes use `addNote`, with a `target: "note"` definition. Each macro expands
exactly one message and has no lifecycle, assignment, permission, or account
actions. Browser code cannot turn a note template into a reply. The final body
must exactly match the selected version's expansion. An edited preview can be
sent as an ordinary staff message by omitting `cannedResponse`; it then carries
no template provenance. Authenticate and resolve current staff permissions at
both preview and send, keep CSRF and durable request limits at the host boundary,
and use `expectedRevision` to detect a ticket changed since preview.

The catalog accepts at most 64 physical versions, with no duplicate `(id, version)`.
IDs and variable names match `^[a-z][a-z0-9_]{0,31}$`; versions are positive safe
integers. Titles are at most 120 characters, templates and expanded messages at
most 16,000 UTF-16 code units, with at most 16 unique variables and 2,000 code
units per supplied value. Application `limits.maxMessageCharacters` may impose
a stricter upper limit, counted in Unicode code points rather than UTF-16 code
units. Values must match the declared variables exactly. Empty/whitespace-only
text, controls (except tab, CR and LF in message text), unknown fields,
accessors, inherited fields, sparse arrays and hidden properties are refused.
Tokens are only `{{name}}`; substitution is literal, single-pass, and never reads
ticket fields or evaluates code. Definitions and command values are copied
before awaits. Render as plain text, HTML-escape at HTML boundaries, and never
interpret substituted content as Markdown or executable markup.

An unavailable version, invalid expansion or wrong target is a `TypeError` before
new ticket writes. Existing revision/capacity errors and HTTP mapping apply.
Server diagnostics distinguish an unavailable version, a target mismatch and
an expanded-body mismatch, without including template content or values. Keep
the browser-facing validation response stable and content-free; do not expose
raw exception messages or parse them as an API contract.
The command fingerprint binds the body, exact version, canonical value map,
revision hint, attachments and notification. Exact accepted replay is checked
before catalog lookup, so withdrawing a definition refuses new uses without
breaking uncertain-outcome recovery. Replay still requires current queue and
target permissions. Retain the exact original command after a timeout; changing
or removing the selection under the same command ID conflicts. Keep each
published catalog version immutable and increment its template version when
changing text, variables, title or target (this is separate from package versions).

Existing `support.ticket.staff_replied` / `support.ticket.note_added` Audit events
add only `cannedResponseId` and `cannedResponseVersion` alongside the existing
`commandId` and `correlationId` details. No other canned-response fields are
included. The events commit with
the message, revision, receipt and optional reply outbox in one ticket partition.
Bodies and variable values stay out of Audit. Provenance is not added to message
DTOs or notification variables. Notes remain absent from customer reads, customer
update times and mail. Notification templates still use their separate renderer
and host-supplied safe variables. See the runnable `runCannedResponseExampleFlow`
in `examples/composition` and public-entry memory/Azurite tests.

Durable administrator authoring/activation, personal catalogs and multi-action
macros remain open questions for separate reviewed tasks. No new collection or
record migration is needed for this deployment-configured slice.

## Optional handling and deterministic controls (SD-01)

`assistantHandlingEnabled` defaults to false. Only new trusted web creation with
`initialHandling: "assistant"`, normal create permission, and
`support.ticket.assistant.start` opts a ticket into assistant handling. Do not
pass browser-selected authority through this field. Omission preserves human
handling and existing create fingerprints. This option enables source
handling commands, not a model, KB connection, or live deployment.

| Method                             | Required permission and result boundary                                                                                                   |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `readAssistantConversation`        | `support.ticket.assistant.read`; service-only safe conversation plus current revision/handling and optional customer trigger              |
| `replyAsAssistant`                 | `support.ticket.assistant.reply`; new work requires enabled handling; attributed plain-text message and bounded acknowledgement           |
| `escalateToHuman`                  | `support.ticket.assistant.escalate`; fenced transition and bounded handoff work                                                           |
| `requestPerson`                    | `support.ticket.request_person.own` plus authoritative ownership; current customer-safe view                                              |
| `takeOverTicket`                   | `support.queue.read` plus `support.ticket.take_over`; staff view with exact revision/handling fences                                      |
| `confirmCustomerSuccess`           | `support.ticket.confirm_success.own` plus ownership/current visible-message proof; always resolves and returns current customer-safe view |
| `readCustomerSuccessConfirmations` | `support.queue.read` plus `support.audit.read`; private structured proof without conversation text                                        |

`readHandoffWork(access, ticketId)` additionally requires `support.queue.read`
and returns bounded staff-only `HandoffWorkDto` values: work identity/status,
reason, optional summary, attempted guide IDs, transcript reference,
handling generation, and creation time. These are separate from historical
`StaffTicketView` replay and from assistant/customer DTOs. Staff handoff review
does not require controllers to bypass the application through raw Store reads.

Assistant reply/escalation require `expectedRevision`,
`expectedHandlingGeneration`, and `triggerMessageId`. The latest visible
message must still be that customer message on an active web assistant ticket.
New input, internal revision changes, escalation, or takeover defeats stale
work. `readAssistantConversation` returns no requester identity or internal
notes; its revision/handling fences are service metadata and must not become a
customer DTO. Assistant messages never set `firstStaffRespondedAt`.

Takeover requires its current revision and handling generation; terminal work
must reopen first. Staff reopening explicit handling routes it to human-pending.
Missing legacy handling remains implicit human-pending/generation zero. An
owned `requestPerson` needs no customer revision: it reopens terminal work for
humans and is a no-op on already-human active work. Disabling assistant start/
reply does not disable request-person, escalation, or takeover. Deterministic
means independent of a provider, with authentication, concurrency, and finite
capacity checks still enforced.

`confirmCustomerSuccess` accepts only command/correlation/ticket IDs and
`lastSeenVisibleMessageId`; there is no optional resolve flag or free-form
evidence body. Use the latest visible message ID from the customer view.
Internal notes do not change that proof. The application derives private
revision/handling facts and records evidence with resolution, Audit, and the
receipt. A closed ticket must reopen before confirmation. Repeating accepted
proof on a resolved ticket with the same last-visible message adds no rows.
Neither proof records nor internal revisions/generations enter customer
responses. The assistant cannot invoke customer resolution as its own action.

Every mutation uses stable `commandId`/semantic input and a host-server-supplied
`correlationId`; the application does not generate it. New handling receipts retain bounded result tickets for
replay. Assistant reply/escalation return `HandlingCommandResult` with IDs and
revision/handling fences; takeover returns its historical staff result;
customer controls reload the current authorized safe view. A no-op creates no
receipt/Audit/work rows. Reuse the same ID and exact input after an unknown
commit outcome; a changed fingerprint conflicts.

The flag refuses new assistant creation/reply, not an exact already committed
receipt replay. Replay still requires current create plus assistant-start
permissions and ownership for customer creation, or current assistant-reply
permission for a reply. It adds no rows, reservations, or model work. A
retained receipt does not restore revoked authority.

Handoff work contains a compact transcript reference and optional summary of
at most 2,000 UTF-16 code units plus at most 16 opaque guide IDs of 200 units each.
The caller must minimize that staff payload; schema limits do not redact
private content. Never copy internal notes or a raw transcript into summary
text. No automatic mail job or guide fetch is created. Source row/byte limits
and the 12-row ordinary / four-row control-tail human reserve are documented
in [collections](COLLECTIONS.md#sd-01-handling-and-handoff-layout-checkpoint).
Limits remain visible named failures, including finite extra control cycles.

`listStaffQueue` defaults to `handling: "human"`; `"assistant"` and `"all"`
are explicit supervision views under queue permission. Selection confirms
current authoritative handling, including legacy omission, and returns a safe
handling state on staff queue items. Schedule the existing projection repair;
no separate human queue store is introduced.
A valid positive older active projection hint can discover the freshly loaded
human ticket immediately. Future/nonpositive/malformed/inactive hints are
refused; missing or inactive hints can still leave a temporary repair gap.

SD-01 includes no AI provider, knowledge retrieval, learning, or publication.
Keep model activation disabled until the host gates pass. This composition
uses the verified KB `0.1.8` set and Agent Access `0.1.1` listed above.
SD-02's producer publication prerequisite is complete. Its optional coordinator source is
merged after validation/review, as are SD-03 through SD-05. They first shipped
in verified synchronized `0.2.0` and remain in current public `0.2.11`, whose publication
receipt is linked above. The current AI consumer pins exact KB application/
contracts `0.1.8`; the earlier `0.2.1`/KB `0.1.2` manifests remain immutable. Actual two-host
login/client, privacy, operations, Task 12,
full-workflow, and pilot evidence remain separate gates.

## Optional assistant coordination (SD-02)

`createSupportDeskAssistant` from `@pegma/support-desk-ai`
composes the five public `AssistantTurnApplication` operations with the actual
KB `retrieveAnswerSources`/`confirmAnswerSources` surface and host-owned model,
configuration, customer-authority, usage, tokenizer, and escalation ports.
The base application needs only opt-in bounded `assistantTurns` configuration;
without that option it creates no turn jobs and still works without AI.
See [the coordination guide](ASSISTANT_COORDINATION.md) and
[the layout checkpoint](COLLECTIONS.md#sd-02-assistant-turn-layout-checkpoint)
for actual types, bounds, replay, and required validation.

The runnable [optional AI composition](../examples/ai/README.md) exercises
the public SDKs with synthetic provider ports. Its memory/Azurite checks and
clean-consumer checks are source validation; they do not prove a host's login,
provider, deployment, or pilot readiness. Follow [upgrading](UPGRADING.md)
and [AI operations](AI_OPERATIONS.md) for forward migration, independent
worker cursors, disabling new work, and privacy withdrawal.

Hosts persist scan continuations, repeat bounded physical scan cycles, claim
with a deadline-compatible lease, and keep per-instance durable usage
reservation/reconciliation outside the Support Desk store contract. The
coordinator's `processTurn` takes `ProcessAssistantTurnCommand`: ticket/turn,
worker identity, and lease duration, without a caller-supplied `claimId`.
Each physical invocation generates a fresh cryptographic claim ID. A duplicate
callback returns `not_claimed` while another claim is live and does not cancel
or reconcile its reservation. After expiry, a new generation/attempt retains
the prior bounded unknown metadata for conservative reconciliation. The model
runs once per newly prepared attempt outside CAS retries. A storage response
loss replays the exact prepared/completion command; provider acceptance or
usage can still be unknown and conservatively reserved. No exactly-once
provider-call or billing guarantee is made.

Resolve service and customer authority independently. Recheck the actual
customer's current active principal, collection/audience/applicability policy,
and the complete supplied KB source set, including uncited sources, immediately
before the paid provider call and before every completion CAS. After awaited
retrieval, preparation, and usage reservation, the identical prepare command
rechecks the live claim/deadline, then the full input guard runs with current
configuration as the last awaited observation before generation. Invalidation
at this point makes zero provider calls and reconciles `not_called` usage
before bounded human fallback or superseding stale work. Trusted configuration must verify the actual provider account,
route, endpoint/model features, exceptions and intermediaries for the bound
ZDR-compatible policy before call and commit. Source fake providers are not
operational privacy evidence. Count the full prompt locally, enforce raw JSON
UTF-8 limits before parsing, accept only exact supplied citations and safe
labels, and never infer a portal URL from a bot-answer source.
The pre-generation customer/source/configuration resolver phase is bounded by
the attempt deadline minus the commit reserve; each final-CAS guard uses the
full attempt deadline.

Pass the coordinator's trusted `maxMessageCharacters` option to match the
application's configured message cap (default 20,000 UTF-16 code units, allowed
1–20,000). Before preparing or reserving paid work, it reserves the complete
possible citation footer for all supplied approved labels and derives
`maxAnswerTextCharacters`. Both limits are exposed in server-side attempt
budgets and fingerprinted; the answer allowance also enters trusted model
instructions. Insufficient remaining space fails to human support before a
provider call. Final validation bounds the complete rendered answer and never
truncates content to fit. Raw response UTF-8 byte limits remain separate.

Keep generation's kill switch independent of deterministic request-person and
staff takeover. Those controls preserve authenticated human handoff even when
configuration, usage reservation, retrieval, or the provider is unavailable.
Only actual signed-in web messages enqueue turns: an email reply to a ticket
whose original `Ticket.channel` is `web` still hands off with `email_reply`.
The worker can answer or escalate; it cannot resolve tickets, act on accounts,
execute broad tools, or publish knowledge/issues. The two hosts retain separate
stores, policies, queues, cursors, usage scopes, and secrets.

## Inbound mail

Support Desk owns provider-neutral processing after the host has verified a
provider event. The host mail worker owns everything before that:

1. **Verify authenticity.** Check the provider webhook signature or the
   delivery mechanism's credentials with the provider SDK or HTTP client in
   the host. Unverified requests never reach Support Desk.
2. **Evaluate the sender.** Produce `InboundSenderAuthentication` only from
   trusted post-verification provider evidence and bind its normalized `email`
   to the same address passed as `from`. A DMARC `pass` requires aligned DKIM
   or aligned SPF; `host_identity` requires an equivalent host-authenticated
   identity. Never trust raw, unparsed `Authentication-Results`, a provider
   webhook signature by itself, or SPF without alignment. Use `fail` or omit
   the result when the host cannot establish these semantics.
3. **Bound and normalize MIME.** Enforce message, part, header, and
   attachment size limits; decode the subject; reduce the body to safe plain
   text (or constrained Markdown) with quoted history trimmed below the
   configured body limit. Raw MIME and HTML are never passed in. Attachments
   continue to be dropped; Task 14 covers web/staff uploads only.
4. **Extract metadata.** Pass the sender address, optional display name, the
   message's own `Message-ID`, `In-Reply-To`, `References`, any candidate
   reply-routing token from the recipient address or provider metadata, and
   the loop signals (`Auto-Submitted`, `Precedence`,
   `X-Auto-Response-Suppress`, `X-Autoreply`-style headers, `List-Id`,
   top-level `Content-Type`, and the SMTP envelope sender).
5. **Mint identifiers.** Supply server-minted `ticketId`, `messageId`, and
   `correlationId` for every attempt. A retry may mint new ones; Support Desk
   reuses the first delivery's reserved identifiers.
6. **Apply durable limits.** Throttle by sender, domain, and channel with
   `@pegma/rate-limit` before calling Support Desk.

```ts
import { createInboundMailProcessor } from "@pegma/support-desk-application";

const inbound = createInboundMailProcessor({
  store,
  clock,
  accountMatcher, // { matchSenderEmail({ channelId, email }) } -> none | one | many
  routingPolicy, // { routeNewConversation({ association, ... }) } -> priority/category
  notificationPolicy, // optional staff alert committed with the message
  subjectMarkerPrefix: "SD", // enables [SD-1042] fallback
  supportAddresses: ["support@example.com"], // mail from these is a loop
  queueTerminalRetentionMilliseconds: 30 * 86_400_000,
  threadIndexRetentionMilliseconds: 365 * 86_400_000,
});

const result = await inbound.processInboundEmail(normalizedProviderEvent);
```

For tickets with `requester.email`, routing tokens, threading headers, and
subject markers join only when the case-insensitive normalized `from` address
equals that email and `senderAuthentication` passes for the same normalized
address. Missing, failed, unaligned, or differently bound results create a new
unverified ticket with a staff-only relationship hint; they never change or
reopen the named ticket. For tickets without a requester email, only the
high-entropy routing token remains a bearer write path. Threading headers and
subject markers alone do not join those tickets.

The account matcher answers whether a sender address matches zero, one, or
several accounts. Only a unique match yields a `matched_email` ticket, and
that ticket is still invisible to the account's web session: an email match
never authenticates, never selects an `AccessContext`, and never enters the
verified-session path. The routing policy receives only the association, an
optional matched principal, and an optional related ticket (never the subject
or body) and may return `low`, `normal`, or `high` plus an allowlisted
category. Inbound mail is never automatically `urgent`.

To make replies thread by key lookup, give outbound notifications a
cryptographically random `replyRoutingToken` (22 to 128 URL-safe characters)
and render it into the reply address, for example `support+<token>@example.com`.
Support Desk indexes its SHA-256 key and the notification `Message-ID` when
the command commits. Hosts must not acknowledge the sender when
`senderAcknowledgementAllowed` is false, and should not auto-acknowledge
unverified senders at all, to avoid backscatter.

Map inbound outcomes for the provider, not for a browser:

| Outcome                                                                               | Provider response                                                                                     |
| ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `created`, `replied`, `duplicate_message`, `suppressed`, `rejected`                   | success (acknowledge; retries return the same result)                                                 |
| `TypeError` or `SupportDeskLimitError` from input validation                          | acknowledge and dead-letter for review; do not retry the same payload                                 |
| `SupportDeskConflictError` (event-ID/content reuse or receipt/command slot collision) | acknowledge and alert; never reprocess as new mail                                                    |
| `SupportDeskConflictError` (concurrent ticket updates exhausted retries)              | non-success so the provider retries the same event; the receipt stays `processing` and resumes safely |
| Store unavailable or unexpected failure                                               | non-success so the provider retries                                                                   |

Inspect the conflict message: contention reports `Concurrent ticket updates
exhausted retries` and explicitly permits retrying the same event. Content
reuse and slot collisions retain their distinct diagnostics. Do not treat every
`SupportDeskConflictError` as poisoned content; other unexpected conflicts
also need a non-success response so the provider retries.

## Host-owned schedulers

The host owns wakeups (Cron Trigger, Timer, queue, or operator action). Wire
the seven direct loops through `@pegma/scheduler` at the composition root:
register static task ids once, map each domain page’s `nextCursor` to
`nextCheckpoint`, and let the scheduler own leases and durable checkpoints.
Never share a checkpoint across loops or Support Desk instances. Crash before
fenced completion may repeat a page; claims and conditional writes make that
safe. The example composition under `examples/composition` uses
`createScheduler` + `runManual` for these seven tasks.

Receipt and principal sweeps stay **outside** the static scheduler registry:
the host selects buckets/principals per invocation and must not invent dynamic
task ids per bucket.

| Loop                            | Entry point                                                                                     | Coordination                           | Notes                                                                                |
| ------------------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------ |
| Mail send                       | `supportMail.worker(...).runSendPage`                                                           | scheduler task `mail.send`             | Claims pending jobs and calls the host provider                                      |
| Mail reconciliation             | `supportMail.worker(...).runReconciliationPage`                                                 | scheduler task `mail.reconcile`        | Resolves ambiguous acceptance                                                        |
| Mail terminal sweep             | `supportMail.sweep(records, { terminalBefore, cursor, limit })`                                 | scheduler task `mail.terminal-sweep`   | Deletes acknowledged terminal jobs older than the cutoff                             |
| Customer-index prune            | `pruneCustomerTicketIndex(store, principalId, { reservedBefore })`                              | host-selected; not a scheduler task id | Drops stale reservations; confirmed ownership is rechecked                           |
| Inbound receipt sweep           | `sweepInboundReceipts(store, clock, { bucket, processedBefore })`                               | host-selected per bucket               | Terminal receipts only; never deletes `processing` or `rerouting` receipts           |
| Delivery-callback receipt sweep | `sweepDeliveryCallbackReceipts(store, clock, { bucket, processedBefore })`                      | host-selected per bucket               | Retains the 30-day dedupe horizon                                                    |
| Queue reconciliation / repair   | `repairQueueProjectionPage({ store, clock, terminalRetentionMilliseconds, cursor, limit })`     | scheduler task `queue.repair`          | Scans authoritative tickets and rewrites projection rows                             |
| Queue inactive-row sweep        | `sweepInactiveQueueProjections({ store, clock, terminalRetentionMilliseconds, cursor, limit })` | scheduler task `queue.inactive-sweep`  | Conditionally deletes inactive projection rows only after reloading the ticket       |
| Thread-index repair             | `repairThreadIndexPage({ store, clock, threadIndexRetentionMilliseconds, cursor, limit })`      | scheduler task `thread-index.repair`   | Re-derives `Message-ID`, reply-token, and ticket-number rows from authoritative rows |
| Thread-index sweep              | `sweepThreadIndexPage({ store, clock, threadIndexRetentionMilliseconds, cursor, limit })`       | scheduler task `thread-index.sweep`    | Conditionally deletes rows whose target is gone or past retention                    |

Projection, repair, and inactive sweep must share the same
`terminalRetentionMilliseconds` value configured on the application (and on
the inbound processor's `queueTerminalRetentionMilliseconds`). Thread-index
repair and sweep must share the inbound processor's
`threadIndexRetentionMilliseconds`. Run at least one complete thread-index
repair cycle after upgrading so tickets created earlier gain index rows.

Online staff queue reads (`listStaffQueue`) start at a null cursor and use only
request-local cursors. They never resume another request's scan and never
authorize access from the projection alone.

## What hosts still own

- authentication and CSRF for browser forms;
- Authorization Core policy that grants Support Desk permission names;
- durable `@pegma/rate-limit` policies on create and reply;
- mail provider credentials, callback verification, and sender domains;
- inbound webhook verification, MIME bounds and normalization, reply-address
  token rendering, sender evaluation, the account matcher, and the inbound
  routing policy;
- template packs and public ticket URLs;
- health metrics without message content;
- retention, export, redaction, and operator access procedures.

## Task 14 host attachment composition

This section describes the attachment APIs published in `0.2.5`. Private
storage, scanning, retention and host deployment acceptance remain required.

Configure the optional `attachments` blob port and limits on the application. Wire a trusted scanner to `recordAttachmentScanResult`, verified session access to `downloadAttachment`, staff redaction to `deleteAttachment`, and an authorized cursor worker to `sweepExpiredAttachments`. Use private isolated storage and apply every returned download header. Orphan cleanup requires a host-wide stopped/drained writer fence and bounded host inventory candidates; it is never an age-only online sweep. See [ATTACHMENTS.md](./ATTACHMENTS.md) for all five activation milestones, defaults and failure recovery. Inbound MIME normalization continues discarding all attachments with bounded parsing.
