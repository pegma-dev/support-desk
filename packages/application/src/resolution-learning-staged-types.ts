import type { AccessContext } from "@pegma/authorization-core";
import type { IsoTimestamp, PrincipalId } from "@pegma/spine";
import type {
  ResolutionLearningReviewReceipt,
  ResolutionLearningTarget,
  ReviewResolutionLearningProposalCommand,
} from "./resolution-learning-types.js";

/** Immutable checked intent. These observations never replace fresh authority. */
export interface ResolutionLearningStagedReviewIntent {
  readonly reviewerId: PrincipalId;
  readonly ticketId: string;
  readonly sourceGeneration: number;
  readonly expectedWorkGeneration: number;
  readonly target: ResolutionLearningTarget;
  readonly policy: {
    readonly version: string;
    readonly binding: string;
    readonly verifiedAt: IsoTimestamp;
    readonly validUntil: IsoTimestamp;
  };
}
export interface ResolutionLearningStagedReviewKey {
  readonly ticketId: string;
  readonly commandId: string;
}
export interface ResolutionLearningStagedReviewFence extends ResolutionLearningStagedReviewKey {
  readonly workerId: string;
  readonly claimId: string;
  readonly claimGeneration: number;
}
export interface ResolutionLearningStagedReviewProof {
  /** Digest of the complete P1 observation, never an authorization capability. */
  readonly binding: string;
  readonly validUntil: IsoTimestamp;
}
export interface ResolutionLearningStagedReviewHint extends ResolutionLearningStagedReviewKey {
  readonly reviewerId: PrincipalId;
  readonly phase: "proof" | "commit";
  readonly expiresAt: IsoTimestamp;
  readonly leaseUntil?: IsoTimestamp;
  readonly held: boolean;
}
export interface ResolutionLearningStagedReviewClaim {
  readonly fence: ResolutionLearningStagedReviewFence;
  readonly reviewerId: PrincipalId;
  readonly command: ReviewResolutionLearningProposalCommand;
  readonly intent: ResolutionLearningStagedReviewIntent;
  readonly phase: "proof" | "commit";
  readonly leaseUntil: IsoTimestamp;
  readonly expiresAt: IsoTimestamp;
  readonly proof?: ResolutionLearningStagedReviewProof;
}
export type ResolutionLearningStagedReviewStatus =
  | ResolutionLearningReviewReceipt
  | {
      readonly outcome: "pending";
      readonly ticketId: string;
      readonly commandId: string;
      readonly phase: "proof" | "commit";
      readonly claimed: boolean;
      readonly held: boolean;
      readonly expiresAt: IsoTimestamp;
    };
/** Fresh host proof, with an optional synchronous assertion after the last await. */
export type ResolutionLearningStagedReviewGuard = () =>
  void | (() => true) | Promise<void | (() => true)>;

/** Additive opt-in capability. Existing inline application implementations need no changes. */
export interface ResolutionLearningStagedReviewApplication {
  admit(
    access: AccessContext,
    command: ReviewResolutionLearningProposalCommand,
    intent: ResolutionLearningStagedReviewIntent,
    verifyBeforeCommit: ResolutionLearningStagedReviewGuard,
  ): Promise<ResolutionLearningStagedReviewStatus>;
  readStatus(
    access: AccessContext,
    command: ReviewResolutionLearningProposalCommand,
  ): Promise<ResolutionLearningStagedReviewStatus | null>;
  /** Opaque dispatch metadata only, authorized by learningProcess. */
  readPending(
    access: AccessContext,
    key: ResolutionLearningStagedReviewKey,
  ): Promise<ResolutionLearningStagedReviewHint | null>;
  scanPending(
    access: AccessContext,
    bounds: { readonly cursor?: string; readonly limit: number },
  ): Promise<{
    readonly candidates: readonly ResolutionLearningStagedReviewHint[];
    readonly nextCursor: string | null;
    readonly physicalRows: number;
    readonly pages: 1;
  }>;
  /** Caller supplies freshly resolved original human authority, never the scanning service's access. */
  claim(
    access: AccessContext,
    command: ResolutionLearningStagedReviewKey & {
      readonly workerId: string;
      readonly claimId: string;
      readonly leaseMilliseconds: number;
    },
  ): Promise<ResolutionLearningStagedReviewClaim | null>;
  prepare(
    access: AccessContext,
    command: {
      readonly fence: ResolutionLearningStagedReviewFence;
      readonly proof: ResolutionLearningStagedReviewProof;
    },
    verifyBeforeCommit: ResolutionLearningStagedReviewGuard,
  ): Promise<ResolutionLearningStagedReviewStatus>;
  complete(
    access: AccessContext,
    fence: ResolutionLearningStagedReviewFence,
    verifyBeforeCommit: ResolutionLearningStagedReviewGuard,
  ): Promise<ResolutionLearningReviewReceipt>;
  cancel(
    access: AccessContext,
    command: ReviewResolutionLearningProposalCommand,
    verifyBeforeCommit: ResolutionLearningStagedReviewGuard,
  ): Promise<ResolutionLearningReviewReceipt>;
}
