import type { AccessContext } from "@pegma/authorization-core";
import type {
  ClaimEngineeringWorkCommand,
  EngineeringClaim,
  ReviewEngineeringProposalCommand,
} from "@pegma/support-desk-application";
import type {
  EngineeringProcessResult,
  EngineeringReviewOptions,
  EngineeringServiceAuthority,
  SupportDeskEngineering,
  SupportDeskEngineeringOptions,
} from "./engineering-ports.js";
import {
  AssistantBoundaryError,
  canonical,
  count,
  snapshot,
  timestamp,
} from "./boundary.js";
import { learningAuthoritySnapshot } from "./learning-request.js";
import { createLearningRuntime } from "./learning-runtime.js";
import {
  engineeringAuthority,
  engineeringFailureCategory,
  engineeringProcessingAuthority,
} from "./engineering-request.js";
import { processEngineeringModel } from "./engineering-model.js";
import {
  dispatchEngineeringExport,
  engineeringProposalGuard,
  prepareEngineeringExport,
  reconcileEngineeringSource,
} from "./engineering-export.js";

class EngineeringReviewGuardFailure extends AssistantBoundaryError {}
class EngineeringReviewAcknowledgementError extends AssistantBoundaryError {
  constructor(readonly failureCategory: string) {
    super("review_acknowledgement_unknown");
  }
}

/** Optional composition only: public application services own all durable state. */
export function createSupportDeskEngineering(
  options: SupportDeskEngineeringOptions,
): SupportDeskEngineering {
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
        SupportDeskEngineeringOptions["application"]["scanEngineeringCandidates"]
      >[1],
    ) {
      const runtime = createLearningRuntime(options);
      try {
        const current = await engineeringAuthority(
          options.serviceAccess,
          runtime,
        );
        return snapshot(
          await runtime.within(() =>
            options.application.scanEngineeringCandidates(
              current.access,
              bounds,
            ),
          ),
        );
      } finally {
        runtime.close();
      }
    },

    async processWork(
      command: Omit<ClaimEngineeringWorkCommand, "claimId">,
      run: { readonly signal?: AbortSignal } = {},
    ): Promise<EngineeringProcessResult> {
      const runtime = createLearningRuntime(options, run);
      const physicalClaim = snapshot({
        ...command,
        claimId: crypto.randomUUID(),
      });
      let claim: EngineeringClaim | undefined;
      try {
        const current = await engineeringAuthority(
          options.serviceAccess,
          runtime,
        );
        const acquired = await runtime.within(() =>
          options.application.claimEngineeringWork(
            current.access,
            physicalClaim,
          ),
        );
        if (acquired === null) return { outcome: "not_claimed" };
        claim = snapshot(acquired);
        const deadline = Math.min(
          runtime.deadline,
          timestamp(claim.leaseUntil),
          timestamp(claim.work.deadline),
        );
        runtime.ensure(deadline);
        if (claim.reconciliationOnly || claim.work.dispatch !== undefined) {
          const result = await runtime.within(
            () =>
              reconcileEngineeringSource(options, command.ticketId, runtime),
            deadline,
          );
          return result.outcome === "reconciled"
            ? { outcome: "reconciled", processed: result.processed }
            : { outcome: "pending", stage: "reconciliation" };
        }
        if (
          claim.work.approval?.decision === "approve" &&
          claim.work.proposal !== undefined
        )
          return await runtime.within(
            () => dispatchEngineeringExport(options, claim!, runtime),
            deadline,
          );
        if (
          claim.work.candidate !== undefined ||
          claim.work.proposal !== undefined ||
          claim.work.stage !== "model"
        )
          return await runtime.within(
            () => prepareEngineeringExport(options, claim!, runtime),
            deadline,
          );
        return await runtime.within(
          () => processEngineeringModel(options, claim!, runtime),
          deadline,
        );
      } catch (error) {
        return {
          outcome: "pending",
          reason: engineeringFailureCategory(error, "engineering_unavailable"),
          stage:
            claim?.reconciliationOnly || claim?.work.dispatch !== undefined
              ? "reconciliation"
              : claim?.work.proposal !== undefined
                ? "dispatch"
                : "finish",
        };
      } finally {
        runtime.close();
      }
    },

    async reviewProposal(
      access: AccessContext,
      input: ReviewEngineeringProposalCommand,
      run: EngineeringReviewOptions = {},
    ) {
      const runtime = createLearningRuntime(options, run);
      try {
        const staff = learningAuthoritySnapshot({
          access,
          authorityVersion: "engineering-staff-review",
          usageScopeRef: "engineering-staff-review",
        }).access;
        const ensureStaffCurrent = (): void => {
          const current = learningAuthoritySnapshot({
            access,
            authorityVersion: "engineering-staff-review",
            usageScopeRef: "engineering-staff-review",
          }).access;
          if (canonical(current) !== canonical(staff))
            throw new EngineeringReviewGuardFailure("authority_changed");
        };
        const command = snapshot(input);
        ensureStaffCurrent();
        let processingAuthority: EngineeringServiceAuthority | undefined;
        const ensureCurrent = (): void => {
          runtime.ensure();
          ensureStaffCurrent();
        };
        const guard = async (): Promise<void> => {
          try {
            ensureCurrent();
            // Only approval needs current external export proof. Rejection
            // still checks the invocation and original staff authority.
            if (command.decision === "approve") {
              const work = snapshot(
                await runtime.within(() =>
                  options.application.readEngineeringWork(access, {
                    ticketId: command.ticketId,
                    sourceGeneration: command.sourceGeneration,
                  }),
                ),
              );
              ensureCurrent();
              const proposal = work.proposal;
              if (
                proposal === undefined ||
                proposal.proposalHash !== command.proposalHash ||
                work.workGeneration !== command.expectedWorkGeneration
              )
                throw new AssistantBoundaryError("proposal_changed");
              processingAuthority ??= await engineeringProcessingAuthority(
                options.serviceAccess,
                runtime,
              );
              ensureCurrent();
              await engineeringProposalGuard(
                options,
                work,
                proposal,
                runtime,
                runtime.deadline,
                processingAuthority,
              );
              ensureCurrent();
            }
            const verifyBeforeCommit = run.verifyBeforeCommit;
            if (verifyBeforeCommit !== undefined) {
              await runtime.within(async () => {
                ensureStaffCurrent();
                try {
                  await verifyBeforeCommit();
                } catch {
                  throw new AssistantBoundaryError("verification_unavailable");
                }
              });
              ensureCurrent();
            }
          } catch (error) {
            throw new EngineeringReviewGuardFailure(
              error instanceof AssistantBoundaryError
                ? error.category
                : "verification_unavailable",
            );
          }
        };
        let uncertain = false;
        let failureCategory = "review_unavailable";
        for (let attempt = 0; attempt < attempts; attempt += 1) {
          try {
            ensureStaffCurrent();
            const accepted = await runtime.within(() =>
              options.application.reviewEngineeringProposal(
                access,
                command,
                guard,
              ),
            );
            ensureStaffCurrent();
            return accepted;
          } catch (error) {
            if (error instanceof EngineeringReviewGuardFailure && !uncertain)
              throw error;
            failureCategory = engineeringFailureCategory(
              error,
              "review_unavailable",
            );
            uncertain = true;
          }
        }
        throw new EngineeringReviewAcknowledgementError(failureCategory);
      } finally {
        runtime.close();
      }
    },

    async reconcileSource(
      ticketId: string,
      run: { readonly signal?: AbortSignal } = {},
    ) {
      const runtime = createLearningRuntime(options, run);
      try {
        return await reconcileEngineeringSource(options, ticketId, runtime);
      } catch (error) {
        return {
          outcome: "pending" as const,
          processed: 0,
          reason: engineeringFailureCategory(
            error,
            "reconciliation_unavailable",
          ),
        };
      } finally {
        runtime.close();
      }
    },
  });
}
