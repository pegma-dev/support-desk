import { fields } from "./assistant-turn-records.js";
import { SupportDeskConflictError } from "./index.js";
import type { EngineeringMutationOptions } from "./engineering-types.js";

/** Operation-local host callbacks and caller cancellation, captured once. */
export function engineeringMutationBoundary(
  options?: EngineeringMutationOptions,
) {
  if (options === undefined) return undefined;
  fields(options, "Mutation options", [], ["signal", "verifyBeforeCommit"]);
  const signal = options.signal;
  const guard = options.verifyBeforeCommit;
  if (guard !== undefined && typeof guard !== "function")
    throw new TypeError("Mutation guard must be callable");
  if (
    signal !== undefined &&
    (signal === null ||
      typeof signal !== "object" ||
      typeof signal.aborted !== "boolean" ||
      typeof signal.addEventListener !== "function" ||
      typeof signal.removeEventListener !== "function")
  )
    throw new TypeError("Mutation requires an AbortSignal");
  const aborted = () => new DOMException("Mutation aborted", "AbortError");
  const ensure = (): void => {
    if (signal?.aborted) throw aborted();
  };
  return {
    signal,
    ensure,
    async verify(): Promise<() => void> {
      ensure();
      let onAbort: (() => void) | undefined;
      let proof: void | (() => true);
      try {
        const result = Promise.resolve().then(() => {
          ensure();
          return guard?.();
        });
        proof =
          signal === undefined
            ? await result
            : await Promise.race([
                result,
                new Promise<never>((_resolve, reject) => {
                  onAbort = () => reject(aborted());
                  signal.addEventListener("abort", onAbort, { once: true });
                  if (signal.aborted) onAbort();
                }),
              ]);
      } finally {
        if (signal !== undefined && onAbort !== undefined)
          signal.removeEventListener("abort", onAbort);
      }
      ensure();
      return () => {
        ensure();
        if (proof !== undefined) {
          if (typeof proof !== "function")
            throw new SupportDeskConflictError("Mutation proof is not current");
          const current: unknown = proof();
          if (current !== true) {
            // Observe a malformed async return while refusing it synchronously.
            void Promise.resolve(current).catch(() => {});
            throw new SupportDeskConflictError("Mutation proof is not current");
          }
        }
        ensure();
      };
    },
  };
}
export type EngineeringMutationBoundary = NonNullable<
  ReturnType<typeof engineeringMutationBoundary>
>;
