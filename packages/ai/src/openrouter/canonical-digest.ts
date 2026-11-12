export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (isPlainObject(value))
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map((key) => JSON.stringify(key) + ":" + canonical(value[key]))
        .join(",") +
      "}"
    );
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  )
    return JSON.stringify(value);
  throw new TypeError("Unsupported knowledge evidence value.");
}

/** Shared host fingerprinting, independent of the report service's storage. */
export async function knowledgeDigest(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical(value)),
  );
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** Exact logical host binding; never URL normalization or ambient request authority. */
export function checkedLogicalHost(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 253 ||
    !value
      .split(".")
      .every(
        (label) =>
          label.length >= 1 &&
          label.length <= 63 &&
          /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label),
      )
  )
    throw new TypeError("Invalid independent check logical host");
  return value;
}
