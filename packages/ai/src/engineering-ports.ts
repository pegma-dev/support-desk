import type { Clock, IsoTimestamp } from "@pegma/spine";
import type { AccessContext } from "@pegma/authorization-core";
import type {
  ClaimEngineeringWorkCommand,
  EngineeringApplication,
  EngineeringCandidate,
  EngineeringCommitGuard,
  EngineeringExportChecksBinding,
  EngineeringExportChecksVerifier,
  EngineeringExportRequest,
  EngineeringIssueAcknowledgement,
  EngineeringPolicyPort,
  EngineeringRepositoryDescriptor,
  EngineeringRepositoryObservation,
  EngineeringRoutingBinding,
  EngineeringRoutingVerifier,
  EngineeringSourceFence,
  EngineeringStepResult,
  ReviewEngineeringProposalCommand,
} from "@pegma/support-desk-application";
import type { LearningCheckPolicyPort } from "./learning-ports.js";
import type {
  LearningBudgets,
  LearningDataControls,
  LearningModelUsage,
  LearningServiceAccessPort,
  LearningServiceAuthority,
  LearningTokenCounter,
} from "./learning-ports.js";

export interface EngineeringBudgets extends LearningBudgets {
  readonly maxRepositories: number;
  readonly maxRepositoryBytes: number;
}

export interface EngineeringDataControls extends Omit<
  LearningDataControls,
  "purpose"
> {
  readonly purpose: "support_bug_assessment";
}

export interface VerifiedEngineeringConfiguration {
  readonly purpose: "support_bug_assessment";
  readonly version: string;
  readonly promptVersion: string;
  readonly modelVersion: string;
  readonly parserVersion: string;
  readonly provider: string;
  readonly model: string;
  readonly pricingRef: string;
  readonly trustedInstructions: string;
  readonly framingTokens: number;
  readonly budgets: EngineeringBudgets;
  readonly dataControls: EngineeringDataControls;
}

export interface EngineeringConfigurationPort {
  /** Ready verifies the entire current ZDR route for this distinct purpose. */
  resolve(
    expectedVersion: string | undefined,
    signal: AbortSignal,
  ): Promise<
    | {
        readonly outcome: "ready";
        readonly configuration: VerifiedEngineeringConfiguration;
      }
    | { readonly outcome: "disabled" | "unavailable" }
  >;
}

export type EngineeringServiceAuthority = LearningServiceAuthority;
export type EngineeringServiceAccessPort = LearningServiceAccessPort;
export type EngineeringTokenCounter = LearningTokenCounter;
export type EngineeringModelUsage = LearningModelUsage;

/** Only admin-approved descriptive routing material crosses the model boundary. */
export interface EngineeringModelRepositoryDescriptor {
  readonly repositoryId: string;
  readonly owner: string;
  readonly name: string;
  readonly responsibilities: string;
  readonly product: string;
  readonly component: string;
  readonly version: string;
  readonly allowedLabels: readonly string[];
  readonly allowedTemplates: readonly string[];
}

/** No private notes, actor IDs, receipts, installation scope, or source references. */
export interface EngineeringModelInput {
  readonly trustedInstructions: string;
  readonly messages: readonly {
    readonly speaker: "customer" | "support" | "assistant" | "notification";
    readonly text: string;
  }[];
  readonly report: {
    readonly expected: string;
    readonly actual: string;
    readonly reproductionSteps: readonly string[];
    readonly product: {
      readonly productId: string;
      readonly version: string;
      readonly buildId: string;
    };
  };
  readonly repositories: readonly EngineeringModelRepositoryDescriptor[];
}

/** Server-only metadata. Never forward this object into provider content or logs. */
export interface EngineeringAttemptContext {
  readonly purpose: "support_bug_assessment";
  readonly invocationId: string;
  readonly operationId: string;
  readonly attemptId: string;
  readonly attempt: number;
  readonly inputFingerprint: string;
  readonly inputManifestHash: string;
  readonly configurationVersion: string;
  readonly promptVersion: string;
  readonly modelVersion: string;
  readonly parserVersion: string;
  readonly policyVersion: string;
  readonly authorityVersion: string;
  readonly usageScopeRef: string;
  readonly usageReservationId: string;
  readonly deadline: IsoTimestamp;
  readonly signal: AbortSignal;
  readonly budgets: EngineeringBudgets;
}

export interface EngineeringModelResult {
  /** Bound raw UTF-8 bytes before parsing; never stream a proposal externally. */
  readonly outputJson: string;
  readonly provider: string;
  readonly model: string;
  readonly requestId: string;
  readonly usage: EngineeringModelUsage;
}

export interface EngineeringModelPort {
  generate(
    input: EngineeringModelInput,
    context: EngineeringAttemptContext,
    configuration: VerifiedEngineeringConfiguration,
  ): Promise<EngineeringModelResult>;
}

export interface EngineeringUsageIdentity {
  readonly purpose: "support_bug_assessment";
  readonly operationId: string;
  readonly attemptId: string;
  readonly inputFingerprint: string;
  readonly usageReservationId: string;
}

export type EngineeringUsageObservation =
  | { readonly state: "not_called" }
  | { readonly state: "unknown" }
  | { readonly state: "known"; readonly usage: EngineeringModelUsage };

export interface EngineeringUsagePort {
  reserve(
    context: EngineeringAttemptContext,
  ): Promise<
    | { readonly outcome: "reserved"; readonly usageReservationId: string }
    | { readonly outcome: "denied" | "unavailable" }
  >;
  reconcile(
    identity: EngineeringUsageIdentity,
    observation: EngineeringUsageObservation,
  ): Promise<"reconciled" | "pending">;
}

export interface EngineeringRuntimeOptions {
  readonly clock: Clock;
  readonly maxOperationMilliseconds?: number;
  readonly commitReserveMilliseconds?: number;
  readonly storageCommandAttempts?: number;
}

export interface EngineeringExternalContext {
  readonly purpose: "support_bug_assessment";
  readonly deadline: IsoTimestamp;
  readonly signal: AbortSignal;
}

/** Correlates trusted remote receipts; never included in issue content or logs. */
export interface EngineeringGitHubContext extends EngineeringExternalContext {
  readonly sourceFence: EngineeringSourceFence;
  readonly dispatchId: string;
  readonly requestHash: string;
}

export interface VerifiedEngineeringCalibration {
  readonly version: string;
  readonly artifactRef: string;
  readonly rubricVersion: string;
  readonly evaluationRef: string;
  readonly modelVersion: string;
  readonly promptVersion: string;
  readonly parserVersion: string;
  readonly policyHash: string;
  readonly verifiedAt: IsoTimestamp;
  readonly validUntil: IsoTimestamp;
}

export interface EngineeringRoutingPort extends EngineeringRoutingVerifier {
  /** Ready requires reviewed labeled/ambiguous/out-of-scope actual-model evaluation. */
  resolve(signal: AbortSignal): Promise<
    | {
        readonly outcome: "ready";
        readonly calibration: VerifiedEngineeringCalibration;
      }
    | { readonly outcome: "unavailable" }
  >;
  /** An automated calibrated gate, never a model's self-assigned confidence. */
  check(
    input: {
      readonly candidate: EngineeringCandidate;
      readonly binding: EngineeringRoutingBinding;
    },
    context: EngineeringExternalContext,
  ): Promise<
    | { readonly outcome: "checked"; readonly receipt: string }
    | { readonly outcome: "human_required" | "restricted" | "unavailable" }
  >;
}

export type EngineeringProposalContent =
  | {
      readonly candidate: EngineeringCandidate;
      readonly previousRequest?: never;
    }
  | {
      readonly candidate?: never;
      readonly previousRequest: EngineeringExportRequest;
    };

export interface EngineeringChecksPort
  extends EngineeringExportChecksVerifier, LearningCheckPolicyPort {
  /** Independently inspect the entire final request, including all hidden text. */
  check(
    input: EngineeringProposalContent & {
      readonly exactRequest: EngineeringExportRequest;
      readonly binding: EngineeringExportChecksBinding;
      readonly checkPolicyVersion: string;
    },
    context: EngineeringExternalContext,
  ): Promise<
    | { readonly outcome: "checked"; readonly receipt: string }
    | { readonly outcome: "held" | "restricted" | "unavailable" }
  >;
  /** Verification must reject revoked/stale receipts under the current check policy. */
}

export interface EngineeringGitHubMetadata {
  readonly repository: EngineeringRepositoryObservation;
  /** Current host-owned installation authority, separate from model configuration. */
  readonly authority: {
    readonly active: true;
    readonly binding: string;
    readonly validUntil: IsoTimestamp;
  };
}

export interface EngineeringDuplicateIssue {
  readonly repositoryId: string;
  readonly issueId: string;
  readonly issueNumber: number;
  readonly title: string;
  readonly body: string;
}

export interface EngineeringGitHubPort {
  getMetadata(
    repositoryId: string,
    context: EngineeringExternalContext,
  ): Promise<EngineeringGitHubMetadata | null>;
  /** Query is trusted configured text, or an independently checked sanitized string. */
  searchDuplicates(
    input: {
      readonly repositoryId: string;
      readonly query: string;
      readonly limit: number;
    },
    context: EngineeringExternalContext,
  ): Promise<{
    readonly issues: readonly EngineeringDuplicateIssue[];
    readonly physicalResults: number;
  }>;
  /** One physical create after durable dispatch-started. There is no idempotence promise. */
  createIssue(
    request: Extract<EngineeringExportRequest, { operation: "create_issue" }>,
    context: EngineeringGitHubContext,
  ): Promise<EngineeringIssueAcknowledgement>;
  /** Empty search, missing issue and elapsed time must remain unknown. */
  reconcile(
    input: {
      readonly repositoryId: string;
      readonly exportMarker: string;
      readonly dispatchId: string;
      readonly requestHash: string;
      readonly operation?: "create_issue" | "link_existing_issue";
      readonly issueId?: string;
      readonly issueNumber?: number;
      readonly sourceFence?: EngineeringSourceFence;
      readonly repositoryMetadataHash?: string;
    },
    context: EngineeringExternalContext,
  ): Promise<
    | {
        readonly outcome: "accepted";
        readonly acknowledgement: EngineeringIssueAcknowledgement;
        readonly proof: string;
      }
    | { readonly outcome: "confirmed_rejected"; readonly proof: string }
    | { readonly outcome: "unknown"; readonly reason?: string }
  >;
}

export interface EngineeringProposalPort {
  /** This query comes from trusted host configuration, never a raw report. */
  duplicateQuery(
    repository: EngineeringRepositoryDescriptor,
    context: EngineeringExternalContext,
  ): Promise<string | null>;
  /** Server-local proposal construction; no customer data may be sent externally here. */
  prepare(
    input: EngineeringProposalContent & {
      readonly repository: EngineeringRepositoryObservation;
      readonly descriptor: EngineeringRepositoryDescriptor;
      readonly exportMarker: string;
      readonly duplicates: readonly EngineeringDuplicateIssue[];
    },
    context: EngineeringExternalContext,
  ): Promise<
    | {
        readonly outcome: "prepared";
        readonly request: EngineeringExportRequest;
      }
    | { readonly outcome: "held" | "restricted" | "unavailable" }
  >;
}

export interface SupportDeskEngineeringOptions extends EngineeringRuntimeOptions {
  readonly application: EngineeringApplication;
  readonly policy: EngineeringPolicyPort;
  readonly serviceAccess: EngineeringServiceAccessPort;
  /** Separate current-read authority permits reconciliation after withdrawal/deletion. */
  readonly reconciliationAccess: EngineeringServiceAccessPort;
  readonly configuration: EngineeringConfigurationPort;
  readonly routing: EngineeringRoutingPort;
  readonly checks: EngineeringChecksPort;
  readonly model: EngineeringModelPort;
  readonly usage: EngineeringUsagePort;
  readonly tokenCounter: EngineeringTokenCounter;
  readonly github: EngineeringGitHubPort;
  readonly proposals: EngineeringProposalPort;
}

export type EngineeringProcessResult =
  | { readonly outcome: "not_claimed" }
  | { readonly outcome: "reconciled"; readonly processed: number }
  | {
      readonly outcome:
        "candidate" | "prepared" | "held" | "restricted" | "dispatched";
      readonly result: EngineeringStepResult;
    }
  | {
      readonly outcome: "pending";
      readonly stage:
        "prepare" | "complete" | "finish" | "dispatch" | "reconciliation";
      /** Current sanitized failure; pending never asserts that a call did not commit. */
      readonly reason?: string;
    };

export interface EngineeringReviewOptions {
  readonly signal?: AbortSignal;
  /** Trusted read-only current human authority check for a new decision. */
  readonly verifyBeforeCommit?: EngineeringCommitGuard;
}

export interface SupportDeskEngineering {
  scanCandidates(
    bounds: Parameters<EngineeringApplication["scanEngineeringCandidates"]>[1],
  ): ReturnType<EngineeringApplication["scanEngineeringCandidates"]>;
  processWork(
    command: Omit<ClaimEngineeringWorkCommand, "claimId">,
    options?: { readonly signal?: AbortSignal },
  ): Promise<EngineeringProcessResult>;
  reviewProposal(
    access: AccessContext,
    command: ReviewEngineeringProposalCommand,
    options?: EngineeringReviewOptions,
  ): Promise<EngineeringStepResult>;
  reconcileSource(
    ticketId: string,
    options?: { readonly signal?: AbortSignal },
  ): Promise<{
    readonly outcome: "reconciled" | "pending";
    readonly processed: number;
    readonly reason?: string;
  }>;
}
