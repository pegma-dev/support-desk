import type {
  LearningKnowledgeAccessPort,
  LearningKnowledgeAuthority,
  SupportDeskLearningOptions,
} from "./learning-integration-types.js";
import type { LearningServiceAuthority } from "./learning-ports.js";
import {
  AssistantBoundaryError,
  count,
  scalar,
  snapshot,
  timestamp,
} from "./boundary.js";
import { learningAuthoritySnapshot } from "./learning-request.js";

export interface LearningRuntime {
  readonly deadline: number;
  readonly signal: AbortSignal;
  remaining(deadline?: number): number;
  ensure(deadline?: number, cleanup?: boolean): void;
  within<T>(
    action: () => Promise<T>,
    deadline?: number,
    cleanup?: boolean,
  ): Promise<T>;
  close(): void;
}

/** One physical invocation, bounded independently by real elapsed and host time. */
export function createLearningRuntime(
  options: Pick<
    SupportDeskLearningOptions,
    "clock" | "maxOperationMilliseconds"
  >,
  run: { readonly signal?: AbortSignal; readonly deadline?: number } = {},
): LearningRuntime {
  const started = performance.now();
  const startTime = timestamp(options.clock.now());
  const milliseconds = count(
    options.maxOperationMilliseconds ?? 25_000,
    25_000,
    1,
  );
  const deadline = Math.min(startTime + milliseconds, run.deadline ?? Infinity);
  const controller = new AbortController();
  const external = run.signal;
  const cancel = (): void => {
    controller.abort();
  };
  if (external?.aborted) cancel();
  else external?.addEventListener("abort", cancel, { once: true });
  const remaining = (phase = deadline): number =>
    Math.min(
      deadline - timestamp(options.clock.now()),
      deadline - startTime - (performance.now() - started),
      phase - timestamp(options.clock.now()),
      phase - startTime - (performance.now() - started),
    );
  const ensure = (phase = deadline, cleanup = false): void => {
    if (!cleanup && controller.signal.aborted)
      throw new AssistantBoundaryError("cancelled");
    if (remaining(phase) <= 0) throw new AssistantBoundaryError("deadline");
  };
  return Object.freeze({
    deadline,
    signal: controller.signal,
    remaining,
    ensure,
    async within<T>(
      action: () => Promise<T>,
      phase = deadline,
      cleanup = false,
    ): Promise<T> {
      ensure(phase, cleanup);
      let timer: ReturnType<typeof setTimeout> | undefined;
      let onAbort: (() => void) | undefined;
      const boundary = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => {
            reject(new AssistantBoundaryError("deadline"));
          },
          Math.max(1, Math.floor(remaining(phase))),
        );
        onAbort = () => reject(new AssistantBoundaryError("cancelled"));
        if (!cleanup)
          controller.signal.addEventListener("abort", onAbort, { once: true });
      });
      try {
        const value = await Promise.race([
          Promise.resolve().then(() => {
            ensure(phase, cleanup);
            return action();
          }),
          boundary,
        ]);
        ensure(phase, cleanup);
        return value;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        if (onAbort !== undefined)
          controller.signal.removeEventListener("abort", onAbort);
      }
    },
    close(): void {
      controller.abort();
      external?.removeEventListener("abort", cancel);
    },
  });
}

export async function learningServiceAuthority(
  options: Pick<SupportDeskLearningOptions, "serviceAccess">,
  runtime: LearningRuntime,
  deadline = runtime.deadline,
): Promise<LearningServiceAuthority> {
  const result = await runtime.within(
    () => options.serviceAccess.resolve(runtime.signal),
    deadline,
  );
  if (result.outcome !== "ready")
    throw new AssistantBoundaryError("authority_unavailable");
  return learningAuthoritySnapshot(result.authority);
}

export async function learningKnowledgeAuthority(
  port: LearningKnowledgeAccessPort,
  runtime: LearningRuntime,
  deadline = runtime.deadline,
): Promise<LearningKnowledgeAuthority> {
  const result = await runtime.within(
    () => port.resolve(runtime.signal),
    deadline,
  );
  if (result.outcome !== "ready")
    throw new AssistantBoundaryError("knowledge_authority_unavailable");
  const value = snapshot(result.authority);
  scalar(value.authorityVersion);
  const normalized = learningAuthoritySnapshot({
    ...value,
    usageScopeRef: "knowledge",
  });
  return Object.freeze({
    access: normalized.access,
    authorityVersion: normalized.authorityVersion,
  });
}
