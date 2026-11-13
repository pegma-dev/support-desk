/** Compare private strings using the same escaping as the encoded JSON payload. */
export function containsPrivateText(
  encoded: string,
  privateValues: readonly string[],
): boolean {
  if (typeof encoded !== "string")
    throw new TypeError("Expected an encoded private-content boundary");
  return privateValues.some(
    (value) =>
      value.length > 0 && encoded.includes(JSON.stringify(value).slice(1, -1)),
  );
}
