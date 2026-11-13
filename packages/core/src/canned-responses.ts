import type {
  CannedResponseDefinition,
  CannedResponseSelection,
} from "@pegma/support-desk-contracts";

const name = /^[a-z][a-z0-9_]{0,31}$/;
const token = /\{\{([a-z][a-z0-9_]{0,31})\}\}/g;
const controls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;

function object(value: unknown): object {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  )
    throw new TypeError("Canned response fields must be plain data");
  return value;
}

function data(source: object, key: PropertyKey): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(source, key);
  if (
    !descriptor ||
    !Object.hasOwn(descriptor, "value") ||
    !descriptor.enumerable
  )
    throw new TypeError("Canned response fields must be enumerable own data");
  return descriptor.value;
}

function fields(value: unknown, keys: readonly string[]): object {
  const source = object(value);
  const actual = Reflect.ownKeys(source);
  if (
    actual.length !== keys.length ||
    actual.some((key) => typeof key !== "string" || !keys.includes(key))
  )
    throw new TypeError("Unexpected canned response fields");
  return source;
}

function text(value: unknown, maximum: number, singleLine = false): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > maximum ||
    controls.test(value) ||
    (singleLine && /[\r\n\t]/.test(value))
  )
    throw new TypeError("Invalid canned response text");
  return value;
}

function identifier(value: unknown): string {
  if (typeof value !== "string" || !name.test(value))
    throw new TypeError("Invalid canned response identifier");
  return value;
}

function version(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    throw new TypeError("Invalid canned response version");
  return value;
}

/** Validate and freeze a bounded plain-text template. No expressions or ticket reads. */
export function defineCannedResponse(
  input: CannedResponseDefinition,
): CannedResponseDefinition {
  const source = fields(input, [
    "id",
    "version",
    "title",
    "target",
    "variables",
    "body",
  ]);
  const id = identifier(data(source, "id"));
  const revision = version(data(source, "version"));
  const title = text(data(source, "title"), 120, true);
  const target = data(source, "target");
  if (target !== "reply" && target !== "note")
    throw new TypeError("Canned response target must be reply or note");
  const raw = data(source, "variables");
  if (!Array.isArray(raw) || raw.length > 16)
    throw new TypeError("Canned responses allow at most 16 variables");
  if (Reflect.ownKeys(raw).length !== raw.length + 1)
    throw new TypeError("Invalid canned response variable array");
  const variables: string[] = [];
  for (let index = 0; index < raw.length; index++)
    variables.push(identifier(data(raw, String(index))));
  if (new Set(variables).size !== variables.length)
    throw new TypeError("Duplicate canned response variables");
  const body = text(data(source, "body"), 16_000);
  const references = new Set(
    [...body.matchAll(token)].map((match) => match[1]),
  );
  const remainder = body.replace(token, "");
  if (
    remainder.includes("{{") ||
    remainder.includes("}}") ||
    references.size !== variables.length ||
    variables.some((key) => !references.has(key))
  )
    throw new TypeError(
      "Canned response variables must match template tokens exactly",
    );
  return Object.freeze({
    id,
    version: revision,
    title,
    target,
    variables: Object.freeze(variables),
    body,
  });
}

/** Snapshot input before an await and sort keys for stable idempotency fingerprints. */
export function snapshotCannedResponseSelection(
  input: unknown,
): CannedResponseSelection {
  const source = fields(input, ["id", "version", "values"]);
  const id = identifier(data(source, "id"));
  const revision = version(data(source, "version"));
  const raw = object(data(source, "values"));
  const keys = Reflect.ownKeys(raw);
  if (
    keys.length > 16 ||
    keys.some((key) => typeof key !== "string" || !name.test(key))
  )
    throw new TypeError("Invalid canned response value keys");
  const values = Object.freeze(
    Object.fromEntries(
      (keys as string[]).sort().map((key) => [key, text(data(raw, key), 2000)]),
    ),
  );
  return Object.freeze({ id, version: revision, values });
}

/** Expand once as literal plain text. Hosts escape this text at HTML/Markdown boundaries. */
export function renderCannedResponse(
  input: CannedResponseDefinition,
  values: Readonly<Record<string, string>>,
): string {
  const definition = defineCannedResponse(input);
  const selection = snapshotCannedResponseSelection({
    id: definition.id,
    version: definition.version,
    values,
  });
  if (
    Object.keys(selection.values).length !== definition.variables.length ||
    definition.variables.some((key) => !Object.hasOwn(selection.values, key))
  )
    throw new TypeError(
      "Canned response values must match declared variables exactly",
    );
  let length = definition.body.length;
  for (const match of definition.body.matchAll(token)) {
    length += selection.values[match[1]!]!.length - match[0].length;
  }
  if (length > 16_000)
    throw new TypeError("Expanded canned response is too large");
  return text(
    definition.body.replace(
      token,
      (_match, key: string) => selection.values[key]!,
    ),
    16_000,
  );
}

/** Deployment-owned catalog; no new collection, settings store, or automatic actions. */
export function defineCannedResponseCatalog(
  input: unknown,
): readonly CannedResponseDefinition[] {
  if (input === undefined) return Object.freeze([]);
  if (!Array.isArray(input))
    throw new TypeError(
      "Canned response catalog must be an array of definitions",
    );
  if (input.length > 64)
    throw new TypeError(
      "Canned response catalog must contain at most 64 definitions",
    );
  if (Reflect.ownKeys(input).length !== input.length + 1)
    throw new TypeError(
      "Canned response catalog must be a dense array without extra properties",
    );
  const result: CannedResponseDefinition[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < input.length; index++) {
    const definition = defineCannedResponse(
      data(input, String(index)) as CannedResponseDefinition,
    );
    const key = `${definition.id}:${definition.version}`;
    if (seen.has(key)) throw new TypeError("Duplicate canned response version");
    seen.add(key);
    result.push(definition);
  }
  return Object.freeze(result);
}
