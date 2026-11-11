import { SupportDeskConflictError } from "./index.js";
import type { EngineeringMutationOptions } from "./engineering-types.js";

/** Operation-local host callbacks and caller cancellation, captured once. */
export function engineeringMutationBoundary(
  options?: EngineeringMutationOptions,
) {
  if (options === undefined) return undefined;
  if (options === null || typeof options !== "object")
    throw new TypeError("Engineering mutation options must be an object");
  const signal = options.signal;
  const guard = options.verifyBeforeCommit;
  if (guard !== undefined && typeof guard !== "function")
    throw new TypeError("Engineering mutation guard must be callable");
  if (
    signal !== undefined &&
    (signal === null ||
      typeof signal !== "object" ||
      typeof signal.aborted !== "boolean" ||
      typeof signal.addEventListener !== "function" ||
      typeof signal.removeEventListener !== "function")
  )
    throw new TypeError("Engineering mutation requires an AbortSignal");
  const aborted = () =>
    new DOMException("Engineering mutation aborted", "AbortError");
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
        if (onAbort !== undefined)
          signal!.removeEventListener("abort", onAbort);
      }
      ensure();
      return () => {
        ensure();
        if (
          proof !== undefined &&
          (typeof proof !== "function" || proof() !== true)
        )
          throw new SupportDeskConflictError(
            "Engineering mutation proof is not current",
          );
        ensure();
      };
    },
  };
}
export type EngineeringMutationBoundary = NonNullable<
  ReturnType<typeof engineeringMutationBoundary>
>;
