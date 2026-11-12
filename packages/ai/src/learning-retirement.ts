import { RepositoryConflictError } from "@pegma/knowledge-base-application";
import type {
  PrivateSourceReference,
  SourceSnapshot,
} from "@pegma/knowledge-base-application";
import type {
  RecordResolutionLearningReconciliationCommand,
  ResolutionLearningReconciliationView,
} from "@pegma/support-desk-application";
import {
  AssistantBoundaryError,
  canonical,
  count,
  fingerprint,
  scalar,
} from "./boundary.js";
import {
  learningReferencesSnapshot,
  learningSourceFence,
  learningSourceReference,
  supportDeskLearningSourceSystem,
} from "./learning-bindings.js";
import type {
  LearningKnowledgeAuthority,
  LearningReconciliationResult,
  SupportDeskLearning,
  SupportDeskLearningOptions,
} from "./learning-integration-types.js";
import {
  createLearningRuntime,
  learningKnowledgeAuthority,
} from "./learning-runtime.js";

type View = ResolutionLearningReconciliationView;
type Destination = View["destinations"][number];
type Identity = NonNullable<Destination["requestIdentity"]>;

interface KnowledgeObservation {
  readonly articleId: string;
  readonly generation: number;
  readonly state: "draft" | "in-review" | "published" | "retired";
  readonly hasPublication: boolean;
  readonly current: SourceSnapshot;
  readonly published: SourceSnapshot | null;
}

interface SourceFacts {
  readonly eligible: boolean;
  readonly reference: PrivateSourceReference | null;
}

interface Observation {
  readonly view: View;
  readonly destination: Destination;
  readonly identity: Identity;
  readonly knowledge: KnowledgeObservation;
  readonly facts: SourceFacts;
}

function sourceVersion(view: View): string {
  return canonical({
    ticketId: view.ticketId,
    generation: view.sourceGeneration,
    workGeneration: view.sourceWorkGeneration,
    state: view.state,
  });
}

function destinationKey(destination: Destination): string {
  return canonical({
    articleId: destination.articleId,
    sourceGeneration: destination.sourceGeneration,
    stepId: destination.stepId,
    requestHash: destination.requestHash,
  });
}

function findDestination(view: View, expected: Destination): Destination {
  const key = destinationKey(expected);
  const found = view.destinations.find((item) => destinationKey(item) === key);
  if (found === undefined)
    throw new AssistantBoundaryError("reconciliation_destination_changed");
  return found;
}

function requestIdentity(destination: Destination): Identity {
  const identity = destination.requestIdentity;
  if (destination.requestIdentityStatus !== "available" || identity === null)
    throw new AssistantBoundaryError("reconciliation_identity_unavailable");
  if (
    !["create", "update"].includes(identity.operation) ||
    scalar(identity.articleId) !== destination.articleId
  )
    throw new AssistantBoundaryError("reconciliation_identity_unavailable");
  scalar(identity.commandId);
  count(identity.originalExpectedGeneration, Number.MAX_SAFE_INTEGER);
  if (
    identity.operation === "create" &&
    identity.originalExpectedGeneration !== 0
  )
    throw new AssistantBoundaryError("reconciliation_identity_unavailable");
  return identity;
}

function sourceSnapshot(value: SourceSnapshot): SourceSnapshot {
  return Object.freeze({
    generation: count(value.generation, Number.MAX_SAFE_INTEGER),
    hash: scalar(value.hash),
    references: learningReferencesSnapshot(value.references),
  });
}

function referencesAffected(
  references: readonly PrivateSourceReference[],
  ticketId: string,
  facts: SourceFacts,
): boolean {
  return references.some(
    (reference) =>
      reference.system === supportDeskLearningSourceSystem &&
      reference.resourceId === ticketId &&
      (!facts.eligible ||
        facts.reference === null ||
        canonical(reference) !== canonical(facts.reference)),
  );
}

/**
 * The durable destination is the outbox. This worker has no Store, model,
 * publication, or processing-switch capability. Every write uses an observed
 * KB generation; an ambiguous original create/update is never reset by absence.
 */
export function createLearningReconciler(
  options: SupportDeskLearningOptions,
): SupportDeskLearning["reconcileSource"] {
  const application = options.application;
  const knowledge = options.knowledge;
  const attempts = count(options.storageCommandAttempts ?? 2, 3, 1);

  return async (
    ticketId,
    runOptions = {},
  ): Promise<LearningReconciliationResult> => {
    scalar(ticketId);
    const runtime = createLearningRuntime(options, runOptions);
    let processedDestinations = 0;
    let latest: View | undefined;
    let blocked = false;
    let reason: string | undefined;

    const authority = () =>
      learningKnowledgeAuthority(options.retirementAccess, runtime);
    const sameAuthority = async (expected: LearningKnowledgeAuthority) => {
      const current = await authority();
      if (canonical(current) !== canonical(expected))
        throw new AssistantBoundaryError("retirement_authority_changed");
      return current;
    };
    const readView = async (
      current: LearningKnowledgeAuthority,
    ): Promise<View> => {
      const view = await runtime.within(() =>
        application.readResolutionLearningReconciliation(
          current.access,
          ticketId,
        ),
      );
      if (view.ticketId !== ticketId)
        throw new AssistantBoundaryError("reconciliation_source_changed");
      count(view.sourceGeneration, Number.MAX_SAFE_INTEGER);
      count(view.sourceWorkGeneration, Number.MAX_SAFE_INTEGER, 1);
      count(view.destinations.length, 4);
      latest = view;
      return view;
    };
    const sourceFacts = async (
      view: View,
      current: LearningKnowledgeAuthority,
    ): Promise<SourceFacts> => {
      if (view.state !== "eligible") {
        if (!["held", "withdrawn", "unverified"].includes(view.state))
          throw new AssistantBoundaryError("reconciliation_source_changed");
        return { eligible: false, reference: null };
      }
      // An unavailable read is not evidence of revocation. A withdrawn source
      // uses the authoritative tombstone above and needs no deleted Ticket row.
      const source = await runtime.within(() =>
        application.readResolutionLearningSource(current.access, ticketId),
      );
      if (
        source.sourceGeneration !== view.sourceGeneration ||
        source.workGeneration !== view.sourceWorkGeneration ||
        source.state !== view.state
      )
        throw new AssistantBoundaryError("reconciliation_source_changed");
      const reference = learningSourceReference(source);
      const eligible = await runtime.within(() =>
        application.confirmResolutionLearningSource(
          current.access,
          learningSourceFence(source),
        ),
      );
      return { eligible, reference };
    };
    const observeKnowledge = async (
      articleId: string,
      current: LearningKnowledgeAuthority,
    ): Promise<KnowledgeObservation> => {
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        try {
          const draft = await runtime.within(() =>
            knowledge.getDraft(current.access, { articleId }),
          );
          const provenance = await runtime.within(() =>
            knowledge.getProvenance(current.access, { articleId }),
          );
          if (draft.generation !== provenance.generation) continue;
          if (
            draft.articleId !== articleId ||
            provenance.articleId !== articleId ||
            !["draft", "in-review", "published", "retired"].includes(
              draft.state,
            ) ||
            typeof draft.hasPublication !== "boolean" ||
            draft.hasPublication !==
              (provenance.publishedSnapshot !== undefined)
          )
            throw new AssistantBoundaryError(
              "reconciliation_provenance_unavailable",
            );
          const currentSnapshot = sourceSnapshot(provenance.snapshot);
          const published =
            provenance.publishedSnapshot === undefined
              ? null
              : sourceSnapshot(provenance.publishedSnapshot);
          const references = new Map<string, PrivateSourceReference>();
          for (const reference of [
            ...currentSnapshot.references,
            ...(published?.references ?? []),
          ])
            references.set(canonical(reference), reference);
          // Readability applies to every contributor in both complete snapshots.
          // Current eligibility is intentionally not required for cleanup.
          const readable = await Promise.all(
            [...references.values()].map((reference) =>
              runtime.within(() =>
                options.sources.canRead({
                  access: current.access,
                  articleId,
                  reference,
                }),
              ),
            ),
          );
          if (readable.some((value) => value !== true))
            throw new AssistantBoundaryError(
              "reconciliation_source_unreadable",
            );
          return Object.freeze({
            articleId,
            generation: count(draft.generation, Number.MAX_SAFE_INTEGER, 1),
            state: draft.state,
            hasPublication: draft.hasPublication,
            current: currentSnapshot,
            published,
          });
        } catch (error) {
          if (!(error instanceof RepositoryConflictError)) throw error;
        }
      }
      throw new AssistantBoundaryError("reconciliation_observation_changed");
    };
    const observe = async (
      view: View,
      destination: Destination,
      current: LearningKnowledgeAuthority,
    ): Promise<Observation> => {
      const identity = requestIdentity(destination);
      const facts = await sourceFacts(view, current);
      const observed = await observeKnowledge(destination.articleId, current);
      const after = await readView(current);
      if (
        sourceVersion(after) !== sourceVersion(view) ||
        canonical(findDestination(after, destination).requestIdentity) !==
          canonical(identity)
      )
        throw new AssistantBoundaryError("reconciliation_source_changed");
      return {
        view: after,
        destination: findDestination(after, destination),
        identity,
        facts,
        knowledge: observed,
      };
    };
    const confirmSourceVersion = async (
      expected: View,
      destination: Destination,
      current: LearningKnowledgeAuthority,
      replayFingerprint?: string,
    ): Promise<View> => {
      const view = await readView(current);
      const found = findDestination(view, destination);
      // The application checks the exact command receipt on replay. Permit only
      // that same receipt's own postcommit version when its acknowledgement was lost.
      const ownReplay =
        replayFingerprint !== undefined &&
        found.lastReconciliation?.fingerprint === replayFingerprint;
      if (
        view.sourceGeneration !== expected.sourceGeneration ||
        view.state !== expected.state ||
        (!ownReplay &&
          view.sourceWorkGeneration !== expected.sourceWorkGeneration) ||
        canonical(found.requestIdentity) !==
          canonical(destination.requestIdentity)
      )
        throw new AssistantBoundaryError("reconciliation_source_changed");
      return view;
    };
    const record = async (
      command: RecordResolutionLearningReconciliationCommand,
      guard: () => Promise<void>,
      current: LearningKnowledgeAuthority,
    ): Promise<View | undefined> => {
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        try {
          const fresh = await sameAuthority(current);
          return await runtime.within(() =>
            application.recordResolutionLearningReconciliation(
              fresh.access,
              command,
              guard,
            ),
          );
        } catch {
          // Retry the identical guarded command only. A lost acknowledgement is
          // not permission to invent a different terminal result or source fence.
          if (runtime.remaining() <= 0 || runtime.signal.aborted) break;
        }
      }
      return undefined;
    };
    const markBlocked = async (
      view: View,
      destination: Destination,
      current: LearningKnowledgeAuthority,
    ): Promise<void> => {
      const command: RecordResolutionLearningReconciliationCommand = {
        ticketId,
        expectedSourceGeneration: view.sourceGeneration,
        expectedSourceWorkGeneration: view.sourceWorkGeneration,
        articleId: destination.articleId,
        stepId: destination.stepId,
        requestHash: destination.requestHash,
        disposition: "blocked",
      };
      const hash = await fingerprint(command);
      const result = await record(
        command,
        async () => {
          const fresh = await sameAuthority(current);
          await confirmSourceVersion(view, destination, fresh, hash);
        },
        current,
      );
      if (result !== undefined) latest = result;
    };

    try {
      const initialAuthority = await authority();
      const initial = await readView(initialAuthority);
      const destinations =
        options.deliveryMode === "staged"
          ? initial.destinations
              .filter(
                (destination) => destination.reconciliation !== "confirmed",
              )
              .slice(0, 1)
          : initial.destinations;
      for (const original of destinations) {
        if (original.reconciliation === "confirmed") continue;
        processedDestinations += 1;
        let resolved = false;
        for (let attempt = 0; attempt < attempts; attempt += 1) {
          const current = await authority();
          const view = await readView(current);
          const destination = findDestination(view, original);
          if (destination.reconciliation === "confirmed") {
            resolved = true;
            break;
          }
          let observation: Observation;
          try {
            observation = await observe(view, destination, current);
          } catch (error) {
            blocked = true;
            reason =
              error instanceof AssistantBoundaryError &&
              [
                "reconciliation_identity_unavailable",
                "reconciliation_source_changed",
                "reconciliation_destination_changed",
                "reconciliation_provenance_unavailable",
                "reconciliation_source_unreadable",
                "reconciliation_observation_changed",
                "cancelled",
                "deadline",
              ].includes(error.category)
                ? error.category
                : "reconciliation_observation_unavailable";
            await markBlocked(view, destination, current);
            break;
          }
          const kb = observation.knowledge;
          const publishedAffected =
            kb.published !== null &&
            referencesAffected(
              kb.published.references,
              ticketId,
              observation.facts,
            );
          const draftAffected =
            !kb.hasPublication &&
            referencesAffected(
              kb.current.references,
              ticketId,
              observation.facts,
            );
          const shouldRetire = publishedAffected || draftAffected;
          const confirmObservation = async (
            replayFingerprint?: string,
          ): Promise<void> => {
            const fresh = await sameAuthority(current);
            const currentView = await confirmSourceVersion(
              view,
              destination,
              fresh,
              replayFingerprint,
            );
            const checked = await observe(
              currentView,
              findDestination(currentView, destination),
              fresh,
            );
            if (
              canonical(checked.knowledge) !== canonical(kb) ||
              canonical(checked.facts) !== canonical(observation.facts)
            )
              throw new AssistantBoundaryError(
                "reconciliation_observation_changed",
              );
          };
          if (
            shouldRetire &&
            (kb.state !== "retired" ||
              kb.generation <= observation.identity.originalExpectedGeneration)
          ) {
            const operationHash = await fingerprint({
              operation: "support.learning.retire.v1",
              ticketId,
              stepId: destination.stepId,
              requestHash: destination.requestHash,
              articleId: kb.articleId,
              expectedGeneration: kb.generation,
              sourceSnapshotHash: kb.published?.hash ?? kb.current.hash,
            });
            let retirementAttempted = false;
            try {
              await confirmObservation();
              const fresh = await sameAuthority(current);
              await runtime.within(() => {
                retirementAttempted = true;
                return knowledge.retireArticle(fresh.access, {
                  articleId: kb.articleId,
                  expectedGeneration: kb.generation,
                  commandId: `support-learning-retire:${operationHash}`,
                  correlationId: `support-learning-reconcile:${operationHash}`,
                });
              });
            } catch {
              // Every invoked KB error may follow acceptance. The next bounded
              // pass reobserves full membership; equal observations reuse this ID.
            }
            if (options.deliveryMode === "staged" && retirementAttempted) break;
            continue;
          }
          if (
            kb.generation <= observation.identity.originalExpectedGeneration
          ) {
            reason = "reconciliation_late_write_unfenced";
            await markBlocked(view, destination, current);
            break;
          }
          const proof = await fingerprint({
            operation: "support.learning.reconciliation.v1",
            ticketId,
            sourceGeneration: view.sourceGeneration,
            sourceWorkGeneration: view.sourceWorkGeneration,
            stepId: destination.stepId,
            requestHash: destination.requestHash,
            originalRequest: observation.identity,
            articleId: kb.articleId,
            generation: kb.generation,
            state: kb.state,
            currentSourceSnapshotHash: kb.current.hash,
            publishedSourceSnapshotHash: kb.published?.hash ?? null,
          });
          const command: RecordResolutionLearningReconciliationCommand = {
            ticketId,
            expectedSourceGeneration: view.sourceGeneration,
            expectedSourceWorkGeneration: view.sourceWorkGeneration,
            articleId: destination.articleId,
            stepId: destination.stepId,
            requestHash: destination.requestHash,
            disposition:
              kb.state === "retired" ? "retired" : "unaffected_publication",
            proof: { kind: "revision_fence", binding: proof },
          };
          const hash = await fingerprint(command);
          const result = await record(
            command,
            () => confirmObservation(hash),
            current,
          );
          if (result !== undefined) {
            latest = result;
            resolved = true;
          }
          break;
        }
        if (!resolved && reason === undefined)
          reason = "reconciliation_pending";
      }
      const current = await authority();
      latest = await readView(current);
      return {
        outcome: !latest.reconciliationPending
          ? "reconciled"
          : blocked
            ? "blocked"
            : "pending",
        processedDestinations,
        result: latest,
        ...(latest.reconciliationPending && reason !== undefined
          ? { reason }
          : {}),
      };
    } catch {
      return {
        outcome: "pending",
        processedDestinations,
        ...(latest === undefined ? {} : { result: latest }),
        reason: "reconciliation_unavailable",
      };
    } finally {
      runtime.close();
    }
  };
}
