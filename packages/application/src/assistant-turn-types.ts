import type { AccessContext } from "@pegma/authorization-core";
import type { IsoTimestamp, PrincipalId } from "@pegma/spine";
import type { MessageId, TicketId } from "@pegma/support-desk-contracts";
import type {
  AssistantConversationView,
  AssistantEscalationReason,
  AssistantTurnFence,
  HandlingCommandResult,
} from "./index.js";

export interface AssistantTurnKey {
  readonly ticketId: TicketId;
  readonly turnId: string;
}

export interface AssistantTurnClaimFence
  extends AssistantTurnKey, AssistantTurnFence {
  readonly workerId: string;
  readonly claimId: string;
  readonly claimGeneration: number;
  readonly attempt: number;
  readonly attemptId: string;
}

/** Generic immutable request identity. Never contains prompts or conversation text. */
export interface AssistantAttemptBinding {
  readonly inputFingerprint: string;
  readonly versions: Readonly<Record<string, string>>;
  readonly references: readonly {
    readonly namespace: string;
    readonly resourceId: string;
    readonly revision: string;
    readonly binding: string;
  }[];
  readonly contextBinding: string;
  readonly deadline: IsoTimestamp;
  readonly usageReservationId: string;
}

export type AssistantTurnAccounting = "not_called" | "accounted" | "unknown";

export interface AssistantTurnProcessingMetadata {
  readonly provider?: string;
  readonly model?: string;
  readonly requestId?: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly costMicros?: number;
  readonly currency?: string;
  readonly failureCategory?: string;
}

export interface AssistantPreparedAttempt {
  readonly attempt: number;
  readonly attemptId: string;
  readonly inputFingerprint: string;
  readonly binding: AssistantAttemptBinding;
  /** Preparation alone cannot establish whether a provider call occurred. */
  readonly accounting: AssistantTurnAccounting;
  readonly processing?: AssistantTurnProcessingMetadata;
}

export interface AssistantTurnClaim {
  readonly fence: AssistantTurnClaimFence;
  readonly triggerRevision: number;
  readonly leaseUntil: IsoTimestamp;
  readonly turnDeadline: IsoTimestamp;
  /** Service-only identity for independently resolving current customer authority. */
  readonly requesterPrincipalId: PrincipalId;
  readonly conversation: AssistantConversationView;
  readonly preparedAttempts: readonly AssistantPreparedAttempt[];
}

export interface AssistantTurnOptions {
  readonly maxAttempts?: number;
  readonly maxTurnMilliseconds?: number;
  readonly maxLeaseMilliseconds?: number;
}

export interface AssistantTurnScanBounds {
  readonly cursor?: string;
  /** Physical adapter rows, including all rows discarded by filtering. */
  readonly limit: number;
}

export interface AssistantTurnScanResult {
  readonly candidates: readonly AssistantTurnKey[];
  readonly nextCursor: string | null;
  readonly physicalRows: number;
  readonly pages: 1;
}

export interface ClaimAssistantTurnCommand extends AssistantTurnKey {
  readonly workerId: string;
  readonly claimId: string;
  readonly leaseMilliseconds: number;
}

export interface PrepareAssistantTurnAttemptCommand extends AssistantTurnClaimFence {
  readonly binding: AssistantAttemptBinding;
}

export interface PreparedAssistantTurnAttempt {
  readonly attemptId: string;
  readonly inputFingerprint: string;
  readonly binding: AssistantAttemptBinding;
}

export type AssistantTurnOutcome =
  | {
      readonly kind: "answer";
      readonly messageId: MessageId;
      readonly body: string;
    }
  | {
      readonly kind: "escalate";
      readonly reason?: AssistantEscalationReason;
      readonly summary?: string;
      readonly attemptedGuideIds?: readonly string[];
    };

export interface CompleteAssistantTurnCommand extends AssistantTurnClaimFence {
  readonly inputFingerprint: string;
  readonly outcome: AssistantTurnOutcome;
  readonly processing?: AssistantTurnProcessingMetadata;
}

export interface FinishAssistantTurnAttemptCommand extends AssistantTurnClaimFence {
  readonly disposition: "retry" | "superseded" | "escalate";
  readonly accounting: AssistantTurnAccounting;
  readonly retryAt?: IsoTimestamp;
  readonly reason?: AssistantEscalationReason;
  readonly summary?: string;
  readonly processing?: AssistantTurnProcessingMetadata;
}

export type AssistantTurnFinishResult = AssistantTurnKey &
  (
    | {
        readonly outcome: "retry_scheduled";
        readonly nextAttemptAt: IsoTimestamp;
      }
    | { readonly outcome: "superseded" }
    | { readonly outcome: "escalated"; readonly result: HandlingCommandResult }
    | {
        readonly outcome: "already_terminal";
        readonly result?: HandlingCommandResult;
      }
  );

/** Read-only authority/source validation. Throwing prevents the transaction. */
export type AssistantTurnCommitGuard = () => void | Promise<void>;

export interface AssistantTurnApplication {
  scanAssistantTurnCandidates(
    access: AccessContext,
    bounds: AssistantTurnScanBounds,
  ): Promise<AssistantTurnScanResult>;
  claimAssistantTurn(
    access: AccessContext,
    command: ClaimAssistantTurnCommand,
  ): Promise<AssistantTurnClaim | null>;
  prepareAssistantTurnAttempt(
    access: AccessContext,
    command: PrepareAssistantTurnAttemptCommand,
  ): Promise<PreparedAssistantTurnAttempt>;
  completeAssistantTurn(
    access: AccessContext,
    command: CompleteAssistantTurnCommand,
    verifyBeforeCommit: AssistantTurnCommitGuard,
  ): Promise<HandlingCommandResult>;
  finishAssistantTurnAttempt(
    access: AccessContext,
    command: FinishAssistantTurnAttemptCommand,
  ): Promise<AssistantTurnFinishResult>;
}
