import type { HandlingCommandResult } from "./index.js";
import type {
  AssistantTurnClaimFence,
  AssistantTurnFinishResult,
  AssistantTurnProcessingMetadata,
} from "./assistant-turn-types.js";
import {
  assistantTurnProcessingState,
  encodedBytes,
  withoutAssistantTurnLease,
  type AssistantTurnRecord,
} from "./assistant-turn-records.js";

// Each accepted UTF-16 code unit can occupy at most six JSON characters.
// Lone surrogates reach that bound and are allowed by the text validator.
const maximumText = "\ud800".repeat(200);
const maximumProcessing: AssistantTurnProcessingMetadata = Object.freeze({
  provider: maximumText,
  model: maximumText,
  requestId: maximumText,
  currency: maximumText,
  failureCategory: "\ud800".repeat(80),
  inputTokens: Number.MAX_SAFE_INTEGER,
  outputTokens: Number.MAX_SAFE_INTEGER,
  costMicros: Number.MAX_SAFE_INTEGER,
});
// Extended ISO years have the longest canonical Date.toISOString() shape.
const maximumTimestamp = "+100000-01-01T00:00:00.000Z";
const maximumFingerprint = "f".repeat(64);

/**
 * Reserve a constructive upper bound before a paid request can be prepared.
 * Earlier bindings and metadata remain verbatim. Only the current attempt's
 * accounting/metadata can change; a later preparation must reserve again.
 *
 * The old 8KB gap alone was insufficient: maximum legal processing metadata
 * is 10,898 encoded bytes and finish stores it twice. Count complete reply,
 * escalation, retry/supersession receipts and the largest replacement claim,
 * using the same processing builder and encoder as actual writes.
 */
export function maximumPostPreparationRecordBytes(
  job: AssistantTurnRecord,
): number {
  const base = withoutAssistantTurnLease(job);
  const processed = assistantTurnProcessingState(base, maximumProcessing, {
    attemptId: `${job.turnId}:${job.attempt}`,
    accounting: "not_called", // Longest supported accounting value.
  });
  const key = { ticketId: job.ticketId, turnId: job.turnId };
  const result: HandlingCommandResult = {
    ticketId: job.ticketId,
    revision: Number.MAX_SAFE_INTEGER,
    handlingGeneration: Number.MAX_SAFE_INTEGER,
  };
  const finishReceipt = (finishResult: AssistantTurnFinishResult) => ({
    fingerprint: maximumFingerprint,
    result: finishResult,
  });
  const retry: AssistantTurnRecord = {
    ...processed,
    status: "retry",
    nextAttemptAt: maximumTimestamp,
    lastFinish: finishReceipt({
      ...key,
      outcome: "retry_scheduled",
      nextAttemptAt: maximumTimestamp,
    }),
  };
  const superseded: AssistantTurnRecord = {
    ...processed,
    status: "superseded",
    lastFinish: finishReceipt({ ...key, outcome: "superseded" }),
  };
  const escalated: AssistantTurnRecord = {
    ...processed,
    status: "escalated",
    terminalResult: result,
    lastFinish: finishReceipt({ ...key, outcome: "escalated", result }),
  };
  const completed: AssistantTurnRecord = {
    ...assistantTurnProcessingState(base, maximumProcessing),
    status: "completed",
    terminalResult: { ...result, messageId: maximumText },
  };
  const directEscalation: AssistantTurnRecord = {
    ...assistantTurnProcessingState(base, maximumProcessing),
    status: "escalated",
    terminalResult: result,
  };
  // Retry/expired-lease recovery must still admit the next owner before that
  // owner's preparation can perform its own size reservation. In particular,
  // don't assume its workerId/claimId will be as short as the current owner's.
  const nextAttempt = Math.min(job.maxAttempts, job.attempt + 1);
  const attemptId = `${job.turnId}:${nextAttempt}`;
  const claim: AssistantTurnClaimFence = {
    ...key,
    workerId: maximumText,
    claimId: maximumText,
    claimGeneration: nextAttempt,
    attempt: nextAttempt,
    attemptId,
    commandId: `assistant-complete:${attemptId}`,
    correlationId: job.correlationId,
    expectedRevision: Number.MAX_SAFE_INTEGER,
    expectedHandlingGeneration: job.triggerHandlingGeneration,
    triggerMessageId: job.triggerMessageId,
  };
  const { nextAttemptAt: _retryAt, ...afterRetry } = retry;
  const replacement: AssistantTurnRecord = {
    ...afterRetry,
    status: "claimed",
    attempt: nextAttempt,
    claimGeneration: nextAttempt,
    claim,
    leaseUntil: maximumTimestamp,
  };
  return Math.max(
    ...[
      retry,
      superseded,
      escalated,
      completed,
      directEscalation,
      replacement,
    ].map(encodedBytes),
  );
}
