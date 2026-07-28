export interface TemplateDefinition {
  readonly id: string;
  readonly version: number;
  readonly variables: readonly string[];
  /** Variables rendered into URL-bearing HTML attributes. HTTPS only. */
  readonly httpsUrlVariables?: readonly string[];
  readonly plainText: string;
  readonly html: string;
}

export interface RenderedTemplate {
  readonly templateId: string;
  readonly templateVersion: number;
  readonly plainText: string;
  readonly html: string;
}

const TOKEN = /\{\{([a-z][a-z0-9_]*)\}\}/g;
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

function ownDataProperty(
  source: object,
  key: string,
  field: string,
  optional = false,
): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(source, key);
  if (descriptor === undefined) {
    if (optional) {
      return undefined;
    }
    throw new TypeError(`${field} must be an own data property`);
  }
  if (!Object.hasOwn(descriptor, "value")) {
    throw new TypeError(
      `${field} must be an own data property, not an accessor`,
    );
  }
  return descriptor.value;
}

function snapshotStringArray(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${field} must be an array`);
  }
  const length = ownDataProperty(value, "length", `${field}.length`);
  if (!Number.isSafeInteger(length) || (length as number) < 0) {
    throw new TypeError(`${field}.length must be a non-negative safe integer`);
  }
  const snapshot: string[] = [];
  for (let index = 0; index < (length as number); index += 1) {
    const item = ownDataProperty(value, String(index), `${field}[${index}]`);
    if (typeof item !== "string") {
      throw new TypeError(`${field}[${index}] must be a string`);
    }
    snapshot.push(item);
  }
  return Object.freeze(snapshot);
}

function snapshotTemplateDefinition(
  definition: TemplateDefinition,
): TemplateDefinition {
  if (
    definition === null ||
    (typeof definition !== "object" && typeof definition !== "function")
  ) {
    throw new TypeError("template must be an object");
  }
  const id = ownDataProperty(definition, "id", "template.id");
  const version = ownDataProperty(definition, "version", "template.version");
  const variables = snapshotStringArray(
    ownDataProperty(definition, "variables", "template.variables"),
    "template.variables",
  );
  const rawHttpsUrlVariables = ownDataProperty(
    definition,
    "httpsUrlVariables",
    "template.httpsUrlVariables",
    true,
  );
  const plainText = ownDataProperty(
    definition,
    "plainText",
    "template.plainText",
  );
  const html = ownDataProperty(definition, "html", "template.html");
  if (typeof id !== "string") {
    throw new TypeError("template.id must be a string");
  }
  if (typeof version !== "number") {
    throw new TypeError("template.version must be a number");
  }
  if (typeof plainText !== "string") {
    throw new TypeError("template.plainText must be a string");
  }
  if (typeof html !== "string") {
    throw new TypeError("template.html must be a string");
  }
  const httpsUrlVariables =
    rawHttpsUrlVariables === undefined
      ? undefined
      : snapshotStringArray(rawHttpsUrlVariables, "template.httpsUrlVariables");
  return Object.freeze({
    id,
    version,
    variables,
    ...(httpsUrlVariables === undefined ? {} : { httpsUrlVariables }),
    plainText,
    html,
  });
}

function requireName(value: string, field: string): void {
  if (!/^[a-z][a-z0-9._-]*$/.test(value)) {
    throw new TypeError(`${field} is not a safe identifier`);
  }
}

function referencedVariables(source: string): Set<string> {
  const found = new Set<string>();
  for (const match of source.matchAll(TOKEN)) {
    const name = match[1];
    if (name !== undefined) {
      found.add(name);
    }
  }
  return found;
}

function validateSource(source: string, field: string): void {
  if (source.length === 0 || CONTROL.test(source)) {
    throw new TypeError(`${field} must be non-empty and contain no controls`);
  }
  if (source.replaceAll(TOKEN, "").includes("{{")) {
    throw new TypeError(`${field} contains an invalid template expression`);
  }
}

function validateConstrainedHtml(
  source: string,
  httpsUrlVariables: ReadonlySet<string>,
): void {
  const openTags = new Set([
    "p",
    "a",
    "strong",
    "em",
    "ul",
    "ol",
    "li",
    "code",
  ]);
  const stack: string[] = [];
  let position = 0;
  while (position < source.length) {
    const character = source[position] as string;
    if (character === "&") {
      throw new TypeError(
        "template.html literal character references are not allowed",
      );
    }
    if (character === ">") {
      throw new TypeError("template.html contains malformed literal markup");
    }
    if (character !== "<") {
      position += 1;
      continue;
    }

    const end = source.indexOf(">", position + 1);
    if (end === -1) {
      throw new TypeError("template.html contains unterminated markup");
    }
    const tag = source.slice(position, end + 1);
    if (tag === "<br>" || tag === "<br/>" || tag === "<br />") {
      position = end + 1;
      continue;
    }

    const plainOpen = /^<([a-z]+)>$/.exec(tag);
    if (plainOpen !== null) {
      const name = plainOpen[1] as string;
      if (!openTags.has(name) || name === "a") {
        throw new TypeError(
          "template.html uses markup or attributes outside the safe subset",
        );
      }
      stack.push(name);
      position = end + 1;
      continue;
    }

    const anchor =
      /^<a href=(?:"\{\{([a-z][a-z0-9_]*)\}\}"|'\{\{([a-z][a-z0-9_]*)\}\}')>$/.exec(
        tag,
      );
    const variable = anchor?.[1] ?? anchor?.[2];
    if (variable !== undefined && httpsUrlVariables.has(variable)) {
      stack.push("a");
      position = end + 1;
      continue;
    }

    const close = /^<\/([a-z]+)>$/.exec(tag);
    if (close !== null) {
      const name = close[1] as string;
      if (!openTags.has(name) || stack.pop() !== name) {
        throw new TypeError(
          "template.html contains unbalanced or disallowed markup",
        );
      }
      position = end + 1;
      continue;
    }

    throw new TypeError(
      "template.html uses markup or attributes outside the safe subset",
    );
  }
  if (stack.length > 0) {
    throw new TypeError("template.html contains unclosed markup");
  }
}

export function defineTemplate(
  definition: TemplateDefinition,
): TemplateDefinition {
  const snapshot = snapshotTemplateDefinition(definition);
  requireName(snapshot.id, "template.id");
  if (!Number.isSafeInteger(snapshot.version) || snapshot.version <= 0) {
    throw new TypeError("template.version must be a positive safe integer");
  }
  validateSource(snapshot.plainText, "template.plainText");
  validateSource(snapshot.html, "template.html");
  const allowed = new Set<string>();
  for (const name of snapshot.variables) {
    requireName(name, "template variable");
    if (allowed.has(name)) {
      throw new TypeError(`duplicate template variable: ${name}`);
    }
    allowed.add(name);
  }
  const httpsUrlVariables = new Set<string>();
  for (const name of snapshot.httpsUrlVariables ?? []) {
    if (!allowed.has(name)) {
      throw new TypeError(
        `HTTPS URL variable is not in the template allowlist: ${name}`,
      );
    }
    if (httpsUrlVariables.has(name)) {
      throw new TypeError(`duplicate HTTPS URL variable: ${name}`);
    }
    httpsUrlVariables.add(name);
  }
  validateConstrainedHtml(snapshot.html, httpsUrlVariables);
  for (const name of [
    ...referencedVariables(snapshot.plainText),
    ...referencedVariables(snapshot.html),
  ]) {
    if (!allowed.has(name)) {
      throw new TypeError(`template references unlisted variable: ${name}`);
    }
  }
  return snapshot;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function interpolate(
  source: string,
  variables: Readonly<Record<string, string>>,
  transform: (value: string) => string,
): string {
  return source.replaceAll(TOKEN, (_token, name: string) =>
    transform(variables[name] ?? ""),
  );
}

function snapshotVariables(
  variables: Readonly<Record<string, string>>,
  allowed: ReadonlySet<string>,
): Readonly<Record<string, string>> {
  if (
    variables === null ||
    (typeof variables !== "object" && typeof variables !== "function")
  ) {
    throw new TypeError("template variables must be an object");
  }
  const snapshot: Record<string, string> = Object.create(null) as Record<
    string,
    string
  >;
  const descriptors = Object.getOwnPropertyDescriptors(variables);
  for (const [name, descriptor] of Object.entries(descriptors)) {
    if (!descriptor.enumerable) {
      continue;
    }
    if (!allowed.has(name)) {
      throw new TypeError(`variable is not allowed by template: ${name}`);
    }
    if (!Object.hasOwn(descriptor, "value")) {
      throw new TypeError(
        `template variable ${name} must be an own data property, not an accessor`,
      );
    }
    const value = descriptor.value;
    if (typeof value !== "string") {
      throw new TypeError(`template variable is required: ${name}`);
    }
    snapshot[name] = value;
  }
  return Object.freeze(snapshot);
}

export function renderTemplate(
  template: TemplateDefinition,
  variables: Readonly<Record<string, string>>,
): RenderedTemplate {
  // Catalogs are host-owned boundaries and may hydrate structural objects
  // without going through defineTemplate. Validate and normalize again at the
  // last boundary before emitting mail.
  const validated = defineTemplate(template);
  const allowed = new Set(validated.variables);
  const values = snapshotVariables(variables, allowed);
  for (const name of validated.variables) {
    if (!Object.hasOwn(values, name)) {
      throw new TypeError(`template variable is required: ${name}`);
    }
  }
  for (const name of validated.httpsUrlVariables ?? []) {
    const value = values[name] as string;
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new TypeError(
        `template URL variable must be absolute HTTPS: ${name}`,
      );
    }
    if (
      parsed.protocol !== "https:" ||
      parsed.username.length > 0 ||
      parsed.password.length > 0
    ) {
      throw new TypeError(
        `template URL variable must be absolute HTTPS: ${name}`,
      );
    }
  }
  return Object.freeze({
    templateId: validated.id,
    templateVersion: validated.version,
    plainText: interpolate(validated.plainText, values, (value) => value),
    html: interpolate(validated.html, values, escapeHtml),
  });
}

export function previewTemplate(
  template: TemplateDefinition,
): RenderedTemplate {
  const validated = defineTemplate(template);
  const urlVariables = new Set(validated.httpsUrlVariables ?? []);
  return renderTemplate(
    validated,
    Object.fromEntries(
      validated.variables.map((name) => [
        name,
        urlVariables.has(name)
          ? `https://preview.invalid/${name}`
          : `[preview:${name}]`,
      ]),
    ),
  );
}
