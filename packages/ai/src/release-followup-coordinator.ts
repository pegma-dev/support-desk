import { hasPermission, type AccessContext } from "@pegma/authorization-core";
import {
  SupportDeskAuthorizationError,
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
  FinishEngineeringFollowupModelCommand,
  PrepareEngineeringFollowupBundleCommand,
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
      disposition: restricted ? "restricted" : "held",
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
    const observeCurrent = async (): Promise<void> => {
      const currentAuthority = await releaseFollowupAuthority(
        options,
        runtime,
        authority,
        phase,
      );
      const current = await releaseFollowupCurrent(
        options,
        claim.work,
        currentAuthority.access,
        runtime,
        phase,
      );
      if (
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
      run: { readonly signal?: AbortSignal } = {},
    ) {
      const runtime = createLearningRuntime(options, run);
      const ensureStaff = staffFence(access);
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
                ),
              checked.deadline,
            );
            ensureStaff();
            return result;
          } catch (error) {
            failure = error;
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
        const guard = async () => {
          try {
            ensureStaff();
            requireStaffRead(access, "post");
            const work = snapshot(
              await runtime.within(() =>
                options.application.readEngineeringFollowupWork(access, key),
              ),
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
                const current = await releaseFollowupCurrent(
                  options,
                  work,
                  access,
                  runtime,
                );
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
                try {
                  await verifyBeforeCommit();
                } catch {
                  throw new AssistantBoundaryError("verification_unavailable");
                }
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
