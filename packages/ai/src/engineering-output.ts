import type {
  EngineeringCandidate,
  EngineeringProcessing,
  EngineeringProductContext,
} from "@pegma/support-desk-application";
import type {
  EngineeringModelInput,
  EngineeringModelResult,
  EngineeringModelUsage,
  EngineeringTokenCounter,
  VerifiedEngineeringConfiguration,
} from "./engineering-ports.js";
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

/** Billable usage is observed before rejecting provider identity or output. */
export function engineeringUsage(
  result: EngineeringModelResult,
): EngineeringModelUsage {
  return learningModelUsage(result);
}

export function engineeringProcessing(
  result: EngineeringModelResult,
  usage: EngineeringModelUsage,
  config: VerifiedEngineeringConfiguration,
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

export function engineeringUsageBudget(
  usage: EngineeringModelUsage,
  config: VerifiedEngineeringConfiguration,
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

export function engineeringCandidate(
  result: EngineeringModelResult,
  config: VerifiedEngineeringConfiguration,
  input: EngineeringModelInput,
  product: EngineeringProductContext,
  counter: EngineeringTokenCounter,
  maximumBytes: number,
): EngineeringCandidate {
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
  const value = exactKeys(parsed, [
    "title",
    "summary",
    "expectedBehavior",
    "actualBehavior",
    "reproductionSteps",
    "applicability",
    "security",
    "routing",
  ]);
  const applicability = exactKeys(value.applicability, [
    "productId",
    "version",
    "buildId",
  ]);
  for (const key of ["productId", "version", "buildId"] as const)
    if (scalar(applicability[key]) !== product[key])
      throw new AssistantBoundaryError("applicability_mismatch");
  if (
    !Array.isArray(value.reproductionSteps) ||
    value.reproductionSteps.length === 0 ||
    value.reproductionSteps.length > 16
  )
    throw new AssistantBoundaryError("malformed_output");
  const routingValue = value.routing;
  if (
    typeof routingValue !== "object" ||
    routingValue === null ||
    Array.isArray(routingValue)
  )
    throw new AssistantBoundaryError("malformed_output");
  const outcome = (routingValue as Record<string, unknown>).outcome;
  if (!["selected", "ambiguous", "out_of_scope"].includes(outcome as string))
    throw new AssistantBoundaryError("malformed_output");
  const route = exactKeys(routingValue, [
    "outcome",
    "alternativeRepositoryIds",
    "rationale",
    ...(outcome === "selected" ? ["repositoryId"] : []),
  ]);
  if (
    !Array.isArray(route.alternativeRepositoryIds) ||
    route.alternativeRepositoryIds.length > 4
  )
    throw new AssistantBoundaryError("malformed_output");
  const alternatives = route.alternativeRepositoryIds.map((id) => scalar(id));
  const selected =
    outcome === "selected" ? scalar(route.repositoryId) : undefined;
  const allowed = new Set(
    input.repositories.map((repository) => repository.repositoryId),
  );
  const invalid =
    alternatives.some((id) => !allowed.has(id)) ||
    new Set(alternatives).size !== alternatives.length ||
    (selected !== undefined &&
      (!allowed.has(selected) || alternatives.includes(selected)));
  const rationale = text(route.rationale, 2_000);
  const candidate: EngineeringCandidate = snapshot({
    title: scalar(value.title, 200),
    summary: text(value.summary, 4_000),
    expectedBehavior: text(value.expectedBehavior, 2_000),
    actualBehavior: text(value.actualBehavior, 2_000),
    reproductionSteps: value.reproductionSteps.map((step) => text(step, 1_000)),
    applicability: {
      productId: product.productId,
      version: product.version,
      buildId: product.buildId,
    },
    security:
      value.security === "ordinary"
        ? "ordinary"
        : value.security === "restricted"
          ? "restricted"
          : "uncertain",
    routing: invalid
      ? {
          outcome: "out_of_scope",
          alternativeRepositoryIds: [],
          rationale:
            "Repository suggestions require authorized human selection.",
        }
      : selected === undefined
        ? {
            outcome: outcome as "ambiguous" | "out_of_scope",
            alternativeRepositoryIds: alternatives,
            rationale,
          }
        : {
            outcome: "selected",
            repositoryId: selected,
            alternativeRepositoryIds: alternatives,
            rationale,
          },
  });
  const serialized = canonical(candidate);
  if (
    Math.max(serialized.length * 2, bytes(serialized)) >
    Math.min(config.budgets.maxCandidateBytes, count(maximumBytes, 16_000, 1))
  )
    throw new AssistantBoundaryError("candidate_limit");
  return candidate;
}
