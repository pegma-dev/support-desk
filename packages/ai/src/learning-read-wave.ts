import { count } from "./boundary.js";

/** Bounded read-only waves consume every settlement and retain input-order errors. */
export async function learningReadWave<T, U>(
  values: readonly T[],
  read: (value: T) => Promise<U>,
): Promise<readonly U[]> {
  count(values.length, 32);
  const settled = await Promise.allSettled(
    values.map((value) => Promise.resolve().then(() => read(value))),
  );
  const result: U[] = [];
  for (const value of settled) {
    if (value.status === "rejected") throw value.reason;
    result.push(value.value);
  }
  return result;
}
