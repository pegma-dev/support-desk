import type {
  AssistantModelUsage,
  AssistantUsageObservation,
} from "../ports.js";
import type { Clock } from "@pegma/spine";
import { defineCollection, type Store } from "@pegma/storage-core";

/** One finite pool. A future reviewed operation must own any rotation/top-up. */
export interface SupportModelUsagePolicy {
  readonly version: string;
  readonly scopeRef: string;
  readonly configurationVersion: string;
  readonly modelVersion: string;
  /** Bound through configurationVersion; the SDK context has no price field. */
  readonly pricingRef: string;
  readonly currency: string;
  readonly maxCostMicros: number;
  readonly maxReservationCostMicros: number;
  readonly maxReservations: number;
  readonly validFrom: string;
  readonly validUntil: string;
  /** Additional minimum after deadline; never shortens whole-window retention. */
  readonly terminalRetentionMilliseconds: number;
}

export interface SupportModelUsageOptions {
  readonly store: Store;
  readonly clock: Clock;
  /** Missing policy is unavailable, before even opening a collection. */
  readonly policy?: SupportModelUsagePolicy;
}

interface UsageIdentity {
  readonly operationId: string;
  readonly attemptId: string;
  readonly inputFingerprint: string;
  readonly usageReservationId: string;
}
interface UsageContext extends UsageIdentity {
  readonly purpose: string;
  readonly usageScopeRef: string;
  readonly configurationVersion: string;
  readonly modelVersion: string;
  readonly deadline: string;
  readonly signal: AbortSignal;
  readonly budgets: {
    readonly currency: string;
    readonly maxCostMicros: number;
  };
}
interface UsagePort<Context, Identity> {
  reserve(
    context: Context,
  ): Promise<
    | { readonly outcome: "reserved"; readonly usageReservationId: string }
    | { readonly outcome: "denied" | "unavailable" }
  >;
  reconcile(
    identity: Identity,
    observation: AssistantUsageObservation,
  ): Promise<"reconciled" | "pending">;
}
interface UsageSchema<Context, Identity> {
  readonly invalidBudgetOutcome?: "denied" | "unavailable";
  readonly purpose: string;
  readonly collection: string;
  readonly key: { readonly partition: string; readonly id: string };
  readonly binding: (context: Context) => string | undefined;
  readonly identity: (identity: Identity) => UsageIdentity;
}
const MAX_RESERVATIONS = 32;
const MAX_WINDOW_MS = 31 * 24 * 60 * 60 * 1_000;
const MAX_RECORD_BYTES = 60_000;
const MAX_SPENT =
  BigInt(Number.MAX_SAFE_INTEGER) * BigInt(MAX_RESERVATIONS + 1);
const HASH = /^[0-9a-f]{64}$/u;

interface Reservation {
  readonly reservationHash: string;
  readonly attemptHash: string;
  readonly identityHash: string;
  readonly bindingHash: string;
  readonly reservedMicros: number;
  readonly deadline: string;
  readonly createdAt: string;
  readonly state: "reserved" | "unknown" | "known" | "not_called";
  readonly terminalAt: string | null;
  readonly usage: AssistantModelUsage | null;
}

interface Ledger {
  readonly policyHash: string;
  /** Conflicting accepted accounting requires a future explicit operator path. */
  readonly accountingHold: boolean;
  /** Decimal integer: actual over-budget usage must not overflow or be refunded. */
  readonly spentMicros: string;
  readonly observedAt: string;
  readonly reservations: readonly Reservation[];
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("Invalid assistant usage data");
  return value as Record<string, unknown>;
}

function keys(
  value: Record<string, unknown>,
  expected: readonly string[],
): void {
  if (
    Object.keys(value).length !== expected.length ||
    expected.some((name) => !Object.hasOwn(value, name))
  )
    throw new TypeError("Invalid assistant usage fields");
}

export function usageText(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    throw new TypeError("Invalid assistant usage reference");
  return value;
}

export function usageInteger(
  value: unknown,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  )
    throw new TypeError("Invalid assistant usage number");
  return value;
}

function timestamp(value: unknown): number {
  const result = typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isFinite(result) || new Date(result).toISOString() !== value)
    throw new TypeError("Invalid assistant usage time");
  return result;
}

function policySnapshot(
  input: SupportModelUsagePolicy,
): SupportModelUsagePolicy {
  const value = object(input);
  keys(value, [
    "version",
    "scopeRef",
    "configurationVersion",
    "modelVersion",
    "pricingRef",
    "currency",
    "maxCostMicros",
    "maxReservationCostMicros",
    "maxReservations",
    "validFrom",
    "validUntil",
    "terminalRetentionMilliseconds",
  ]);
  const from = timestamp(value.validFrom);
  const until = timestamp(value.validUntil);
  if (until <= from || until - from > MAX_WINDOW_MS)
    throw new TypeError("Invalid assistant usage policy window");
  const maxCostMicros = usageInteger(value.maxCostMicros, 1);
  const currency = usageText(value.currency);
  if (!/^[A-Z]{3}$/u.test(currency))
    throw new TypeError("Invalid assistant usage currency");
  return Object.freeze({
    version: usageText(value.version),
    scopeRef: usageText(value.scopeRef),
    configurationVersion: usageText(value.configurationVersion),
    modelVersion: usageText(value.modelVersion),
    pricingRef: usageText(value.pricingRef),
    currency,
    maxCostMicros,
    maxReservationCostMicros: usageInteger(
      value.maxReservationCostMicros,
      1,
      maxCostMicros,
    ),
    maxReservations: usageInteger(value.maxReservations, 1, MAX_RESERVATIONS),
    validFrom: value.validFrom as string,
    validUntil: value.validUntil as string,
    terminalRetentionMilliseconds: usageInteger(
      value.terminalRetentionMilliseconds,
      1,
      MAX_WINDOW_MS,
    ),
  });
}

function usageSnapshot(input: unknown): AssistantModelUsage {
  const value = object(input);
  keys(value, ["inputTokens", "outputTokens", "costMicros", "currency"]);
  const currency = usageText(value.currency);
  if (!/^[A-Z]{3}$/u.test(currency))
    throw new TypeError("Invalid usage currency");
  return {
    inputTokens: usageInteger(value.inputTokens),
    outputTokens: usageInteger(value.outputTokens),
    costMicros: usageInteger(value.costMicros),
    currency,
  };
}

function ledgerSnapshot(input: unknown): Ledger {
  const value = object(input);
  keys(value, [
    "policyHash",
    "accountingHold",
    "spentMicros",
    "observedAt",
    "reservations",
  ]);
  if (typeof value.policyHash !== "string" || !HASH.test(value.policyHash))
    throw new TypeError("Invalid usage policy binding");
  if (typeof value.accountingHold !== "boolean")
    throw new TypeError("Invalid usage accounting hold");
  if (
    typeof value.spentMicros !== "string" ||
    !/^(0|[1-9][0-9]{0,17})$/u.test(value.spentMicros) ||
    BigInt(value.spentMicros) > MAX_SPENT
  )
    throw new TypeError("Invalid cumulative usage");
  const observedAt = value.observedAt as string;
  const observed = timestamp(observedAt);
  if (
    !Array.isArray(value.reservations) ||
    value.reservations.length > MAX_RESERVATIONS
  )
    throw new TypeError("Invalid reservation capacity");
  const reservationIds = new Set<string>();
  const attemptIds = new Set<string>();
  const reservations = value.reservations.map((input): Reservation => {
    const entry = object(input);
    keys(entry, [
      "reservationHash",
      "attemptHash",
      "identityHash",
      "bindingHash",
      "reservedMicros",
      "deadline",
      "createdAt",
      "state",
      "terminalAt",
      "usage",
    ]);
    for (const name of [
      "reservationHash",
      "attemptHash",
      "identityHash",
      "bindingHash",
    ])
      if (typeof entry[name] !== "string" || !HASH.test(entry[name] as string))
        throw new TypeError("Invalid reservation binding");
    const reservationHash = entry.reservationHash as string;
    const attemptHash = entry.attemptHash as string;
    if (reservationIds.has(reservationHash) || attemptIds.has(attemptHash))
      throw new TypeError("Duplicate usage reservation");
    reservationIds.add(reservationHash);
    attemptIds.add(attemptHash);
    const created = timestamp(entry.createdAt);
    const deadline = timestamp(entry.deadline);
    if (created > observed || deadline <= created)
      throw new TypeError("Invalid reservation interval");
    const state = entry.state;
    if (
      state !== "reserved" &&
      state !== "unknown" &&
      state !== "known" &&
      state !== "not_called"
    )
      throw new TypeError("Invalid reservation state");
    const terminal = state === "known" || state === "not_called";
    if (terminal) {
      const settled = timestamp(entry.terminalAt);
      if (settled < created || settled > observed)
        throw new TypeError("Invalid usage settlement time");
    } else if (entry.terminalAt !== null) {
      throw new TypeError("Uncertain usage cannot expire");
    }
    const usage = state === "known" ? usageSnapshot(entry.usage) : null;
    if (state !== "known" && entry.usage !== null)
      throw new TypeError("Invalid usage settlement");
    return {
      reservationHash,
      attemptHash,
      identityHash: entry.identityHash as string,
      bindingHash: entry.bindingHash as string,
      reservedMicros: usageInteger(entry.reservedMicros, 1),
      deadline: entry.deadline as string,
      createdAt: entry.createdAt as string,
      state,
      terminalAt: entry.terminalAt as string | null,
      usage,
    };
  });
  return {
    policyHash: value.policyHash,
    accountingHold: value.accountingHold,
    spentMicros: value.spentMicros,
    observedAt,
    reservations,
  };
}

async function hash(input: string): Promise<string> {
  const result = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return Array.from(new Uint8Array(result), (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("");
}

async function identityBinding(input: UsageIdentity) {
  const values = [
    usageText(input.operationId),
    usageText(input.attemptId),
    usageText(input.inputFingerprint),
    usageText(input.usageReservationId),
  ];
  const [reservationHash, attemptHash, identityHash] = await Promise.all([
    hash(JSON.stringify(["reservation", values[3]])),
    hash(JSON.stringify(["attempt", values[0], values[1]])),
    hash(JSON.stringify(["identity", ...values])),
  ]);
  return { reservationHash, attemptHash, identityHash };
}

function sameUsage(
  a: AssistantModelUsage | null,
  b: AssistantModelUsage,
): boolean {
  return (
    a !== null &&
    a.currency === b.currency &&
    a.inputTokens === b.inputTokens &&
    a.outputTokens === b.outputTokens &&
    a.costMicros === b.costMicros
  );
}

function observationSnapshot(
  input: AssistantUsageObservation,
): AssistantUsageObservation {
  const value = object(input);
  if (value.state === "not_called" || value.state === "unknown") {
    keys(value, ["state"]);
    return { state: value.state };
  }
  if (value.state !== "known") throw new TypeError("Invalid usage observation");
  keys(value, ["state", "usage"]);
  return { state: "known", usage: usageSnapshot(value.usage) };
}

/**
 * One fixed physical head, at most 32 entries and one update(maxAttempts:2) per
 * operation. No enumeration, cleanup job, external calls or paid retry lives in
 * its decider. Unknown/reserved entries never age out. Terminal identities stay
 * for the entire immutable admission window, even when deadline+retention has
 * elapsed. Exhausting the finite slots refuses more work; it never compacts
 * identities to fund another attempt. After the window closes, a settlement
 * may prune other expired terminal records, without reopening admission or
 * reducing cumulative spend. Exact historical ACKs grant no new credit.
 *
 * The pool is immutable: a changed scope/version/price/window/cap is refused,
 * never a reset of cumulative spend. This slice deliberately has no top-up or
 * rotation API. A policy window is not a timer that replenishes the pool.
 */
export function createSupportModelUsageLedger<
  Context extends UsageContext,
  Identity,
>(
  options: SupportModelUsageOptions,
  schema: UsageSchema<Context, Identity>,
): UsagePort<Context, Identity> {
  const KEY = Object.freeze({ ...schema.key });
  const records = defineCollection<Ledger>({
    name: schema.collection,
    key: () => KEY,
    codec: {
      encode(value) {
        const record = {
          ...KEY,
          format: 1,
          payload: JSON.stringify(ledgerSnapshot(value)),
        };
        if (
          new TextEncoder().encode(JSON.stringify(record)).byteLength >
          MAX_RECORD_BYTES
        )
          throw new TypeError("Assistant usage record capacity exceeded");
        return record;
      },
      decode(value) {
        if (
          value.partition !== KEY.partition ||
          value.id !== KEY.id ||
          value.format !== 1 ||
          typeof value.payload !== "string" ||
          new TextEncoder().encode(JSON.stringify(value)).byteLength >
            MAX_RECORD_BYTES
        )
          throw new TypeError("Invalid assistant usage record");
        keys(value, ["partition", "id", "format", "payload"]);
        return ledgerSnapshot(JSON.parse(value.payload));
      },
    },
  });

  const policy =
    options.policy === undefined ? undefined : policySnapshot(options.policy);
  const policyJson = policy === undefined ? "" : JSON.stringify(policy);
  const active = (now: number) =>
    policy !== undefined &&
    now >= timestamp(policy.validFrom) &&
    now < timestamp(policy.validUntil);
  const sampled = () => {
    const at = options.clock.now();
    return { at, milliseconds: timestamp(at) };
  };
  const checkedHead = (
    current: Ledger | null,
    policyHash: string,
    now: number,
  ) => {
    if (
      current !== null &&
      (current.policyHash !== policyHash || now < timestamp(current.observedAt))
    )
      throw new TypeError("Assistant usage policy or clock changed");
    if (current !== null && policy !== undefined) {
      const known = current.reservations.reduce(
        (total, entry) =>
          total + (entry.usage === null ? 0n : BigInt(entry.usage.costMicros)),
        0n,
      );
      if (
        current.reservations.length > policy.maxReservations ||
        known > BigInt(current.spentMicros) ||
        current.reservations.some(
          (entry) =>
            entry.reservedMicros !== policy.maxReservationCostMicros ||
            timestamp(entry.createdAt) < timestamp(policy.validFrom) ||
            timestamp(entry.createdAt) >= timestamp(policy.validUntil) ||
            timestamp(entry.deadline) > timestamp(policy.validUntil) ||
            (entry.usage !== null && entry.usage.currency !== policy.currency),
        )
      )
        throw new TypeError("Assistant usage accounting is invalid");
    }
  };
  return Object.freeze({
    async reserve(
      context: Context,
    ): ReturnType<UsagePort<Context, Identity>["reserve"]> {
      if (policy === undefined) return { outcome: "unavailable" };
      try {
        const initial = sampled();
        const deadlineText = context.deadline;
        const deadline = timestamp(deadlineText);
        const signal = context.signal;
        const identityInput: UsageIdentity = {
          operationId: usageText(context.operationId),
          attemptId: usageText(context.attemptId),
          inputFingerprint: usageText(context.inputFingerprint),
          usageReservationId: usageText(context.usageReservationId),
        };
        if (
          context.purpose !== schema.purpose ||
          !active(initial.milliseconds) ||
          signal.aborted ||
          deadline <= initial.milliseconds ||
          deadline > timestamp(policy.validUntil) ||
          context.usageScopeRef !== policy.scopeRef ||
          context.configurationVersion !== policy.configurationVersion ||
          context.modelVersion !== policy.modelVersion ||
          context.budgets.currency !== policy.currency ||
          context.budgets.maxCostMicros < 1 ||
          context.budgets.maxCostMicros > policy.maxReservationCostMicros
        )
          return { outcome: "denied" };
        if (!Number.isSafeInteger(context.budgets.maxCostMicros))
          return { outcome: schema.invalidBudgetOutcome ?? "denied" };
        const snapshot = schema.binding(context);
        if (snapshot === undefined) return { outcome: "denied" };
        const [identity, policyHash] = await Promise.all([
          identityBinding(identityInput),
          hash(policyJson),
        ]);
        const bindingHash = await hash(
          JSON.stringify([identity.identityHash, policyHash, snapshot]),
        );
        const result = await options.store.collection(records).update(
          KEY,
          (current) => {
            const now = sampled();
            checkedHead(current, policyHash, now.milliseconds);
            if (
              !active(now.milliseconds) ||
              signal.aborted ||
              deadline <= now.milliseconds
            )
              return { action: "keep" };
            if (current?.accountingHold) return { action: "keep" };
            const existing = current?.reservations.find(
              (entry) =>
                entry.reservationHash === identity.reservationHash ||
                entry.attemptHash === identity.attemptHash,
            );
            if (existing !== undefined) return { action: "keep" };
            const retained = current?.reservations ?? [];
            const spent = BigInt(current?.spentMicros ?? "0");
            const held = retained.reduce(
              (total, entry) =>
                total +
                (entry.state === "reserved" || entry.state === "unknown"
                  ? BigInt(entry.reservedMicros)
                  : 0n),
              0n,
            );
            if (
              retained.length >= policy.maxReservations ||
              spent + held + BigInt(policy.maxReservationCostMicros) >
                BigInt(policy.maxCostMicros)
            )
              return { action: "keep" };
            return {
              action: "write",
              value: {
                policyHash,
                accountingHold: false,
                spentMicros: spent.toString(),
                observedAt: now.at,
                reservations: [
                  ...retained,
                  {
                    ...identity,
                    bindingHash,
                    reservedMicros: policy.maxReservationCostMicros,
                    deadline: deadlineText,
                    createdAt: now.at,
                    state: "reserved",
                    terminalAt: null,
                    usage: null,
                  },
                ],
              },
            };
          },
          { maxAttempts: 2 },
        );
        const now = sampled();
        checkedHead(result.value, policyHash, now.milliseconds);
        if (
          !active(now.milliseconds) ||
          signal.aborted ||
          deadline <= now.milliseconds
        )
          return { outcome: "unavailable" };
        if (result.value?.accountingHold) return { outcome: "denied" };
        const entry = result.value?.reservations.find(
          (value) => value.reservationHash === identity.reservationHash,
        );
        return entry?.identityHash === identity.identityHash &&
          entry.bindingHash === bindingHash
          ? {
              outcome: "reserved",
              usageReservationId: identityInput.usageReservationId,
            }
          : { outcome: "denied" };
      } catch {
        // A storage/ACK failure cannot establish absence of a committed reserve.
        return { outcome: "unavailable" };
      }
    },

    async reconcile(
      identityInput: Identity,
      input: AssistantUsageObservation,
    ): Promise<"reconciled" | "pending"> {
      if (policy === undefined) return "pending";
      try {
        const observation = observationSnapshot(input);
        if (
          observation.state === "known" &&
          observation.usage.currency !== policy.currency
        )
          return "pending";
        sampled();
        const [identity, policyHash] = await Promise.all([
          identityBinding(schema.identity(identityInput)),
          hash(policyJson),
        ]);
        const result = await options.store.collection(records).update(
          KEY,
          (current) => {
            const now = sampled();
            checkedHead(current, policyHash, now.milliseconds);
            if (current === null) return { action: "keep" };
            const index = current.reservations.findIndex(
              (entry) =>
                entry.reservationHash === identity.reservationHash &&
                entry.identityHash === identity.identityHash,
            );
            if (index < 0) return { action: "keep" };
            const entry = current.reservations[index]!;
            let next: Reservation;
            let spent = BigInt(current.spentMicros);
            if (observation.state === "known") {
              if (entry.state === "known") {
                if (
                  sameUsage(entry.usage, observation.usage) ||
                  current.accountingHold
                )
                  return { action: "keep" };
                // Returning pending alone is insufficient: another ticket could
                // otherwise spend a pool whose accepted accounting is disputed.
                return {
                  action: "write",
                  value: {
                    ...current,
                    accountingHold: true,
                    observedAt: now.at,
                  },
                };
              }
              spent += BigInt(observation.usage.costMicros);
              next = {
                ...entry,
                state: "known",
                usage: observation.usage,
                terminalAt: now.at,
              };
            } else if (observation.state === "unknown") {
              if (entry.state === "known" || entry.state === "unknown")
                return { action: "keep" };
              // A late uncertain observation may restore a previously released hold.
              next = {
                ...entry,
                state: "unknown",
                terminalAt: null,
                usage: null,
              };
            } else {
              // A later failure to call is not proof against an earlier uncertain call.
              if (
                entry.state === "unknown" ||
                entry.state === "known" ||
                entry.state === "not_called"
              )
                return { action: "keep" };
              next = {
                ...entry,
                state: "not_called",
                terminalAt: now.at,
                usage: null,
              };
            }
            return {
              action: "write",
              value: {
                ...current,
                spentMicros: spent.toString(),
                observedAt: now.at,
                reservations: current.reservations
                  .map((value, position) => (position === index ? next : value))
                  .filter(
                    (value) =>
                      current.accountingHold ||
                      value.reservationHash === identity.reservationHash ||
                      value.terminalAt === null ||
                      now.milliseconds < timestamp(policy.validUntil) ||
                      now.milliseconds <
                        timestamp(value.deadline) +
                          policy.terminalRetentionMilliseconds,
                  ),
              },
            };
          },
          { maxAttempts: 2 },
        );
        checkedHead(result.value, policyHash, sampled().milliseconds);
        const entry = result.value?.reservations.find(
          (value) =>
            value.reservationHash === identity.reservationHash &&
            value.identityHash === identity.identityHash,
        );
        const covered =
          entry !== undefined &&
          (observation.state === "known"
            ? entry.state === "known" &&
              sameUsage(entry.usage, observation.usage)
            : observation.state === "not_called"
              ? entry.state === "not_called"
              : entry.state === "unknown" || entry.state === "known");
        return covered && result.value?.accountingHold === false
          ? "reconciled"
          : "pending";
      } catch {
        return "pending";
      }
    },
  });
}
