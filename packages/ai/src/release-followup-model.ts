import {
  engineeringFollowupModelAttemptCount,
  engineeringFollowupModelManifestHash,
  engineeringFollowupPublicFactsHash,
  type CompleteEngineeringFollowupModelCommand,
  type EngineeringFollowupClaim,
  type EngineeringFollowupPreparedModel,
  type EngineeringProcessing,
  type FinishEngineeringFollowupModelCommand,
  type PrepareEngineeringFollowupModelCommand,
} from "@pegma/support-desk-application";
import type {
  ReleaseFollowupAttemptContext,
  ReleaseFollowupModelResult,
  ReleaseFollowupProcessResult,
  ReleaseFollowupUsageIdentity,
  ReleaseFollowupUsageObservation,
  SupportDeskReleaseFollowupOptions,
} from "./release-followup-ports.js";
import type { LearningRuntime } from "./learning-runtime.js";
import {
  AssistantBoundaryError,
  canonical,
  count,
  fingerprint,
  scalar,
  snapshot,
  timestamp,
} from "./boundary.js";
import {
  releaseFollowupAuthority,
  releaseFollowupCheckPolicy,
  releaseFollowupConfiguration,
  releaseFollowupCurrent,
  releaseFollowupEvaluation,
  releaseFollowupFailure,
  releaseFollowupModelRequest,
  releaseFollowupProof,
  releaseFollowupProofSnapshot,
} from "./release-followup-request.js";
import {
  releaseFollowupCandidate,
  releaseFollowupProcessing,
  releaseFollowupUsage,
  releaseFollowupUsageBudget,
} from "./release-followup-output.js";
import { learningAuthoritySnapshot } from "./learning-request.js";

class ReleaseFollowupModelGuardFailure extends AssistantBoundaryError {}

/** Private claimed stage; the public coordinator owns each fresh physical claim. */
export async function processReleaseFollowupModel(
  options: SupportDeskReleaseFollowupOptions,
  rawClaim: EngineeringFollowupClaim,
  runtime: LearningRuntime,
): Promise<ReleaseFollowupProcessResult> {
  const claim = snapshot(rawClaim);
  const attempts = count(options.storageCommandAttempts ?? 2, 3, 1);
  const reserve = count(options.commitReserveMilliseconds ?? 1_000, 5_000, 1);
  const invocationId = crypto.randomUUID();
  const provider = new AbortController();
  const cancel = (): void => provider.abort();
  runtime.signal.addEventListener("abort", cancel, { once: true });
  let prepared: EngineeringFollowupPreparedModel | undefined;
  let processing: EngineeringProcessing | undefined;
  let identity: ReleaseFollowupUsageIdentity | undefined;
  let observation: ReleaseFollowupUsageObservation = { state: "not_called" };
  let accounting: "not_called" | "accounted" | "unknown" = "not_called";
  const settledAccounting = (): "accounted" | "unknown" =>
    accounting === "accounted" ? "accounted" : "unknown";
  const reconcile = async (): Promise<void> => {
    if (identity === undefined) return;
    try {
      const settled = await runtime.within(
        () => options.usage.reconcile(identity!, observation),
        runtime.deadline,
        true,
      );
      accounting =
        observation.state === "not_called"
          ? "not_called"
          : observation.state === "known" && settled === "reconciled"
            ? "accounted"
            : "unknown";
    } catch {
      accounting =
        observation.state === "not_called" ? "not_called" : "unknown";
    }
  };
  const finish = async (
    reason: string,
    disposition: "held" | "retry" = "held",
  ): Promise<ReleaseFollowupProcessResult> => {
    const command: FinishEngineeringFollowupModelCommand = snapshot({
      ...claim.fence,
      ...(prepared === undefined
        ? {}
        : { stepId: prepared.stepId, requestHash: prepared.requestHash }),
      disposition,
      accounting,
      reason,
      ...(processing === undefined ? {} : { processing }),
    });
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const resolved = await runtime.within(
          () => options.serviceAccess.resolve(runtime.signal),
          runtime.deadline,
          true,
        );
        if (resolved.outcome !== "ready")
          throw new AssistantBoundaryError("authority_unavailable");
        const authority = learningAuthoritySnapshot(resolved.authority);
        const result = await runtime.within(
          () =>
            options.application.finishEngineeringFollowupModel(
              authority.access,
              command,
            ),
          runtime.deadline,
          true,
        );
        return {
          outcome: result.status === "restricted" ? "restricted" : "held",
          result,
        };
      } catch {
        /* An invoked storage mutation may have committed: replay only the identical command. */
      }
    }
    return { outcome: "pending", stage: "finish", reason };
  };
  try {
    if (
      claim.work.candidate !== undefined ||
      claim.work.preparedBundle !== undefined ||
      claim.work.stage !== "model" ||
      claim.work.status !== "claimed" ||
      canonical(claim.work.claim) !== canonical(claim.fence)
    )
      throw new AssistantBoundaryError("invalid_claim");
    const operationId =
      "followup:" +
      (
        await fingerprint({
          ticketId: claim.fence.ticketId,
          workId: claim.fence.workId,
        })
      ).slice(0, 48);
    for (const old of claim.work.modelAttempts) {
      if (old.accounting !== "unknown") continue;
      try {
        await runtime.within(() =>
          options.usage.reconcile(
            {
              purpose: "support_release_followup",
              operationId,
              attemptId: old.stepId,
              inputFingerprint: old.binding.inputFingerprint,
              usageReservationId: old.binding.usageReservationId,
            },
            { state: "unknown" },
          ),
        );
      } catch {
        /* A possible paid attempt remains conservatively reserved. */
      }
    }
    if (claim.recoveredModelPreparation) {
      const old = claim.work.modelAttempts.find(
        (entry) => entry.stepId === claim.work.stepId,
      );
      if (old === undefined)
        throw new AssistantBoundaryError("preparation_mismatch");
      prepared = {
        stepId: old.stepId,
        requestHash: old.requestHash,
        maxCandidateBytes: 16_000,
      };
      accounting = "unknown";
      return await finish("recovered_preparation", "retry");
    }
    const authority = await releaseFollowupAuthority(options, runtime);
    const config = await releaseFollowupConfiguration(options, runtime);
    const previousAttempts = engineeringFollowupModelAttemptCount(claim.work);
    if (previousAttempts >= config.budgets.maxAttempts)
      throw new AssistantBoundaryError("budget_exceeded");
    const evaluation = await releaseFollowupEvaluation(
      options,
      config,
      runtime,
    );
    const policy = await releaseFollowupCheckPolicy(options, runtime);
    releaseFollowupProofSnapshot(
      claim.proof,
      claim.work,
      timestamp(options.clock.now()),
    );
    const proof = await releaseFollowupProof(options, claim.work, runtime);
    const request = await releaseFollowupModelRequest(
      options,
      claim,
      proof,
      config,
    );
    const deadline = Math.min(
      runtime.deadline,
      timestamp(claim.leaseUntil),
      timestamp(claim.work.deadline),
      timestamp(config.dataControls.validUntil),
      timestamp(evaluation.validUntil),
      timestamp(policy.validUntil),
      timestamp(proof.attestation.validUntil),
    );
    const providerDeadline = Math.min(
      deadline - reserve,
      timestamp(options.clock.now()) + config.budgets.maxDurationMilliseconds,
    );
    runtime.ensure(providerDeadline);
    const usageReservationId =
      "usage:" +
      (
        await fingerprint({
          purpose: "support_release_followup",
          operationId,
          invocationId,
        })
      ).slice(0, 48);
    const inputManifestHash = await engineeringFollowupModelManifestHash(
      request.manifest,
    );
    const inputFingerprint = await fingerprint({
      purpose: "support_release_followup",
      invocationId,
      operationId,
      fence: claim.fence,
      sourceFence: claim.sourceFence,
      input: request.input,
      manifest: request.manifest,
      configuration: config,
      authority,
      checkPolicy: policy,
      evaluation,
      proof,
      deadline,
      providerDeadline,
      usageReservationId,
    });
    const command: PrepareEngineeringFollowupModelCommand = snapshot({
      ...claim.fence,
      binding: {
        inputManifest: request.manifest,
        inputManifestHash,
        inputFingerprint,
        configVersion: config.version,
        promptVersion: config.promptVersion,
        modelVersion: config.modelVersion,
        parserVersion: config.parserVersion,
        checkPolicyVersion: policy.version,
        budgetsHash: await fingerprint(config.budgets),
        usageReservationId,
        deadline: new Date(deadline).toISOString(),
      },
    });
    const requestHash = await fingerprint(command.binding);
    const checkedPreparation = (
      raw: EngineeringFollowupPreparedModel,
    ): EngineeringFollowupPreparedModel => {
      const value = snapshot(raw);
      scalar(value.stepId);
      if (
        value.requestHash !== requestHash ||
        value.maxCandidateBytes !== 16_000 ||
        value.maxCandidateBytes < config.budgets.maxCandidateBytes
      )
        throw new AssistantBoundaryError("preparation_mismatch");
      return value;
    };
    const verifyCurrent = async (
      phase: number,
      beforeCall = false,
    ): Promise<void> => {
      const freshProof = await releaseFollowupProof(
        options,
        claim.work,
        runtime,
        phase,
      );
      if (
        (await engineeringFollowupPublicFactsHash(freshProof.publicFacts)) !==
        request.manifest.publicFactsHash
      )
        throw new AssistantBoundaryError("release_proof_changed");
      if (
        canonical(
          await releaseFollowupCheckPolicy(
            options,
            runtime,
            policy.version,
            phase,
          ),
        ) !== canonical(policy)
      )
        throw new AssistantBoundaryError("check_policy_changed");
      if (
        canonical(
          await releaseFollowupEvaluation(options, config, runtime, phase),
        ) !== canonical(evaluation)
      )
        throw new AssistantBoundaryError("evaluation_changed");
      if (
        canonical(
          await releaseFollowupConfiguration(
            options,
            runtime,
            config.version,
            phase,
          ),
        ) !== canonical(config)
      )
        throw new AssistantBoundaryError("configuration_changed");
      const currentAuthority = await releaseFollowupAuthority(
        options,
        runtime,
        authority,
        phase,
      );
      // No remote/config/proof/authority awaits below this final authoritative application bracket.
      const current = await releaseFollowupCurrent(
        options,
        claim.work,
        currentAuthority.access,
        runtime,
        phase,
      );
      const stored = current.modelAttempts.find(
        (entry) =>
          entry.stepId === prepared?.stepId &&
          entry.requestHash === requestHash,
      );
      if (
        stored === undefined ||
        canonical(stored.binding) !== canonical(command.binding)
      )
        throw new AssistantBoundaryError("preparation_mismatch");
      if (
        beforeCall &&
        (current.claim === undefined ||
          canonical(current.claim) !== canonical(claim.fence) ||
          current.status !== "model_prepared" ||
          current.stage !== "model" ||
          current.stepId !== prepared?.stepId ||
          current.requestHash !== requestHash ||
          current.candidate !== undefined ||
          current.preparedBundle !== undefined ||
          current.leaseUntil === undefined ||
          current.completionRows !== 5 ||
          current.messageSlots !== 1)
      )
        throw new AssistantBoundaryError("preparation_mismatch");
      runtime.ensure(
        Math.min(phase, timestamp(freshProof.attestation.validUntil)),
      );
    };
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const current = await releaseFollowupAuthority(
          options,
          runtime,
          authority,
          providerDeadline,
        );
        prepared = checkedPreparation(
          await runtime.within(
            () =>
              options.application.prepareEngineeringFollowupModel(
                current.access,
                command,
              ),
            providerDeadline,
          ),
        );
        break;
      } catch {
        /* A lost preparation ACK never authorizes generation. */
      }
    }
    if (prepared === undefined) return { outcome: "pending", stage: "prepare" };
    const context: ReleaseFollowupAttemptContext = Object.freeze({
      purpose: "support_release_followup",
      invocationId,
      operationId,
      attemptId: prepared.stepId,
      attempt: previousAttempts + 1,
      inputFingerprint,
      inputManifestHash,
      configurationVersion: config.version,
      promptVersion: config.promptVersion,
      modelVersion: config.modelVersion,
      parserVersion: config.parserVersion,
      evaluationVersion: evaluation.version,
      checkPolicyVersion: policy.version,
      authorityVersion: authority.authorityVersion,
      usageScopeRef: authority.usageScopeRef,
      usageReservationId,
      deadline: new Date(providerDeadline).toISOString(),
      signal: provider.signal,
      budgets: config.budgets,
    });
    identity = {
      purpose: "support_release_followup",
      operationId,
      attemptId: prepared.stepId,
      inputFingerprint,
      usageReservationId,
    };
    const reservation = await runtime.within(
      () => options.usage.reserve(context),
      providerDeadline,
    );
    if (
      reservation.outcome !== "reserved" ||
      reservation.usageReservationId !== usageReservationId
    )
      throw new AssistantBoundaryError("usage_unavailable");
    const replayAuthority = await releaseFollowupAuthority(
      options,
      runtime,
      authority,
      providerDeadline,
    );
    if (
      canonical(
        checkedPreparation(
          await runtime.within(
            () =>
              options.application.prepareEngineeringFollowupModel(
                replayAuthority.access,
                command,
              ),
            providerDeadline,
          ),
        ),
      ) !== canonical(prepared)
    )
      throw new AssistantBoundaryError("preparation_mismatch");
    await verifyCurrent(providerDeadline, true);
    runtime.ensure(providerDeadline);
    observation = { state: "unknown" };
    accounting = "unknown";
    let result: ReleaseFollowupModelResult;
    try {
      result = await runtime.within(
        () => options.model.generate(request.input, context, config),
        providerDeadline,
      );
    } catch (error) {
      provider.abort();
      throw error instanceof AssistantBoundaryError
        ? error
        : new AssistantBoundaryError("provider_unavailable");
    }
    const usage = releaseFollowupUsage(result);
    observation = { state: "known", usage };
    processing = releaseFollowupProcessing(result, usage, config);
    releaseFollowupUsageBudget(usage, config);
    const candidate = releaseFollowupCandidate(
      result,
      config,
      options.tokenCounter,
      prepared.maxCandidateBytes,
    );
    await reconcile();
    const completion: CompleteEngineeringFollowupModelCommand = snapshot({
      ...claim.fence,
      stepId: prepared.stepId,
      requestHash: prepared.requestHash,
      candidate,
      processing,
      accounting: settledAccounting(),
    });
    const guard = async (): Promise<void> => {
      try {
        await verifyCurrent(deadline);
      } catch (error) {
        throw new ReleaseFollowupModelGuardFailure(
          releaseFollowupFailure(error, "verification_unavailable"),
        );
      }
    };
    let uncertain = false;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const current = await releaseFollowupAuthority(
          options,
          runtime,
          authority,
          deadline,
        );
        const accepted = await runtime.within(
          () =>
            options.application.completeEngineeringFollowupModel(
              current.access,
              completion,
              guard,
            ),
          deadline,
        );
        return { outcome: "candidate", result: accepted };
      } catch (error) {
        if (error instanceof ReleaseFollowupModelGuardFailure && !uncertain)
          return await finish(error.category);
        uncertain = true;
      }
    }
    return { outcome: "pending", stage: "complete" };
  } catch (error) {
    await reconcile();
    return await finish(releaseFollowupFailure(error, "model_unavailable"));
  } finally {
    provider.abort();
    runtime.signal.removeEventListener("abort", cancel);
  }
}
