import type { AccessContext } from "@pegma/authorization-core";
import type { Clock, IsoTimestamp } from "@pegma/spine";
import type {
  ResolutionLearningApplication,
  ResolutionLearningCandidate,
  ResolutionLearningChecksBinding,
  ResolutionLearningClaim,
  ResolutionLearningClaimFence,
  ResolutionLearningDeliveryRequest,
  ResolutionLearningModelBinding,
  ResolutionLearningStepResult,
  ResolutionSourceFence,
  VerifiedResolutionLearningChecks,
} from "@pegma/support-desk-application";

/** Learning has a separate route, budget and privacy acceptance from answering. */
export interface LearningBudgets {
  readonly maxMessages: number;
  readonly maxInputBytes: number;
  readonly maxInputTokens: number;
  readonly maxContextTokens: number;
  readonly maxOutputBytes: number;
  readonly maxOutputTokens: number;
  /** Conservative serialized UTF-16 JSON bytes, including escaping. */
  readonly maxCandidateBytes: number;
  readonly maxDurationMilliseconds: number;
  readonly maxCostMicros: number;
  readonly currency: string;
  readonly maxAttempts: number;
}

export interface LearningDataControls {
  readonly status: "verified";
  readonly purpose: "support_learning";
  readonly configurationBinding: string;
  readonly accountRef: string;
  readonly projectRef: string;
  readonly endpointRef: string;
  readonly modelRef: string;
  readonly featuresRef: string;
  readonly exceptionsRef: string;
  readonly intermediaryRefs: readonly string[];
  readonly verifiedAt: IsoTimestamp;
  readonly validUntil: IsoTimestamp;
}

export interface VerifiedLearningConfiguration {
  readonly purpose: "support_learning";
  readonly version: string;
  readonly promptVersion: string;
  readonly modelVersion: string;
  readonly provider: string;
  readonly model: string;
  readonly pricingRef: string;
  readonly trustedInstructions: string;
  readonly framingTokens: number;
  readonly budgets: LearningBudgets;
  readonly dataControls: LearningDataControls;
}

export interface LearningConfigurationPort {
  /** Ready asserts current documented ZDR compatibility for this purpose/path. */
  resolve(
    expectedVersion: string | undefined,
    signal: AbortSignal,
  ): Promise<
    | {
        readonly outcome: "ready";
        readonly configuration: VerifiedLearningConfiguration;
      }
    | { readonly outcome: "disabled" | "unavailable" }
  >;
}

export interface LearningServiceAuthority {
  readonly access: AccessContext;
  readonly authorityVersion: string;
  readonly usageScopeRef: string;
}

export interface LearningServiceAccessPort {
  /** Re-resolves the active service principal and current processing permission. */
  resolve(signal: AbortSignal): Promise<
    | {
        readonly outcome: "ready";
        readonly authority: LearningServiceAuthority;
      }
    | { readonly outcome: "inactive" | "unavailable" }
  >;
}

export interface VerifiedLearningCheckPolicy {
  readonly version: string;
  readonly binding: string;
  readonly verifiedAt: IsoTimestamp;
  readonly validUntil: IsoTimestamp;
}

export interface LearningCheckPolicyPort {
  resolvePolicy(
    expectedVersion: string | undefined,
    signal: AbortSignal,
  ): Promise<
    | {
        readonly outcome: "ready";
        readonly policy: VerifiedLearningCheckPolicy;
      }
    | { readonly outcome: "disabled" | "unavailable" }
  >;
}

/** This object alone is provider-visible. It contains no identity or proof IDs. */
export interface LearningModelInput {
  readonly trustedInstructions: string;
  readonly messages: readonly {
    /** Labels untrusted data; notification is never a provider system role. */
    readonly speaker: "customer" | "support" | "assistant" | "notification";
    readonly text: string;
  }[];
  readonly workingSolution: readonly string[];
}

/** Server-only context. Never serialize into provider content, tracing or logs. */
export interface LearningAttemptContext {
  readonly purpose: "support_learning";
  readonly invocationId: string;
  readonly operationId: string;
  readonly attemptId: string;
  readonly attempt: number;
  readonly fence: ResolutionLearningClaimFence;
  readonly sourceFence: ResolutionSourceFence;
  readonly inputFingerprint: string;
  readonly inputManifestHash: string;
  readonly configurationVersion: string;
  readonly promptVersion: string;
  readonly modelVersion: string;
  readonly checkPolicyVersion: string;
  readonly authorityVersion: string;
  readonly usageScopeRef: string;
  readonly usageReservationId: string;
  readonly deadline: IsoTimestamp;
  readonly signal: AbortSignal;
  readonly budgets: LearningBudgets;
}

export interface LearningModelUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costMicros: number;
  readonly currency: string;
}

export interface LearningModelResult {
  /** Adapters must bound raw UTF-8 bytes; the executor checks again before parse. */
  readonly outputJson: string;
  readonly provider: string;
  readonly model: string;
  readonly requestId: string;
  readonly usage: LearningModelUsage;
}

export interface LearningModelPort {
  /** One physical call per new durable preparation, outside storage retries. */
  generate(
    input: LearningModelInput,
    context: LearningAttemptContext,
    configuration: VerifiedLearningConfiguration,
  ): Promise<LearningModelResult>;
}

export interface LearningUsageIdentity {
  readonly purpose: "support_learning";
  readonly operationId: string;
  readonly attemptId: string;
  readonly inputFingerprint: string;
  readonly usageReservationId: string;
}

export type LearningUsageObservation =
  | { readonly state: "not_called" }
  | { readonly state: "unknown" }
  | { readonly state: "known"; readonly usage: LearningModelUsage };

export interface LearningUsagePort {
  /** Durable, idempotent reservation bound to the predetermined complete input. */
  reserve(
    context: LearningAttemptContext,
  ): Promise<
    | { readonly outcome: "reserved"; readonly usageReservationId: string }
    | { readonly outcome: "denied" | "unavailable" }
  >;
  /** Unknown usage stays conservatively reserved independently of KB delivery. */
  reconcile(
    identity: LearningUsageIdentity,
    observation: LearningUsageObservation,
  ): Promise<"reconciled" | "pending">;
}

export interface LearningTokenCounter {
  /** Trusted local tokenizer; no network, content persistence or content logging. */
  count(text: string): number;
}

export interface LearningCheckInput {
  readonly candidate: ResolutionLearningCandidate;
  /** Server-only exact outbound request; never forward source refs or IDs to a model. */
  readonly exactRequest: ResolutionLearningDeliveryRequest;
  readonly workingSolution: readonly string[];
  readonly targetComparison: {
    readonly operation: "create" | "update";
    readonly existingDraft?: string;
  };
  readonly binding: ResolutionLearningChecksBinding;
}

/** Independent automated checks; a model's own privacy assessment cannot pass. */
export interface LearningChecksPort extends LearningCheckPolicyPort {
  check(
    input: LearningCheckInput,
    context: {
      readonly purpose: "support_learning";
      readonly deadline: IsoTimestamp;
      readonly signal: AbortSignal;
    },
  ): Promise<
    | { readonly outcome: "checked"; readonly receipt: string }
    | { readonly outcome: "held" | "unavailable" }
  >;
  verify(
    receipt: string,
    binding: ResolutionLearningChecksBinding,
    signal?: AbortSignal,
  ): Promise<VerifiedResolutionLearningChecks | null>;
}

export interface LearningModelExecutorOptions {
  readonly application: Pick<
    ResolutionLearningApplication,
    | "prepareResolutionLearningStep"
    | "completeResolutionLearningStep"
    | "finishResolutionLearningWork"
    | "confirmResolutionLearningSource"
  >;
  readonly serviceAccess: LearningServiceAccessPort;
  readonly configuration: LearningConfigurationPort;
  readonly checkPolicy: LearningCheckPolicyPort;
  readonly model: LearningModelPort;
  readonly usage: LearningUsagePort;
  readonly tokenCounter: LearningTokenCounter;
  readonly clock: Clock;
  readonly maxOperationMilliseconds?: number;
  readonly commitReserveMilliseconds?: number;
  readonly storageCommandAttempts?: number;
}

export type LearningModelProcessResult =
  | {
      readonly outcome: "candidate";
      readonly result: ResolutionLearningStepResult;
    }
  | {
      readonly outcome: "finished";
      readonly result: ResolutionLearningStepResult;
    }
  | {
      readonly outcome: "pending";
      readonly stage: "prepare" | "complete" | "finish";
    };

export interface LearningModelExecutor {
  /** The caller owns scan/claim and must use a fresh cryptographic physical claim. */
  processClaim(
    claim: ResolutionLearningClaim,
    options?: { readonly signal?: AbortSignal },
  ): Promise<LearningModelProcessResult>;
}

/** Complete immutable request manifest is persisted by the base application. */
export type LearningInputManifest =
  ResolutionLearningModelBinding["inputManifest"];
