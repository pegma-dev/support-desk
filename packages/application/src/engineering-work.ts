import { hasPermission, type AccessContext } from "@pegma/authorization-core";
import { MAX_SCAN_PAGE_SIZE } from "@pegma/storage-core";
import {
  SupportDeskAuthorizationError,
  SupportDeskConflictError,
  SupportDeskLimitError,
  SupportDeskNotFoundError,
  supportPermissions,
} from "./index.js";
import {
  canonical,
  dataArray,
  encodedBytes,
  fields,
  fingerprint,
  integer,
  text,
  timestamp,
} from "./assistant-turn-records.js";
import type {
  EngineeringApplication,
  EngineeringClaimFence,
  EngineeringExportChecksBinding,
  EngineeringExportRequest,
  EngineeringModelBinding,
  EngineeringProcessing,
  EngineeringRoutingBinding,
  EngineeringRoutingDecision,
  EngineeringStepResult,
  EngineeringPolicySnapshot,
} from "./engineering-types.js";
import {
  safeEngineeringSnapshot as snapshot,
  checkEngineeringRecordCapacity,
  engineeringMaximumCandidateBytes,
  engineeringMaximumRecordBytes,
  engineeringCommandKey,
  engineeringSourceKey,
  engineeringWorkKey,
  validateEngineeringCandidate,
  validateEngineeringModelBinding,
  validateEngineeringExportRequest,
  type EngineeringPreparedProposal as PreparedProposal,
  type EngineeringSourceRecord,
  type EngineeringWorkRecord,
  type EngineeringStaffSelection,
} from "./engineering-records.js";
import type {
  EngineeringAction,
  EngineeringDependencies,
  EngineeringLoaded,
  EngineeringLoader,
  EngineeringWorkVersion,
} from "./engineering-internal.js";

export async function engineeringModelManifestHash(
  manifest: EngineeringModelBinding["inputManifest"],
): Promise<string> {
  const value = fields(manifest, "engineering input manifest", [
    "messages",
    "evidenceFingerprint",
    "product",
    "policyGeneration",
    "policyHash",
    "repositoryIds",
  ]);
  const seen = new Set<string>();
  for (const item of dataArray(value.messages, "manifest.messages", 100)) {
    const message = fields(item, "manifest message", ["messageId", "ordinal"]);
    text(message.messageId, "messageId");
    integer(message.ordinal, "ordinal", 1);
    if (seen.has(message.messageId as string))
      throw new TypeError("Duplicate engineering manifest message");
    seen.add(message.messageId as string);
  }
  text(value.evidenceFingerprint, "manifest.evidenceFingerprint");
  integer(value.policyGeneration, "manifest.policyGeneration", 0);
  text(value.policyHash, "manifest.policyHash");
  const product = fields(value.product, "manifest.product", [
    "productId",
    "version",
    "buildId",
    "binding",
    "contextVersion",
  ]);
  for (const key of Object.keys(product))
    text(product[key], `manifest.product.${key}`);
  const repositories = dataArray(
    value.repositoryIds,
    "manifest.repositoryIds",
    20,
  ).map((id) => text(id, "manifest.repositoryId"));
  if (new Set(repositories).size !== repositories.length)
    throw new TypeError("Duplicate engineering manifest repository");
  return fingerprint(manifest);
}

export async function engineeringRoutingBinding(input: {
  readonly sourceBindingHash: string;
  readonly evidenceFingerprint: string;
  readonly candidateHash: string;
  readonly inputFingerprint: string;
  readonly routing: EngineeringRoutingDecision;
  readonly policyGeneration: number;
  readonly policyHash: string;
  readonly modelVersion: string;
  readonly promptVersion: string;
  readonly parserVersion: string;
  readonly repositoryId: string;
}): Promise<EngineeringRoutingBinding> {
  const { routing, ...binding } = input;
  return { ...binding, routingHash: await fingerprint(routing) };
}

export async function engineeringRoutingBindingHash(
  binding: EngineeringRoutingBinding,
): Promise<string> {
  return fingerprint(binding);
}

export async function engineeringStaffSelectionHash(
  selection: EngineeringStaffSelection,
): Promise<string> {
  return fingerprint({ kind: "staff_selection", selection });
}

export async function engineeringExportChecksBinding(input: {
  readonly sourceBindingHash: string;
  readonly evidenceFingerprint: string;
  readonly candidateHash: string;
  readonly routingBindingHash: string;
  readonly exactRequest: EngineeringExportRequest;
  readonly policyGeneration: number;
  readonly policyHash: string;
}): Promise<EngineeringExportChecksBinding> {
  const { exactRequest, ...binding } = input;
  return {
    ...binding,
    requestHash: await fingerprint(exactRequest),
    repositoryMetadataHash: await fingerprint(exactRequest.repository),
  };
}

type WorkerMethods = Pick<
  EngineeringApplication,
  | "scanEngineeringCandidates"
  | "claimEngineeringWork"
  | "prepareEngineeringModel"
  | "completeEngineeringModel"
  | "finishEngineeringWork"
  | "selectEngineeringRepository"
  | "prepareEngineeringProposal"
  | "reviewEngineeringProposal"
  | "beginEngineeringDispatch"
>;

function permission(
  access: AccessContext,
  review = false,
  expectedActor?: string,
): void {
  text(access.principalId, "principalId");
  const name = review
    ? supportPermissions.engineeringReview
    : supportPermissions.engineeringProcess;
  if (expectedActor !== undefined && access.principalId !== expectedActor)
    throw new SupportDeskAuthorizationError(name);
  if (!hasPermission(access, name))
    throw new SupportDeskAuthorizationError(name);
  if (review && !hasPermission(access, supportPermissions.queueRead))
    throw new SupportDeskAuthorizationError(supportPermissions.queueRead);
}
function scanPermission(access: AccessContext, actorId: string) {
  text(access.principalId, "principalId");
  if (access.principalId !== actorId)
    throw new SupportDeskAuthorizationError(
      supportPermissions.engineeringProcess,
    );
  const process = hasPermission(access, supportPermissions.engineeringProcess);
  const review =
    hasPermission(access, supportPermissions.engineeringReview) &&
    hasPermission(access, supportPermissions.queueRead);
  if (!process && !review)
    throw new SupportDeskAuthorizationError(
      supportPermissions.engineeringProcess,
    );
  return {
    process,
    review,
    restricted:
      review &&
      hasPermission(access, supportPermissions.engineeringRestrictedRead),
  };
}
function fence(command: EngineeringClaimFence): void {
  text(command.ticketId, "ticketId");
  integer(command.sourceGeneration, "sourceGeneration", 1);
  text(command.workerId, "workerId");
  text(command.claimId, "claimId");
  integer(command.claimGeneration, "claimGeneration", 1);
}
function sameClaim(
  work: EngineeringWorkRecord,
  command: EngineeringClaimFence,
): boolean {
  return (
    work.claim !== undefined &&
    canonical(work.claim) ===
      canonical({
        ticketId: command.ticketId,
        sourceGeneration: command.sourceGeneration,
        workerId: command.workerId,
        claimId: command.claimId,
        claimGeneration: command.claimGeneration,
      })
  );
}
function withoutLease(work: EngineeringWorkRecord): EngineeringWorkRecord {
  const { claim: _claim, leaseUntil: _lease, retryAt: _retry, ...rest } = work;
  return rest;
}
function processing(value: EngineeringProcessing | undefined): void {
  if (value === undefined) return;
  const input = fields(
    value,
    "engineering processing",
    [],
    [
      "provider",
      "model",
      "requestId",
      "failureCategory",
      "inputTokens",
      "outputTokens",
      "costMicros",
      "currency",
    ],
  );
  for (const [key, entry] of Object.entries(input))
    if (["inputTokens", "outputTokens", "costMicros"].includes(key))
      integer(entry, `processing.${key}`, 0);
    else text(entry, `processing.${key}`);
}
function outcome(work: EngineeringWorkRecord): EngineeringStepResult {
  return {
    ticketId: work.ticketId,
    sourceGeneration: work.sourceGeneration,
    workGeneration: work.workGeneration,
    status: work.status,
    ...(work.stepId === undefined ? {} : { stepId: work.stepId }),
    ...(work.requestHash === undefined
      ? {}
      : { requestHash: work.requestHash }),
    ...(work.candidateHash === undefined
      ? {}
      : { candidateHash: work.candidateHash }),
    ...(work.proposal === undefined
      ? {}
      : { proposalHash: work.proposal.proposalHash }),
    ...(work.dispatch === undefined
      ? {}
      : { dispatchId: work.dispatch.dispatchId }),
    ...(work.acknowledgement === undefined
      ? {}
      : { acknowledgement: snapshot(work.acknowledgement) }),
  };
}
function effectiveTime(deps: EngineeringDependencies): () => number {
  const initial = timestamp(deps.clock.now(), "now");
  const start = performance.now();
  return () =>
    Math.max(
      timestamp(deps.clock.now(), "now"),
      initial + Math.max(0, performance.now() - start),
    );
}
async function trusted<T>(
  deps: EngineeringDependencies,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => operation(controller.signal)),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(
            new SupportDeskConflictError(
              "Engineering trusted observation timed out",
            ),
          );
        }, deps.options.trustTimeoutMilliseconds);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
function current(
  loaded: EngineeringLoaded,
  work: EngineeringWorkRecord,
): boolean {
  const source = loaded.source.value;
  return (
    source.state === "eligible" &&
    source.security === "ordinary" &&
    work.security === "ordinary" &&
    source.sourceGeneration === work.sourceGeneration &&
    source.sourceBindingHash === work.sourceBindingHash &&
    source.evidence !== undefined &&
    source.product !== undefined &&
    work.evidence !== undefined &&
    work.product !== undefined &&
    canonical(source.evidence) === canonical(work.evidence) &&
    canonical(source.product) === canonical(work.product)
  );
}
function reserveReachable(work: EngineeringWorkRecord): void {
  const escaped = "\ud800".repeat(200);
  const maximumTime = "+275760-09-13T00:00:00.000Z";
  const metadata = {
    provider: escaped,
    model: escaped,
    requestId: escaped,
    failureCategory: escaped,
    currency: escaped,
    inputTokens: Number.MAX_SAFE_INTEGER,
    outputTokens: Number.MAX_SAFE_INTEGER,
    costMicros: Number.MAX_SAFE_INTEGER,
  };
  const maximumFence = {
    ticketId: work.ticketId,
    sourceGeneration: work.sourceGeneration,
    workerId: escaped,
    claimId: escaped,
    claimGeneration: Number.MAX_SAFE_INTEGER,
  };
  const base = {
    ...work,
    security: "restricted",
    workGeneration: Number.MAX_SAFE_INTEGER,
    claimGeneration: Number.MAX_SAFE_INTEGER,
    claim: maximumFence,
    leaseUntil: maximumTime,
    retryAt: maximumTime,
    heldReason: escaped,
    lastFinish: { fingerprint: "f".repeat(64) },
  };
  const futures: object[] = [base];
  if (work.stage === "model") {
    for (const accounting of ["not_called", "accounted"] as const) {
      const modelAttempts = work.modelAttempts.map((entry, index) =>
        index !== work.modelAttempts.length - 1
          ? entry
          : { ...entry, accounting, processing: metadata },
      );
      futures.push({ ...base, modelAttempts, status: "superseded" });
      if (accounting === "accounted")
        futures.push({
          ...base,
          modelAttempts,
          stage: "proposal",
          status: "restricted",
          candidate: "\ud800".repeat(
            Math.ceil(engineeringMaximumCandidateBytes / 12),
          ),
          candidateHash: "f".repeat(64),
          lastCompletion: { fingerprint: "f".repeat(64) },
        });
    }
  } else {
    const acknowledgement = {
      repositoryId: escaped,
      issueId: escaped,
      issueNumber: Number.MAX_SAFE_INTEGER,
      url: escaped,
    };
    const proposal = work.proposal;
    const approval =
      proposal === undefined
        ? {}
        : {
            approval: {
              proposalHash: proposal.proposalHash,
              requestHash: proposal.requestHash,
              sourceBindingHash: work.sourceBindingHash,
              policyGeneration: proposal.policyGeneration,
              policyHash: proposal.policyHash,
              repositoryMetadataHash: proposal.repositoryMetadataHash,
              routingBindingHash: proposal.routingBindingHash,
              checksBindingHash: "f".repeat(64),
              decision: "approve",
              reviewedBy: escaped,
              reviewedAt: maximumTime,
              reason: escaped,
            },
          };
    const dispatch =
      proposal === undefined
        ? {}
        : {
            dispatch: {
              dispatchId: escaped,
              startedAt: maximumTime,
              workerId: escaped,
              claimId: escaped,
              claimGeneration: Number.MAX_SAFE_INTEGER,
              repositoryId: proposal.request.repository.repositoryId,
              requestHash: proposal.requestHash,
              exportMarker: proposal.request.bundle.exportMarker,
            },
          };
    futures.push({
      ...base,
      ...approval,
      ...dispatch,
      stage: "reconcile",
      status: "confirmed_rejected",
      terminalReserveRows: 2,
      resultProof: escaped,
      acknowledgement,
      lastDispatchResult: { fingerprint: "f".repeat(64) },
    });
  }
  for (const future of futures)
    if (encodedBytes(future) > engineeringMaximumRecordBytes)
      throw new SupportDeskLimitError(
        "serialized_record",
        engineeringMaximumRecordBytes,
      );
  checkEngineeringRecordCapacity(work);
}

export function createEngineeringWorkerServices(
  deps: EngineeringDependencies,
  load: EngineeringLoader,
): WorkerMethods {
  const { records, clock, options } = deps;
  async function workAt(key: {
    readonly ticketId: string;
    readonly sourceGeneration: number;
  }): Promise<EngineeringWorkVersion> {
    const stored = await records.getVersioned(
      engineeringWorkKey(key.ticketId, key.sourceGeneration),
    );
    if (stored?.value.kind !== "engineering_work")
      throw new SupportDeskNotFoundError();
    return { value: stored.value, version: stored.version };
  }
  async function save(
    loaded: EngineeringLoaded,
    stored: EngineeringWorkVersion,
    work: EngineeringWorkRecord,
    source: EngineeringSourceRecord = loaded.source.value,
    extra: readonly EngineeringAction[] = [],
  ): Promise<boolean> {
    checkEngineeringRecordCapacity(work);
    checkEngineeringRecordCapacity(source);
    return (
      await records.transact(work.ticketId, [
        {
          action: "putIfUnchanged",
          version: loaded.ticket.version,
          value: loaded.ticket.value,
        },
        {
          action: "putIfUnchanged",
          version: loaded.source.version,
          value: source,
        },
        { action: "putIfUnchanged", version: stored.version, value: work },
        ...extra,
      ])
    ).committed;
  }
  function live(
    loaded: EngineeringLoaded,
    work: EngineeringWorkRecord,
    command: EngineeringClaimFence,
    now: number,
  ): void {
    if (
      !sameClaim(work, command) ||
      work.leaseUntil === undefined ||
      timestamp(work.leaseUntil, "leaseUntil") <= now ||
      timestamp(work.deadline, "deadline") <= now ||
      !current(loaded, work)
    )
      throw new SupportDeskConflictError(
        "Engineering source, work or claim fence changed",
      );
  }
  function restrictedSource(
    loaded: EngineeringLoaded,
    work: EngineeringWorkRecord,
    security: "restricted" | "uncertain" = "restricted",
  ): EngineeringSourceRecord {
    const source = loaded.source.value;
    if (
      source.state === "withdrawn" ||
      source.sourceGeneration !== work.sourceGeneration ||
      source.sourceBindingHash !== work.sourceBindingHash
    )
      return source;
    return {
      ...source,
      state: "restricted",
      security,
      sourceGeneration: source.sourceGeneration + 1,
      workGeneration: source.workGeneration + 1,
      heldReason: "security_restricted",
      updatedAt: clock.now(),
    };
  }
  async function freshPolicy(
    access: AccessContext,
    expected?: {
      readonly policyGeneration: number;
      readonly policyHash: string;
    },
  ): Promise<EngineeringPolicySnapshot> {
    const policy = snapshot(await deps.policy.resolve(access));
    if (
      !policy.policy.enabled ||
      (expected !== undefined &&
        (policy.generation !== expected.policyGeneration ||
          policy.policyHash !== expected.policyHash))
    )
      throw new SupportDeskConflictError(
        "Engineering repository policy changed or disabled",
      );
    return policy;
  }
  function allowed(
    policy: EngineeringPolicySnapshot,
    request: EngineeringExportRequest,
  ): void {
    const descriptor = policy.policy.repositories.find(
      (entry) => entry.repositoryId === request.repository.repositoryId,
    );
    if (
      descriptor === undefined ||
      !descriptor.enabled ||
      descriptor.publicationMode !== "approval_required" ||
      descriptor.owner !== request.repository.owner ||
      descriptor.name !== request.repository.name ||
      descriptor.visibility !== request.repository.visibility ||
      request.bundle.labels.some(
        (label) => !descriptor.allowedLabels.includes(label),
      ) ||
      (request.bundle.templateId !== undefined &&
        !descriptor.allowedTemplates.includes(request.bundle.templateId))
    )
      throw new SupportDeskConflictError(
        "Engineering request is outside current repository authority",
      );
  }
  async function currentRepository(
    request: EngineeringExportRequest,
  ): Promise<void> {
    if (options.repositoryMetadata === undefined)
      throw new SupportDeskConflictError(
        "Engineering repository observation unavailable",
      );
    const observed = await trusted(deps, (signal) =>
      options.repositoryMetadata!.resolve(
        request.repository.repositoryId,
        signal,
      ),
    );
    if (
      observed === null ||
      canonical(observed) !== canonical(request.repository)
    )
      throw new SupportDeskConflictError(
        "Engineering repository metadata or installation authority changed",
      );
  }
  function receipt(
    command: { readonly ticketId: string; readonly commandId: string },
    hash: string,
    result: EngineeringStepResult,
  ): EngineeringAction {
    return {
      action: "insert",
      value: {
        kind: "engineering_receipt",
        partition: command.ticketId,
        id: engineeringCommandKey(command.ticketId, command.commandId).id,
        fingerprint: hash,
        result,
      },
    };
  }
  async function replay(
    command: { readonly ticketId: string; readonly commandId: string },
    hash: string,
  ): Promise<EngineeringStepResult | null> {
    const prior = await records.get(
      engineeringCommandKey(command.ticketId, command.commandId),
    );
    if (prior === null) return null;
    if (
      prior.kind !== "engineering_receipt" ||
      prior.fingerprint !== hash ||
      !("status" in prior.result)
    )
      throw new SupportDeskConflictError("Engineering command ID reused");
    return snapshot(prior.result);
  }
  function claimView(
    loaded: EngineeringLoaded,
    work: EngineeringWorkRecord,
    policy: EngineeringPolicySnapshot,
    recoveredModelPreparation: boolean,
  ) {
    const ordinals = new Set<number>();
    const messages = loaded.rows
      .flatMap((row) => {
        if (
          row.kind !== "message" ||
          row.message.visibility !== "customer" ||
          row.ordinal > work.acceptedTicketRevision
        )
          return [];
        integer(row.ordinal, "message.ordinal", 1);
        if (ordinals.has(row.ordinal))
          throw new SupportDeskConflictError("Duplicate message ordinal");
        ordinals.add(row.ordinal);
        return [
          {
            messageId: row.message.id,
            ordinal: row.ordinal,
            body: row.message.body,
            speaker:
              row.message.authorKind === "customer"
                ? ("customer" as const)
                : row.message.authorKind === "assistant"
                  ? ("assistant" as const)
                  : row.message.authorKind === "system"
                    ? ("notification" as const)
                    : ("support" as const),
          },
        ];
      })
      .sort((a, b) => a.ordinal - b.ordinal);
    return {
      fence: snapshot(work.claim!),
      sourceFence: {
        ticketId: work.ticketId,
        sourceGeneration: work.sourceGeneration,
        sourceBindingHash: work.sourceBindingHash,
      },
      workGeneration: work.workGeneration,
      leaseUntil: work.leaseUntil!,
      work: snapshot(work),
      policy: snapshot(policy),
      messages,
      recoveredModelPreparation,
      reconciliationOnly:
        work.dispatch !== undefined || work.stage === "reconcile",
    };
  }
  function validity(
    value: { readonly verifiedAt: string; readonly validUntil: string },
    now: number,
    name: string,
  ): number {
    if (
      timestamp(value.verifiedAt, `${name}.verifiedAt`) > now ||
      timestamp(value.validUntil, `${name}.validUntil`) <= now
    )
      throw new SupportDeskConflictError(`${name} is not current`);
    return timestamp(value.validUntil, `${name}.validUntil`);
  }
  async function verifyProposal(
    access: AccessContext,
    loaded: EngineeringLoaded,
    work: EngineeringWorkRecord,
    proposal: PreparedProposal,
    runNow: () => number,
  ): Promise<number> {
    const policy = await freshPolicy(access, proposal);
    allowed(policy, proposal.request);
    if (
      proposal.requestHash !== (await fingerprint(proposal.request)) ||
      proposal.repositoryMetadataHash !==
        (await fingerprint(proposal.request.repository)) ||
      proposal.candidateHash !== work.candidateHash ||
      canonical(proposal.checksBinding) !==
        canonical(
          await engineeringExportChecksBinding({
            sourceBindingHash: work.sourceBindingHash,
            evidenceFingerprint: loaded.source.value.evidenceFingerprint!,
            candidateHash: proposal.candidateHash,
            routingBindingHash: proposal.routingBindingHash,
            exactRequest: proposal.request,
            policyGeneration: proposal.policyGeneration,
            policyHash: proposal.policyHash,
          }),
        )
    )
      throw new SupportDeskConflictError(
        "Engineering exact proposal binding changed",
      );
    let deadline = Number.POSITIVE_INFINITY;
    if (proposal.routingBinding !== undefined) {
      if (
        options.routing === undefined ||
        proposal.routingReceipt === undefined ||
        proposal.routingBindingHash !==
          (await engineeringRoutingBindingHash(proposal.routingBinding))
      )
        throw new SupportDeskConflictError(
          "Engineering calibrated routing unavailable",
        );
      const verified = snapshot(
        await trusted(deps, () =>
          options.routing!.verify(
            proposal.routingReceipt!,
            proposal.routingBinding!,
          ),
        ),
      );
      if (verified === null)
        throw new SupportDeskConflictError(
          "Engineering routing receipt unverified",
        );
      fields(verified, "verified routing", [
        "binding",
        "outcome",
        "verifierReceiptId",
        "verifierVersion",
        "verifiedAt",
        "validUntil",
      ]);
      text(verified.verifierReceiptId, "routing.verifierReceiptId");
      text(verified.verifierVersion, "routing.verifierVersion");
      if (
        verified.outcome !== "accepted" ||
        canonical(verified.binding) !== canonical(proposal.routingBinding)
      )
        throw new SupportDeskConflictError(
          "Engineering routing requires staff selection",
        );
      deadline = Math.min(
        deadline,
        validity(verified, runNow(), "engineering routing"),
      );
    } else if (
      work.staffSelection === undefined ||
      work.staffSelection.repositoryId !==
        proposal.request.repository.repositoryId ||
      work.staffSelection.policyGeneration !== proposal.policyGeneration ||
      work.staffSelection.policyHash !== proposal.policyHash ||
      proposal.routingBindingHash !==
        (await engineeringStaffSelectionHash(work.staffSelection))
    )
      throw new SupportDeskConflictError(
        "Engineering staff repository selection changed",
      );
    if (options.checks === undefined)
      throw new SupportDeskConflictError(
        "Engineering independent export checks unavailable",
      );
    const verified = snapshot(
      await trusted(deps, () =>
        options.checks!.verify(proposal.checksReceipt, proposal.checksBinding),
      ),
    );
    if (verified === null)
      throw new SupportDeskConflictError(
        "Engineering export checks unverified",
      );
    fields(verified, "verified engineering checks", [
      "binding",
      "privacy",
      "factual",
      "security",
      "publicReproduction",
      "verifierReceiptId",
      "verifierVersion",
      "verifiedAt",
      "validUntil",
    ]);
    text(verified.verifierReceiptId, "checks.verifierReceiptId");
    text(verified.verifierVersion, "checks.verifierVersion");
    if (
      canonical(verified.binding) !== canonical(proposal.checksBinding) ||
      verified.privacy !== "passed" ||
      verified.factual !== "passed" ||
      verified.security !== "clear" ||
      (verified.publicReproduction !== "passed" &&
        verified.publicReproduction !== "not_applicable") ||
      (proposal.request.repository.visibility === "public" &&
        verified.publicReproduction !== "passed")
    )
      throw new SupportDeskConflictError(
        "Engineering exact privacy, factual, security or public reproduction check failed",
      );
    deadline = Math.min(
      deadline,
      validity(verified, runNow(), "engineering export checks"),
    );
    if (runNow() >= deadline)
      throw new SupportDeskConflictError(
        "Engineering proposal verification expired",
      );
    return deadline;
  }
  return {
    async scanEngineeringCandidates(access, input) {
      const actorId = access.principalId;
      const authority = scanPermission(access, actorId);
      const bounds = fields(input, "engineering scan", ["limit"], ["cursor"]);
      integer(bounds.limit, "limit", 1, MAX_SCAN_PAGE_SIZE);
      if (bounds.cursor !== undefined) text(bounds.cursor, "cursor", 20_000);
      const page = await records.scan({
        limit: bounds.limit as number,
        ...(bounds.cursor === undefined
          ? {}
          : { cursor: bounds.cursor as string }),
      });
      if (page.records.length > (bounds.limit as number))
        throw new TypeError(
          "Engineering scan returned more physical rows than requested",
        );
      scanPermission(access, actorId);
      const now = timestamp(clock.now(), "now");
      const sources = new Map<
        string,
        Promise<EngineeringSourceRecord | null>
      >();
      function sourceAt(
        ticketId: string,
      ): Promise<EngineeringSourceRecord | null> {
        let pending = sources.get(ticketId);
        if (pending === undefined) {
          pending = records
            .get(engineeringSourceKey(ticketId))
            .then((value) => {
              if (value === null) return null;
              if (
                value.kind !== "engineering_source" ||
                value.ticketId !== ticketId ||
                value.partition !== ticketId ||
                value.id !== "engineering-source"
              )
                throw new SupportDeskConflictError(
                  "Engineering scan source key identity mismatch",
                );
              return value;
            });
          sources.set(ticketId, pending);
        }
        return pending;
      }
      const candidates: { ticketId: string; sourceGeneration: number }[] = [];
      const reviewCandidates: { ticketId: string; sourceGeneration: number }[] =
        [];
      const restrictedReviewCandidates: {
        ticketId: string;
        sourceGeneration: number;
      }[] = [];
      const reviewSources = new Set<string>();
      const restrictedReviewSources = new Set<string>();
      const reconciliationSources = new Set<string>();
      function sourceAttention(source: EngineeringSourceRecord | null): void {
        if (
          source === null ||
          !["unverified", "held", "restricted"].includes(source.state)
        )
          return;
        if (source.security !== "ordinary" || source.state === "restricted")
          restrictedReviewSources.add(source.ticketId);
        else reviewSources.add(source.ticketId);
      }
      for (const row of page.records) {
        if (row.value.kind === "engineering_source") {
          if (
            row.key.partition !== row.value.ticketId ||
            row.key.id !== "engineering-source"
          )
            throw new TypeError("Engineering scan source identity mismatch");
          if (authority.process && row.value.reconciliationPending)
            reconciliationSources.add(row.value.ticketId);
          if (authority.review)
            sourceAttention(await sourceAt(row.value.ticketId));
          continue;
        }
        if (row.value.kind !== "engineering_work") continue;
        const work = row.value;
        if (row.key.partition !== work.ticketId || row.key.id !== work.id)
          throw new TypeError("Engineering scan work identity mismatch");
        const key = {
          ticketId: work.ticketId,
          sourceGeneration: work.sourceGeneration,
        };
        const restrictedWork =
          work.security !== "ordinary" ||
          work.status === "restricted" ||
          (work.candidate !== undefined &&
            work.candidate.security !== "ordinary");
        let source: EngineeringSourceRecord | null | undefined;
        if (authority.review) {
          source = await sourceAt(work.ticketId);
          sourceAttention(source);
          if (
            restrictedWork &&
            source !== null &&
            source.state !== "withdrawn" &&
            (source.state === "restricted" || source.security !== "ordinary") &&
            source.sourceBindingHash === work.sourceBindingHash
          )
            restrictedReviewCandidates.push(key);
        }
        if (work.dispatch !== undefined) {
          if (
            authority.process &&
            !["accepted", "confirmed_rejected"].includes(work.status)
          )
            reconciliationSources.add(work.ticketId);
          continue;
        }
        if (
          [
            "accepted",
            "confirmed_rejected",
            "superseded",
            "restricted",
          ].includes(work.status) ||
          restrictedWork
        )
          continue;
        if (source === undefined) source = await sourceAt(work.ticketId);
        if (
          source?.kind === "engineering_source" &&
          source.state === "eligible" &&
          source.security === "ordinary" &&
          source.sourceGeneration === work.sourceGeneration &&
          source.sourceBindingHash === work.sourceBindingHash
        ) {
          if (
            authority.review &&
            ((work.proposal !== undefined &&
              !work.proposalNeedsRebuild &&
              (work.approval === undefined ||
                (work.approval.decision === "approve" &&
                  timestamp(work.deadline, "work.deadline") <= now))) ||
              (work.proposal === undefined &&
                work.candidate !== undefined &&
                (work.candidate.routing.outcome !== "selected" ||
                  work.status === "held")))
          )
            reviewCandidates.push(key);
          if (
            authority.process &&
            timestamp(work.deadline, "work.deadline") > now &&
            (work.retryAt === undefined ||
              timestamp(work.retryAt, "work.retryAt") <= now) &&
            (work.proposal === undefined ||
              work.proposalNeedsRebuild ||
              work.approval?.decision === "approve")
          )
            candidates.push(key);
        }
      }
      const finalAuthority = scanPermission(access, actorId);
      return {
        candidates: finalAuthority.process ? candidates : [],
        reviewCandidates: finalAuthority.review
          ? [
              ...reviewCandidates,
              ...(finalAuthority.restricted ? restrictedReviewCandidates : []),
            ]
          : [],
        reviewSources: finalAuthority.review
          ? [
              ...new Set([
                ...reviewSources,
                ...(finalAuthority.restricted ? restrictedReviewSources : []),
              ]),
            ]
          : [],
        reconciliationSources: finalAuthority.process
          ? [...reconciliationSources]
          : [],
        physicalRows: page.records.length,
        pages: 1,
        nextCursor: page.nextCursor,
      };
    },
    async claimEngineeringWork(access, input) {
      permission(access);
      const actorId = access.principalId;
      const command = snapshot(
        fields(input, "engineering claim", [
          "ticketId",
          "sourceGeneration",
          "workerId",
          "claimId",
          "leaseMilliseconds",
        ]),
      ) as unknown as typeof input;
      text(command.ticketId, "ticketId");
      integer(command.sourceGeneration, "sourceGeneration", 1);
      text(command.workerId, "workerId");
      text(command.claimId, "claimId");
      integer(
        command.leaseMilliseconds,
        "leaseMilliseconds",
        1,
        options.maxLeaseMilliseconds,
      );
      if (!options.enabled) return null;
      for (let attempt = 0; attempt < deps.maxConflictAttempts; attempt += 1) {
        permission(access, false, actorId);
        const loaded = await load(command.ticketId);
        const stored = await workAt(command);
        const work = stored.value;
        const now = timestamp(clock.now(), "now");
        if (
          !current(loaded, work) ||
          [
            "accepted",
            "confirmed_rejected",
            "superseded",
            "restricted",
          ].includes(work.status) ||
          timestamp(work.deadline, "deadline") <= now ||
          (work.retryAt !== undefined &&
            timestamp(work.retryAt, "retryAt") > now)
        ) {
          permission(access, false, actorId);
          return null;
        }
        const policy = await freshPolicy(access);
        const recovered =
          work.stage === "model" &&
          work.stepId !== undefined &&
          ["prepared", "claimed", "unknown"].includes(work.status);
        if (
          work.claim !== undefined &&
          work.leaseUntil !== undefined &&
          timestamp(work.leaseUntil, "leaseUntil") > now
        ) {
          if (
            work.claim.workerId !== command.workerId ||
            work.claim.claimId !== command.claimId
          ) {
            permission(access, false, actorId);
            return null;
          }
          permission(access, false, actorId);
          if (await save(loaded, stored, work)) {
            permission(access, false, actorId);
            return claimView(loaded, work, policy, recovered);
          }
          continue;
        }
        const claimGeneration = work.claimGeneration + 1;
        integer(claimGeneration, "claimGeneration", 1);
        const next: EngineeringWorkRecord = {
          ...work,
          claimGeneration,
          claim: {
            ticketId: work.ticketId,
            sourceGeneration: work.sourceGeneration,
            workerId: command.workerId,
            claimId: command.claimId,
            claimGeneration,
          },
          leaseUntil: new Date(
            Math.min(
              timestamp(clock.now(), "now") + command.leaseMilliseconds,
              timestamp(work.deadline, "deadline"),
            ),
          ).toISOString(),
          workGeneration: work.workGeneration + 1,
          status: work.dispatch === undefined ? "claimed" : work.status,
        };
        permission(access, false, actorId);
        if (
          timestamp(work.deadline, "deadline") <= timestamp(clock.now(), "now")
        )
          return null;
        if (await save(loaded, stored, next)) {
          permission(access, false, actorId);
          return claimView(loaded, next, policy, recovered);
        }
      }
      throw new SupportDeskConflictError();
    },
    async prepareEngineeringModel(access, input) {
      permission(access);
      const actorId = access.principalId;
      const command = snapshot(
        fields(input, "prepare engineering model", [
          "ticketId",
          "sourceGeneration",
          "workerId",
          "claimId",
          "claimGeneration",
          "binding",
        ]),
      ) as unknown as typeof input;
      fence(command);
      validateEngineeringModelBinding(command.binding);
      if (!options.enabled)
        throw new SupportDeskConflictError("Engineering processing disabled");
      const runNow = effectiveTime(deps);
      for (let attempt = 0; attempt < deps.maxConflictAttempts; attempt += 1) {
        permission(access, false, actorId);
        const loaded = await load(command.ticketId);
        const stored = await workAt(command);
        const work = stored.value;
        live(loaded, work, command, runNow());
        if (
          work.stage !== "model" ||
          work.dispatch !== undefined ||
          work.candidate !== undefined
        )
          throw new SupportDeskConflictError("Engineering model stage changed");
        const binding = command.binding;
        const manifest = binding.inputManifest;
        const policy = await freshPolicy(access, {
          policyGeneration: manifest.policyGeneration,
          policyHash: manifest.policyHash,
        });
        if (
          (await engineeringModelManifestHash(manifest)) !==
            binding.inputManifestHash ||
          manifest.evidenceFingerprint !==
            loaded.source.value.evidenceFingerprint ||
          canonical(manifest.product) !==
            canonical({
              productId: work.product!.productId,
              version: work.product!.version,
              buildId: work.product!.buildId,
              binding: work.product!.binding,
              contextVersion: work.product!.contextVersion,
            }) ||
          manifest.repositoryIds.some(
            (id) =>
              !policy.policy.repositories.some(
                (repo) => repo.repositoryId === id && repo.enabled,
              ),
          ) ||
          manifest.messages.some(
            (reference) =>
              !loaded.rows.some(
                (row) =>
                  row.kind === "message" &&
                  row.message.visibility === "customer" &&
                  row.message.id === reference.messageId &&
                  row.ordinal === reference.ordinal &&
                  row.ordinal <= work.acceptedTicketRevision,
              ),
          )
        )
          throw new SupportDeskConflictError(
            "Engineering input manifest differs from authoritative evidence",
          );
        const deadline = timestamp(binding.deadline, "model.deadline");
        if (
          deadline <= runNow() ||
          deadline > timestamp(work.leaseUntil!, "leaseUntil") ||
          deadline > timestamp(work.deadline, "deadline")
        )
          throw new SupportDeskConflictError(
            "Engineering model deadline exceeds live claim",
          );
        const existing = work.modelAttempts.find(
          (entry) => canonical(entry.binding) === canonical(binding),
        );
        if (existing !== undefined) {
          if (
            existing.preparedClaimGeneration !== command.claimGeneration ||
            existing.stepId !== work.stepId
          )
            throw new SupportDeskConflictError(
              "Engineering model preparation belongs to another invocation",
            );
          live(loaded, work, command, runNow());
          permission(access, false, actorId);
          if (await save(loaded, stored, work)) {
            permission(access, false, actorId);
            return {
              stepId: existing.stepId,
              requestHash: existing.requestHash,
              maxCandidateBytes: 16_000,
            };
          }
          continue;
        }
        if (
          work.modelAttempts.length >= options.maxModelAttempts ||
          work.modelAttempts.some(
            (entry) =>
              entry.preparedClaimGeneration === command.claimGeneration,
          )
        )
          throw new SupportDeskConflictError(
            "Engineering model attempt limit reached",
          );
        const requestHash = await fingerprint(binding);
        const stepId = await fingerprint({
          sourceBindingHash: work.sourceBindingHash,
          claimGeneration: command.claimGeneration,
          binding,
        });
        const next: EngineeringWorkRecord = {
          ...work,
          status: "prepared",
          stepId,
          requestHash,
          modelAttempts: [
            ...work.modelAttempts,
            {
              preparedClaimGeneration: command.claimGeneration,
              stepId,
              requestHash,
              binding,
              accounting: "unknown",
            },
          ],
          workGeneration: work.workGeneration + 1,
        };
        reserveReachable(next);
        await freshPolicy(access, {
          policyGeneration: manifest.policyGeneration,
          policyHash: manifest.policyHash,
        });
        live(loaded, work, command, runNow());
        permission(access, false, actorId);
        if (await save(loaded, stored, next)) {
          permission(access, false, actorId);
          return { stepId, requestHash, maxCandidateBytes: 16_000 };
        }
      }
      throw new SupportDeskConflictError();
    },
    async completeEngineeringModel(access, input, guard) {
      permission(access);
      const actorId = access.principalId;
      if (typeof guard !== "function")
        throw new TypeError(
          "Engineering model completion requires a current read-only guard",
        );
      const command = snapshot(
        fields(
          input,
          "complete engineering model",
          [
            "ticketId",
            "sourceGeneration",
            "workerId",
            "claimId",
            "claimGeneration",
            "stepId",
            "requestHash",
            "candidate",
            "accounting",
          ],
          ["processing"],
        ),
      ) as unknown as typeof input;
      fence(command);
      text(command.stepId, "stepId");
      text(command.requestHash, "requestHash");
      validateEngineeringCandidate(command.candidate);
      processing(command.processing);
      if (!["accounted", "unknown"].includes(command.accounting))
        throw new TypeError("Invalid model accounting");
      const completion = await fingerprint(command);
      const candidateHash = await fingerprint(command.candidate);
      const runNow = effectiveTime(deps);
      for (let attempt = 0; attempt < deps.maxConflictAttempts; attempt += 1) {
        permission(access, false, actorId);
        const loaded = await load(command.ticketId);
        const stored = await workAt(command);
        const work = stored.value;
        if (work.lastCompletion?.fingerprint === completion) {
          permission(access, false, actorId);
          return outcome(work);
        }
        live(loaded, work, command, runNow());
        const model = work.modelAttempts.find(
          (entry) =>
            entry.stepId === command.stepId &&
            entry.requestHash === command.requestHash,
        );
        if (
          work.stage !== "model" ||
          work.stepId !== command.stepId ||
          work.requestHash !== command.requestHash ||
          model === undefined ||
          model.preparedClaimGeneration !== command.claimGeneration
        )
          throw new SupportDeskConflictError(
            "Engineering prepared model owner changed",
          );
        if (
          canonical(command.candidate.applicability) !==
          canonical({
            productId: work.product!.productId,
            version: work.product!.version,
            buildId: work.product!.buildId,
          })
        )
          throw new SupportDeskConflictError(
            "Engineering candidate applicability changed",
          );
        const next: EngineeringWorkRecord = {
          ...withoutLease(work),
          stage: "proposal",
          status:
            command.candidate.security === "ordinary"
              ? "candidate"
              : "restricted",
          security: command.candidate.security,
          candidate: command.candidate,
          candidateHash,
          workGeneration: work.workGeneration + 1,
          lastCompletion: { fingerprint: completion },
          modelAttempts: work.modelAttempts.map((entry) =>
            entry !== model
              ? entry
              : {
                  ...entry,
                  accounting: command.accounting,
                  ...(command.processing === undefined
                    ? {}
                    : { processing: command.processing }),
                },
          ),
        };
        checkEngineeringRecordCapacity(next);
        await guard();
        await freshPolicy(access, {
          policyGeneration: model.binding.inputManifest.policyGeneration,
          policyHash: model.binding.inputManifest.policyHash,
        });
        permission(access, false, actorId);
        live(loaded, work, command, runNow());
        if (timestamp(model.binding.deadline, "model.deadline") <= runNow())
          throw new SupportDeskConflictError(
            "Engineering prepared model deadline expired",
          );
        const nextSource =
          command.candidate.security === "ordinary"
            ? loaded.source.value
            : restrictedSource(loaded, work, command.candidate.security);
        if (await save(loaded, stored, next, nextSource)) {
          permission(access, false, actorId);
          return outcome(next);
        }
      }
      throw new SupportDeskConflictError();
    },
    async finishEngineeringWork(access, input) {
      permission(access);
      const actorId = access.principalId;
      const command = snapshot(
        fields(
          input,
          "finish engineering work",
          [
            "ticketId",
            "sourceGeneration",
            "workerId",
            "claimId",
            "claimGeneration",
            "disposition",
          ],
          [
            "stepId",
            "requestHash",
            "accounting",
            "retryAt",
            "reason",
            "processing",
            "classificationCandidateHash",
          ],
        ),
      ) as unknown as typeof input;
      fence(command);
      processing(command.processing);
      if (
        (command.stepId === undefined) !==
        (command.requestHash === undefined)
      )
        throw new TypeError(
          "Engineering finish requires exact step and request hash together",
        );
      if (command.stepId !== undefined) {
        text(command.stepId, "stepId");
        text(command.requestHash, "requestHash");
      }
      if (
        !["retry", "held", "restricted", "unknown", "superseded"].includes(
          command.disposition,
        )
      )
        throw new TypeError("Invalid engineering disposition");
      if (
        command.accounting !== undefined &&
        !["not_called", "accounted", "unknown"].includes(command.accounting)
      )
        throw new TypeError("Invalid engineering accounting");
      if (command.reason !== undefined) text(command.reason, "reason");
      if (command.classificationCandidateHash !== undefined) {
        text(
          command.classificationCandidateHash,
          "classificationCandidateHash",
        );
        if (
          command.disposition !== "restricted" ||
          command.stepId === undefined ||
          command.accounting !== undefined ||
          command.processing !== undefined
        )
          throw new TypeError(
            "Historical restriction requires an exact step and cannot change usage accounting",
          );
      }
      const hash = await fingerprint(command);
      for (let attempt = 0; attempt < deps.maxConflictAttempts; attempt += 1) {
        permission(access, false, actorId);
        const loaded = await load(command.ticketId);
        const stored = await workAt(command);
        const work = stored.value;
        if (work.lastFinish?.fingerprint === hash) {
          permission(access, false, actorId);
          return outcome(work);
        }
        if (command.classificationCandidateHash !== undefined) {
          if (
            work.candidateHash !== command.classificationCandidateHash ||
            !(
              work.modelAttempts.some(
                (entry) =>
                  entry.stepId === command.stepId &&
                  entry.requestHash === command.requestHash,
              ) ||
              (work.proposal !== undefined &&
                work.proposal.stepId === command.stepId &&
                work.proposal.requestHash === command.requestHash)
            )
          )
            throw new SupportDeskConflictError(
              "Historical restriction candidate or prepared step changed",
            );
          const { approval: _approval, ...classified } = withoutLease(work);
          const preserved =
            work.dispatch !== undefined ||
            [
              "superseded",
              "held",
              "accepted",
              "confirmed_rejected",
              "unknown",
            ].includes(work.status);
          const next: EngineeringWorkRecord = {
            ...classified,
            security: "restricted",
            status: preserved ? work.status : "restricted",
            workGeneration: work.workGeneration + 1,
            heldReason: "security_restricted",
            lastFinish: { fingerprint: hash },
          };
          permission(access, false, actorId);
          if (
            await save(loaded, stored, next, restrictedSource(loaded, work))
          ) {
            permission(access, false, actorId);
            return outcome(next);
          }
          continue;
        }
        const now = timestamp(clock.now(), "now");
        if (
          !sameClaim(work, command) ||
          work.leaseUntil === undefined ||
          timestamp(work.leaseUntil, "leaseUntil") <= now
        )
          throw new SupportDeskConflictError(
            "Engineering finish claim expired",
          );
        if (
          (command.stepId !== undefined && command.stepId !== work.stepId) ||
          (command.requestHash !== undefined &&
            command.requestHash !== work.requestHash)
        )
          throw new SupportDeskConflictError("Engineering finish step changed");
        if (
          command.stepId === undefined &&
          (work.proposal !== undefined ||
            work.dispatch !== undefined ||
            work.modelAttempts.some(
              (entry) =>
                entry.preparedClaimGeneration === command.claimGeneration,
            ))
        )
          throw new SupportDeskConflictError(
            "Prepared engineering work requires its exact step fence",
          );
        if (
          command.retryAt !== undefined &&
          (timestamp(command.retryAt, "retryAt") < now ||
            timestamp(command.retryAt, "retryAt") >=
              timestamp(work.deadline, "deadline"))
        )
          throw new SupportDeskConflictError(
            "Engineering retry exceeds work deadline",
          );
        const next: EngineeringWorkRecord = {
          ...withoutLease(work),
          security:
            command.disposition === "restricted" ? "restricted" : work.security,
          status:
            work.dispatch !== undefined
              ? "unknown"
              : current(loaded, work)
                ? command.disposition
                : "held",
          stage: work.dispatch === undefined ? work.stage : "reconcile",
          workGeneration: work.workGeneration + 1,
          lastFinish: { fingerprint: hash },
          ...(command.retryAt === undefined
            ? {}
            : { retryAt: command.retryAt }),
          ...(command.reason === undefined
            ? {}
            : { heldReason: command.reason }),
          modelAttempts: work.modelAttempts.map((entry) => {
            if (
              command.stepId === undefined ||
              entry.stepId !== command.stepId ||
              entry.requestHash !== command.requestHash
            )
              return entry;
            if (entry.preparedClaimGeneration !== command.claimGeneration) {
              if (
                command.accounting !== undefined &&
                command.accounting !== "unknown" &&
                command.accounting !== entry.accounting
              )
                throw new SupportDeskConflictError(
                  "Cannot rewrite another invocation's engineering accounting",
                );
              return entry;
            }
            if (
              entry.accounting !== "unknown" &&
              command.accounting !== undefined &&
              entry.accounting !== command.accounting
            )
              throw new SupportDeskConflictError(
                "Known engineering accounting cannot be replaced",
              );
            return {
              ...entry,
              ...(command.accounting === undefined
                ? {}
                : { accounting: command.accounting }),
              ...(command.processing === undefined
                ? {}
                : { processing: command.processing }),
            };
          }),
        };
        const nextSource =
          command.disposition !== "restricted"
            ? loaded.source.value
            : restrictedSource(loaded, work);
        permission(access, false, actorId);
        if (await save(loaded, stored, next, nextSource)) {
          permission(access, false, actorId);
          return outcome(next);
        }
      }
      throw new SupportDeskConflictError();
    },
    async selectEngineeringRepository(access, input) {
      permission(access, true);
      const actorId = access.principalId;
      const command = snapshot(
        fields(input, "select engineering repository", [
          "ticketId",
          "sourceGeneration",
          "commandId",
          "correlationId",
          "expectedWorkGeneration",
          "repositoryId",
          "policyGeneration",
          "policyHash",
          "reason",
        ]),
      ) as unknown as typeof input;
      text(command.ticketId, "ticketId");
      integer(command.sourceGeneration, "sourceGeneration", 1);
      for (const key of [
        "commandId",
        "correlationId",
        "repositoryId",
        "policyHash",
        "reason",
      ] as const)
        text(command[key], key);
      integer(command.expectedWorkGeneration, "expectedWorkGeneration", 1);
      integer(command.policyGeneration, "policyGeneration", 0);
      const hash = await fingerprint({ command, actorId });
      for (let attempt = 0; attempt < deps.maxConflictAttempts; attempt += 1) {
        permission(access, true, actorId);
        const previous = await replay(command, hash);
        if (previous !== null) {
          permission(access, true, actorId);
          return previous;
        }
        const loaded = await load(command.ticketId);
        const stored = await workAt(command);
        const work = stored.value;
        if (
          !current(loaded, work) ||
          work.workGeneration !== command.expectedWorkGeneration ||
          work.dispatch !== undefined ||
          work.candidateHash === undefined ||
          work.status === "restricted" ||
          (work.candidate !== undefined &&
            work.candidate.security !== "ordinary")
        )
          throw new SupportDeskConflictError(
            "Engineering repository selection source or work changed",
          );
        const policy = await freshPolicy(access, command);
        if (
          !policy.policy.repositories.some(
            (entry) =>
              entry.repositoryId === command.repositoryId && entry.enabled,
          )
        )
          throw new SupportDeskConflictError(
            "Selected engineering repository is not allowed",
          );
        const {
          approval: _approval,
          proposalNeedsRebuild: _rebuild,
          ...editable
        } = work;
        const now = clock.now();
        const next: EngineeringWorkRecord = {
          ...withoutLease(editable),
          stage: "proposal",
          status: "candidate",
          deadline: new Date(
            timestamp(now, "now") + options.maxWorkMilliseconds,
          ).toISOString(),
          ...(work.proposal === undefined
            ? {}
            : { proposalNeedsRebuild: true }),
          workGeneration: work.workGeneration + 1,
          staffSelection: {
            repositoryId: command.repositoryId,
            policyGeneration: command.policyGeneration,
            policyHash: command.policyHash,
            selectedBy: actorId,
            selectedAt: now,
            reason: command.reason,
            commandId: command.commandId,
          },
        };
        if (next.proposal === undefined) checkEngineeringRecordCapacity(next);
        else reserveReachable(next);
        deps.admission(loaded.ticket.value.ticket, loaded.rows, 2);
        const result = outcome(next);
        permission(access, true, actorId);
        if (
          await save(loaded, stored, next, loaded.source.value, [
            deps.audit(
              command,
              loaded.ticket.value.ticket,
              actorId,
              now,
              "support.engineering.repository_selected",
            ),
            receipt(command, hash, result),
          ])
        ) {
          permission(access, true, actorId);
          return result;
        }
      }
      const previous = await replay(command, hash);
      if (previous !== null) {
        permission(access, true, actorId);
        return previous;
      }
      throw new SupportDeskConflictError();
    },
    async prepareEngineeringProposal(access, input, guard) {
      permission(access);
      const actorId = access.principalId;
      if (typeof guard !== "function")
        throw new TypeError(
          "Engineering proposal requires a current read-only guard",
        );
      const command = snapshot(
        fields(
          input,
          "prepare engineering proposal",
          [
            "ticketId",
            "sourceGeneration",
            "workerId",
            "claimId",
            "claimGeneration",
            "candidateHash",
            "checksReceipt",
            "exactRequest",
            "policyGeneration",
            "policyHash",
          ],
          ["routingReceipt"],
        ),
      ) as unknown as typeof input;
      fence(command);
      text(command.candidateHash, "candidateHash");
      text(command.checksReceipt, "checksReceipt");
      text(command.policyHash, "policyHash");
      integer(command.policyGeneration, "policyGeneration", 0);
      if (command.routingReceipt !== undefined)
        text(command.routingReceipt, "routingReceipt");
      validateEngineeringExportRequest(command.exactRequest);
      if (
        !command.exactRequest.bundle.body.includes(
          command.exactRequest.bundle.exportMarker,
        )
      )
        throw new SupportDeskConflictError(
          "Engineering exact rendered body must contain its opaque export marker",
        );
      const preparationFingerprint = await fingerprint({ actorId, command });
      const runNow = effectiveTime(deps);
      for (let attempt = 0; attempt < deps.maxConflictAttempts; attempt += 1) {
        permission(access, false, actorId);
        const accepted = await replay(
          { ticketId: command.ticketId, commandId: preparationFingerprint },
          preparationFingerprint,
        );
        if (accepted !== null) {
          permission(access, false, actorId);
          return accepted;
        }
        const stored = await workAt(command);
        const work = stored.value;
        if (
          work.lastProposalPreparation?.fingerprint === preparationFingerprint
        ) {
          permission(access, false, actorId);
          return snapshot(work.lastProposalPreparation.result);
        }
        if (!options.enabled)
          throw new SupportDeskConflictError("Engineering processing disabled");
        const loaded = await load(command.ticketId);
        live(loaded, work, command, runNow());
        if (
          work.dispatch !== undefined ||
          work.candidateHash !== command.candidateHash ||
          work.status === "restricted" ||
          (work.candidate !== undefined &&
            work.candidate.security !== "ordinary")
        )
          throw new SupportDeskConflictError(
            "Engineering proposal candidate or dispatch changed",
          );
        const policy = await freshPolicy(access, command);
        allowed(policy, command.exactRequest);
        const repositoryId = command.exactRequest.repository.repositoryId;
        let routingBinding: EngineeringRoutingBinding | undefined;
        let routingReceipt: string | undefined;
        let routingBindingHash: string;
        if (work.staffSelection !== undefined) {
          if (
            work.staffSelection.repositoryId !== repositoryId ||
            work.staffSelection.policyGeneration !== policy.generation ||
            work.staffSelection.policyHash !== policy.policyHash
          )
            throw new SupportDeskConflictError(
              "Engineering staff selection differs from current target",
            );
          routingBindingHash = await engineeringStaffSelectionHash(
            work.staffSelection,
          );
        } else {
          const model = work.modelAttempts.at(-1);
          if (model === undefined || command.routingReceipt === undefined)
            throw new SupportDeskConflictError(
              "Engineering routing requires authorized staff selection",
            );
          if (work.candidate !== undefined) {
            if (
              work.candidate.routing.outcome !== "selected" ||
              work.candidate.routing.repositoryId !== repositoryId
            )
              throw new SupportDeskConflictError(
                "Engineering routing requires authorized staff selection",
              );
            routingBinding = await engineeringRoutingBinding({
              sourceBindingHash: work.sourceBindingHash,
              evidenceFingerprint: loaded.source.value.evidenceFingerprint!,
              candidateHash: command.candidateHash,
              inputFingerprint: model.binding.inputFingerprint,
              routing: work.candidate.routing,
              policyGeneration: policy.generation,
              policyHash: policy.policyHash,
              modelVersion: model.binding.modelVersion,
              promptVersion: model.binding.promptVersion,
              parserVersion: model.binding.parserVersion,
              repositoryId,
            });
          } else {
            const previous = work.proposal?.routingBinding;
            if (
              previous === undefined ||
              previous.repositoryId !== repositoryId ||
              previous.sourceBindingHash !== work.sourceBindingHash ||
              previous.candidateHash !== command.candidateHash ||
              previous.evidenceFingerprint !==
                loaded.source.value.evidenceFingerprint
            )
              throw new SupportDeskConflictError(
                "Engineering replacement needs current staff target selection",
              );
            routingBinding = {
              ...previous,
              policyGeneration: policy.generation,
              policyHash: policy.policyHash,
            };
          }
          routingBindingHash =
            await engineeringRoutingBindingHash(routingBinding);
          routingReceipt = command.routingReceipt;
        }
        const checksBinding = await engineeringExportChecksBinding({
          sourceBindingHash: work.sourceBindingHash,
          evidenceFingerprint: loaded.source.value.evidenceFingerprint!,
          candidateHash: command.candidateHash,
          routingBindingHash,
          exactRequest: command.exactRequest,
          policyGeneration: policy.generation,
          policyHash: policy.policyHash,
        });
        const body = {
          candidateHash: command.candidateHash,
          policyGeneration: policy.generation,
          policyHash: policy.policyHash,
          repositoryMetadataHash: checksBinding.repositoryMetadataHash,
          routingBindingHash,
          ...(routingBinding === undefined ? {} : { routingBinding }),
          ...(routingReceipt === undefined ? {} : { routingReceipt }),
          checksBinding,
          checksReceipt: command.checksReceipt,
          request: command.exactRequest,
        };
        const old = work.proposal;
        const identical =
          old !== undefined &&
          !work.proposalNeedsRebuild &&
          canonical(body) ===
            canonical({
              candidateHash: old.candidateHash,
              policyGeneration: old.policyGeneration,
              policyHash: old.policyHash,
              repositoryMetadataHash: old.repositoryMetadataHash,
              routingBindingHash: old.routingBindingHash,
              ...(old.routingBinding === undefined
                ? {}
                : {
                    routingBinding: old.routingBinding,
                    routingReceipt: old.routingReceipt,
                  }),
              checksBinding: old.checksBinding,
              checksReceipt: old.checksReceipt,
              request: old.request,
            });
        if (!identical && work.proposalCount >= options.maxProposals)
          throw new SupportDeskConflictError(
            "Engineering proposal limit reached",
          );
        const proposalCount = identical
          ? work.proposalCount
          : work.proposalCount + 1;
        const proposalHash = identical
          ? old!.proposalHash
          : await fingerprint({
              sourceBindingHash: work.sourceBindingHash,
              proposalCount,
              ...body,
            });
        const stepId = identical
          ? old!.stepId
          : await fingerprint({
              sourceGeneration: work.sourceGeneration,
              proposalHash,
            });
        const proposal: PreparedProposal = identical
          ? old!
          : {
              ...body,
              proposalHash,
              stepId,
              requestHash: checksBinding.requestHash,
              preparedClaimGeneration: command.claimGeneration,
            };
        const deadline = await verifyProposal(
          access,
          loaded,
          work,
          proposal,
          runNow,
        );
        const {
          approval: _approval,
          candidate: _candidate,
          proposalNeedsRebuild: _needsRebuild,
          ...unreviewed
        } = work;
        const next: EngineeringWorkRecord = identical
          ? work
          : {
              ...withoutLease(unreviewed),
              stage: "proposal",
              status: "prepared",
              stepId,
              requestHash: proposal.requestHash,
              proposal,
              proposalCount,
              workGeneration: work.workGeneration + 1,
            };
        reserveReachable(next);
        const causal = {
          ticketId: command.ticketId,
          commandId: preparationFingerprint,
          correlationId: stepId,
        };
        const hash = preparationFingerprint;
        const result = outcome(next);
        const acknowledged: EngineeringWorkRecord = {
          ...next,
          lastProposalPreparation: {
            fingerprint: preparationFingerprint,
            result,
          },
        };
        reserveReachable(acknowledged);
        deps.admission(loaded.ticket.value.ticket, loaded.rows, 2);
        await guard();
        await currentRepository(proposal.request);
        await freshPolicy(access, proposal);
        permission(access, false, actorId);
        live(loaded, work, command, runNow());
        if (runNow() >= deadline)
          throw new SupportDeskConflictError(
            "Engineering exact proposal checks expired",
          );
        const actions: readonly EngineeringAction[] = [
          deps.audit(
            causal,
            loaded.ticket.value.ticket,
            actorId,
            clock.now(),
            "support.engineering.proposal_prepared",
          ),
          receipt(causal, hash, result),
        ];
        if (
          await save(loaded, stored, acknowledged, loaded.source.value, actions)
        ) {
          permission(access, false, actorId);
          return result;
        }
      }
      throw new SupportDeskConflictError();
    },
    async reviewEngineeringProposal(access, input, guard) {
      permission(access, true);
      const actorId = access.principalId;
      const command = snapshot(
        fields(
          input,
          "review engineering proposal",
          [
            "ticketId",
            "sourceGeneration",
            "commandId",
            "correlationId",
            "expectedWorkGeneration",
            "proposalHash",
            "decision",
          ],
          ["reason"],
        ),
      ) as unknown as typeof input;
      text(command.ticketId, "ticketId");
      integer(command.sourceGeneration, "sourceGeneration", 1);
      for (const key of ["commandId", "correlationId", "proposalHash"] as const)
        text(command[key], key);
      integer(command.expectedWorkGeneration, "expectedWorkGeneration", 1);
      if (command.decision !== "approve" && command.decision !== "reject")
        throw new TypeError("Invalid engineering review decision");
      if (command.reason !== undefined) text(command.reason, "reason");
      const hash = await fingerprint({ command, actorId });
      const runNow = effectiveTime(deps);
      for (let attempt = 0; attempt < deps.maxConflictAttempts; attempt += 1) {
        permission(access, true, actorId);
        const previous = await replay(command, hash);
        if (previous !== null) {
          permission(access, true, actorId);
          return previous;
        }
        if (command.decision === "approve" && typeof guard !== "function")
          throw new TypeError(
            "Engineering approval requires a current read-only guard",
          );
        const loaded = await load(command.ticketId);
        const stored = await workAt(command);
        const work = stored.value;
        if (
          !current(loaded, work) ||
          work.workGeneration !== command.expectedWorkGeneration ||
          work.dispatch !== undefined ||
          work.proposal?.proposalHash !== command.proposalHash ||
          work.proposalNeedsRebuild === true
        )
          throw new SupportDeskConflictError(
            "Engineering exact review source, proposal or generation changed",
          );
        const proposal = work.proposal;
        const deadline =
          command.decision === "reject"
            ? Number.POSITIVE_INFINITY
            : await verifyProposal(access, loaded, work, proposal, runNow);
        let next: EngineeringWorkRecord = {
          ...withoutLease(work),
          stage: "dispatch",
          status: command.decision === "approve" ? "approved" : "held",
          ...(command.decision === "reject"
            ? {}
            : {
                deadline: new Date(
                  runNow() + options.maxWorkMilliseconds,
                ).toISOString(),
              }),
          workGeneration: work.workGeneration + 1,
          approval: {
            proposalHash: proposal.proposalHash,
            requestHash: proposal.requestHash,
            sourceBindingHash: work.sourceBindingHash,
            policyGeneration: proposal.policyGeneration,
            policyHash: proposal.policyHash,
            repositoryMetadataHash: proposal.repositoryMetadataHash,
            routingBindingHash: proposal.routingBindingHash,
            checksBindingHash: await fingerprint(proposal.checksBinding),
            decision: command.decision,
            reviewedBy: actorId,
            reviewedAt: clock.now(),
            ...(command.reason === undefined ? {} : { reason: command.reason }),
          },
        };
        reserveReachable(next);
        deps.admission(loaded.ticket.value.ticket, loaded.rows, 2);
        const result = outcome(next);
        if (command.decision === "approve") {
          await guard!();
          await currentRepository(proposal.request);
          await freshPolicy(access, proposal);
        }
        permission(access, true, actorId);
        if (!current(loaded, work) || runNow() >= deadline)
          throw new SupportDeskConflictError(
            "Engineering review source or checks expired",
          );
        if (command.decision === "approve") {
          next = {
            ...next,
            deadline: new Date(
              runNow() + options.maxWorkMilliseconds,
            ).toISOString(),
          };
          reserveReachable(next);
        }
        if (
          await save(loaded, stored, next, loaded.source.value, [
            deps.audit(
              command,
              loaded.ticket.value.ticket,
              actorId,
              clock.now(),
              "support.engineering.reviewed",
            ),
            receipt(command, hash, result),
          ])
        ) {
          permission(access, true, actorId);
          return result;
        }
      }
      const previous = await replay(command, hash);
      if (previous !== null) {
        permission(access, true, actorId);
        return previous;
      }
      throw new SupportDeskConflictError();
    },
    async beginEngineeringDispatch(access, input, guard) {
      permission(access);
      const actorId = access.principalId;
      if (typeof guard !== "function")
        throw new TypeError(
          "Engineering dispatch requires a current read-only guard",
        );
      const command = snapshot(
        fields(input, "begin engineering dispatch", [
          "ticketId",
          "sourceGeneration",
          "workerId",
          "claimId",
          "claimGeneration",
          "stepId",
          "requestHash",
          "proposalHash",
          "dispatchId",
        ]),
      ) as unknown as typeof input;
      fence(command);
      for (const key of [
        "stepId",
        "requestHash",
        "proposalHash",
        "dispatchId",
      ] as const)
        text(command[key], key);
      if (!options.enabled)
        throw new SupportDeskConflictError("Engineering processing disabled");
      if (options.dispatchResults === undefined)
        throw new SupportDeskConflictError(
          "Engineering dispatch proof verifier unavailable",
        );
      const runNow = effectiveTime(deps);
      for (let attempt = 0; attempt < deps.maxConflictAttempts; attempt += 1) {
        permission(access, false, actorId);
        const loaded = await load(command.ticketId);
        const stored = await workAt(command);
        const work = stored.value;
        live(loaded, work, command, runNow());
        const proposal = work.proposal;
        const approval = work.approval;
        if (
          proposal === undefined ||
          work.proposalNeedsRebuild === true ||
          approval?.decision !== "approve" ||
          proposal.proposalHash !== command.proposalHash ||
          proposal.stepId !== command.stepId ||
          proposal.requestHash !== command.requestHash ||
          work.stepId !== command.stepId ||
          work.requestHash !== command.requestHash ||
          approval.proposalHash !== proposal.proposalHash ||
          approval.requestHash !== proposal.requestHash ||
          approval.sourceBindingHash !== work.sourceBindingHash ||
          approval.policyGeneration !== proposal.policyGeneration ||
          approval.policyHash !== proposal.policyHash ||
          approval.repositoryMetadataHash !== proposal.repositoryMetadataHash ||
          approval.routingBindingHash !== proposal.routingBindingHash ||
          approval.checksBindingHash !==
            (await fingerprint(proposal.checksBinding))
        )
          throw new SupportDeskConflictError(
            "Engineering dispatch exact staff approval changed",
          );
        if (
          work.dispatch !== undefined &&
          (work.status !== "dispatch_started" ||
            work.dispatch.dispatchId !== command.dispatchId ||
            work.dispatch.workerId !== command.workerId ||
            work.dispatch.claimId !== command.claimId ||
            work.dispatch.claimGeneration !== command.claimGeneration)
        ) {
          permission(access, false, actorId);
          return null;
        }
        const deadline = await verifyProposal(
          access,
          loaded,
          work,
          proposal,
          runNow,
        );
        await guard();
        await currentRepository(proposal.request);
        await freshPolicy(access, proposal);
        permission(access, false, actorId);
        live(loaded, work, command, runNow());
        if (runNow() >= deadline)
          throw new SupportDeskConflictError(
            "Engineering dispatch verification expired",
          );
        const replayed = work.dispatch !== undefined;
        const dispatch = work.dispatch ?? {
          dispatchId: command.dispatchId,
          startedAt: clock.now(),
          workerId: command.workerId,
          claimId: command.claimId,
          claimGeneration: command.claimGeneration,
          repositoryId: proposal.request.repository.repositoryId,
          requestHash: proposal.requestHash,
          exportMarker: proposal.request.bundle.exportMarker,
        };
        const next: EngineeringWorkRecord = replayed
          ? work
          : {
              ...work,
              dispatch,
              terminalReserveRows: 2,
              stage: "reconcile",
              status: "dispatch_started",
              workGeneration: work.workGeneration + 1,
            };
        const destinations = loaded.source.value.destinations;
        if (
          !replayed &&
          (destinations.length >= options.maxTargets ||
            destinations.some(
              (entry) => entry.exportMarker === dispatch.exportMarker,
            ))
        )
          throw new SupportDeskConflictError(
            "Engineering target capacity or opaque marker uniqueness limit reached",
          );
        const nextSource: EngineeringSourceRecord = replayed
          ? loaded.source.value
          : {
              ...loaded.source.value,
              workGeneration: loaded.source.value.workGeneration + 1,
              reconciliationPending: true,
              destinations: [
                ...destinations,
                {
                  repositoryId: dispatch.repositoryId,
                  sourceGeneration: work.sourceGeneration,
                  stepId: proposal.stepId,
                  requestHash: proposal.requestHash,
                  exportMarker: dispatch.exportMarker,
                  dispatchId: dispatch.dispatchId,
                  outcome: "dispatch_started",
                  reconciliation: "pending",
                },
              ],
            };
        reserveReachable(next);
        checkEngineeringRecordCapacity(nextSource);
        const causal = {
          ticketId: command.ticketId,
          commandId: await fingerprint({
            operation: "dispatch_started",
            dispatchId: command.dispatchId,
            sourceGeneration: work.sourceGeneration,
            requestHash: command.requestHash,
          }),
          correlationId: command.dispatchId,
        };
        const hash = await fingerprint(command);
        if (!replayed)
          deps.admission(loaded.ticket.value.ticket, loaded.rows, 4);
        if (
          await save(
            loaded,
            stored,
            next,
            nextSource,
            replayed
              ? []
              : [
                  deps.audit(
                    causal,
                    loaded.ticket.value.ticket,
                    actorId,
                    clock.now(),
                    "support.engineering.dispatch_started",
                  ),
                  receipt(causal, hash, outcome(next)),
                ],
          )
        ) {
          await guard();
          await currentRepository(proposal.request);
          await freshPolicy(access, proposal);
          const latest = await load(command.ticketId);
          const latestWork = await workAt(command);
          const finalSource = await records.getVersioned(
            engineeringSourceKey(command.ticketId),
          );
          permission(access, false, actorId);
          live(latest, latestWork.value, command, runNow());
          if (
            finalSource?.version !== latest.source.version ||
            latestWork.value.dispatch?.dispatchId !== command.dispatchId ||
            latestWork.value.status !== "dispatch_started" ||
            runNow() >= deadline
          )
            throw new SupportDeskConflictError(
              "Engineering dispatch changed before physical call authorization",
            );
          return {
            ticketId: work.ticketId,
            sourceGeneration: work.sourceGeneration,
            dispatchId: dispatch.dispatchId,
            exportMarker: dispatch.exportMarker,
            requestHash: proposal.requestHash,
            request: snapshot(proposal.request),
          };
        }
      }
      throw new SupportDeskConflictError();
    },
  };
}
