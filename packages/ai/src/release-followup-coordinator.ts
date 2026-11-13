import { hasPermission, type AccessContext } from "@pegma/authorization-core";
import {
  SupportDeskAuthorizationError,
  SupportDeskConflictError,
  supportPermissions,
} from "@pegma/support-desk-application";
import type {
  ApproveAndPostEngineeringFollowupWebUpdateCommand,
  ClaimEngineeringFollowupWorkCommand,
  EngineeringFollowupClaim,
  EngineeringFollowupReassessmentView,
  EngineeringFollowupResult,
  EngineeringFollowupWebUpdateOptions,
  EngineeringFollowupWorkRecord,
  EngineeringMutationOptions,
  EngineeringFollowupPostObservation,
  FinishEngineeringFollowupModelCommand,
  PrepareEngineeringFollowupBundleCommand,
  EngineeringFollowupBundleObservation,
} from "@pegma/support-desk-application";
import type {
  PrepareReleaseFollowupStaffReassessmentCommand,
  ReleaseFollowupProcessResult,
  SupportDeskReleaseFollowup,
  SupportDeskReleaseFollowupOptions,
} from "./release-followup-ports.js";
import {
  AssistantBoundaryError,
  canonical,
  count,
  exactKeys,
  fingerprint,
  scalar,
  snapshot,
  timestamp,
} from "./boundary.js";
import { learningAuthoritySnapshot } from "./learning-request.js";
import {
  createLearningRuntime,
  type LearningRuntime,
} from "./learning-runtime.js";
import {
  releaseFollowupAuthority,
  releaseFollowupCurrent,
  releaseFollowupFailure,
  releaseFollowupScanAuthority,
} from "./release-followup-request.js";
import { processReleaseFollowupModel } from "./release-followup-model.js";
import {
  confirmStoredReleaseFollowupBundle,
  prepareCheckedReleaseFollowupBundle,
  ReleaseFollowupReviewGuardFailure,
  ReleaseFollowupCheckDeferred,
  retainedReleaseFollowupContent,
} from "./release-followup-review.js";

/** Original live staff context reaches the app; a snapshot only binds identity/permissions. */
function staffFence(access: AccessContext): () => void {
  const baseline = learningAuthoritySnapshot({
    access,
    authorityVersion: "release-followup-staff",
    usageScopeRef: "release-followup-staff",
  }).access;
  return (): void => {
    const current = learningAuthoritySnapshot({
      access,
      authorityVersion: "release-followup-staff",
      usageScopeRef: "release-followup-staff",
    }).access;
    if (canonical(current) !== canonical(baseline))
      throw new ReleaseFollowupReviewGuardFailure("authority_changed");
  };
}

function requireStaffRead(
  access: AccessContext,
  action: "prepare" | "post",
): void {
  for (const permission of [
    supportPermissions.engineeringFollowupRead,
    supportPermissions.engineeringFollowupReview,
    supportPermissions.queueRead,
    ...(action === "post" ? [supportPermissions.replyAny] : []),
  ])
    if (!hasPermission(access, permission))
      throw new SupportDeskAuthorizationError(permission);
}

function prospectiveWork(
  view: EngineeringFollowupReassessmentView,
): EngineeringFollowupWorkRecord {
  return snapshot({
    ...view.work,
    workBindingHash: view.prospectiveWorkBindingHash,
    workGeneration: view.workGeneration,
    parentSourceGeneration: view.proofContext.parentSourceGeneration,
    acceptedTicketRevision: view.proofContext.ticketRevision,
    lastVisibleMessageId: view.proofContext.lastVisibleMessageId,
    association: view.proofContext.association,
    context: view.proof.context,
  });
}

async function prepareWorkerBundle(
  options: SupportDeskReleaseFollowupOptions,
  claim: EngineeringFollowupClaim,
  runtime: LearningRuntime,
): Promise<ReleaseFollowupProcessResult> {
  const attempts = count(options.storageCommandAttempts ?? 2, 3, 1);
  const phase =
    Math.min(
      runtime.deadline,
      timestamp(claim.leaseUntil),
      timestamp(claim.work.deadline),
    ) - count(options.commitReserveMilliseconds ?? 1_000, 5_000, 1);
  const finish = async (
    reason: string,
    restricted = false,
    deferred?: {
      readonly operationId: string;
      readonly expiresAt: string;
      readonly callState: "not_called" | "recorded";
    },
  ): Promise<ReleaseFollowupProcessResult> => {
    const command: FinishEngineeringFollowupModelCommand = snapshot({
      ...claim.fence,
      ...(claim.work.stepId === undefined ||
      claim.work.requestHash === undefined
        ? {}
        : { stepId: claim.work.stepId, requestHash: claim.work.requestHash }),
      ...(restricted && claim.work.candidateHash !== undefined
        ? { classificationCandidateHash: claim.work.candidateHash }
        : {}),
      disposition: deferred ? "retry" : restricted ? "restricted" : "held",
      reason,
    });
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const authority = await releaseFollowupAuthority(options, runtime);
        const result = await runtime.within(() =>
          options.application.finishEngineeringFollowupModel(
            authority.access,
            command,
          ),
        );
        if (deferred && result.status === "retry")
          return {
            outcome: "pending",
            stage: "bundle",
            checkpoint:
              deferred.callState === "not_called"
                ? "checks_planned"
                : "checks_recorded",
            callState: deferred.callState,
            checks: {
              operationId: deferred.operationId,
              expiresAt: deferred.expiresAt,
            },
          };
        return { outcome: restricted ? "restricted" : "held", result };
      } catch {
        /* Exact finish retry only; accounting of the prior paid attempt is untouched. */
      }
    }
    return { outcome: "pending", stage: "finish", reason };
  };
  try {
    if (claim.work.preparedBundle !== undefined)
      return {
        outcome: "prepared",
        result: {
          ticketId: claim.work.ticketId,
          workId: claim.work.workId,
          workGeneration: claim.work.workGeneration,
          status: claim.work.status,
          bundleHash: claim.work.preparedBundle.bundleHash,
        },
      };
    const authority = await releaseFollowupAuthority(
      options,
      runtime,
      undefined,
      phase,
    );
    const observeCurrent = async (
      observation?: EngineeringFollowupBundleObservation,
    ): Promise<void> => {
      const currentAuthority = await releaseFollowupAuthority(
        options,
        runtime,
        authority,
        phase,
      );
      const current =
        observation === undefined
          ? await releaseFollowupCurrent(
              options,
              claim.work,
              currentAuthority.access,
              runtime,
              phase,
            )
          : snapshot(observation.readWork(currentAuthority.access));
      if (
        current.ticketId !== claim.work.ticketId ||
        current.workId !== claim.work.workId ||
        current.workGeneration !== claim.work.workGeneration ||
        current.workBindingHash !== claim.work.workBindingHash ||
        current.withdrawn ||
        current.security !== "ordinary" ||
        current.parentSourceGeneration !== claim.work.parentSourceGeneration ||
        current.acceptedTicketRevision !== claim.work.acceptedTicketRevision ||
        current.lastVisibleMessageId !== claim.work.lastVisibleMessageId ||
        canonical(current.context) !== canonical(claim.work.context) ||
        canonical(current.association) !== canonical(claim.work.association) ||
        current.claim === undefined ||
        canonical(current.claim) !== canonical(claim.fence) ||
        current.candidateHash !== claim.work.candidateHash ||
        current.preparedBundle !== undefined ||
        current.stage !== "bundle"
      )
        throw new AssistantBoundaryError("current_fence_changed");
    };
    const checked = await prepareCheckedReleaseFollowupBundle(
      options,
      claim.work,
      retainedReleaseFollowupContent(claim.work),
      runtime,
      observeCurrent,
      phase,
      options.invocationMode === "staged" && claim.bundleObservation === true
        ? {
            proof: claim.proof,
            async readProof(observation) {
              const current = await releaseFollowupAuthority(
                options,
                runtime,
                authority,
                phase,
              );
              return observation.readProof(current.access);
            },
          }
        : undefined,
    );
    const commandId =
      "followup-bundle:" +
      (
        await fingerprint({ fence: claim.fence, binding: checked.binding })
      ).slice(0, 48);
    const command: PrepareEngineeringFollowupBundleCommand = snapshot({
      commandId,
      correlationId: commandId,
      ticketId: claim.work.ticketId,
      workId: claim.work.workId,
      mode: "prepare",
      expectedWorkGeneration: claim.work.workGeneration,
      candidateHash: claim.work.candidateHash!,
      exactBundle: checked.bundle,
      checksReceipt: checked.receipt,
      checkPolicyVersion: checked.checkPolicyVersion,
    });
    let uncertain = false;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const current = await releaseFollowupAuthority(
          options,
          runtime,
          authority,
          checked.deadline,
        );
        const result = await runtime.within(
          () =>
            options.application.prepareEngineeringFollowupBundle(
              current.access,
              command,
              checked.guard,
            ),
          checked.deadline,
        );
        return { outcome: "prepared", result };
      } catch (error) {
        if (error instanceof ReleaseFollowupReviewGuardFailure && !uncertain)
          return await finish(
            error.category,
            error.category === "security_restricted",
          );
        uncertain = true;
      }
    }
    return { outcome: "pending", stage: "bundle" };
  } catch (error) {
    if (
      options.invocationMode === "staged" &&
      error instanceof ReleaseFollowupCheckDeferred
    )
      return await finish("checks_deferred", false, {
        operationId: error.operationId,
        expiresAt: error.expiresAt,
        callState: error.callState,
      });
    return await finish(
      releaseFollowupFailure(error, "bundle_unavailable"),
      error instanceof AssistantBoundaryError &&
        error.category === "security_restricted",
    );
  }
}

/** Optional composition only. The application owns admission, durable work and atomic web posting. */
export function createSupportDeskReleaseFollowup(
  options: SupportDeskReleaseFollowupOptions,
): SupportDeskReleaseFollowup {
  if (
    options.invocationMode !== undefined &&
    options.invocationMode !== "staged"
  )
    throw new TypeError("Unknown release follow-up invocation mode");
  const attempts = count(options.storageCommandAttempts ?? 2, 3, 1);
  const milliseconds = count(
    options.maxOperationMilliseconds ?? 25_000,
    25_000,
    1,
  );
  if (
    count(options.commitReserveMilliseconds ?? 1_000, 5_000, 1) >= milliseconds
  )
    throw new TypeError(
      "Completion reserve must be below the operation deadline",
    );
  return Object.freeze({
    async scanCandidates(
      bounds: Parameters<
        SupportDeskReleaseFollowupOptions["application"]["scanEngineeringFollowups"]
      >[1],
    ) {
      const runtime = createLearningRuntime(options);
      try {
        const authority = await releaseFollowupScanAuthority(options, runtime);
        const page = snapshot(
          await runtime.within(() =>
            options.application.scanEngineeringFollowups(
              authority.access,
              bounds,
            ),
          ),
        );
        await releaseFollowupScanAuthority(options, runtime, authority);
        return page;
      } finally {
        runtime.close();
      }
    },
    async processWork(
      command: Omit<ClaimEngineeringFollowupWorkCommand, "claimId">,
      run: { readonly signal?: AbortSignal } = {},
    ): Promise<ReleaseFollowupProcessResult> {
      if (
        options.invocationMode === "staged" &&
        (typeof options.application.planEngineeringFollowupModel !==
          "function" ||
          typeof options.application.beginEngineeringFollowupModel !==
            "function" ||
          typeof options.application.recordEngineeringFollowupModel !==
            "function")
      )
        return {
          outcome: "pending",
          stage: "prepare",
          reason: "staged_invocation_unavailable",
        };
      if (
        options.invocationMode === "staged" &&
        typeof options.checks.prepare !== "function"
      )
        return {
          outcome: "pending",
          stage: "prepare",
          reason: "staged_checks_unavailable",
        };
      const runtime = createLearningRuntime(options, run);
      // Never accept a caller's reusable physical claim identity.
      const physicalClaim = snapshot({
        ...command,
        claimId: crypto.randomUUID(),
      });
      try {
        const authority = await releaseFollowupAuthority(options, runtime);
        const acquired = await runtime.within(() =>
          options.application.claimEngineeringFollowupWork(
            authority.access,
            physicalClaim,
          ),
        );
        if (acquired === null) return { outcome: "not_claimed" };
        const claim = snapshot(acquired);
        runtime.ensure(
          Math.min(
            runtime.deadline,
            timestamp(claim.leaseUntil),
            timestamp(claim.work.deadline),
          ),
        );
        if (
          claim.work.candidate !== undefined ||
          claim.work.preparedBundle !== undefined ||
          claim.work.stage !== "model"
        )
          return await prepareWorkerBundle(options, claim, runtime);
        return await processReleaseFollowupModel(options, claim, runtime);
      } catch (error) {
        return {
          outcome: "pending",
          stage: "finish",
          reason: releaseFollowupFailure(error, "followup_unavailable"),
        };
      } finally {
        runtime.close();
      }
    },
    async prepareStaffReassessment(
      access: AccessContext,
      input: PrepareReleaseFollowupStaffReassessmentCommand,
      run: EngineeringMutationOptions = {},
    ) {
      const runtime = createLearningRuntime(options, run);
      const { signal, verifyBeforeCommit } = run;
      const ensureStaff = staffFence(access);
      const mutationOptionsFor = (
        deadline: () => number,
        required = false,
      ): EngineeringMutationOptions | undefined =>
        !required && signal === undefined && verifyBeforeCommit === undefined
          ? undefined
          : {
              signal: runtime.signal,
              async verifyBeforeCommit() {
                runtime.ensure(deadline());
                ensureStaff();
                const proof =
                  verifyBeforeCommit === undefined
                    ? undefined
                    : await runtime.within(
                        async () => verifyBeforeCommit(),
                        deadline(),
                      );
                runtime.ensure(deadline());
                ensureStaff();
                return (): true => {
                  runtime.ensure(deadline());
                  ensureStaff();
                  const current = proof === undefined ? true : proof();
                  runtime.ensure(deadline());
                  ensureStaff();
                  return current;
                };
              },
            };
      try {
        const command = snapshot(input);
        exactKeys(command, [
          "ticketId",
          "workId",
          "commandId",
          "correlationId",
          "expectedWorkGeneration",
          ...(command.content === undefined ? [] : ["content"]),
        ]);
        for (const value of [
          command.ticketId,
          command.workId,
          command.commandId,
          command.correlationId,
        ])
          scalar(value);
        count(command.expectedWorkGeneration, Number.MAX_SAFE_INTEGER, 1);
        const key = snapshot({
          ticketId: command.ticketId,
          workId: command.workId,
        });
        const recoveryIntentHash = await fingerprint({
          purpose: "support_release_followup",
          operation: "staff_reassessment",
          intent: command,
        });
        const recoveryCommand = snapshot({
          ...key,
          commandId: command.commandId,
          recoveryIntentHash,
        });
        const recover = async (): Promise<EngineeringFollowupResult | null> => {
          let failure: unknown;
          for (let attempt = 0; attempt < attempts; attempt += 1) {
            try {
              ensureStaff();
              const result = await runtime.within(() =>
                options.application.recoverEngineeringFollowupPreparation(
                  access,
                  recoveryCommand,
                ),
              );
              ensureStaff();
              if (
                result !== null &&
                (result.ticketId !== key.ticketId ||
                  result.workId !== key.workId)
              )
                throw new AssistantBoundaryError("preparation_mismatch");
              return result === null ? null : snapshot(result);
            } catch (error) {
              failure = error;
            }
          }
          throw new AssistantBoundaryError(
            releaseFollowupFailure(failure, "bundle_acknowledgement_unknown"),
          );
        };
        const reassess = options.application.reassessEngineeringFollowupBundle;
        if (reassess !== undefined) {
          let phaseDeadline = runtime.deadline;
          let verificationDeadline = phaseDeadline;
          const mutationOptions = mutationOptionsFor(
            () => verificationDeadline,
            true,
          );
          let failure: unknown;
          for (let attempt = 0; attempt < attempts; attempt += 1) {
            try {
              runtime.ensure(phaseDeadline);
              ensureStaff();
              const result = await runtime.within(() =>
                reassess.call(
                  options.application,
                  access,
                  {
                    ...key,
                    commandId: command.commandId,
                    correlationId: command.correlationId,
                    expectedWorkGeneration: command.expectedWorkGeneration,
                    recoveryIntentHash,
                  },
                  async (observation) => {
                    ensureStaff();
                    requireStaffRead(access, "prepare");
                    const view = snapshot(observation.read(access));
                    if (view.workGeneration !== command.expectedWorkGeneration)
                      throw new AssistantBoundaryError("current_fence_changed");
                    const work = prospectiveWork(view);
                    const observeCurrent = async (): Promise<void> => {
                      ensureStaff();
                      await runtime.within(() => observation.confirm(access));
                      ensureStaff();
                      const current = snapshot(observation.read(access));
                      if (
                        current.workGeneration !== view.workGeneration ||
                        current.prospectiveWorkBindingHash !==
                          view.prospectiveWorkBindingHash ||
                        canonical(current.proofContext) !==
                          canonical(view.proofContext) ||
                        canonical(current.proof.context) !==
                          canonical(view.proof.context)
                      )
                        throw new AssistantBoundaryError("source_changed");
                      runtime.ensure(
                        Math.min(
                          runtime.deadline,
                          timestamp(current.proof.attestation.validUntil),
                        ),
                      );
                    };
                    const checked = await prepareCheckedReleaseFollowupBundle(
                      options,
                      work,
                      command.content ??
                        retainedReleaseFollowupContent(view.work),
                      runtime,
                      observeCurrent,
                    );
                    phaseDeadline = Math.min(phaseDeadline, checked.deadline);
                    verificationDeadline = phaseDeadline;
                    return {
                      candidateHash: work.candidateHash!,
                      exactBundle: checked.bundle,
                      checksReceipt: checked.receipt,
                      checkPolicyVersion: checked.checkPolicyVersion,
                      guard: async () => {
                        await checked.guard();
                        verificationDeadline = Math.min(
                          phaseDeadline,
                          checked.verificationDeadline,
                        );
                      },
                    };
                  },
                  mutationOptions,
                ),
              );
              ensureStaff();
              return result;
            } catch (error) {
              failure = error;
              // Replanning is App-owned only after a genuine conditional conflict.
              // Known proof/authority failures still get opaque ACK recovery below.
              if (
                error instanceof AssistantBoundaryError ||
                error instanceof SupportDeskConflictError ||
                error instanceof SupportDeskAuthorizationError ||
                error instanceof TypeError
              )
                break;
            }
          }
          const accepted = await recover();
          if (accepted !== null) return accepted;
          throw new AssistantBoundaryError(
            releaseFollowupFailure(failure, "bundle_acknowledgement_unknown"),
          );
        }
        ensureStaff();
        const recovered = await recover();
        if (recovered !== null) return recovered;
        requireStaffRead(access, "prepare");
        const view = snapshot(
          await runtime.within(() =>
            options.application.readEngineeringFollowupReassessment(
              access,
              key,
            ),
          ),
        );
        ensureStaff();
        if (view.workGeneration !== command.expectedWorkGeneration)
          throw new AssistantBoundaryError("current_fence_changed");
        const work = prospectiveWork(view);
        const observeCurrent = async (): Promise<void> => {
          ensureStaff();
          // This app read resolves proof first, then checks direct current metadata last.
          const current = snapshot(
            await runtime.within(() =>
              options.application.readEngineeringFollowupReassessment(
                access,
                key,
              ),
            ),
          );
          ensureStaff();
          if (
            current.workGeneration !== view.workGeneration ||
            current.prospectiveWorkBindingHash !==
              view.prospectiveWorkBindingHash ||
            canonical(current.proofContext) !== canonical(view.proofContext) ||
            canonical(current.proof.context) !== canonical(view.proof.context)
          )
            throw new AssistantBoundaryError("source_changed");
          runtime.ensure(
            Math.min(
              runtime.deadline,
              timestamp(current.proof.attestation.validUntil),
            ),
          );
        };
        const checked = await prepareCheckedReleaseFollowupBundle(
          options,
          work,
          command.content ?? retainedReleaseFollowupContent(view.work),
          runtime,
          observeCurrent,
        );
        const prepare: PrepareEngineeringFollowupBundleCommand = snapshot({
          ticketId: command.ticketId,
          workId: command.workId,
          commandId: command.commandId,
          correlationId: command.correlationId,
          mode: "staff_reassessment",
          expectedWorkGeneration: command.expectedWorkGeneration,
          candidateHash: work.candidateHash!,
          exactBundle: checked.bundle,
          checksReceipt: checked.receipt,
          checkPolicyVersion: checked.checkPolicyVersion,
          recoveryIntentHash,
        });
        const mutationOptions = mutationOptionsFor(
          () => checked.verificationDeadline,
        );
        let failure: unknown;
        for (let attempt = 0; attempt < attempts; attempt += 1) {
          try {
            ensureStaff();
            const result = await runtime.within(
              () =>
                options.application.prepareEngineeringFollowupBundle(
                  access,
                  prepare,
                  checked.guard,
                  mutationOptions,
                ),
              checked.deadline,
            );
            ensureStaff();
            return result;
          } catch (error) {
            failure = error;
            // A host overrun is terminal; only non-deadline failures may renew proof.
            if (
              error instanceof AssistantBoundaryError &&
              error.category === "deadline"
            )
              break;
          }
        }
        const accepted = await recover();
        if (accepted !== null) return accepted;
        throw new AssistantBoundaryError(
          releaseFollowupFailure(failure, "bundle_acknowledgement_unknown"),
        );
      } finally {
        runtime.close();
      }
    },
    async approveAndPostWebUpdate(
      access: AccessContext,
      input: ApproveAndPostEngineeringFollowupWebUpdateCommand,
      run: EngineeringFollowupWebUpdateOptions = {},
    ) {
      const runtime = createLearningRuntime(options, run);
      const ensureStaff = staffFence(access);
      const { verifyBeforeCommit } = run;
      try {
        const command = snapshot(input);
        const key = snapshot({
          ticketId: command.ticketId,
          workId: command.workId,
        });
        let proofDeadline = runtime.deadline;
        const guardFailure = (error: unknown) =>
          new ReleaseFollowupReviewGuardFailure(
            releaseFollowupFailure(error, "verification_unavailable"),
          );
        // Lazy preflight lets the app recognize an exact historical posting receipt first.
        const guard = async (
          observation?: EngineeringFollowupPostObservation,
        ) => {
          try {
            ensureStaff();
            requireStaffRead(access, "post");
            const work = snapshot(
              observation === undefined
                ? await runtime.within(() =>
                    options.application.readEngineeringFollowupWork(
                      access,
                      key,
                    ),
                  )
                : observation.readWork(access),
            );
            ensureStaff();
            if (
              work.workGeneration !== command.expectedWorkGeneration ||
              work.preparedBundle?.bundleHash !== command.bundleHash ||
              work.acceptedTicketRevision !== command.expectedTicketRevision
            )
              throw new AssistantBoundaryError("bundle_changed");
            const deadline = await confirmStoredReleaseFollowupBundle(
              options,
              work,
              runtime,
              async () => {
                ensureStaff();
                let current;
                if (observation === undefined) {
                  current = await releaseFollowupCurrent(
                    options,
                    work,
                    access,
                    runtime,
                  );
                } else {
                  await runtime.within(() => observation.confirm(access));
                  current = observation.readWork(access);
                }
                ensureStaff();
                if (
                  current.workGeneration !== work.workGeneration ||
                  current.preparedBundle?.bundleHash !== command.bundleHash
                )
                  throw new AssistantBoundaryError("bundle_changed");
              },
            );
            ensureStaff();
            proofDeadline = deadline;
            return (): true => {
              try {
                runtime.ensure(deadline);
                ensureStaff();
                return true;
              } catch (error) {
                throw guardFailure(error);
              }
            };
          } catch (error) {
            throw guardFailure(error);
          }
        };
        const verifyAuthority = async (): Promise<void> => {
          try {
            runtime.ensure(proofDeadline);
            ensureStaff();
            if (verifyBeforeCommit !== undefined) {
              await runtime.within(async () => {
                await verifyBeforeCommit();
              }, proofDeadline);
            }
            runtime.ensure(proofDeadline);
            ensureStaff();
          } catch (error) {
            throw guardFailure(error);
          }
        };
        let uncertain = false;
        let failure: unknown;
        for (let attempt = 0; attempt < attempts; attempt += 1) {
          try {
            ensureStaff();
            const result = await runtime.within(() =>
              options.application.approveAndPostEngineeringFollowupWebUpdate(
                access,
                command,
                guard,
                {
                  signal: runtime.signal,
                  verifyBeforeCommit: verifyAuthority,
                },
              ),
            );
            ensureStaff();
            return result;
          } catch (error) {
            if (
              error instanceof ReleaseFollowupReviewGuardFailure &&
              !uncertain
            )
              throw error;
            uncertain = true;
            failure = error;
          }
        }
        // No new body/message ID is generated after a potentially accepted mutation.
        throw new AssistantBoundaryError(
          releaseFollowupFailure(failure, "posting_acknowledgement_unknown"),
        );
      } finally {
        runtime.close();
      }
    },
  });
}
