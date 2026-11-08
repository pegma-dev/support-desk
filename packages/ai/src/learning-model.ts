import type {
  CompleteResolutionLearningStepCommand,
  FinishResolutionLearningWorkCommand,
  PrepareResolutionLearningStepCommand,
  ResolutionLearningClaim,
  ResolutionLearningPreparedStep,
  ResolutionLearningProcessing,
} from "@pegma/support-desk-application";
import type {
  LearningAttemptContext,
  LearningModelExecutor,
  LearningModelExecutorOptions,
  LearningModelProcessResult,
  LearningModelResult,
  LearningServiceAuthority,
  LearningUsageIdentity,
  LearningUsageObservation,
  VerifiedLearningCheckPolicy,
  VerifiedLearningConfiguration,
} from "./learning-ports.js";
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
  learningAuthoritySnapshot,
  learningCheckPolicySnapshot,
  learningConfigurationSnapshot,
  learningInputManifest,
  learningModelInput,
} from "./learning-request.js";
import {
  enforceLearningModelIdentity,
  enforceLearningUsageBudget,
  learningCandidate,
  learningModelUsage,
  learningProcessingMetadata,
} from "./learning-output.js";

class LearningGuardFailure extends AssistantBoundaryError {}

/** Internal claimed-stage executor. Public scan/claim/delivery belongs to the coordinator. */
export function createLearningModelExecutor(
  options: LearningModelExecutorOptions,
): LearningModelExecutor {
  const operationMilliseconds = count(
    options.maxOperationMilliseconds ?? 25_000,
    25_000,
    1,
  );
  const commitReserve = count(
    options.commitReserveMilliseconds ?? 1_000,
    5_000,
    1,
  );
  const commandAttempts = count(options.storageCommandAttempts ?? 2, 3, 1);
  if (commitReserve >= operationMilliseconds)
    throw new TypeError(
      "Completion reserve must be below the operation deadline",
    );

  return Object.freeze({
    async processClaim(
      rawClaim: ResolutionLearningClaim,
      runOptions: { readonly signal?: AbortSignal } = {},
    ): Promise<LearningModelProcessResult> {
      const started = performance.now();
      const startTime = timestamp(options.clock.now());
      const claim = snapshot(rawClaim);
      if (
        claim.work.stage !== "model" ||
        claim.work.candidate !== undefined ||
        claim.work.exactRequest !== undefined ||
        claim.work.status !== "claimed" ||
        canonical(claim.work.claim) !== canonical(claim.fence) ||
        claim.work.sourceBindingHash !== claim.sourceFence.sourceBindingHash ||
        claim.work.sourceGeneration !== claim.sourceFence.sourceGeneration ||
        claim.work.resolutionCycle !== claim.sourceFence.resolutionCycle ||
        claim.work.ticketId !== claim.fence.ticketId ||
        claim.sourceFence.ticketId !== claim.fence.ticketId ||
        claim.fence.sourceGeneration !== claim.sourceFence.sourceGeneration
      )
        throw new AssistantBoundaryError("invalid_claim");
      for (const value of [
        claim.fence.ticketId,
        claim.fence.workerId,
        claim.fence.claimId,
        claim.sourceFence.sourceBindingHash,
      ])
        scalar(value);
      count(claim.fence.sourceGeneration, Number.MAX_SAFE_INTEGER, 1);
      count(claim.fence.claimGeneration, Number.MAX_SAFE_INTEGER, 1);
      const baseDeadline = Math.min(
        startTime + operationMilliseconds,
        timestamp(claim.leaseUntil),
        timestamp(claim.work.deadline),
      );
      // A fresh nonce also prevents two accidental dispatches of the same claim
      // from preparing an identical provider request under one durable owner.
      const invocationId = crypto.randomUUID();
      const controller = new AbortController();
      const providerController = new AbortController();
      const external = runOptions.signal;
      const cancel = (): void => {
        controller.abort();
        providerController.abort();
      };
      if (external?.aborted) cancel();
      else external?.addEventListener("abort", cancel, { once: true });
      let observation: LearningUsageObservation = { state: "not_called" };
      let accounting: "not_called" | "accounted" | "unknown" = "not_called";
      let identity: LearningUsageIdentity | undefined;
      let processing: ResolutionLearningProcessing | undefined;
      let prepared:
        Extract<ResolutionLearningPreparedStep, { step: "model" }> | undefined;

      // Both clocks enforce every phase. A frozen/backward host Clock cannot
      // extend a short lease, configuration expiry, or provider phase in real time.
      const remaining = (deadline = baseDeadline): number =>
        Math.min(
          deadline - timestamp(options.clock.now()),
          deadline - startTime - (performance.now() - started),
        );
      const ensure = (deadline = baseDeadline, cleanup = false): void => {
        if (!cleanup && controller.signal.aborted)
          throw new AssistantBoundaryError("cancelled");
        if (remaining(deadline) <= 0)
          throw new AssistantBoundaryError("deadline");
      };
      const within = async <T>(
        action: () => Promise<T>,
        deadline = baseDeadline,
        cleanup = false,
      ): Promise<T> => {
        ensure(deadline, cleanup);
        let timer: ReturnType<typeof setTimeout> | undefined;
        let onAbort: (() => void) | undefined;
        const boundary = new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new AssistantBoundaryError("deadline")),
            Math.max(1, Math.floor(remaining(deadline))),
          );
          onAbort = () => reject(new AssistantBoundaryError("cancelled"));
          if (!cleanup)
            controller.signal.addEventListener("abort", onAbort, {
              once: true,
            });
        });
        try {
          const value = await Promise.race([
            Promise.resolve().then(() => {
              ensure(deadline, cleanup);
              return action();
            }),
            boundary,
          ]);
          ensure(deadline, cleanup);
          return value;
        } finally {
          if (timer !== undefined) clearTimeout(timer);
          if (onAbort !== undefined)
            controller.signal.removeEventListener("abort", onAbort);
        }
      };
      const authority = async (
        deadline = baseDeadline,
      ): Promise<LearningServiceAuthority> => {
        const result = await within(
          () => options.serviceAccess.resolve(controller.signal),
          deadline,
        );
        if (result.outcome !== "ready")
          throw new AssistantBoundaryError("authority_unavailable");
        return learningAuthoritySnapshot(result.authority);
      };
      const configuration = async (
        expectedVersion: string | undefined = undefined,
        deadline = baseDeadline,
      ): Promise<VerifiedLearningConfiguration> => {
        const result = await within(
          () =>
            options.configuration.resolve(expectedVersion, controller.signal),
          deadline,
        );
        if (result.outcome !== "ready")
          throw new AssistantBoundaryError("configuration_unavailable");
        const value = learningConfigurationSnapshot(
          result.configuration,
          timestamp(options.clock.now()),
        );
        if (expectedVersion !== undefined && value.version !== expectedVersion)
          throw new AssistantBoundaryError("configuration_changed");
        return value;
      };
      const checkPolicy = async (
        expectedVersion: string | undefined = undefined,
        deadline = baseDeadline,
      ): Promise<VerifiedLearningCheckPolicy> => {
        const result = await within(
          () =>
            options.checkPolicy.resolvePolicy(
              expectedVersion,
              controller.signal,
            ),
          deadline,
        );
        if (result.outcome !== "ready")
          throw new AssistantBoundaryError("check_policy_unavailable");
        const value = learningCheckPolicySnapshot(
          result.policy,
          timestamp(options.clock.now()),
        );
        if (expectedVersion !== undefined && value.version !== expectedVersion)
          throw new AssistantBoundaryError("check_policy_changed");
        return value;
      };
      const reconcile = async (): Promise<void> => {
        if (identity === undefined) return;
        try {
          const settled = await within(
            () => options.usage.reconcile(identity!, observation),
            baseDeadline,
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
      const completionAccounting = (): "accounted" | "unknown" =>
        accounting === "accounted" ? "accounted" : "unknown";
      const finish = async (
        reason: string,
        disposition: "retry" | "held" = "held",
      ): Promise<LearningModelProcessResult> => {
        const command: FinishResolutionLearningWorkCommand = snapshot({
          ...claim.fence,
          ...(prepared === undefined
            ? {}
            : { stepId: prepared.stepId, requestHash: prepared.requestHash }),
          disposition,
          accounting,
          reason,
          ...(processing === undefined ? {} : { processing }),
        });
        for (let attempt = 0; attempt < commandAttempts; attempt += 1) {
          try {
            const current = await authority();
            const result = await within(() =>
              options.application.finishResolutionLearningWork(
                current.access,
                command,
              ),
            );
            return { outcome: "finished", result };
          } catch {
            /* Retry only the same immutable finish command. */
          }
        }
        return { outcome: "pending", stage: "finish" };
      };

      try {
        const operationId =
          "learning:" +
          (
            await fingerprint({
              ticketId: claim.fence.ticketId,
              sourceGeneration: claim.fence.sourceGeneration,
            })
          ).slice(0, 48);
        // Every recovered reservation may have funded a call, including a lost
        // preparation acknowledgement. Reconcile unknown without regenerating it.
        for (const old of claim.work.modelAttempts) {
          if (old.accounting !== "unknown") continue;
          try {
            await within(() =>
              options.usage.reconcile(
                {
                  purpose: "support_learning",
                  operationId,
                  attemptId: old.stepId,
                  inputFingerprint: old.binding.inputFingerprint,
                  usageReservationId: old.binding.usageReservationId,
                },
                { state: "unknown" },
              ),
            );
          } catch {
            /* Its durable reservation stays conservatively pending. */
          }
        }
        if (claim.recoveredModelPreparation) {
          accounting = "unknown";
          const old = claim.work.modelAttempts.find(
            (attempt) => attempt.stepId === claim.work.stepId,
          );
          if (old === undefined)
            throw new AssistantBoundaryError("preparation_mismatch");
          prepared = {
            step: "model",
            stepId: old.stepId,
            requestHash: old.requestHash,
            maxCandidateBytes: 16_000,
          };
          return await finish("recovered_preparation", "retry");
        }

        const config = await configuration();
        if (claim.work.modelAttempts.length >= config.budgets.maxAttempts)
          throw new AssistantBoundaryError("budget_exceeded");
        const initialAuthority = await authority();
        const policy = await checkPolicy();
        const manifest = learningInputManifest(claim);
        const input = learningModelInput(
          claim,
          manifest,
          config,
          options.tokenCounter,
        );
        const deadlineMilliseconds = Math.min(
          baseDeadline,
          timestamp(config.dataControls.validUntil),
          timestamp(policy.validUntil),
        );
        const providerDeadline = Math.min(
          deadlineMilliseconds - commitReserve,
          timestamp(options.clock.now()) +
            config.budgets.maxDurationMilliseconds,
        );
        ensure(providerDeadline);
        const deadline = new Date(deadlineMilliseconds).toISOString();
        const usageReservationId =
          "usage:" +
          (
            await fingerprint({
              purpose: "support_learning",
              operationId,
              invocationId,
            })
          ).slice(0, 48);
        const inputManifestHash = await fingerprint(manifest);
        const budgetsHash = await fingerprint(config.budgets);
        const inputFingerprint = await fingerprint({
          purpose: "support_learning",
          invocationId,
          operationId,
          fence: claim.fence,
          sourceFence: claim.sourceFence,
          input,
          manifest,
          configuration: config,
          authority: initialAuthority,
          checkPolicy: policy,
          deadline,
          providerDeadline,
          usageReservationId,
        });
        const binding = snapshot({
          inputManifest: manifest,
          inputFingerprint,
          inputManifestHash,
          configVersion: config.version,
          promptVersion: config.promptVersion,
          modelVersion: config.modelVersion,
          checkPolicyVersion: policy.version,
          budgetsHash,
          usageReservationId,
          deadline,
        });
        const command: PrepareResolutionLearningStepCommand = snapshot({
          ...claim.fence,
          step: "model",
          binding,
        });
        const expectedRequestHash = await fingerprint(binding);
        const checkedPreparation = (
          ack: ResolutionLearningPreparedStep,
        ): Extract<ResolutionLearningPreparedStep, { step: "model" }> => {
          scalar(ack.stepId);
          if (
            ack.step !== "model" ||
            ack.requestHash !== expectedRequestHash ||
            ack.maxCandidateBytes < config.budgets.maxCandidateBytes ||
            ack.maxCandidateBytes !== 16_000
          )
            throw new AssistantBoundaryError("preparation_mismatch");
          return snapshot(ack);
        };
        const verifyCurrent = async (
          phaseDeadline: number,
        ): Promise<LearningServiceAuthority> => {
          ensure(phaseDeadline);
          const currentAuthority = await authority(phaseDeadline);
          if (canonical(currentAuthority) !== canonical(initialAuthority))
            throw new AssistantBoundaryError("authority_changed");
          const eligible = await within(
            () =>
              options.application.confirmResolutionLearningSource(
                currentAuthority.access,
                claim.sourceFence,
              ),
            phaseDeadline,
          );
          if (!eligible) throw new AssistantBoundaryError("source_changed");
          const currentPolicy = await checkPolicy(
            policy.version,
            phaseDeadline,
          );
          if (canonical(currentPolicy) !== canonical(policy))
            throw new AssistantBoundaryError("check_policy_changed");
          // Last awaited observation before paid generation, following reservation,
          // is the exact current independently verified processing route.
          const currentConfig = await configuration(
            config.version,
            phaseDeadline,
          );
          if (canonical(currentConfig) !== canonical(config))
            throw new AssistantBoundaryError("configuration_changed");
          ensure(phaseDeadline);
          return currentAuthority;
        };
        for (let attempt = 0; attempt < commandAttempts; attempt += 1) {
          try {
            const current = await authority(providerDeadline);
            prepared = checkedPreparation(
              await within(
                () =>
                  options.application.prepareResolutionLearningStep(
                    current.access,
                    command,
                  ),
                providerDeadline,
              ),
            );
            break;
          } catch {
            /* Unknown acknowledgement: repeat exactly; never call yet. */
          }
        }
        if (prepared === undefined)
          return { outcome: "pending", stage: "prepare" };
        const context: LearningAttemptContext = Object.freeze({
          purpose: "support_learning",
          invocationId,
          operationId,
          attemptId: prepared.stepId,
          attempt: claim.work.modelAttempts.length + 1,
          fence: claim.fence,
          sourceFence: claim.sourceFence,
          inputFingerprint,
          inputManifestHash,
          configurationVersion: config.version,
          promptVersion: config.promptVersion,
          modelVersion: config.modelVersion,
          checkPolicyVersion: policy.version,
          authorityVersion: initialAuthority.authorityVersion,
          usageScopeRef: initialAuthority.usageScopeRef,
          usageReservationId,
          deadline: new Date(providerDeadline).toISOString(),
          signal: providerController.signal,
          budgets: config.budgets,
        });
        identity = {
          purpose: "support_learning",
          operationId,
          attemptId: prepared.stepId,
          inputFingerprint,
          usageReservationId,
        };
        const reservation = await within(
          () => options.usage.reserve(context),
          providerDeadline,
        );
        if (
          reservation.outcome !== "reserved" ||
          reservation.usageReservationId !== usageReservationId
        )
          throw new AssistantBoundaryError("usage_unavailable");
        const current = await authority(providerDeadline);
        const confirmed = checkedPreparation(
          await within(
            () =>
              options.application.prepareResolutionLearningStep(
                current.access,
                command,
              ),
            providerDeadline,
          ),
        );
        if (canonical(confirmed) !== canonical(prepared))
          throw new AssistantBoundaryError("preparation_mismatch");
        await verifyCurrent(providerDeadline);
        ensure(providerDeadline);
        observation = { state: "unknown" };
        accounting = "unknown";
        let result: LearningModelResult;
        try {
          result = await within(
            () => options.model.generate(input, context, config),
            providerDeadline,
          );
        } catch (error) {
          providerController.abort();
          throw error;
        }
        const usage = learningModelUsage(result);
        observation = { state: "known", usage };
        enforceLearningModelIdentity(result, config);
        processing = learningProcessingMetadata(result, usage);
        enforceLearningUsageBudget(usage, config);
        const candidate = learningCandidate(
          result,
          config,
          manifest,
          options.tokenCounter,
          prepared.maxCandidateBytes,
        );
        await reconcile();
        const completion: CompleteResolutionLearningStepCommand = snapshot({
          ...claim.fence,
          step: "model",
          stepId: prepared.stepId,
          requestHash: prepared.requestHash,
          candidate,
          processing,
          accounting: completionAccounting(),
        });
        const guard = async (): Promise<void> => {
          try {
            await verifyCurrent(deadlineMilliseconds);
          } catch (error) {
            throw new LearningGuardFailure(
              error instanceof AssistantBoundaryError
                ? error.category
                : "verification_unavailable",
            );
          }
        };
        let uncertainCompletion = false;
        for (let attempt = 0; attempt < commandAttempts; attempt += 1) {
          try {
            const current = await authority(deadlineMilliseconds);
            const accepted = await within(
              () =>
                options.application.completeResolutionLearningStep(
                  current.access,
                  completion,
                  guard,
                ),
              deadlineMilliseconds,
            );
            return { outcome: "candidate", result: accepted };
          } catch (error) {
            if (error instanceof LearningGuardFailure) {
              if (!uncertainCompletion) return await finish(error.category);
            }
            // A completed CAS may have lost its acknowledgement. Keep the exact
            // candidate/metadata/accounting for every retry and never call again.
            uncertainCompletion = true;
            let sourceRevoked = false;
            try {
              const current = await authority(deadlineMilliseconds);
              const eligible = await within(
                () =>
                  options.application.confirmResolutionLearningSource(
                    current.access,
                    claim.sourceFence,
                  ),
                deadlineMilliseconds,
              );
              sourceRevoked = eligible === false;
            } catch {
              // Unavailable authority or confirmation does not prove revocation.
            }
            if (sourceRevoked) {
              // Revocation alone cannot prove whether completion committed. This
              // exact-step finish is allowed only while the original claim still
              // owns unfinished work. Acceptance clears that claim, so a lost
              // completion acknowledgement cannot be overwritten by this hold.
              const held = await finish("source_changed");
              return held.outcome === "finished"
                ? held
                : { outcome: "pending", stage: "complete" };
            }
          }
        }
        return { outcome: "pending", stage: "complete" };
      } catch (error) {
        await reconcile();
        const category =
          error instanceof AssistantBoundaryError
            ? error.category
            : "provider_unavailable";
        return await finish(category);
      } finally {
        controller.abort();
        providerController.abort();
        external?.removeEventListener("abort", cancel);
      }
    },
  });
}
