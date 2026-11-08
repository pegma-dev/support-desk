import { hasPermission, type AccessContext } from "@pegma/authorization-core";
import type { CollectionStore } from "@pegma/storage-core";
import {
  SupportDeskAuthorizationError,
  SupportDeskConflictError,
  SupportDeskLimitError,
  SupportDeskNotFoundError,
  supportPermissions,
  supportTicketAuditActions,
  type SupportRecord,
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
  engineeringSourceKey,
  engineeringWorkKey,
} from "./engineering-records.js";
import {
  safeEngineeringFollowupSnapshot as snapshot,
  checkEngineeringFollowupRecordCapacity,
  reserveEngineeringFollowupReachable,
  engineeringFollowupHeadKey,
  engineeringFollowupWorkKey,
  engineeringFollowupCommandKey,
  validateVerifiedEngineeringFollowupContext,
  type EngineeringFollowupHeadRecord,
  type EngineeringFollowupWorkRecord,
} from "./engineering-followup-records.js";
import type {
  EngineeringFollowupApplication,
  EngineeringFollowupAssociation,
  EngineeringFollowupContext,
  EngineeringFollowupProofContext,
  EngineeringFollowupResult,
  VerifiedEngineeringFollowupContext,
} from "./engineering-followup-types.js";
import type {
  EngineeringFollowupDependencies,
  EngineeringFollowupLoaded,
  EngineeringFollowupLoad,
  EngineeringFollowupMutationPlan,
  EngineeringFollowupSourceChangeContext,
  EngineeringFollowupWorkVersion,
} from "./engineering-followup-internal.js";
import type { EngineeringAction } from "./engineering-internal.js";

export function engineeringFollowupPermission(
  access: AccessContext,
  name: string,
  actorId: string,
  staff = false,
): void {
  text(access.principalId, "principalId");
  if (access.principalId !== actorId || !hasPermission(access, name))
    throw new SupportDeskAuthorizationError(name);
  if (staff && !hasPermission(access, supportPermissions.queueRead))
    throw new SupportDeskAuthorizationError(supportPermissions.queueRead);
}
export function engineeringFollowupNow(
  deps: EngineeringFollowupDependencies,
): () => number {
  const initial = timestamp(deps.clock.now(), "now");
  const start = performance.now();
  return () =>
    Math.max(
      timestamp(deps.clock.now(), "now"),
      initial + Math.max(0, performance.now() - start),
    );
}
export async function engineeringFollowupTrusted<T>(
  deps: EngineeringFollowupDependencies,
  action: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => action(controller.signal)),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(
            new SupportDeskConflictError(
              "Follow-up trusted observation timed out",
            ),
          );
        }, deps.options.trustTimeoutMilliseconds);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
export function engineeringFollowupResult(
  work: EngineeringFollowupWorkRecord,
): EngineeringFollowupResult {
  return {
    ticketId: work.ticketId,
    workId: work.workId,
    workGeneration: work.workGeneration,
    status: work.status,
    ...(work.stepId === undefined ? {} : { stepId: work.stepId }),
    ...(work.requestHash === undefined
      ? {}
      : { requestHash: work.requestHash }),
    ...(work.candidateHash === undefined
      ? {}
      : { candidateHash: work.candidateHash }),
    ...(work.preparedBundle === undefined
      ? {}
      : { bundleHash: work.preparedBundle.bundleHash }),
    ...(work.delivered === undefined
      ? {}
      : {
          messageId: work.delivered.messageId,
          ticketRevision: work.delivered.ticketRevision,
        }),
  };
}
export function engineeringFollowupWithoutLease(
  work: EngineeringFollowupWorkRecord,
): EngineeringFollowupWorkRecord {
  const { claim: _claim, leaseUntil: _lease, retryAt: _retry, ...rest } = work;
  return rest;
}
export function holdEngineeringFollowupWork(
  work: EngineeringFollowupWorkRecord,
  reason: string,
): EngineeringFollowupWorkRecord {
  if (work.withdrawn) return work;
  return {
    ...engineeringFollowupWithoutLease(work),
    status: work.security === "ordinary" ? "held" : "restricted",
    ...(work.status === "delivered" ? { status: "delivered" as const } : {}),
    completionRows: 0,
    messageSlots: 0,
    heldReason: reason,
    workGeneration: work.workGeneration + 1,
  };
}
function scrub(
  work: EngineeringFollowupWorkRecord,
  reason: string,
): EngineeringFollowupWorkRecord {
  const {
    context: _context,
    candidate: _candidate,
    candidateHash: _candidateHash,
    preparedBundle: _bundle,
    handoff: _handoff,
    modelAttempts: _attempts,
    retestResults: _tests,
    ...minimal
  } = engineeringFollowupWithoutLease(work);
  return {
    ...minimal,
    withdrawn: true,
    status: work.status === "delivered" ? "delivered" : "held",
    completionRows: 0,
    messageSlots: 0,
    heldReason: reason,
    workGeneration: work.workGeneration + 1,
    modelAttempts: [],
    retestResults: [],
    usageTombstones: [
      ...new Map(
        [
          ...(work.usageTombstones ?? []),
          ...work.modelAttempts.map((entry) => ({
            stepId: entry.stepId,
            requestHash: entry.requestHash,
            usageReservationId: entry.binding.usageReservationId,
            accounting: entry.accounting,
          })),
        ].map((entry) => [canonical([entry.stepId, entry.requestHash]), entry]),
      ).values(),
    ],
  };
}
export async function engineeringFollowupWorkId(
  identity: EngineeringFollowupWorkRecord["semanticIdentity"],
): Promise<string> {
  return fingerprint(identity);
}
export async function engineeringFollowupWorkBindingHash(
  input: Pick<
    EngineeringFollowupWorkRecord,
    | "association"
    | "parentSourceGeneration"
    | "acceptedTicketRevision"
    | "lastVisibleMessageId"
    | "context"
  >,
): Promise<string> {
  return fingerprint(input);
}
export function engineeringFollowupLatestVisible(
  loaded: EngineeringFollowupLoaded,
): { readonly messageId: string; readonly ordinal: number } {
  const ordinals = new Set<number>();
  let latest: { messageId: string; ordinal: number } | undefined;
  for (const row of loaded.rows) {
    if (row.kind !== "message" || row.message.visibility !== "customer")
      continue;
    integer(row.ordinal, "message.ordinal", 1);
    if (ordinals.has(row.ordinal))
      throw new SupportDeskConflictError("Duplicate message ordinal");
    ordinals.add(row.ordinal);
    if (latest === undefined || row.ordinal > latest.ordinal)
      latest = { messageId: row.message.id, ordinal: row.ordinal };
  }
  if (latest === undefined)
    throw new SupportDeskConflictError("Follow-up has no visible conversation");
  return latest;
}
export function engineeringFollowupWeb(
  loaded: EngineeringFollowupLoaded,
): void {
  const ticket = loaded.ticket.value.ticket;
  if (
    ticket.channel !== "web" ||
    ticket.requester.association !== "authenticated" ||
    ticket.requester.principalId === undefined
  )
    throw new SupportDeskConflictError(
      "Follow-up requires authenticated web support",
    );
}
export async function engineeringFollowupAssociation(
  deps: EngineeringFollowupDependencies,
  loaded: EngineeringFollowupLoaded,
  requested: { readonly repositoryId: string; readonly issueId: string },
  exact?: EngineeringFollowupAssociation,
) {
  const source = loaded.source.value;
  if (
    source.state === "withdrawn" ||
    source.security !== "ordinary" ||
    source.followupRevocationEpoch === undefined
  )
    throw new SupportDeskConflictError(
      "Follow-up parent authority unavailable",
    );
  for (const destination of source.destinations) {
    if (
      destination.repositoryId !== requested.repositoryId ||
      destination.outcome !== "accepted" ||
      destination.acknowledgement?.issueId !== requested.issueId ||
      destination.dispatchId === undefined ||
      destination.followupRevocationEpoch === undefined ||
      destination.followupRevocationEpoch !== source.followupRevocationEpoch
    )
      continue;
    const association: EngineeringFollowupAssociation = {
      ticketId: source.ticketId,
      repositoryId: destination.repositoryId,
      issueId: destination.acknowledgement.issueId,
      issueNumber: destination.acknowledgement.issueNumber,
      dispatchId: destination.dispatchId,
      requestHash: destination.requestHash,
      engineeringSourceGeneration: destination.sourceGeneration,
      followupRevocationEpoch: destination.followupRevocationEpoch,
    };
    if (exact !== undefined && canonical(association) !== canonical(exact))
      continue;
    const stored = await deps.records.getVersioned(
      engineeringWorkKey(source.ticketId, destination.sourceGeneration),
    );
    if (stored?.value.kind !== "engineering_work") continue;
    const work = stored.value;
    if (
      work.status !== "accepted" ||
      work.security !== "ordinary" ||
      work.product === undefined ||
      work.dispatch?.dispatchId !== destination.dispatchId ||
      work.stepId !== destination.stepId ||
      work.requestHash !== destination.requestHash ||
      work.acknowledgement?.repositoryId !== association.repositoryId ||
      work.acknowledgement.issueId !== association.issueId ||
      work.acknowledgement.issueNumber !== association.issueNumber
    )
      continue;
    return {
      association,
      engineeringWork: { value: work, version: stored.version },
    };
  }
  throw new SupportDeskConflictError(
    "Ordinary accepted follow-up association unavailable or revoked",
  );
}
export function engineeringFollowupProofContext(
  loaded: EngineeringFollowupLoaded,
  association: EngineeringFollowupAssociation,
): EngineeringFollowupProofContext {
  return {
    ticketId: association.ticketId,
    ticketRevision: loaded.ticket.value.ticket.revision,
    lastVisibleMessageId: engineeringFollowupLatestVisible(loaded).messageId,
    parentSourceGeneration: loaded.source.value.sourceGeneration,
    followupRevocationEpoch: association.followupRevocationEpoch,
    association,
  };
}
export function engineeringFollowupValidateProof(
  proof: VerifiedEngineeringFollowupContext | null,
  context: EngineeringFollowupProofContext,
  product: { readonly binding: string; readonly productId: string },
  now: () => number,
): asserts proof is VerifiedEngineeringFollowupContext {
  if (proof === null)
    throw new SupportDeskConflictError(
      "Follow-up deployment proof unavailable",
    );
  validateVerifiedEngineeringFollowupContext(proof);
  const attestation = fields(proof.attestation, "follow-up attestation", [
    "verifierReceiptId",
    "verifierVersion",
    "verifiedAt",
    "validUntil",
  ]);
  text(attestation.verifierReceiptId, "verifierReceiptId");
  text(attestation.verifierVersion, "verifierVersion");
  if (
    timestamp(attestation.verifiedAt, "verifiedAt") > now() ||
    timestamp(attestation.validUntil, "validUntil") <= now()
  )
    throw new SupportDeskConflictError("Follow-up proof expired");
  if (
    proof.context.issueHead.repositoryId !== context.association.repositoryId ||
    proof.context.issueHead.issueId !== context.association.issueId ||
    proof.context.issueHead.issueNumber !== context.association.issueNumber
  )
    throw new SupportDeskConflictError("Follow-up issue binding changed");
  const mapping = proof.context.mapping;
  if (
    mapping !== undefined &&
    (mapping.affectedProductBinding !== product.binding ||
      mapping.fixedProduct.productId !== product.productId ||
      mapping.issueHeadHash !== proof.context.issueHead.hash ||
      mapping.deploymentHeadHash !== proof.context.deploymentHead.hash)
  )
    throw new SupportDeskConflictError(
      "Follow-up mapping does not match product or current heads",
    );
}
export async function engineeringFollowupVersionsCurrent(
  deps: EngineeringFollowupDependencies,
  loaded: EngineeringFollowupLoaded,
  work?: EngineeringFollowupWorkVersion,
  associationWork?: {
    readonly value: { readonly partition: string; readonly id: string };
    readonly version: string;
  },
): Promise<boolean> {
  const compare = async (
    key: { partition: string; id: string },
    version: string | null,
  ) =>
    (await deps.records.getVersioned(key))?.version === (version ?? undefined);
  if (
    work !== undefined &&
    !(await compare(
      { partition: work.value.partition, id: work.value.id },
      work.version,
    ))
  )
    return false;
  if (
    associationWork !== undefined &&
    !(await compare(
      {
        partition: associationWork.value.partition,
        id: associationWork.value.id,
      },
      associationWork.version,
    ))
  )
    return false;
  if (
    !(await compare(
      engineeringFollowupHeadKey(loaded.source.value.ticketId),
      loaded.head?.version ?? null,
    ))
  )
    return false;
  if (
    !(await compare(
      { partition: loaded.ticket.value.partition, id: "ticket" },
      loaded.ticket.version,
    ))
  )
    return false;
  return compare(
    engineeringSourceKey(loaded.source.value.ticketId),
    loaded.source.version,
  );
}
export async function engineeringFollowupActive(
  deps: EngineeringFollowupDependencies,
  loaded: EngineeringFollowupLoaded,
  stored: EngineeringFollowupWorkVersion,
  now = engineeringFollowupNow(deps),
) {
  const work = stored.value;
  engineeringFollowupWeb(loaded);
  if (
    work.withdrawn ||
    timestamp(work.deadline, "deadline") <= now() ||
    work.security !== "ordinary" ||
    ["held", "restricted", "superseded", "delivered"].includes(work.status) ||
    work.context === undefined ||
    loaded.head === null ||
    loaded.head.value.withdrawn ||
    work.parentSourceGeneration !== loaded.source.value.sourceGeneration ||
    work.acceptedTicketRevision !== loaded.ticket.value.ticket.revision ||
    work.lastVisibleMessageId !==
      engineeringFollowupLatestVisible(loaded).messageId
  )
    throw new SupportDeskConflictError(
      "Follow-up work is held, withdrawn or stale",
    );
  const associated = await engineeringFollowupAssociation(
    deps,
    loaded,
    work.association,
    work.association,
  );
  const associationKey = await fingerprint({
    repositoryId: work.association.repositoryId,
    issueId: work.association.issueId,
  });
  const issue = loaded.head.value.associationHeads.find(
    (entry) => entry.associationKey === associationKey,
  )?.issueHead;
  const deployment = loaded.head.value.deploymentContexts.find(
    (entry) =>
      entry.associationKey === associationKey &&
      entry.deploymentHead.contextRef ===
        work.context!.deploymentHead.contextRef,
  );
  if (
    canonical(issue) !== canonical(work.context.issueHead) ||
    canonical(deployment?.deploymentHead) !==
      canonical(work.context.deploymentHead) ||
    work.context.issueHead.state !== "closed" ||
    work.context.deploymentHead.state !== "deployed" ||
    work.context.mapping === undefined ||
    deployment?.mappingHash !== (await fingerprint(work.context.mapping)) ||
    work.workBindingHash !==
      (await engineeringFollowupWorkBindingHash({
        association: work.association,
        parentSourceGeneration: work.parentSourceGeneration,
        acceptedTicketRevision: work.acceptedTicketRevision,
        lastVisibleMessageId: work.lastVisibleMessageId,
        context: work.context,
      })) ||
    timestamp(work.deadline, "deadline") <= now()
  )
    throw new SupportDeskConflictError(
      "Follow-up current heads or exact binding changed",
    );
  return {
    ...associated,
    proofContext: engineeringFollowupProofContext(
      loaded,
      associated.association,
    ),
  };
}
export async function engineeringFollowupCurrent(
  deps: EngineeringFollowupDependencies,
  loaded: EngineeringFollowupLoaded,
  stored: EngineeringFollowupWorkVersion,
  now = engineeringFollowupNow(deps),
) {
  const associated = await engineeringFollowupActive(deps, loaded, stored, now);
  if (deps.options.releaseEvidence === undefined)
    throw new SupportDeskConflictError(
      "Follow-up release verification unavailable",
    );
  const proof = snapshot(
    await engineeringFollowupTrusted(deps, (signal) =>
      deps.options.releaseEvidence!.confirm(
        stored.value.context!,
        associated.proofContext,
        signal,
      ),
    ),
  );
  engineeringFollowupValidateProof(
    proof,
    associated.proofContext,
    associated.engineeringWork.value.product!,
    now,
  );
  if (
    canonical(proof.context) !== canonical(stored.value.context) ||
    proof.context.mapping === undefined ||
    proof.context.deploymentHead.state !== "deployed" ||
    timestamp(stored.value.deadline, "deadline") <= now()
  )
    throw new SupportDeskConflictError("Follow-up deployment changed");
  return { ...associated, loaded, work: stored, proof };
}

export async function planEngineeringFollowupSourceChange(
  records: CollectionStore<SupportRecord>,
  context: EngineeringFollowupSourceChangeContext,
): Promise<EngineeringFollowupMutationPlan> {
  const rows = context.rows.filter(
    (row) => row.kind === "engineering_followup_work",
  );
  if (rows.length > 8)
    throw new SupportDeskConflictError("Follow-up history exceeds bound");
  const actions: EngineeringAction[] = [];
  const nextWorkRows: EngineeringFollowupWorkRecord[] = [];
  const whole =
    context.reason !== "security_restriction" ||
    context.previousSource.followupRevocationEpoch !==
      context.nextSource.followupRevocationEpoch ||
    context.previousSource.sourceGeneration !==
      context.nextSource.sourceGeneration ||
    context.previousSource.security !== context.nextSource.security ||
    context.previousSource.sourceBindingHash !==
      context.nextSource.sourceBindingHash;
  for (const hint of rows) {
    const stored = await records.getVersioned({
      partition: hint.partition,
      id: hint.id,
    });
    if (stored?.value.kind !== "engineering_followup_work")
      throw new SupportDeskConflictError("Follow-up child changed");
    const work = stored.value;
    const historicalRestriction = context.rows.some(
      (row) =>
        row.kind === "engineering_work" &&
        row.security !== "ordinary" &&
        row.sourceGeneration === work.association.engineeringSourceGeneration &&
        row.dispatch?.dispatchId === work.association.dispatchId &&
        row.acknowledgement?.issueId === work.association.issueId &&
        row.acknowledgement.repositoryId === work.association.repositoryId &&
        row.requestHash === work.association.requestHash,
    );
    if (!whole && !historicalRestriction) continue;
    const held =
      context.reason === "withdrawal"
        ? scrub(work, "parent_withdrawn")
        : holdEngineeringFollowupWork(work, context.reason);
    const next =
      context.reason === "security_restriction"
        ? { ...held, security: "restricted" as const }
        : held;
    if (next === work) continue;
    checkEngineeringFollowupRecordCapacity(next);
    nextWorkRows.push(next);
    actions.push({
      action: "putIfUnchanged",
      version: stored.version,
      value: next,
    });
  }
  const head = await records.getVersioned(
    engineeringFollowupHeadKey(context.previousSource.ticketId),
  );
  if (head !== null && (whole || nextWorkRows.length > 0)) {
    if (head.value.kind !== "engineering_followup_head")
      throw new SupportDeskConflictError("Follow-up head key collision");
    const next: EngineeringFollowupHeadRecord =
      context.reason === "withdrawal"
        ? {
            ...head.value,
            withdrawn: true,
            associationHeads: [],
            deploymentContexts: [],
            headGeneration: head.value.headGeneration + 1,
            heldReason: "parent_withdrawn",
          }
        : {
            ...head.value,
            headGeneration: head.value.headGeneration + 1,
            ...(whole ? { heldReason: context.reason } : {}),
          };
    const { lastObservation: _observation, ...retained } = next;
    checkEngineeringFollowupRecordCapacity(retained);
    actions.push({
      action: "putIfUnchanged",
      version: head.version,
      value: retained,
    });
  }
  return { actions, nextWorkRows };
}

export async function planEngineeringFollowupTicketMutation(
  records: CollectionStore<SupportRecord>,
  rows: readonly SupportRecord[],
  ticketId: string,
  reason: "visible_source_changed" | "reopened" | "approved_followup_notice",
  completedWorkId?: string,
): Promise<EngineeringFollowupMutationPlan> {
  const actions: EngineeringAction[] = [];
  const nextWorkRows: EngineeringFollowupWorkRecord[] = [];
  const hints = rows.filter((row) => row.kind === "engineering_followup_work");
  if (hints.length > 8)
    throw new SupportDeskConflictError("Follow-up history exceeds bound");
  for (const hint of hints) {
    if (hint.workId === completedWorkId || hint.status === "delivered")
      continue;
    const stored = await records.getVersioned({
      partition: ticketId,
      id: hint.id,
    });
    if (stored?.value.kind !== "engineering_followup_work")
      throw new SupportDeskConflictError("Follow-up child changed");
    const next = holdEngineeringFollowupWork(stored.value, reason);
    if (next === stored.value) continue;
    checkEngineeringFollowupRecordCapacity(next);
    nextWorkRows.push(next);
    actions.push({
      action: "putIfUnchanged",
      version: stored.version,
      value: next,
    });
  }
  return { actions, nextWorkRows };
}

export async function engineeringFollowupPlanHeads(
  head: EngineeringFollowupHeadRecord,
  context: EngineeringFollowupContext,
  now: string,
) {
  const associationKey = await fingerprint({
    repositoryId: context.issueHead.repositoryId,
    issueId: context.issueHead.issueId,
  });
  const oldIssue = head.associationHeads.find(
    (entry) => entry.associationKey === associationKey,
  );
  const oldDeployment = head.deploymentContexts.find(
    (entry) =>
      entry.associationKey === associationKey &&
      entry.deploymentHead.contextRef === context.deploymentHead.contextRef,
  );
  for (const [before, after] of [
    [oldIssue?.issueHead, context.issueHead],
    [oldDeployment?.deploymentHead, context.deploymentHead],
  ] as const) {
    if (before === undefined) continue;
    if (after.generation < before.generation)
      return { stale: true as const, head, associationKey };
    if (
      after.generation === before.generation &&
      (after.hash !== before.hash || canonical(after) !== canonical(before))
    )
      throw new SupportDeskConflictError(
        "Equal follow-up head generations have different facts",
      );
  }
  if (
    (oldIssue === undefined && head.associationHeads.length >= 4) ||
    (oldDeployment === undefined && head.deploymentContexts.length >= 8)
  )
    return {
      stale: false as const,
      capacity: true as const,
      head: {
        ...head,
        headGeneration: head.headGeneration + 1,
        updatedAt: now,
        heldReason: "followup_context_capacity",
      },
      associationKey,
      oldIssue: oldIssue?.issueHead,
      oldDeployment: oldDeployment?.deploymentHead,
    };
  const { heldReason: _reason, ...clean } = head;
  const mappingHash =
    context.mapping === undefined
      ? undefined
      : await fingerprint(context.mapping);
  const next: EngineeringFollowupHeadRecord = {
    ...clean,
    headGeneration: head.headGeneration + 1,
    updatedAt: now,
    associationHeads:
      oldIssue === undefined
        ? [
            ...head.associationHeads,
            { associationKey, issueHead: context.issueHead },
          ]
        : head.associationHeads.map((entry) =>
            entry === oldIssue
              ? { associationKey, issueHead: context.issueHead }
              : entry,
          ),
    deploymentContexts:
      oldDeployment === undefined
        ? [
            ...head.deploymentContexts,
            {
              associationKey,
              deploymentHead: context.deploymentHead,
              ...(mappingHash === undefined
                ? { heldReason: "awaiting_deployment" }
                : { mappingHash }),
            },
          ]
        : head.deploymentContexts.map((entry) =>
            entry === oldDeployment
              ? {
                  associationKey,
                  deploymentHead: context.deploymentHead,
                  ...(mappingHash === undefined
                    ? { heldReason: "awaiting_deployment" }
                    : { mappingHash }),
                }
              : entry,
          ),
  };
  return {
    stale: false as const,
    capacity: false as const,
    head: next,
    associationKey,
    oldIssue: oldIssue?.issueHead,
    oldDeployment: oldDeployment?.deploymentHead,
  };
}

type SourceMethods = Pick<
  EngineeringFollowupApplication,
  | "scanEngineeringFollowups"
  | "observeEngineeringFollowup"
  | "readEngineeringFollowupWork"
  | "confirmEngineeringFollowupCurrent"
  | "readEngineeringFollowupReassessment"
>;

export function createEngineeringFollowupSourceServices(
  deps: EngineeringFollowupDependencies,
) {
  const { records, clock, options } = deps;
  const load: EngineeringFollowupLoad = async (ticketId) => {
    text(ticketId, "ticketId");
    const ticket = await records.getVersioned({
      partition: ticketId,
      id: "ticket",
    });
    const source = await records.getVersioned(engineeringSourceKey(ticketId));
    const head = await records.getVersioned(
      engineeringFollowupHeadKey(ticketId),
    );
    if (
      ticket?.value.kind !== "ticket" ||
      source?.value.kind !== "engineering_source"
    )
      throw new SupportDeskNotFoundError();
    if (head !== null && head.value.kind !== "engineering_followup_head")
      throw new SupportDeskConflictError("Follow-up head key collision");
    const rows = await records.list(ticketId);
    if (rows.length > deps.limits.maxRecordsPerTicket)
      throw new SupportDeskLimitError(
        "ticket_partition",
        deps.limits.maxRecordsPerTicket,
      );
    return {
      ticket: { value: ticket.value, version: ticket.version },
      source: { value: source.value, version: source.version },
      head:
        head === null
          ? null
          : {
              value: head.value as EngineeringFollowupHeadRecord,
              version: head.version,
            },
      rows,
    };
  };
  const workAt = async (key: {
    readonly ticketId: string;
    readonly workId: string;
  }): Promise<EngineeringFollowupWorkVersion> => {
    text(key.workId, "workId");
    const work = await records.getVersioned(
      engineeringFollowupWorkKey(key.ticketId, key.workId),
    );
    if (work?.value.kind !== "engineering_followup_work")
      throw new SupportDeskNotFoundError();
    return { value: work.value, version: work.version };
  };
  async function reassessment(
    key: { readonly ticketId: string; readonly workId: string },
    now = engineeringFollowupNow(deps),
  ) {
    const loaded = await load(key.ticketId);
    const work = await workAt(key);
    const value = work.value;
    engineeringFollowupWeb(loaded);
    if (
      value.withdrawn ||
      value.status === "delivered" ||
      value.security !== "ordinary" ||
      value.context === undefined ||
      (value.candidate === undefined && value.preparedBundle === undefined)
    )
      throw new SupportDeskConflictError(
        "Follow-up has no eligible retained draft",
      );
    const associated = await engineeringFollowupAssociation(
      deps,
      loaded,
      value.semanticIdentity,
    );
    const proofContext = engineeringFollowupProofContext(
      loaded,
      associated.association,
    );
    if (options.releaseEvidence === undefined)
      throw new SupportDeskConflictError(
        "Follow-up release verification unavailable",
      );
    const proof = snapshot(
      await engineeringFollowupTrusted(deps, (signal) =>
        options.releaseEvidence!.confirm(value.context!, proofContext, signal),
      ),
    );
    engineeringFollowupValidateProof(
      proof,
      proofContext,
      associated.engineeringWork.value.product!,
      now,
    );
    if (
      proof.context.issueHead.state !== "closed" ||
      proof.context.deploymentHead.state !== "deployed" ||
      proof.context.mapping === undefined ||
      proof.context.issueHead.repositoryId !==
        value.semanticIdentity.repositoryId ||
      proof.context.issueHead.issueId !== value.semanticIdentity.issueId ||
      proof.context.mapping.semanticMappingId !==
        value.semanticIdentity.semanticMappingId ||
      proof.context.deploymentHead.deploymentEpoch !==
        value.semanticIdentity.deploymentEpoch
    )
      throw new SupportDeskConflictError(
        "Follow-up reassessment deployment or semantic identity changed",
      );
    if (loaded.head === null || loaded.head.value.withdrawn)
      throw new SupportDeskConflictError(
        "Follow-up reassessment head unavailable",
      );
    const nextHead = await engineeringFollowupPlanHeads(
      loaded.head.value,
      proof.context,
      clock.now(),
    );
    if (nextHead.stale || nextHead.capacity)
      throw new SupportDeskConflictError(
        "Follow-up reassessment proof is stale or exceeds context capacity",
      );
    const prospective = {
      association: associated.association,
      parentSourceGeneration: loaded.source.value.sourceGeneration,
      acceptedTicketRevision: loaded.ticket.value.ticket.revision,
      lastVisibleMessageId: proofContext.lastVisibleMessageId,
      context: proof.context,
    };
    return {
      loaded,
      work,
      ...associated,
      proofContext,
      proof,
      prospective,
      nextHead: nextHead.head,
      prospectiveWorkBindingHash:
        await engineeringFollowupWorkBindingHash(prospective),
    };
  }
  const application: SourceMethods = {
    async scanEngineeringFollowups(access, input) {
      const actorId = access.principalId;
      const rights = () => {
        text(actorId, "principalId");
        if (access.principalId !== actorId)
          throw new SupportDeskAuthorizationError(
            supportPermissions.engineeringFollowupProcess,
          );
        const process = hasPermission(
          access,
          supportPermissions.engineeringFollowupProcess,
        );
        const review =
          hasPermission(access, supportPermissions.engineeringFollowupReview) &&
          hasPermission(access, supportPermissions.queueRead);
        if (!process && !review)
          throw new SupportDeskAuthorizationError(
            supportPermissions.engineeringFollowupProcess,
          );
        return {
          process,
          review,
          restricted:
            review &&
            hasPermission(access, supportPermissions.engineeringRestrictedRead),
        };
      };
      const initial = rights();
      const bounds = snapshot(
        fields(input, "follow-up scan", ["limit"], ["cursor"]),
      );
      integer(bounds.limit, "limit", 1, 64);
      if (bounds.cursor !== undefined) text(bounds.cursor, "cursor", 20_000);
      const page = await records.scan({
        limit: bounds.limit as number,
        ...(bounds.cursor === undefined
          ? {}
          : { cursor: bounds.cursor as string }),
      });
      if (page.records.length > (bounds.limit as number))
        throw new TypeError("Follow-up scan exceeded physical row bound");
      rights();
      const associations: EngineeringFollowupAssociation[] = [];
      const candidates: { ticketId: string; workId: string }[] = [];
      const reviewCandidates: { ticketId: string; workId: string }[] = [];
      const attention = new Set<string>();
      const restricted = new Set<string>();
      const sources = new Map<string, Promise<SupportRecord | null>>();
      const sourceFor = (ticketId: string) => {
        let pending = sources.get(ticketId);
        if (pending === undefined) {
          pending = records.get(engineeringSourceKey(ticketId));
          sources.set(ticketId, pending);
        }
        return pending;
      };
      for (const row of page.records) {
        if (row.value.kind === "engineering_source") {
          const source = row.value;
          if (
            row.key.partition !== source.ticketId ||
            row.key.id !== "engineering-source"
          )
            throw new TypeError("Follow-up scan source identity mismatch");
          if (source.state === "withdrawn") continue;
          if (
            source.security !== "ordinary" ||
            source.followupRevocationEpoch === undefined
          ) {
            if (initial.review)
              (source.security === "ordinary" ? attention : restricted).add(
                source.ticketId,
              );
            continue;
          }
          for (const destination of source.destinations)
            if (
              destination.outcome === "accepted" &&
              destination.dispatchId !== undefined &&
              destination.followupRevocationEpoch !== undefined &&
              destination.followupRevocationEpoch ===
                source.followupRevocationEpoch &&
              destination.acknowledgement !== undefined
            )
              associations.push({
                ticketId: source.ticketId,
                repositoryId: destination.repositoryId,
                issueId: destination.acknowledgement.issueId,
                issueNumber: destination.acknowledgement.issueNumber,
                dispatchId: destination.dispatchId,
                requestHash: destination.requestHash,
                engineeringSourceGeneration: destination.sourceGeneration,
                followupRevocationEpoch: destination.followupRevocationEpoch,
              });
        } else if (row.value.kind === "engineering_followup_work") {
          const work = row.value;
          if (row.key.partition !== work.ticketId || row.key.id !== work.id)
            throw new TypeError("Follow-up scan work identity mismatch");
          if (work.withdrawn || work.status === "delivered") continue;
          if (work.security !== "ordinary") {
            if (initial.review) restricted.add(work.ticketId);
            continue;
          }
          const source = await sourceFor(work.ticketId);
          if (
            source?.kind !== "engineering_source" ||
            source.state === "withdrawn"
          )
            continue;
          if (source.security !== "ordinary") {
            if (initial.review) restricted.add(work.ticketId);
            continue;
          }
          const key = { ticketId: work.ticketId, workId: work.workId };
          if (
            ["held", "superseded", "restricted", "bundle_prepared"].includes(
              work.status,
            ) ||
            timestamp(work.deadline, "deadline") <=
              timestamp(clock.now(), "now")
          ) {
            if (initial.review) reviewCandidates.push(key);
          } else if (
            source.followupRevocationEpoch ===
              work.association.followupRevocationEpoch &&
            initial.process &&
            (work.retryAt === undefined ||
              timestamp(work.retryAt, "retryAt") <=
                timestamp(clock.now(), "now"))
          )
            candidates.push(key);
        }
      }
      const final = rights();
      return {
        associations: final.process ? associations : [],
        candidates: final.process ? candidates : [],
        reviewCandidates: final.review ? reviewCandidates : [],
        attentionSources: final.review
          ? [
              ...new Set([
                ...attention,
                ...(final.restricted ? restricted : []),
              ]),
            ]
          : [],
        physicalRows: page.records.length,
        pages: 1,
        nextCursor: page.nextCursor,
      };
    },
    async readEngineeringFollowupWork(access, input) {
      const actorId = access.principalId;
      engineeringFollowupPermission(
        access,
        supportPermissions.engineeringFollowupRead,
        actorId,
        true,
      );
      const key = snapshot(
        fields(input, "follow-up key", ["ticketId", "workId"]),
      ) as unknown as typeof input;
      text(key.ticketId, "ticketId");
      text(key.workId, "workId");
      for (let attempt = 0; attempt < deps.maxConflictAttempts; attempt += 1) {
        const loaded = await load(key.ticketId);
        const stored = await workAt(key);
        if (
          loaded.source.value.security !== "ordinary" ||
          stored.value.security !== "ordinary"
        )
          engineeringFollowupPermission(
            access,
            supportPermissions.engineeringRestrictedRead,
            actorId,
            true,
          );
        if (!(await engineeringFollowupVersionsCurrent(deps, loaded, stored)))
          continue;
        engineeringFollowupPermission(
          access,
          supportPermissions.engineeringFollowupRead,
          actorId,
          true,
        );
        if (
          loaded.source.value.security !== "ordinary" ||
          stored.value.security !== "ordinary"
        )
          engineeringFollowupPermission(
            access,
            supportPermissions.engineeringRestrictedRead,
            actorId,
            true,
          );
        return snapshot(stored.value);
      }
      throw new SupportDeskConflictError();
    },
    async confirmEngineeringFollowupCurrent(access, input) {
      const actorId = access.principalId;
      const authorize = () => {
        if (
          hasPermission(access, supportPermissions.engineeringFollowupProcess)
        )
          engineeringFollowupPermission(
            access,
            supportPermissions.engineeringFollowupProcess,
            actorId,
          );
        else
          engineeringFollowupPermission(
            access,
            supportPermissions.engineeringFollowupReview,
            actorId,
            true,
          );
      };
      authorize();
      const command = snapshot(
        fields(input, "follow-up current fence", [
          "ticketId",
          "workId",
          "workBindingHash",
          "expectedWorkGeneration",
        ]),
      ) as unknown as typeof input;
      text(command.ticketId, "ticketId");
      text(command.workId, "workId");
      text(command.workBindingHash, "workBindingHash");
      integer(command.expectedWorkGeneration, "expectedWorkGeneration", 1);
      const now = engineeringFollowupNow(deps);
      try {
        const loaded = await load(command.ticketId);
        const work = await workAt(command);
        const active = await engineeringFollowupActive(deps, loaded, work, now);
        const okay =
          work.value.workBindingHash === command.workBindingHash &&
          work.value.workGeneration === command.expectedWorkGeneration &&
          (await engineeringFollowupVersionsCurrent(
            deps,
            loaded,
            work,
            active.engineeringWork,
          )) &&
          timestamp(work.value.deadline, "deadline") > now();
        authorize();
        return okay;
      } catch (error) {
        authorize();
        if (
          error instanceof SupportDeskConflictError ||
          error instanceof SupportDeskNotFoundError
        )
          return false;
        throw error;
      }
    },
    async readEngineeringFollowupReassessment(access, input) {
      const actorId = access.principalId;
      const authorize = () => {
        engineeringFollowupPermission(
          access,
          supportPermissions.engineeringFollowupRead,
          actorId,
          true,
        );
        engineeringFollowupPermission(
          access,
          supportPermissions.engineeringFollowupReview,
          actorId,
          true,
        );
      };
      authorize();
      const key = snapshot(
        fields(input, "follow-up reassessment key", ["ticketId", "workId"]),
      ) as unknown as typeof input;
      text(key.ticketId, "ticketId");
      text(key.workId, "workId");
      const now = engineeringFollowupNow(deps);
      for (let attempt = 0; attempt < deps.maxConflictAttempts; attempt += 1) {
        const current = await reassessment(key, now);
        if (
          !(await engineeringFollowupVersionsCurrent(
            deps,
            current.loaded,
            current.work,
            current.engineeringWork,
          ))
        )
          continue;
        authorize();
        if (
          now() >= timestamp(current.proof.attestation.validUntil, "validUntil")
        )
          throw new SupportDeskConflictError("Follow-up reassessment expired");
        return {
          work: snapshot(current.work.value),
          proofContext: current.proofContext,
          proof: current.proof,
          prospectiveWorkBindingHash: current.prospectiveWorkBindingHash,
          workGeneration: current.work.value.workGeneration,
        };
      }
      throw new SupportDeskConflictError();
    },
    async observeEngineeringFollowup(access, input) {
      const actorId = access.principalId;
      const authorize = () =>
        engineeringFollowupPermission(
          access,
          supportPermissions.engineeringFollowupEvidenceSubmit,
          actorId,
        );
      authorize();
      const command = snapshot(
        fields(input, "observe follow-up", [
          "ticketId",
          "commandId",
          "correlationId",
          "association",
          "inputReference",
        ]),
      ) as unknown as typeof input;
      for (const value of [
        command.ticketId,
        command.commandId,
        command.correlationId,
        command.inputReference,
      ])
        text(value, "observation identity");
      fields(command.association, "observation association", [
        "repositoryId",
        "issueId",
      ]);
      text(command.association.repositoryId, "repositoryId");
      text(command.association.issueId, "issueId");
      const hash = await fingerprint({ actorId, command });
      const now = engineeringFollowupNow(deps);
      for (let attempt = 0; attempt < deps.maxConflictAttempts; attempt += 1) {
        const prior = await records.get(
          engineeringFollowupCommandKey(command.ticketId, command.commandId),
        );
        authorize();
        if (prior !== null) {
          if (
            prior.kind !== "engineering_followup_receipt" ||
            prior.fingerprint !== hash ||
            !("headGeneration" in prior.result)
          )
            throw new SupportDeskConflictError("Follow-up command reused");
          return snapshot(prior.result);
        }
        const admitted = await (async () => {
          const loaded = await load(command.ticketId);
          engineeringFollowupWeb(loaded);
          return {
            loaded,
            associated: await engineeringFollowupAssociation(
              deps,
              loaded,
              command.association,
            ),
          };
        })().catch((error: unknown) => {
          authorize();
          if (
            error instanceof SupportDeskConflictError ||
            error instanceof SupportDeskNotFoundError
          )
            return null;
          throw error;
        });
        if (admitted === null) {
          authorize();
          return {
            ticketId: command.ticketId,
            headGeneration: 0,
            outcome: "held",
            reason: "association_unavailable",
          };
        }
        const { loaded, associated } = admitted;
        const proofContext = engineeringFollowupProofContext(
          loaded,
          associated.association,
        );
        if (options.releaseEvidence === undefined) {
          authorize();
          return {
            ticketId: command.ticketId,
            headGeneration: loaded.head?.value.headGeneration ?? 0,
            outcome: "held",
            reason: "release_verification_unavailable",
          };
        }
        let proof: VerifiedEngineeringFollowupContext;
        try {
          const verified = snapshot(
            await engineeringFollowupTrusted(deps, (signal) =>
              options.releaseEvidence!.verifyInput(
                command.inputReference,
                proofContext,
                signal,
              ),
            ),
          );
          engineeringFollowupValidateProof(
            verified,
            proofContext,
            associated.engineeringWork.value.product!,
            now,
          );
          const current = snapshot(
            await engineeringFollowupTrusted(deps, (signal) =>
              options.releaseEvidence!.confirm(
                verified.context,
                proofContext,
                signal,
              ),
            ),
          );
          engineeringFollowupValidateProof(
            current,
            proofContext,
            associated.engineeringWork.value.product!,
            now,
          );
          proof = current;
        } catch {
          authorize();
          return {
            ticketId: command.ticketId,
            headGeneration: loaded.head?.value.headGeneration ?? 0,
            outcome: "held",
            reason: "deployment_unverified",
          };
        }
        const oldHead: EngineeringFollowupHeadRecord = loaded.head?.value ?? {
          kind: "engineering_followup_head",
          partition: command.ticketId,
          id: "engineering-followup-head",
          ticketId: command.ticketId,
          headGeneration: 0,
          createdAt: clock.now(),
          updatedAt: clock.now(),
          workCount: 0,
          associationHeads: [],
          deploymentContexts: [],
        };
        const planned = await engineeringFollowupPlanHeads(
          oldHead,
          proof.context,
          clock.now(),
        );
        if (planned.stale) {
          authorize();
          return {
            ticketId: command.ticketId,
            headGeneration: oldHead.headGeneration,
            outcome: "stale",
          };
        }
        const workHints = loaded.rows.filter(
          (row) => row.kind === "engineering_followup_work",
        );
        if (workHints.length > options.maxWorksets)
          throw new SupportDeskConflictError(
            "Follow-up work count exceeds bound",
          );
        const affected = workHints.filter(
          (work) =>
            !work.withdrawn &&
            work.status !== "delivered" &&
            (planned.capacity ||
              (work.association.repositoryId ===
                command.association.repositoryId &&
                work.association.issueId === command.association.issueId)),
        );
        const negative =
          planned.capacity ||
          proof.context.issueHead.state !== "closed" ||
          proof.context.deploymentHead.state !== "deployed" ||
          proof.context.mapping === undefined;
        const unchanged =
          !planned.capacity &&
          canonical(oldHead.associationHeads) ===
            canonical(planned.head.associationHeads) &&
          canonical(oldHead.deploymentContexts) ===
            canonical(planned.head.deploymentContexts);
        const semanticIdentity =
          negative || proof.context.mapping === undefined
            ? undefined
            : {
                repositoryId: command.association.repositoryId,
                issueId: command.association.issueId,
                semanticMappingId: proof.context.mapping.semanticMappingId,
                deploymentEpoch: proof.context.deploymentHead.deploymentEpoch,
              };
        const semanticWorkId =
          semanticIdentity === undefined
            ? undefined
            : await engineeringFollowupWorkId(semanticIdentity);
        const semanticWork =
          semanticWorkId === undefined
            ? null
            : await records.get(
                engineeringFollowupWorkKey(command.ticketId, semanticWorkId),
              );
        const missingWorkCanQueue =
          options.enabled &&
          semanticWorkId !== undefined &&
          semanticWork === null &&
          oldHead.workCount < options.maxWorksets;
        if (unchanged && !missingWorkCanQueue) {
          authorize();
          return {
            ticketId: command.ticketId,
            headGeneration: oldHead.headGeneration,
            outcome: "unchanged",
          };
        }
        const actions: EngineeringAction[] = [];
        const nextWorkRows: EngineeringFollowupWorkRecord[] = [];
        let workId: string | undefined;
        let queued = false;
        for (const hint of affected) {
          const stored = await workAt(hint);
          const next = holdEngineeringFollowupWork(
            stored.value,
            negative
              ? "release_reassessment_required"
              : "release_context_changed",
          );
          if (next !== stored.value) {
            nextWorkRows.push(next);
            actions.push({
              action: "putIfUnchanged",
              version: stored.version,
              value: next,
            });
          }
        }
        let head = planned.head;
        if (
          semanticIdentity !== undefined &&
          semanticWorkId !== undefined &&
          options.enabled
        ) {
          workId = semanticWorkId;
          if (
            semanticWork === null &&
            oldHead.workCount < options.maxWorksets
          ) {
            const context = proof.context;
            const binding = {
              association: associated.association,
              parentSourceGeneration: loaded.source.value.sourceGeneration,
              acceptedTicketRevision: loaded.ticket.value.ticket.revision,
              lastVisibleMessageId: proofContext.lastVisibleMessageId,
              context,
            };
            const work: EngineeringFollowupWorkRecord = {
              kind: "engineering_followup_work",
              partition: command.ticketId,
              id: engineeringFollowupWorkKey(command.ticketId, workId).id,
              ticketId: command.ticketId,
              workId,
              semanticIdentity,
              ...binding,
              workBindingHash:
                await engineeringFollowupWorkBindingHash(binding),
              workGeneration: 1,
              security: "ordinary",
              createdAt: clock.now(),
              deadline: new Date(
                now() + options.maxWorkMilliseconds,
              ).toISOString(),
              status: "pending",
              stage: "model",
              modelAttempts: [],
              claimGeneration: 0,
              bundleRevision: 0,
              completionRows: 5,
              messageSlots: 1,
              retestResults: [],
            };
            reserveEngineeringFollowupReachable(work);
            nextWorkRows.push(work);
            actions.push({ action: "insert", value: work });
            queued = true;
            head = { ...head, workCount: oldHead.workCount + 1 };
          } else if (semanticWork === null)
            head = { ...head, heldReason: "followup_capacity" };
        }
        const result = {
          ticketId: command.ticketId,
          headGeneration: head.headGeneration,
          ...(workId === undefined ? {} : { workId }),
          outcome: queued ? ("queued" as const) : ("held" as const),
          ...(queued
            ? {}
            : {
                reason: negative
                  ? "awaiting_deployment"
                  : "staff_reassessment_required",
              }),
        };
        head = { ...head, lastObservation: { fingerprint: hash, result } };
        checkEngineeringFollowupRecordCapacity(head);
        const insertedWorks = nextWorkRows.filter(
          (next) => !loaded.rows.some((old) => old.id === next.id),
        ).length;
        deps.admission(
          loaded.ticket.value.ticket,
          loaded.rows,
          nextWorkRows,
          2 + insertedWorks + (loaded.head === null ? 1 : 0),
        );
        if (
          !(await engineeringFollowupVersionsCurrent(
            deps,
            loaded,
            undefined,
            associated.engineeringWork,
          ))
        )
          continue;
        authorize();
        if (now() >= timestamp(proof.attestation.validUntil, "validUntil"))
          throw new SupportDeskConflictError("Follow-up observation expired");
        const receipt = {
          kind: "engineering_followup_receipt" as const,
          partition: command.ticketId,
          id: engineeringFollowupCommandKey(command.ticketId, command.commandId)
            .id,
          fingerprint: hash,
          result,
        };
        checkEngineeringFollowupRecordCapacity(receipt);
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
                value: loaded.source.value,
              },
              loaded.head === null
                ? { action: "insert", value: head }
                : {
                    action: "putIfUnchanged",
                    version: loaded.head.version,
                    value: head,
                  },
              ...actions,
              deps.audit(
                command,
                loaded.ticket.value.ticket,
                actorId,
                clock.now(),
                supportTicketAuditActions.engineeringFollowupObserved,
              ),
              { action: "insert", value: receipt },
            ])
          ).committed
        ) {
          authorize();
          return result;
        }
      }
      throw new SupportDeskConflictError();
    },
  };
  return {
    application,
    internal: {
      load,
      workAt,
      reassessment,
      current: async (
        key: { ticketId: string; workId: string },
        now?: () => number,
      ) =>
        engineeringFollowupCurrent(
          deps,
          await load(key.ticketId),
          await workAt(key),
          now,
        ),
      versionsCurrent: (
        loaded: EngineeringFollowupLoaded,
        work?: EngineeringFollowupWorkVersion,
      ) => engineeringFollowupVersionsCurrent(deps, loaded, work),
    },
  };
}
