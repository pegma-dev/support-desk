import type { AccessContext } from "@pegma/authorization-core";
import type {
  PrivateSourceReference,
  PrivateSourcesVerifier,
  SourceEligibilityRequest,
  SourceReadRequest,
} from "@pegma/knowledge-base-application";
import type { ResolutionLearningSourceRecord } from "@pegma/support-desk-application";
import {
  AssistantBoundaryError,
  canonical,
  count,
  scalar,
  snapshot,
  timestamp,
} from "./boundary.js";
import {
  learningReferenceSnapshot,
  learningReferencesSnapshot,
  learningSourceFence,
  learningSourceReference,
  learningTargetBinding,
  supportDeskLearningSourceSystem,
} from "./learning-bindings.js";
import type { SupportDeskLearningSourceVerifierOptions } from "./learning-integration-types.js";

interface SourceOperation {
  readonly signal: AbortSignal;
  now(): number;
  within<T>(action: () => Promise<T>): Promise<T>;
}
interface CurrentAuthority {
  readonly access: AccessContext;
  readonly version: string;
  readonly principalId: string;
  readonly accessBinding: string;
}

/**
 * Read-only bridge over Support's public services. It never calls KB, so KB's
 * source callbacks cannot recursively enter retrieval, review, or publication.
 */
export function createSupportDeskLearningSourceVerifier(
  options: SupportDeskLearningSourceVerifierOptions,
): PrivateSourcesVerifier {
  const application = options.application;
  const sourceAccess = options.serviceAccess;
  const reviewPolicy = options.reviewPolicy;
  const otherSources = options.otherSources;
  const clock = options.clock;
  const operationMilliseconds = count(
    options.maxOperationMilliseconds ?? 2_500,
    25_000,
    1,
  );

  async function run(
    action: (operation: SourceOperation) => Promise<boolean>,
  ): Promise<boolean> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const started = performance.now();
      const startClock = timestamp(clock.now());
      const deadline = startClock + operationMilliseconds;
      const now = (): number =>
        Math.max(
          timestamp(clock.now()),
          startClock + performance.now() - started,
        );
      const ensure = (): void => {
        if (
          controller.signal.aborted ||
          performance.now() - started >= operationMilliseconds ||
          now() >= deadline
        )
          throw new AssistantBoundaryError("source_deadline");
      };
      const operation: SourceOperation = {
        signal: controller.signal,
        now,
        async within<T>(invoke: () => Promise<T>): Promise<T> {
          ensure();
          const value = await invoke();
          ensure();
          return value;
        },
      };
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new AssistantBoundaryError("source_deadline"));
        }, operationMilliseconds);
      });
      return (await Promise.race([action(operation), timeout])) === true;
    } catch {
      // Callback failures carry no source text or private operational errors.
      return false;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      controller.abort();
    }
  }

  async function authority(
    operation: SourceOperation,
    previous?: CurrentAuthority,
  ): Promise<CurrentAuthority> {
    const resolved = await operation.within(() =>
      sourceAccess.resolve(operation.signal),
    );
    if (resolved.outcome !== "ready")
      throw new AssistantBoundaryError("source_authority_unavailable");
    const access = snapshot(resolved.authority.access);
    const current: CurrentAuthority = {
      access,
      version: scalar(resolved.authority.authorityVersion),
      principalId: scalar(access.principalId),
      accessBinding: canonical(access),
    };
    if (
      previous !== undefined &&
      (previous.version !== current.version ||
        previous.principalId !== current.principalId ||
        previous.accessBinding !== current.accessBinding)
    )
      throw new AssistantBoundaryError("source_authority_changed");
    return current;
  }

  async function currentSources(
    references: readonly PrivateSourceReference[],
    current: CurrentAuthority,
    operation: SourceOperation,
  ): Promise<readonly ResolutionLearningSourceRecord[]> {
    const sources: ResolutionLearningSourceRecord[] = [];
    for (const reference of references) {
      const source = await operation.within(() =>
        application.readResolutionLearningSource(
          current.access,
          reference.resourceId,
        ),
      );
      const actual = learningSourceReference(source);
      if (
        actual.id !== reference.id ||
        actual.system !== reference.system ||
        actual.resourceId !== reference.resourceId ||
        actual.version !== reference.version ||
        !(await operation.within(() =>
          application.confirmResolutionLearningSource(
            current.access,
            learningSourceFence(source),
          ),
        ))
      )
        throw new AssistantBoundaryError("source_ineligible");
      sources.push(source);
    }
    return sources;
  }

  async function confirmSources(
    sources: readonly ResolutionLearningSourceRecord[],
    current: CurrentAuthority,
    operation: SourceOperation,
  ): Promise<boolean> {
    for (const source of sources)
      if (
        !(await operation.within(() =>
          application.confirmResolutionLearningSource(
            current.access,
            learningSourceFence(source),
          ),
        ))
      )
        return false;
    return true;
  }

  async function retainedReference(
    request: SourceReadRequest,
    reference: PrivateSourceReference,
    operation: SourceOperation,
  ): Promise<boolean> {
    // Use the actual caller, never the fixed service authority. This operation
    // authorizes only opaque metadata for a registered withdrawn destination.
    const retained = await operation.within(() =>
      application.readResolutionLearningReconciliation(
        request.access,
        reference.resourceId,
      ),
    );
    return (
      retained.ticketId === reference.resourceId &&
      retained.state === "withdrawn" &&
      retained.destinations.some(
        (destination) => destination.articleId === request.articleId,
      )
    );
  }

  const verifier: PrivateSourcesVerifier = {
    async canRead(request) {
      return run(async (operation) => {
        const reference = learningReferenceSnapshot(request.reference);
        scalar(request.articleId);
        if (reference.system !== supportDeskLearningSourceSystem)
          return otherSources === undefined
            ? false
            : operation.within(() => otherSources.canRead(request));
        try {
          const source = await operation.within(() =>
            application.readResolutionLearningSource(
              request.access,
              reference.resourceId,
            ),
          );
          if (
            source.ticketId === reference.resourceId &&
            ["eligible", "held", "unverified"].includes(source.state)
          )
            return true;
        } catch {
          // Deletion can remove the ticket while retaining a minimal source and
          // destination tombstone. The separate public read authorizes itself.
        }
        return retainedReference(request, reference, operation);
      });
    },
    async isCurrent(request) {
      return run(async (operation) => {
        const references = learningReferencesSnapshot(
          request.snapshot.references,
        );
        if (references.length === 0) return true;
        const known = references.filter(
          (reference) => reference.system === supportDeskLearningSourceSystem,
        );
        const foreign = known.length !== references.length;
        if (foreign && otherSources === undefined) return false;
        if (known.length === 0)
          return operation.within(() => otherSources!.isCurrent(request));
        const initial = await authority(operation);
        const sources = await currentSources(known, initial, operation);
        if (
          foreign &&
          !(await operation.within(() => otherSources!.isCurrent(request)))
        )
          return false;
        const latest = await authority(operation, initial);
        if (!(await confirmSources(sources, latest, operation))) return false;
        await authority(operation, initial);
        return true;
      });
    },
    async canPublish(request: SourceEligibilityRequest) {
      return run(async (operation) => {
        const references = learningReferencesSnapshot(
          request.snapshot.references,
        );
        if (references.length === 0) return true;
        const known = references.filter(
          (reference) => reference.system === supportDeskLearningSourceSystem,
        );
        const foreign = known.length !== references.length;
        if (foreign && otherSources === undefined) return false;
        if (known.length === 0)
          return (
            (await operation.within(() => otherSources!.isCurrent(request))) &&
            (await operation.within(() => otherSources!.canPublish(request)))
          );
        const initial = await authority(operation);
        const sources = await currentSources(known, initial, operation);
        if (
          foreign &&
          (!(await operation.within(() => otherSources!.isCurrent(request))) ||
            !(await operation.within(() => otherSources!.canPublish(request))))
        )
          return false;
        const resolved = await operation.within(() =>
          reviewPolicy.resolvePolicy(undefined, operation.signal),
        );
        if (resolved.outcome !== "ready") return false;
        const policy = snapshot(resolved.policy);
        const policyVersion = scalar(policy.version);
        const policyBinding = scalar(policy.binding);
        const policyNow = operation.now();
        const policyUntil = timestamp(policy.validUntil);
        const liveUntil = (until: number): boolean => until > operation.now();
        const policyLive = (): boolean => liveUntil(policyUntil);
        if (timestamp(policy.verifiedAt) > policyNow || !policyLive())
          return false;
        const target = await operation.within(() =>
          learningTargetBinding(request.article, request.snapshot),
        );
        const latest = await authority(operation, initial);
        if (!(await confirmSources(sources, latest, operation))) return false;
        for (const source of sources) {
          if (!policyLive()) return false;
          if (
            await operation.within(() =>
              application.confirmResolutionLearningTargetReview(latest.access, {
                ticketId: source.ticketId,
                target,
                policyVersion,
              }),
            )
          ) {
            if (!policyLive()) return false;
            const refreshed = await operation.within(() =>
              reviewPolicy.resolvePolicy(policyVersion, operation.signal),
            );
            if (refreshed.outcome !== "ready") return false;
            const fresh = snapshot(refreshed.policy);
            const freshNow = operation.now();
            if (
              scalar(fresh.version) !== policyVersion ||
              scalar(fresh.binding) !== policyBinding ||
              timestamp(fresh.verifiedAt) > freshNow ||
              timestamp(fresh.validUntil) <= freshNow
            )
              return false;
            // The policy resolver can await while another contributing source
            // reopens or the aggregate staff decision is rejected. Recheck the
            // entire unchanged context once after that awaited observation.
            if (
              foreign &&
              (!(await operation.within(() =>
                otherSources!.isCurrent(request),
              )) ||
                !(await operation.within(() =>
                  otherSources!.canPublish(request),
                )))
            )
              return false;
            // Delegated checks may also await; confirm every Support source
            // afterward, before considering any aggregate staff approval.
            const finalAuthority = await authority(operation, initial);
            if (!(await confirmSources(sources, finalAuthority, operation)))
              return false;
            let reviewed = false;
            for (const contributor of sources) {
              if (
                await operation.within(() =>
                  application.confirmResolutionLearningTargetReview(
                    finalAuthority.access,
                    { ticketId: contributor.ticketId, target, policyVersion },
                  ),
                )
              ) {
                reviewed = true;
                break;
              }
            }
            if (!reviewed) return false;
            if (!policyLive() || !liveUntil(timestamp(fresh.validUntil)))
              return false;
            return true;
          }
        }
        return false;
      });
    },
  };
  return Object.freeze(verifier);
}
