import { hasPermission, type AccessContext } from "@pegma/authorization-core";
import type { Clock } from "@pegma/spine";
import type { CollectionStore } from "@pegma/storage-core";
import type { Ticket } from "@pegma/support-desk-contracts";
import {
  SupportDeskAuthorizationError,
  SupportDeskConflictError,
  SupportDeskLimitError,
  SupportDeskNotFoundError,
  supportPermissions,
  type SupportRecord,
} from "./index.js";
import {
  fields,
  fingerprint,
  integer,
  timestamp,
  text,
} from "./assistant-turn-records.js";
import {
  checkEngineeringRecordCapacity,
  advanceEngineeringFollowupRevocationEpoch,
  createEngineeringSource,
  engineeringCommandKey,
  engineeringSourceKey,
  engineeringWorkKey,
  safeEngineeringSnapshot as snapshot,
  validateEngineeringEvidence,
  validateEngineeringEvidenceInput,
  validateEngineeringProduct,
  type EngineeringDestination,
  type EngineeringSourceRecord,
  type EngineeringWorkRecord,
} from "./engineering-records.js";
import type {
  EngineeringAction,
  EngineeringDependencies,
  EngineeringLoaded,
  EngineeringLoader,
  EngineeringSourceVersion,
  EngineeringTicketVersion,
} from "./engineering-internal.js";
import { projectEngineeringRows } from "./engineering-internal.js";
import type {
  EngineeringApplication,
  EngineeringCommand,
  EngineeringEvidence,
  EngineeringIssueAcknowledgement,
  EngineeringMismatch,
  EngineeringProductContext,
  EngineeringSecurity,
  EngineeringSourceResult,
  EngineeringTrustContext,
  InvalidateEngineeringSourceCommand,
  SubmitEngineeringEvidenceCommand,
  WithdrawEngineeringSourceCommand,
} from "./engineering-types.js";

type EvidenceMethods = Pick<
  EngineeringApplication,
  | "enrollEngineeringSource"
  | "submitEngineeringEvidence"
  | "invalidateEngineeringSource"
  | "withdrawEngineeringSource"
  | "readEngineeringSource"
  | "readEngineeringWork"
>;

class EngineeringTrustUnavailable extends Error {}

/** One original clock/elapsed-time budget covers every awaited trust port. */
function trustWindow(clock: Clock, milliseconds: number) {
  const started = performance.now();
  const initial = timestamp(clock.now(), "now");
  const controller = new AbortController();
  const now = (): number =>
    Math.max(
      timestamp(clock.now(), "now"),
      initial + performance.now() - started,
    );
  const remaining = (): number => initial + milliseconds - now();
  const ensure = (): void => {
    if (controller.signal.aborted || remaining() <= 0)
      throw new EngineeringTrustUnavailable();
  };
  return {
    now,
    close: () => controller.abort(),
    async within<T>(action: (signal: AbortSignal) => Promise<T>): Promise<T> {
      ensure();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const value = await Promise.race([
          Promise.resolve().then(() => {
            ensure();
            return action(controller.signal);
          }),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => {
                controller.abort();
                reject(new EngineeringTrustUnavailable());
              },
              Math.max(1, Math.ceil(remaining())),
            );
          }),
        ]);
        ensure();
        return value;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },
  };
}

function permission(
  access: AccessContext,
  name: string,
  actorId?: string,
): void {
  text(access.principalId, "principalId");
  if (actorId !== undefined && access.principalId !== actorId)
    throw new SupportDeskConflictError("Engineering actor changed");
  for (const required of [name, supportPermissions.queueRead])
    if (!hasPermission(access, required))
      throw new SupportDeskAuthorizationError(required);
}

function result(source: EngineeringSourceRecord): EngineeringSourceResult {
  return {
    ticketId: source.ticketId,
    sourceGeneration: source.sourceGeneration,
    state: source.state,
    security: source.security,
    ...(source.heldReason === undefined
      ? {}
      : { heldReason: source.heldReason }),
  };
}

function bounded(row: EngineeringSourceRecord | EngineeringWorkRecord): void {
  checkEngineeringRecordCapacity(row);
}

export async function readEngineeringSourceVersion(
  records: CollectionStore<SupportRecord>,
  ticketId: string,
): Promise<EngineeringSourceVersion | null> {
  const source = await records.getVersioned(engineeringSourceKey(ticketId));
  if (source === null) return null;
  if (source.value.kind !== "engineering_source")
    throw new SupportDeskConflictError(
      "Engineering source key contains another record",
    );
  return { value: source.value, version: source.version };
}

function sourceAction(
  source: EngineeringSourceVersion,
  next: EngineeringSourceRecord,
): EngineeringAction {
  bounded(next);
  return { action: "putIfUnchanged", version: source.version, value: next };
}

function withoutClaim(work: EngineeringWorkRecord) {
  const { claim: _claim, leaseUntil: _lease, retryAt: _retry, ...rest } = work;
  return rest;
}

function reconciliationAfterSourceChange(
  destination: EngineeringDestination,
): "confirmed" | "pending" {
  return destination.reconciliation === "confirmed" &&
    ["accepted", "confirmed_rejected"].includes(destination.outcome)
    ? "confirmed"
    : "pending";
}

/** Sensitivity survives workflow-status changes and retained-body transitions. */
function retainedWorkSecurity(
  work: EngineeringWorkRecord,
): EngineeringSecurity {
  if (
    work.status === "restricted" ||
    work.security === "restricted" ||
    work.candidate?.security === "restricted"
  )
    return "restricted";
  if (work.security === "uncertain" || work.candidate?.security === "uncertain")
    return "uncertain";
  return "ordinary";
}

function invalidatedWork(
  work: EngineeringWorkRecord,
  reason: string,
): EngineeringWorkRecord {
  const { approval: _approval, ...rest } = withoutClaim(work);
  const status =
    work.status === "accepted" || work.status === "confirmed_rejected"
      ? work.status
      : work.dispatch === undefined
        ? "superseded"
        : "unknown";
  return {
    ...rest,
    security: retainedWorkSecurity(work),
    status,
    ...(work.dispatch === undefined ? {} : { stage: "reconcile" as const }),
    heldReason: reason,
    workGeneration: work.workGeneration + 1,
  };
}

/** Persisted enrollment participates even when new engineering is disabled. */
export async function planEngineeringTicketMutation(
  records: CollectionStore<SupportRecord>,
  before: EngineeringTicketVersion,
  after: Ticket,
  hint: { readonly visibleChange: boolean },
): Promise<{
  readonly actions: readonly EngineeringAction[];
  readonly additionalRows: number;
}> {
  const source = await readEngineeringSourceVersion(records, after.id);
  const reopened =
    ["resolved", "closed"].includes(before.value.ticket.status) &&
    !["resolved", "closed"].includes(after.status);
  if (source === null || (!hint.visibleChange && !reopened))
    return { actions: [], additionalRows: 0 };
  const next: EngineeringSourceRecord = {
    ...source.value,
    sourceGeneration: source.value.sourceGeneration + 1,
    workGeneration: source.value.workGeneration + 1,
    state:
      source.value.state === "withdrawn"
        ? "withdrawn"
        : source.value.state === "restricted"
          ? "restricted"
          : "held",
    heldReason:
      source.value.state === "withdrawn"
        ? (source.value.heldReason ?? "withdrawn")
        : reopened
          ? "reopened"
          : "visible_source_changed",
    updatedAt: after.updatedAt,
    reconciliationPending: source.value.destinations.some(
      (destination) =>
        reconciliationAfterSourceChange(destination) !== "confirmed",
    ),
    destinations: source.value.destinations.map((destination) => ({
      ...destination,
      reconciliation: reconciliationAfterSourceChange(destination),
    })),
  };
  const actions: EngineeringAction[] = [sourceAction(source, next)];
  // Older generations already fail the source fence. Only this currently live
  // generation can retain a claim or approval invalidated by the ticket change.
  const work = await records.getVersioned(
    engineeringWorkKey(after.id, source.value.sourceGeneration),
  );
  if (work !== null) {
    if (work.value.kind !== "engineering_work")
      throw new SupportDeskConflictError();
    const changed = invalidatedWork(work.value, next.heldReason!);
    bounded(changed);
    actions.push({
      action: "putIfUnchanged",
      version: work.version,
      value: changed,
    });
  }
  return { actions, additionalRows: 0 };
}

function opaqueAcknowledgement(
  ack: EngineeringIssueAcknowledgement | undefined,
) {
  if (ack === undefined) return undefined;
  const { url: _url, ...identity } = ack;
  return identity;
}

function scrubbedWork(
  work: EngineeringWorkRecord,
  reason: string,
): EngineeringWorkRecord {
  const request =
    work.withdrawnRequest ??
    (work.proposal === undefined
      ? undefined
      : {
          operation: work.proposal.request.operation,
          repositoryId: work.proposal.request.repository.repositoryId,
          repositoryMetadataHash: work.proposal.repositoryMetadataHash,
          exportMarker: work.proposal.request.bundle.exportMarker,
          ...(work.proposal.request.operation === "link_existing_issue"
            ? {
                issueId: work.proposal.request.issueId,
                issueNumber: work.proposal.request.issueNumber,
              }
            : {}),
        });
  const acknowledgement = opaqueAcknowledgement(work.acknowledgement);
  const next: EngineeringWorkRecord = {
    kind: work.kind,
    partition: work.partition,
    id: work.id,
    ticketId: work.ticketId,
    sourceGeneration: work.sourceGeneration,
    sourceBindingHash: work.sourceBindingHash,
    workGeneration: work.workGeneration + 1,
    acceptedTicketRevision: work.acceptedTicketRevision,
    createdAt: work.createdAt,
    deadline: work.deadline,
    security: retainedWorkSecurity(work),
    status:
      work.status === "accepted" || work.status === "confirmed_rejected"
        ? work.status
        : work.dispatch === undefined
          ? "held"
          : "unknown",
    stage: work.dispatch === undefined ? work.stage : "reconcile",
    modelAttempts: [],
    claimGeneration: work.claimGeneration,
    proposalCount: work.proposalCount,
    heldReason: reason,
    terminalReserveRows: work.terminalReserveRows,
    usageTombstones:
      work.usageTombstones ??
      work.modelAttempts.map((attempt) => ({
        stepId: attempt.stepId,
        requestHash: attempt.requestHash,
        usageReservationId: attempt.binding.usageReservationId,
        accounting: attempt.accounting,
      })),
    ...(work.stepId === undefined ? {} : { stepId: work.stepId }),
    ...(work.requestHash === undefined
      ? {}
      : { requestHash: work.requestHash }),
    ...(work.dispatch === undefined ? {} : { dispatch: work.dispatch }),
    ...(acknowledgement === undefined ? {} : { acknowledgement }),
    ...(request === undefined ? {} : { withdrawnRequest: request }),
    ...(work.lastCompletion === undefined
      ? {}
      : { lastCompletion: work.lastCompletion }),
    ...(work.lastFinish === undefined ? {} : { lastFinish: work.lastFinish }),
    ...(work.lastDispatchResult === undefined
      ? {}
      : { lastDispatchResult: work.lastDispatchResult }),
  };
  bounded(next);
  return next;
}

function requiresSecurityReview(
  source: EngineeringSourceRecord,
  security: EngineeringSecurity,
): boolean {
  return (
    security === "ordinary" &&
    (source.state === "restricted" ||
      (source.security !== "ordinary" &&
        (source.evidence !== undefined || source.generationCount > 0)))
  );
}

function privateRead(
  access: AccessContext,
  security: EngineeringSecurity,
  actorId: string,
): void {
  permission(access, supportPermissions.engineeringRead, actorId);
  if (security !== "ordinary")
    permission(access, supportPermissions.engineeringRestrictedRead, actorId);
}

export function createEngineeringEvidenceServices(
  deps: EngineeringDependencies,
): {
  readonly application: EvidenceMethods;
  readonly load: EngineeringLoader;
} {
  const { records, clock, options } = deps;
  const load: EngineeringLoader = async (ticketId) => {
    text(ticketId, "ticketId");
    const ticket = await records.getVersioned({
      partition: ticketId,
      id: "ticket",
    });
    if (ticket?.value.kind !== "ticket") throw new SupportDeskNotFoundError();
    const source = await readEngineeringSourceVersion(records, ticketId);
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
  };
  function validateCommand(command: EngineeringCommand): void {
    for (const name of ["ticketId", "commandId", "correlationId"] as const)
      text(command[name], name);
  }
  function receipt(
    command: EngineeringCommand,
    hash: string,
    value: EngineeringSourceResult,
  ): EngineeringAction {
    return {
      action: "insert",
      value: {
        kind: "engineering_receipt",
        partition: command.ticketId,
        id: engineeringCommandKey(command.ticketId, command.commandId).id,
        fingerprint: hash,
        result: value,
      },
    };
  }
  async function replay(
    command: EngineeringCommand,
    hash: string,
  ): Promise<EngineeringSourceResult | null> {
    const stored = await records.get(
      engineeringCommandKey(command.ticketId, command.commandId),
    );
    if (stored === null) return null;
    if (
      stored.kind !== "engineering_receipt" ||
      stored.fingerprint !== hash ||
      !("state" in stored.result) ||
      !("security" in stored.result)
    )
      throw new SupportDeskConflictError("Engineering command identity reused");
    if (
      (await readEngineeringSourceVersion(records, command.ticketId)) === null
    )
      throw new SupportDeskNotFoundError();
    return snapshot(stored.result as EngineeringSourceResult);
  }
  async function replayAuthorized(
    access: AccessContext,
    name: string,
    actorId: string,
    command: EngineeringCommand,
    hash: string,
  ): Promise<EngineeringSourceResult | null> {
    permission(access, name, actorId);
    const previous = await replay(command, hash);
    permission(access, name, actorId);
    return previous;
  }
  const guardedTicket = (loaded: EngineeringLoaded): EngineeringAction => ({
    action: "putIfUnchanged",
    value: loaded.ticket.value,
    version: loaded.ticket.version,
  });

  async function invalidate(
    access: AccessContext,
    input:
      InvalidateEngineeringSourceCommand | WithdrawEngineeringSourceCommand,
    privacy: boolean,
  ): Promise<EngineeringSourceResult> {
    const name = privacy
      ? supportPermissions.engineeringWithdraw
      : supportPermissions.engineeringEvidenceSubmit;
    permission(access, name);
    const actorId = access.principalId;
    const command = snapshot(
      fields(input, "engineering invalidation", [
        "ticketId",
        "commandId",
        "correlationId",
        "reason",
      ]),
    ) as unknown as typeof input;
    validateCommand(command);
    if (
      !(
        privacy
          ? ["privacy_withdrawal", "source_access_revoked", "source_deleted"]
          : [
              "evidence_revoked",
              "product_binding_revoked",
              "check_policy_revoked",
            ]
      ).includes(command.reason)
    )
      throw new TypeError("Invalid engineering invalidation reason");
    const hash = await fingerprint({
      operation: privacy ? "withdraw" : "invalidate",
      actorId,
      command,
    });
    for (let attempt = 0; attempt < deps.maxConflictAttempts; attempt += 1) {
      const previous = await replayAuthorized(
        access,
        name,
        actorId,
        command,
        hash,
      );
      if (previous !== null) return previous;
      const loaded = await load(command.ticketId);
      if (loaded.source.value.state === "withdrawn") {
        permission(access, name, actorId);
        return result(loaded.source.value);
      }
      const source = loaded.source.value;
      const now = clock.now();
      const {
        evidence: _evidence,
        product: _product,
        proofIdentity: _proof,
        evidenceFingerprint: _evidenceHash,
        productContextFingerprint: _productHash,
        sourceBindingHash: _binding,
        acceptedTicketRevision: _revision,
        lastVisibleMessageId: _visible,
        pendingEvidenceReference: _pending,
        ...minimal
      } = source;
      const next: EngineeringSourceRecord = {
        ...(privacy ? minimal : source),
        state: privacy
          ? "withdrawn"
          : source.security === "ordinary"
            ? "held"
            : "restricted",
        heldReason: command.reason,
        sourceGeneration: source.sourceGeneration + 1,
        followupRevocationEpoch:
          advanceEngineeringFollowupRevocationEpoch(source),
        workGeneration: source.workGeneration + 1,
        updatedAt: now,
        destinations: source.destinations.map((entry) => {
          const acknowledgement = privacy
            ? opaqueAcknowledgement(entry.acknowledgement)
            : entry.acknowledgement;
          const {
            acknowledgement: _ack,
            lastReconciliation: last,
            ...identity
          } = entry;
          return {
            ...identity,
            reconciliation: reconciliationAfterSourceChange(entry),
            ...(acknowledgement === undefined ? {} : { acknowledgement }),
            ...(last === undefined
              ? {}
              : {
                  lastReconciliation: privacy
                    ? {
                        fingerprint: last.fingerprint,
                        outcome: last.outcome,
                        observedAt: last.observedAt,
                      }
                    : last,
                }),
          };
        }),
        reconciliationPending: source.destinations.some(
          (destination) =>
            reconciliationAfterSourceChange(destination) !== "confirmed",
        ),
      };
      const followup = await deps.planFollowupSourceChange({
        rows: loaded.rows,
        previousSource: source,
        nextSource: next,
        reason: privacy ? "withdrawal" : "explicit_revocation",
      });
      const plannedRows = projectEngineeringRows(
        loaded.rows,
        followup.nextWorkRows,
      );
      if (privacy)
        deps.withdrawalAdmission(loaded.ticket.value.ticket, plannedRows, 2);
      else deps.admission(loaded.ticket.value.ticket, plannedRows, 2);
      const actions: EngineeringAction[] = [
        guardedTicket(loaded),
        sourceAction(loaded.source, next),
        ...followup.actions,
      ];
      const workRows = loaded.rows.filter(
        (row) => row.kind === "engineering_work",
      );
      if (workRows.length > 8)
        throw new SupportDeskConflictError(
          "Engineering history exceeds its bound",
        );
      for (const row of workRows) {
        const work = await records.getVersioned({
          partition: command.ticketId,
          id: row.id,
        });
        if (work?.value.kind !== "engineering_work")
          throw new SupportDeskConflictError();
        const changed = privacy
          ? scrubbedWork(work.value, command.reason)
          : invalidatedWork(work.value, command.reason);
        bounded(changed);
        actions.push({
          action: "putIfUnchanged",
          version: work.version,
          value: changed,
        });
      }
      actions.push(
        deps.audit(
          command,
          loaded.ticket.value.ticket,
          actorId,
          now,
          privacy
            ? "support.engineering.withdrawn"
            : "support.engineering.evidence_invalidated",
        ),
        receipt(command, hash, result(next)),
      );
      permission(access, name, actorId);
      if ((await records.transact(command.ticketId, actions)).committed) {
        permission(access, name, actorId);
        return result(next);
      }
    }
    const previous = await replayAuthorized(
      access,
      name,
      actorId,
      command,
      hash,
    );
    if (previous !== null) return previous;
    throw new SupportDeskConflictError();
  }

  const application: EvidenceMethods = {
    async enrollEngineeringSource(access, input) {
      const name = supportPermissions.engineeringEvidenceSubmit;
      permission(access, name);
      const actorId = access.principalId;
      const command = snapshot(
        fields(input, "engineering enrollment", [
          "ticketId",
          "commandId",
          "correlationId",
          "expectedRevision",
        ]),
      ) as unknown as typeof input;
      validateCommand(command);
      integer(command.expectedRevision, "expectedRevision", 1);
      const hash = await fingerprint({ operation: "enroll", actorId, command });
      for (let attempt = 0; attempt < deps.maxConflictAttempts; attempt += 1) {
        const previous = await replayAuthorized(
          access,
          name,
          actorId,
          command,
          hash,
        );
        if (previous !== null) return previous;
        const ticket = await records.getVersioned({
          partition: command.ticketId,
          id: "ticket",
        });
        if (ticket?.value.kind !== "ticket")
          throw new SupportDeskNotFoundError();
        const existing = await readEngineeringSourceVersion(
          records,
          command.ticketId,
        );
        if (existing !== null) {
          permission(access, name, actorId);
          return result(existing.value);
        }
        if (!options.enabled)
          throw new SupportDeskConflictError("Engineering enrollment disabled");
        if (ticket.value.ticket.revision !== command.expectedRevision)
          throw new SupportDeskConflictError(
            "Engineering ticket revision changed",
          );
        const rows = await records.list(command.ticketId);
        const created = await createEngineeringSource(ticket.value.ticket);
        deps.admission(ticket.value.ticket, [...rows, created], 2);
        const now = clock.now();
        const actions: EngineeringAction[] = [
          {
            action: "putIfUnchanged",
            version: ticket.version,
            value: ticket.value,
          },
          { action: "insert", value: created },
          deps.audit(
            command,
            ticket.value.ticket,
            actorId,
            now,
            "support.engineering.enrolled",
          ),
          receipt(command, hash, result(created)),
        ];
        permission(access, name, actorId);
        if ((await records.transact(command.ticketId, actions)).committed) {
          permission(access, name, actorId);
          return result(created);
        }
      }
      const previous = await replayAuthorized(
        access,
        name,
        actorId,
        command,
        hash,
      );
      if (previous !== null) return previous;
      throw new SupportDeskConflictError();
    },

    async submitEngineeringEvidence(access, input) {
      const name = supportPermissions.engineeringEvidenceSubmit;
      permission(access, name);
      const actorId = access.principalId;
      const raw = fields(input, "engineering evidence command", [
        "ticketId",
        "commandId",
        "correlationId",
        "expectedRevision",
        "evidence",
        "security",
      ]);
      // Bound the closed mismatch before copying any caller-owned object graph.
      validateCommand(raw as unknown as EngineeringCommand);
      integer(raw.expectedRevision, "expectedRevision", 1);
      validateEngineeringEvidenceInput(raw.evidence);
      if (
        !["ordinary", "restricted", "uncertain"].includes(
          raw.security as string,
        )
      )
        throw new TypeError("Invalid engineering security classification");
      const command = snapshot(
        raw,
      ) as unknown as SubmitEngineeringEvidenceCommand;
      validateCommand(command);
      integer(command.expectedRevision, "expectedRevision", 1);
      validateEngineeringEvidenceInput(command.evidence);
      if (!["ordinary", "restricted", "uncertain"].includes(command.security))
        throw new TypeError("Invalid engineering security classification");
      const hash = await fingerprint({
        operation: "evidence",
        actorId,
        command,
      });
      for (let attempt = 0; attempt < deps.maxConflictAttempts; attempt += 1) {
        const previous = await replayAuthorized(
          access,
          name,
          actorId,
          command,
          hash,
        );
        if (previous !== null) return previous;
        const loaded = await load(command.ticketId);
        const source = loaded.source.value;
        const ticket = loaded.ticket.value.ticket;
        if (source.state === "withdrawn") {
          permission(access, name, actorId);
          return result(source);
        }
        if (!options.enabled)
          throw new SupportDeskConflictError("Engineering processing disabled");
        if (ticket.revision !== command.expectedRevision)
          throw new SupportDeskConflictError(
            "Engineering ticket revision changed",
          );
        const clearing = requiresSecurityReview(source, command.security);
        if (clearing)
          permission(
            access,
            supportPermissions.engineeringSecurityReview,
            actorId,
          );
        const visible = loaded.rows.filter(
          (row): row is Extract<SupportRecord, { kind: "message" }> =>
            row.kind === "message" && row.message.visibility === "customer",
        );
        const latest = [...visible].sort(
          (left, right) => right.ordinal - left.ordinal,
        )[0];
        if (
          latest === undefined ||
          command.evidence.visibleMessageIds.some(
            (id) =>
              !visible.some(
                (message) =>
                  message.message.id === id &&
                  message.ordinal <= ticket.revision,
              ),
          )
        )
          throw new SupportDeskConflictError(
            "Engineering evidence must identify actual visible messages",
          );
        const now = clock.now();
        const trust: EngineeringTrustContext = {
          ticketId: ticket.id,
          ticketRevision: ticket.revision,
          sourceGeneration: source.sourceGeneration,
          actorId,
          acceptedAt: now,
        };
        const mismatch: EngineeringMismatch = {
          expectedBehavior: command.evidence.expectedBehavior,
          actualBehavior: command.evidence.actualBehavior,
          reproductionSteps: command.evidence.reproductionSteps,
          visibleMessageIds: command.evidence.visibleMessageIds,
        };
        const window = trustWindow(clock, options.trustTimeoutMilliseconds);
        let product: EngineeringProductContext | null = null;
        let evidence: EngineeringEvidence | null = null;
        let heldReason = "product_context_unavailable";
        try {
          if (options.productContext !== undefined) {
            const resolved = await window.within((signal) =>
              options.productContext!.resolve(snapshot(trust), signal),
            );
            if (resolved !== null) {
              product = snapshot(resolved);
              validateEngineeringProduct(product);
              if (
                timestamp(product.verifiedAt, "product.verifiedAt") >
                  window.now() ||
                timestamp(product.validUntil, "product.validUntil") <=
                  window.now()
              )
                product = null;
            }
          }
          if (product !== null) {
            if (command.evidence.kind === "staff_verified_failure") {
              evidence = {
                ...mismatch,
                kind: command.evidence.kind,
                verificationReference: command.evidence.verificationReference,
                actorId,
              };
            } else {
              heldReason = "failed_test_unverified";
              if (options.testReceipts !== undefined) {
                const receiptId = command.evidence.receipt;
                const test = await window.within((signal) =>
                  options.testReceipts!.verify(
                    receiptId,
                    snapshot({
                      ...trust,
                      product: product!,
                      evidence: mismatch,
                    }),
                    signal,
                  ),
                );
                if (test !== null) {
                  const proposed: EngineeringEvidence = {
                    ...mismatch,
                    kind: "failed_test",
                    actorId,
                    test: snapshot(test),
                  };
                  validateEngineeringEvidence(proposed);
                  if (
                    test.productBinding === product.binding &&
                    timestamp(test.executedAt, "test.executedAt") <=
                      timestamp(test.verifiedAt, "test.verifiedAt") &&
                    timestamp(test.verifiedAt, "test.verifiedAt") <=
                      window.now() &&
                    timestamp(test.validUntil, "test.validUntil") > window.now()
                  )
                    evidence = proposed;
                }
              }
            }
            if (evidence !== null) validateEngineeringEvidence(evidence);
          }
        } catch {
          product = null;
          evidence = null;
        } finally {
          window.close();
        }

        const stableProduct =
          product === null
            ? null
            : {
                productId: product.productId,
                version: product.version,
                buildId: product.buildId,
                binding: product.binding,
                contextVersion: product.contextVersion,
              };
        const stableEvidence =
          evidence === null
            ? null
            : evidence.kind === "staff_verified_failure"
              ? evidence
              : {
                  ...mismatch,
                  kind: evidence.kind,
                  actorId,
                  executionId: evidence.test.executionId,
                  runnerId: evidence.test.runnerId,
                  testId: evidence.test.testId,
                  productBinding: evidence.test.productBinding,
                };
        const evidenceFingerprint = await fingerprint(stableEvidence);
        const productContextFingerprint = await fingerprint(stableProduct);
        const proofIdentity = await fingerprint({
          evidence: stableEvidence,
          product: stableProduct,
          lastVisibleMessageId: latest.message.id,
          security: command.security,
        });
        const trusted =
          product !== null &&
          evidence !== null &&
          timestamp(product.validUntil, "product.validUntil") > window.now() &&
          (evidence.kind !== "failed_test" ||
            timestamp(evidence.test.validUntil, "test.validUntil") >
              window.now());
        let next = source;
        let work: EngineeringWorkRecord | undefined;
        if (!(
          trusted &&
          ["eligible", "restricted"].includes(source.state) &&
          source.security === command.security &&
          !clearing &&
          source.proofIdentity === proofIdentity
        )) {
          const {
            heldReason: _held,
            pendingEvidenceReference: _pending,
            evidence: _evidence,
            product: _product,
            proofIdentity: _proof,
            evidenceFingerprint: _evidenceHash,
            productContextFingerprint: _productHash,
            sourceBindingHash: _binding,
            acceptedTicketRevision: _accepted,
            lastVisibleMessageId: _visible,
            ...base
          } = source;
          const sourceGeneration = source.sourceGeneration + 1;
          const sourceBindingHash = await fingerprint({
            ticketId: ticket.id,
            sourceGeneration,
            evidenceFingerprint,
            productContextFingerprint,
            proofIdentity,
          });
          next = {
            ...base,
            sourceGeneration,
            workGeneration: source.workGeneration + 1,
            security: command.security,
            updatedAt: now,
            state: trusted
              ? command.security === "ordinary"
                ? "eligible"
                : "restricted"
              : command.security === "ordinary"
                ? "held"
                : "restricted",
            ...(trusted
              ? {
                  proofIdentity,
                  evidenceFingerprint,
                  productContextFingerprint,
                  sourceBindingHash,
                  acceptedTicketRevision: ticket.revision,
                  lastVisibleMessageId: latest.message.id,
                  evidence: evidence!,
                  product: product!,
                  generationCount: source.generationCount + 1,
                }
              : { heldReason, pendingEvidenceReference: command.commandId }),
            destinations: source.destinations.map((destination) => ({
              ...destination,
              reconciliation: reconciliationAfterSourceChange(destination),
            })),
            reconciliationPending: source.destinations.some(
              (destination) =>
                reconciliationAfterSourceChange(destination) !== "confirmed",
            ),
          };
          if (trusted && source.generationCount >= options.maxGenerations) {
            next = {
              ...next,
              generationCount: source.generationCount,
              state: "held",
              heldReason: "engineering_capacity",
            };
          } else if (trusted && command.security === "ordinary") {
            work = {
              kind: "engineering_work",
              partition: ticket.id,
              id: engineeringWorkKey(ticket.id, sourceGeneration).id,
              ticketId: ticket.id,
              sourceGeneration,
              sourceBindingHash,
              workGeneration: 1,
              acceptedTicketRevision: ticket.revision,
              createdAt: now,
              deadline: new Date(
                timestamp(now, "now") + options.maxWorkMilliseconds,
              ).toISOString(),
              security: command.security,
              evidence: evidence!,
              product: product!,
              status: "pending",
              stage: "model",
              modelAttempts: [],
              claimGeneration: 0,
              proposalCount: 0,
              terminalReserveRows: 0,
            };
          }
        }
        const securityRestriction =
          next.security !== "ordinary" &&
          (next.sourceGeneration !== source.sourceGeneration ||
            next.security !== source.security ||
            source.state !== "restricted");
        if (securityRestriction)
          next = {
            ...next,
            followupRevocationEpoch:
              advanceEngineeringFollowupRevocationEpoch(source),
          };
        else if (trusted && next.followupRevocationEpoch === undefined)
          next = { ...next, followupRevocationEpoch: 0 };
        const followup = securityRestriction
          ? await deps.planFollowupSourceChange({
              rows: loaded.rows,
              previousSource: source,
              nextSource: next,
              reason: "security_restriction",
            })
          : { actions: [], nextWorkRows: [] };
        const plannedRows = projectEngineeringRows(
          loaded.rows,
          followup.nextWorkRows,
        );
        try {
          bounded(next);
          if (work !== undefined) {
            bounded(work);
            deps.admission(ticket, [...plannedRows, work], 2);
          } else deps.admission(ticket, plannedRows, 2);
        } catch (error) {
          if (!(error instanceof SupportDeskLimitError) || work === undefined)
            throw error;
          work = undefined;
          next = {
            ...next,
            state: "held",
            heldReason: "engineering_capacity",
            generationCount: source.generationCount,
          };
          bounded(next);
          deps.admission(ticket, plannedRows, 2);
        }
        const actions: EngineeringAction[] = [
          guardedTicket(loaded),
          sourceAction(loaded.source, next),
          ...followup.actions,
        ];
        if (work !== undefined) actions.push({ action: "insert", value: work });
        actions.push(
          deps.audit(
            command,
            ticket,
            actorId,
            now,
            "support.engineering.evidence_recorded",
          ),
          receipt(command, hash, result(next)),
        );
        permission(access, name, actorId);
        if (clearing)
          permission(
            access,
            supportPermissions.engineeringSecurityReview,
            actorId,
          );
        // Hashing/planning can await after the trust response. Never commit a
        // newly eligible proof whose original product/test attestation expired.
        if (
          trusted &&
          (timestamp(product!.validUntil, "product.validUntil") <=
            window.now() ||
            (evidence!.kind === "failed_test" &&
              timestamp(evidence!.test.validUntil, "test.validUntil") <=
                window.now()))
        )
          throw new SupportDeskConflictError(
            "Engineering evidence expired before commit",
          );
        if ((await records.transact(command.ticketId, actions)).committed) {
          permission(access, name, actorId);
          if (clearing)
            permission(
              access,
              supportPermissions.engineeringSecurityReview,
              actorId,
            );
          return result(next);
        }
      }
      const previous = await replayAuthorized(
        access,
        name,
        actorId,
        command,
        hash,
      );
      if (previous !== null) return previous;
      throw new SupportDeskConflictError();
    },

    invalidateEngineeringSource: (access, command) =>
      invalidate(access, command, false),
    withdrawEngineeringSource: (access, command) =>
      invalidate(access, command, true),

    async readEngineeringSource(access, ticketId) {
      const actorId = access.principalId;
      permission(access, supportPermissions.engineeringRead, actorId);
      text(ticketId, "ticketId");
      for (let attempt = 0; attempt < deps.maxConflictAttempts; attempt += 1) {
        const source = await readEngineeringSourceVersion(records, ticketId);
        permission(access, supportPermissions.engineeringRead, actorId);
        if (source === null) throw new SupportDeskNotFoundError();
        privateRead(access, source.value.security, actorId);
        if (source.value.state === "restricted")
          permission(
            access,
            supportPermissions.engineeringRestrictedRead,
            actorId,
          );
        if (source.value.state !== "withdrawn") {
          const ticket = await records.get({
            partition: ticketId,
            id: "ticket",
          });
          permission(access, supportPermissions.engineeringRead, actorId);
          if (ticket?.kind !== "ticket") throw new SupportDeskNotFoundError();
        }
        const latest = await readEngineeringSourceVersion(records, ticketId);
        permission(access, supportPermissions.engineeringRead, actorId);
        if (latest?.version !== source.version) continue;
        privateRead(access, source.value.security, actorId);
        if (source.value.state === "restricted")
          permission(
            access,
            supportPermissions.engineeringRestrictedRead,
            actorId,
          );
        return snapshot(source.value);
      }
      throw new SupportDeskConflictError();
    },

    async readEngineeringWork(access, key) {
      const actorId = access.principalId;
      permission(access, supportPermissions.engineeringRead, actorId);
      const input = snapshot(
        fields(key, "engineering work key", ["ticketId", "sourceGeneration"]),
      ) as unknown as typeof key;
      text(input.ticketId, "ticketId");
      integer(input.sourceGeneration, "sourceGeneration", 1);
      for (let attempt = 0; attempt < deps.maxConflictAttempts; attempt += 1) {
        const source = await readEngineeringSourceVersion(
          records,
          input.ticketId,
        );
        permission(access, supportPermissions.engineeringRead, actorId);
        if (source === null) throw new SupportDeskNotFoundError();
        privateRead(access, source.value.security, actorId);
        if (source.value.state === "restricted")
          permission(
            access,
            supportPermissions.engineeringRestrictedRead,
            actorId,
          );
        const work = await records.getVersioned(
          engineeringWorkKey(input.ticketId, input.sourceGeneration),
        );
        permission(access, supportPermissions.engineeringRead, actorId);
        if (work?.value.kind !== "engineering_work")
          throw new SupportDeskNotFoundError();
        privateRead(access, source.value.security, actorId);
        privateRead(access, work.value.security, actorId);
        if (
          source.value.state === "restricted" ||
          work.value.status === "restricted" ||
          (work.value.candidate !== undefined &&
            work.value.candidate.security !== "ordinary")
        )
          permission(
            access,
            supportPermissions.engineeringRestrictedRead,
            actorId,
          );
        if (source.value.state !== "withdrawn") {
          const ticket = await records.get({
            partition: input.ticketId,
            id: "ticket",
          });
          permission(access, supportPermissions.engineeringRead, actorId);
          if (ticket?.kind !== "ticket") throw new SupportDeskNotFoundError();
        }
        const latest = await readEngineeringSourceVersion(
          records,
          input.ticketId,
        );
        permission(access, supportPermissions.engineeringRead, actorId);
        const latestWork = await records.getVersioned(
          engineeringWorkKey(input.ticketId, input.sourceGeneration),
        );
        permission(access, supportPermissions.engineeringRead, actorId);
        if (
          latest?.version !== source.version ||
          latestWork?.version !== work.version
        )
          continue;
        privateRead(access, source.value.security, actorId);
        privateRead(access, work.value.security, actorId);
        if (
          source.value.state === "restricted" ||
          work.value.status === "restricted" ||
          (work.value.candidate !== undefined &&
            work.value.candidate.security !== "ordinary")
        )
          permission(
            access,
            supportPermissions.engineeringRestrictedRead,
            actorId,
          );
        return snapshot(work.value);
      }
      throw new SupportDeskConflictError();
    },
  };
  return { application, load };
}
