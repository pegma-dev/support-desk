import { hasPermission, type AccessContext } from "@pegma/authorization-core";
import { MAX_SCAN_PAGE_SIZE, type VersionedRecord } from "@pegma/storage-core";
import {
  SupportDeskAuthorizationError,
  SupportDeskConflictError,
  SupportDeskLimitError,
  SupportDeskNotFoundError,
  supportPermissions,
  type SupportRecord,
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
import {
  safeLearningSnapshot as snapshot,
  assertResolutionLearningRecord,
  maximumResolutionLearningSourceBytes,
  resolutionLearningReviewKey,
  resolutionLearningWorkKey,
  validateResolutionCandidate,
  validateResolutionRequest,
  validateResolutionTarget,
  type ResolutionLearningReviewRecord,
  type ResolutionLearningSourceRecord,
  type ResolutionLearningWorkRecord,
} from "./resolution-learning-records.js";
import type {
  ResolutionLearningDependencies,
  SourceVersion,
  TicketVersion,
} from "./resolution-learning.js";
import type {
  CompleteResolutionLearningStepCommand,
  PrepareResolutionLearningStepCommand,
  ResolutionLearningApplication,
  ResolutionLearningChecksBinding,
  ResolutionLearningClaimFence,
  ResolutionLearningDeliveryRequest,
  ResolutionLearningModelBinding,
  ResolutionLearningPreparedStep,
  ResolutionLearningProcessing,
  ResolutionLearningStepResult,
} from "./resolution-learning-types.js";

export async function resolutionLearningManifestHash(
  manifest: ResolutionLearningModelBinding["inputManifest"],
): Promise<string> {
  const value = fields(manifest, "input manifest", [
    "messages",
    "workingSolutionMessageIds",
    "product",
  ]);
  const seen = new Set<string>();
  for (const item of dataArray(value.messages, "manifest.messages", 100)) {
    const message = fields(item, "manifest message", ["messageId", "ordinal"]);
    text(message.messageId, "messageId");
    integer(message.ordinal, "ordinal", 1);
    if (seen.has(message.messageId as string))
      throw new TypeError("Duplicate manifest message");
    seen.add(message.messageId as string);
  }
  for (const id of dataArray(
    value.workingSolutionMessageIds,
    "solution IDs",
    16,
  )) {
    text(id, "solution ID");
    if (!seen.has(id as string))
      throw new TypeError("Working solution absent from manifest");
  }
  const product = fields(value.product, "manifest.product", [
    "productId",
    "version",
    "buildId",
    "binding",
    "contextVersion",
  ]);
  for (const key of Object.keys(product))
    text(product[key], `manifest.product.${key}`);
  return fingerprint(manifest);
}
function outcome(
  work: ResolutionLearningWorkRecord,
): ResolutionLearningStepResult {
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
    ...(work.target === undefined ? {} : { target: snapshot(work.target) }),
  };
}
function processing(value: ResolutionLearningProcessing | undefined): void {
  if (value === undefined) return;
  const object = fields(
    value,
    "processing",
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
  for (const [name, entry] of Object.entries(object))
    if (["inputTokens", "outputTokens", "costMicros"].includes(name))
      integer(entry, `processing.${name}`, 0);
    else text(entry, `processing.${name}`);
}

export async function resolutionLearningDeliveryBinding(input: {
  readonly candidateHash: string;
  readonly sourceBindingHash: string;
  readonly policyVersion: string;
  readonly targetDecisionHash: string;
  readonly applicability: unknown;
  readonly exactRequest: ResolutionLearningDeliveryRequest;
}): Promise<ResolutionLearningChecksBinding> {
  validateResolutionRequest(input.exactRequest);
  return {
    candidateHash: input.candidateHash,
    sourceBindingHash: input.sourceBindingHash,
    policyVersion: input.policyVersion,
    targetDecisionHash: input.targetDecisionHash,
    applicabilityHash: await fingerprint(input.applicability),
    requestHash: await fingerprint(input.exactRequest),
  };
}
type Loaded = {
  ticket: TicketVersion;
  source: SourceVersion;
  rows: readonly SupportRecord[];
};
type WorkerMethods = Pick<
  ResolutionLearningApplication,
  | "scanResolutionLearningCandidates"
  | "claimResolutionLearningWork"
  | "prepareResolutionLearningStep"
  | "completeResolutionLearningStep"
  | "finishResolutionLearningWork"
  | "reviewResolutionLearningProposal"
>;
function permission(access: AccessContext, review = false): void {
  text(access.principalId, "principalId");
  const name = review
    ? supportPermissions.learningReview
    : supportPermissions.learningProcess;
  if (!hasPermission(access, name))
    throw new SupportDeskAuthorizationError(name);
  if (review && !hasPermission(access, supportPermissions.queueRead))
    throw new SupportDeskAuthorizationError(supportPermissions.queueRead);
}
function checkRow(
  row: ResolutionLearningWorkRecord | ResolutionLearningSourceRecord,
): void {
  if (encodedBytes(row) > 60_000)
    throw new SupportDeskLimitError("serialized_record", 60_000);
  if (
    row.kind === "resolution_learning_source" &&
    maximumResolutionLearningSourceBytes(row) > 60_000
  )
    throw new SupportDeskLimitError("serialized_record", 60_000);
  assertResolutionLearningRecord(row, { partition: row.partition, id: row.id });
}
function validateFence(command: ResolutionLearningClaimFence): void {
  text(command.ticketId, "ticketId");
  integer(command.sourceGeneration, "sourceGeneration", 1);
  text(command.workerId, "workerId");
  text(command.claimId, "claimId");
  integer(command.claimGeneration, "claimGeneration", 1);
}
function sameClaim(
  work: ResolutionLearningWorkRecord,
  command: ResolutionLearningClaimFence,
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
function current(loaded: Loaded, work: ResolutionLearningWorkRecord): boolean {
  return (
    loaded.source.value.state === "eligible" &&
    loaded.source.value.sourceGeneration === work.sourceGeneration &&
    loaded.source.value.resolutionCycle === work.resolutionCycle &&
    loaded.source.value.sourceBindingHash === work.sourceBindingHash &&
    loaded.ticket.value.ticket.resolvedAt === loaded.source.value.resolvedAt &&
    ["resolved", "closed"].includes(loaded.ticket.value.ticket.status)
  );
}
function withoutLease(
  work: ResolutionLearningWorkRecord,
): ResolutionLearningWorkRecord {
  const { claim: _claim, leaseUntil: _lease, retryAt: _retry, ...rest } = work;
  return rest;
}
function reserveReachable(row: ResolutionLearningWorkRecord): void {
  // Construct legal states for this prepared stage. Model completion retains
  // its candidate; KB delivery has replaced that body with the exact request.
  // They never share a candidate plus a KB acknowledgement/target envelope.
  const escaped = "\ud800".repeat(200);
  const processing = {
    provider: escaped,
    model: escaped,
    requestId: escaped,
    failureCategory: escaped,
    currency: escaped,
    inputTokens: Number.MAX_SAFE_INTEGER,
    outputTokens: Number.MAX_SAFE_INTEGER,
    costMicros: Number.MAX_SAFE_INTEGER,
  };
  const fence = {
    ticketId: row.ticketId,
    sourceGeneration: row.sourceGeneration,
    workerId: escaped,
    claimId: escaped,
    claimGeneration: Number.MAX_SAFE_INTEGER,
  };
  const attempts = row.modelAttempts.map((attempt, index) =>
    row.stage === "model" && index === row.modelAttempts.length - 1
      ? { ...attempt, accounting: "unknown" as const, processing }
      : attempt,
  );
  const base = {
    ...withoutLease(row),
    modelAttempts: attempts,
    lastCompletion: { fingerprint: "f".repeat(64) },
    lastFinish: { fingerprint: "f".repeat(64) },
    ...(row.stage === "model"
      ? { candidate: "\ud800".repeat(Math.ceil(16_000 / 12)) }
      : {
          acknowledgement: {
            id: escaped,
            generation: Number.MAX_SAFE_INTEGER,
            articleRevision: Number.MAX_SAFE_INTEGER,
            contentHash: escaped,
            state: escaped,
          },
          target: {
            articleId: escaped,
            collectionId: escaped,
            articleRevision: Number.MAX_SAFE_INTEGER,
            contentHash: escaped,
            sourceSnapshotGeneration: Number.MAX_SAFE_INTEGER,
            sourceSnapshotHash: escaped,
            orderedReferencesHash: escaped,
          },
        }),
  };
  const completion = {
    ...base,
    status: row.stage === "model" ? "candidate" : "completed",
  };
  const finish = {
    ...base,
    status: "retry",
    heldReason: escaped,
    retryAt: "9999-12-31T23:59:59.999Z",
  };
  const replacement = {
    ...finish,
    status: "claimed",
    claim: fence,
    claimGeneration: Number.MAX_SAFE_INTEGER,
    leaseUntil: "9999-12-31T23:59:59.999Z",
  };
  for (const reachable of [completion, finish, replacement])
    if (encodedBytes(reachable) > 60_000)
      throw new SupportDeskLimitError("serialized_record", 60_000);
  checkRow(row);
}

export function createResolutionLearningWorkerServices(
  deps: ResolutionLearningDependencies,
  load: (ticketId: string) => Promise<Loaded>,
): WorkerMethods {
  const { records, clock, options } = deps;
  async function workAt(key: {
    ticketId: string;
    sourceGeneration: number;
  }): Promise<VersionedRecord<ResolutionLearningWorkRecord>> {
    const work = await records.getVersioned(
      resolutionLearningWorkKey(key.ticketId, key.sourceGeneration),
    );
    if (work?.value.kind !== "resolution_learning_work")
      throw new SupportDeskNotFoundError();
    return { value: work.value, version: work.version };
  }
  async function save(
    loaded: Loaded,
    work: VersionedRecord<ResolutionLearningWorkRecord>,
    next: ResolutionLearningWorkRecord,
    nextSource: ResolutionLearningSourceRecord = loaded.source.value,
  ): Promise<boolean> {
    checkRow(next);
    checkRow(nextSource);
    return (
      await records.transact(next.ticketId, [
        {
          action: "putIfUnchanged",
          version: loaded.ticket.version,
          value: loaded.ticket.value,
        },
        {
          action: "putIfUnchanged",
          version: loaded.source.version,
          value: nextSource,
        },
        { action: "putIfUnchanged", version: work.version, value: next },
      ])
    ).committed;
  }
  function live(
    loaded: Loaded,
    work: ResolutionLearningWorkRecord,
    command: ResolutionLearningClaimFence,
  ): void {
    if (
      !sameClaim(work, command) ||
      work.leaseUntil === undefined ||
      timestamp(work.leaseUntil, "leaseUntil") <=
        timestamp(clock.now(), "now") ||
      !current(loaded, work)
    )
      throw new SupportDeskConflictError(
        "Learning claim or source fence changed",
      );
  }
  function claimView(
    loaded: Loaded,
    work: ResolutionLearningWorkRecord,
    recoveredModelPreparation: boolean,
  ) {
    const seen = new Set<number>();
    const messages = loaded.rows
      .flatMap((row) => {
        if (
          row.kind !== "message" ||
          row.message.visibility !== "customer" ||
          row.ordinal > work.acceptedTicketRevision
        )
          return [];
        integer(row.ordinal, "ordinal", 1);
        if (seen.has(row.ordinal))
          throw new SupportDeskConflictError("Duplicate message ordinal");
        seen.add(row.ordinal);
        return [
          {
            messageId: row.message.id,
            ordinal: row.ordinal,
            speaker:
              row.message.authorKind === "customer"
                ? ("customer" as const)
                : row.message.authorKind === "assistant"
                  ? ("assistant" as const)
                  : ("support" as const),
            body: row.message.body,
          },
        ];
      })
      .sort((a, b) => a.ordinal - b.ordinal);
    return {
      fence: work.claim!,
      sourceFence: {
        ticketId: work.ticketId,
        sourceGeneration: work.sourceGeneration,
        resolutionCycle: work.resolutionCycle,
        sourceBindingHash: work.sourceBindingHash,
      },
      workGeneration: work.workGeneration,
      leaseUntil: work.leaseUntil!,
      work: snapshot(work),
      messages,
      workingSolutionMessageIds: [...work.workingSolutionMessageIds],
      recoveredModelPreparation,
    };
  }
  return {
    async scanResolutionLearningCandidates(access, input) {
      permission(access);
      const bounds = fields(input, "learning scan", ["limit"], ["cursor"]);
      integer(bounds.limit, "limit", 1, MAX_SCAN_PAGE_SIZE);
      if (bounds.cursor !== undefined) text(bounds.cursor, "cursor", 20_000);
      const page = await records.scan({
        limit: bounds.limit as number,
        ...(bounds.cursor === undefined
          ? {}
          : { cursor: bounds.cursor as string }),
      });
      return {
        candidates: page.records
          .filter(
            (row) =>
              row.value.kind === "resolution_learning_work" &&
              !["completed", "superseded"].includes(row.value.status),
          )
          .map((row) => {
            if (
              row.value.kind !== "resolution_learning_work" ||
              row.key.partition !== row.value.ticketId ||
              row.key.id !== row.value.id
            )
              throw new TypeError("Learning scan identity mismatch");
            return {
              ticketId: row.key.partition,
              sourceGeneration: row.value.sourceGeneration,
            };
          }),
        reconciliationSources: page.records.flatMap((row) => {
          if (
            row.value.kind !== "resolution_learning_source" ||
            !row.value.reconciliationPending
          )
            return [];
          if (
            row.key.partition !== row.value.ticketId ||
            row.key.id !== "learning-source"
          )
            throw new TypeError(
              "Learning reconciliation scan identity mismatch",
            );
          return [row.key.partition];
        }),
        nextCursor: page.nextCursor,
        physicalRows: page.records.length,
        pages: 1,
      };
    },
    async claimResolutionLearningWork(access, input) {
      permission(access);
      const command = snapshot(
        fields(input, "claim learning", [
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
        const loaded = await load(command.ticketId);
        const stored = await workAt(command);
        const work = stored.value;
        const now = timestamp(clock.now(), "now");
        if (
          !current(loaded, work) ||
          ["completed", "superseded"].includes(work.status) ||
          now >= timestamp(work.deadline, "deadline") ||
          (work.retryAt !== undefined &&
            now < timestamp(work.retryAt, "retryAt"))
        )
          return null;
        if (
          work.claim !== undefined &&
          work.leaseUntil !== undefined &&
          timestamp(work.leaseUntil, "leaseUntil") > now
        ) {
          if (
            work.claim.workerId !== command.workerId ||
            work.claim.claimId !== command.claimId
          )
            return null;
          return claimView(
            loaded,
            work,
            work.stage === "model" && work.stepId !== undefined,
          );
        }
        const claimGeneration =
          work.claim !== undefined &&
          work.claim.workerId === command.workerId &&
          work.claim.claimId === command.claimId &&
          work.leaseUntil !== undefined &&
          timestamp(work.leaseUntil, "leaseUntil") > now
            ? work.claimGeneration
            : work.claimGeneration + 1;
        const fence: ResolutionLearningClaimFence = {
          ticketId: command.ticketId,
          sourceGeneration: command.sourceGeneration,
          workerId: command.workerId,
          claimId: command.claimId,
          claimGeneration,
        };
        const next: ResolutionLearningWorkRecord = {
          ...work,
          claimGeneration,
          claim: fence,
          leaseUntil: new Date(
            Math.min(
              now + command.leaseMilliseconds,
              timestamp(work.deadline, "deadline"),
            ),
          ).toISOString(),
          workGeneration: work.workGeneration + 1,
          status: "claimed",
        };
        if (await save(loaded, stored, next)) {
          return claimView(
            loaded,
            next,
            work.stage === "model" &&
              work.stepId !== undefined &&
              (work.status === "prepared" || work.status === "claimed"),
          );
        }
      }
      throw new SupportDeskConflictError();
    },
    async prepareResolutionLearningStep(access, input) {
      permission(access);
      const command = snapshot(
        fields(input, "prepare learning", [
          "ticketId",
          "sourceGeneration",
          "workerId",
          "claimId",
          "claimGeneration",
          "step",
          ...(input.step === "model"
            ? ["binding"]
            : [
                "candidateHash",
                "verifiedCheckReceipt",
                "policyVersion",
                "targetDecisionHash",
                "exactRequest",
              ]),
        ]),
      ) as unknown as PrepareResolutionLearningStepCommand;
      validateFence(command);
      if (!options.enabled)
        throw new SupportDeskConflictError("Learning processing disabled");
      if (command.step !== "model" && command.step !== "kb_delivery")
        throw new TypeError("invalid learning step");
      for (let attempt = 0; attempt < deps.maxConflictAttempts; attempt += 1) {
        const loaded = await load(command.ticketId);
        const stored = await workAt(command);
        const work = stored.value;
        live(loaded, work, command);
        let next: ResolutionLearningWorkRecord;
        let prepared: ResolutionLearningPreparedStep;
        let nextSource = loaded.source.value;
        if (command.step === "model") {
          const binding = fields(command.binding, "model binding", [
            "inputManifest",
            "inputFingerprint",
            "inputManifestHash",
            "configVersion",
            "promptVersion",
            "modelVersion",
            "checkPolicyVersion",
            "budgetsHash",
            "usageReservationId",
            "deadline",
          ]);
          for (const name of Object.keys(binding).filter(
            (key) => key !== "deadline" && key !== "inputManifest",
          ))
            text(binding[name], `binding.${name}`);
          if (
            (await resolutionLearningManifestHash(
              command.binding.inputManifest,
            )) !== command.binding.inputManifestHash
          )
            throw new SupportDeskConflictError(
              "Input manifest fingerprint mismatch",
            );
          const manifest = command.binding.inputManifest;
          if (
            canonical(manifest.workingSolutionMessageIds) !==
              canonical(work.workingSolutionMessageIds) ||
            canonical(manifest.product) !==
              canonical({
                productId: work.product!.productId,
                version: work.product!.version,
                buildId: work.product!.buildId,
                binding: work.product!.binding,
                contextVersion: work.product!.contextVersion,
              }) ||
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
              "Input manifest differs from authoritative source",
            );
          const deadline = timestamp(binding.deadline, "binding.deadline");
          if (
            deadline <= timestamp(clock.now(), "now") ||
            deadline > timestamp(work.deadline, "work.deadline") ||
            deadline > timestamp(work.leaseUntil!, "leaseUntil")
          )
            throw new SupportDeskConflictError(
              "Model deadline exceeds live claim",
            );
          const existing = work.modelAttempts.find(
            (entry) => canonical(entry.binding) === canonical(command.binding),
          );
          if (existing !== undefined) {
            if (
              existing.preparedClaimGeneration !== command.claimGeneration ||
              existing.stepId !== work.stepId ||
              work.stage !== "model"
            )
              throw new SupportDeskConflictError(
                "Model preparation belongs to another invocation",
              );
            live(loaded, work, command);
            if (await save(loaded, stored, work))
              return {
                step: "model",
                stepId: existing.stepId,
                requestHash: existing.requestHash,
                maxCandidateBytes: 16_000,
              };
            continue;
          }
          if (
            work.modelAttempts.some(
              (entry) =>
                entry.preparedClaimGeneration === command.claimGeneration,
            )
          )
            throw new SupportDeskConflictError(
              "This invocation already prepared a model request",
            );
          if (
            work.exactRequest !== undefined ||
            work.candidate !== undefined ||
            work.modelAttempts.length >= options.maxModelAttempts
          )
            throw new SupportDeskConflictError(
              "Learning model attempt budget exhausted",
            );
          const requestHash = await fingerprint(command.binding);
          const stepId = await fingerprint({
            ticketId: work.ticketId,
            sourceGeneration: work.sourceGeneration,
            modelAttempt: work.modelAttempts.length + 1,
            requestHash,
          });
          next = {
            ...work,
            stage: "model",
            status: "prepared",
            stepId,
            requestHash,
            workGeneration: work.workGeneration + 1,
            modelAttempts: [
              ...work.modelAttempts,
              {
                preparedClaimGeneration: command.claimGeneration,
                stepId,
                requestHash,
                binding: command.binding,
                accounting: "unknown",
              },
            ],
          };
          prepared = {
            step: "model",
            stepId,
            requestHash,
            maxCandidateBytes: 16_000,
          };
        } else {
          validateResolutionRequest(command.exactRequest);
          text(command.candidateHash, "candidateHash");
          text(command.verifiedCheckReceipt, "verifiedCheckReceipt");
          text(command.policyVersion, "policyVersion");
          text(command.targetDecisionHash, "targetDecisionHash");
          if (
            work.candidateHash !== command.candidateHash ||
            (work.candidate === undefined && work.exactRequest === undefined)
          )
            throw new SupportDeskConflictError("Candidate changed");
          const reference = command.exactRequest.sourceReferences.find(
            (item) => item.id === loaded.source.value.sourceId,
          );
          if (
            reference === undefined ||
            reference.system !== "pegma.support-desk" ||
            reference.resourceId !== work.ticketId ||
            reference.version !== work.sourceBindingHash
          )
            throw new SupportDeskConflictError(
              "Exact source reference missing",
            );
          const applicability = work.candidate?.applicability ?? {
            productId: work.product!.productId,
            version: work.product!.version,
            buildId: work.product!.buildId,
          };
          const binding = await resolutionLearningDeliveryBinding({
            candidateHash: command.candidateHash,
            sourceBindingHash: work.sourceBindingHash,
            policyVersion: command.policyVersion,
            targetDecisionHash: command.targetDecisionHash,
            applicability,
            exactRequest: command.exactRequest,
          });
          const verified =
            options.checks === undefined
              ? null
              : await options.checks.verify(
                  command.verifiedCheckReceipt,
                  binding,
                );
          live(loaded, work, command);
          if (
            verified === null ||
            canonical(verified.binding) !== canonical(binding) ||
            [
              verified.privacy,
              verified.factual,
              verified.applicability,
              verified.duplication,
            ].some((check) => check !== "passed") ||
            timestamp(verified.validUntil, "check.validUntil") <
              timestamp(clock.now(), "now")
          )
            throw new SupportDeskConflictError(
              "Independent learning checks missing or stale",
            );
          if (work.exactRequest !== undefined) {
            if (
              work.requestHash !== binding.requestHash ||
              canonical(work.exactRequest) !== canonical(command.exactRequest)
            )
              throw new SupportDeskConflictError(
                "Prepared KB request cannot change",
              );
            if (await save(loaded, stored, work))
              return {
                step: "kb_delivery",
                stepId: work.stepId!,
                requestHash: work.requestHash!,
              };
            continue;
          }
          const destination = nextSource.destinations.find(
            (target) => target.articleId === command.exactRequest.articleId,
          );
          if (
            destination?.acceptance === "unknown" &&
            (destination.reconciliation !== "confirmed" ||
              destination.lastReconciliation?.proof === undefined)
          )
            throw new SupportDeskConflictError(
              "Prior destination write still requires reconciliation",
            );
          if (
            destination === undefined &&
            nextSource.destinations.length >= options.maxTargets
          )
            throw new SupportDeskLimitError(
              "ticket_partition",
              deps.limits.maxRecordsPerTicket,
            );
          const stepId = await fingerprint({
            ticketId: work.ticketId,
            sourceGeneration: work.sourceGeneration,
            requestHash: binding.requestHash,
          });
          const { candidate: _candidate, ...rest } = work;
          next = {
            ...rest,
            stage: "kb_delivery",
            status: "prepared",
            stepId,
            requestHash: binding.requestHash,
            exactRequest: command.exactRequest,
            verifiedCheckReceipt: command.verifiedCheckReceipt,
            checkPolicyVersion: command.policyVersion,
            targetDecisionHash: command.targetDecisionHash,
            workGeneration: work.workGeneration + 1,
          };
          const entry = {
            articleId: command.exactRequest.articleId,
            sourceGeneration: work.sourceGeneration,
            stepId,
            requestHash: binding.requestHash,
            acceptance: "unknown" as const,
            reconciliation: "pending" as const,
          };
          nextSource = {
            ...nextSource,
            reconciliationPending: true,
            destinations: [
              ...nextSource.destinations.filter(
                (target) => target.articleId !== entry.articleId,
              ),
              entry,
            ],
            workGeneration: nextSource.workGeneration + 1,
          };
          prepared = {
            step: "kb_delivery",
            stepId,
            requestHash: binding.requestHash,
          };
        }
        reserveReachable(next);
        checkRow(nextSource);
        if (await save(loaded, stored, next, nextSource)) return prepared;
      }
      throw new SupportDeskConflictError();
    },
    async completeResolutionLearningStep(access, input, guard) {
      permission(access);
      if (typeof guard !== "function")
        throw new TypeError(
          "Learning completion requires a read-only current-input guard",
        );
      const command = snapshot(
        fields(
          input,
          "complete learning",
          [
            "ticketId",
            "sourceGeneration",
            "workerId",
            "claimId",
            "claimGeneration",
            "stepId",
            "requestHash",
            "step",
            ...(input.step === "model"
              ? ["candidate", "accounting"]
              : ["historicalAck", "currentTargetBinding"]),
          ],
          input.step === "model" ? ["processing"] : [],
        ),
      ) as unknown as CompleteResolutionLearningStepCommand;
      validateFence(command);
      text(command.stepId, "stepId");
      text(command.requestHash, "requestHash");
      const completion = await fingerprint(command);
      for (let attempt = 0; attempt < deps.maxConflictAttempts; attempt += 1) {
        const loaded = await load(command.ticketId);
        const stored = await workAt(command);
        const work = stored.value;
        if (work.lastCompletion?.fingerprint === completion) {
          await guard();
          return outcome(work);
        }
        live(loaded, work, command);
        if (
          work.stepId !== command.stepId ||
          work.requestHash !== command.requestHash ||
          work.stage !== command.step
        )
          throw new SupportDeskConflictError("Prepared learning step changed");
        let next: ResolutionLearningWorkRecord;
        let nextSource = loaded.source.value;
        if (command.step === "model") {
          const preparedAttempt = work.modelAttempts.find(
            (entry) =>
              entry.stepId === command.stepId &&
              entry.requestHash === command.requestHash,
          );
          if (
            preparedAttempt === undefined ||
            preparedAttempt.preparedClaimGeneration !== command.claimGeneration
          )
            throw new SupportDeskConflictError(
              "Model completion belongs to another invocation",
            );
          validateResolutionCandidate(command.candidate);
          if (!["accounted", "unknown"].includes(command.accounting))
            throw new TypeError("Invalid model accounting");
          processing(command.processing);
          if (
            canonical(command.candidate.applicability) !==
            canonical({
              productId: work.product!.productId,
              version: work.product!.version,
              buildId: work.product!.buildId,
            })
          )
            throw new SupportDeskConflictError(
              "Candidate applicability differs from trusted product",
            );
          const candidateHash = await fingerprint(command.candidate);
          next = {
            ...withoutLease(work),
            status: "candidate",
            candidate: command.candidate,
            candidateHash,
            workGeneration: work.workGeneration + 1,
            lastCompletion: { fingerprint: completion },
            modelAttempts: work.modelAttempts.map((entry) =>
              entry.stepId !== command.stepId
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
        } else {
          validateResolutionTarget(command.currentTargetBinding);
          const ack = fields(command.historicalAck, "KB acknowledgement", [
            "id",
            "generation",
            "articleRevision",
            "contentHash",
            "state",
          ]);
          for (const key of ["id", "contentHash", "state"])
            text(ack[key], `ack.${key}`);
          integer(ack.generation, "ack.generation", 1);
          integer(ack.articleRevision, "ack.articleRevision", 1);
          if (
            work.exactRequest === undefined ||
            command.historicalAck.id !== work.exactRequest.articleId ||
            command.currentTargetBinding.articleId !==
              work.exactRequest.articleId
          )
            throw new SupportDeskConflictError(
              "KB acknowledgement target mismatch",
            );
          const agrees =
            command.historicalAck.articleRevision ===
              command.currentTargetBinding.articleRevision &&
            command.historicalAck.contentHash ===
              command.currentTargetBinding.contentHash;
          next = {
            ...withoutLease(work),
            status: agrees ? "completed" : "held",
            acknowledgement: command.historicalAck,
            target: command.currentTargetBinding,
            workGeneration: work.workGeneration + 1,
            lastCompletion: { fingerprint: completion },
            ...(agrees ? {} : { heldReason: "kb_target_changed" }),
          };
          nextSource = {
            ...nextSource,
            workGeneration: nextSource.workGeneration + 1,
            destinations: nextSource.destinations.map((entry) =>
              entry.articleId === command.historicalAck.id
                ? {
                    ...entry,
                    acceptance: "accepted" as const,
                    reconciliation: agrees
                      ? ("confirmed" as const)
                      : ("pending" as const),
                  }
                : entry,
            ),
          };
          nextSource = {
            ...nextSource,
            reconciliationPending: nextSource.destinations.some(
              (entry) => entry.reconciliation !== "confirmed",
            ),
          };
        }
        checkRow(next);
        await guard();
        live(loaded, work, command);
        if (
          command.step === "model" &&
          timestamp(
            work.modelAttempts.find((entry) => entry.stepId === command.stepId)!
              .binding.deadline,
            "model.deadline",
          ) <= timestamp(clock.now(), "now")
        )
          throw new SupportDeskConflictError("Prepared model deadline expired");
        if (await save(loaded, stored, next, nextSource)) return outcome(next);
      }
      throw new SupportDeskConflictError();
    },
    async finishResolutionLearningWork(access, input) {
      permission(access);
      const command = snapshot(
        fields(
          input,
          "finish learning",
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
          ],
        ),
      ) as unknown as typeof input;
      validateFence(command);
      if (
        !["retry", "held", "unknown", "superseded"].includes(
          command.disposition,
        )
      )
        throw new TypeError("invalid learning disposition");
      if (command.reason !== undefined) text(command.reason, "reason");
      processing(command.processing);
      if (
        command.accounting !== undefined &&
        !["not_called", "accounted", "unknown"].includes(command.accounting)
      )
        throw new TypeError("Invalid learning accounting");
      const hash = await fingerprint(command);
      for (let attempt = 0; attempt < deps.maxConflictAttempts; attempt += 1) {
        const loaded = await load(command.ticketId);
        const stored = await workAt(command);
        const work = stored.value;
        if (work.lastFinish?.fingerprint === hash) return outcome(work);
        if (
          !sameClaim(work, command) ||
          work.leaseUntil === undefined ||
          timestamp(work.leaseUntil, "leaseUntil") <=
            timestamp(clock.now(), "now")
        )
          throw new SupportDeskConflictError("Learning claim expired");
        if (
          (command.stepId !== undefined && command.stepId !== work.stepId) ||
          (command.requestHash !== undefined &&
            command.requestHash !== work.requestHash)
        )
          throw new SupportDeskConflictError("Learning finish step changed");
        const status = current(loaded, work) ? command.disposition : "held";
        if (
          command.retryAt !== undefined &&
          (timestamp(command.retryAt, "retryAt") >=
            timestamp(work.deadline, "deadline") ||
            timestamp(command.retryAt, "retryAt") <
              timestamp(clock.now(), "now"))
        )
          throw new SupportDeskConflictError("Retry exceeds work deadline");
        const next: ResolutionLearningWorkRecord = {
          ...withoutLease(work),
          status,
          workGeneration: work.workGeneration + 1,
          lastFinish: { fingerprint: hash },
          ...(command.retryAt === undefined
            ? {}
            : { retryAt: command.retryAt }),
          ...(command.reason === undefined
            ? {}
            : { heldReason: command.reason }),
          modelAttempts: work.modelAttempts.map((entry) => {
            // A finish before preparation belongs to no provider request. A new
            // claim cannot relabel an earlier invocation's known accounting.
            if (
              command.stepId === undefined ||
              command.requestHash === undefined ||
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
                  "Cannot rewrite another invocation's accounting",
                );
              return entry;
            }
            if (
              entry.accounting !== "unknown" &&
              command.accounting !== undefined &&
              command.accounting !== entry.accounting
            )
              throw new SupportDeskConflictError(
                "Known accounting cannot be replaced",
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
        if (await save(loaded, stored, next)) return outcome(next);
      }
      throw new SupportDeskConflictError();
    },
    async reviewResolutionLearningProposal(access, input, guard) {
      permission(access, true);
      if (typeof guard !== "function")
        throw new TypeError(
          "KB target review requires a read-only current-target guard",
        );
      const command = snapshot(
        fields(
          input,
          "review learning",
          [
            "ticketId",
            "sourceGeneration",
            "commandId",
            "correlationId",
            "expectedWorkGeneration",
            "target",
            "decision",
            "policyVersion",
          ],
          ["reason"],
        ),
      ) as unknown as typeof input;
      validateResolutionTarget(command.target);
      integer(command.expectedWorkGeneration, "expectedWorkGeneration", 1);
      text(command.commandId, "commandId");
      text(command.correlationId, "correlationId");
      text(command.policyVersion, "policyVersion");
      if (command.reason !== undefined) text(command.reason, "reason");
      if (command.decision !== "approve" && command.decision !== "reject")
        throw new TypeError("invalid review decision");
      const hash = await fingerprint({ command, actorId: access.principalId });
      const key = {
        partition: command.ticketId,
        id: `learning-command:${command.commandId}`,
      };
      for (let attempt = 0; attempt < deps.maxConflictAttempts; attempt += 1) {
        const loaded = await load(command.ticketId);
        const work = await workAt(command);
        const prior = await records.get(key);
        if (prior !== null) {
          if (
            prior.kind !== "resolution_learning_receipt" ||
            prior.fingerprint !== hash
          )
            throw new SupportDeskConflictError("Review command reused");
          return snapshot(prior.result);
        }
        if (
          !current(loaded, work.value) ||
          work.value.workGeneration !== command.expectedWorkGeneration ||
          !loaded.source.value.destinations.some(
            (entry) => entry.articleId === command.target.articleId,
          )
        )
          throw new SupportDeskConflictError(
            "Review source/work/target changed",
          );
        const reviewKey = await resolutionLearningReviewKey(
          loaded.source.value,
          command.target,
          command.policyVersion,
        );
        const previousReview = await records.getVersioned(reviewKey);
        if (
          previousReview !== null &&
          previousReview.value.kind !== "resolution_learning_review"
        )
          throw new SupportDeskConflictError("Review binding key collision");
        if (
          previousReview === null &&
          loaded.source.value.reviewBindingCount >= options.maxReviewBindings
        )
          throw new SupportDeskLimitError(
            "ticket_partition",
            deps.limits.maxRecordsPerTicket,
          );
        deps.admission(
          loaded.ticket.value.ticket,
          loaded.rows,
          previousReview === null ? 3 : 2,
        );
        const now = clock.now();
        const review: ResolutionLearningReviewRecord = {
          kind: "resolution_learning_review",
          partition: command.ticketId,
          id: reviewKey.id,
          ticketId: command.ticketId,
          sourceGeneration: loaded.source.value.sourceGeneration,
          sourceBindingHash: loaded.source.value.sourceBindingHash!,
          target: command.target,
          decision: command.decision,
          policyVersion: command.policyVersion,
          reviewerId: access.principalId,
          reviewedAt: now,
          ...(command.reason === undefined ? {} : { reason: command.reason }),
        };
        assertResolutionLearningRecord(review, reviewKey);
        const source: ResolutionLearningSourceRecord = {
          ...loaded.source.value,
          workGeneration: loaded.source.value.workGeneration + 1,
          reviewBindingCount:
            loaded.source.value.reviewBindingCount +
            (previousReview === null ? 1 : 0),
        };
        checkRow(source);
        const outcome = {
          ticketId: source.ticketId,
          sourceGeneration: source.sourceGeneration,
          resolutionCycle: source.resolutionCycle,
          state: source.state,
        };
        await guard();
        if (
          (
            await records.transact(command.ticketId, [
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
              {
                action: "putIfUnchanged",
                version: work.version,
                value: work.value,
              },
              previousReview === null
                ? { action: "insert", value: review }
                : {
                    action: "putIfUnchanged",
                    version: previousReview.version,
                    value: review,
                  },
              deps.audit(
                command,
                loaded.ticket.value.ticket,
                access.principalId,
                now,
                "support.learning.reviewed",
              ),
              {
                action: "insert",
                value: {
                  kind: "resolution_learning_receipt",
                  partition: command.ticketId,
                  id: key.id,
                  fingerprint: hash,
                  result: outcome,
                },
              },
            ])
          ).committed
        )
          return outcome;
      }
      throw new SupportDeskConflictError();
    },
  };
}
