import type {
  AssistantAttemptBinding,
  AssistantEscalationReason,
  AssistantTurnAccounting,
  AssistantTurnClaim,
  AssistantTurnProcessingMetadata,
  AssistantTurnScanBounds,
  CompleteAssistantTurnCommand,
  FinishAssistantTurnAttemptCommand,
} from "@pegma/support-desk-application";
import type {
  AssistantAttemptContext,
  AssistantAttemptBudgets,
  AssistantCustomerAuthority,
  AssistantModelInput,
  AssistantModelResult,
  AssistantModelUsage,
  AssistantProcessResult,
  AssistantUsageIdentity,
  AssistantUsageObservation,
  ProcessAssistantTurnCommand,
  SupportDeskAssistant,
  SupportDeskAssistantOptions,
  VerifiedAssistantConfiguration,
} from "./ports.js";
import {
  AssistantBoundaryError,
  canonical,
  count,
  fingerprint,
  snapshot,
  timestamp,
} from "./boundary.js";
import {
  authoritySnapshot,
  configurationSnapshot,
  modelInput,
  retrievalQuery,
  sourceSnapshot,
} from "./request.js";
import {
  answerBody,
  answerTextAllowance,
  escalationReasons,
  modelDecision,
  modelUsage,
  processingMetadata,
} from "./output.js";
import {
  generationStageVersion,
  isRetrievalPreparation,
  retrievalStageVersion,
  stagedInputFingerprint,
  stagedPreparation,
  stagedReferences,
  verifyStagedPreparation,
} from "./staged-retrieval.js";

class GuardFailure extends AssistantBoundaryError {}

/** Optional composition only. The base application remains the durable authority. */
export function createSupportDeskAssistant(
  options: SupportDeskAssistantOptions,
): SupportDeskAssistant {
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
  const maxMessageCharacters = count(
    options.maxMessageCharacters ?? 20_000,
    20_000,
    1,
  );
  const stagedRetrieval = options.stagedRetrieval === true;
  if (commitReserve >= operationMilliseconds)
    throw new TypeError(
      "Completion reserve must be below the operation deadline",
    );

  return Object.freeze({
    async scanCandidates(bounds: AssistantTurnScanBounds) {
      return options.application.scanAssistantTurnCandidates(
        await options.serviceAccess(),
        bounds,
      );
    },

    async processTurn(
      command: ProcessAssistantTurnCommand,
      runOptions: { readonly signal?: AbortSignal } = {},
    ): Promise<AssistantProcessResult> {
      const started = performance.now();
      const startTime = timestamp(options.clock.now());
      const operationDeadline = startTime + operationMilliseconds;
      // Lower-level claims intentionally replay identical owner IDs. A physical
      // coordinator execution must instead have an exclusive durable owner, so
      // concurrent scheduler callbacks cannot both prepare and call one attempt.
      const claimCommand = snapshot({
        ...command,
        claimId: crypto.randomUUID(),
      });
      const controller = new AbortController();
      const providerController = new AbortController();
      const external = runOptions.signal;
      const cancel = (): void => {
        controller.abort();
        providerController.abort();
      };
      if (external?.aborted) controller.abort();
      else external?.addEventListener("abort", cancel, { once: true });
      let claim: AssistantTurnClaim | undefined;
      let accounting: AssistantTurnAccounting = "not_called";
      let usageIdentity: AssistantUsageIdentity | undefined;
      let observation: AssistantUsageObservation = { state: "not_called" };
      let processing: AssistantTurnProcessingMetadata | undefined;

      const remaining = (deadline = operationDeadline): number =>
        Math.min(
          deadline - timestamp(options.clock.now()),
          operationMilliseconds - (performance.now() - started),
        );
      const ensure = (deadline = operationDeadline, cleanup = false): void => {
        if (!cleanup && controller.signal.aborted)
          throw new AssistantBoundaryError("cancelled");
        if (remaining(deadline) <= 0)
          throw new AssistantBoundaryError("deadline");
      };
      const within = async <T>(
        action: () => Promise<T>,
        deadline = operationDeadline,
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
      const reconcile = async (): Promise<void> => {
        if (usageIdentity === undefined) return;
        try {
          const state = await within(
            () => options.usage.reconcile(usageIdentity!, observation),
            operationDeadline,
            true,
          );
          accounting =
            observation.state === "not_called"
              ? "not_called"
              : observation.state === "known" && state === "reconciled"
                ? "accounted"
                : "unknown";
        } catch {
          accounting =
            observation.state === "not_called" ? "not_called" : "unknown";
        }
      };
      const finish = async (
        reason: AssistantEscalationReason,
        disposition: "retry" | "escalate" = "escalate",
        category?: string,
      ): Promise<AssistantProcessResult> => {
        if (claim === undefined) return { outcome: "not_claimed" };
        const finishCommand: FinishAssistantTurnAttemptCommand = {
          ...claim.fence,
          disposition,
          accounting,
          reason,
          summary:
            "The automated answer could not be safely completed. A person can help with this conversation.",
          ...(processing === undefined && category === undefined
            ? {}
            : {
                processing: {
                  ...processing,
                  ...(category === undefined
                    ? {}
                    : { failureCategory: category }),
                },
              }),
        };
        for (let attempt = 0; attempt < commandAttempts; attempt += 1) {
          try {
            const result = await within(
              async () =>
                options.application.finishAssistantTurnAttempt(
                  await options.serviceAccess(),
                  finishCommand,
                ),
              operationDeadline,
              true,
            );
            return { outcome: "finished", result };
          } catch {
            /* Retry only this identical command. */
          }
        }
        return { outcome: "pending", stage: "finish" };
      };
      const configuration = async (
        expectedVersion?: string,
        phaseDeadline = operationDeadline,
      ): Promise<VerifiedAssistantConfiguration> => {
        const current = await within(
          () => options.configuration.resolve(expectedVersion),
          phaseDeadline,
        );
        if (current.outcome !== "ready")
          throw new AssistantBoundaryError("configuration_unavailable");
        const value = configurationSnapshot(
          current.configuration,
          timestamp(options.clock.now()),
        );
        if (expectedVersion !== undefined && value.version !== expectedVersion)
          throw new AssistantBoundaryError("configuration_changed");
        return value;
      };
      const customer = async (
        phaseDeadline = operationDeadline,
      ): Promise<AssistantCustomerAuthority> => {
        const current = await within(
          () => options.customerAuthority.resolve(claim!.requesterPrincipalId),
          phaseDeadline,
        );
        if (current.outcome !== "ready")
          throw new AssistantBoundaryError("authority_unavailable");
        return authoritySnapshot(
          current.authority,
          claim!.requesterPrincipalId,
        );
      };

      try {
        const acquired = await within(async () =>
          options.application.claimAssistantTurn(
            await options.serviceAccess(),
            claimCommand,
          ),
        );
        if (acquired === null) return { outcome: "not_claimed" };
        claim = snapshot(acquired);
        const operationId =
          "answer:" +
          (
            await fingerprint({
              ticketId: claim.fence.ticketId,
              turnId: claim.fence.turnId,
            })
          ).slice(0, 48);
        const currentPrepared = claim.preparedAttempts.find(
          (prepared) => prepared.attemptId === claim!.fence.attemptId,
        );
        // A durable preparation does not prove whether the earlier owner called.
        // Never blindly generate again for that same attempt after a restart.
        for (const prepared of claim.preparedAttempts) {
          if (prepared.accounting !== "unknown") continue;
          // The tagged first stage has no usage reservation or provider path.
          // Unknown acknowledgment still cannot make it eligible for resume.
          if (stagedRetrieval && isRetrievalPreparation(prepared)) continue;
          try {
            await within(() =>
              options.usage.reconcile(
                {
                  operationId,
                  attemptId: prepared.attemptId,
                  inputFingerprint: prepared.inputFingerprint,
                  usageReservationId: prepared.binding.usageReservationId,
                },
                { state: "unknown" },
              ),
            );
          } catch {
            /* The host retains a conservative pending reservation. */
          }
        }
        if (currentPrepared !== undefined) {
          accounting = "unknown";
          return await finish(
            "provider_failure",
            "retry",
            "recovered_preparation",
          );
        }

        const config = await configuration();
        if (
          claim.fence.attempt > config.budgets.maxAttempts ||
          (stagedRetrieval && config.budgets.maxAttempts < 2)
        )
          throw new AssistantBoundaryError("budget_exceeded");
        const retrievalPreparation = stagedRetrieval
          ? stagedPreparation(claim)
          : undefined;
        const preparingRetrieval =
          stagedRetrieval && retrievalPreparation === undefined;
        const authority = await customer();
        const sources = sourceSnapshot(
          await within(() =>
            retrievalPreparation === undefined
              ? options.knowledge.retrieveAnswerSources(authority.access, {
                  collectionIds: authority.collectionIds,
                  query: retrievalQuery(claim!),
                  applicability: authority.applicability,
                })
              : options.knowledge.confirmAnswerSources(authority.access, {
                  references: stagedReferences(retrievalPreparation),
                  applicability: authority.applicability,
                }),
          ),
          authority,
          options.tokenCounter,
        );
        const attemptBudgets: AssistantAttemptBudgets = snapshot({
          ...config.budgets,
          maxMessageCharacters,
          maxAnswerTextCharacters: answerTextAllowance(
            sources,
            maxMessageCharacters,
          ),
        });
        const input: AssistantModelInput = modelInput(
          claim,
          config,
          sources,
          options.tokenCounter,
          attemptBudgets,
        );
        const logicalFingerprint = stagedRetrieval
          ? await stagedInputFingerprint({
              claim,
              modelInput: input,
              configuration: config,
              authority,
              sources,
              budgets: attemptBudgets,
            })
          : undefined;
        if (retrievalPreparation !== undefined)
          await verifyStagedPreparation(
            retrievalPreparation,
            claim,
            logicalFingerprint!,
            config,
            authority,
          );
        const deadlineMilliseconds = Math.min(
          operationDeadline,
          timestamp(claim.leaseUntil),
          timestamp(claim.turnDeadline),
          timestamp(config.dataControls.validUntil),
          timestamp(options.clock.now()) +
            config.budgets.maxDurationMilliseconds,
        );
        if (remaining(deadlineMilliseconds) <= commitReserve)
          throw new AssistantBoundaryError("deadline");
        const deadline = new Date(deadlineMilliseconds).toISOString();
        const references = sources.sources.map((source) => source.reference);
        const usageReservationId =
          (preparingRetrieval ? "retrieval:" : "usage:") +
          (
            await fingerprint({
              ticketId: claim.fence.ticketId,
              turnId: claim.fence.turnId,
              attemptId: claim.fence.attemptId,
            })
          ).slice(0, 48);
        const inputFingerprint = preparingRetrieval
          ? logicalFingerprint!
          : await fingerprint({
              purpose: "support_answer",
              operationId,
              fence: claim.fence,
              input,
              configuration: config,
              authority,
              references,
              deadline,
              usageReservationId,
              budgets: attemptBudgets,
              ...(retrievalPreparation === undefined
                ? {}
                : {
                    retrievalPreparation: {
                      attemptId: retrievalPreparation.attemptId,
                      inputFingerprint: retrievalPreparation.inputFingerprint,
                    },
                  }),
            });
        const binding: AssistantAttemptBinding = snapshot({
          inputFingerprint,
          versions: {
            configuration: config.version,
            prompt: config.promptVersion,
            model: config.modelVersion,
            audience: authority.audienceVersion,
            policy: authority.policyVersion,
            accessPolicy: authority.access.policyVersion,
            ...(stagedRetrieval
              ? {
                  supportAnswerStage: preparingRetrieval
                    ? retrievalStageVersion
                    : generationStageVersion,
                }
              : {}),
          },
          references: references.map((reference) => ({
            namespace: "pegma.knowledge-base",
            resourceId: reference.articleId,
            revision: String(reference.articleRevision),
            binding: canonical(reference),
          })),
          contextBinding: await fingerprint(authority),
          deadline,
          usageReservationId,
        });
        const context: AssistantAttemptContext = Object.freeze({
          purpose: "support_answer",
          operationId,
          attemptId: claim.fence.attemptId,
          attempt: claim.fence.attempt,
          fence: claim.fence,
          inputFingerprint,
          configurationVersion: config.version,
          promptVersion: config.promptVersion,
          modelVersion: config.modelVersion,
          audienceVersion: authority.audienceVersion,
          policyVersion: authority.policyVersion,
          usageScopeRef: authority.usageScopeRef,
          usageReservationId,
          applicability: authority.applicability,
          allSourceReferences: Object.freeze(references),
          deadline,
          signal: providerController.signal,
          budgets: attemptBudgets,
          ...(stagedRetrieval
            ? {
                stagedRetrieval: Object.freeze({
                  stage: preparingRetrieval
                    ? ("preparation" as const)
                    : ("generation" as const),
                  preparationAttemptId:
                    retrievalPreparation?.attemptId ?? claim.fence.attemptId,
                }),
              }
            : {}),
        });
        const policyReason = options.escalationPolicy?.evaluate(input, context);
        if (policyReason !== undefined && policyReason !== null) {
          if (!escalationReasons.includes(policyReason))
            throw new AssistantBoundaryError("invalid_policy");
          return await finish(policyReason);
        }

        let prepared = false;
        const prepareCommand = snapshot({ ...claim.fence, binding });
        const verifyCurrentInputs = async (
          phaseDeadline: number,
        ): Promise<void> => {
          ensure(phaseDeadline);
          const currentAuthority = await customer(phaseDeadline);
          if (canonical(currentAuthority) !== canonical(authority))
            throw new AssistantBoundaryError("authority_changed");
          const confirmed = sourceSnapshot(
            await within(
              () =>
                options.knowledge.confirmAnswerSources(
                  currentAuthority.access,
                  {
                    references,
                    applicability: currentAuthority.applicability,
                  },
                ),
              phaseDeadline,
            ),
            currentAuthority,
            options.tokenCounter,
          );
          // Confirm every supplied source, including sources the model did not cite.
          if (canonical(confirmed) !== canonical(sources))
            throw new AssistantBoundaryError("source_changed");
          // Configuration is the last awaited observation before generation:
          // neither usage reservation nor source confirmation can conceal a
          // disabled or changed customer-content processing route.
          const currentConfig = await configuration(
            config.version,
            phaseDeadline,
          );
          if (canonical(currentConfig) !== canonical(config))
            throw new AssistantBoundaryError("configuration_changed");
          ensure(phaseDeadline);
        };
        for (let attempt = 0; attempt < commandAttempts; attempt += 1) {
          try {
            const ack = await within(
              async () =>
                options.application.prepareAssistantTurnAttempt(
                  await options.serviceAccess(),
                  prepareCommand,
                ),
              deadlineMilliseconds,
            );
            if (
              ack.attemptId !== claim.fence.attemptId ||
              ack.inputFingerprint !== inputFingerprint ||
              canonical(ack.binding) !== canonical(binding)
            )
              throw new AssistantBoundaryError("preparation_mismatch");
            prepared = true;
            break;
          } catch {
            /* Unknown acknowledgment: repeat exactly, never call yet. */
          }
        }
        if (!prepared) return { outcome: "pending", stage: "prepare" };
        if (preparingRetrieval) {
          // A successful preparation ACK alone retains accounting:"unknown".
          // Only this exact no-call finish releases the claim for another
          // physical invocation; terminal or ambiguous finishes stay distinct.
          const released = await finish("other", "retry");
          ensure();
          if (
            released.outcome === "finished" &&
            released.result.outcome === "retry_scheduled"
          )
            return {
              outcome: "prepared",
              ticketId: claim.fence.ticketId,
              turnId: claim.fence.turnId,
              preparationAttemptId: claim.fence.attemptId,
              nextAttemptAt: released.result.nextAttemptAt,
            };
          return released;
        }
        usageIdentity = {
          operationId,
          attemptId: context.attemptId,
          inputFingerprint,
          usageReservationId,
        };
        const reservation = await within(
          () => options.usage.reserve(context),
          deadlineMilliseconds - commitReserve,
        );
        if (
          reservation.outcome !== "reserved" ||
          reservation.usageReservationId !== usageReservationId
        )
          throw new AssistantBoundaryError("usage_unavailable");
        // Recheck live application fencing after the awaited reservation, then
        // re-read every trusted input before any customer content leaves the host.
        const rechecked = await within(
          async () =>
            options.application.prepareAssistantTurnAttempt(
              await options.serviceAccess(),
              prepareCommand,
            ),
          deadlineMilliseconds - commitReserve,
        );
        if (
          rechecked.attemptId !== claim.fence.attemptId ||
          rechecked.inputFingerprint !== inputFingerprint ||
          canonical(rechecked.binding) !== canonical(binding)
        )
          throw new AssistantBoundaryError("preparation_mismatch");
        await verifyCurrentInputs(deadlineMilliseconds - commitReserve);
        ensure(deadlineMilliseconds - commitReserve);
        observation = { state: "unknown" };
        accounting = "unknown";
        let result: AssistantModelResult;
        try {
          result = await within(
            () => options.model.generate(input, context, config),
            deadlineMilliseconds - commitReserve,
          );
        } catch (error) {
          providerController.abort();
          // The provider may have accepted a request even when its response is lost.
          // Reconciliation below therefore remains unknown and conservative.
          throw error;
        }
        const usage: AssistantModelUsage = modelUsage(result, config);
        observation = { state: "known", usage };
        processing = processingMetadata(result, usage);
        const decision = modelDecision(
          result,
          config,
          sources,
          options.tokenCounter,
          attemptBudgets,
        );
        await reconcile();
        const completion: CompleteAssistantTurnCommand = snapshot({
          ...claim.fence,
          inputFingerprint,
          outcome:
            decision.kind === "answer"
              ? {
                  kind: "answer",
                  messageId:
                    "assistant:" +
                    (
                      await fingerprint({
                        ticketId: claim.fence.ticketId,
                        turnId: claim.fence.turnId,
                      })
                    ).slice(0, 48),
                  body: answerBody(decision, sources, maxMessageCharacters),
                }
              : {
                  kind: "escalate",
                  reason: decision.reason,
                  summary: decision.text,
                  attemptedGuideIds: references.map(
                    (reference) => reference.articleId,
                  ),
                },
          processing,
        });
        const guard = async (): Promise<void> => {
          try {
            await verifyCurrentInputs(deadlineMilliseconds);
          } catch (error) {
            throw new GuardFailure(
              error instanceof AssistantBoundaryError
                ? error.category
                : "verification_unavailable",
            );
          }
        };
        let uncertainCompletion = false;
        for (let attempt = 0; attempt < commandAttempts; attempt += 1) {
          try {
            const accepted = await within(
              async () =>
                options.application.completeAssistantTurn(
                  await options.serviceAccess(),
                  completion,
                  guard,
                ),
              deadlineMilliseconds,
            );
            return { outcome: "completed", result: accepted };
          } catch (error) {
            if (error instanceof GuardFailure) {
              if (uncertainCompletion)
                return { outcome: "pending", stage: "complete" };
              return await finish(
                "provider_failure",
                "escalate",
                error.category,
              );
            }
            uncertainCompletion = true;
            // A commit may have succeeded. Retry exactly this body/command/fingerprint.
            // Never finish or generate again while acceptance remains indeterminate.
          }
        }
        return { outcome: "pending", stage: "complete" };
      } catch (error) {
        await reconcile();
        const category =
          error instanceof AssistantBoundaryError
            ? error.category
            : "provider_unavailable";
        const reason: AssistantEscalationReason =
          category === "no_guidance"
            ? "no_guidance"
            : [
                  "budget_exceeded",
                  "turn_limit",
                  "usage_unavailable",
                  "deadline",
                  "answer_limit",
                ].includes(category)
              ? "capacity"
              : "provider_failure";
        return await finish(reason, "escalate", category);
      } finally {
        controller.abort();
        providerController.abort();
        external?.removeEventListener("abort", cancel);
      }
    },
  });
}
