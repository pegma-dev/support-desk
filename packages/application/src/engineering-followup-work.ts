import type { AccessContext } from "@pegma/authorization-core";
import {
  engineeringMutationBoundary,
  type EngineeringMutationBoundary,
} from "./engineering-mutation-guard.js";
import {
  SupportDeskConflictError,
  SupportDeskNotFoundError,
  supportPermissions,
  supportTicketAuditActions,
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
  safeEngineeringFollowupSnapshot as snapshot,
  checkEngineeringFollowupRecordCapacity,
  reserveEngineeringFollowupReachable,
  engineeringFollowupWorkKey,
  engineeringFollowupCommandKey,
  validateEngineeringFollowupCandidate,
  validateEngineeringFollowupBundle,
  validateEngineeringFollowupModelBinding,
  engineeringFollowupModelManifestHash,
  engineeringFollowupContextHash,
  engineeringFollowupPublicFactsHash,
  engineeringFollowupChecksBinding,
  engineeringFollowupRetestProductBinding,
  engineeringFollowupRetestRequestHash,
  engineeringFollowupRetestRequestId,
  engineeringFollowupRetestSummary,
  engineeringFollowupModelAttemptCount,
  type EngineeringFollowupWorkRecord,
} from "./engineering-followup-records.js";
import {
  createEngineeringFollowupSourceServices,
  engineeringFollowupPermission as permission,
  engineeringFollowupObservation,
  engineeringFollowupNow,
  engineeringFollowupTrusted,
  engineeringFollowupResult as result,
  engineeringFollowupWithoutLease as withoutLease,
  engineeringFollowupCurrent,
  engineeringFollowupVersionsCurrent,
  holdEngineeringFollowupWork,
  engineeringFollowupAssociation,
  engineeringFollowupProofContext,
  engineeringFollowupValidateProof,
  planEngineeringFollowupContextChange,
} from "./engineering-followup-source.js";
import type {
  EngineeringFollowupDependencies,
  EngineeringFollowupLoad,
  EngineeringFollowupLoaded,
  EngineeringFollowupWorkVersion,
  EngineeringFollowupReassessmentSeed,
} from "./engineering-followup-internal.js";
import type {
  EngineeringFollowupApplication,
  EngineeringFollowupClaimFence,
  EngineeringFollowupBundle,
  EngineeringFollowupResult,
  PrepareEngineeringFollowupBundleCommand,
  EngineeringFollowupReassessmentObservation,
} from "./engineering-followup-types.js";
import { engineeringSourceKey } from "./engineering-records.js";
import type { EngineeringAction } from "./engineering-internal.js";
import type {
  EngineeringCommand,
  EngineeringMutationOptions,
  EngineeringProcessing,
} from "./engineering-types.js";

type Methods = Pick<
  EngineeringFollowupApplication,
  | "claimEngineeringFollowupWork"
  | "prepareEngineeringFollowupModel"
  | "completeEngineeringFollowupModel"
  | "finishEngineeringFollowupModel"
  | "prepareEngineeringFollowupBundle"
  | "reassessEngineeringFollowupBundle"
  | "rejectEngineeringFollowupBundle"
  | "submitEngineeringFollowupRetestResult"
  | "recoverEngineeringFollowupPreparation"
  | "retryEngineeringFollowupWork"
  | "abandonEngineeringFollowupWork"
>;

function validateFence(command: EngineeringFollowupClaimFence): void {
  for (const value of [
    command.ticketId,
    command.workId,
    command.workerId,
    command.claimId,
  ])
    text(value, "follow-up claim identity");
  integer(command.claimGeneration, "claimGeneration", 1);
}
function sameClaim(
  work: EngineeringFollowupWorkRecord,
  fence: EngineeringFollowupClaimFence,
): boolean {
  return (
    canonical(work.claim) ===
    canonical({
      ticketId: fence.ticketId,
      workId: fence.workId,
      workerId: fence.workerId,
      claimId: fence.claimId,
      claimGeneration: fence.claimGeneration,
    })
  );
}
function processing(value: EngineeringProcessing | undefined): void {
  if (value === undefined) return;
  const input = fields(
    value,
    "follow-up processing",
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
      integer(entry, key, 0);
    else text(entry, key);
}
function live(
  work: EngineeringFollowupWorkRecord,
  command: EngineeringFollowupClaimFence,
  now: number,
): void {
  if (
    !sameClaim(work, command) ||
    work.leaseUntil === undefined ||
    timestamp(work.leaseUntil, "leaseUntil") <= now ||
    timestamp(work.deadline, "deadline") <= now
  )
    throw new SupportDeskConflictError("Follow-up claim expired or changed");
}
function compactModelAttempts(
  work: EngineeringFollowupWorkRecord,
): EngineeringFollowupWorkRecord {
  const history = new Map(
    (work.usageTombstones ?? []).map((entry) => [
      canonical([entry.stepId, entry.requestHash]),
      entry,
    ]),
  );
  for (const entry of work.modelAttempts)
    history.set(canonical([entry.stepId, entry.requestHash]), {
      stepId: entry.stepId,
      requestHash: entry.requestHash,
      usageReservationId: entry.binding.usageReservationId,
      accounting: entry.accounting,
    });
  return { ...work, modelAttempts: [], usageTombstones: [...history.values()] };
}

export function createEngineeringFollowupWorkServices(
  deps: EngineeringFollowupDependencies,
  load: EngineeringFollowupLoad,
) {
  const { records, clock, options } = deps;
  const sourceServices = createEngineeringFollowupSourceServices(deps);
  async function workAt(key: {
    readonly ticketId: string;
    readonly workId: string;
  }): Promise<EngineeringFollowupWorkVersion> {
    const work = await records.getVersioned(
      engineeringFollowupWorkKey(key.ticketId, key.workId),
    );
    if (work?.value.kind !== "engineering_followup_work")
      throw new SupportDeskNotFoundError();
    return { value: work.value, version: work.version };
  }
  async function save(
    loaded: EngineeringFollowupLoaded,
    work: EngineeringFollowupWorkVersion,
    next: EngineeringFollowupWorkRecord,
    extra: readonly EngineeringAction[] = [],
    nextHead = loaded.head?.value,
    mutation?: EngineeringMutationBoundary,
    beforeCommit?: () => void,
  ): Promise<boolean> {
    if (loaded.head === null || nextHead === undefined)
      throw new SupportDeskConflictError("Follow-up head disappeared");
    checkEngineeringFollowupRecordCapacity(next);
    checkEngineeringFollowupRecordCapacity(nextHead);
    if (mutation !== undefined) {
      const assertHostCurrent = await mutation.verify();
      assertHostCurrent();
      beforeCommit?.();
      mutation.ensure();
    }
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
          value: loaded.source.value,
        },
        {
          action: "putIfUnchanged",
          version: loaded.head.version,
          value: nextHead,
        },
        { action: "putIfUnchanged", version: work.version, value: next },
        ...extra,
      ])
    ).committed;
  }
  function receipt(
    command: EngineeringCommand,
    hash: string,
    outcome:
      | EngineeringFollowupResult
      | {
          ticketId: string;
          workId: string;
          outcome: "recorded" | "unchanged" | "held";
          result: "passed" | "failed";
        },
    recoveryFingerprint?: string,
  ): EngineeringAction {
    const row = {
      kind: "engineering_followup_receipt" as const,
      partition: command.ticketId,
      id: engineeringFollowupCommandKey(command.ticketId, command.commandId).id,
      fingerprint: hash,
      result: outcome,
      ...(recoveryFingerprint === undefined ? {} : { recoveryFingerprint }),
    };
    checkEngineeringFollowupRecordCapacity(row);
    return { action: "insert", value: row };
  }
  async function replay(command: EngineeringCommand, hash: string) {
    const prior = await records.get(
      engineeringFollowupCommandKey(command.ticketId, command.commandId),
    );
    if (prior === null) return null;
    if (
      prior.kind !== "engineering_followup_receipt" ||
      prior.fingerprint !== hash
    )
      throw new SupportDeskConflictError("Follow-up command ID reused");
    return snapshot(prior.result);
  }
  function messages(
    loaded: EngineeringFollowupLoaded,
    work: EngineeringFollowupWorkRecord,
  ) {
    const ordinals = new Set<number>();
    return loaded.rows
      .flatMap((row) => {
        if (
          row.kind !== "message" ||
          row.message.visibility !== "customer" ||
          row.ordinal > work.acceptedTicketRevision
        )
          return [];
        if (ordinals.has(row.ordinal))
          throw new SupportDeskConflictError(
            "Duplicate visible message ordinal",
          );
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
      .sort((left, right) => left.ordinal - right.ordinal);
  }
  async function verifyBundle(
    work: EngineeringFollowupWorkRecord,
    bundle: EngineeringFollowupBundle,
    candidateHash: string,
    checkPolicyVersion: string,
    checksReceipt: string,
    now: () => number,
  ) {
    if (work.context === undefined || options.checks === undefined)
      throw new SupportDeskConflictError(
        "Independent follow-up checks unavailable",
      );
    validateEngineeringFollowupBundle(bundle);
    const binding = await engineeringFollowupChecksBinding({
      workBindingHash: work.workBindingHash,
      candidateHash,
      exactBundle: bundle,
      checkPolicyVersion,
      followupRevocationEpoch: work.association.followupRevocationEpoch,
      context: work.context,
    });
    const productBinding = await engineeringFollowupRetestProductBinding(
      work.context,
    );
    for (const [index, request] of bundle.retestRequests.entries()) {
      if (
        request.productBinding !== productBinding ||
        request.requestId !==
          (await engineeringFollowupRetestRequestId({
            workId: work.workId,
            index,
            steps: request.steps,
            expectedBehavior: request.expectedBehavior,
            productBinding,
            validationRequirementIds: request.validationRequirementIds,
          }))
      )
        throw new SupportDeskConflictError(
          "Follow-up retest scope or request identity changed",
        );
      if (
        request.validationRequirementIds.some(
          (id) =>
            bundle.kbProposal?.target.kind !== "article" ||
            !bundle.kbProposal.target.validationRequirementIds.includes(id),
        )
      )
        throw new SupportDeskConflictError(
          "Follow-up retest names an unauthorized requirement",
        );
    }
    const checked = snapshot(
      await engineeringFollowupTrusted(deps, (signal) =>
        options.checks!.verify(checksReceipt, binding, signal),
      ),
    );
    if (
      checked === null ||
      canonical(checked.binding) !== canonical(binding) ||
      checked.privacy !== "passed" ||
      checked.factual !== "passed" ||
      checked.applicability !== "passed" ||
      checked.security !== "clear" ||
      timestamp(checked.verifiedAt, "verifiedAt") > now() ||
      timestamp(checked.validUntil, "validUntil") <= now()
    )
      throw new SupportDeskConflictError(
        "Follow-up exact bundle checks are not current",
      );
    text(checked.verifierReceiptId, "verifierReceiptId");
    text(checked.verifierVersion, "verifierVersion");
    return { binding, deadline: timestamp(checked.validUntil, "validUntil") };
  }
  class ReassessmentRetry extends Error {}
  async function prepareBundle(
    access: AccessContext,
    input: PrepareEngineeringFollowupBundleCommand,
    guard: Parameters<
      EngineeringFollowupApplication["prepareEngineeringFollowupBundle"]
    >[2],
    control?: EngineeringMutationOptions,
    initial?: {
      readonly current: EngineeringFollowupReassessmentSeed;
      readonly mutation: EngineeringMutationBoundary | undefined;
      readonly authorize: () => void;
    },
  ): Promise<EngineeringFollowupResult> {
    const actorId = access.principalId;
    const command = snapshot(
      fields(
        input,
        "prepare follow-up bundle",
        [
          "ticketId",
          "workId",
          "commandId",
          "correlationId",
          "mode",
          "expectedWorkGeneration",
          "candidateHash",
          "exactBundle",
          "checksReceipt",
          "checkPolicyVersion",
        ],
        ["recoveryIntentHash"],
      ),
    ) as unknown as typeof input;
    if (command.mode !== "prepare" && command.mode !== "staff_reassessment")
      throw new TypeError("Invalid follow-up preparation mode");
    const staff = command.mode === "staff_reassessment";
    const authorize = () => {
      initial?.authorize();
      permission(
        access,
        staff
          ? supportPermissions.engineeringFollowupReview
          : supportPermissions.engineeringFollowupProcess,
        actorId,
        staff,
      );
    };
    authorize();
    const mutation = initial?.mutation ?? engineeringMutationBoundary(control);
    for (const entry of [
      command.ticketId,
      command.workId,
      command.commandId,
      command.correlationId,
      command.candidateHash,
      command.checksReceipt,
      command.checkPolicyVersion,
    ])
      text(entry, "bundle preparation identity");
    integer(command.expectedWorkGeneration, "expectedWorkGeneration", 1);
    validateEngineeringFollowupBundle(command.exactBundle);
    if (
      command.recoveryIntentHash !== undefined &&
      (!staff || !/^[a-f0-9]{64}$/.test(command.recoveryIntentHash))
    )
      throw new TypeError("Invalid preparation recovery intent");
    const hash = await fingerprint({ actorId, command });
    const recoveryFingerprint =
      command.recoveryIntentHash === undefined
        ? undefined
        : await fingerprint({
            actorId,
            intentHash: command.recoveryIntentHash,
          });
    const now = engineeringFollowupNow(deps);
    for (
      let attempt = 0;
      attempt < (initial === undefined ? deps.maxConflictAttempts : 1);
      attempt += 1
    ) {
      const previous = await replay(command, hash);
      authorize();
      if (previous !== null) {
        if (!("status" in previous))
          throw new SupportDeskConflictError("Wrong follow-up receipt kind");
        return previous;
      }
      if (typeof guard !== "function")
        throw new TypeError(
          "Follow-up bundle preparation needs a current read-only guard",
        );
      mutation?.ensure();
      const loaded = initial?.current.loaded ?? (await load(command.ticketId));
      const stored = initial?.current.work ?? (await workAt(command));
      const work = stored.value;
      if (
        work.workGeneration !== command.expectedWorkGeneration ||
        work.candidateHash !== command.candidateHash ||
        work.withdrawn ||
        work.status === "delivered" ||
        work.security !== "ordinary"
      )
        throw new SupportDeskConflictError(
          "Follow-up bundle source, candidate or generation changed",
        );
      if (!staff && timestamp(work.deadline, "deadline") <= now())
        throw new SupportDeskConflictError(
          "Expired follow-up requires explicit staff reassessment",
        );
      if (work.bundleRevision >= options.maxBundleRevisions)
        throw new SupportDeskConflictError(
          "Follow-up bundle preparation bound reached",
        );
      const rearm = staff
        ? await sourceServices.internal.reassessment(
            command,
            now,
            "bundle",
            initial?.current,
            initial === undefined ? undefined : () => initial.authorize(),
          )
        : null;
      const current = staff
        ? null
        : await engineeringFollowupCurrent(deps, loaded, stored, now);
      if (
        !staff &&
        (work.stage !== "bundle" ||
          work.candidate === undefined ||
          work.completionRows !== 5 ||
          work.messageSlots !== 1)
      )
        throw new SupportDeskConflictError(
          "Follow-up bundle preparation needs its current model candidate",
        );
      if (
        rearm !== null &&
        (rearm.work.version !== stored.version ||
          rearm.loaded.ticket.version !== loaded.ticket.version ||
          rearm.loaded.source.version !== loaded.source.version ||
          rearm.loaded.head?.version !== loaded.head?.version)
      ) {
        if (initial !== undefined) throw new ReassessmentRetry();
        continue;
      }
      const base: EngineeringFollowupWorkRecord =
        rearm === null
          ? work
          : {
              ...work,
              ...rearm.prospective,
              workBindingHash: rearm.prospectiveWorkBindingHash,
            };
      const checked = await verifyBundle(
        base,
        command.exactBundle,
        command.candidateHash,
        command.checkPolicyVersion,
        command.checksReceipt,
        now,
      );
      const { candidate: _candidate, ...retained } = withoutLease(base);
      const next: EngineeringFollowupWorkRecord = {
        ...retained,
        stage: "bundle",
        status: "bundle_prepared",
        completionRows: 3,
        messageSlots: 1,
        deadline: staff
          ? new Date(now() + options.maxWorkMilliseconds).toISOString()
          : work.deadline,
        workGeneration: work.workGeneration + 1,
        bundleRevision: work.bundleRevision + 1,
        preparedBundle: {
          bundle: command.exactBundle,
          bundleHash: checked.binding.bundleHash,
          candidateHash: command.candidateHash,
          binding: checked.binding,
          checksReceipt: command.checksReceipt,
        },
      };
      reserveEngineeringFollowupReachable(next);
      const cohort =
        rearm === null
          ? { actions: [], nextWorkRows: [] }
          : await planEngineeringFollowupContextChange(records, {
              rows: loaded.rows,
              context: rearm.proof.context,
              previousHead: loaded.head!.value,
              nextHead: rearm.nextHead,
              excludedWorkId: work.workId,
            });
      deps.admission(
        loaded.ticket.value.ticket,
        loaded.rows,
        [next, ...cohort.nextWorkRows],
        2,
      );
      await guard();
      const proof = rearm?.proof ?? current!.proof;
      const associationWork =
        rearm?.engineeringWork ?? current!.engineeringWork;
      if (
        !(await engineeringFollowupVersionsCurrent(
          deps,
          loaded,
          stored,
          associationWork,
        ))
      ) {
        if (initial !== undefined) throw new ReassessmentRetry();
        continue;
      }
      authorize();
      if (!staff && timestamp(work.deadline, "deadline") <= now())
        throw new SupportDeskConflictError(
          "Expired follow-up requires explicit staff reassessment",
        );
      if (
        now() >=
        Math.min(
          checked.deadline,
          timestamp(proof.attestation.validUntil, "validUntil"),
          timestamp(next.deadline, "deadline"),
        )
      )
        throw new SupportDeskConflictError("Follow-up bundle proof expired");
      const outcome = result(next);
      if (
        await save(
          loaded,
          stored,
          next,
          [
            ...cohort.actions,
            deps.audit(
              command,
              loaded.ticket.value.ticket,
              actorId,
              clock.now(),
              staff
                ? supportTicketAuditActions.engineeringFollowupReassessed
                : supportTicketAuditActions.engineeringFollowupBundlePrepared,
            ),
            receipt(command, hash, outcome, recoveryFingerprint),
          ],
          rearm?.nextHead ?? loaded.head!.value,
          mutation,
          () => {
            authorize();
            if (!staff && timestamp(work.deadline, "deadline") <= now())
              throw new SupportDeskConflictError(
                "Expired follow-up requires explicit staff reassessment",
              );
            if (
              now() >=
              Math.min(
                checked.deadline,
                timestamp(proof.attestation.validUntil, "validUntil"),
                timestamp(next.deadline, "deadline"),
              )
            )
              throw new SupportDeskConflictError(
                "Follow-up bundle proof expired",
              );
          },
        )
      ) {
        authorize();
        return outcome;
      }
    }
    if (initial !== undefined) throw new ReassessmentRetry();
    throw new SupportDeskConflictError();
  }

  const application: Methods = {
    async claimEngineeringFollowupWork(access, input) {
      const actorId = access.principalId;
      const authorize = () =>
        permission(
          access,
          supportPermissions.engineeringFollowupProcess,
          actorId,
        );
      authorize();
      const command = snapshot(
        fields(input, "claim follow-up", [
          "ticketId",
          "workId",
          "workerId",
          "claimId",
          "leaseMilliseconds",
        ]),
      ) as unknown as typeof input;
      for (const entry of [
        command.ticketId,
        command.workId,
        command.workerId,
        command.claimId,
      ])
        text(entry, "claim identity");
      integer(
        command.leaseMilliseconds,
        "leaseMilliseconds",
        1,
        options.maxLeaseMilliseconds,
      );
      if (!options.enabled) return null;
      const now = engineeringFollowupNow(deps);
      for (let attempt = 0; attempt < deps.maxConflictAttempts; attempt += 1) {
        const loaded = await load(command.ticketId);
        const stored = await workAt(command);
        const work = stored.value;
        if (
          [
            "held",
            "restricted",
            "superseded",
            "delivered",
            "bundle_prepared",
          ].includes(work.status) ||
          work.withdrawn ||
          timestamp(work.deadline, "deadline") <= now() ||
          (work.retryAt !== undefined &&
            timestamp(work.retryAt, "retryAt") > now())
        ) {
          authorize();
          return null;
        }
        const current = await engineeringFollowupCurrent(
          deps,
          loaded,
          stored,
          now,
        );
        const recovered =
          work.stage === "model" &&
          work.stepId !== undefined &&
          ["model_prepared", "claimed", "unknown"].includes(work.status);
        if (
          work.claim !== undefined &&
          work.leaseUntil !== undefined &&
          timestamp(work.leaseUntil, "leaseUntil") > now() &&
          (work.claim.workerId !== command.workerId ||
            work.claim.claimId !== command.claimId)
        ) {
          authorize();
          return null;
        }
        const same =
          work.claim !== undefined &&
          work.claim.workerId === command.workerId &&
          work.claim.claimId === command.claimId &&
          work.leaseUntil !== undefined &&
          timestamp(work.leaseUntil, "leaseUntil") > now();
        const next: EngineeringFollowupWorkRecord = same
          ? work
          : {
              ...work,
              status: "claimed",
              claimGeneration: work.claimGeneration + 1,
              workGeneration: work.workGeneration + 1,
              claim: {
                ticketId: work.ticketId,
                workId: work.workId,
                workerId: command.workerId,
                claimId: command.claimId,
                claimGeneration: work.claimGeneration + 1,
              },
              leaseUntil: new Date(
                Math.min(
                  now() + command.leaseMilliseconds,
                  timestamp(work.deadline, "deadline"),
                ),
              ).toISOString(),
            };
        if (
          !(await engineeringFollowupVersionsCurrent(
            deps,
            loaded,
            stored,
            current.engineeringWork,
          ))
        )
          continue;
        authorize();
        if (
          now() >=
          Math.min(
            timestamp(current.proof.attestation.validUntil, "validUntil"),
            timestamp(work.deadline, "deadline"),
          )
        )
          throw new SupportDeskConflictError("Follow-up claim proof expired");
        if (await save(loaded, stored, next)) {
          authorize();
          return {
            fence: snapshot(next.claim!),
            sourceFence: {
              ticketId: work.ticketId,
              workId: work.workId,
              workBindingHash: work.workBindingHash,
            },
            workGeneration: next.workGeneration,
            leaseUntil: next.leaseUntil!,
            work: snapshot(next),
            proof: current.proof,
            messages: messages(loaded, next),
            recoveredModelPreparation: recovered,
          };
        }
      }
      throw new SupportDeskConflictError();
    },
    async prepareEngineeringFollowupModel(access, input) {
      const actorId = access.principalId;
      const authorize = () =>
        permission(
          access,
          supportPermissions.engineeringFollowupProcess,
          actorId,
        );
      authorize();
      const command = snapshot(
        fields(input, "prepare follow-up model", [
          "ticketId",
          "workId",
          "workerId",
          "claimId",
          "claimGeneration",
          "binding",
        ]),
      ) as unknown as typeof input;
      validateFence(command);
      validateEngineeringFollowupModelBinding(command.binding);
      const now = engineeringFollowupNow(deps);
      if (!options.enabled)
        throw new SupportDeskConflictError(
          "Follow-up model processing disabled",
        );
      for (let attempt = 0; attempt < deps.maxConflictAttempts; attempt += 1) {
        const loaded = await load(command.ticketId);
        const stored = await workAt(command);
        const work = stored.value;
        live(work, command, now());
        const current = await engineeringFollowupCurrent(
          deps,
          loaded,
          stored,
          now,
        );
        const binding = command.binding;
        const manifest = binding.inputManifest;
        if (
          work.stage !== "model" ||
          work.candidate !== undefined ||
          work.preparedBundle !== undefined ||
          work.completionRows !== 5 ||
          work.messageSlots !== 1 ||
          manifest.workBindingHash !== work.workBindingHash ||
          manifest.contextHash !==
            (await engineeringFollowupContextHash(work.context!)) ||
          manifest.publicFactsHash !==
            (await engineeringFollowupPublicFactsHash(
              current.proof.publicFacts,
            )) ||
          binding.inputManifestHash !==
            (await engineeringFollowupModelManifestHash(manifest)) ||
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
            "Follow-up model manifest differs from current facts",
          );
        const deadline = timestamp(binding.deadline, "model.deadline");
        if (
          deadline <= now() ||
          deadline > timestamp(work.deadline, "deadline") ||
          deadline > timestamp(work.leaseUntil!, "leaseUntil")
        )
          throw new SupportDeskConflictError(
            "Follow-up model deadline exceeds live claim",
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
              "Follow-up preparation belongs to another physical invocation",
            );
          if (
            !(await engineeringFollowupVersionsCurrent(
              deps,
              loaded,
              stored,
              current.engineeringWork,
            ))
          )
            continue;
          authorize();
          live(work, command, now());
          if (
            now() >=
            Math.min(
              deadline,
              timestamp(current.proof.attestation.validUntil, "validUntil"),
            )
          )
            throw new SupportDeskConflictError("Follow-up model proof expired");
          if (await save(loaded, stored, work)) {
            authorize();
            return {
              stepId: existing.stepId,
              requestHash: existing.requestHash,
              maxCandidateBytes: 16_000,
            };
          }
          continue;
        }
        if (
          engineeringFollowupModelAttemptCount(work) >=
            options.maxModelAttempts ||
          work.modelAttempts.some(
            (entry) =>
              entry.preparedClaimGeneration === command.claimGeneration,
          )
        )
          throw new SupportDeskConflictError(
            "Follow-up paid attempt bound reached",
          );
        const requestHash = await fingerprint(binding);
        const stepId = await fingerprint({
          workId: work.workId,
          claimGeneration: command.claimGeneration,
          binding,
        });
        const next: EngineeringFollowupWorkRecord = {
          ...compactModelAttempts(work),
          status: "model_prepared",
          stepId,
          requestHash,
          workGeneration: work.workGeneration + 1,
          modelAttempts: [
            {
              preparedClaimGeneration: command.claimGeneration,
              stepId,
              requestHash,
              binding,
              accounting: "unknown",
            },
          ],
        };
        reserveEngineeringFollowupReachable(next);
        if (
          !(await engineeringFollowupVersionsCurrent(
            deps,
            loaded,
            stored,
            current.engineeringWork,
          ))
        )
          continue;
        authorize();
        live(work, command, now());
        if (
          now() >=
          Math.min(
            deadline,
            timestamp(current.proof.attestation.validUntil, "validUntil"),
          )
        )
          throw new SupportDeskConflictError("Follow-up model proof expired");
        if (await save(loaded, stored, next)) {
          authorize();
          return { stepId, requestHash, maxCandidateBytes: 16_000 };
        }
      }
      throw new SupportDeskConflictError();
    },
    async completeEngineeringFollowupModel(access, input, guard) {
      const actorId = access.principalId;
      const authorize = () =>
        permission(
          access,
          supportPermissions.engineeringFollowupProcess,
          actorId,
        );
      authorize();
      if (typeof guard !== "function")
        throw new TypeError(
          "Follow-up completion needs a current read-only guard",
        );
      const command = snapshot(
        fields(
          input,
          "complete follow-up model",
          [
            "ticketId",
            "workId",
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
      validateFence(command);
      validateEngineeringFollowupCandidate(command.candidate);
      processing(command.processing);
      if (!["accounted", "unknown"].includes(command.accounting))
        throw new TypeError("Invalid follow-up accounting");
      const hash = await fingerprint({ actorId, command });
      const now = engineeringFollowupNow(deps);
      for (let attempt = 0; attempt < deps.maxConflictAttempts; attempt += 1) {
        const loaded = await load(command.ticketId);
        const stored = await workAt(command);
        const work = stored.value;
        if (work.lastCompletion?.fingerprint === hash) {
          authorize();
          return snapshot(work.lastCompletion.result);
        }
        live(work, command, now());
        const current = await engineeringFollowupCurrent(
          deps,
          loaded,
          stored,
          now,
        );
        const model = work.modelAttempts.find(
          (entry) =>
            entry.stepId === command.stepId &&
            entry.requestHash === command.requestHash,
        );
        if (
          work.stage !== "model" ||
          model === undefined ||
          model.preparedClaimGeneration !== command.claimGeneration ||
          work.stepId !== command.stepId ||
          work.requestHash !== command.requestHash
        )
          throw new SupportDeskConflictError(
            "Follow-up prepared model owner changed",
          );
        const next: EngineeringFollowupWorkRecord = compactModelAttempts({
          ...withoutLease(work),
          status: "candidate",
          stage: "bundle",
          candidate: command.candidate,
          candidateHash: await fingerprint(command.candidate),
          workGeneration: work.workGeneration + 1,
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
        });
        const accepted: EngineeringFollowupWorkRecord = {
          ...next,
          lastCompletion: { fingerprint: hash, result: result(next) },
        };
        checkEngineeringFollowupRecordCapacity(accepted);
        await guard();
        if (
          !(await engineeringFollowupVersionsCurrent(
            deps,
            loaded,
            stored,
            current.engineeringWork,
          ))
        )
          continue;
        authorize();
        live(work, command, now());
        if (
          now() >=
          Math.min(
            timestamp(model.binding.deadline, "model.deadline"),
            timestamp(current.proof.attestation.validUntil, "validUntil"),
          )
        )
          throw new SupportDeskConflictError(
            "Follow-up completion proof expired",
          );
        if (await save(loaded, stored, accepted)) {
          authorize();
          return result(next);
        }
      }
      throw new SupportDeskConflictError();
    },
    async finishEngineeringFollowupModel(access, input) {
      const actorId = access.principalId;
      const authorize = () =>
        permission(
          access,
          supportPermissions.engineeringFollowupProcess,
          actorId,
        );
      authorize();
      const retryFloor = timestamp(clock.now(), "now");
      const now = engineeringFollowupNow(deps);
      const command = snapshot(
        fields(
          input,
          "finish follow-up model",
          [
            "ticketId",
            "workId",
            "workerId",
            "claimId",
            "claimGeneration",
            "disposition",
          ],
          [
            "stepId",
            "requestHash",
            "classificationCandidateHash",
            "accounting",
            "reason",
            "retryAt",
            "processing",
          ],
        ),
      ) as unknown as typeof input;
      validateFence(command);
      processing(command.processing);
      if (
        (command.stepId === undefined) !==
        (command.requestHash === undefined)
      )
        throw new TypeError("Follow-up finish requires exact step/hash pair");
      if (command.stepId !== undefined) {
        text(command.stepId, "stepId");
        text(command.requestHash, "requestHash");
      }
      if (
        !["retry", "held", "restricted", "superseded", "unknown"].includes(
          command.disposition,
        )
      )
        throw new TypeError("Invalid follow-up finish disposition");
      if (command.reason !== undefined) text(command.reason, "reason");
      if (
        command.accounting !== undefined &&
        !["not_called", "accounted", "unknown"].includes(command.accounting)
      )
        throw new TypeError("Invalid follow-up accounting");
      if (
        command.classificationCandidateHash !== undefined &&
        (command.disposition !== "restricted" ||
          command.stepId === undefined ||
          command.accounting !== undefined ||
          command.processing !== undefined)
      )
        throw new TypeError("Historical restriction cannot change accounting");
      const hash = await fingerprint({ actorId, command });
      for (let attempt = 0; attempt < deps.maxConflictAttempts; attempt += 1) {
        const loaded = await load(command.ticketId);
        const stored = await workAt(command);
        const work = stored.value;
        if (work.lastFinish?.fingerprint === hash) {
          authorize();
          return snapshot(work.lastFinish.result);
        }
        const historical = command.classificationCandidateHash !== undefined;
        if (historical) {
          if (
            (work.candidateHash ??
              work.lastCompletion?.result.candidateHash) !==
              command.classificationCandidateHash ||
            ![...work.modelAttempts, ...(work.usageTombstones ?? [])].some(
              (entry) =>
                entry.stepId === command.stepId &&
                entry.requestHash === command.requestHash,
            )
          )
            throw new SupportDeskConflictError(
              "Follow-up historical classification binding changed",
            );
        } else {
          live(work, command, now());
          if (
            (command.stepId !== undefined && command.stepId !== work.stepId) ||
            (command.requestHash !== undefined &&
              command.requestHash !== work.requestHash)
          )
            throw new SupportDeskConflictError("Follow-up finish step changed");
          if (
            command.stepId === undefined &&
            (work.preparedBundle !== undefined ||
              work.modelAttempts.some(
                (entry) =>
                  entry.preparedClaimGeneration === command.claimGeneration,
              ))
          )
            throw new SupportDeskConflictError(
              "Prepared follow-up needs an exact finish fence",
            );
        }
        const retry = !historical && command.disposition === "retry";
        if (
          retry &&
          command.retryAt !== undefined &&
          (timestamp(command.retryAt, "retryAt") >=
            timestamp(work.deadline, "deadline") ||
            timestamp(command.retryAt, "retryAt") < retryFloor)
        )
          throw new SupportDeskConflictError(
            "Follow-up retry exceeds deadline",
          );
        const next: EngineeringFollowupWorkRecord = {
          ...withoutLease(work),
          status:
            work.status === "delivered"
              ? "delivered"
              : historical && ["held", "superseded"].includes(work.status)
                ? work.status
                : command.disposition === "unknown"
                  ? "held"
                  : command.disposition,
          security:
            command.disposition === "restricted" ? "restricted" : work.security,
          completionRows: retry ? work.completionRows : 0,
          messageSlots: retry ? work.messageSlots : 0,
          workGeneration: work.workGeneration + 1,
          ...(command.reason === undefined || work.withdrawn
            ? {}
            : { heldReason: command.reason }),
          ...(!retry || command.retryAt === undefined
            ? {}
            : { retryAt: command.retryAt }),
          modelAttempts: historical
            ? work.modelAttempts
            : work.modelAttempts.map((entry) => {
                if (
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
                      "Cannot rewrite another follow-up invocation's accounting",
                    );
                  return entry;
                }
                if (
                  entry.accounting !== "unknown" &&
                  command.accounting !== undefined &&
                  entry.accounting !== command.accounting
                )
                  throw new SupportDeskConflictError(
                    "Known follow-up accounting cannot change",
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
        const accepted: EngineeringFollowupWorkRecord = {
          ...next,
          lastFinish: { fingerprint: hash, result: result(next) },
        };
        authorize();
        if (!historical) live(work, command, now());
        if (await save(loaded, stored, accepted)) {
          authorize();
          return result(next);
        }
      }
      throw new SupportDeskConflictError();
    },
    async recoverEngineeringFollowupPreparation(access, input) {
      const actorId = access.principalId;
      const authorize = () =>
        permission(
          access,
          supportPermissions.engineeringFollowupReview,
          actorId,
          true,
        );
      authorize();
      const command = snapshot(
        fields(input, "recover follow-up preparation", [
          "ticketId",
          "workId",
          "commandId",
          "recoveryIntentHash",
        ]),
      ) as unknown as typeof input;
      for (const entry of [command.ticketId, command.workId, command.commandId])
        text(entry, "recovery identity");
      if (!/^[a-f0-9]{64}$/.test(command.recoveryIntentHash))
        throw new TypeError("Invalid follow-up recovery intent hash");
      const recoveryFingerprint = await fingerprint({
        actorId,
        intentHash: command.recoveryIntentHash,
      });
      const prior = await records.get(
        engineeringFollowupCommandKey(command.ticketId, command.commandId),
      );
      authorize();
      if (prior === null) return null;
      if (
        prior.kind !== "engineering_followup_receipt" ||
        prior.recoveryFingerprint !== recoveryFingerprint ||
        !("workId" in prior.result) ||
        prior.result.workId !== command.workId ||
        !("status" in prior.result)
      )
        throw new SupportDeskConflictError(
          "Follow-up recovery identity does not match accepted preparation",
        );
      return snapshot(prior.result);
    },
    async prepareEngineeringFollowupBundle(access, input, guard, control) {
      return prepareBundle(access, input, guard, control);
    },
    async reassessEngineeringFollowupBundle(access, input, planner, control) {
      const actorId = access.principalId;
      const authorize = (reader: AccessContext = access) => {
        permission(
          reader,
          supportPermissions.engineeringFollowupReview,
          actorId,
          true,
        );
        permission(
          reader,
          supportPermissions.engineeringFollowupRead,
          actorId,
          true,
        );
      };
      permission(
        access,
        supportPermissions.engineeringFollowupReview,
        actorId,
        true,
      );
      const command = snapshot(
        fields(input, "reassess follow-up bundle", [
          "ticketId",
          "workId",
          "commandId",
          "correlationId",
          "expectedWorkGeneration",
          "recoveryIntentHash",
        ]),
      ) as unknown as typeof input;
      for (const entry of [
        command.ticketId,
        command.workId,
        command.commandId,
        command.correlationId,
      ])
        text(entry, "reassessment identity");
      integer(command.expectedWorkGeneration, "expectedWorkGeneration", 1);
      if (!/^[a-f0-9]{64}$/.test(command.recoveryIntentHash))
        throw new TypeError("Invalid reassessment recovery intent");
      const recovery = {
        ticketId: command.ticketId,
        workId: command.workId,
        commandId: command.commandId,
        recoveryIntentHash: command.recoveryIntentHash,
      };
      const recover = () =>
        application.recoverEngineeringFollowupPreparation(access, recovery);
      const mutation = engineeringMutationBoundary(control);
      const now = engineeringFollowupNow(deps);
      for (let attempt = 0; attempt < deps.maxConflictAttempts; attempt += 1) {
        const accepted = await recover();
        if (accepted !== null) return accepted;
        mutation?.ensure();
        authorize();
        // Eligibility and private Source authority precede any protected hydration.
        const source = await records.getVersioned(
          engineeringSourceKey(command.ticketId),
        );
        authorize();
        if (source?.value.kind !== "engineering_source")
          throw new SupportDeskNotFoundError();
        if (source.value.security !== "ordinary")
          permission(
            access,
            supportPermissions.engineeringRestrictedRead,
            actorId,
            true,
          );
        if (
          source.value.security !== "ordinary" ||
          source.value.state === "withdrawn"
        )
          throw new SupportDeskConflictError("Follow-up Source is ineligible");
        try {
          const current = await sourceServices.internal.reassessment(
            command,
            now,
            "bundle",
            undefined,
            (source) => {
              authorize();
              if (source !== undefined) {
                if (source.security !== "ordinary")
                  permission(
                    access,
                    supportPermissions.engineeringRestrictedRead,
                    actorId,
                    true,
                  );
                if (
                  source.security !== "ordinary" ||
                  source.state === "withdrawn"
                )
                  throw new SupportDeskConflictError(
                    "Follow-up Source is ineligible",
                  );
              }
            },
            { value: source.value, version: source.version },
          );
          // The initial external release proof cannot make the original Source current.
          const confirmedSource = await records.getVersioned(
            engineeringSourceKey(command.ticketId),
          );
          authorize();
          if (confirmedSource?.value.kind !== "engineering_source")
            throw new SupportDeskNotFoundError();
          if (confirmedSource.value.security !== "ordinary")
            permission(
              access,
              supportPermissions.engineeringRestrictedRead,
              actorId,
              true,
            );
          if (confirmedSource.version !== source.version)
            throw new SupportDeskConflictError(
              "Follow-up Source changed during release verification",
            );
          if (
            current.work.value.workGeneration !== command.expectedWorkGeneration
          )
            throw new SupportDeskConflictError(
              "Follow-up reassessment generation changed",
            );
          const scope = engineeringFollowupObservation(
            deps,
            current,
            actorId,
            authorize,
          );
          const observation: EngineeringFollowupReassessmentObservation =
            Object.freeze({
              read(reader: AccessContext) {
                scope.check(reader);
                if (
                  now() >=
                  timestamp(current.proof.attestation.validUntil, "validUntil")
                )
                  throw new SupportDeskConflictError(
                    "Follow-up reassessment expired",
                  );
                return snapshot({
                  work: current.work.value,
                  proofContext: current.proofContext,
                  proof: current.proof,
                  prospectiveWorkBindingHash:
                    current.prospectiveWorkBindingHash,
                  workGeneration: current.work.value.workGeneration,
                });
              },
              confirm: scope.confirm,
            });
          try {
            if (typeof planner !== "function")
              throw new TypeError(
                "Follow-up reassessment needs a read-only planner",
              );
            const planned = await planner(observation);
            authorize();
            const checkedPlan = fields(planned, "follow-up reassessment plan", [
              "candidateHash",
              "exactBundle",
              "checksReceipt",
              "checkPolicyVersion",
              "guard",
            ]);
            const guard = checkedPlan.guard;
            if (typeof guard !== "function")
              throw new TypeError(
                "Follow-up reassessment guard must be callable",
              );
            const plan = snapshot({
              candidateHash: checkedPlan.candidateHash,
              exactBundle: checkedPlan.exactBundle,
              checksReceipt: checkedPlan.checksReceipt,
              checkPolicyVersion: checkedPlan.checkPolicyVersion,
            });
            // Functions never enter the immutable command or an accepted receipt.
            return await prepareBundle(
              access,
              {
                ...command,
                mode: "staff_reassessment",
                candidateHash: plan.candidateHash as string,
                exactBundle:
                  plan.exactBundle as unknown as EngineeringFollowupBundle,
                checksReceipt: plan.checksReceipt as string,
                checkPolicyVersion: plan.checkPolicyVersion as string,
              },
              async () => {
                try {
                  return await guard();
                } finally {
                  scope.close();
                }
              },
              undefined,
              { current, mutation, authorize },
            );
          } finally {
            scope.close();
          }
        } catch (error) {
          const accepted = await recover();
          if (accepted !== null) return accepted;
          if (!(error instanceof ReassessmentRetry)) throw error;
        }
      }
      throw new SupportDeskConflictError();
    },
    async retryEngineeringFollowupWork(access, input, control) {
      const actorId = access.principalId;
      const authorize = () =>
        permission(
          access,
          supportPermissions.engineeringFollowupReview,
          actorId,
          true,
        );
      authorize();
      const mutation = engineeringMutationBoundary(control);
      const now = engineeringFollowupNow(deps);
      const command = snapshot(
        fields(input, "retry follow-up work", [
          "ticketId",
          "workId",
          "commandId",
          "correlationId",
          "expectedWorkGeneration",
        ]),
      ) as unknown as typeof input;
      for (const entry of [
        command.ticketId,
        command.workId,
        command.commandId,
        command.correlationId,
      ])
        text(entry, "retry identity");
      integer(command.expectedWorkGeneration, "expectedWorkGeneration", 1);
      const hash = await fingerprint({ actorId, command });
      for (let attempt = 0; attempt < deps.maxConflictAttempts; attempt += 1) {
        const previous = await replay(command, hash);
        authorize();
        if (previous !== null) {
          if (!("status" in previous))
            throw new SupportDeskConflictError("Wrong follow-up receipt kind");
          return previous;
        }
        mutation?.ensure();
        const current = await sourceServices.internal.reassessment(
          command,
          now,
          "model_retry",
        );
        const { loaded, work: stored } = current;
        const work = stored.value;
        if (
          work.workGeneration !== command.expectedWorkGeneration ||
          engineeringFollowupModelAttemptCount(work) >= options.maxModelAttempts
        )
          throw new SupportDeskConflictError(
            "Follow-up recovery generation or lifetime model budget changed",
          );
        const {
          stepId: _step,
          requestHash: _request,
          heldReason: _reason,
          ...retained
        } = withoutLease(compactModelAttempts(work));
        const next: EngineeringFollowupWorkRecord = {
          ...retained,
          ...current.prospective,
          workBindingHash: current.prospectiveWorkBindingHash,
          workGeneration: work.workGeneration + 1,
          status: "pending",
          stage: "model",
          completionRows: 5,
          messageSlots: 1,
          deadline: new Date(now() + options.maxWorkMilliseconds).toISOString(),
        };
        reserveEngineeringFollowupReachable(next);
        const cohort = await planEngineeringFollowupContextChange(records, {
          rows: loaded.rows,
          context: current.proof.context,
          previousHead: loaded.head!.value,
          nextHead: current.nextHead,
          excludedWorkId: work.workId,
        });
        deps.admission(
          loaded.ticket.value.ticket,
          loaded.rows,
          [next, ...cohort.nextWorkRows],
          2,
        );
        if (
          !(await engineeringFollowupVersionsCurrent(
            deps,
            loaded,
            stored,
            current.engineeringWork,
          ))
        )
          continue;
        authorize();
        if (
          now() >=
          Math.min(
            timestamp(current.proof.attestation.validUntil, "validUntil"),
            timestamp(next.deadline, "deadline"),
          )
        )
          throw new SupportDeskConflictError(
            "Follow-up recovery proof expired",
          );
        const outcome = result(next);
        if (
          await save(
            loaded,
            stored,
            next,
            [
              ...cohort.actions,
              deps.audit(
                command,
                loaded.ticket.value.ticket,
                actorId,
                clock.now(),
                supportTicketAuditActions.engineeringFollowupRetried,
              ),
              receipt(command, hash, outcome),
            ],
            current.nextHead,
            mutation,
            () => {
              authorize();
              if (
                now() >=
                Math.min(
                  timestamp(current.proof.attestation.validUntil, "validUntil"),
                  timestamp(next.deadline, "deadline"),
                )
              )
                throw new SupportDeskConflictError(
                  "Follow-up recovery proof expired",
                );
            },
          )
        ) {
          authorize();
          return outcome;
        }
      }
      throw new SupportDeskConflictError();
    },
    async abandonEngineeringFollowupWork(access, input, control) {
      const actorId = access.principalId;
      const authorize = () =>
        permission(
          access,
          supportPermissions.engineeringFollowupReview,
          actorId,
          true,
        );
      authorize();
      const mutation = engineeringMutationBoundary(control);
      const command = snapshot(
        fields(input, "abandon follow-up work", [
          "ticketId",
          "workId",
          "commandId",
          "correlationId",
          "expectedWorkGeneration",
          "reason",
        ]),
      ) as unknown as typeof input;
      for (const entry of [
        command.ticketId,
        command.workId,
        command.commandId,
        command.correlationId,
        command.reason,
      ])
        text(entry, "abandonment identity");
      integer(command.expectedWorkGeneration, "expectedWorkGeneration", 1);
      const hash = await fingerprint({ actorId, command });
      for (let attempt = 0; attempt < deps.maxConflictAttempts; attempt += 1) {
        const previous = await replay(command, hash);
        authorize();
        if (previous !== null) {
          if (!("status" in previous))
            throw new SupportDeskConflictError("Wrong follow-up receipt kind");
          return previous;
        }
        mutation?.ensure();
        const loaded = await load(command.ticketId);
        const stored = await workAt(command);
        const work = stored.value;
        if (
          work.workGeneration !== command.expectedWorkGeneration ||
          work.withdrawn ||
          work.status === "delivered"
        )
          throw new SupportDeskConflictError(
            "Follow-up abandonment target changed or was withdrawn or delivered",
          );
        const next = holdEngineeringFollowupWork(work, command.reason);
        deps.admission(loaded.ticket.value.ticket, loaded.rows, [next], 2);
        const outcome = result(next);
        authorize();
        if (
          await save(
            loaded,
            stored,
            next,
            [
              deps.audit(
                command,
                loaded.ticket.value.ticket,
                actorId,
                clock.now(),
                supportTicketAuditActions.engineeringFollowupAbandoned,
              ),
              receipt(command, hash, outcome),
            ],
            loaded.head?.value,
            mutation,
            authorize,
          )
        ) {
          authorize();
          return outcome;
        }
      }
      throw new SupportDeskConflictError();
    },
    async rejectEngineeringFollowupBundle(access, input, control) {
      const actorId = access.principalId;
      const authorize = () =>
        permission(
          access,
          supportPermissions.engineeringFollowupReview,
          actorId,
          true,
        );
      authorize();
      const mutation = engineeringMutationBoundary(control);
      const command = snapshot(
        fields(input, "reject follow-up bundle", [
          "ticketId",
          "workId",
          "commandId",
          "correlationId",
          "expectedWorkGeneration",
          "bundleHash",
          "reason",
        ]),
      ) as unknown as typeof input;
      for (const entry of [
        command.ticketId,
        command.workId,
        command.commandId,
        command.correlationId,
        command.bundleHash,
        command.reason,
      ])
        text(entry, "rejection identity");
      integer(command.expectedWorkGeneration, "expectedWorkGeneration", 1);
      const hash = await fingerprint({ actorId, command });
      for (let attempt = 0; attempt < deps.maxConflictAttempts; attempt += 1) {
        const previous = await replay(command, hash);
        authorize();
        if (previous !== null) {
          if (!("status" in previous))
            throw new SupportDeskConflictError("Wrong follow-up receipt kind");
          return previous;
        }
        mutation?.ensure();
        const loaded = await load(command.ticketId);
        const stored = await workAt(command);
        const work = stored.value;
        if (
          work.workGeneration !== command.expectedWorkGeneration ||
          work.status === "delivered" ||
          work.withdrawn ||
          work.preparedBundle?.bundleHash !== command.bundleHash
        )
          throw new SupportDeskConflictError(
            "Exact follow-up rejection target changed",
          );
        const next = holdEngineeringFollowupWork(work, command.reason);
        deps.admission(loaded.ticket.value.ticket, loaded.rows, [next], 2);
        const outcome = result(next);
        authorize();
        if (
          await save(
            loaded,
            stored,
            next,
            [
              deps.audit(
                command,
                loaded.ticket.value.ticket,
                actorId,
                clock.now(),
                supportTicketAuditActions.engineeringFollowupRejected,
              ),
              receipt(command, hash, outcome),
            ],
            loaded.head?.value,
            mutation,
            authorize,
          )
        ) {
          authorize();
          return outcome;
        }
      }
      throw new SupportDeskConflictError();
    },
    async submitEngineeringFollowupRetestResult(access, input, control) {
      const actorId = access.principalId;
      const authorize = () =>
        permission(
          access,
          supportPermissions.engineeringFollowupEvidenceSubmit,
          actorId,
        );
      authorize();
      const mutation = engineeringMutationBoundary(control);
      const command = snapshot(
        fields(input, "submit follow-up retest", [
          "ticketId",
          "workId",
          "commandId",
          "correlationId",
          "retestRequestId",
          "receiptReference",
        ]),
      ) as unknown as typeof input;
      for (const entry of [
        command.ticketId,
        command.workId,
        command.commandId,
        command.correlationId,
        command.retestRequestId,
        command.receiptReference,
      ])
        text(entry, "retest identity");
      const hash = await fingerprint({ actorId, command });
      const now = engineeringFollowupNow(deps);
      for (let attempt = 0; attempt < deps.maxConflictAttempts; attempt += 1) {
        const previous = await replay(command, hash);
        authorize();
        if (previous !== null) {
          if (!("result" in previous))
            throw new SupportDeskConflictError("Wrong retest receipt kind");
          return previous;
        }
        mutation?.ensure();
        const loaded = await load(command.ticketId);
        const stored = await workAt(command);
        const work = stored.value;
        if (
          work.withdrawn ||
          work.security !== "ordinary" ||
          options.retestReceipts === undefined ||
          work.context === undefined ||
          loaded.source.value.state === "withdrawn" ||
          loaded.source.value.followupRevocationEpoch !==
            work.association.followupRevocationEpoch
        )
          throw new SupportDeskConflictError(
            "Follow-up retest source unavailable",
          );
        const associated = await engineeringFollowupAssociation(
          deps,
          loaded,
          work.association,
          work.association,
        );
        const proofContext = engineeringFollowupProofContext(
          loaded,
          associated.association,
        );
        if (options.releaseEvidence === undefined)
          throw new SupportDeskConflictError(
            "Follow-up release verification unavailable",
          );
        authorize();
        const proof = snapshot(
          await engineeringFollowupTrusted(deps, (signal) =>
            options.releaseEvidence!.confirm(
              work.context!,
              proofContext,
              signal,
            ),
          ),
        );
        engineeringFollowupValidateProof(
          proof,
          proofContext,
          associated.engineeringWork.value.product!,
          now,
        );
        if (
          canonical(proof.context) !== canonical(work.context) ||
          proof.context.mapping === undefined ||
          proof.context.deploymentHead.state !== "deployed"
        )
          throw new SupportDeskConflictError(
            "Follow-up retest deployment changed",
          );
        const requests =
          work.preparedBundle?.bundle.retestRequests ??
          work.handoff?.retestRequests;
        const request = requests?.find(
          (entry) => entry.requestId === command.retestRequestId,
        );
        const bundleHash =
          work.preparedBundle?.bundleHash ?? work.delivered?.bundleHash;
        if (request === undefined || bundleHash === undefined)
          throw new SupportDeskConflictError(
            "Follow-up retest request changed",
          );
        const binding = {
          ticketId: work.ticketId,
          workId: work.workId,
          workBindingHash: work.workBindingHash,
          requestId: request.requestId,
          requestHash: await engineeringFollowupRetestRequestHash(request),
          bundleHash,
          productBinding: request.productBinding,
        };
        authorize();
        const verified = snapshot(
          await engineeringFollowupTrusted(deps, (signal) =>
            options.retestReceipts!.verify(
              command.receiptReference,
              binding,
              signal,
            ),
          ),
        );
        if (
          verified === null ||
          canonical(verified.binding) !== canonical(binding) ||
          !["passed", "failed"].includes(verified.result) ||
          timestamp(verified.verifiedAt, "verifiedAt") > now() ||
          timestamp(verified.validUntil, "validUntil") <= now()
        )
          throw new SupportDeskConflictError(
            "Follow-up retest receipt unverified",
          );
        for (const entry of [
          verified.verifierReceiptId,
          verified.verifierVersion,
          verified.executionId,
          verified.runnerId,
        ])
          text(entry, "retest proof identity");
        const summary = await engineeringFollowupRetestSummary(
          verified,
          command.receiptReference,
        );
        const prior = work.retestResults.find(
          (entry) => entry.requestId === request.requestId,
        );
        if (prior?.verificationHash === summary.verificationHash) {
          if (
            !(await engineeringFollowupVersionsCurrent(
              deps,
              loaded,
              stored,
              associated.engineeringWork,
            ))
          )
            continue;
          authorize();
          if (
            now() >=
            Math.min(
              timestamp(verified.validUntil, "validUntil"),
              timestamp(proof.attestation.validUntil, "validUntil"),
            )
          )
            throw new SupportDeskConflictError(
              "Follow-up retest proof expired",
            );
          return {
            ticketId: work.ticketId,
            workId: work.workId,
            outcome: "unchanged",
            result: verified.result,
          };
        }
        const target =
          verified.result === "failed"
            ? holdEngineeringFollowupWork(work, "retest_failed")
            : { ...work, workGeneration: work.workGeneration + 1 };
        const next: EngineeringFollowupWorkRecord = {
          ...(target.stage === "bundle"
            ? compactModelAttempts(target)
            : target),
          retestResults: [
            ...work.retestResults.filter(
              (entry) => entry.requestId !== request.requestId,
            ),
            summary,
          ],
        };
        const others: {
          stored: EngineeringFollowupWorkVersion;
          next: EngineeringFollowupWorkRecord;
        }[] = [];
        if (verified.result === "failed")
          for (const hint of loaded.rows) {
            if (
              hint.kind !== "engineering_followup_work" ||
              hint.workId === work.workId ||
              hint.status === "delivered" ||
              hint.withdrawn ||
              hint.association.repositoryId !== work.association.repositoryId ||
              hint.association.issueId !== work.association.issueId ||
              hint.context?.deploymentHead.contextRef !==
                work.context.deploymentHead.contextRef ||
              hint.semanticIdentity.deploymentEpoch !==
                work.semanticIdentity.deploymentEpoch
            )
              continue;
            const other = await workAt(hint);
            const held = holdEngineeringFollowupWork(
              other.value,
              "retest_failed",
            );
            others.push({ stored: other, next: held });
          }
        deps.admission(
          loaded.ticket.value.ticket,
          loaded.rows,
          [next, ...others.map((entry) => entry.next)],
          2,
        );
        const outcome = {
          ticketId: work.ticketId,
          workId: work.workId,
          outcome:
            verified.result === "failed"
              ? ("held" as const)
              : ("recorded" as const),
          result: verified.result,
        };
        if (
          !(await engineeringFollowupVersionsCurrent(
            deps,
            loaded,
            stored,
            associated.engineeringWork,
          ))
        )
          continue;
        authorize();
        if (
          now() >=
          Math.min(
            timestamp(verified.validUntil, "validUntil"),
            timestamp(proof.attestation.validUntil, "validUntil"),
          )
        )
          throw new SupportDeskConflictError("Follow-up retest proof expired");
        if (
          await save(
            loaded,
            stored,
            next,
            [
              ...others.map((entry): EngineeringAction => ({
                action: "putIfUnchanged",
                version: entry.stored.version,
                value: entry.next,
              })),
              deps.audit(
                command,
                loaded.ticket.value.ticket,
                actorId,
                clock.now(),
                supportTicketAuditActions.engineeringFollowupRetestRecorded,
              ),
              receipt(command, hash, outcome),
            ],
            loaded.head?.value,
            mutation,
            () => {
              authorize();
              if (
                now() >=
                Math.min(
                  timestamp(verified.validUntil, "validUntil"),
                  timestamp(proof.attestation.validUntil, "validUntil"),
                )
              )
                throw new SupportDeskConflictError(
                  "Follow-up retest proof expired",
                );
            },
          )
        ) {
          authorize();
          return outcome;
        }
      }
      throw new SupportDeskConflictError();
    },
  };
  return {
    application,
    internal: {
      ...sourceServices.internal,
      verifyBundle: async (
        current: Awaited<ReturnType<typeof sourceServices.internal.current>>,
        now = engineeringFollowupNow(deps),
      ) => {
        const prepared = current.work.value.preparedBundle;
        if (prepared === undefined)
          throw new SupportDeskConflictError("Follow-up bundle not prepared");
        return verifyBundle(
          current.work.value,
          prepared.bundle,
          prepared.candidateHash,
          prepared.binding.checkPolicyVersion,
          prepared.checksReceipt,
          now,
        );
      },
    },
  };
}
