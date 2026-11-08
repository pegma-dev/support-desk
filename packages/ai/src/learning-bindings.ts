import type {
  PrivateSourceReference,
  SourceSnapshot,
} from "@pegma/knowledge-base-application";
import type { ArticleRevision } from "@pegma/knowledge-base-contracts";
import type {
  ResolutionLearningSourceRecord,
  ResolutionLearningTarget,
  ResolutionSourceFence,
} from "@pegma/support-desk-application";
import {
  AssistantBoundaryError,
  count,
  exactKeys,
  fingerprint,
  scalar,
  snapshot,
} from "./boundary.js";

export const supportDeskLearningSourceSystem = "pegma.support-desk";

/** Read only the required metadata; never inspect an article or ticket body. */
function own(value: unknown, key: string): unknown {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  )
    throw new AssistantBoundaryError("invalid_data");
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (
    descriptor === undefined ||
    !("value" in descriptor) ||
    !descriptor.enumerable
  )
    throw new AssistantBoundaryError("invalid_data");
  return descriptor.value;
}

export function learningReferenceSnapshot(
  reference: PrivateSourceReference,
): PrivateSourceReference {
  const value = exactKeys(snapshot(reference), [
    "id",
    "system",
    "resourceId",
    "version",
  ]);
  return Object.freeze({
    id: scalar(value.id),
    system: scalar(value.system),
    resourceId: scalar(value.resourceId),
    version: scalar(value.version),
  });
}

export function learningReferencesSnapshot(
  references: readonly PrivateSourceReference[],
): readonly PrivateSourceReference[] {
  const copied = snapshot(references);
  if (!Array.isArray(copied)) throw new AssistantBoundaryError("invalid_data");
  count(copied.length, 32);
  const ids = new Set<string>();
  const result = copied.map((reference) => {
    const value = learningReferenceSnapshot(reference);
    if (ids.has(value.id)) throw new AssistantBoundaryError("invalid_data");
    ids.add(value.id);
    return value;
  });
  return Object.freeze(result);
}

/** Canonical object fields, original reference ordering, and no filtering. */
export async function learningOrderedReferencesHash(
  references: readonly PrivateSourceReference[],
): Promise<string> {
  return fingerprint(learningReferencesSnapshot(references));
}

/** Bind the actual immutable KB revision and its entire actual source snapshot. */
export async function learningTargetBinding(
  article: ArticleRevision,
  sourceSnapshot: SourceSnapshot,
): Promise<ResolutionLearningTarget> {
  const references = learningReferencesSnapshot(
    own(sourceSnapshot, "references") as readonly PrivateSourceReference[],
  );
  const target = {
    articleId: scalar(own(article, "articleId")),
    collectionId: scalar(own(article, "collectionId")),
    articleRevision: count(own(article, "number"), Number.MAX_SAFE_INTEGER, 1),
    contentHash: scalar(own(article, "contentHash")),
    sourceSnapshotGeneration: count(
      own(sourceSnapshot, "generation"),
      Number.MAX_SAFE_INTEGER,
    ),
    sourceSnapshotHash: scalar(own(sourceSnapshot, "hash")),
    orderedReferencesHash: await learningOrderedReferencesHash(references),
  };
  return Object.freeze(target);
}

/** A source ID is opaque metadata, never an authorization capability. */
export function learningSourceReference(
  source: ResolutionLearningSourceRecord,
): PrivateSourceReference {
  if (
    own(source, "kind") !== "resolution_learning_source" ||
    own(source, "id") !== "learning-source" ||
    own(source, "state") !== "eligible"
  )
    throw new AssistantBoundaryError("source_ineligible");
  const ticketId = scalar(own(source, "ticketId"));
  if (own(source, "partition") !== ticketId)
    throw new AssistantBoundaryError("invalid_data");
  count(own(source, "sourceGeneration"), Number.MAX_SAFE_INTEGER, 1);
  count(own(source, "resolutionCycle"), Number.MAX_SAFE_INTEGER, 1);
  return Object.freeze({
    id: scalar(own(source, "sourceId")),
    system: supportDeskLearningSourceSystem,
    resourceId: ticketId,
    version: scalar(own(source, "sourceBindingHash")),
  });
}

export function learningSourceFence(
  source: ResolutionLearningSourceRecord,
): ResolutionSourceFence {
  const reference = learningSourceReference(source);
  return Object.freeze({
    ticketId: reference.resourceId,
    sourceGeneration: count(
      own(source, "sourceGeneration"),
      Number.MAX_SAFE_INTEGER,
      1,
    ),
    resolutionCycle: count(
      own(source, "resolutionCycle"),
      Number.MAX_SAFE_INTEGER,
      1,
    ),
    sourceBindingHash: reference.version,
  });
}
