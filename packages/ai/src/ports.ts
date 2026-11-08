import type { AccessContext } from "@pegma/authorization-core";
import type {
  AnswerSourceReference,
  KnowledgeRetrievalApplication,
} from "@pegma/knowledge-base-application";
import type { Applicability } from "@pegma/knowledge-base-contracts";
import type { Clock, IsoTimestamp, PrincipalId } from "@pegma/spine";
import type {
  AssistantEscalationReason,
  AssistantTurnApplication,
  AssistantTurnClaimFence,
  AssistantTurnFinishResult,
  AssistantTurnScanBounds,
  AssistantTurnScanResult,
  ClaimAssistantTurnCommand,
  HandlingCommandResult,
} from "@pegma/support-desk-application";

export interface AssistantBudgets {
  readonly maxMessages: number;
  readonly maxInputBytes: number;
  readonly maxInputTokens: number;
  readonly maxContextTokens: number;
  readonly maxOutputBytes: number;
  readonly maxOutputTokens: number;
  readonly maxDurationMilliseconds: number;
  readonly maxCostMicros: number;
  readonly currency: string;
  readonly maxAttempts: number;
  readonly maxAssistantTurns: number;
}

/** Effective per-attempt limits, including the application's rendered message cap. */
export interface AssistantAttemptBudgets extends AssistantBudgets {
  readonly maxMessageCharacters: number;
  readonly maxAnswerTextCharacters: number;
}

/** Host evidence, checked by the trusted resolver against its current route. */
export interface AssistantDataControls {
  readonly status: "verified";
  readonly configurationBinding: string;
  readonly accountRef: string;
  readonly projectRef: string;
  readonly endpointRef: string;
  readonly modelRef: string;
  readonly featuresRef: string;
  readonly exceptionsRef: string;
  /** An empty list explicitly means the verified path has no intermediaries. */
  readonly intermediaryRefs: readonly string[];
  readonly verifiedAt: IsoTimestamp;
  readonly validUntil: IsoTimestamp;
}

export interface VerifiedAssistantConfiguration {
  readonly version: string;
  readonly promptVersion: string;
  readonly modelVersion: string;
  readonly provider: string;
  readonly model: string;
  readonly pricingRef: string;
  readonly trustedInstructions: string;
  /** Trusted local allowance for the selected adapter's complete wire framing. */
  readonly framingTokens: number;
  readonly budgets: AssistantBudgets;
  readonly dataControls: AssistantDataControls;
}

/** Returning ready asserts current documented ZDR compatibility on every path. */
export interface AssistantConfigurationPort {
  resolve(expectedVersion?: string): Promise<
    | {
        readonly outcome: "ready";
        readonly configuration: VerifiedAssistantConfiguration;
      }
    | { readonly outcome: "disabled" | "unavailable" }
  >;
}

export interface AssistantCustomerAuthority {
  /** Current active principal and current permissions, never the assistant's audience. */
  readonly access: AccessContext;
  readonly audienceVersion: string;
  readonly policyVersion: string;
  readonly usageScopeRef: string;
  readonly collectionIds: readonly string[];
  readonly applicability: Applicability;
}

export interface AssistantCustomerAuthorityPort {
  /** The host rechecks active/current principal state on every invocation. */
  resolve(principalId: PrincipalId): Promise<
    | {
        readonly outcome: "ready";
        readonly authority: AssistantCustomerAuthority;
      }
    | { readonly outcome: "inactive" | "unavailable" }
  >;
}

/** This is the entire model-visible input. Treat messages and sources as data. */
export interface AssistantModelInput {
  readonly trustedInstructions: string;
  readonly messages: readonly {
    readonly speaker: "customer" | "assistant" | "support";
    readonly text: string;
  }[];
  readonly serializedSources: string;
}

/** Server context must never be serialized into a provider prompt or content log. */
export interface AssistantAttemptContext {
  readonly purpose: "support_answer";
  readonly operationId: string;
  readonly attemptId: string;
  readonly attempt: number;
  readonly fence: AssistantTurnClaimFence;
  readonly inputFingerprint: string;
  readonly configurationVersion: string;
  readonly promptVersion: string;
  readonly modelVersion: string;
  readonly audienceVersion: string;
  readonly policyVersion: string;
  readonly usageScopeRef: string;
  readonly usageReservationId: string;
  readonly applicability: Applicability;
  readonly allSourceReferences: readonly AnswerSourceReference[];
  readonly deadline: IsoTimestamp;
  readonly signal: AbortSignal;
  readonly budgets: AssistantAttemptBudgets;
}

export interface AssistantModelUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costMicros: number;
  readonly currency: string;
}

export interface AssistantModelResult {
  /** Bound UTF-8 bytes before parsing. No response is streamed to a customer. */
  readonly outputJson: string;
  readonly provider: string;
  readonly model: string;
  readonly requestId: string;
  readonly usage: AssistantModelUsage;
}

export interface AssistantModelPort {
  /** Called once per newly prepared attempt, outside all Store retry callbacks. */
  generate(
    input: AssistantModelInput,
    context: AssistantAttemptContext,
    configuration: VerifiedAssistantConfiguration,
  ): Promise<AssistantModelResult>;
}

export interface AssistantUsageIdentity {
  readonly operationId: string;
  readonly attemptId: string;
  readonly inputFingerprint: string;
  readonly usageReservationId: string;
}

export type AssistantUsageObservation =
  | { readonly state: "not_called" }
  | { readonly state: "unknown" }
  | { readonly state: "known"; readonly usage: AssistantModelUsage };

export interface AssistantUsagePort {
  /** Durable, idempotent and semantically bound to the supplied predetermined ID. */
  reserve(
    context: AssistantAttemptContext,
  ): Promise<
    | { readonly outcome: "reserved"; readonly usageReservationId: string }
    | { readonly outcome: "denied" | "unavailable" }
  >;
  /** Unknown usage remains conservatively reserved; duplicate calls are harmless. */
  reconcile(
    identity: AssistantUsageIdentity,
    observation: AssistantUsageObservation,
  ): Promise<"reconciled" | "pending">;
}

export interface AssistantTokenCounter {
  /** Trusted local tokenizer: no network, logging, or customer-content persistence. */
  count(text: string): number;
}

export interface AssistantEscalationPolicy {
  /** Trusted host policy may add topic/security triggers; customer text cannot set it. */
  evaluate(
    input: AssistantModelInput,
    context: AssistantAttemptContext,
  ): AssistantEscalationReason | null;
}

export interface SupportDeskAssistantOptions {
  readonly application: AssistantTurnApplication;
  readonly knowledge: Pick<
    KnowledgeRetrievalApplication,
    "retrieveAnswerSources" | "confirmAnswerSources"
  >;
  readonly serviceAccess: () => Promise<AccessContext>;
  readonly configuration: AssistantConfigurationPort;
  readonly customerAuthority: AssistantCustomerAuthorityPort;
  readonly usage: AssistantUsagePort;
  readonly model: AssistantModelPort;
  readonly tokenCounter: AssistantTokenCounter;
  readonly clock: Clock;
  readonly escalationPolicy?: AssistantEscalationPolicy;
  /** Actual application cap (default 20,000); pass a lower configured host limit. */
  readonly maxMessageCharacters?: number;
  /** Entire invocation ceiling; at most 25s, below the default 30s host lease. */
  readonly maxOperationMilliseconds?: number;
  /** Reserved after generation for final validation and atomic completion. */
  readonly commitReserveMilliseconds?: number;
  /** Identical storage command attempts, never provider attempts. At most three. */
  readonly storageCommandAttempts?: number;
}

export type AssistantProcessResult =
  | { readonly outcome: "not_claimed" }
  | { readonly outcome: "completed"; readonly result: HandlingCommandResult }
  | { readonly outcome: "finished"; readonly result: AssistantTurnFinishResult }
  | {
      readonly outcome: "pending";
      readonly stage: "prepare" | "complete" | "finish";
    };

/** Each physical invocation owns a fresh internal claim ID, never a caller replay ID. */
export type ProcessAssistantTurnCommand = Omit<
  ClaimAssistantTurnCommand,
  "claimId"
>;

export interface SupportDeskAssistant {
  scanCandidates(
    bounds: AssistantTurnScanBounds,
  ): Promise<AssistantTurnScanResult>;
  processTurn(
    command: ProcessAssistantTurnCommand,
    options?: { readonly signal?: AbortSignal },
  ): Promise<AssistantProcessResult>;
}
