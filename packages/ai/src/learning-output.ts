import type {
  ResolutionLearningCandidate,
  ResolutionLearningProcessing,
} from "@pegma/support-desk-application";
import type {
  LearningInputManifest,
  LearningModelResult,
  LearningModelUsage,
  LearningTokenCounter,
  VerifiedLearningConfiguration,
} from "./learning-ports.js";
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

export function learningModelUsage(
  result: LearningModelResult,
): LearningModelUsage {
  const usage = snapshot(result.usage);
  exactKeys(usage, ["inputTokens", "outputTokens", "costMicros", "currency"]);
  count(usage.inputTokens, Number.MAX_SAFE_INTEGER);
  count(usage.outputTokens, Number.MAX_SAFE_INTEGER);
  count(usage.costMicros, Number.MAX_SAFE_INTEGER);
  scalar(usage.currency, 12);
  return usage;
}

/** Identity rejection must not erase independently valid billable usage. */
export function enforceLearningModelIdentity(
  result: LearningModelResult,
  config: VerifiedLearningConfiguration,
): void {
  if (result.provider !== config.provider || result.model !== config.model)
    throw new AssistantBoundaryError("provider_mismatch");
  scalar(result.provider);
  scalar(result.model);
}

/** Valid usage is settled even when the provider exceeded its allowed budget. */
export function enforceLearningUsageBudget(
  usage: LearningModelUsage,
  config: VerifiedLearningConfiguration,
): void {
  if (
    usage.inputTokens > config.budgets.maxInputTokens ||
    usage.outputTokens > config.budgets.maxOutputTokens ||
    usage.inputTokens + usage.outputTokens > config.budgets.maxContextTokens ||
    usage.costMicros > config.budgets.maxCostMicros ||
    usage.currency !== config.budgets.currency
  )
    throw new AssistantBoundaryError("budget_exceeded");
}

export function learningProcessingMetadata(
  result: LearningModelResult,
  usage: LearningModelUsage,
): ResolutionLearningProcessing {
  return snapshot({
    provider: scalar(result.provider),
    model: scalar(result.model),
    requestId: scalar(result.requestId),
    ...usage,
  });
}

/** Raw byte bound precedes JSON parsing and every structural/content check. */
export function learningCandidate(
  result: LearningModelResult,
  config: VerifiedLearningConfiguration,
  manifest: LearningInputManifest,
  counter: LearningTokenCounter,
  preparedCandidateBytes: number,
): ResolutionLearningCandidate {
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
  const data = exactKeys(parsed, [
    "problem",
    "applicability",
    "steps",
    "solution",
    "validationRequirements",
  ]);
  const applicability = exactKeys(data.applicability, [
    "productId",
    "version",
    "buildId",
  ]);
  for (const key of ["productId", "version", "buildId"] as const) {
    if (scalar(applicability[key]) !== manifest.product[key])
      throw new AssistantBoundaryError("applicability_mismatch");
  }
  const items = (value: unknown): readonly string[] => {
    if (!Array.isArray(value) || value.length === 0 || value.length > 16)
      throw new AssistantBoundaryError("malformed_output");
    return value.map((item) => text(item, 2_000));
  };
  const candidate: ResolutionLearningCandidate = snapshot({
    problem: text(data.problem, 4_000),
    applicability: {
      productId: manifest.product.productId,
      version: manifest.product.version,
      buildId: manifest.product.buildId,
    },
    steps: items(data.steps),
    solution: text(data.solution, 8_000),
    validationRequirements: items(data.validationRequirements),
  });
  const encoded = canonical(candidate);
  const candidateBytes = Math.max(encoded.length * 2, bytes(encoded));
  if (
    candidateBytes > config.budgets.maxCandidateBytes ||
    candidateBytes > count(preparedCandidateBytes, 16_000, 1)
  )
    throw new AssistantBoundaryError("candidate_limit");
  return candidate;
}
