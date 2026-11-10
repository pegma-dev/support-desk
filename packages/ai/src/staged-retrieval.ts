import type {
  AnswerSourceReference,
  AnswerSourcesResult,
} from "@pegma/knowledge-base-application";
import type {
  AssistantPreparedAttempt,
  AssistantTurnClaim,
} from "@pegma/support-desk-application";
import type {
  AssistantAttemptBudgets,
  AssistantCustomerAuthority,
  AssistantModelInput,
  VerifiedAssistantConfiguration,
} from "./ports.js";
import { AssistantBoundaryError, canonical, fingerprint } from "./boundary.js";
import { checkedReference } from "./request.js";

/** This versioned protocol never reserves usage or calls a model in its first stage. */
export const retrievalStageVersion = "support-answer-retrieval-1";
export const generationStageVersion = "support-answer-generation-1";

export function isRetrievalPreparation(
  prepared: AssistantPreparedAttempt,
): boolean {
  return prepared.binding.versions.supportAnswerStage === retrievalStageVersion;
}

/** Only the acknowledged first no-call stage can supply a second-stage request. */
export function stagedPreparation(
  claim: AssistantTurnClaim,
): AssistantPreparedAttempt | undefined {
  if (claim.fence.attempt === 1 && claim.preparedAttempts.length === 0)
    return undefined;
  const prepared = claim.preparedAttempts[0];
  if (
    claim.fence.attempt !== 2 ||
    claim.preparedAttempts.length !== 1 ||
    prepared === undefined ||
    prepared.attempt !== 1 ||
    prepared.accounting !== "not_called" ||
    prepared.processing !== undefined ||
    !isRetrievalPreparation(prepared)
  )
    throw new AssistantBoundaryError("retrieval_preparation_unavailable");
  // The application validates its durable attempt envelope before returning
  // a claim. Keep its identifier opaque; verification below binds the exact
  // returned identity through the predetermined no-call reservation.
  return prepared;
}

export function stagedReferences(
  prepared: AssistantPreparedAttempt,
): readonly AnswerSourceReference[] {
  if (
    prepared.binding.references.length === 0 ||
    prepared.binding.references.length > 5
  )
    throw new AssistantBoundaryError("retrieval_preparation_unavailable");
  const ids = new Set<string>();
  return prepared.binding.references.map((stored) => {
    const reference = checkedReference(JSON.parse(stored.binding));
    if (
      stored.namespace !== "pegma.knowledge-base" ||
      stored.resourceId !== reference.articleId ||
      stored.revision !== String(reference.articleRevision) ||
      stored.binding !== canonical(reference) ||
      ids.has(reference.articleId)
    )
      throw new AssistantBoundaryError("retrieval_preparation_unavailable");
    ids.add(reference.articleId);
    return reference;
  });
}

export async function verifyStagedPreparation(
  prepared: AssistantPreparedAttempt,
  claim: AssistantTurnClaim,
  logicalFingerprint: string,
  configuration: VerifiedAssistantConfiguration,
  authority: AssistantCustomerAuthority,
): Promise<void> {
  const expectedReservation =
    "retrieval:" +
    (
      await fingerprint({
        ticketId: claim.fence.ticketId,
        turnId: claim.fence.turnId,
        attemptId: prepared.attemptId,
      })
    ).slice(0, 48);
  if (
    prepared.inputFingerprint !== logicalFingerprint ||
    prepared.binding.inputFingerprint !== logicalFingerprint ||
    prepared.binding.contextBinding !== (await fingerprint(authority)) ||
    prepared.binding.usageReservationId !== expectedReservation ||
    canonical(prepared.binding.versions) !==
      canonical({
        configuration: configuration.version,
        prompt: configuration.promptVersion,
        model: configuration.modelVersion,
        audience: authority.audienceVersion,
        policy: authority.policyVersion,
        accessPolicy: authority.access.policyVersion,
        supportAnswerStage: retrievalStageVersion,
      })
  )
    throw new AssistantBoundaryError("retrieval_preparation_changed");
}

/**
 * Bind the entire logical request, excluding the physical owner, attempt,
 * lease, execution deadline and reservation that the next invocation replaces.
 * Only hashes and exact source references are persisted by the generic binding.
 * Renewed evidence timestamps and reissued opaque authority values intentionally
 * invalidate preparation even when their configuration versions are unchanged.
 */
export function stagedInputFingerprint(input: {
  readonly claim: AssistantTurnClaim;
  readonly modelInput: AssistantModelInput;
  readonly configuration: VerifiedAssistantConfiguration;
  readonly authority: AssistantCustomerAuthority;
  readonly sources: AnswerSourcesResult;
  readonly budgets: AssistantAttemptBudgets;
}): Promise<string> {
  const { claim, ...request } = input;
  const fence = claim.fence;
  return fingerprint({
    purpose: retrievalStageVersion,
    turn: {
      ticketId: fence.ticketId,
      turnId: fence.turnId,
      correlationId: fence.correlationId,
      triggerMessageId: fence.triggerMessageId,
      expectedRevision: fence.expectedRevision,
      expectedHandlingGeneration: fence.expectedHandlingGeneration,
      triggerRevision: claim.triggerRevision,
      requesterPrincipalId: claim.requesterPrincipalId,
    },
    conversation: claim.conversation,
    ...request,
  });
}
