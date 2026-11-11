import type { AccessContext } from "@pegma/authorization-core";
import type {
  ResolutionLearningReviewReceipt,
  ResolutionLearningStagedReviewApplication,
  ResolutionLearningStagedReviewGuard,
  ResolutionLearningStagedReviewKey,
  ResolutionLearningStagedReviewStatus,
} from "@pegma/support-desk-application";
import type {
  LearningReviewCommand,
  LearningRunOptions,
  SupportDeskLearningOptions,
} from "./learning-integration-types.js";

export interface SupportDeskStagedLearningReviewOptions extends Pick<
  SupportDeskLearningOptions,
  | "application"
  | "knowledge"
  | "sources"
  | "checks"
  | "serviceAccess"
  | "clock"
  | "maxOperationMilliseconds"
  | "readScheduling"
> {
  /** Current host-owned Identity/roles for this exact original human, never a service substitute. */
  readonly resolveActor: (request: {
    readonly principalId: string;
    readonly signal: AbortSignal;
  }) => Promise<AccessContext | null>;
}
export interface LearningStagedReviewAdmissionOptions extends LearningRunOptions {
  /** Mandatory fresh original-browser actor, review/queue and KB authority at admission. Logout after durable admission does not cancel the command. */
  readonly verifyBeforeCommit: ResolutionLearningStagedReviewGuard;
}
export interface LearningStagedReviewCancellationOptions extends LearningRunOptions {
  /** Current original human review/queue only; old KB authority is unnecessary for cancellation. */
  readonly verifyBeforeCommit: ResolutionLearningStagedReviewGuard;
}
export type ProcessLearningReviewCommand = Omit<
  Parameters<ResolutionLearningStagedReviewApplication["claim"]>[1],
  "claimId"
>;
export type LearningStagedReviewProcessResult =
  | { readonly outcome: "not_pending" }
  | { readonly outcome: "not_claimed" }
  | {
      readonly outcome: "prepared";
      readonly status: ResolutionLearningStagedReviewStatus;
    }
  | {
      readonly outcome: "completed";
      readonly receipt: ResolutionLearningReviewReceipt;
    }
  | {
      readonly outcome: "pending";
      readonly phase: "proof" | "commit";
      readonly reason: string;
    }
  | { readonly outcome: "held"; readonly reason: string };

/** An accepted command is durable intent, not an accepted review or KB publication. */
export interface SupportDeskStagedLearningReviews {
  admitReviewIntent(
    access: AccessContext,
    command: LearningReviewCommand,
    options: LearningStagedReviewAdmissionOptions,
  ): Promise<ResolutionLearningStagedReviewStatus>;
  readReviewStatus(
    access: AccessContext,
    command: LearningReviewCommand,
    options?: LearningRunOptions,
  ): Promise<ResolutionLearningStagedReviewStatus | null>;
  cancelReview(
    access: AccessContext,
    command: LearningReviewCommand,
    options: LearningStagedReviewCancellationOptions,
  ): Promise<ResolutionLearningReviewReceipt>;
  scanPending(
    bounds: Parameters<
      ResolutionLearningStagedReviewApplication["scanPending"]
    >[1],
    options?: LearningRunOptions,
  ): ReturnType<ResolutionLearningStagedReviewApplication["scanPending"]>;
  /** One proof OR commit phase. Return from this physical invocation after prepared/pending; do not loop. */
  processReview(
    command: ProcessLearningReviewCommand,
    options?: LearningRunOptions,
  ): Promise<LearningStagedReviewProcessResult>;
}

export type LearningStagedReviewQueueKey = ResolutionLearningStagedReviewKey;
