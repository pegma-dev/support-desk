/** An operation-local signal; it stores no SDK or adapter state. */
export function signal() {
  let release = () => {};
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { ready, release };
}

export type Settled<T> =
  | { readonly outcome: "returned"; readonly value: T }
  | { readonly outcome: "threw"; readonly error: unknown };

export function settled<T>(operation: Promise<T>): Promise<Settled<T>> {
  return operation.then(
    (value) => ({ outcome: "returned" as const, value }),
    (error: unknown) => ({ outcome: "threw" as const, error }),
  );
}

/** Bound a real read barrier below the unchanged 30-second test watchdog. */
export async function reached(
  ready: Promise<unknown>,
  operation: Promise<unknown>,
  label: string,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      ready,
      operation.then(() => {
        throw new Error(`Public operation missed its read barrier: ${label}`);
      }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(label)), 10_000);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
