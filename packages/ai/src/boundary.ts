/** Coarse local failure: never retains customer text, provider bodies or errors. */
export class AssistantBoundaryError extends Error {
  override readonly name = "AssistantBoundaryError";
  constructor(readonly category: string) {
    super("Assistant processing could not be safely completed");
  }
}

export function bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

export function text(value: unknown, maximum = 200): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maximum
  )
    throw new AssistantBoundaryError("invalid_data");
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(value))
    throw new AssistantBoundaryError("invalid_data");
  return value;
}

/** Single-line persisted metadata follows the application's stricter C0 rule. */
export function scalar(value: unknown, maximum = 200): string {
  const result = text(value, maximum);
  if (/[\u0000-\u001F\u007F]/u.test(result))
    throw new AssistantBoundaryError("invalid_data");
  return result;
}

export function count(value: unknown, maximum: number, minimum = 0): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < minimum ||
    (value as number) > maximum
  )
    throw new AssistantBoundaryError("budget_exceeded");
  return value as number;
}

export function timestamp(value: unknown): number {
  const parsed = Date.parse(scalar(value, 40));
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value)
    throw new AssistantBoundaryError("invalid_data");
  return parsed;
}

/** Deterministic bounded JSON data only, rejecting getters, coercion and cycles. */
export function canonical(value: unknown): string {
  const seen = new Set<object>();
  let nodes = 0;
  let characters = 0;
  const visit = (item: unknown, depth: number): string => {
    if (++nodes > 30_000 || depth > 24)
      throw new AssistantBoundaryError("invalid_data");
    let encoded: string;
    if (
      item === null ||
      typeof item === "string" ||
      typeof item === "boolean"
    ) {
      if (typeof item === "string" && item.length > 262_144)
        throw new AssistantBoundaryError("budget_exceeded");
      encoded = JSON.stringify(item);
    } else if (typeof item === "number" && Number.isFinite(item)) {
      encoded = JSON.stringify(item);
    } else if (typeof item === "object" && item !== null && !seen.has(item)) {
      seen.add(item);
      try {
        if (Object.getOwnPropertySymbols(item).length !== 0)
          throw new AssistantBoundaryError("invalid_data");
        const own = (key: string): unknown => {
          const descriptor = Object.getOwnPropertyDescriptor(item, key);
          if (descriptor === undefined || !("value" in descriptor))
            throw new AssistantBoundaryError("invalid_data");
          return descriptor.value;
        };
        if (Array.isArray(item)) {
          if (item.length > 1_024 || Object.keys(item).length !== item.length)
            throw new AssistantBoundaryError("invalid_data");
          encoded =
            "[" +
            Array.from({ length: item.length }, (_, i) =>
              visit(own(String(i)), depth + 1),
            ).join(",") +
            "]";
        } else {
          if (
            Object.getPrototypeOf(item) !== Object.prototype &&
            Object.getPrototypeOf(item) !== null
          )
            throw new AssistantBoundaryError("invalid_data");
          const keys = Object.keys(item).sort();
          if (keys.length > 128)
            throw new AssistantBoundaryError("invalid_data");
          encoded =
            "{" +
            keys
              .map(
                (key) => JSON.stringify(key) + ":" + visit(own(key), depth + 1),
              )
              .join(",") +
            "}";
        }
      } finally {
        seen.delete(item);
      }
    } else {
      throw new AssistantBoundaryError("invalid_data");
    }
    characters += encoded.length;
    if (characters > 4_000_000)
      throw new AssistantBoundaryError("budget_exceeded");
    return encoded;
  };
  return visit(value, 0);
}

export function snapshot<T>(value: T): T {
  const copied = JSON.parse(canonical(value)) as T;
  const freeze = (item: unknown): void => {
    if (typeof item !== "object" || item === null) return;
    for (const child of Object.values(item)) freeze(child);
    Object.freeze(item);
  };
  freeze(copied);
  return copied;
}

export async function fingerprint(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical(value)),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function exactKeys(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new AssistantBoundaryError("malformed_output");
  const actual = Object.keys(value).sort();
  if (canonical(actual) !== canonical([...keys].sort()))
    throw new AssistantBoundaryError("malformed_output");
  return value as Record<string, unknown>;
}
