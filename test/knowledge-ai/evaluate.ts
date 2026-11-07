import {
  countedArtifactKinds,
  type AcceptanceCase,
  type ExposureSink,
  type Observation,
  type SourceReference,
  type TurnIdentity,
} from "./types.js";

function references(values: readonly SourceReference[]): string {
  return JSON.stringify(
    [
      ...new Set(
        values.map((value) =>
          JSON.stringify([value.instanceId, value.articleId, value.revision]),
        ),
      ),
    ].sort(),
  );
}

function turnKey(value: TurnIdentity | undefined): string {
  return JSON.stringify(
    value === undefined
      ? null
      : [value.operationId, value.ticketId, value.revision, value.generation],
  );
}

/**
 * Evaluate captured artifacts against authored oracles. This does not execute
 * or implement KB authorization, publication, routing, or ticket workflow.
 * Canary matching detects exact literal markers in serialized traces only.
 * Encoded, fragmented, or paraphrased disclosures require separate semantic
 * privacy evaluation; a passing result is not a publication/privacy approval.
 */
export function evaluateObservation(
  scenario: AcceptanceCase,
  observation: Observation,
): readonly string[] {
  const failures = new Set<string>();
  if (observation.instanceId !== scenario.instanceId)
    failures.add("instance:observation");
  if (observation.outcome !== scenario.expected.outcome)
    failures.add("outcome");
  if (observation.modelRequests.length !== scenario.expected.modelCalls)
    failures.add("count:model");
  if (
    observation.modelRequests.some(
      (request) => request.instanceId !== scenario.instanceId,
    )
  )
    failures.add("instance:model");
  if (
    observation.artifacts.some(
      (artifact) => artifact.instanceId !== scenario.instanceId,
    )
  )
    failures.add("instance:artifact");

  for (const kind of countedArtifactKinds) {
    const expectedCount = scenario.expected.counts[kind];
    if (
      expectedCount !== undefined &&
      observation.artifacts.filter((artifact) => artifact.kind === kind)
        .length !== expectedCount
    ) {
      failures.add(`count:${kind}`);
    }
  }
  const artifactKeys = new Set<string>();
  for (const artifact of observation.artifacts) {
    const key = `${artifact.kind}:${artifact.id}`;
    if (artifactKeys.has(key)) failures.add(`duplicate:${key}`);
    artifactKeys.add(key);
  }

  const modelSources = observation.modelRequests.flatMap((request) =>
    request.sources.map((source) => source.reference),
  );
  const customerArtifacts = observation.artifacts.filter(
    (artifact) => artifact.kind === "message" || artifact.kind === "portal",
  );
  if (references(modelSources) !== references(scenario.expected.modelSources))
    failures.add("sources:model");
  for (const kind of ["portal", "message"] as const) {
    const actualSources = observation.artifacts
      .filter((artifact) => artifact.kind === kind)
      .flatMap((artifact) => artifact.sources ?? []);
    const expectedSources =
      kind === "portal"
        ? scenario.expected.portalSources
        : scenario.expected.messageSources;
    if (references(actualSources) !== references(expectedSources))
      failures.add(`sources:${kind}`);
  }

  if (scenario.expected.committedTurns !== undefined) {
    const messages = observation.artifacts.filter(
      (artifact) => artifact.kind === "message",
    );
    if (
      JSON.stringify(
        messages.map((artifact) => turnKey(artifact.committedTurn)).sort(),
      ) !== JSON.stringify(scenario.expected.committedTurns.map(turnKey).sort())
    )
      failures.add("turns:message");
    const requestedTurns = new Set(
      observation.modelRequests.map((request) =>
        turnKey({ operationId: request.operationId, ...request.trigger }),
      ),
    );
    if (
      messages.some(
        (artifact) => !requestedTurns.has(turnKey(artifact.committedTurn)),
      )
    )
      failures.add("turn:unrequested");
  }

  if (scenario.expected.repositoryTargets !== undefined) {
    const observedTargets = observation.artifacts
      .filter(
        (artifact) => artifact.kind === "draft" || artifact.kind === "issue",
      )
      .map((artifact) =>
        JSON.stringify([artifact.kind, artifact.repositoryId ?? null]),
      )
      .sort();
    const expectedTargets = scenario.expected.repositoryTargets
      .map((target) => JSON.stringify([target.kind, target.repositoryId]))
      .sort();
    if (JSON.stringify(observedTargets) !== JSON.stringify(expectedTargets))
      failures.add("repository:targets");
  }

  const exposed: Record<ExposureSink, string> = {
    model: JSON.stringify(observation.modelRequests),
    customer: JSON.stringify(customerArtifacts),
    publication: JSON.stringify(
      observation.artifacts.filter(
        (artifact) => artifact.kind === "publication",
      ),
    ),
    draft: JSON.stringify(
      observation.artifacts.filter((artifact) => artifact.kind === "draft"),
    ),
    issue: JSON.stringify(
      observation.artifacts.filter((artifact) => artifact.kind === "issue"),
    ),
    notification: JSON.stringify(
      observation.artifacts.filter(
        (artifact) => artifact.kind === "notification",
      ),
    ),
  };
  for (const rule of scenario.expected.forbidden) {
    for (const sink of rule.sinks) {
      if (rule.values.some((value) => exposed[sink].includes(value)))
        failures.add(`forbidden:${sink}`);
    }
  }
  return [...failures];
}
