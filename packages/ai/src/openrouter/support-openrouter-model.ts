import type { Clock } from "@pegma/spine";

export type SupportOpenRouterModelFailure =
  | "route_unavailable"
  | "invalid_input"
  | "credential_unavailable"
  | "aborted"
  | "deadline"
  | "provider_unavailable"
  | "invalid_response"
  | "response_limit"
  | "usage_invalid";
/** Internal finite error; purpose wrappers expose their existing public errors. */
export class SupportOpenRouterModelError extends Error {
  override readonly name = "SupportOpenRouterModelError";
  constructor(readonly code: SupportOpenRouterModelFailure) {
    super("Support provider request could not be safely completed");
  }
}
interface SupportOpenRouterBudgets {
  readonly maxMessages: number;
  readonly maxInputBytes: number;
  readonly maxInputTokens: number;
  readonly maxContextTokens: number;
  readonly maxOutputBytes: number;
  readonly maxOutputTokens: number;
  readonly maxDurationMilliseconds: number;
  readonly maxCostMicros: number;
  readonly currency: string;
}
export interface SupportOpenRouterConfiguration {
  readonly version: string;
  readonly promptVersion: string;
  readonly modelVersion: string;
  readonly provider: string;
  readonly model: string;
  readonly trustedInstructions: string;
  readonly framingTokens: number;
  readonly budgets: SupportOpenRouterBudgets;
}
export interface SupportOpenRouterContext {
  readonly purpose: string;
  readonly configurationVersion: string;
  readonly promptVersion: string;
  readonly modelVersion: string;
  readonly usageScopeRef: string;
  readonly deadline: string;
  readonly signal: AbortSignal;
  readonly budgets: SupportOpenRouterBudgets;
}
export interface SupportOpenRouterRoute<Configuration> {
  readonly configuration: Configuration;
  readonly endpoint: string;
  readonly credentialRef: string;
  readonly usageScopeRef: string;
  readonly endpointTag: string;
  readonly outputTokenParameter: "max_tokens" | "max_completion_tokens";
  readonly approval: {
    readonly validUntil: string;
    readonly implicitCache: "absent" | "approved";
  };
}
export interface SupportOpenRouterModelOptions<Configuration> {
  readonly clock: Clock;
  readonly configuration: {
    currentRoute(
      expectedVersion?: string,
    ): SupportOpenRouterRoute<Configuration> | undefined;
    readonly tokenCounter: { count(text: string): number };
  };
  readonly readApiKey: (credentialRef: string) => string | undefined;
  readonly fetch?: (url: string, init: RequestInit) => Promise<Response>;
  /** Purpose wrappers preserve their existing finite callback error classes. */
  readonly failureCode?: (
    error: unknown,
  ) => SupportOpenRouterModelFailure | undefined;
}
export interface SupportOpenRouterModelResult {
  readonly outputJson: string;
  readonly provider: string;
  readonly model: string;
  readonly requestId: string;
  readonly usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly costMicros: number;
    readonly currency: string;
  };
}

const encoder = new TextEncoder();
const badScalar = /[\u0000-\u001F\u007F]/u;
const badText = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u;

export function usableCredential(value: unknown): value is string {
  return typeof value === "string" && /^[\x21-\x7E]{1,4096}$/u.test(value);
}

export function fail(code: SupportOpenRouterModelFailure): never {
  throw new SupportOpenRouterModelError(code);
}

export function object(
  value: unknown,
  allowed: readonly string[],
  required = allowed,
): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Object.getOwnPropertySymbols(value).length !== 0
  )
    fail("invalid_response");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Object.keys(descriptors).some(
      (key) => !allowed.includes(key) || !("value" in descriptors[key]!),
    ) ||
    required.some((key) => !descriptors[key] || !("value" in descriptors[key]!))
  )
    fail("invalid_response");
  return value as Record<string, unknown>;
}

export function scalar(value: unknown, maximum = 200): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maximum ||
    badScalar.test(value)
  )
    fail("invalid_response");
  return value;
}

export function text(value: unknown, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maximum ||
    badText.test(value)
  )
    fail("invalid_response");
  return value;
}

export function integer(
  value: unknown,
  maximum: number,
  minimum = 0,
  failure: SupportOpenRouterModelFailure = "usage_invalid",
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  )
    fail(failure);
  return value;
}

export function array(value: unknown, maximum: number, minimum = 0): unknown[] {
  if (
    !Array.isArray(value) ||
    value.length < minimum ||
    value.length > maximum ||
    Object.getOwnPropertySymbols(value).length !== 0 ||
    Object.getOwnPropertyNames(value).length !== value.length + 1
  )
    fail("invalid_input");
  return Array.from({ length: value.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor)) fail("invalid_input");
    return descriptor.value;
  });
}

export function canonical(value: unknown): string {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    typeof value === "number"
  )
    return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  const data = value as Record<string, unknown>;
  return (
    "{" +
    Object.keys(data)
      .sort()
      .map((key) => JSON.stringify(key) + ":" + canonical(data[key]))
      .join(",") +
    "}"
  );
}

/** One bounded lexical pass rejects duplicate keys and preserves the cost decimal. */
export function strictJson(source: string): { value: unknown; cost?: string } {
  let at = 0;
  let nodes = 0;
  let cost: string | undefined;
  const space = () => {
    while (/\s/u.test(source[at] ?? "") && at < source.length) at += 1;
  };
  const string = (): string => {
    const start = at++;
    let escaped = false;
    while (at < source.length) {
      const ch = source[at++]!;
      if (!escaped && ch === '"')
        return JSON.parse(source.slice(start, at)) as string;
      if (!escaped && ch === "\\") escaped = true;
      else escaped = false;
    }
    return fail("invalid_response");
  };
  const visit = (path: readonly string[], depth: number): void => {
    if (++nodes > 30_000 || depth > 24) fail("response_limit");
    space();
    const ch = source[at];
    if (ch === '"') {
      string();
      return;
    }
    if (ch === "{") {
      at += 1;
      space();
      const keys = new Set<string>();
      if (source[at] === "}") {
        at += 1;
        return;
      }
      while (at < source.length) {
        space();
        if (source[at] !== '"') fail("invalid_response");
        const key = string();
        if (keys.has(key)) fail("invalid_response");
        keys.add(key);
        space();
        if (source[at++] !== ":") fail("invalid_response");
        visit([...path, key], depth + 1);
        space();
        const end = source[at++];
        if (end === "}") return;
        if (end !== ",") fail("invalid_response");
      }
      fail("invalid_response");
    }
    if (ch === "[") {
      at += 1;
      space();
      if (source[at] === "]") {
        at += 1;
        return;
      }
      while (at < source.length) {
        visit([...path, "[]"], depth + 1);
        space();
        const end = source[at++];
        if (end === "]") return;
        if (end !== ",") fail("invalid_response");
      }
      fail("invalid_response");
    }
    const start = at;
    while (at < source.length && !/[\s,}\]]/u.test(source[at]!)) at += 1;
    const token = source.slice(start, at);
    if (
      !/^(?:null|true|false|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)$/u.test(
        token,
      )
    )
      fail("invalid_response");
    if (path.length === 2 && path[0] === "usage" && path[1] === "cost")
      cost = token;
  };
  visit([], 0);
  space();
  if (at !== source.length) fail("invalid_response");
  const value: unknown = JSON.parse(source);
  return cost === undefined ? { value } : { value, cost };
}

/** Exact decimal rounding; never silently loses a fractional micro-unit. */
function costMicros(decimal: string | undefined, maximum: number): number {
  if (decimal === undefined || decimal.length > 400) fail("usage_invalid");
  const match = /^(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/u.exec(decimal);
  if (!match) fail("usage_invalid");
  const exponent = Number(match[3] ?? "0");
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 400)
    fail("usage_invalid");
  const digits = BigInt(match[1]! + (match[2] ?? ""));
  const scale = 6 + exponent - (match[2]?.length ?? 0);
  const result =
    scale >= 0
      ? digits * 10n ** BigInt(scale)
      : (digits + 10n ** BigInt(-scale) - 1n) / 10n ** BigInt(-scale);
  if (result > BigInt(maximum)) fail("usage_invalid");
  return Number(result);
}

function details(
  raw: unknown,
  allowed: readonly string[],
  maximum: number,
  requireZero: boolean,
): void {
  if (raw === undefined) return;
  const values = object(raw, allowed, []);
  for (const value of Object.values(values)) {
    const count = integer(
      value,
      Number.MAX_SAFE_INTEGER,
      0,
      "invalid_response",
    );
    if (count > (requireZero ? 0 : maximum)) fail("usage_invalid");
  }
}

function responseResult(
  raw: string,
  response: Response,
  route: SupportOpenRouterRoute<SupportOpenRouterConfiguration>,
  context: SupportOpenRouterContext,
  convertOutput: (content: string) => string,
): SupportOpenRouterModelResult {
  const parsed = strictJson(raw);
  const data = object(
    parsed.value,
    [
      "id",
      "object",
      "created",
      "model",
      "provider",
      "choices",
      "usage",
      "system_fingerprint",
      "service_tier",
    ],
    ["id", "object", "model", "provider", "choices", "usage"],
  );
  if (
    data.object !== "chat.completion" ||
    data.provider !== route.configuration.provider ||
    data.model !== route.configuration.model
  )
    fail("invalid_response");
  const requestId = scalar(data.id);
  const headerId = response.headers.get("x-generation-id");
  if (headerId !== null && headerId !== requestId) fail("invalid_response");
  if (data.created !== undefined)
    integer(data.created, Number.MAX_SAFE_INTEGER, 0, "invalid_response");
  if (data.system_fingerprint !== undefined && data.system_fingerprint !== null)
    scalar(data.system_fingerprint);
  if (
    data.service_tier !== undefined &&
    data.service_tier !== null &&
    data.service_tier !== "default"
  )
    fail("invalid_response");
  if (!Array.isArray(data.choices) || data.choices.length !== 1)
    fail("invalid_response");
  const choice = object(
    data.choices[0],
    ["index", "message", "finish_reason", "native_finish_reason", "logprobs"],
    ["index", "message", "finish_reason"],
  );
  if (
    choice.index !== 0 ||
    (choice.finish_reason !== "stop" && choice.finish_reason !== "length") ||
    (choice.logprobs !== undefined && choice.logprobs !== null)
  )
    fail("invalid_response");
  if (
    choice.native_finish_reason !== undefined &&
    choice.native_finish_reason !== null
  ) {
    const nativeReason = scalar(choice.native_finish_reason);
    if (
      choice.finish_reason === "stop" &&
      !["stop", "end_turn", "completed"].includes(nativeReason)
    )
      fail("invalid_response");
  }
  const message = object(
    choice.message,
    [
      "role",
      "content",
      "refusal",
      "tool_calls",
      "reasoning",
      "reasoning_details",
      "annotations",
    ],
    ["role", "content"],
  );
  if (
    message.role !== "assistant" ||
    (message.refusal !== undefined && message.refusal !== null) ||
    (message.reasoning !== undefined &&
      message.reasoning !== null &&
      message.reasoning !== "")
  )
    fail("invalid_response");
  for (const key of ["tool_calls", "reasoning_details", "annotations"]) {
    const value = message[key];
    if (
      value !== undefined &&
      value !== null &&
      (!Array.isArray(value) || value.length !== 0)
    )
      fail("invalid_response");
  }
  if (typeof message.content !== "string" && message.content !== null)
    fail("invalid_response");
  const usage = object(
    data.usage,
    [
      "prompt_tokens",
      "completion_tokens",
      "total_tokens",
      "cost",
      "currency",
      "is_byok",
      "prompt_tokens_details",
      "completion_tokens_details",
      "cost_details",
    ],
    ["prompt_tokens", "completion_tokens", "total_tokens", "cost"],
  );
  const inputTokens = integer(usage.prompt_tokens, Number.MAX_SAFE_INTEGER, 1);
  const outputTokens = integer(
    usage.completion_tokens,
    Number.MAX_SAFE_INTEGER,
    0,
  );
  if (
    integer(usage.total_tokens, Number.MAX_SAFE_INTEGER) !==
      inputTokens + outputTokens ||
    (usage.currency !== undefined && usage.currency !== "USD") ||
    (usage.is_byok !== undefined && usage.is_byok !== false) ||
    typeof usage.cost !== "number" ||
    !Number.isFinite(usage.cost) ||
    usage.cost < 0
  )
    fail("usage_invalid");
  details(
    usage.prompt_tokens_details,
    ["cached_tokens", "cache_write_tokens", "audio_tokens", "video_tokens"],
    inputTokens,
    route.approval.implicitCache === "absent",
  );
  if (usage.prompt_tokens_details !== undefined) {
    const promptDetails = usage.prompt_tokens_details as Record<
      string,
      unknown
    >;
    if (
      ["audio_tokens", "video_tokens"].some(
        (key) => promptDetails[key] !== undefined && promptDetails[key] !== 0,
      )
    )
      fail("usage_invalid");
  }
  details(
    usage.completion_tokens_details,
    [
      "reasoning_tokens",
      "accepted_prediction_tokens",
      "rejected_prediction_tokens",
      "image_tokens",
      "audio_tokens",
    ],
    outputTokens,
    true,
  );
  if (usage.cost_details !== undefined) {
    const costs = object(
      usage.cost_details,
      [
        "upstream_inference_cost",
        "upstream_inference_input_cost",
        "upstream_inference_output_cost",
        "upstream_inference_prompt_cost",
        "upstream_inference_completions_cost",
      ],
      [],
    );
    for (const value of Object.values(costs))
      if (
        value !== null &&
        (typeof value !== "number" || !Number.isFinite(value) || value < 0)
      )
        fail("usage_invalid");
  }
  const actualCostMicros = costMicros(parsed.cost, Number.MAX_SAFE_INTEGER);
  const overBudget =
    inputTokens > context.budgets.maxInputTokens ||
    outputTokens > context.budgets.maxOutputTokens ||
    inputTokens + outputTokens > context.budgets.maxContextTokens ||
    actualCostMicros > context.budgets.maxCostMicros;
  let outputJson = "";
  if (!overBudget && choice.finish_reason === "stop") {
    try {
      const content = text(message.content, context.budgets.maxOutputBytes);
      if (encoder.encode(content).byteLength > context.budgets.maxOutputBytes)
        fail("response_limit");
      outputJson = convertOutput(content);
    } catch {
      // Unusable output still carries validated native accounting.
    }
  }
  return {
    // Preserve valid native accounting for the SDK's usage reconciliation. An
    // over-budget response must never supply an acceptable answer/candidate.
    outputJson,
    provider: route.configuration.provider,
    model: route.configuration.model,
    requestId,
    usage: {
      inputTokens,
      outputTokens,
      costMicros: actualCostMicros,
      currency: "USD",
    },
  };
}

export function createSupportOpenRouterModel<
  Input extends { readonly trustedInstructions: string },
  Context extends SupportOpenRouterContext,
  Configuration extends SupportOpenRouterConfiguration,
>(
  options: SupportOpenRouterModelOptions<Configuration>,
  protocol: {
    readonly purpose: string;
    readonly endpoint: string;
    readonly system: string;
    readonly schemaName: string;
    readonly schema: unknown;
    input(input: Input, context: Context): string;
    output(content: string, context: Context): string;
    validate(
      input: Input,
      context: Context,
      configuration: Configuration,
    ): void;
  },
) {
  const request = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
  return {
    async generate(
      input: Input,
      context: Context,
      configuration: Configuration,
    ) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let bodyStream: ReadableStream<Uint8Array> | undefined;
      let stopped = false;
      const controller = new AbortController();
      let rejectStop: (error: SupportOpenRouterModelError) => void = () => {};
      const stop = new Promise<never>((_, reject) => {
        rejectStop = reject;
      });
      void stop.catch(() => {});
      const abort = (code: "aborted" | "deadline") => {
        if (stopped) return;
        stopped = true;
        controller.abort();
        if (reader) void reader.cancel().catch(() => {});
        rejectStop(new SupportOpenRouterModelError(code));
      };
      const onAbort = () => abort("aborted");
      try {
        if (context.signal.aborted) fail("aborted");
        const startedText = options.clock.now();
        const started = Date.parse(startedText);
        const monotonic = performance.now();
        const deadline = Math.min(
          Date.parse(context.deadline),
          started + context.budgets.maxDurationMilliseconds,
        );
        if (
          !Number.isFinite(started) ||
          new Date(started).toISOString() !== startedText ||
          !Number.isFinite(deadline) ||
          deadline <= started ||
          new Date(Date.parse(context.deadline)).toISOString() !==
            context.deadline
        )
          fail("deadline");
        const route = options.configuration.currentRoute(configuration.version);
        if (
          !route ||
          route.endpoint !== protocol.endpoint ||
          canonical(route.configuration) !== canonical(configuration) ||
          context.purpose !== protocol.purpose ||
          context.configurationVersion !== configuration.version ||
          context.promptVersion !== configuration.promptVersion ||
          context.modelVersion !== configuration.modelVersion ||
          context.usageScopeRef !== route.usageScopeRef
        )
          fail("route_unavailable");
        for (const key of [
          "maxMessages",
          "maxInputBytes",
          "maxInputTokens",
          "maxContextTokens",
          "maxOutputBytes",
          "maxOutputTokens",
          "maxDurationMilliseconds",
          "maxCostMicros",
        ] as const)
          if (
            integer(context.budgets[key], configuration.budgets[key]) < 1 &&
            key !== "maxCostMicros"
          )
            fail("invalid_input");
        protocol.validate(input, context, configuration);
        if (context.budgets.currency !== configuration.budgets.currency)
          fail("usage_invalid");
        const routeBinding = canonical(route);
        const guard = () => {
          if (stopped || context.signal.aborted) fail("aborted");
          const now = Math.max(
            Date.parse(options.clock.now()),
            started + Math.max(0, performance.now() - monotonic),
          );
          if (!Number.isFinite(now) || now >= deadline) fail("deadline");
          const current = options.configuration.currentRoute(
            configuration.version,
          );
          if (
            !current ||
            canonical(current) !== routeBinding ||
            Date.parse(current.approval.validUntil) <= now
          )
            fail("route_unavailable");
        };
        const payload = protocol.input(input, context);
        if (
          !input.trustedInstructions.startsWith(
            configuration.trustedInstructions,
          )
        )
          fail("invalid_input");
        const inputTokens =
          options.configuration.tokenCounter.count(payload) +
          configuration.framingTokens;
        if (
          encoder.encode(payload).byteLength > context.budgets.maxInputBytes ||
          inputTokens > context.budgets.maxInputTokens ||
          inputTokens + context.budgets.maxOutputTokens >
            context.budgets.maxContextTokens
        )
          fail("invalid_input");
        const key = options.readApiKey(route.credentialRef);
        if (!usableCredential(key)) fail("credential_unavailable");
        const body = JSON.stringify({
          model: configuration.model,
          stream: false,
          messages: [
            { role: "system", content: protocol.system },
            { role: "user", content: payload },
          ],
          [route.outputTokenParameter]: context.budgets.maxOutputTokens,
          response_format: {
            type: "json_schema",
            json_schema: {
              name: protocol.schemaName,
              strict: true,
              schema: protocol.schema,
            },
          },
          provider: {
            only: [route.endpointTag],
            allow_fallbacks: false,
            data_collection: "deny",
            zdr: true,
            require_parameters: true,
          },
        });
        context.signal.addEventListener("abort", onAbort, { once: true });
        timer = setTimeout(
          () => abort("deadline"),
          Math.max(
            1,
            deadline -
              Math.max(
                Date.parse(options.clock.now()),
                started + performance.now() - monotonic,
              ),
          ),
        );
        guard();
        const pending = request(route.endpoint, {
          method: "POST",
          redirect: "error",
          cache: "no-store",
          credentials: "omit",
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${key}`,
            "Content-Type": "application/json",
            Accept: "application/json",
            "X-OpenRouter-Cache": "false",
            "Cache-Control": "no-store",
          },
          body,
        });
        void pending.then(
          (response) => {
            if (stopped && response.body)
              void response.body.cancel().catch(() => {});
          },
          () => {},
        );
        const response = await Promise.race([pending, stop]);
        bodyStream = response.body ?? undefined;
        guard();
        if (
          response.status !== 200 ||
          response.redirected ||
          (response.url && response.url !== route.endpoint) ||
          !/^application\/json(?:\s*;|$)/iu.test(
            response.headers.get("content-type") ?? "",
          ) ||
          !response.body
        )
          fail("provider_unavailable");
        const maximum = Math.min(
          524_288,
          context.budgets.maxOutputBytes * 6 + 16_384,
        );
        const declared = response.headers.get("content-length");
        if (
          declared !== null &&
          (!/^\d+$/u.test(declared) ||
            !Number.isSafeInteger(Number(declared)) ||
            Number(declared) > maximum)
        )
          fail("response_limit");
        reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        while (true) {
          const next = await Promise.race([reader.read(), stop]);
          guard();
          if (next.done) break;
          bytes += next.value.byteLength;
          if (bytes > maximum) fail("response_limit");
          chunks.push(new Uint8Array(next.value));
        }
        const all = new Uint8Array(bytes);
        let offset = 0;
        for (const chunk of chunks) {
          all.set(chunk, offset);
          offset += chunk.byteLength;
        }
        const result = responseResult(
          new TextDecoder("utf-8", { fatal: true }).decode(all),
          response,
          route,
          context,
          (content) => protocol.output(content, context),
        );
        let outputJson = result.outputJson;
        try {
          if (
            options.configuration.tokenCounter.count(outputJson) >
              context.budgets.maxOutputTokens ||
            encoder.encode(outputJson).byteLength >
              context.budgets.maxOutputBytes
          )
            outputJson = "";
        } catch {
          outputJson = "";
        }
        guard();
        return { ...result, outputJson };
      } catch (error) {
        controller.abort();
        if (error instanceof SupportOpenRouterModelError) throw error;
        throw new SupportOpenRouterModelError(
          options.failureCode?.(error) ??
            (stopped || context.signal.aborted
              ? "aborted"
              : "provider_unavailable"),
        );
      } finally {
        stopped = true;
        if (timer !== undefined) clearTimeout(timer);
        context.signal.removeEventListener("abort", onAbort);
        if (reader) {
          void reader.cancel().catch(() => {});
          try {
            reader.releaseLock();
          } catch {
            /* A pending aborted read still owns its lock. */
          }
        } else if (bodyStream) void bodyStream.cancel().catch(() => {});
      }
    },
  };
}
