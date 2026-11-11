import type { AccessContext } from "@pegma/authorization-core";
import type { Clock, IsoTimestamp } from "@pegma/spine";
import type {
  DraftArticleDto,
  KnowledgeBaseApplication,
  ValidationRequirementsDto,
} from "@pegma/knowledge-base-application";
import type {
  ApproveAndPostEngineeringFollowupWebUpdateCommand,
  ClaimEngineeringFollowupWorkCommand,
  EngineeringCommand,
  EngineeringFollowupApplication,
  EngineeringFollowupBundle,
  EngineeringFollowupCandidate,
  EngineeringFollowupChecksBinding,
  EngineeringFollowupChecksPort,
  EngineeringFollowupContext,
  EngineeringFollowupKey,
  EngineeringFollowupProofContext,
  EngineeringFollowupReleaseEvidencePort,
  EngineeringFollowupResult,
  EngineeringFollowupWebUpdateOptions,
  VerifiedEngineeringFollowupContext,
} from "@pegma/support-desk-application";
import type {
  LearningBudgets,
  LearningCheckPolicyPort,
  LearningDataControls,
  LearningModelUsage,
  LearningServiceAccessPort,
  LearningServiceAuthority,
  LearningTokenCounter,
} from "./learning-ports.js";
import type { LearningKnowledgeAccessPort } from "./learning-integration-types.js";

export type ReleaseFollowupBudgets = LearningBudgets;
export type ReleaseFollowupServiceAuthority = LearningServiceAuthority;
/** The coordinator applies method-specific grants to each freshly resolved context. */
export type ReleaseFollowupServiceAccessPort = LearningServiceAccessPort;
export type ReleaseFollowupTokenCounter = LearningTokenCounter;
export type ReleaseFollowupModelUsage = LearningModelUsage;

export interface ReleaseFollowupDataControls extends Omit<
  LearningDataControls,
  "purpose"
> {
  readonly purpose: "support_release_followup";
}

export interface VerifiedReleaseFollowupConfiguration {
  readonly purpose: "support_release_followup";
  readonly version: string;
  readonly promptVersion: string;
  readonly modelVersion: string;
  readonly parserVersion: string;
  readonly evaluationVersion: string;
  readonly provider: string;
  readonly model: string;
  readonly pricingRef: string;
  readonly trustedInstructions: string;
  readonly framingTokens: number;
  readonly budgets: ReleaseFollowupBudgets;
  readonly dataControls: ReleaseFollowupDataControls;
}

export interface ReleaseFollowupConfigurationPort {
  /** Ready verifies the complete current ZDR route for this distinct purpose. */
  resolve(
    expectedVersion: string | undefined,
    signal: AbortSignal,
  ): Promise<
    | {
        readonly outcome: "ready";
        readonly configuration: VerifiedReleaseFollowupConfiguration;
      }
    | { readonly outcome: "disabled" | "unavailable" }
  >;
}

export interface VerifiedReleaseFollowupEvaluation {
  readonly version: string;
  readonly artifactRef: string;
  readonly modelVersion: string;
  readonly promptVersion: string;
  readonly parserVersion: string;
  readonly verifiedAt: IsoTimestamp;
  readonly validUntil: IsoTimestamp;
}

export interface ReleaseFollowupEvaluationPort {
  /** Reviewed actual-model privacy, factual and release-applicability evaluation. */
  resolve(
    expectedVersion: string,
    signal: AbortSignal,
  ): Promise<
    | {
        readonly outcome: "ready";
        readonly evaluation: VerifiedReleaseFollowupEvaluation;
      }
    | { readonly outcome: "unavailable" }
  >;
}

/** This first argument alone is provider-visible. All text is untrusted data. */
export interface ReleaseFollowupModelInput {
  readonly trustedInstructions: string;
  readonly messages: readonly {
    readonly speaker: "customer" | "support" | "assistant" | "notification";
    readonly text: string;
  }[];
  /** Request-local references, never actual issue/deployment/KB identifiers. */
  readonly publicReleaseFacts: readonly {
    readonly ref: string;
    readonly text: string;
  }[];
}

/** Server-only. Never forward IDs, proof references or this context into content logs. */
export interface ReleaseFollowupAttemptContext {
  readonly purpose: "support_release_followup";
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
  readonly evaluationVersion: string;
  readonly checkPolicyVersion: string;
  readonly authorityVersion: string;
  readonly usageScopeRef: string;
  readonly usageReservationId: string;
  readonly deadline: IsoTimestamp;
  readonly signal: AbortSignal;
  readonly budgets: ReleaseFollowupBudgets;
}

export interface ReleaseFollowupModelResult {
  readonly outputJson: string;
  readonly provider: string;
  readonly model: string;
  readonly requestId: string;
  readonly usage: ReleaseFollowupModelUsage;
}

export interface ReleaseFollowupModelPort {
  generate(
    input: ReleaseFollowupModelInput,
    context: ReleaseFollowupAttemptContext,
    configuration: VerifiedReleaseFollowupConfiguration,
  ): Promise<ReleaseFollowupModelResult>;
}

export interface ReleaseFollowupUsageIdentity {
  readonly purpose: "support_release_followup";
  readonly operationId: string;
  readonly attemptId: string;
  readonly inputFingerprint: string;
  readonly usageReservationId: string;
}
export type ReleaseFollowupUsageObservation =
  | { readonly state: "not_called" | "unknown" }
  | { readonly state: "known"; readonly usage: ReleaseFollowupModelUsage };
export interface ReleaseFollowupUsagePort {
  reserve(
    context: ReleaseFollowupAttemptContext,
  ): Promise<
    | { readonly outcome: "reserved"; readonly usageReservationId: string }
    | { readonly outcome: "denied" | "unavailable" }
  >;
  reconcile(
    identity: ReleaseFollowupUsageIdentity,
    observation: ReleaseFollowupUsageObservation,
  ): Promise<"reconciled" | "pending">;
}

export interface ReleaseFollowupExternalContext {
  readonly purpose: "support_release_followup";
  readonly deadline: IsoTimestamp;
  readonly signal: AbortSignal;
}

export interface ReleaseFollowupTargetPort {
  /** Trusted explicit target selection, with no content-derived discovery or writes. */
  resolve(
    input: {
      readonly key: EngineeringFollowupKey;
      readonly context: EngineeringFollowupContext;
      readonly proofContext: EngineeringFollowupProofContext;
    },
    context: ReleaseFollowupExternalContext,
  ): Promise<
    | { readonly kind: "none" }
    | { readonly kind: "article"; readonly articleId: string }
    | { readonly kind: "unavailable" }
  >;
}

export interface ReleaseFollowupChecksPort
  extends EngineeringFollowupChecksPort, LearningCheckPolicyPort {
  /** Inspect the entire exact private handoff and customer body, independent of model claims. */
  check(
    input: {
      readonly candidate: EngineeringFollowupCandidate;
      readonly exactBundle: EngineeringFollowupBundle;
      readonly binding: EngineeringFollowupChecksBinding;
      readonly releaseProof: VerifiedEngineeringFollowupContext;
      readonly targetBaseline: DraftArticleDto | null;
      readonly validationRequirements: ValidationRequirementsDto | null;
    },
    context: ReleaseFollowupExternalContext,
  ): Promise<
    | { readonly outcome: "checked"; readonly receipt: string }
    | { readonly outcome: "held" | "restricted" | "unavailable" }
  >;
}

export interface SupportDeskReleaseFollowupOptions {
  readonly application: EngineeringFollowupApplication;
  readonly clock: Clock;
  /** Processing requires Process+Read+queueRead; body-free scans accept Process OR Review+queueRead. */
  readonly serviceAccess: ReleaseFollowupServiceAccessPort;
  /** The same actual current-facts verifier used by the base application. */
  readonly releaseEvidence: EngineeringFollowupReleaseEvidencePort;
  readonly configuration: ReleaseFollowupConfigurationPort;
  readonly evaluations: ReleaseFollowupEvaluationPort;
  readonly model: ReleaseFollowupModelPort;
  readonly usage: ReleaseFollowupUsagePort;
  readonly tokenCounter: ReleaseFollowupTokenCounter;
  readonly targets: ReleaseFollowupTargetPort;
  readonly checks: ReleaseFollowupChecksPort;
  /** Optional actual released SDK reads. No authoring or publication capability. */
  readonly knowledge?: Pick<
    KnowledgeBaseApplication,
    "getDraft" | "getValidationRequirements"
  >;
  readonly knowledgeAccess?: LearningKnowledgeAccessPort;
  readonly maxOperationMilliseconds?: number;
  readonly commitReserveMilliseconds?: number;
  readonly storageCommandAttempts?: number;
}

export type ReleaseFollowupProcessResult =
  | { readonly outcome: "not_claimed" }
  | {
      readonly outcome: "candidate" | "prepared" | "held" | "restricted";
      readonly result: EngineeringFollowupResult;
    }
  | {
      readonly outcome: "pending";
      readonly stage: "prepare" | "complete" | "bundle" | "finish";
      readonly reason?: string;
    };

export interface PrepareReleaseFollowupStaffReassessmentCommand
  extends EngineeringCommand, EngineeringFollowupKey {
  readonly expectedWorkGeneration: number;
  /** Omit to recheck retained content; explicit staff edits are checked in full. */
  readonly content?: EngineeringFollowupCandidate;
}

export interface SupportDeskReleaseFollowup {
  /** Body-free hints: engineeringFollowupProcess OR engineeringFollowupReview+queueRead. */
  scanCandidates(
    bounds: Parameters<
      EngineeringFollowupApplication["scanEngineeringFollowups"]
    >[1],
  ): ReturnType<EngineeringFollowupApplication["scanEngineeringFollowups"]>;
  /** Requires engineeringFollowupProcess+engineeringFollowupRead+queueRead before claiming or paid preparation. */
  processWork(
    command: Omit<ClaimEngineeringFollowupWorkCommand, "claimId">,
    options?: { readonly signal?: AbortSignal },
  ): Promise<ReleaseFollowupProcessResult>;
  /** New work requires Read+Review+queueRead; opaque accepted-intent recovery needs Review+queueRead only. */
  prepareStaffReassessment(
    access: AccessContext,
    command: PrepareReleaseFollowupStaffReassessmentCommand,
    options?: { readonly signal?: AbortSignal },
  ): Promise<EngineeringFollowupResult>;
  /** New posting requires Read+Review+queueRead+replyAny; exact historical ACK replay retains base posting grants. */
  approveAndPostWebUpdate(
    access: AccessContext,
    command: ApproveAndPostEngineeringFollowupWebUpdateCommand,
    options?: EngineeringFollowupWebUpdateOptions,
  ): ReturnType<
    EngineeringFollowupApplication["approveAndPostEngineeringFollowupWebUpdate"]
  >;
}
