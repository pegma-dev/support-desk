import type { AccessContext } from "@pegma/authorization-core";
import type {
  CreateDraftInput,
  DraftArticleDto,
  KnowledgeBaseApplication,
  PrivateSourcesVerifier,
  PublishedArticleDto,
} from "@pegma/knowledge-base-application";
import type { Clock, IsoTimestamp } from "@pegma/spine";
import type {
  ClaimResolutionLearningWorkCommand,
  ResolutionLearningApplication,
  ResolutionLearningCandidate,
  ResolutionLearningCommitGuard,
  ResolutionLearningKey,
  ResolutionLearningReviewReceipt,
  ResolutionLearningTarget,
  ResolutionLearningReconciliationView,
  ResolutionLearningSourceResult,
  ResolutionLearningStepResult,
  ResolutionSourceFence,
  ReviewResolutionLearningProposalCommand,
} from "@pegma/support-desk-application";
import type {
  LearningCheckPolicyPort,
  LearningChecksPort,
  LearningInputManifest,
  LearningModelExecutorOptions,
  LearningModelProcessResult,
  LearningServiceAccessPort,
  VerifiedLearningCheckPolicy,
} from "./learning-ports.js";
export type {
  LearningComparisonSelection,
  LearningPublishedSearchObservations,
  LearningPublishedSearchScopeState,
} from "./learning-comparison.js";

/** Use the released direct authoring contract, without a copied draft schema. */
export type LearningArticleDraft = CreateDraftInput["draft"];

export type LearningTargetProduct = LearningInputManifest["product"];

export interface LearningTargetScope {
  readonly version: string;
  readonly collectionId: string;
  readonly kind: LearningArticleDraft["kind"];
  /** Trusted configured query; never derive discovery text from private candidates. */
  readonly searchQuery: string;
  /** Explicitly authorized IDs only; no draft catalog or discovery operation exists. */
  readonly explicitDraftIds: readonly string[];
}

export interface LearningTargetScopeContext {
  readonly deadline: IsoTimestamp;
  readonly signal: AbortSignal;
}

/** Server-only identity; never serialize this context into model content or logs. */
export interface LearningTargetContext extends LearningTargetScopeContext {
  readonly sourceFence: ResolutionSourceFence;
}

/** These bounded observations are server data, not a provider prompt envelope. */
export interface LearningTargetSelectionInput {
  readonly candidate: ResolutionLearningCandidate;
  readonly scope: LearningTargetScope;
  /** Stable create identity supplied by the coordinator for this source generation. */
  readonly newArticleId: string;
  /** Fresh approved content from this scope's bounded published search only. */
  readonly publishedMatches: readonly PublishedArticleDto[];
  /** Current reads of the scope's explicitly authorized draft IDs only. */
  readonly explicitDrafts: readonly DraftArticleDto[];
}

export type LearningTargetSelection =
  | {
      readonly outcome: "selected";
      readonly operation: "create" | "update";
      readonly articleId: string;
      /** Updates must merge relevant existing guidance, or return held. */
      readonly draft: LearningArticleDraft;
    }
  | { readonly outcome: "held" | "unavailable"; readonly reason?: string };

export interface LearningTargetPort {
  /** Only trusted product facts may influence discovery scope and search text. */
  resolveScope(
    product: LearningTargetProduct,
    context: LearningTargetScopeContext,
  ): Promise<
    | { readonly outcome: "ready"; readonly scope: LearningTargetScope }
    | { readonly outcome: "held" | "unavailable"; readonly reason?: string }
  >;
  /**
   * Bounded search is not exhaustive duplicate detection. Hold uncertainty, and
   * never silently replace a newer unpublished draft absent from explicitDrafts.
   * Keep identities and private metadata outside any provider-visible payload.
   */
  select(
    input: LearningTargetSelectionInput,
    context: LearningTargetContext,
  ): Promise<LearningTargetSelection>;
}

export interface LearningKnowledgeAuthority {
  readonly access: AccessContext;
  readonly authorityVersion: string;
}

export interface LearningKnowledgeAccessPort {
  /** Resolve current host-owned authority; this port grants no permissions itself. */
  resolve(signal: AbortSignal): Promise<
    | {
        readonly outcome: "ready";
        readonly authority: LearningKnowledgeAuthority;
      }
    | { readonly outcome: "inactive" | "unavailable" }
  >;
}

/** There is deliberately no publication, review-submission, or Store capability. */
export type LearningKnowledgeApplication = Pick<
  KnowledgeBaseApplication,
  | "searchPublishedArticles"
  | "getPublishedArticle"
  | "getDraft"
  | "getProvenance"
  | "getValidationRequirements"
  | "createDraft"
  | "updateDraft"
  | "retireArticle"
>;

export interface SupportDeskLearningOptions extends Omit<
  LearningModelExecutorOptions,
  "application" | "checkPolicy"
> {
  readonly application: ResolutionLearningApplication;
  readonly knowledge: LearningKnowledgeApplication;
  /**
   * The same verifier wired into KB privateSources. Current and published
   * provenance must be readable; stale published eligibility must not prevent
   * correcting a draft. Never fabricate filtered snapshots or old revisions.
   */
  readonly sources: PrivateSourcesVerifier;
  /** Opt in only for the real SDK's read-only application/source graph. Custom ports remain serial. */
  readonly readScheduling?: "sdk";
  /** Return after each durable delivery checkpoint; resume in a new invocation. */
  readonly deliveryMode?: "staged";
  /** Current draft/provenance/search and source-read authority; no publish needed. */
  readonly knowledgeAccess: LearningKnowledgeAccessPort;
  /** Separate narrow current retirement/provenance authority; no publish needed. */
  readonly retirementAccess: LearningKnowledgeAccessPort;
  readonly targets: LearningTargetPort;
  readonly checks: LearningChecksPort;
  /** Bounded approved results; default and hard ceiling are five. */
  readonly maxPublishedMatches?: number;
  /** Bounded explicit draft reads; default and hard ceiling are five. */
  readonly maxExplicitDrafts?: number;
}

export type LearningScanBounds = Parameters<
  ResolutionLearningApplication["scanResolutionLearningCandidates"]
>[1];
export type LearningScanResult = Awaited<
  ReturnType<ResolutionLearningApplication["scanResolutionLearningCandidates"]>
>;

/** Callers cannot reuse an external claim ID across physical invocations. */
export type ProcessLearningWorkCommand = Omit<
  ClaimResolutionLearningWorkCommand,
  "claimId"
>;

export interface LearningRunOptions {
  readonly signal?: AbortSignal;
}

/** Immutable reviewed coordinates, not an approval or a reusable authority grant. */
export interface LearningReviewIntent {
  readonly reviewerId: string;
  readonly ticketId: string;
  readonly sourceGeneration: number;
  readonly expectedWorkGeneration: number;
  readonly target: ResolutionLearningTarget;
  readonly policy: VerifiedLearningCheckPolicy;
}
export interface LearningReviewPreparation {
  readonly intent: LearningReviewIntent;
  readonly draft: DraftArticleDto;
}
export interface LearningReviewCommand {
  readonly intent: LearningReviewIntent;
  readonly commandId: string;
  readonly correlationId: string;
  readonly decision: "approve" | "reject";
  readonly reason?: string;
}
export interface LearningReviewCancellationOptions extends LearningRunOptions {
  /** Trusted read-only current human authority; cancellation needs no old KB proof. */
  readonly verifyBeforeCommit: ResolutionLearningCommitGuard;
}

export type LearningProcessResult =
  | LearningModelProcessResult
  | { readonly outcome: "not_claimed" }
  | {
      readonly outcome: "delivered";
      readonly result: ResolutionLearningStepResult;
    }
  | {
      readonly outcome: "held";
      readonly reason: string;
      readonly result?: ResolutionLearningStepResult;
    }
  | {
      readonly outcome: "pending";
      readonly stage: "delivery";
      /** Durable App progress and claim release; not a custom check port's billing receipt. */
      readonly checkpoint?: "prepared" | "acknowledged";
    };

export interface LearningReconciliationResult {
  readonly outcome: "reconciled" | "pending" | "blocked";
  readonly processedDestinations: number;
  readonly result?: ResolutionLearningReconciliationView;
  readonly reason?: string;
}

export interface SupportDeskLearning {
  scanCandidates(bounds: LearningScanBounds): Promise<LearningScanResult>;
  /** Fresh crypto UUID claim; one model or KB-delivery stage per invocation. */
  processWork(
    command: ProcessLearningWorkCommand,
    options?: LearningRunOptions,
  ): Promise<LearningProcessResult>;
  /**
   * Confirm the actual KB target and record Support's exact staff approval only.
   * The host separately uses KB's existing submit/review/publish operations.
   */
  reviewProposal(
    access: AccessContext,
    command: ReviewResolutionLearningProposalCommand,
    options?: LearningRunOptions,
  ): Promise<ResolutionLearningSourceResult>;
  /** Read-only preparation; retain the entire intent before any review submission. */
  prepareReviewIntent(
    access: AccessContext,
    key: ResolutionLearningKey,
    options?: LearningRunOptions,
  ): Promise<LearningReviewPreparation>;
  /** Exact receipt recovery precedes current checks; new approvals recheck all proofs. */
  submitReviewIntent(
    access: AccessContext,
    command: LearningReviewCommand,
    options?: LearningRunOptions,
  ): Promise<ResolutionLearningSourceResult>;
  /** Null never establishes that an older in-flight call cannot still commit. */
  readReviewReceipt(
    access: AccessContext,
    command: LearningReviewCommand,
    options?: LearningRunOptions,
  ): Promise<ResolutionLearningReviewReceipt | null>;
  /** Explicitly settle the original intent; never cancel an accepted review. */
  cancelReview(
    access: AccessContext,
    command: LearningReviewCommand,
    options: LearningReviewCancellationOptions,
  ): Promise<ResolutionLearningReviewReceipt>;
  /**
   * Durable destinations drive conditional retirement and authoritative proofs.
   * Equal KB observations reuse the same command; newer generations fence old
   * calls. Unknown creates never clear from absence or age; no exactly-once claim.
   */
  reconcileSource(
    ticketId: string,
    options?: LearningRunOptions,
  ): Promise<LearningReconciliationResult>;
}

export interface SupportDeskLearningSourceVerifierOptions {
  /** Real SDK independent contributor reads only; publication checks remain serial. */
  readonly readScheduling?: "sdk";
  /** No KB reads: callbacks must not recursively enter publication or retrieval. */
  readonly application: Pick<
    ResolutionLearningApplication,
    | "readResolutionLearningSource"
    | "confirmResolutionLearningSource"
    | "confirmResolutionLearningTargetReview"
    | "readResolutionLearningReconciliation"
  >;
  readonly serviceAccess: LearningServiceAccessPort;
  /** Current review policy must remain independent of model generation switches. */
  readonly reviewPolicy: LearningCheckPolicyPort;
  /** Unknown namespaces fail closed unless this verifier receives full context. */
  readonly otherSources?: PrivateSourcesVerifier;
  readonly clock: Clock;
  readonly maxOperationMilliseconds?: number;
}

/** Factory result uses KB's actual public callback signatures without widening them. */
export type SupportDeskLearningSourceVerifier = PrivateSourcesVerifier;
