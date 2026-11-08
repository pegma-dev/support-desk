import type { AccessContext } from "@pegma/authorization-core";
import type { IsoTimestamp, PrincipalId } from "@pegma/spine";
import type { TicketId } from "@pegma/support-desk-contracts";
import type { ResolutionProductContext } from "./resolution-learning-types.js";
import type {
  EngineeringSourceRecord,
  EngineeringWorkRecord,
} from "./engineering-records.js";

export type EngineeringSecurity = "ordinary" | "restricted" | "uncertain";
export type EngineeringProductContext = ResolutionProductContext;
export interface EngineeringTrustContext {
  readonly ticketId: TicketId;
  readonly ticketRevision: number;
  readonly sourceGeneration: number;
  readonly actorId: PrincipalId;
  readonly acceptedAt: IsoTimestamp;
}
export interface EngineeringProductContextPort {
  resolve(
    context: EngineeringTrustContext,
    signal: AbortSignal,
  ): Promise<EngineeringProductContext | null>;
}
export interface EngineeringFailedTest {
  readonly result: "failed";
  readonly executionId: string;
  readonly runnerId: string;
  readonly testId: string;
  readonly productBinding: string;
  readonly executedAt: IsoTimestamp;
  readonly receiptId: string;
  readonly verifiedAt: IsoTimestamp;
  readonly validUntil: IsoTimestamp;
}
export interface EngineeringTestReceiptPort {
  verify(
    receipt: string,
    context: EngineeringTrustContext & {
      readonly product: EngineeringProductContext;
      readonly evidence: EngineeringMismatch;
    },
    signal: AbortSignal,
  ): Promise<EngineeringFailedTest | null>;
}
export interface EngineeringMismatch {
  readonly expectedBehavior: string;
  readonly actualBehavior: string;
  readonly reproductionSteps: readonly string[];
  readonly visibleMessageIds: readonly string[];
}
export type EngineeringEvidence = EngineeringMismatch & {
  readonly actorId: PrincipalId;
} & (
    | {
        readonly kind: "staff_verified_failure";
        readonly verificationReference: string;
      }
    | { readonly kind: "failed_test"; readonly test: EngineeringFailedTest }
  );
export type EngineeringEvidenceInput = EngineeringMismatch &
  (
    | {
        readonly kind: "staff_verified_failure";
        readonly verificationReference: string;
      }
    | { readonly kind: "failed_test"; readonly receipt: string }
  );

export interface EngineeringRepositoryDescriptor {
  readonly repositoryId: string;
  readonly owner: string;
  readonly name: string;
  readonly visibility: "public" | "private";
  readonly responsibilities: string;
  readonly product: string;
  readonly component: string;
  readonly version: string;
  readonly allowedLabels: readonly string[];
  readonly allowedTemplates: readonly string[];
  readonly publicationMode: "approval_required";
  readonly enabled: boolean;
}
export interface EngineeringRepositoryPolicy {
  readonly enabled: boolean;
  readonly repositories: readonly EngineeringRepositoryDescriptor[];
}
export interface EngineeringPolicySnapshot {
  readonly generation: number;
  readonly policyHash: string;
  readonly policy: EngineeringRepositoryPolicy;
}
export interface EngineeringPolicyResult {
  readonly generation: number;
  readonly policyHash: string;
  readonly enabled: boolean;
}
export interface EngineeringPolicyCommand {
  readonly commandId: string;
  readonly correlationId: string;
  readonly expectedGeneration: number;
}
export interface PutEngineeringPolicyCommand extends EngineeringPolicyCommand {
  readonly policy: EngineeringRepositoryPolicy;
}
export interface EngineeringPolicyApplication {
  readRepositoryPolicy(
    access: AccessContext,
  ): Promise<EngineeringPolicySnapshot>;
  putRepositoryPolicy(
    access: AccessContext,
    command: PutEngineeringPolicyCommand,
  ): Promise<EngineeringPolicyResult>;
  disableEngineeringExports(
    access: AccessContext,
    command: EngineeringPolicyCommand,
  ): Promise<EngineeringPolicyResult>;
}
export interface EngineeringPolicyPort {
  /** Fresh authoritative head, independent of model/worker enablement. */
  resolve(access: AccessContext): Promise<EngineeringPolicySnapshot>;
}
export interface EngineeringRepositoryObservation {
  readonly repositoryId: string;
  readonly owner: string;
  readonly name: string;
  readonly visibility: "public" | "private";
  readonly installationBinding: string;
  readonly metadataVersion: string;
}
export type EngineeringRoutingDecision = {
  readonly alternativeRepositoryIds: readonly string[];
  readonly rationale: string;
} & (
  | { readonly outcome: "selected"; readonly repositoryId: string }
  | { readonly outcome: "ambiguous" | "out_of_scope" }
);
export interface EngineeringCandidate {
  readonly title: string;
  readonly summary: string;
  readonly expectedBehavior: string;
  readonly actualBehavior: string;
  readonly reproductionSteps: readonly string[];
  readonly applicability: {
    readonly productId: string;
    readonly version: string;
    readonly buildId: string;
  };
  readonly security: EngineeringSecurity;
  readonly routing: EngineeringRoutingDecision;
}
export interface EngineeringRoutingBinding {
  readonly sourceBindingHash: string;
  readonly evidenceFingerprint: string;
  readonly candidateHash: string;
  readonly inputFingerprint: string;
  readonly routingHash: string;
  readonly policyGeneration: number;
  readonly policyHash: string;
  readonly modelVersion: string;
  readonly promptVersion: string;
  readonly parserVersion: string;
  readonly repositoryId: string;
}
export interface VerifiedEngineeringRouting {
  readonly binding: EngineeringRoutingBinding;
  readonly outcome: "accepted" | "human_required" | "restricted";
  readonly verifierReceiptId: string;
  readonly verifierVersion: string;
  readonly verifiedAt: IsoTimestamp;
  readonly validUntil: IsoTimestamp;
}
export interface EngineeringRoutingVerifier {
  verify(
    receipt: string,
    binding: EngineeringRoutingBinding,
  ): Promise<VerifiedEngineeringRouting | null>;
}
export interface EngineeringSanitizedBundle {
  readonly title: string;
  readonly body: string;
  readonly labels: readonly string[];
  readonly templateId?: string;
  readonly evidenceReferences: readonly string[];
  readonly exportMarker: string;
}
export type EngineeringExportRequest = {
  readonly repository: EngineeringRepositoryObservation;
  readonly bundle: EngineeringSanitizedBundle;
} & (
  | { readonly operation: "create_issue" }
  | {
      readonly operation: "link_existing_issue";
      readonly issueId: string;
      readonly issueNumber: number;
    }
);
export interface EngineeringExportChecksBinding {
  readonly sourceBindingHash: string;
  readonly evidenceFingerprint: string;
  readonly candidateHash: string;
  readonly routingBindingHash: string;
  readonly requestHash: string;
  readonly policyGeneration: number;
  readonly policyHash: string;
  readonly repositoryMetadataHash: string;
}
export interface VerifiedEngineeringExportChecks {
  readonly binding: EngineeringExportChecksBinding;
  readonly privacy: "passed";
  readonly factual: "passed";
  readonly security: "clear";
  readonly publicReproduction: "passed" | "not_applicable";
  readonly verifierReceiptId: string;
  readonly verifierVersion: string;
  readonly verifiedAt: IsoTimestamp;
  readonly validUntil: IsoTimestamp;
}
export interface EngineeringExportChecksVerifier {
  verify(
    receipt: string,
    binding: EngineeringExportChecksBinding,
  ): Promise<VerifiedEngineeringExportChecks | null>;
}
export interface EngineeringRepositoryMetadataPort {
  /** Actual current repository/installation facts; never caller-supplied metadata. */
  resolve(
    repositoryId: string,
    signal: AbortSignal,
  ): Promise<EngineeringRepositoryObservation | null>;
}
export interface EngineeringDispatchProofBinding extends EngineeringSourceFence {
  readonly repositoryId: string;
  readonly repositoryMetadataHash: string;
  readonly dispatchId: string;
  readonly requestHash: string;
  readonly exportMarker: string;
  readonly operation: "create_issue" | "link_existing_issue";
  readonly result: Exclude<
    RecordEngineeringDispatchResultCommand["result"],
    { readonly outcome: "unknown" }
  >;
}
export interface VerifiedEngineeringDispatchResult {
  readonly binding: EngineeringDispatchProofBinding;
  readonly verifierReceiptId: string;
  readonly verifierVersion: string;
  readonly verifiedAt: IsoTimestamp;
  readonly validUntil: IsoTimestamp;
}
export interface EngineeringDispatchResultVerifier {
  /** Authenticate unique acceptance or authoritative no-acceptance; absence is insufficient. */
  verify(
    binding: EngineeringDispatchProofBinding,
    signal: AbortSignal,
  ): Promise<VerifiedEngineeringDispatchResult | null>;
}
export interface EngineeringOptions {
  readonly enabled?: boolean;
  readonly productContext?: EngineeringProductContextPort;
  readonly testReceipts?: EngineeringTestReceiptPort;
  readonly routing?: EngineeringRoutingVerifier;
  readonly checks?: EngineeringExportChecksVerifier;
  readonly repositoryMetadata?: EngineeringRepositoryMetadataPort;
  readonly dispatchResults?: EngineeringDispatchResultVerifier;
  readonly trustTimeoutMilliseconds?: number;
  readonly maxGenerations?: number;
  readonly maxTargets?: number;
  readonly maxProposals?: number;
  readonly maxModelAttempts?: number;
  readonly maxLeaseMilliseconds?: number;
  readonly maxWorkMilliseconds?: number;
}
export interface EngineeringCommand {
  readonly ticketId: TicketId;
  readonly commandId: string;
  readonly correlationId: string;
}
export interface EngineeringKey {
  readonly ticketId: TicketId;
  readonly sourceGeneration: number;
}
export interface EngineeringSourceFence extends EngineeringKey {
  readonly sourceBindingHash: string;
}
export interface EngineeringClaimFence extends EngineeringKey {
  readonly workerId: string;
  readonly claimId: string;
  readonly claimGeneration: number;
}
export interface EnrollEngineeringSourceCommand extends EngineeringCommand {
  readonly expectedRevision: number;
}
export interface SubmitEngineeringEvidenceCommand extends EngineeringCommand {
  readonly expectedRevision: number;
  readonly evidence: EngineeringEvidenceInput;
  readonly security: EngineeringSecurity;
}
export interface InvalidateEngineeringSourceCommand extends EngineeringCommand {
  readonly reason:
    "evidence_revoked" | "product_binding_revoked" | "check_policy_revoked";
}
export interface WithdrawEngineeringSourceCommand extends EngineeringCommand {
  readonly reason:
    "privacy_withdrawal" | "source_access_revoked" | "source_deleted";
}
export interface EngineeringSourceResult extends EngineeringKey {
  readonly state: EngineeringSourceRecord["state"];
  readonly security: EngineeringSecurity;
  readonly heldReason?: string;
}
export interface EngineeringModelBinding {
  readonly inputManifest: {
    readonly messages: readonly {
      readonly messageId: string;
      readonly ordinal: number;
    }[];
    readonly evidenceFingerprint: string;
    readonly product: {
      readonly productId: string;
      readonly version: string;
      readonly buildId: string;
      readonly binding: string;
      readonly contextVersion: string;
    };
    readonly policyGeneration: number;
    readonly policyHash: string;
    readonly repositoryIds: readonly string[];
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
export interface EngineeringProcessing {
  readonly provider?: string;
  readonly model?: string;
  readonly requestId?: string;
  readonly failureCategory?: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly costMicros?: number;
  readonly currency?: string;
}
export interface EngineeringClaim {
  readonly fence: EngineeringClaimFence;
  readonly sourceFence: EngineeringSourceFence;
  readonly workGeneration: number;
  readonly leaseUntil: IsoTimestamp;
  readonly work: EngineeringWorkRecord;
  readonly policy: EngineeringPolicySnapshot;
  readonly messages: readonly {
    readonly messageId: string;
    readonly ordinal: number;
    readonly speaker: "customer" | "support" | "assistant" | "notification";
    readonly body: string;
  }[];
  readonly recoveredModelPreparation: boolean;
  readonly reconciliationOnly: boolean;
}
export interface ClaimEngineeringWorkCommand extends EngineeringKey {
  readonly workerId: string;
  readonly claimId: string;
  readonly leaseMilliseconds: number;
}
export interface PrepareEngineeringModelCommand extends EngineeringClaimFence {
  readonly binding: EngineeringModelBinding;
}
export interface EngineeringPreparedModel {
  readonly stepId: string;
  readonly requestHash: string;
  readonly maxCandidateBytes: 16_000;
}
export interface CompleteEngineeringModelCommand extends EngineeringClaimFence {
  readonly stepId: string;
  readonly requestHash: string;
  readonly candidate: EngineeringCandidate;
  readonly processing?: EngineeringProcessing;
  readonly accounting: "accounted" | "unknown";
}
export interface FinishEngineeringWorkCommand extends EngineeringClaimFence {
  readonly stepId?: string;
  readonly requestHash?: string;
  readonly disposition:
    "retry" | "held" | "restricted" | "unknown" | "superseded";
  readonly accounting?: "not_called" | "accounted" | "unknown";
  readonly retryAt?: IsoTimestamp;
  readonly reason?: string;
  readonly processing?: EngineeringProcessing;
}
export interface SelectEngineeringRepositoryCommand
  extends EngineeringCommand, EngineeringKey {
  readonly expectedWorkGeneration: number;
  readonly repositoryId: string;
  readonly policyGeneration: number;
  readonly policyHash: string;
  readonly reason: string;
}
export interface PrepareEngineeringProposalCommand extends EngineeringClaimFence {
  readonly candidateHash: string;
  readonly routingReceipt?: string;
  readonly checksReceipt: string;
  readonly exactRequest: EngineeringExportRequest;
  readonly policyGeneration: number;
  readonly policyHash: string;
}
export interface ReviewEngineeringProposalCommand
  extends EngineeringCommand, EngineeringKey {
  readonly expectedWorkGeneration: number;
  readonly proposalHash: string;
  readonly decision: "approve" | "reject";
  readonly reason?: string;
}
export interface BeginEngineeringDispatchCommand extends EngineeringClaimFence {
  readonly stepId: string;
  readonly requestHash: string;
  readonly proposalHash: string;
  readonly dispatchId: string;
}
export interface EngineeringDispatchPermit extends EngineeringKey {
  readonly dispatchId: string;
  readonly exportMarker: string;
  readonly requestHash: string;
  readonly request: EngineeringExportRequest;
}
export interface EngineeringIssueAcknowledgement {
  readonly repositoryId: string;
  readonly issueId: string;
  readonly issueNumber: number;
  readonly url?: string;
}
export interface RecordEngineeringDispatchResultCommand extends EngineeringKey {
  readonly dispatchId: string;
  readonly requestHash: string;
  readonly result:
    | {
        readonly outcome: "accepted";
        readonly acknowledgement: EngineeringIssueAcknowledgement;
      }
    | { readonly outcome: "confirmed_rejected"; readonly proof: string }
    | { readonly outcome: "unknown"; readonly reason?: string };
}
export interface EngineeringStepResult extends EngineeringKey {
  readonly workGeneration: number;
  readonly status: EngineeringWorkRecord["status"];
  readonly stepId?: string;
  readonly requestHash?: string;
  readonly candidateHash?: string;
  readonly proposalHash?: string;
  readonly dispatchId?: string;
  readonly acknowledgement?: EngineeringIssueAcknowledgement;
}
export interface EngineeringReconciliationView extends EngineeringKey {
  readonly sourceWorkGeneration: number;
  readonly state: EngineeringSourceRecord["state"];
  readonly destinations: readonly (EngineeringSourceRecord["destinations"][number] & {
    readonly requestIdentity: {
      readonly operation: "create_issue" | "link_existing_issue";
      readonly sourceBindingHash: string;
      readonly repositoryMetadataHash: string;
      readonly issueId?: string;
      readonly issueNumber?: number;
    } | null;
    readonly requestIdentityStatus: "available" | "unavailable";
  })[];
}
export interface RecordEngineeringReconciliationCommand extends EngineeringKey {
  readonly expectedSourceWorkGeneration: number;
  readonly repositoryId: string;
  readonly dispatchId: string;
  readonly requestHash: string;
  readonly result:
    | {
        readonly outcome: "accepted";
        readonly acknowledgement: EngineeringIssueAcknowledgement;
        readonly proof: string;
      }
    | { readonly outcome: "confirmed_rejected"; readonly proof: string }
    | { readonly outcome: "unknown"; readonly reason?: string };
}
export type EngineeringCommitGuard = () => void | Promise<void>;
export interface EngineeringApplication {
  enrollEngineeringSource(
    access: AccessContext,
    command: EnrollEngineeringSourceCommand,
  ): Promise<EngineeringSourceResult>;
  submitEngineeringEvidence(
    access: AccessContext,
    command: SubmitEngineeringEvidenceCommand,
  ): Promise<EngineeringSourceResult>;
  invalidateEngineeringSource(
    access: AccessContext,
    command: InvalidateEngineeringSourceCommand,
  ): Promise<EngineeringSourceResult>;
  withdrawEngineeringSource(
    access: AccessContext,
    command: WithdrawEngineeringSourceCommand,
  ): Promise<EngineeringSourceResult>;
  readEngineeringSource(
    access: AccessContext,
    ticketId: TicketId,
  ): Promise<EngineeringSourceRecord>;
  readEngineeringWork(
    access: AccessContext,
    key: EngineeringKey,
  ): Promise<EngineeringWorkRecord>;
  scanEngineeringCandidates(
    access: AccessContext,
    bounds: { readonly limit: number; readonly cursor?: string },
  ): Promise<{
    readonly candidates: readonly EngineeringKey[];
    readonly reconciliationSources: readonly TicketId[];
    readonly physicalRows: number;
    readonly pages: 1;
    readonly nextCursor: string | null;
  }>;
  claimEngineeringWork(
    access: AccessContext,
    command: ClaimEngineeringWorkCommand,
  ): Promise<EngineeringClaim | null>;
  prepareEngineeringModel(
    access: AccessContext,
    command: PrepareEngineeringModelCommand,
  ): Promise<EngineeringPreparedModel>;
  completeEngineeringModel(
    access: AccessContext,
    command: CompleteEngineeringModelCommand,
    guard: EngineeringCommitGuard,
  ): Promise<EngineeringStepResult>;
  finishEngineeringWork(
    access: AccessContext,
    command: FinishEngineeringWorkCommand,
  ): Promise<EngineeringStepResult>;
  selectEngineeringRepository(
    access: AccessContext,
    command: SelectEngineeringRepositoryCommand,
  ): Promise<EngineeringStepResult>;
  prepareEngineeringProposal(
    access: AccessContext,
    command: PrepareEngineeringProposalCommand,
    guard: EngineeringCommitGuard,
  ): Promise<EngineeringStepResult>;
  reviewEngineeringProposal(
    access: AccessContext,
    command: ReviewEngineeringProposalCommand,
    guard: EngineeringCommitGuard,
  ): Promise<EngineeringStepResult>;
  beginEngineeringDispatch(
    access: AccessContext,
    command: BeginEngineeringDispatchCommand,
    guard: EngineeringCommitGuard,
  ): Promise<EngineeringDispatchPermit | null>;
  recordEngineeringDispatchResult(
    access: AccessContext,
    command: RecordEngineeringDispatchResultCommand,
  ): Promise<EngineeringStepResult>;
  readEngineeringReconciliation(
    access: AccessContext,
    ticketId: TicketId,
  ): Promise<EngineeringReconciliationView>;
  recordEngineeringReconciliation(
    access: AccessContext,
    command: RecordEngineeringReconciliationCommand,
    guard: EngineeringCommitGuard,
  ): Promise<EngineeringReconciliationView>;
}
