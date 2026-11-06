import type { PrincipalId } from "@pegma/spine";

/** P-00 test-adapter vocabulary only. None of these are production APIs. */
export type InstanceId = "workshop" | "observatory";

export type ScenarioId =
  | "agent-authored-explanation"
  | "agent-tested-walkthrough"
  | "collection-audiences"
  | "exact-publication"
  | "ticket-backed-answer"
  | "human-request-and-takeover"
  | "unsupported-or-conflicting-guidance"
  | "learning"
  | "reopen-and-deletion"
  | "bug-validity"
  | "ai-routing"
  | "private-public-export"
  | "security-uncertainty"
  | "external-call-failures"
  | "released-fix"
  | "out-of-order-and-rollback"
  | "capacity-and-isolation"
  | "zdr-and-disclosure";

export const countedArtifactKinds = [
  "ticket",
  "message",
  "job",
  "portal",
  "publication",
  "draft",
  "held_draft",
  "issue",
  "notification",
  "retest",
] as const;
export type CountedArtifactKind = (typeof countedArtifactKinds)[number];
export type ArtifactKind = CountedArtifactKind | "private";

export interface SourceReference {
  readonly instanceId: InstanceId;
  readonly articleId: string;
  readonly revision: number;
}

export interface FixtureInstance {
  readonly id: InstanceId;
  readonly customerId: PrincipalId;
  readonly staffId: PrincipalId;
  readonly agentId: PrincipalId;
  readonly portalSource: SourceReference;
  readonly botSource: SourceReference;
  readonly staffSentinel: string;
  readonly provenanceSentinel: string;
  readonly customerSentinel: string;
  readonly privateLink: string;
  readonly publicSentinel: string;
  readonly repositories: Readonly<
    Record<
      "guides" | "product",
      {
        readonly id: string;
        readonly visibility: "public" | "private";
        readonly description: string;
      }
    >
  >;
}

export interface TurnIdentity {
  readonly operationId: string;
  readonly ticketId: string;
  readonly revision: number;
  readonly generation: number;
}

export interface RepositoryTarget {
  readonly kind: "draft" | "issue";
  readonly repositoryId: string;
}

export type FixtureValue =
  | null
  | string
  | number
  | boolean
  | readonly FixtureValue[]
  | { readonly [key: string]: FixtureValue };

export interface AcceptanceCase {
  readonly id: string;
  readonly instanceId: InstanceId;
  readonly scenario: ScenarioId;
  readonly ownerTasks: readonly string[];
  /** Scenario setup vocabulary, interpreted by a future real host adapter. */
  readonly input: Readonly<Record<string, FixtureValue>>;
  readonly steps: readonly string[];
  readonly expected: {
    readonly outcome: string;
    readonly modelCalls: number;
    readonly modelSources: readonly SourceReference[];
    readonly portalSources: readonly SourceReference[];
    readonly messageSources: readonly SourceReference[];
    readonly committedTurns?: readonly TurnIdentity[];
    readonly repositoryTargets?: readonly RepositoryTarget[];
    readonly counts: Readonly<Partial<Record<CountedArtifactKind, number>>>;
    readonly forbidden: readonly {
      readonly sinks: readonly ExposureSink[];
      readonly values: readonly string[];
    }[];
  };
}

export type ExposureSink =
  "model" | "customer" | "publication" | "draft" | "issue" | "notification";

/** Proposed model-port requirements recorded as a test-double request. */
export interface ModelRequest {
  readonly operationId: string;
  readonly instanceId: InstanceId;
  readonly purpose:
    "answer" | "learning" | "bug_assessment" | "routing" | "follow_up";
  readonly trigger: {
    readonly ticketId: string;
    readonly revision: number;
    readonly generation: number;
  };
  readonly promptVersion: string;
  readonly configurationVersion: string;
  readonly providerVerificationRef: string;
  readonly messages: readonly {
    readonly role: "customer" | "assistant" | "staff";
    readonly content: string;
  }[];
  readonly sources: readonly {
    readonly reference: SourceReference;
    readonly text: string;
  }[];
  readonly budget: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly deadlineMilliseconds: number;
  };
}

/** Model suggestions carry no permission to publish, send, or resolve. */
export interface ModelReply {
  readonly kind: "answer" | "escalate" | "draft" | "routing";
  readonly text: string;
  readonly citations: readonly SourceReference[];
  readonly model: string;
  readonly requestId: string;
  readonly usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
  };
  readonly routing?: {
    readonly repositoryId: string;
    readonly alternatives: readonly string[];
    readonly confidenceHint: number;
    readonly reason: string;
  };
}

export interface Artifact {
  readonly kind: ArtifactKind;
  readonly instanceId: InstanceId;
  readonly id: string;
  readonly text: string;
  readonly sources?: readonly SourceReference[];
  /** Captured from the committed job/message, never from model assertions. */
  readonly committedTurn?: TurnIdentity;
  /** Actual destination on a proposal/send, captured by trusted instrumentation. */
  readonly repositoryId?: string;
}

/** Logical artifacts captured from real adapters later, not service state. */
export interface Observation {
  instanceId: InstanceId;
  outcome: string;
  modelRequests: readonly ModelRequest[];
  artifacts: readonly Artifact[];
}
