import type {
  EngineeringFollowupCandidate,
  EngineeringProcessing,
} from "@pegma/support-desk-application";
import type {
  ReleaseFollowupModelResult,
  ReleaseFollowupModelUsage,
  ReleaseFollowupTokenCounter,
  VerifiedReleaseFollowupConfiguration,
} from "./release-followup-ports.js";
import {
  AssistantBoundaryError,
  bytes,
  canonical,
  count,
  exactKeys,
  scalar,
  snapshot,
  text,
} from "./boundary.js";
import { learningModelUsage } from "./learning-output.js";

/** Usage must become known before identity, syntax or content can reject a paid result. */
export function releaseFollowupUsage(
  result: ReleaseFollowupModelResult,
): ReleaseFollowupModelUsage {
  return learningModelUsage(result);
}

export function releaseFollowupProcessing(
  result: ReleaseFollowupModelResult,
  usage: ReleaseFollowupModelUsage,
  config: VerifiedReleaseFollowupConfiguration,
): EngineeringProcessing {
  if (result.provider !== config.provider || result.model !== config.model)
    throw new AssistantBoundaryError("provider_mismatch");
  return snapshot({
    provider: scalar(result.provider),
    model: scalar(result.model),
    requestId: scalar(result.requestId),
    ...usage,
  });
}

export function releaseFollowupUsageBudget(
  usage: ReleaseFollowupModelUsage,
  config: VerifiedReleaseFollowupConfiguration,
): void {
  const budgets = config.budgets;
  if (
    usage.inputTokens > budgets.maxInputTokens ||
    usage.outputTokens > budgets.maxOutputTokens ||
    usage.inputTokens + usage.outputTokens > budgets.maxContextTokens ||
    usage.costMicros > budgets.maxCostMicros ||
    usage.currency !== budgets.currency
  )
    throw new AssistantBoundaryError("budget_exceeded");
}

/** The same strict content boundary also validates explicit staff edits. */
export function releaseFollowupContent(
  raw: unknown,
  maximumBytes = 16_000,
): EngineeringFollowupCandidate {
  const value = exactKeys(raw, [
    "customerDraft",
    "kbProposal",
    "retestRequests",
  ]);
  const customer = exactKeys(value.customerDraft, ["body"]);
  let kbProposal: EngineeringFollowupCandidate["kbProposal"] = null;
  if (value.kbProposal !== null) {
    const proposal = exactKeys(value.kbProposal, [
      "summary",
      "changes",
      "advisoryValidationRequirements",
    ]);
    kbProposal = {
      summary: text(proposal.summary, 2_000),
      changes: strings(proposal.changes, 16, 1_000, 1),
      advisoryValidationRequirements: strings(
        proposal.advisoryValidationRequirements,
        16,
        1_000,
      ),
    };
  }
  if (!Array.isArray(value.retestRequests) || value.retestRequests.length > 4)
    throw new AssistantBoundaryError("malformed_output");
  const candidate: EngineeringFollowupCandidate = snapshot({
    customerDraft: { body: text(customer.body, 4_000) },
    kbProposal,
    retestRequests: value.retestRequests.map((rawRequest) => {
      const request = exactKeys(rawRequest, ["steps", "expectedBehavior"]);
      return {
        steps: strings(request.steps, 16, 1_000, 1),
        expectedBehavior: text(request.expectedBehavior, 2_000),
      };
    }),
  });
  const serialized = canonical(candidate);
  if (
    Math.max(serialized.length * 2, bytes(serialized)) >
    count(maximumBytes, 16_000, 1)
  )
    throw new AssistantBoundaryError("candidate_limit");
  return candidate;
}

function strings(
  raw: unknown,
  maximum: number,
  characters: number,
  minimum = 0,
): readonly string[] {
  if (!Array.isArray(raw) || raw.length < minimum || raw.length > maximum)
    throw new AssistantBoundaryError("malformed_output");
  return raw.map((entry) => text(entry, characters));
}

export function releaseFollowupCandidate(
  result: ReleaseFollowupModelResult,
  config: VerifiedReleaseFollowupConfiguration,
  counter: ReleaseFollowupTokenCounter,
  maximumBytes: number,
): EngineeringFollowupCandidate {
  if (
    typeof result.outputJson !== "string" ||
    result.outputJson.length > config.budgets.maxOutputBytes ||
    bytes(result.outputJson) > config.budgets.maxOutputBytes
  )
    throw new AssistantBoundaryError("oversized_output");
  count(counter.count(result.outputJson), config.budgets.maxOutputTokens, 1);
  let raw: unknown;
  try {
    raw = JSON.parse(result.outputJson) as unknown;
  } catch {
    throw new AssistantBoundaryError("malformed_output");
  }
  return releaseFollowupContent(
    raw,
    Math.min(maximumBytes, config.budgets.maxCandidateBytes),
  );
}
