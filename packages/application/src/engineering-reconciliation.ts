import { hasPermission, type AccessContext } from "@pegma/authorization-core";
import {
  SupportDeskAuthorizationError,
  SupportDeskConflictError,
  SupportDeskNotFoundError,
  supportPermissions,
} from "./index.js";
import {
  canonical,
  fields,
  fingerprint,
  integer,
  text,
  timestamp,
} from "./assistant-turn-records.js";
import {
  safeEngineeringSnapshot as snapshot,
  checkEngineeringRecordCapacity,
  engineeringCommandKey,
  engineeringSourceKey,
  engineeringWorkKey,
  validateEngineeringAcknowledgement,
  type EngineeringDestination,
  type EngineeringSourceRecord,
  type EngineeringWorkRecord,
} from "./engineering-records.js";
import type {
  EngineeringAction,
  EngineeringDependencies,
  EngineeringSourceVersion,
  EngineeringWorkVersion,
} from "./engineering-internal.js";
import type {
  EngineeringApplication,
  EngineeringCommitGuard,
  EngineeringDispatchProofBinding,
  EngineeringReconciliationView,
  EngineeringStepResult,
  RecordEngineeringDispatchResultCommand,
  RecordEngineeringReconciliationCommand,
} from "./engineering-types.js";

type Methods = Pick<
  EngineeringApplication,
  | "readEngineeringReconciliation"
  | "recordEngineeringReconciliation"
  | "recordEngineeringDispatchResult"
>;
type Identity = NonNullable<
  EngineeringReconciliationView["destinations"][number]["requestIdentity"]
>;
type Result = RecordEngineeringDispatchResultCommand["result"];

function permission(access: AccessContext, reconciliation: boolean): void {
  text(access.principalId, "principalId");
  const name = reconciliation
    ? supportPermissions.engineeringReconcile
    : supportPermissions.engineeringProcess;
  if (
    !hasPermission(access, name) &&
    (reconciliation ||
      !hasPermission(access, supportPermissions.engineeringReconcile))
  )
    throw new SupportDeskAuthorizationError(name);
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
function sameAcknowledgement(
  left: EngineeringDestination["acknowledgement"],
  right: EngineeringDestination["acknowledgement"],
): boolean {
  return (
    left !== undefined &&
    right !== undefined &&
    left.repositoryId === right.repositoryId &&
    left.issueId === right.issueId &&
    left.issueNumber === right.issueNumber
  );
}
function validateResult(input: unknown, reconciliation: boolean): Result {
  const value = fields(
    input,
    "engineering dispatch result",
    ["outcome"],
    ["acknowledgement", "proof", "reason"],
  );
  if (value.outcome === "accepted") {
    fields(value, "accepted engineering result", [
      "outcome",
      "acknowledgement",
      ...(reconciliation ? ["proof"] : []),
    ]);
    validateEngineeringAcknowledgement(value.acknowledgement);
    if (reconciliation) text(value.proof, "proof");
    return {
      outcome: "accepted",
      acknowledgement: snapshot(value.acknowledgement),
    };
  }
  if (value.outcome === "confirmed_rejected") {
    fields(value, "rejected engineering result", ["outcome", "proof"]);
    text(value.proof, "proof");
    return { outcome: "confirmed_rejected", proof: value.proof as string };
  }
  if (value.outcome === "unknown") {
    fields(value, "unknown engineering result", ["outcome"], ["reason"]);
    if (value.reason !== undefined) text(value.reason, "reason");
    return {
      outcome: "unknown",
      ...(value.reason === undefined ? {} : { reason: value.reason as string }),
    };
  }
  throw new TypeError("Invalid engineering result outcome");
}

export function createEngineeringReconciliationServices(
  deps: EngineeringDependencies,
): Methods {
  const { records, clock, options } = deps;
  async function sourceAt(ticketId: string): Promise<EngineeringSourceVersion> {
    const source = await records.getVersioned(engineeringSourceKey(ticketId));
    if (source?.value.kind !== "engineering_source")
      throw new SupportDeskNotFoundError();
    return { value: source.value, version: source.version };
  }
  async function workAt(
    ticketId: string,
    generation: number,
  ): Promise<EngineeringWorkVersion | null> {
    const work = await records.getVersioned(
      engineeringWorkKey(ticketId, generation),
    );
    if (work === null) return null;
    if (work.value.kind !== "engineering_work")
      throw new SupportDeskConflictError(
        "Engineering work key contains another record",
      );
    return { value: work.value, version: work.version };
  }
  async function identity(
    work: EngineeringWorkRecord | null,
    destination: EngineeringDestination,
  ): Promise<Identity | null> {
    if (
      work === null ||
      work.dispatch === undefined ||
      work.sourceGeneration !== destination.sourceGeneration ||
      work.stepId !== destination.stepId ||
      work.requestHash !== destination.requestHash ||
      work.dispatch?.dispatchId !== destination.dispatchId ||
      work.dispatch.requestHash !== destination.requestHash ||
      work.dispatch.repositoryId !== destination.repositoryId ||
      work.dispatch.exportMarker !== destination.exportMarker
    )
      return null;
    const prepared = work.proposal;
    if (prepared !== undefined) {
      const request = prepared.request;
      if (
        prepared.stepId !== destination.stepId ||
        prepared.requestHash !== destination.requestHash ||
        request.repository.repositoryId !== destination.repositoryId ||
        request.bundle.exportMarker !== destination.exportMarker ||
        (await fingerprint(request)) !== destination.requestHash ||
        (await fingerprint(request.repository)) !==
          prepared.repositoryMetadataHash
      )
        return null;
      return {
        operation: request.operation,
        sourceBindingHash: work.sourceBindingHash,
        repositoryMetadataHash: prepared.repositoryMetadataHash,
        ...(request.operation === "link_existing_issue"
          ? { issueId: request.issueId, issueNumber: request.issueNumber }
          : {}),
      };
    }
    const request = work.withdrawnRequest;
    if (
      request === undefined ||
      request.repositoryId !== destination.repositoryId ||
      request.exportMarker !== destination.exportMarker
    )
      return null;
    return {
      operation: request.operation,
      sourceBindingHash: work.sourceBindingHash,
      repositoryMetadataHash: request.repositoryMetadataHash,
      ...(request.operation === "link_existing_issue"
        ? { issueId: request.issueId!, issueNumber: request.issueNumber! }
        : {}),
    };
  }
  async function view(
    ticketId: string,
  ): Promise<EngineeringReconciliationView> {
    for (let attempt = 0; attempt < deps.maxConflictAttempts; attempt += 1) {
      const source = await sourceAt(ticketId);
      const destinations = await Promise.all(
        source.value.destinations.map(async (destination) => {
          const work = await workAt(ticketId, destination.sourceGeneration);
          const requestIdentity = await identity(
            work?.value ?? null,
            destination,
          );
          return {
            ...snapshot(destination),
            requestIdentity,
            requestIdentityStatus:
              requestIdentity === null
                ? ("unavailable" as const)
                : ("available" as const),
          };
        }),
      );
      const latest = await sourceAt(ticketId);
      if (latest.version !== source.version) continue;
      return {
        ticketId,
        sourceGeneration: source.value.sourceGeneration,
        sourceWorkGeneration: source.value.workGeneration,
        state: source.value.state,
        destinations,
      };
    }
    throw new SupportDeskConflictError(
      "Engineering source changed during reconciliation read",
    );
  }
  async function verify(
    binding: EngineeringDispatchProofBinding,
    now: () => number,
  ): Promise<{ readonly receipt: string; readonly deadline: number }> {
    if (options.dispatchResults === undefined)
      throw new SupportDeskConflictError(
        "Engineering dispatch proof verifier unavailable",
      );
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const verified = snapshot(
        await Promise.race([
          Promise.resolve().then(() =>
            options.dispatchResults!.verify(binding, controller.signal),
          ),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
              controller.abort();
              reject(
                new SupportDeskConflictError(
                  "Engineering dispatch proof timed out",
                ),
              );
            }, options.trustTimeoutMilliseconds);
          }),
        ]),
      );
      if (verified === null)
        throw new SupportDeskConflictError(
          "Engineering acceptance or no-acceptance proof unverified",
        );
      fields(verified, "verified engineering dispatch", [
        "binding",
        "verifierReceiptId",
        "verifierVersion",
        "verifiedAt",
        "validUntil",
      ]);
      text(verified.verifierReceiptId, "dispatch.verifierReceiptId");
      text(verified.verifierVersion, "dispatch.verifierVersion");
      if (
        canonical(verified.binding) !== canonical(binding) ||
        timestamp(verified.verifiedAt, "dispatch.verifiedAt") > now() ||
        timestamp(verified.validUntil, "dispatch.validUntil") <= now()
      )
        throw new SupportDeskConflictError(
          "Engineering dispatch proof binding or validity changed",
        );
      return {
        receipt: verified.verifierReceiptId,
        deadline: timestamp(verified.validUntil, "dispatch.validUntil"),
      };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
  async function record(
    access: AccessContext,
    command:
      | RecordEngineeringDispatchResultCommand
      | RecordEngineeringReconciliationCommand,
    result: Result,
    reconciliation: boolean,
    guard?: EngineeringCommitGuard,
  ): Promise<EngineeringStepResult> {
    const runStart = timestamp(clock.now(), "now");
    const started = performance.now();
    const now = () =>
      Math.max(
        timestamp(clock.now(), "now"),
        runStart + Math.max(0, performance.now() - started),
      );
    const hash = await fingerprint({
      operation: reconciliation ? "reconcile" : "dispatch_result",
      command,
    });
    for (let attempt = 0; attempt < deps.maxConflictAttempts; attempt += 1) {
      permission(access, reconciliation);
      const source = await sourceAt(command.ticketId);
      const stored = await workAt(command.ticketId, command.sourceGeneration);
      const work = stored?.value;
      const destination = source.value.destinations.find(
        (entry) =>
          entry.sourceGeneration === command.sourceGeneration &&
          entry.dispatchId === command.dispatchId &&
          entry.requestHash === command.requestHash &&
          (!reconciliation ||
            entry.repositoryId ===
              (command as RecordEngineeringReconciliationCommand).repositoryId),
      );
      if (
        stored === null ||
        work === undefined ||
        destination === undefined ||
        work.dispatch === undefined
      )
        throw new SupportDeskConflictError(
          "Engineering reconciliation destination changed",
        );
      if (
        work.lastDispatchResult?.fingerprint === hash ||
        destination.lastReconciliation?.fingerprint === hash
      ) {
        if (guard !== undefined) await guard();
        permission(access, reconciliation);
        return outcome(work);
      }
      if (
        reconciliation &&
        source.value.workGeneration !==
          (command as RecordEngineeringReconciliationCommand)
            .expectedSourceWorkGeneration
      )
        throw new SupportDeskConflictError(
          "Engineering reconciliation source version changed",
        );
      if (
        ["accepted", "confirmed_rejected"].includes(destination.outcome) &&
        destination.reconciliation === "confirmed"
      ) {
        if (
          (result.outcome === "accepted" &&
            destination.outcome === "accepted" &&
            sameAcknowledgement(
              destination.acknowledgement,
              result.acknowledgement,
            )) ||
          (result.outcome === "confirmed_rejected" &&
            destination.outcome === "confirmed_rejected")
        ) {
          if (guard !== undefined) await guard();
          permission(access, reconciliation);
          return outcome(work);
        }
        throw new SupportDeskConflictError(
          "Established engineering terminal outcome cannot be replaced",
        );
      }
      const requestIdentity = await identity(work, destination);
      if (requestIdentity === null)
        throw new SupportDeskConflictError(
          "Engineering exact request identity unavailable",
        );
      if (
        result.outcome === "accepted" &&
        (result.acknowledgement.repositoryId !== destination.repositoryId ||
          (requestIdentity.operation === "link_existing_issue" &&
            (result.acknowledgement.issueId !== requestIdentity.issueId ||
              result.acknowledgement.issueNumber !==
                requestIdentity.issueNumber)))
      )
        throw new SupportDeskConflictError(
          "Engineering acknowledgement does not match exact destination",
        );
      const proof =
        result.outcome === "unknown"
          ? null
          : await verify(
              {
                ticketId: command.ticketId,
                sourceGeneration: work.sourceGeneration,
                sourceBindingHash: requestIdentity.sourceBindingHash,
                repositoryId: destination.repositoryId,
                repositoryMetadataHash: requestIdentity.repositoryMetadataHash,
                dispatchId: command.dispatchId,
                requestHash: command.requestHash,
                exportMarker: destination.exportMarker,
                operation: requestIdentity.operation,
                result,
              },
              now,
            );
      const terminal = result.outcome !== "unknown";
      if (terminal && work.terminalReserveRows !== 2)
        throw new SupportDeskConflictError(
          "Engineering terminal reserve unavailable",
        );
      const acknowledgement =
        result.outcome !== "accepted"
          ? undefined
          : source.value.state === "withdrawn"
            ? {
                repositoryId: result.acknowledgement.repositoryId,
                issueId: result.acknowledgement.issueId,
                issueNumber: result.acknowledgement.issueNumber,
              }
            : result.acknowledgement;
      const {
        claim: _claim,
        leaseUntil: _lease,
        retryAt: _retry,
        ...unclaimed
      } = work;
      const nextWork: EngineeringWorkRecord = {
        ...unclaimed,
        status: result.outcome,
        stage: "reconcile",
        workGeneration: work.workGeneration + 1,
        terminalReserveRows: terminal ? 0 : 2,
        lastDispatchResult: { fingerprint: hash },
        ...(acknowledgement === undefined ? {} : { acknowledgement }),
        ...(proof === null ? {} : { resultProof: proof.receipt }),
        ...(result.outcome !== "unknown" ||
        result.reason === undefined ||
        source.value.state === "withdrawn"
          ? {}
          : { heldReason: result.reason }),
      };
      const destinations = source.value.destinations.map((entry) =>
        entry !== destination
          ? entry
          : {
              ...entry,
              outcome: result.outcome,
              reconciliation: terminal
                ? ("confirmed" as const)
                : ("blocked" as const),
              ...(acknowledgement === undefined ? {} : { acknowledgement }),
              lastReconciliation: {
                fingerprint: hash,
                outcome: result.outcome,
                observedAt: clock.now(),
                ...(proof === null ? {} : { proof: proof.receipt }),
              },
            },
      );
      const nextSource: EngineeringSourceRecord = {
        ...source.value,
        workGeneration: source.value.workGeneration + 1,
        destinations,
        reconciliationPending: destinations.some(
          (entry) => entry.reconciliation !== "confirmed",
        ),
      };
      checkEngineeringRecordCapacity(nextWork);
      checkEngineeringRecordCapacity(nextSource);
      const ticket = await records.getVersioned({
        partition: command.ticketId,
        id: "ticket",
      });
      if (ticket !== null && ticket.value.kind !== "ticket")
        throw new SupportDeskConflictError(
          "Ticket key contains another record",
        );
      const rows = await records.list(command.ticketId);
      const ticketFact =
        ticket?.value.kind === "ticket"
          ? ticket.value.ticket
          : { id: work.ticketId, revision: work.acceptedTicketRevision };
      const causal = {
        ticketId: command.ticketId,
        commandId: await fingerprint({
          operation: "engineering_terminal",
          sourceGeneration: work.sourceGeneration,
          dispatchId: command.dispatchId,
          requestHash: command.requestHash,
        }),
        correlationId: command.dispatchId,
      };
      const actions: EngineeringAction[] = [];
      if (terminal) {
        deps.completionAdmission(ticketFact, rows, 2, work.id);
        const resultReceipt = {
          kind: "engineering_receipt" as const,
          partition: command.ticketId,
          id: engineeringCommandKey(command.ticketId, causal.commandId).id,
          fingerprint: hash,
          result: outcome(nextWork),
        };
        checkEngineeringRecordCapacity(resultReceipt);
        actions.push(
          deps.audit(
            causal,
            ticketFact,
            access.principalId,
            clock.now(),
            reconciliation
              ? "support.engineering.reconciled"
              : "support.engineering.export_recorded",
          ),
          { action: "insert", value: resultReceipt },
        );
      }
      if (guard !== undefined) await guard();
      permission(access, reconciliation);
      if (proof !== null && now() >= proof.deadline)
        throw new SupportDeskConflictError(
          "Engineering terminal proof expired before commit",
        );
      if (
        (
          await records.transact(command.ticketId, [
            ...(ticket === null
              ? []
              : [
                  {
                    action: "putIfUnchanged" as const,
                    version: ticket.version,
                    value: ticket.value,
                  },
                ]),
            {
              action: "putIfUnchanged",
              version: source.version,
              value: nextSource,
            },
            {
              action: "putIfUnchanged",
              version: stored.version,
              value: nextWork,
            },
            ...actions,
          ])
        ).committed
      )
        return outcome(nextWork);
    }
    throw new SupportDeskConflictError();
  }
  return {
    async readEngineeringReconciliation(access, ticketId) {
      permission(access, true);
      text(ticketId, "ticketId");
      const result = await view(ticketId);
      permission(access, true);
      return result;
    },
    async recordEngineeringDispatchResult(access, input) {
      permission(access, false);
      const command = snapshot(
        fields(input, "record engineering dispatch", [
          "ticketId",
          "sourceGeneration",
          "dispatchId",
          "requestHash",
          "result",
        ]),
      ) as unknown as typeof input;
      text(command.ticketId, "ticketId");
      integer(command.sourceGeneration, "sourceGeneration", 1);
      text(command.dispatchId, "dispatchId");
      text(command.requestHash, "requestHash");
      return record(
        access,
        command,
        validateResult(command.result, false),
        false,
      );
    },
    async recordEngineeringReconciliation(access, input, guard) {
      permission(access, true);
      if (typeof guard !== "function")
        throw new TypeError(
          "Engineering reconciliation requires a current read-only remote proof guard",
        );
      const command = snapshot(
        fields(input, "record engineering reconciliation", [
          "ticketId",
          "sourceGeneration",
          "expectedSourceWorkGeneration",
          "repositoryId",
          "dispatchId",
          "requestHash",
          "result",
        ]),
      ) as unknown as typeof input;
      text(command.ticketId, "ticketId");
      integer(command.sourceGeneration, "sourceGeneration", 1);
      integer(
        command.expectedSourceWorkGeneration,
        "expectedSourceWorkGeneration",
        1,
      );
      for (const key of ["repositoryId", "dispatchId", "requestHash"] as const)
        text(command[key], key);
      await record(
        access,
        command,
        validateResult(command.result, true),
        true,
        guard,
      );
      const result = await view(command.ticketId);
      permission(access, true);
      return result;
    },
  };
}
