import type { ResolutionLearningStagedReviewApplication } from "./resolution-learning-staged-types.js";
import type { AccessContext } from "@pegma/authorization-core";
import type { IsoTimestamp, PrincipalId } from "@pegma/spine";
import type { TicketId } from "@pegma/support-desk-contracts";
import type {
  ResolutionLearningSourceRecord,
  ResolutionLearningWorkRecord,
} from "./resolution-learning-records.js";

export interface ResolutionLearningKey {
  readonly ticketId: TicketId;
  readonly sourceGeneration: number;
}
export interface ResolutionSourceFence extends ResolutionLearningKey {
  readonly resolutionCycle: number;
  readonly sourceBindingHash: string;
}
export interface ResolutionLearningClaimFence extends ResolutionLearningKey {
  readonly workerId: string;
  readonly claimId: string;
  readonly claimGeneration: number;
}
export interface ResolutionProductContext {
  readonly productId: string;
  readonly version: string;
  readonly buildId: string;
  /** Stable trusted applicability identity; receipt refreshes do not change it. */
  readonly binding: string;
  readonly contextVersion: string;
  readonly receiptId: string;
  readonly verifiedAt: IsoTimestamp;
  readonly validUntil: IsoTimestamp;
}
export interface ResolutionTrustContext {
  readonly ticketId: TicketId;
  readonly ticketRevision: number;
  readonly resolutionCycle: number;
  readonly resolvedAt: IsoTimestamp;
  readonly actorId: PrincipalId;
  readonly acceptedAt: IsoTimestamp;
}
export interface ResolutionProductContextPort {
  resolve(
    context: ResolutionTrustContext,
    signal: AbortSignal,
  ): Promise<ResolutionProductContext | null>;
}
export interface ResolutionVerifiedTest {
  readonly executionId: string;
  readonly runnerId: string;
  readonly testId: string;
  readonly productBinding: string;
  readonly executedAt: IsoTimestamp;
  readonly receiptId: string;
  readonly verifiedAt: IsoTimestamp;
  readonly validUntil: IsoTimestamp;
}
export interface ResolutionTestReceiptPort {
  verify(
    receipt: string,
    context: ResolutionTrustContext & {
      readonly product: ResolutionProductContext;
    },
    signal: AbortSignal,
  ): Promise<ResolutionVerifiedTest | null>;
}
export type ResolutionEvidence =
  | {
      readonly kind: "customer_confirmation";
      readonly actorId: PrincipalId;
      readonly lastVisibleMessageId: string;
    }
  | {
      readonly kind: "staff_verified_fix";
      readonly actorId: PrincipalId;
      readonly solutionMessageId: string;
      /** Stable explicit proof identity; refreshable product receipts are separate. */
      readonly verificationReference: string;
    }
  | {
      readonly kind: "successful_test";
      readonly actorId: PrincipalId;
      readonly solutionMessageId: string;
      readonly test: ResolutionVerifiedTest;
    };

export interface ResolutionLearningSourceReference {
  readonly id: string;
  readonly system: string;
  readonly resourceId: string;
  readonly version: string;
}
export interface ResolutionLearningCandidate {
  readonly problem: string;
  readonly applicability: {
    readonly productId: string;
    readonly version: string;
    readonly buildId: string;
  };
  readonly steps: readonly string[];
  readonly solution: string;
  readonly validationRequirements: readonly string[];
}
/** Canonical JSON draft payload is provider-neutral and interpreted by the KB adapter. */
export interface ResolutionLearningDeliveryRequest {
  readonly operation: "create" | "update";
  readonly articleId: string;
  readonly collectionId: string;
  readonly draftPayload: string;
  readonly sourceReferences: readonly ResolutionLearningSourceReference[];
  readonly originalExpectedGeneration: number;
  readonly commandId: string;
  readonly correlationId: string;
}
export interface ResolutionLearningChecksBinding {
  readonly candidateHash: string;
  readonly sourceBindingHash: string;
  readonly policyVersion: string;
  readonly applicabilityHash: string;
  readonly targetDecisionHash: string;
  readonly requestHash: string;
}
export interface VerifiedResolutionLearningChecks {
  readonly binding: ResolutionLearningChecksBinding;
  readonly privacy: "passed";
  readonly factual: "passed";
  readonly applicability: "passed";
  readonly duplication: "passed";
  readonly verifierReceiptId: string;
  readonly verifierVersion: string;
  readonly verifiedAt: IsoTimestamp;
  readonly validUntil: IsoTimestamp;
}
export interface ResolutionLearningChecksPort {
  /** Trusted read-only verification, independently of the drafting model. */
  verify(
    receipt: string,
    binding: ResolutionLearningChecksBinding,
    signal?: AbortSignal,
    context?: ResolutionLearningChecksVerificationContext,
  ): Promise<VerifiedResolutionLearningChecks | null>;
}
/** Fresh keyed-read hints only; the verifier authenticates the matching signed
 * scope before using them. Neither hints nor ACK claims confer authority. */
export interface ResolutionLearningChecksVerificationContext {
  readonly comparisonScope?: { readonly collectionId: string };
  /** Historical no-write completion must independently read this exact App ACK. */
  readonly acceptedAcknowledgement?: NonNullable<
    ResolutionLearningWorkRecord["acknowledgement"]
  >;
}
export interface ResolutionLearningOptions {
  /** Opt-in durable human-review commands. Inline review remains the default. */
  readonly stagedReviews?: boolean;
  /** Counts all retained pending and terminal attempts; preserves bounded privacy withdrawal. */
  readonly maxStagedReviewAttempts?: number;
  readonly enabled?: boolean;
  readonly productContext?: ResolutionProductContextPort;
  readonly testReceipts?: ResolutionTestReceiptPort;
  readonly checks?: ResolutionLearningChecksPort;
  readonly trustTimeoutMilliseconds?: number;
  readonly maxGenerations?: number;
  readonly maxTargets?: number;
  readonly maxReviewBindings?: number;
  readonly maxModelAttempts?: number;
  readonly maxLeaseMilliseconds?: number;
  readonly maxWorkMilliseconds?: number;
}
export interface ResolutionLearningCommand {
  readonly ticketId: TicketId;
  readonly commandId: string;
  readonly correlationId: string;
}
export interface EnrollResolutionLearningCommand extends ResolutionLearningCommand {
  readonly expectedRevision: number;
}
export interface SubmitResolutionEvidenceCommand extends ResolutionLearningCommand {
  readonly expectedRevision: number;
  readonly resolutionCycle: number;
  readonly evidence:
    | {
        readonly kind: "staff_verified_fix";
        readonly solutionMessageId: string;
        /** Stable explicit proof ID; a different verification is new evidence. */
        readonly verificationReference: string;
      }
    | {
        readonly kind: "successful_test";
        readonly solutionMessageId: string;
        readonly receipt: string;
      };
}
export type ResolutionLearningInvalidationReason =
  "evidence_revoked" | "product_binding_revoked" | "check_policy_revoked";
export interface InvalidateResolutionEvidenceCommand extends ResolutionLearningCommand {
  readonly reason: ResolutionLearningInvalidationReason;
}
export interface WithdrawResolutionLearningSourceCommand extends ResolutionLearningCommand {
  readonly reason:
    "privacy_withdrawal" | "source_access_revoked" | "source_deleted";
}
export interface ResolutionLearningSourceResult {
  readonly ticketId: TicketId;
  readonly sourceGeneration: number;
  readonly resolutionCycle: number;
  readonly state: ResolutionLearningSourceRecord["state"];
  readonly heldReason?: string;
}
export interface ClaimResolutionLearningWorkCommand extends ResolutionLearningKey {
  readonly workerId: string;
  readonly claimId: string;
  readonly leaseMilliseconds: number;
}
export interface ResolutionLearningClaim {
  readonly fence: ResolutionLearningClaimFence;
  readonly sourceFence: ResolutionSourceFence;
  readonly workGeneration: number;
  readonly leaseUntil: IsoTimestamp;
  readonly work: ResolutionLearningWorkRecord;
  /** Only customer-visible immutable rows; never includes private notes. */
  readonly messages: readonly {
    readonly messageId: string;
    readonly ordinal: number;
    readonly speaker: "customer" | "support" | "assistant" | "notification";
    readonly body: string;
  }[];
  readonly workingSolutionMessageIds: readonly string[];
  readonly recoveredModelPreparation: boolean;
}
export interface ResolutionLearningModelBinding {
  readonly inputManifest: {
    readonly messages: readonly {
      readonly messageId: string;
      readonly ordinal: number;
    }[];
    readonly workingSolutionMessageIds: readonly string[];
    readonly product: {
      readonly productId: string;
      readonly version: string;
      readonly buildId: string;
      readonly binding: string;
      readonly contextVersion: string;
    };
  };
  readonly inputFingerprint: string;
  readonly inputManifestHash: string;
  readonly configVersion: string;
  readonly promptVersion: string;
  readonly modelVersion: string;
  readonly checkPolicyVersion: string;
  readonly budgetsHash: string;
  readonly usageReservationId: string;
  readonly deadline: IsoTimestamp;
}
export type PrepareResolutionLearningStepCommand =
  ResolutionLearningClaimFence &
    (
      | {
          readonly step: "model";
          readonly binding: ResolutionLearningModelBinding;
        }
      | {
          readonly step: "kb_delivery";
          readonly candidateHash: string;
          readonly verifiedCheckReceipt: string;
          readonly policyVersion: string;
          readonly targetDecisionHash: string;
          readonly exactRequest: ResolutionLearningDeliveryRequest;
        }
    );
export type ResolutionLearningPreparedStep = {
  readonly stepId: string;
  readonly requestHash: string;
} & (
  | { readonly step: "model"; readonly maxCandidateBytes: 16_000 }
  | { readonly step: "kb_delivery" }
);
export interface ResolutionLearningStepResult extends ResolutionLearningKey {
  readonly workGeneration: number;
  readonly status: ResolutionLearningWorkRecord["status"];
  readonly stepId?: string;
  readonly requestHash?: string;
  readonly candidateHash?: string;
  readonly target?: ResolutionLearningTarget;
}
/** Exact prepared delivery coordinates, never permission or a stored proof. */
export interface ResolutionLearningDeliveryFence extends ResolutionLearningClaimFence {
  readonly stepId: string;
  readonly requestHash: string;
}
export type ResolutionLearningDeliveryAssertion = () => true;
/** Exists only inside one built-in App call, with current named reader grants. */
export interface ResolutionLearningDeliveryObservation {
  read(access: AccessContext): {
    readonly source: ResolutionLearningSourceRecord;
    readonly work: ResolutionLearningWorkRecord;
  };
  confirm(access: AccessContext): Promise<void>;
}
export type ResolutionLearningDeliveryGuard = (
  observation: ResolutionLearningDeliveryObservation,
) =>
  | void
  | ResolutionLearningDeliveryAssertion
  | Promise<void | ResolutionLearningDeliveryAssertion>;
/** SDK-owned atomic checkpoints; optional for existing structural applications. */
export interface ResolutionLearningStagedDeliveryApplication {
  prepare(
    access: AccessContext,
    command: Extract<
      PrepareResolutionLearningStepCommand,
      { readonly step: "kb_delivery" }
    >,
    guard: ResolutionLearningDeliveryGuard,
  ): Promise<
    Extract<ResolutionLearningPreparedStep, { readonly step: "kb_delivery" }>
  >;
  write(
    access: AccessContext,
    command: ResolutionLearningDeliveryFence,
    deliver: (observation: ResolutionLearningDeliveryObservation) => Promise<{
      readonly historicalAck: NonNullable<
        ResolutionLearningWorkRecord["acknowledgement"]
      >;
      readonly assertCurrent: ResolutionLearningDeliveryAssertion;
    }>,
  ): Promise<ResolutionLearningStepResult>;
  complete(
    access: AccessContext,
    command: ResolutionLearningDeliveryFence,
    plan: (observation: ResolutionLearningDeliveryObservation) => Promise<{
      readonly target: ResolutionLearningTarget;
      readonly assertCurrent: ResolutionLearningDeliveryAssertion;
    }>,
  ): Promise<ResolutionLearningStepResult>;
}
export interface ResolutionLearningProcessing {
  readonly provider?: string;
  readonly model?: string;
  readonly requestId?: string;
  readonly failureCategory?: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly costMicros?: number;
  readonly currency?: string;
}
export interface ResolutionLearningTarget {
  readonly articleId: string;
  readonly collectionId: string;
  readonly articleRevision: number;
  readonly contentHash: string;
  readonly sourceSnapshotGeneration: number;
  readonly sourceSnapshotHash: string;
  readonly orderedReferencesHash: string;
}
export type CompleteResolutionLearningStepCommand =
  ResolutionLearningClaimFence & {
    readonly stepId: string;
    readonly requestHash: string;
  } & (
      | {
          readonly step: "model";
          readonly candidate: ResolutionLearningCandidate;
          readonly processing?: ResolutionLearningProcessing;
          readonly accounting: "accounted" | "unknown";
        }
      | {
          readonly step: "kb_delivery";
          readonly historicalAck: {
            readonly id: string;
            readonly generation: number;
            readonly articleRevision: number;
            readonly contentHash: string;
            readonly state: string;
          };
          readonly currentTargetBinding: ResolutionLearningTarget;
        }
    );
export interface FinishResolutionLearningWorkCommand extends ResolutionLearningClaimFence {
  readonly stepId?: string;
  readonly requestHash?: string;
  readonly disposition: "retry" | "held" | "unknown" | "superseded";
  readonly accounting?: "not_called" | "accounted" | "unknown";
  readonly retryAt?: IsoTimestamp;
  readonly reason?: string;
  readonly processing?: ResolutionLearningProcessing;
}
export interface ReviewResolutionLearningProposalCommand
  extends ResolutionLearningCommand, ResolutionLearningKey {
  readonly expectedWorkGeneration: number;
  readonly target: ResolutionLearningTarget;
  readonly decision: "approve" | "reject";
  readonly policyVersion: string;
  /** Optional full SDK-prepared intent hash; omission retains legacy fingerprints. */
  readonly intentBinding?: string;
  readonly reason?: string;
}
/** Exact actor/command receipt; cancellation is not an approval or rollback. */
export type ResolutionLearningReviewReceipt =
  | {
      readonly outcome: "accepted";
      readonly result: ResolutionLearningSourceResult;
    }
  | {
      readonly outcome: "cancelled";
      readonly ticketId: TicketId;
      readonly commandId: string;
    };
/** Read-only current authority/configuration/KB target confirmation. */
export type ResolutionLearningCommitGuard = () => void | Promise<void>;
/** Optional live host authority fence for a new resolution-evidence mutation. */
export interface SubmitResolutionEvidenceOptions {
  /** Cancellation prevents a new write; exact accepted receipts remain recoverable. */
  readonly signal?: AbortSignal;
  /**
   * Read-only current browser/entitlement check after all SDK proof reads, once
   * per CAS attempt. A returned synchronous assertion runs at the transaction
   * handoff; it must not perform async work. Exact accepted replay skips this.
   */
  readonly verifyBeforeCommit?: () =>
    void | (() => true) | Promise<void | (() => true)>;
}
export interface ResolutionLearningReconciliationView {
  readonly ticketId: TicketId;
  readonly sourceGeneration: number;
  readonly sourceWorkGeneration: number;
  readonly state: ResolutionLearningSourceRecord["state"];
  readonly reconciliationPending: boolean;
  readonly destinations: readonly (ResolutionLearningSourceRecord["destinations"][number] & {
    readonly requestIdentity: Pick<
      ResolutionLearningDeliveryRequest,
      "operation" | "commandId" | "articleId" | "originalExpectedGeneration"
    > | null;
    readonly requestIdentityStatus: "available" | "unavailable";
  })[];
}
export interface RecordResolutionLearningReconciliationCommand {
  readonly ticketId: TicketId;
  readonly expectedSourceGeneration: number;
  readonly expectedSourceWorkGeneration: number;
  readonly articleId: string;
  readonly stepId: string;
  readonly requestHash: string;
  readonly disposition:
    "blocked" | "retired" | "unaffected_publication" | "write_rejected";
  readonly proof?: {
    readonly kind:
      "terminal_receipt" | "revision_fence" | "trusted_cancellation";
    readonly binding: string;
  };
}
export interface ResolutionLearningApplication {
  readonly stagedResolutionLearningDelivery?: ResolutionLearningStagedDeliveryApplication;
  readonly stagedResolutionLearningReviews?: ResolutionLearningStagedReviewApplication;
  enrollResolutionLearning(
    access: AccessContext,
    command: EnrollResolutionLearningCommand,
  ): Promise<ResolutionLearningSourceResult>;
  submitResolutionEvidence(
    access: AccessContext,
    command: SubmitResolutionEvidenceCommand,
    options?: SubmitResolutionEvidenceOptions,
  ): Promise<ResolutionLearningSourceResult>;
  readResolutionLearningSource(
    access: AccessContext,
    ticketId: TicketId,
  ): Promise<ResolutionLearningSourceRecord>;
  readResolutionLearningWork(
    access: AccessContext,
    key: ResolutionLearningKey,
  ): Promise<ResolutionLearningWorkRecord>;
  invalidateResolutionEvidence(
    access: AccessContext,
    command: InvalidateResolutionEvidenceCommand,
  ): Promise<ResolutionLearningSourceResult>;
  withdrawResolutionLearningSource(
    access: AccessContext,
    command: WithdrawResolutionLearningSourceCommand,
  ): Promise<ResolutionLearningSourceResult>;
  scanResolutionLearningCandidates(
    access: AccessContext,
    bounds: { readonly cursor?: string; readonly limit: number },
  ): Promise<{
    readonly candidates: readonly ResolutionLearningKey[];
    readonly reconciliationSources: readonly TicketId[];
    readonly nextCursor: string | null;
    readonly physicalRows: number;
    readonly pages: 1;
  }>;
  claimResolutionLearningWork(
    access: AccessContext,
    command: ClaimResolutionLearningWorkCommand,
  ): Promise<ResolutionLearningClaim | null>;
  prepareResolutionLearningStep(
    access: AccessContext,
    command: PrepareResolutionLearningStepCommand,
  ): Promise<ResolutionLearningPreparedStep>;
  completeResolutionLearningStep(
    access: AccessContext,
    command: CompleteResolutionLearningStepCommand,
    verifyBeforeCommit: ResolutionLearningCommitGuard,
  ): Promise<ResolutionLearningStepResult>;
  finishResolutionLearningWork(
    access: AccessContext,
    command: FinishResolutionLearningWorkCommand,
  ): Promise<ResolutionLearningStepResult>;
  reviewResolutionLearningProposal(
    access: AccessContext,
    command: ReviewResolutionLearningProposalCommand,
    verifyBeforeCommit: ResolutionLearningCommitGuard,
  ): Promise<ResolutionLearningSourceResult>;
  /** Null is only an observation; an in-flight review can still commit. */
  readResolutionLearningReviewReceipt(
    access: AccessContext,
    command: ReviewResolutionLearningProposalCommand,
  ): Promise<ResolutionLearningReviewReceipt | null>;
  /**
   * Recover an accepted review, or atomically fence its exact command against
   * future acceptance. The guard confirms current human authority, not the old
   * KB target. Unknown/error results never prove cancellation.
   */
  cancelResolutionLearningReview(
    access: AccessContext,
    command: ReviewResolutionLearningProposalCommand,
    verifyBeforeCommit: ResolutionLearningCommitGuard,
  ): Promise<ResolutionLearningReviewReceipt>;
  confirmResolutionLearningSource(
    access: AccessContext,
    fence: ResolutionSourceFence,
  ): Promise<boolean>;
  confirmResolutionLearningTargetReview(
    access: AccessContext,
    command: {
      readonly ticketId: TicketId;
      readonly target: ResolutionLearningTarget;
      readonly policyVersion: string;
    },
  ): Promise<boolean>;
  readResolutionLearningReconciliation(
    access: AccessContext,
    ticketId: TicketId,
  ): Promise<ResolutionLearningReconciliationView>;
  recordResolutionLearningReconciliation(
    access: AccessContext,
    command: RecordResolutionLearningReconciliationCommand,
    verifyBeforeCommit: ResolutionLearningCommitGuard,
  ): Promise<ResolutionLearningReconciliationView>;
}
