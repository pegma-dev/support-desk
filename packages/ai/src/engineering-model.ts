import {
  engineeringModelManifestHash,
  type CompleteEngineeringModelCommand,
  type EngineeringClaim,
  type EngineeringPreparedModel,
  type EngineeringProcessing,
  type FinishEngineeringWorkCommand,
  type PrepareEngineeringModelCommand,
} from "@pegma/support-desk-application";
import type {
  EngineeringAttemptContext,
  EngineeringModelResult,
  EngineeringProcessResult,
  EngineeringUsageIdentity,
  EngineeringUsageObservation,
  SupportDeskEngineeringOptions,
} from "./engineering-ports.js";
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
  engineeringAuthority,
  engineeringCalibration,
  engineeringCheckPolicy,
  engineeringConfiguration,
  engineeringCurrentFacts,
  engineeringFailureCategory,
  engineeringModelRequest,
  engineeringPolicy,
  engineeringProcessingAuthority,
  engineeringSource,
} from "./engineering-request.js";
import {
  engineeringCandidate,
  engineeringProcessing,
  engineeringUsage,
  engineeringUsageBudget,
} from "./engineering-output.js";
import type { LearningRuntime } from "./learning-runtime.js";

class EngineeringModelGuardFailure extends AssistantBoundaryError {}

/** Internal model stage. Claiming and physical invocation identity belong to the public coordinator. */
export async function processEngineeringModel(
  options: SupportDeskEngineeringOptions,
  rawClaim: EngineeringClaim,
  runtime: LearningRuntime,
): Promise<EngineeringProcessResult> {
  const claim = snapshot(rawClaim);
  const attempts = count(options.storageCommandAttempts ?? 2, 3, 1);
  const reserve = count(options.commitReserveMilliseconds ?? 1_000, 5_000, 1);
  const invocationId = crypto.randomUUID();
  const provider = new AbortController();
  const abort = (): void => {
    provider.abort();
  };
  runtime.signal.addEventListener("abort", abort, { once: true });
  let prepared: EngineeringPreparedModel | undefined;
  let processing: EngineeringProcessing | undefined;
  let identity: EngineeringUsageIdentity | undefined;
  let observation: EngineeringUsageObservation = { state: "not_called" };
  let accounting: "not_called" | "accounted" | "unknown" = "not_called";
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
  const settledAccounting = (): "accounted" | "unknown" =>
    accounting === "accounted" ? "accounted" : "unknown";
  const finish = async (
    reason: string,
    disposition: "held" | "restricted" | "retry" = "held",
  ): Promise<EngineeringProcessResult> => {
    const command: FinishEngineeringWorkCommand = snapshot({
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
        const current = await engineeringAuthority(
          options.serviceAccess,
          runtime,
        );
        const result = await runtime.within(() =>
          options.application.finishEngineeringWork(current.access, command),
        );
        return {
          outcome: result.status === "restricted" ? "restricted" : "held",
          result,
        };
      } catch {
        /* Only this identical finish command is replayed. */
      }
    }
    return { outcome: "pending", stage: "finish" };
  };
  try {
    if (
      claim.work.candidate !== undefined ||
      claim.work.proposal !== undefined ||
      claim.work.dispatch !== undefined ||
      claim.work.status !== "claimed" ||
      canonical(claim.work.claim) !== canonical(claim.fence)
    )
      throw new AssistantBoundaryError("invalid_claim");
    const operationId =
      "engineering:" +
      (
        await fingerprint({
          ticketId: claim.fence.ticketId,
          sourceGeneration: claim.fence.sourceGeneration,
        })
      ).slice(0, 48);
    for (const old of claim.work.modelAttempts) {
      if (old.accounting !== "unknown") continue;
      try {
        await runtime.within(() =>
          options.usage.reconcile(
            {
              purpose: "support_bug_assessment",
              operationId,
              attemptId: old.stepId,
              inputFingerprint: old.binding.inputFingerprint,
              usageReservationId: old.binding.usageReservationId,
            },
            { state: "unknown" },
          ),
        );
      } catch {
        /* Keep the durable reservation conservative. */
      }
    }
    if (claim.recoveredModelPreparation) {
      accounting = "unknown";
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
      return await finish("recovered_preparation", "retry");
    }
    const authority = await engineeringProcessingAuthority(
      options.serviceAccess,
      runtime,
    );
    const source = await engineeringSource(
      options,
      claim.sourceFence,
      runtime,
      authority,
    );
    const evidence = claim.work.evidence;
    const product = claim.work.product;
    if (
      evidence === undefined ||
      product === undefined ||
      canonical(evidence) !== canonical(source.evidence) ||
      canonical(product) !== canonical(source.product)
    )
      throw new AssistantBoundaryError("source_changed");
    const policy = await engineeringPolicy(options, authority, runtime);
    if (canonical(policy) !== canonical(claim.policy))
      throw new AssistantBoundaryError("repository_policy_changed");
    const config = await engineeringConfiguration(
      options.configuration,
      runtime,
      () => timestamp(options.clock.now()),
    );
    if (claim.work.modelAttempts.length >= config.budgets.maxAttempts)
      throw new AssistantBoundaryError("budget_exceeded");
    const checkPolicy = await engineeringCheckPolicy(options, runtime);
    const calibration = await engineeringCalibration(
      options,
      {
        modelVersion: config.modelVersion,
        promptVersion: config.promptVersion,
        parserVersion: config.parserVersion,
        policyHash: policy.policyHash,
      },
      runtime,
    );
    const request = engineeringModelRequest(
      claim,
      evidence,
      product,
      source.evidenceFingerprint!,
      config,
      options.tokenCounter,
    );
    const deadline = Math.min(
      runtime.deadline,
      timestamp(claim.leaseUntil),
      timestamp(claim.work.deadline),
      timestamp(config.dataControls.validUntil),
      timestamp(checkPolicy.validUntil),
      timestamp(calibration.validUntil),
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
          purpose: "support_bug_assessment",
          operationId,
          invocationId,
        })
      ).slice(0, 48);
    const inputManifestHash = await engineeringModelManifestHash(
      request.manifest,
    );
    const inputFingerprint = await fingerprint({
      purpose: "support_bug_assessment",
      invocationId,
      operationId,
      fence: claim.fence,
      sourceFence: claim.sourceFence,
      input: request.input,
      manifest: request.manifest,
      configuration: config,
      authority,
      policy,
      checkPolicy,
      calibration,
      deadline,
      providerDeadline,
      usageReservationId,
    });
    const command: PrepareEngineeringModelCommand = snapshot({
      ...claim.fence,
      binding: {
        inputManifest: request.manifest,
        inputManifestHash,
        inputFingerprint,
        configVersion: config.version,
        promptVersion: config.promptVersion,
        modelVersion: config.modelVersion,
        parserVersion: config.parserVersion,
        checkPolicyVersion: checkPolicy.version,
        budgetsHash: await fingerprint(config.budgets),
        usageReservationId,
        deadline: new Date(deadline).toISOString(),
      },
    });
    const requestHash = await fingerprint(command.binding);
    const checkedPreparation = (
      value: EngineeringPreparedModel,
    ): EngineeringPreparedModel => {
      scalar(value.stepId);
      if (
        value.requestHash !== requestHash ||
        value.maxCandidateBytes !== 16_000 ||
        value.maxCandidateBytes < config.budgets.maxCandidateBytes
      )
        throw new AssistantBoundaryError("preparation_mismatch");
      return snapshot(value);
    };
    const verifyCurrent = async (
      phase: number,
      beforeCall = false,
    ): Promise<void> => {
      await engineeringProcessingAuthority(
        options.serviceAccess,
        runtime,
        authority,
        phase,
      );
      if (
        canonical(
          await engineeringCheckPolicy(
            options,
            runtime,
            checkPolicy.version,
            phase,
          ),
        ) !== canonical(checkPolicy)
      )
        throw new AssistantBoundaryError("check_policy_changed");
      if (
        canonical(
          await engineeringCalibration(
            options,
            {
              modelVersion: config.modelVersion,
              promptVersion: config.promptVersion,
              parserVersion: config.parserVersion,
              policyHash: policy.policyHash,
            },
            runtime,
            phase,
          ),
        ) !== canonical(calibration)
      )
        throw new AssistantBoundaryError("routing_calibration_changed");
      const currentConfig = await engineeringConfiguration(
        options.configuration,
        runtime,
        () => timestamp(options.clock.now()),
        config.version,
        phase,
      );
      if (canonical(currentConfig) !== canonical(config))
        throw new AssistantBoundaryError("configuration_changed");
      const finalAuthority = await engineeringProcessingAuthority(
        options.serviceAccess,
        runtime,
        authority,
        phase,
      );
      const facts = await engineeringCurrentFacts(
        options,
        claim.sourceFence,
        finalAuthority,
        runtime,
        phase,
      );
      if (
        facts.source.evidenceFingerprint !== source.evidenceFingerprint ||
        canonical(facts.source.product) !== canonical(product)
      )
        throw new AssistantBoundaryError("source_changed");
      if (canonical(facts.policy) !== canonical(policy))
        throw new AssistantBoundaryError("repository_policy_changed");
      const storedAttempt = facts.work.modelAttempts.find(
        (entry) =>
          entry.stepId === prepared?.stepId &&
          entry.requestHash === requestHash,
      );
      if (
        storedAttempt === undefined ||
        canonical(storedAttempt.binding) !== canonical(command.binding)
      )
        throw new AssistantBoundaryError("preparation_mismatch");
      if (
        beforeCall &&
        (facts.work.claim === undefined ||
          canonical(facts.work.claim) !== canonical(claim.fence) ||
          facts.work.status !== "prepared" ||
          facts.work.stage !== "model" ||
          facts.work.stepId !== prepared?.stepId ||
          facts.work.requestHash !== requestHash ||
          facts.work.candidate !== undefined ||
          facts.work.dispatch !== undefined ||
          facts.work.leaseUntil === undefined)
      )
        throw new AssistantBoundaryError("preparation_mismatch");
      runtime.ensure(phase);
    };
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const current = await engineeringAuthority(
          options.serviceAccess,
          runtime,
          providerDeadline,
        );
        prepared = checkedPreparation(
          await runtime.within(
            () =>
              options.application.prepareEngineeringModel(
                current.access,
                command,
              ),
            providerDeadline,
          ),
        );
        break;
      } catch {
        /* A lost preparation acknowledgement never permits generation. */
      }
    }
    if (prepared === undefined) return { outcome: "pending", stage: "prepare" };
    const context: EngineeringAttemptContext = Object.freeze({
      purpose: "support_bug_assessment",
      invocationId,
      operationId,
      attemptId: prepared.stepId,
      attempt: claim.work.modelAttempts.length + 1,
      inputFingerprint,
      inputManifestHash,
      configurationVersion: config.version,
      promptVersion: config.promptVersion,
      modelVersion: config.modelVersion,
      parserVersion: config.parserVersion,
      policyVersion: checkPolicy.version,
      authorityVersion: authority.authorityVersion,
      usageScopeRef: authority.usageScopeRef,
      usageReservationId,
      deadline: new Date(providerDeadline).toISOString(),
      signal: provider.signal,
      budgets: config.budgets,
    });
    identity = {
      purpose: "support_bug_assessment",
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
    const current = await engineeringAuthority(
      options.serviceAccess,
      runtime,
      providerDeadline,
    );
    if (
      canonical(
        checkedPreparation(
          await runtime.within(
            () =>
              options.application.prepareEngineeringModel(
                current.access,
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
    let result: EngineeringModelResult;
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
    const usage = engineeringUsage(result);
    observation = { state: "known", usage };
    processing = engineeringProcessing(result, usage, config);
    engineeringUsageBudget(usage, config);
    const candidate = engineeringCandidate(
      result,
      config,
      request.input,
      product,
      options.tokenCounter,
      prepared.maxCandidateBytes,
    );
    await reconcile();
    const complete: CompleteEngineeringModelCommand = snapshot({
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
        throw new EngineeringModelGuardFailure(
          error instanceof AssistantBoundaryError
            ? error.category
            : "verification_unavailable",
        );
      }
    };
    let uncertain = false;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const current = await engineeringAuthority(
          options.serviceAccess,
          runtime,
          deadline,
        );
        const accepted = await runtime.within(
          () =>
            options.application.completeEngineeringModel(
              current.access,
              complete,
              guard,
            ),
          deadline,
        );
        return {
          outcome:
            accepted.status === "restricted" ? "restricted" : "candidate",
          result: accepted,
        };
      } catch (error) {
        if (error instanceof EngineeringModelGuardFailure && !uncertain)
          return await finish(
            error.category,
            error.category === "security_restricted" ? "restricted" : "held",
          );
        uncertain = true;
        let revoked = false;
        try {
          const access = await engineeringAuthority(
            options.serviceAccess,
            runtime,
            deadline,
          );
          const source = await runtime.within(
            () =>
              options.application.readEngineeringSource(
                access.access,
                claim.fence.ticketId,
              ),
            deadline,
          );
          revoked =
            source.state !== "eligible" ||
            source.security !== "ordinary" ||
            source.sourceGeneration !== claim.sourceFence.sourceGeneration ||
            source.sourceBindingHash !== claim.sourceFence.sourceBindingHash;
        } catch {
          /* Unavailability does not prove revocation. */
        }
        if (revoked) {
          const held = await finish("source_changed");
          return held.outcome === "pending"
            ? { outcome: "pending", stage: "complete" }
            : held;
        }
      }
    }
    return { outcome: "pending", stage: "complete" };
  } catch (error) {
    await reconcile();
    const reason = engineeringFailureCategory(
      error,
      "engineering_processing_unavailable",
    );
    return await finish(
      reason,
      ["security_restricted", "malformed_output"].includes(reason)
        ? "restricted"
        : "held",
    );
  } finally {
    provider.abort();
    runtime.signal.removeEventListener("abort", abort);
  }
}
