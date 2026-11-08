import type {
  AnswerSourcesResult,
  AnswerSourceReference,
} from "@pegma/knowledge-base-application";
import type { AssistantTurnClaim } from "@pegma/support-desk-application";
import type {
  AssistantCustomerAuthority,
  AssistantModelInput,
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
  timestamp,
} from "./boundary.js";

export function configurationSnapshot(
  raw: VerifiedAssistantConfiguration,
  now: number,
): VerifiedAssistantConfiguration {
  const config = snapshot(raw);
  for (const value of [
    config.version,
    config.promptVersion,
    config.modelVersion,
    config.provider,
    config.model,
    config.pricingRef,
  ])
    text(value);
  text(config.trustedInstructions, 16_384);
  count(config.framingTokens, 8_192);
  const budget = config.budgets;
  count(budget.maxMessages, 100, 1);
  count(budget.maxInputBytes, 262_144, 1);
  count(budget.maxInputTokens, 65_536, 1);
  count(budget.maxContextTokens, 131_072, 1);
  count(budget.maxOutputBytes, 64 * 1024, 1);
  count(budget.maxOutputTokens, 8_192, 1);
  count(budget.maxDurationMilliseconds, 20_000, 1);
  count(budget.maxCostMicros, Number.MAX_SAFE_INTEGER);
  text(budget.currency, 12);
  count(budget.maxAttempts, 10, 1);
  count(budget.maxAssistantTurns, 100, 1);
  const controls = config.dataControls;
  if (
    controls.status !== "verified" ||
    controls.configurationBinding !== config.version
  )
    throw new AssistantBoundaryError("configuration_unverified");
  for (const value of [
    controls.accountRef,
    controls.projectRef,
    controls.endpointRef,
    controls.modelRef,
    controls.featuresRef,
    controls.exceptionsRef,
  ])
    text(value);
  if (
    !Array.isArray(controls.intermediaryRefs) ||
    controls.intermediaryRefs.length > 16
  )
    throw new AssistantBoundaryError("configuration_unverified");
  controls.intermediaryRefs.forEach((ref) => text(ref));
  if (
    timestamp(controls.verifiedAt) > now ||
    timestamp(controls.validUntil) <= now
  )
    throw new AssistantBoundaryError("configuration_unverified");
  return config;
}

export function authoritySnapshot(
  raw: AssistantCustomerAuthority,
  principalId: string,
): AssistantCustomerAuthority {
  const authority = snapshot(raw);
  if (authority.access.principalId !== principalId)
    throw new AssistantBoundaryError("authority_unavailable");
  for (const value of [
    authority.audienceVersion,
    authority.policyVersion,
    authority.usageScopeRef,
    authority.access.policyVersion,
  ])
    text(value);
  for (const values of [
    authority.access.roles,
    authority.access.entitlements,
    authority.access.permissions,
  ]) {
    if (!Array.isArray(values) || values.length > 1_024)
      throw new AssistantBoundaryError("authority_unavailable");
    values.forEach((value) => text(value));
  }
  if (
    !Array.isArray(authority.collectionIds) ||
    authority.collectionIds.length === 0 ||
    authority.collectionIds.length > 4 ||
    new Set(authority.collectionIds).size !== authority.collectionIds.length
  )
    throw new AssistantBoundaryError("authority_unavailable");
  authority.collectionIds.forEach((value) => text(value));
  const applicability = authority.applicability;
  const keys = [
    "productId",
    "productVersion",
    ...(applicability.buildId === undefined ? [] : ["buildId"]),
    ...(applicability.locale === undefined ? [] : ["locale"]),
  ];
  exactKeys(applicability, keys);
  Object.values(applicability).forEach((value) => text(value));
  return snapshot({
    ...authority,
    access: {
      ...authority.access,
      roles: [...authority.access.roles].sort(),
      entitlements: [...authority.access.entitlements].sort(),
      permissions: [...authority.access.permissions].sort(),
    },
    collectionIds: [...authority.collectionIds].sort(),
  });
}

export function checkedReference(value: unknown): AnswerSourceReference {
  const ref = exactKeys(value, [
    "articleId",
    "collectionId",
    "collectionPolicyVersion",
    "articleRevision",
    "contentHash",
    "applicationGeneration",
    "governanceGeneration",
    "validationGeneration",
  ]);
  for (const key of ["articleId", "collectionId", "contentHash"])
    text(ref[key]);
  for (const key of [
    "collectionPolicyVersion",
    "articleRevision",
    "applicationGeneration",
    "governanceGeneration",
    "validationGeneration",
  ])
    count(ref[key], Number.MAX_SAFE_INTEGER, 1);
  return value as AnswerSourceReference;
}

export function sourceSnapshot(
  raw: AnswerSourcesResult,
  authority: AssistantCustomerAuthority,
  counter: AssistantTokenCounter,
): AnswerSourcesResult {
  const result = snapshot(raw);
  if (
    result.outcome !== "results" ||
    !Array.isArray(result.sources) ||
    result.sources.length === 0 ||
    result.sources.length > 5
  )
    throw new AssistantBoundaryError("no_guidance");
  if (
    typeof result.serializedSources !== "string" ||
    bytes(result.serializedSources) > 64 * 1024 ||
    result.serializedSources !== canonical(result.sources)
  )
    throw new AssistantBoundaryError("source_changed");
  count(result.sourceTokens, 8_192, 1);
  count(counter.count(result.serializedSources), 8_192, 1);
  const ids = new Set<string>();
  for (const source of result.sources) {
    checkedReference(source.reference);
    if (
      !authority.collectionIds.includes(source.reference.collectionId) ||
      ids.has(source.reference.articleId) ||
      canonical(source.applicability) !== canonical(authority.applicability)
    )
      throw new AssistantBoundaryError("source_changed");
    ids.add(source.reference.articleId);
    text(source.citation.label, 500);
  }
  return result;
}

export function retrievalQuery(claim: AssistantTurnClaim): string {
  const trigger = claim.conversation.messages.find(
    (message) => message.id === claim.fence.triggerMessageId,
  );
  if (trigger?.authorKind !== "customer" || trigger.visibility !== "customer")
    throw new AssistantBoundaryError("invalid_conversation");
  const terms =
    trigger.body
      .slice(0, 256)
      .match(/[\p{L}\p{N}]+/gu)
      ?.slice(0, 8) ?? [];
  if (terms.length === 0) throw new AssistantBoundaryError("no_guidance");
  return terms.join(" ").slice(0, 256);
}

export function modelInput(
  claim: AssistantTurnClaim,
  config: VerifiedAssistantConfiguration,
  sources: AnswerSourcesResult,
  counter: AssistantTokenCounter,
): AssistantModelInput {
  const visible = claim.conversation.messages;
  if (
    claim.conversation.ticket.channel !== "web" ||
    claim.conversation.handling.state !== "assistant" ||
    visible.length > config.budgets.maxMessages
  )
    throw new AssistantBoundaryError("invalid_conversation");
  const messages: AssistantModelInput["messages"][number][] = [];
  let assistantTurns = 0;
  for (const message of visible) {
    if (message.visibility !== "customer")
      throw new AssistantBoundaryError("invalid_conversation");
    if (message.authorKind === "system") continue;
    if (!["customer", "staff", "assistant"].includes(message.authorKind))
      throw new AssistantBoundaryError("invalid_conversation");
    if (message.authorKind === "assistant") assistantTurns += 1;
    messages.push({
      speaker: message.authorKind === "staff" ? "support" : message.authorKind,
      text: text(message.body, 20_000),
    });
  }
  if (assistantTurns >= config.budgets.maxAssistantTurns)
    throw new AssistantBoundaryError("turn_limit");
  const input = snapshot({
    trustedInstructions: config.trustedInstructions,
    messages,
    serializedSources: sources.serializedSources,
  });
  const serialized = canonical(input);
  if (bytes(serialized) > config.budgets.maxInputBytes)
    throw new AssistantBoundaryError("budget_exceeded");
  const tokens =
    count(counter.count(serialized), config.budgets.maxInputTokens, 1) +
    config.framingTokens;
  if (
    tokens > config.budgets.maxInputTokens ||
    tokens + config.budgets.maxOutputTokens > config.budgets.maxContextTokens
  )
    throw new AssistantBoundaryError("budget_exceeded");
  return input;
}
