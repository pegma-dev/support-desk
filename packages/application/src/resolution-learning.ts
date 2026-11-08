import { hasPermission, type AccessContext } from "@pegma/authorization-core";
import type { Clock } from "@pegma/spine";
import {
  MAX_SCAN_PAGE_SIZE,
  type CollectionStore,
  type VersionedRecord,
} from "@pegma/storage-core";
import type { Ticket } from "@pegma/support-desk-contracts";
import {
  SupportDeskAuthorizationError,
  SupportDeskConflictError,
  SupportDeskLimitError,
  SupportDeskNotFoundError,
  supportPermissions,
  type SupportDeskLimits,
  type SupportRecord,
} from "./index.js";
import {
  canonical,
  dataObject,
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
  resolutionLearningSourceKey,
  resolutionLearningWorkKey,
  validateResolutionCandidate,
  validateResolutionEvidence,
  validateResolutionProduct,
  validateResolutionRequest,
  validateResolutionTarget,
  type ResolutionLearningSourceRecord,
  type ResolutionLearningWorkRecord,
  type ResolvedResolutionLearningOptions,
} from "./resolution-learning-records.js";
import type {
  ResolutionEvidence,
  ResolutionLearningApplication,
  ResolutionLearningCommand,
  ResolutionLearningSourceResult,
  ResolutionProductContext,
  ResolutionTrustContext,
} from "./resolution-learning-types.js";

type Action = Parameters<CollectionStore<SupportRecord>["transact"]>[1][number];
type TicketVersion = VersionedRecord<
  Extract<SupportRecord, { kind: "ticket" }>
>;
type SourceVersion = VersionedRecord<ResolutionLearningSourceRecord>;
interface Dependencies {
  readonly records: CollectionStore<SupportRecord>;
  readonly clock: Clock;
  readonly limits: SupportDeskLimits;
  readonly options: ResolvedResolutionLearningOptions;
  readonly maxConflictAttempts: number;
  audit(
    command: ResolutionLearningCommand,
    ticket: Ticket,
    actorId: string,
    now: string,
    action: string,
  ): Action;
  admission(
    ticket: Ticket,
    rows: readonly SupportRecord[],
    additional: number,
  ): void;
  withdrawalAdmission(
    ticket: Ticket,
    rows: readonly SupportRecord[],
    additional: number,
  ): void;
}
const terminal = (ticket: Ticket): boolean =>
  ticket.status === "resolved" || ticket.status === "closed";
const result = (
  source: ResolutionLearningSourceRecord,
): ResolutionLearningSourceResult => ({
  ticketId: source.ticketId,
  sourceGeneration: source.sourceGeneration,
  resolutionCycle: source.resolutionCycle,
  state: source.state,
  ...(source.heldReason === undefined ? {} : { heldReason: source.heldReason }),
});
function permission(access: AccessContext, name: string, staff = false): void {
  text(access.principalId, "principalId");
  if (!hasPermission(access, name))
    throw new SupportDeskAuthorizationError(name);
  if (staff && !hasPermission(access, supportPermissions.queueRead))
    throw new SupportDeskAuthorizationError(supportPermissions.queueRead);
}
function boundedRecord(
  row: ResolutionLearningSourceRecord | ResolutionLearningWorkRecord,
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
function sourceAction(
  source: SourceVersion,
  next: ResolutionLearningSourceRecord,
): Action {
  boundedRecord(next);
  return { action: "putIfUnchanged", version: source.version, value: next };
}
export async function createResolutionLearningSource(
  ticket: Ticket,
): Promise<ResolutionLearningSourceRecord> {
  const row: ResolutionLearningSourceRecord = {
    kind: "resolution_learning_source",
    partition: ticket.id,
    id: "learning-source",
    ticketId: ticket.id,
    sourceId: await fingerprint({
      system: "pegma.support-desk",
      ticketId: ticket.id,
    }),
    resolutionCycle: 1,
    sourceGeneration: 0,
    workGeneration: 1,
    generationCount: 0,
    reviewBindingCount: 0,
    state: "unverified",
    createdAt: ticket.createdAt,
    updatedAt: ticket.updatedAt,
    destinations: [],
    reconciliationPending: false,
  };
  boundedRecord(row);
  return row;
}
export async function readResolutionSource(
  records: CollectionStore<SupportRecord>,
  ticketId: string,
): Promise<SourceVersion | null> {
  const stored = await records.getVersioned(
    resolutionLearningSourceKey(ticketId),
  );
  if (stored === null) return null;
  if (stored.value.kind !== "resolution_learning_source")
    throw new SupportDeskConflictError(
      "Learning source key contains another record",
    );
  return { value: stored.value, version: stored.version };
}

/** Always runs for existing enrollment, independent of current configuration. */
export async function planResolutionLearningTicketMutation(
  records: CollectionStore<SupportRecord>,
  before: TicketVersion,
  after: Ticket,
): Promise<{
  readonly actions: readonly Action[];
  readonly additionalRows: number;
  readonly source: SourceVersion | null;
}> {
  const source = await readResolutionSource(records, after.id);
  const ticketAction: Action = {
    action: "putIfUnchanged",
    version: before.version,
    value: { ...before.value, ticket: after },
  };
  if (source === null || !terminal(before.value.ticket) || terminal(after))
    return { actions: [ticketAction], additionalRows: 0, source };
  const next: ResolutionLearningSourceRecord = {
    ...source.value,
    resolutionCycle: source.value.resolutionCycle + 1,
    sourceGeneration: source.value.sourceGeneration + 1,
    workGeneration: source.value.workGeneration + 1,
    state: source.value.state === "withdrawn" ? "withdrawn" : "held",
    heldReason:
      source.value.state === "withdrawn"
        ? (source.value.heldReason ?? "withdrawn")
        : "reopened",
    updatedAt: after.updatedAt,
    reconciliationPending: source.value.destinations.length > 0,
    destinations: source.value.destinations.map((entry) => ({
      ...entry,
      reconciliation: "pending" as const,
    })),
  };
  return {
    actions: [ticketAction, sourceAction(source, next)],
    additionalRows: 0,
    source: { value: next, version: source.version },
  };
}

async function trustedWait<T>(
  milliseconds: number,
  invoke: (signal: AbortSignal) => Promise<T>,
): Promise<T | null> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => invoke(controller.signal)),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => {
          controller.abort();
          resolve(null);
        }, milliseconds);
      }),
    ]);
  } catch {
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
function heldSource(
  source: ResolutionLearningSourceRecord,
  now: string,
  reason: string,
  pending?: string,
): ResolutionLearningSourceRecord {
  return {
    ...source,
    state:
      source.state === "eligible"
        ? "eligible"
        : source.state === "withdrawn"
          ? "withdrawn"
          : "held",
    heldReason:
      source.state === "withdrawn" ? (source.heldReason ?? reason) : reason,
    updatedAt: now,
    workGeneration: source.workGeneration + 1,
    ...(pending === undefined ? {} : { pendingProofReference: pending }),
  };
}
async function evidencePlan(
  deps: Dependencies,
  stored: SourceVersion,
  ticket: Ticket,
  evidence: ResolutionEvidence,
  now: string,
  product: ResolutionProductContext | null,
  pending: string,
  capacity: boolean,
  rows: readonly SupportRecord[],
): Promise<{
  readonly actions: readonly Action[];
  readonly source: ResolutionLearningSourceRecord;
  readonly additionalRows: number;
}> {
  const source = stored.value;
  const hold = (reason: string) => {
    const next = heldSource(source, now, reason, pending);
    return {
      actions: [sourceAction(stored, next)],
      source: next,
      additionalRows: 0,
    };
  };
  if (source.state === "withdrawn") return hold("withdrawn");
  const workingSolutionMessageIds =
    evidence.kind === "customer_confirmation"
      ? rows
          .filter(
            (row): row is Extract<SupportRecord, { kind: "message" }> =>
              row.kind === "message" &&
              row.message.visibility === "customer" &&
              (row.message.authorKind === "staff" ||
                row.message.authorKind === "assistant") &&
              row.ordinal <= ticket.revision,
          )
          .sort((a, b) => b.ordinal - a.ordinal)
          .slice(0, 1)
          .map((row) => row.message.id)
      : [evidence.solutionMessageId];
  if (
    workingSolutionMessageIds.length === 0 &&
    evidence.kind === "customer_confirmation"
  )
    workingSolutionMessageIds.push(evidence.lastVisibleMessageId);
  if (product === null) return hold("product_context_unavailable");
  validateResolutionProduct(product);
  validateResolutionEvidence(evidence);
  if (
    timestamp(product.verifiedAt, "product.verifiedAt") >
      timestamp(now, "acceptedAt") ||
    timestamp(product.validUntil, "product.validUntil") <
      timestamp(now, "acceptedAt")
  )
    return hold("product_context_unverified");
  const stableEvidence =
    evidence.kind === "customer_confirmation"
      ? {
          kind: evidence.kind,
          actorId: evidence.actorId,
          lastVisibleMessageId: evidence.lastVisibleMessageId,
        }
      : evidence.kind === "staff_verified_fix"
        ? {
            kind: evidence.kind,
            actorId: evidence.actorId,
            solutionMessageId: evidence.solutionMessageId,
            verificationReference: evidence.verificationReference,
          }
        : {
            kind: evidence.kind,
            actorId: evidence.actorId,
            solutionMessageId: evidence.solutionMessageId,
            executionId: evidence.test.executionId,
            runnerId: evidence.test.runnerId,
            testId: evidence.test.testId,
            productBinding: evidence.test.productBinding,
          };
  const stableProduct = {
    productId: product.productId,
    version: product.version,
    buildId: product.buildId,
    binding: product.binding,
  };
  const proofIdentity = await fingerprint({
    resolutionCycle: source.resolutionCycle,
    evidence: stableEvidence,
    product: stableProduct,
  });
  if (source.state === "eligible" && source.proofIdentity === proofIdentity)
    return { actions: [], source, additionalRows: 0 };
  if (!capacity || source.generationCount >= deps.options.maxGenerations)
    return hold("learning_capacity");
  const sourceGeneration = source.sourceGeneration + 1;
  const evidenceFingerprint = await fingerprint(stableEvidence);
  const productContextFingerprint = await fingerprint(stableProduct);
  const sourceBindingHash = await fingerprint({
    ticketId: ticket.id,
    resolutionCycle: source.resolutionCycle,
    sourceGeneration,
    evidenceFingerprint,
    productContextFingerprint,
  });
  const {
    pendingProofReference: _pending,
    heldReason: _held,
    ...base
  } = source;
  const next: ResolutionLearningSourceRecord = {
    ...base,
    sourceGeneration,
    workGeneration: source.workGeneration + 1,
    generationCount: source.generationCount + 1,
    state: "eligible",
    updatedAt: now,
    resolvedAt: ticket.resolvedAt!,
    acceptedTicketRevision: ticket.revision,
    proofIdentity,
    sourceBindingHash,
    evidenceFingerprint,
    productContextFingerprint,
    evidence,
    product,
    reconciliationPending: source.destinations.length > 0,
    destinations: source.destinations.map((entry) => ({
      ...entry,
      reconciliation: "pending" as const,
    })),
  };
  const work: ResolutionLearningWorkRecord = {
    kind: "resolution_learning_work",
    partition: ticket.id,
    id: resolutionLearningWorkKey(ticket.id, sourceGeneration).id,
    ticketId: ticket.id,
    sourceGeneration,
    resolutionCycle: source.resolutionCycle,
    sourceBindingHash,
    workGeneration: 1,
    acceptedTicketRevision: ticket.revision,
    workingSolutionMessageIds,
    createdAt: now,
    deadline: new Date(
      timestamp(now, "now") + deps.options.maxWorkMilliseconds,
    ).toISOString(),
    evidence,
    product,
    status: "pending",
    stage: "model",
    modelAttempts: [],
    claimGeneration: 0,
  };
  try {
    boundedRecord(next);
    boundedRecord(work);
  } catch (error) {
    if (error instanceof SupportDeskLimitError)
      return hold("learning_capacity");
    throw error;
  }
  return {
    actions: [sourceAction(stored, next), { action: "insert", value: work }],
    source: next,
    additionalRows: 1,
  };
}

export function createResolutionLearningServices(deps: Dependencies): {
  readonly application: ResolutionLearningApplication;
  customerConfirmation(
    source: SourceVersion | null,
    ticket: Ticket,
    actorId: string,
    lastVisibleMessageId: string,
    commandId: string,
    rows: readonly SupportRecord[],
  ): Promise<{
    readonly actions: readonly Action[];
    readonly additionalRows: number;
  }>;
} {
  const { records, options, clock } = deps;
  async function load(ticketId: string): Promise<{
    ticket: TicketVersion;
    source: SourceVersion;
    rows: readonly SupportRecord[];
  }> {
    text(ticketId, "ticketId");
    const ticket = await records.getVersioned({
      partition: ticketId,
      id: "ticket",
    });
    if (ticket?.value.kind !== "ticket") throw new SupportDeskNotFoundError();
    const source = await readResolutionSource(records, ticketId);
    if (source === null) throw new SupportDeskNotFoundError();
    const rows = await records.list(ticketId);
    if (rows.length > deps.limits.maxRecordsPerTicket)
      throw new SupportDeskLimitError(
        "ticket_partition",
        deps.limits.maxRecordsPerTicket,
      );
    return {
      ticket: { value: ticket.value, version: ticket.version },
      source,
      rows,
    };
  }
  async function context(
    ticket: Ticket,
    source: ResolutionLearningSourceRecord,
    actorId: string,
    now: string,
  ): Promise<{
    product: ResolutionProductContext | null;
    trust: ResolutionTrustContext;
  }> {
    const trust: ResolutionTrustContext = {
      ticketId: ticket.id,
      ticketRevision: ticket.revision,
      resolutionCycle: source.resolutionCycle,
      resolvedAt: ticket.resolvedAt!,
      actorId,
      acceptedAt: now,
    };
    const product =
      options.productContext === undefined
        ? null
        : await trustedWait(options.trustTimeoutMilliseconds, (signal) =>
            options.productContext!.resolve(trust, signal),
          );
    if (product !== null) {
      try {
        validateResolutionProduct(product);
        return { product: snapshot(product), trust };
      } catch {
        return { product: null, trust };
      }
    }
    return { product: null, trust };
  }
  function room(
    ticket: Ticket,
    rows: readonly SupportRecord[],
    extra: number,
  ): boolean {
    try {
      deps.admission(ticket, rows, extra);
      return true;
    } catch (error) {
      if (error instanceof SupportDeskLimitError) return false;
      throw error;
    }
  }
  async function commandFingerprint(
    command: ResolutionLearningCommand,
    actorId: string,
    operation: string,
  ): Promise<string> {
    return fingerprint({ operation, actorId, command });
  }
  function receipt(
    command: ResolutionLearningCommand,
    hash: string,
    outcome: ResolutionLearningSourceResult,
  ): Action {
    return {
      action: "insert",
      value: {
        kind: "resolution_learning_receipt",
        partition: command.ticketId,
        id: `learning-command:${command.commandId}`,
        fingerprint: hash,
        result: outcome,
      },
    };
  }
  async function replay(
    command: ResolutionLearningCommand,
    hash: string,
  ): Promise<ResolutionLearningSourceResult | null> {
    const found = await records.get({
      partition: command.ticketId,
      id: `learning-command:${command.commandId}`,
    });
    if (found === null) return null;
    if (
      found.kind !== "resolution_learning_receipt" ||
      found.fingerprint !== hash
    )
      throw new SupportDeskConflictError("Learning command ID reused");
    return snapshot(found.result);
  }
  function validateCommand(command: ResolutionLearningCommand): void {
    text(command.ticketId, "ticketId");
    text(command.commandId, "commandId");
    text(command.correlationId, "correlationId");
  }
  async function reconciliationView(ticketId: string) {
    for (let attempt = 0; attempt < deps.maxConflictAttempts; attempt += 1) {
      const source = await readResolutionSource(records, ticketId);
      if (source === null) throw new SupportDeskNotFoundError();
      const destinations = await Promise.all(
        source.value.destinations.map(async (destination) => {
          const stored = await records.get(
            resolutionLearningWorkKey(ticketId, destination.sourceGeneration),
          );
          const work =
            stored?.kind === "resolution_learning_work" ? stored : null;
          const request = work?.exactRequest ?? work?.withdrawnRequest;
          if (
            work === null ||
            request === undefined ||
            work.ticketId !== ticketId ||
            work.sourceGeneration !== destination.sourceGeneration ||
            work.stepId !== destination.stepId ||
            work.requestHash !== destination.requestHash ||
            request.articleId !== destination.articleId
          )
            return {
              ...snapshot(destination),
              requestIdentity: null,
              requestIdentityStatus: "unavailable" as const,
            };
          return {
            ...snapshot(destination),
            requestIdentityStatus: "available" as const,
            requestIdentity: {
              operation: request.operation,
              commandId: request.commandId,
              articleId: request.articleId,
              originalExpectedGeneration: request.originalExpectedGeneration,
            },
          };
        }),
      );
      const latest = await readResolutionSource(records, ticketId);
      if (latest?.version !== source.version) continue;
      return {
        ticketId,
        sourceGeneration: source.value.sourceGeneration,
        sourceWorkGeneration: source.value.workGeneration,
        state: source.value.state,
        reconciliationPending: source.value.reconciliationPending,
        destinations,
      };
    }
    throw new SupportDeskConflictError(
      "Source changed during reconciliation read",
    );
  }
  async function invalidate(
    access: AccessContext,
    input: ResolutionLearningCommand & { readonly reason: string },
    privacy: boolean,
  ): Promise<ResolutionLearningSourceResult> {
    permission(access, supportPermissions.learningWithdraw, true);
    const command = snapshot(
      fields(input, "source invalidation", [
        "ticketId",
        "commandId",
        "correlationId",
        "reason",
      ]),
    ) as unknown as typeof input;
    validateCommand(command);
    const reasons = privacy
      ? ["privacy_withdrawal", "source_access_revoked", "source_deleted"]
      : ["evidence_revoked", "product_binding_revoked", "check_policy_revoked"];
    if (!reasons.includes(command.reason))
      throw new TypeError("invalid source invalidation reason");
    const hash = await commandFingerprint(
      command,
      access.principalId,
      privacy ? "withdraw" : "invalidate",
    );
    for (let attempt = 0; attempt < deps.maxConflictAttempts; attempt += 1) {
      const prior = await replay(command, hash);
      if (prior !== null) return prior;
      const { ticket, source, rows } = await load(command.ticketId);
      if (source.value.state === "withdrawn") return result(source.value);
      if (privacy) deps.withdrawalAdmission(ticket.value.ticket, rows, 2);
      else deps.admission(ticket.value.ticket, rows, 2);
      const now = clock.now();
      const {
        evidence: _e,
        product: _p,
        pendingProofReference: _pending,
        proofIdentity: _proof,
        evidenceFingerprint: _ef,
        productContextFingerprint: _pf,
        acceptedTicketRevision: _revision,
        resolvedAt: _resolved,
        sourceBindingHash: _binding,
        ...base
      } = source.value;
      const next: ResolutionLearningSourceRecord = {
        ...(privacy ? base : source.value),
        state: privacy ? "withdrawn" : "held",
        heldReason: command.reason,
        sourceGeneration: source.value.sourceGeneration + 1,
        workGeneration: source.value.workGeneration + 1,
        updatedAt: now,
        reconciliationPending: source.value.destinations.length > 0,
        destinations: source.value.destinations.map((entry) => ({
          ...entry,
          reconciliation: "pending" as const,
        })),
      };
      const actions: Action[] = [
        {
          action: "putIfUnchanged",
          version: ticket.version,
          value: ticket.value,
        },
        sourceAction(source, next),
      ];
      if (privacy) {
        for (const candidate of rows) {
          if (candidate.kind === "resolution_learning_review") {
            const review = await records.getVersioned({
              partition: command.ticketId,
              id: candidate.id,
            });
            if (review?.value.kind !== "resolution_learning_review")
              throw new SupportDeskConflictError();
            const { reason: _reason, ...minimalReview } = review.value;
            actions.push({
              action: "putIfUnchanged",
              version: review.version,
              value: {
                ...minimalReview,
                reviewerId: "withdrawn",
                decision: "reject",
              },
            });
          }
          if (candidate.kind !== "resolution_learning_work") continue;
          const current = await records.getVersioned({
            partition: command.ticketId,
            id: candidate.id,
          });
          if (current?.value.kind !== "resolution_learning_work")
            throw new SupportDeskConflictError();
          const {
            candidate: _c,
            evidence: _evidence,
            product: _product,
            exactRequest: _request,
            verifiedCheckReceipt: _checks,
            ...minimal
          } = current.value;
          const request =
            _request === undefined
              ? undefined
              : (({ draftPayload: _body, ...identity }) => identity)(_request);
          actions.push({
            action: "putIfUnchanged",
            version: current.version,
            value: {
              ...minimal,
              workingSolutionMessageIds: [],
              modelAttempts: [],
              usageTombstones:
                current.value.usageTombstones ??
                current.value.modelAttempts.map((entry) => ({
                  stepId: entry.stepId,
                  requestHash: entry.requestHash,
                  usageReservationId: entry.binding.usageReservationId,
                  accounting: entry.accounting,
                })),
              ...(request === undefined ? {} : { withdrawnRequest: request }),
              status: "held",
              heldReason: command.reason,
              workGeneration: minimal.workGeneration + 1,
            },
          });
        }
      }
      actions.push(
        deps.audit(
          command,
          ticket.value.ticket,
          access.principalId,
          now,
          privacy
            ? "support.learning.withdrawn"
            : "support.learning.evidence_invalidated",
        ),
        receipt(command, hash, result(next)),
      );
      if ((await records.transact(command.ticketId, actions)).committed)
        return result(next);
    }
    const prior = await replay(command, hash);
    if (prior !== null) return prior;
    throw new SupportDeskConflictError();
  }
  const application: ResolutionLearningApplication = {
    async enrollResolutionLearning(access, input) {
      permission(access, supportPermissions.learningEvidenceSubmit, true);
      const command = snapshot(
        fields(input, "enroll command", [
          "ticketId",
          "commandId",
          "correlationId",
          "expectedRevision",
        ]),
      ) as unknown as typeof input;
      validateCommand(command);
      integer(command.expectedRevision, "expectedRevision", 1);
      const hash = await commandFingerprint(
        command,
        access.principalId,
        "enroll",
      );
      for (let attempt = 0; attempt < deps.maxConflictAttempts; attempt += 1) {
        const previous = await replay(command, hash);
        if (previous !== null) return previous;
        const ticket = await records.getVersioned({
          partition: command.ticketId,
          id: "ticket",
        });
        if (ticket?.value.kind !== "ticket")
          throw new SupportDeskNotFoundError();
        const source = await readResolutionSource(records, command.ticketId);
        if (source !== null) return result(source.value);
        if (!options.enabled)
          throw new SupportDeskConflictError("Learning enrollment disabled");
        if (ticket.value.ticket.revision !== command.expectedRevision)
          throw new SupportDeskConflictError("Ticket revision changed");
        const rows = await records.list(command.ticketId);
        const created = await createResolutionLearningSource(
          ticket.value.ticket,
        );
        deps.admission(ticket.value.ticket, [...rows, created], 2);
        if (
          (
            await records.transact(command.ticketId, [
              {
                action: "putIfUnchanged",
                version: ticket.version,
                value: ticket.value,
              },
              { action: "insert", value: created },
              deps.audit(
                command,
                ticket.value.ticket,
                access.principalId,
                clock.now(),
                "support.learning.enrolled",
              ),
              receipt(command, hash, result(created)),
            ])
          ).committed
        )
          return result(created);
      }
      throw new SupportDeskConflictError();
    },
    async submitResolutionEvidence(access, input) {
      permission(access, supportPermissions.learningEvidenceSubmit, true);
      const command = snapshot(
        fields(input, "evidence command", [
          "ticketId",
          "commandId",
          "correlationId",
          "expectedRevision",
          "resolutionCycle",
          "evidence",
        ]),
      ) as unknown as typeof input;
      validateCommand(command);
      integer(command.expectedRevision, "expectedRevision", 1);
      integer(command.resolutionCycle, "resolutionCycle", 1);
      const raw = dataObject(command.evidence, "evidence input");
      if (raw.kind === "staff_verified_fix")
        fields(raw, "staff proof", [
          "kind",
          "solutionMessageId",
          "verificationReference",
        ]);
      else if (raw.kind === "successful_test")
        fields(raw, "test proof", ["kind", "solutionMessageId", "receipt"]);
      else throw new TypeError("invalid evidence kind");
      text(raw.solutionMessageId, "solutionMessageId");
      text(
        raw.kind === "staff_verified_fix"
          ? raw.verificationReference
          : raw.receipt,
        "verification reference",
      );
      const hash = await commandFingerprint(
        command,
        access.principalId,
        "evidence",
      );
      for (let attempt = 0; attempt < deps.maxConflictAttempts; attempt += 1) {
        const previous = await replay(command, hash);
        if (previous !== null) return previous;
        const {
          ticket: versioned,
          source,
          rows,
        } = await load(command.ticketId);
        const ticket = versioned.value.ticket;
        if (
          ticket.revision !== command.expectedRevision ||
          source.value.resolutionCycle !== command.resolutionCycle ||
          !terminal(ticket) ||
          ticket.resolvedAt === undefined
        )
          throw new SupportDeskConflictError("Resolution fence changed");
        const solution = rows.find(
          (row) =>
            row.kind === "message" &&
            row.message.id === raw.solutionMessageId &&
            row.message.visibility === "customer" &&
            row.ordinal <= ticket.revision,
        );
        if (solution === undefined)
          throw new SupportDeskConflictError(
            "Visible solution message missing",
          );
        const now = clock.now();
        const trusted = await context(
          ticket,
          source.value,
          access.principalId,
          now,
        );
        let evidence: ResolutionEvidence | null = null;
        if (command.evidence.kind === "staff_verified_fix")
          evidence = { ...command.evidence, actorId: access.principalId };
        else if (
          trusted.product !== null &&
          options.testReceipts !== undefined
        ) {
          const test = await trustedWait(
            options.trustTimeoutMilliseconds,
            (signal) =>
              options.testReceipts!.verify(
                command.evidence.kind === "successful_test"
                  ? command.evidence.receipt
                  : "",
                { ...trusted.trust, product: trusted.product! },
                signal,
              ),
          );
          if (test !== null) {
            const proposed: ResolutionEvidence = {
              kind: "successful_test",
              actorId: access.principalId,
              solutionMessageId: command.evidence.solutionMessageId,
              test,
            };
            try {
              validateResolutionEvidence(proposed);
              if (
                test.productBinding === trusted.product.binding &&
                timestamp(test.verifiedAt, "test.verifiedAt") <=
                  timestamp(now, "acceptedAt") &&
                timestamp(test.validUntil, "test.validUntil") >=
                  timestamp(now, "acceptedAt") &&
                timestamp(test.executedAt, "executedAt") <=
                  timestamp(now, "acceptedAt")
              )
                evidence = snapshot(proposed);
            } catch {
              /* Untrusted receipt cannot qualify. */
            }
          }
        }
        deps.admission(ticket, rows, 2);
        const plan =
          evidence === null
            ? {
                source: heldSource(
                  source.value,
                  now,
                  "test_receipt_unverified",
                  command.commandId,
                ),
                actions: [] as readonly Action[],
                additionalRows: 0,
              }
            : await evidencePlan(
                deps,
                source,
                ticket,
                evidence,
                now,
                trusted.product,
                command.commandId,
                room(ticket, rows, 3),
                rows,
              );
        const actions: Action[] = [
          {
            action: "putIfUnchanged",
            version: versioned.version,
            value: versioned.value,
          },
          ...(evidence === null
            ? [sourceAction(source, plan.source)]
            : plan.actions),
          deps.audit(
            command,
            ticket,
            access.principalId,
            now,
            "support.learning.evidence_recorded",
          ),
          receipt(command, hash, result(plan.source)),
        ];
        if ((await records.transact(command.ticketId, actions)).committed)
          return result(plan.source);
      }
      const previous = await replay(command, hash);
      if (previous !== null) return previous;
      throw new SupportDeskConflictError();
    },
    async readResolutionLearningSource(access, ticketId) {
      permission(access, supportPermissions.learningRead, true);
      return snapshot((await load(ticketId)).source.value);
    },
    async readResolutionLearningWork(access, key) {
      permission(access, supportPermissions.learningRead, true);
      await load(key.ticketId);
      integer(key.sourceGeneration, "sourceGeneration", 1);
      const work = await records.get(
        resolutionLearningWorkKey(key.ticketId, key.sourceGeneration),
      );
      if (work?.kind !== "resolution_learning_work")
        throw new SupportDeskNotFoundError();
      return snapshot(work);
    },
    invalidateResolutionEvidence: (access, command) =>
      invalidate(access, command, false),
    withdrawResolutionLearningSource: (access, command) =>
      invalidate(access, command, true),
    ...createResolutionLearningWorkerServices(deps, load),
    async readResolutionLearningReconciliation(access, ticketId) {
      permission(access, supportPermissions.learningProcess);
      text(ticketId, "ticketId");
      return reconciliationView(ticketId);
    },
    async recordResolutionLearningReconciliation(access, input, guard) {
      permission(access, supportPermissions.learningProcess);
      if (typeof guard !== "function")
        throw new TypeError(
          "Reconciliation requires current full-provenance confirmation",
        );
      const command = snapshot(
        fields(
          input,
          "reconciliation command",
          [
            "ticketId",
            "expectedSourceGeneration",
            "expectedSourceWorkGeneration",
            "articleId",
            "stepId",
            "requestHash",
            "disposition",
          ],
          ["proof"],
        ),
      ) as unknown as typeof input;
      for (const name of [
        "ticketId",
        "articleId",
        "stepId",
        "requestHash",
      ] as const)
        text(command[name], name);
      integer(command.expectedSourceGeneration, "expectedSourceGeneration", 0);
      integer(
        command.expectedSourceWorkGeneration,
        "expectedSourceWorkGeneration",
        1,
      );
      if (
        ![
          "blocked",
          "retired",
          "unaffected_publication",
          "write_rejected",
        ].includes(command.disposition)
      )
        throw new TypeError("Invalid reconciliation disposition");
      if (command.disposition !== "blocked" && command.proof === undefined)
        throw new TypeError(
          "Terminal reconciliation needs authoritative receipt, cancellation, or revision fence",
        );
      if (command.proof !== undefined) {
        const proof = fields(command.proof, "reconciliation proof", [
          "kind",
          "binding",
        ]);
        if (
          ![
            "terminal_receipt",
            "revision_fence",
            "trusted_cancellation",
          ].includes(proof.kind as string)
        )
          throw new TypeError("Invalid reconciliation proof");
        text(proof.binding, "proof.binding");
      }
      const hash = await fingerprint(command);
      for (let attempt = 0; attempt < deps.maxConflictAttempts; attempt += 1) {
        const source = await readResolutionSource(records, command.ticketId);
        if (source === null) throw new SupportDeskNotFoundError();
        if (source.value.sourceGeneration !== command.expectedSourceGeneration)
          throw new SupportDeskConflictError(
            "Source generation changed during reconciliation",
          );
        const destination = source.value.destinations.find(
          (entry) =>
            entry.articleId === command.articleId &&
            entry.stepId === command.stepId &&
            entry.requestHash === command.requestHash,
        );
        if (destination === undefined)
          throw new SupportDeskConflictError(
            "Reconciliation destination changed",
          );
        if (command.disposition !== "blocked") {
          const projected = await reconciliationView(command.ticketId);
          if (
            projected.sourceGeneration !== source.value.sourceGeneration ||
            projected.sourceWorkGeneration !== source.value.workGeneration
          )
            continue;
          if (
            projected.destinations.find(
              (entry) => entry.articleId === command.articleId,
            )?.requestIdentityStatus !== "available"
          )
            throw new SupportDeskConflictError(
              "Reconciliation request identity unavailable",
            );
        }
        if (destination.lastReconciliation?.fingerprint === hash) {
          await guard();
          return reconciliationView(command.ticketId);
        }
        if (
          source.value.workGeneration !== command.expectedSourceWorkGeneration
        )
          throw new SupportDeskConflictError(
            "Source reconciliation version changed",
          );
        const destinations = source.value.destinations.map((entry) =>
          entry !== destination
            ? entry
            : {
                ...entry,
                reconciliation:
                  command.disposition === "blocked"
                    ? ("blocked" as const)
                    : ("confirmed" as const),
                lastReconciliation: {
                  fingerprint: hash,
                  disposition: command.disposition,
                  observedAt: clock.now(),
                  ...(command.proof === undefined
                    ? {}
                    : { proof: command.proof }),
                },
              },
        );
        const next: ResolutionLearningSourceRecord = {
          ...source.value,
          workGeneration: source.value.workGeneration + 1,
          destinations,
          reconciliationPending: destinations.some(
            (entry) => entry.reconciliation !== "confirmed",
          ),
        };
        boundedRecord(next);
        await guard();
        if (
          (
            await records.transact(command.ticketId, [
              sourceAction(source, next),
            ])
          ).committed
        )
          return reconciliationView(command.ticketId);
      }
      throw new SupportDeskConflictError();
    },
    async confirmResolutionLearningSource(access, fence) {
      permission(access, supportPermissions.learningProcess);
      try {
        const { ticket, source } = await load(fence.ticketId);
        const latest = await readResolutionSource(records, fence.ticketId);
        return (
          latest?.version === source.version &&
          terminal(ticket.value.ticket) &&
          source.value.state === "eligible" &&
          source.value.sourceGeneration === fence.sourceGeneration &&
          source.value.resolutionCycle === fence.resolutionCycle &&
          source.value.sourceBindingHash === fence.sourceBindingHash &&
          source.value.resolvedAt === ticket.value.ticket.resolvedAt
        );
      } catch (error) {
        if (error instanceof SupportDeskNotFoundError) return false;
        throw error;
      }
    },
    async confirmResolutionLearningTargetReview(access, command) {
      permission(access, supportPermissions.learningProcess);
      validateResolutionTarget(command.target);
      text(command.policyVersion, "policyVersion");
      try {
        const { ticket, source } = await load(command.ticketId);
        if (
          !terminal(ticket.value.ticket) ||
          source.value.state !== "eligible" ||
          source.value.resolvedAt !== ticket.value.ticket.resolvedAt
        )
          return false;
        const review = await records.get(
          await resolutionLearningReviewKey(
            source.value,
            command.target,
            command.policyVersion,
          ),
        );
        const latest = await readResolutionSource(records, command.ticketId);
        return (
          latest?.version === source.version &&
          review?.kind === "resolution_learning_review" &&
          review.sourceGeneration === source.value.sourceGeneration &&
          review.sourceBindingHash === source.value.sourceBindingHash &&
          review.decision === "approve" &&
          review.policyVersion === command.policyVersion &&
          canonical(review.target) === canonical(command.target)
        );
      } catch (error) {
        if (error instanceof SupportDeskNotFoundError) return false;
        throw error;
      }
    },
  };
  return {
    application,
    async customerConfirmation(
      source,
      ticket,
      actorId,
      lastVisibleMessageId,
      commandId,
      rows,
    ) {
      if (source === null) return { actions: [], additionalRows: 0 };
      const trusted = await context(
        ticket,
        source.value,
        actorId,
        ticket.updatedAt,
      );
      const humanTail =
        (ticket.firstStaffRespondedAt === undefined &&
        rows.some(
          (row) => row.kind === "ticket_quota" && row.assistantManaged === true,
        )
          ? 4
          : 0) + (source.value.state === "withdrawn" ? 0 : 2);
      const plan = await evidencePlan(
        deps,
        source,
        ticket,
        { kind: "customer_confirmation", actorId, lastVisibleMessageId },
        ticket.updatedAt,
        trusted.product,
        `success:${commandId}`,
        rows.length + 4 <= deps.limits.maxRecordsPerTicket - humanTail,
        rows,
      );
      return { actions: plan.actions, additionalRows: plan.additionalRows };
    },
  };
}

import { createResolutionLearningWorkerServices } from "./resolution-learning-worker.js";
export type {
  Dependencies as ResolutionLearningDependencies,
  TicketVersion,
  SourceVersion,
};
