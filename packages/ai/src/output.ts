import type {
  AnswerSourceReference,
  AnswerSourcesResult,
} from "@pegma/knowledge-base-application";
import type {
  AssistantEscalationReason,
  AssistantTurnProcessingMetadata,
} from "@pegma/support-desk-application";
import type {
  AssistantModelResult,
  AssistantModelUsage,
  AssistantTokenCounter,
  VerifiedAssistantConfiguration,
} from "./ports.js";
import {
  AssistantBoundaryError,
  bytes,
  canonical,
  count,
  exactKeys,
  snapshot,
  text,
} from "./boundary.js";
import { checkedReference } from "./request.js";

export const escalationReasons = [
  "no_guidance",
  "unsuccessful",
  "capacity",
  "provider_failure",
  "other",
] as const;

export type ValidatedDecision =
  | {
      readonly kind: "answer";
      readonly text: string;
      readonly citations: readonly AnswerSourceReference[];
    }
  | {
      readonly kind: "escalate";
      readonly reason: AssistantEscalationReason;
      readonly text: string;
    };

export function modelUsage(
  result: AssistantModelResult,
  config: VerifiedAssistantConfiguration,
): AssistantModelUsage {
  if (result.provider !== config.provider || result.model !== config.model)
    throw new AssistantBoundaryError("provider_mismatch");
  text(result.requestId);
  const usage = snapshot(result.usage);
  exactKeys(usage, ["inputTokens", "outputTokens", "costMicros", "currency"]);
  count(usage.inputTokens, config.budgets.maxInputTokens);
  count(usage.outputTokens, config.budgets.maxOutputTokens);
  if (usage.inputTokens + usage.outputTokens > config.budgets.maxContextTokens)
    throw new AssistantBoundaryError("budget_exceeded");
  count(usage.costMicros, config.budgets.maxCostMicros);
  if (usage.currency !== config.budgets.currency)
    throw new AssistantBoundaryError("budget_exceeded");
  return usage;
}

export function processingMetadata(
  result: AssistantModelResult,
  usage: AssistantModelUsage,
): AssistantTurnProcessingMetadata {
  return snapshot({
    provider: result.provider,
    model: result.model,
    requestId: result.requestId,
    ...usage,
  });
}

export function modelDecision(
  result: AssistantModelResult,
  config: VerifiedAssistantConfiguration,
  sources: AnswerSourcesResult,
  counter: AssistantTokenCounter,
): ValidatedDecision {
  if (
    typeof result.outputJson !== "string" ||
    result.outputJson.length > config.budgets.maxOutputBytes ||
    bytes(result.outputJson) > config.budgets.maxOutputBytes
  )
    throw new AssistantBoundaryError("oversized_output");
  count(counter.count(result.outputJson), config.budgets.maxOutputTokens, 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.outputJson) as unknown;
  } catch {
    throw new AssistantBoundaryError("malformed_output");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new AssistantBoundaryError("malformed_output");
  const kind = (parsed as Record<string, unknown>).kind;
  if (kind === "escalate") {
    const data = exactKeys(parsed, ["kind", "reason", "text"]);
    if (!escalationReasons.includes(data.reason as AssistantEscalationReason))
      throw new AssistantBoundaryError("malformed_output");
    return {
      kind,
      reason: data.reason as AssistantEscalationReason,
      text: text(data.text, 2_000),
    };
  }
  if (kind !== "answer") throw new AssistantBoundaryError("malformed_output");
  const data = exactKeys(parsed, ["kind", "text", "citations"]);
  if (
    !Array.isArray(data.citations) ||
    data.citations.length === 0 ||
    data.citations.length > sources.sources.length
  )
    throw new AssistantBoundaryError("invalid_citations");
  const citations = data.citations.map(checkedReference);
  const unique = new Set<string>();
  for (const reference of citations) {
    const binding = canonical(reference);
    if (
      unique.has(binding) ||
      !sources.sources.some((source) => canonical(source.reference) === binding)
    )
      throw new AssistantBoundaryError("invalid_citations");
    unique.add(binding);
  }
  return snapshot({ kind, text: text(data.text, 20_000), citations });
}

/** Labels only: a bot citation is not an inferred permission to browse an article. */
export function answerBody(
  decision: Extract<ValidatedDecision, { kind: "answer" }>,
  confirmed: AnswerSourcesResult,
): string {
  const labels = decision.citations.map((reference, index) => {
    const source = confirmed.sources.find(
      (candidate) => canonical(candidate.reference) === canonical(reference),
    );
    if (source === undefined)
      throw new AssistantBoundaryError("source_changed");
    return `${index + 1}. ${text(source.citation.label, 500).replace(/[\r\n]/gu, " ")}`;
  });
  return text(decision.text + "\n\nSources:\n" + labels.join("\n"), 20_000);
}
