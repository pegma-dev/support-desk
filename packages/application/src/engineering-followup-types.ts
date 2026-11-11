import type { AccessContext } from "@pegma/authorization-core";
import type { IsoTimestamp, PrincipalId } from "@pegma/spine";
import type { TicketId, MessageId } from "@pegma/support-desk-contracts";
import type {
  EngineeringCommand,
  EngineeringCommitGuard,
  EngineeringProcessing,
  EngineeringSecurity,
} from "./engineering-types.js";
import type { EngineeringFollowupWorkRecord } from "./engineering-followup-records.js";

export interface EngineeringFollowupKey {
  readonly ticketId: TicketId;
  readonly workId: string;
}
export interface EngineeringFollowupFence extends EngineeringFollowupKey {
  readonly workBindingHash: string;
}
export interface EngineeringFollowupClaimFence extends EngineeringFollowupKey {
  readonly workerId: string;
  readonly claimId: string;
  readonly claimGeneration: number;
}
export interface EngineeringFollowupAssociation {
  readonly ticketId: TicketId;
  readonly repositoryId: string;
  readonly issueId: string;
  readonly issueNumber: number;
  readonly dispatchId: string;
  readonly requestHash: string;
  readonly engineeringSourceGeneration: number;
  readonly followupRevocationEpoch: number;
}
export interface EngineeringFollowupIssueHead {
  readonly repositoryId: string;
  readonly issueId: string;
  readonly issueNumber: number;
  readonly generation: number;
  readonly hash: string;
  readonly state: "open" | "closed";
}
export interface EngineeringFollowupDeploymentHead {
  readonly contextRef: string;
  readonly generation: number;
  readonly hash: string;
  readonly state: "unknown" | "deployed" | "rolled_back";
  readonly deploymentEpoch: string;
}
export interface EngineeringFollowupMapping {
  readonly semanticMappingId: string;
  readonly mappingId: string;
  readonly mappingVersion: string;
  readonly affectedProductBinding: string;
  readonly fixedProduct: {
    readonly productId: string;
    readonly version: string;
    readonly buildId: string;
  };
  readonly releaseRef: string;
  readonly deploymentId: string;
  readonly scopeRef: string;
  readonly issueHeadHash: string;
  readonly deploymentHeadHash: string;
  readonly verification:
    | { readonly kind: "host_release"; readonly reference: string }
    | {
        readonly kind: "staff_verified";
        readonly reference: string;
        readonly actorId: PrincipalId;
      };
}
export interface EngineeringFollowupContext {
  readonly issueHead: EngineeringFollowupIssueHead;
  readonly deploymentHead: EngineeringFollowupDeploymentHead;
  readonly mapping?: EngineeringFollowupMapping;
}
export interface EngineeringFollowupAttestation {
  readonly verifierReceiptId: string;
  readonly verifierVersion: string;
  readonly verifiedAt: IsoTimestamp;
  readonly validUntil: IsoTimestamp;
}
export interface EngineeringFollowupPublicFact {
  readonly reference: string;
  readonly text: string;
}
export interface VerifiedEngineeringFollowupContext {
  readonly context: EngineeringFollowupContext;
  readonly publicFacts: readonly EngineeringFollowupPublicFact[];
  readonly attestation: EngineeringFollowupAttestation;
}
export interface EngineeringFollowupProofContext {
  readonly ticketId: TicketId;
  readonly ticketRevision: number;
  readonly lastVisibleMessageId: MessageId;
  readonly parentSourceGeneration: number;
  readonly followupRevocationEpoch: number;
  readonly association: EngineeringFollowupAssociation;
}
export interface EngineeringFollowupReleaseEvidencePort {
  verifyInput(
    inputReference: string,
    context: EngineeringFollowupProofContext,
    signal: AbortSignal,
  ): Promise<VerifiedEngineeringFollowupContext | null>;
  /** Fresh actual facts, independent of provider configuration or receipt refresh. */
  confirm(
    binding: EngineeringFollowupContext,
    context: EngineeringFollowupProofContext,
    signal: AbortSignal,
  ): Promise<VerifiedEngineeringFollowupContext | null>;
}
export interface EngineeringFollowupCandidate {
  readonly customerDraft: { readonly body: string };
  readonly kbProposal: {
    readonly summary: string;
    readonly changes: readonly string[];
    readonly advisoryValidationRequirements: readonly string[];
  } | null;
  readonly retestRequests: readonly {
    readonly steps: readonly string[];
    readonly expectedBehavior: string;
  }[];
}
export type EngineeringFollowupKbTarget =
  | { readonly kind: "none" }
  | {
      readonly kind: "article";
      readonly articleId: string;
      readonly collectionId: string;
      readonly articleRevision: number;
      readonly contentHash: string;
      readonly validationRequirementsHash: string;
      readonly validationRequirementIds: readonly string[];
    };
export interface EngineeringFollowupRetestRequest {
  readonly requestId: string;
  readonly steps: readonly string[];
  readonly expectedBehavior: string;
  readonly productBinding: string;
  readonly validationRequirementIds: readonly string[];
}
export interface EngineeringFollowupBundle {
  readonly customerDraft: { readonly body: string };
  readonly kbProposal: {
    readonly target: EngineeringFollowupKbTarget;
    readonly summary: string;
    readonly changes: readonly string[];
    readonly advisoryValidationRequirements: readonly string[];
  } | null;
  readonly retestRequests: readonly EngineeringFollowupRetestRequest[];
}
export interface EngineeringFollowupChecksBinding {
  readonly workBindingHash: string;
  readonly candidateHash: string;
  readonly bundleHash: string;
  readonly checkPolicyVersion: string;
  readonly followupRevocationEpoch: number;
  readonly issueHeadHash: string;
  readonly deploymentHeadHash: string;
}
export interface VerifiedEngineeringFollowupChecks extends EngineeringFollowupAttestation {
  readonly binding: EngineeringFollowupChecksBinding;
  readonly privacy: "passed";
  readonly factual: "passed";
  readonly applicability: "passed";
  readonly security: "clear";
}
export interface EngineeringFollowupChecksPort {
  verify(
    receipt: string,
    binding: EngineeringFollowupChecksBinding,
    signal: AbortSignal,
  ): Promise<VerifiedEngineeringFollowupChecks | null>;
}
export interface EngineeringFollowupRetestBinding extends EngineeringFollowupFence {
  readonly requestId: string;
  readonly requestHash: string;
  readonly bundleHash: string;
  readonly productBinding: string;
}
export interface VerifiedEngineeringFollowupRetest extends EngineeringFollowupAttestation {
  readonly binding: EngineeringFollowupRetestBinding;
  readonly result: "passed" | "failed";
  readonly executionId: string;
  readonly runnerId: string;
}
export interface EngineeringFollowupRetestPort {
  verify(
    receiptReference: string,
    binding: EngineeringFollowupRetestBinding,
    signal: AbortSignal,
  ): Promise<VerifiedEngineeringFollowupRetest | null>;
}
export interface EngineeringFollowupOptions {
  readonly enabled?: boolean;
  readonly releaseEvidence?: EngineeringFollowupReleaseEvidencePort;
  readonly checks?: EngineeringFollowupChecksPort;
  readonly retestReceipts?: EngineeringFollowupRetestPort;
  readonly maxWorksets?: number;
  readonly maxModelAttempts?: number;
  readonly maxBundleRevisions?: number;
  readonly trustTimeoutMilliseconds?: number;
  readonly maxLeaseMilliseconds?: number;
  readonly maxWorkMilliseconds?: number;
}
export interface EngineeringFollowupScanBounds {
  readonly limit: number;
  readonly cursor?: string;
}
export interface EngineeringFollowupScanResult {
  readonly associations: readonly EngineeringFollowupAssociation[];
  readonly candidates: readonly EngineeringFollowupKey[];
  readonly reviewCandidates: readonly EngineeringFollowupKey[];
  readonly attentionSources: readonly TicketId[];
  readonly physicalRows: number;
  readonly pages: 1;
  readonly nextCursor: string | null;
}
export interface ObserveEngineeringFollowupCommand extends EngineeringCommand {
  readonly association: {
    readonly repositoryId: string;
    readonly issueId: string;
  };
  readonly inputReference: string;
}
export interface EngineeringFollowupObservationResult {
  readonly ticketId: TicketId;
  readonly headGeneration: number;
  readonly workId?: string;
  readonly outcome: "queued" | "unchanged" | "held" | "stale";
  readonly reason?: string;
}
export interface EngineeringFollowupResult extends EngineeringFollowupKey {
  readonly workGeneration: number;
  readonly status: EngineeringFollowupWorkRecord["status"];
  readonly stepId?: string;
  readonly requestHash?: string;
  readonly candidateHash?: string;
  readonly bundleHash?: string;
  readonly messageId?: MessageId;
  readonly ticketRevision?: number;
}
export interface ClaimEngineeringFollowupWorkCommand extends EngineeringFollowupKey {
  readonly workerId: string;
  readonly claimId: string;
  readonly leaseMilliseconds: number;
}
export interface EngineeringFollowupModelBinding {
  readonly inputManifest: {
    readonly messages: readonly {
      readonly messageId: MessageId;
      readonly ordinal: number;
    }[];
    readonly workBindingHash: string;
    readonly contextHash: string;
    readonly publicFactsHash: string;
  };
  readonly inputFingerprint: string;
  readonly inputManifestHash: string;
  readonly configVersion: string;
  readonly promptVersion: string;
  readonly modelVersion: string;
  readonly parserVersion: string;
  readonly checkPolicyVersion: string;
  readonly budgetsHash: string;
  readonly usageReservationId: string;
  readonly deadline: IsoTimestamp;
}
export interface EngineeringFollowupClaim {
  readonly fence: EngineeringFollowupClaimFence;
  readonly sourceFence: EngineeringFollowupFence;
  readonly workGeneration: number;
  readonly leaseUntil: IsoTimestamp;
  readonly work: EngineeringFollowupWorkRecord;
  readonly proof: VerifiedEngineeringFollowupContext;
  readonly messages: readonly {
    readonly messageId: MessageId;
    readonly ordinal: number;
    readonly speaker: "customer" | "support" | "assistant" | "notification";
    readonly body: string;
  }[];
  readonly recoveredModelPreparation: boolean;
}
export interface PrepareEngineeringFollowupModelCommand extends EngineeringFollowupClaimFence {
  readonly binding: EngineeringFollowupModelBinding;
}
export interface EngineeringFollowupPreparedModel {
  readonly stepId: string;
  readonly requestHash: string;
  readonly maxCandidateBytes: 16_000;
}
export interface CompleteEngineeringFollowupModelCommand extends EngineeringFollowupClaimFence {
  readonly stepId: string;
  readonly requestHash: string;
  readonly candidate: EngineeringFollowupCandidate;
  readonly accounting: "accounted" | "unknown";
  readonly processing?: EngineeringProcessing;
}
export interface FinishEngineeringFollowupModelCommand extends EngineeringFollowupClaimFence {
  readonly stepId?: string;
  readonly requestHash?: string;
  readonly classificationCandidateHash?: string;
  readonly disposition:
    "retry" | "held" | "restricted" | "superseded" | "unknown";
  readonly accounting?: "not_called" | "accounted" | "unknown";
  readonly reason?: string;
  readonly retryAt?: IsoTimestamp;
  readonly processing?: EngineeringProcessing;
}
export interface PrepareEngineeringFollowupBundleCommand
  extends EngineeringCommand, EngineeringFollowupKey {
  readonly mode: "prepare" | "staff_reassessment";
  readonly expectedWorkGeneration: number;
  readonly candidateHash: string;
  readonly exactBundle: EngineeringFollowupBundle;
  readonly checksReceipt: string;
  readonly checkPolicyVersion: string;
  readonly recoveryIntentHash?: string;
}
export interface RecoverEngineeringFollowupPreparationCommand extends EngineeringFollowupKey {
  readonly commandId: string;
  readonly recoveryIntentHash: string;
}
export interface RejectEngineeringFollowupBundleCommand
  extends EngineeringCommand, EngineeringFollowupKey {
  readonly expectedWorkGeneration: number;
  readonly bundleHash: string;
  readonly reason: string;
}
export interface RetryEngineeringFollowupWorkCommand
  extends EngineeringCommand, EngineeringFollowupKey {
  readonly expectedWorkGeneration: number;
}
export interface AbandonEngineeringFollowupWorkCommand
  extends EngineeringCommand, EngineeringFollowupKey {
  readonly expectedWorkGeneration: number;
  readonly reason: string;
}
export interface ApproveAndPostEngineeringFollowupWebUpdateCommand
  extends EngineeringCommand, EngineeringFollowupKey {
  readonly expectedWorkGeneration: number;
  readonly expectedTicketRevision: number;
  readonly bundleHash: string;
  readonly messageId: MessageId;
}
/**
 * A trusted release check may supply a synchronous final proof assertion.
 * Returning void selects the application's stored proof and work deadlines.
 * Returning an assertion adds the guard's policy and invocation deadline checks.
 * Existing void guards remain supported.
 * Forward an AI coordinator guard's returned assertion unchanged through any
 * adapter so its shorter proof, policy and invocation limits are checked again
 * after the final awaited staff-authority observation.
 */
export type EngineeringFollowupWebUpdateProofGuard = () =>
  void | (() => true) | Promise<void | (() => true)>;

export interface EngineeringFollowupWebUpdateOptions {
  readonly signal?: AbortSignal;
  /**
   * Trusted, read-only current staff authority check for a new notice.
   * The AI coordinator preserves a SupportDeskAuthorizationError as its
   * existing authorization_unavailable category. Use signal for cancellation;
   * unclassified host errors remain coarse verification_unavailable failures.
   * A failed observation does not establish absence of an earlier commit.
   */
  readonly verifyBeforeCommit?: EngineeringCommitGuard;
}
export interface EngineeringFollowupPostResult extends EngineeringFollowupKey {
  readonly messageId: MessageId;
  readonly ticketRevision: number;
  readonly bundleHash: string;
}
export interface EngineeringFollowupReassessmentView {
  readonly work: EngineeringFollowupWorkRecord;
  readonly proofContext: EngineeringFollowupProofContext;
  readonly proof: VerifiedEngineeringFollowupContext;
  readonly prospectiveWorkBindingHash: string;
  readonly workGeneration: number;
}
export interface SubmitEngineeringFollowupRetestResultCommand
  extends EngineeringCommand, EngineeringFollowupKey {
  readonly retestRequestId: string;
  readonly receiptReference: string;
}
export interface EngineeringFollowupRetestResult extends EngineeringFollowupKey {
  readonly outcome: "recorded" | "unchanged" | "held";
  readonly result: "passed" | "failed";
}
export interface EngineeringFollowupApplication {
  scanEngineeringFollowups(
    access: AccessContext,
    bounds: EngineeringFollowupScanBounds,
  ): Promise<EngineeringFollowupScanResult>;
  observeEngineeringFollowup(
    access: AccessContext,
    command: ObserveEngineeringFollowupCommand,
  ): Promise<EngineeringFollowupObservationResult>;
  readEngineeringFollowupWork(
    access: AccessContext,
    key: EngineeringFollowupKey,
  ): Promise<EngineeringFollowupWorkRecord>;
  confirmEngineeringFollowupCurrent(
    access: AccessContext,
    fence: EngineeringFollowupFence & {
      readonly expectedWorkGeneration: number;
    },
  ): Promise<boolean>;
  readEngineeringFollowupReassessment(
    access: AccessContext,
    key: EngineeringFollowupKey,
  ): Promise<EngineeringFollowupReassessmentView>;
  claimEngineeringFollowupWork(
    access: AccessContext,
    command: ClaimEngineeringFollowupWorkCommand,
  ): Promise<EngineeringFollowupClaim | null>;
  prepareEngineeringFollowupModel(
    access: AccessContext,
    command: PrepareEngineeringFollowupModelCommand,
  ): Promise<EngineeringFollowupPreparedModel>;
  completeEngineeringFollowupModel(
    access: AccessContext,
    command: CompleteEngineeringFollowupModelCommand,
    guard: EngineeringCommitGuard,
  ): Promise<EngineeringFollowupResult>;
  finishEngineeringFollowupModel(
    access: AccessContext,
    command: FinishEngineeringFollowupModelCommand,
  ): Promise<EngineeringFollowupResult>;
  prepareEngineeringFollowupBundle(
    access: AccessContext,
    command: PrepareEngineeringFollowupBundleCommand,
    guard: EngineeringCommitGuard,
  ): Promise<EngineeringFollowupResult>;
  recoverEngineeringFollowupPreparation(
    access: AccessContext,
    command: RecoverEngineeringFollowupPreparationCommand,
  ): Promise<EngineeringFollowupResult | null>;
  rejectEngineeringFollowupBundle(
    access: AccessContext,
    command: RejectEngineeringFollowupBundleCommand,
  ): Promise<EngineeringFollowupResult>;
  retryEngineeringFollowupWork(
    access: AccessContext,
    command: RetryEngineeringFollowupWorkCommand,
  ): Promise<EngineeringFollowupResult>;
  abandonEngineeringFollowupWork(
    access: AccessContext,
    command: AbandonEngineeringFollowupWorkCommand,
  ): Promise<EngineeringFollowupResult>;
  approveAndPostEngineeringFollowupWebUpdate(
    access: AccessContext,
    command: ApproveAndPostEngineeringFollowupWebUpdateCommand,
    guard: EngineeringFollowupWebUpdateProofGuard,
    options?: EngineeringFollowupWebUpdateOptions,
  ): Promise<EngineeringFollowupPostResult>;
  submitEngineeringFollowupRetestResult(
    access: AccessContext,
    command: SubmitEngineeringFollowupRetestResultCommand,
  ): Promise<EngineeringFollowupRetestResult>;
}
