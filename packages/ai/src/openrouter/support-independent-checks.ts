import { hasPermission, type AccessContext } from "@pegma/authorization-core";
import {
  KnowledgeBaseNotFoundError,
  type KnowledgeBaseApplication,
} from "@pegma/knowledge-base-application";
import type { Clock } from "@pegma/spine";
import { defineCollection, type Store } from "@pegma/storage-core";
import type { EngineeringChecksPort } from "../engineering-ports.js";
import type {
  LearningChecksPort,
  LearningServiceAccessPort,
} from "../learning-ports.js";
import type { LearningKnowledgeAccessPort } from "../learning-integration-types.js";
import {
  engineeringExportChecksBinding,
  engineeringRoutingBinding,
  engineeringRoutingBindingHash,
  engineeringStaffSelectionHash,
  resolutionLearningDeliveryBinding,
  supportPermissions,
  type SupportDeskApplication,
  type EngineeringApplication,
  type ResolutionLearningApplication,
  type EngineeringExportChecksBinding,
  type ResolutionLearningChecksBinding,
  type EngineeringRepositoryMetadataPort,
  type EngineeringPolicyApplication,
} from "@pegma/support-desk-application";
import { z } from "zod";
import { knowledgeDigest, checkedLogicalHost } from "./canonical-digest.js";
import {
  createSupportModelUsageLedger,
  type SupportModelUsagePolicy,
} from "./support-model-usage-ledger.js";
import {
  createSupportIndependentCheckModel,
  INDEPENDENT_CHECK_PURPOSE,
  type IndependentCheckContext,
  type IndependentCheckInput,
  type IndependentCheckModelOptions,
} from "./support-independent-checks-model.js";

type Application = Pick<SupportDeskApplication, "readStaffTicket"> &
  Pick<
    EngineeringApplication,
    "readEngineeringSource" | "readEngineeringWork"
  > &
  Pick<EngineeringPolicyApplication, "readRepositoryPolicy"> &
  Pick<
    ResolutionLearningApplication,
    "readResolutionLearningSource" | "readResolutionLearningWork"
  >;
export interface IndependentCheckScope {
  readonly ticketId: string;
  readonly sourceGeneration: number;
}
export interface IndependentCheckPendingHint {
  readonly kind: "engineering" | "learning";
  readonly operationId: string;
  readonly scope: IndependentCheckScope;
  readonly expiresAt: string;
}
export interface IndependentCheckCapture {
  readonly onDurablyDeferred?: (hint: IndependentCheckPendingHint) => void;
}
export interface IndependentCheckReceiptKey {
  readonly id: string;
  /** Root-owned, purpose-separated HMAC-SHA256 key. Never a provider credential. */
  readonly key: CryptoKey;
  readonly validUntil: string;
}
export interface SupportIndependentChecksOptions extends IndependentCheckModelOptions {
  readonly store: Store;
  readonly application: () => Application;
  readonly authority: LearningServiceAccessPort;
  readonly knowledge?: Pick<KnowledgeBaseApplication, "getDraft">;
  readonly knowledgeAccess?: LearningKnowledgeAccessPort;
  readonly repositories?: EngineeringRepositoryMetadataPort;
  readonly usagePolicy?: SupportModelUsagePolicy;
  readonly readReceiptKey?: () => IndependentCheckReceiptKey | null;
  readonly maxOperationMilliseconds?: number;
  readonly maxReceiptMilliseconds?: number;
  /** Default: SDK check calls persist a bounded private request and return held. */
  readonly deferred?: boolean;
  readonly deferredRetentionMilliseconds?: number;
}
const scalar = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[^\u0000-\u001f\u007f]+$/u);
const hash = z.string().regex(/^[0-9a-f]{64}$/u);
const time = z.string().datetime({ precision: 3 });
const scopeSchema = z
  .object({ ticketId: scalar, sourceGeneration: z.number().int().positive() })
  .strict();
const engineeringBinding = z
  .object({
    sourceBindingHash: hash,
    evidenceFingerprint: hash,
    candidateHash: hash,
    routingBindingHash: hash,
    requestHash: hash,
    policyGeneration: z.number().int().positive(),
    policyHash: hash,
    repositoryMetadataHash: hash,
  })
  .strict();
const learningBinding = z
  .object({
    candidateHash: hash,
    sourceBindingHash: hash,
    policyVersion: scalar,
    applicabilityHash: hash,
    targetDecisionHash: hash,
    requestHash: hash,
  })
  .strict();
const targetSchema = z
  .object({
    articleId: scalar,
    originalGeneration: z.number().int().nonnegative(),
    originalHash: hash.nullable(),
    outboundHash: hash,
  })
  .strict();
const payloadBase = z.object({
  version: z.literal(1),
  keyId: scalar,
  scope: scopeSchema,
  issuerId: scalar,
  authorityVersion: scalar,
  policyVersion: scalar,
  policyBinding: scalar,
  verifierVersion: scalar,
  configurationVersion: scalar,
  promptVersion: scalar,
  modelVersion: scalar,
  routePolicyHash: hash,
  sourceStamp: hash,
  receiptId: hash,
  verifiedAt: time,
  validUntil: time,
});
const payloadSchema = z.discriminatedUnion("kind", [
  payloadBase
    .extend({
      kind: z.literal("engineering"),
      binding: engineeringBinding,
      publicReproduction: z.enum(["passed", "not_applicable"]),
    })
    .strict(),
  payloadBase
    .extend({
      kind: z.literal("learning"),
      binding: learningBinding,
      target: targetSchema,
    })
    .strict(),
]);
type Payload = z.infer<typeof payloadSchema>;
type Binding = EngineeringExportChecksBinding | ResolutionLearningChecksBinding;
type Kind = Payload["kind"];
interface ReceiptHeader {
  readonly operation: string;
  readonly issuer: string;
  readonly verifiedAt: string;
  readonly validUntil: string;
  readonly flag: "p" | "n" | "l";
  readonly signature: Uint8Array<ArrayBuffer>;
}
type Authority = {
  readonly access: AccessContext;
  readonly version: string;
  readonly usageScopeRef: string;
};
type EngineeringInput = Parameters<EngineeringChecksPort["check"]>[0];
type LearningInput = Parameters<LearningChecksPort["check"]>[0];
type Input = EngineeringInput | LearningInput;
const KEY = Object.freeze({
  partition: INDEPENDENT_CHECK_PURPOSE,
  id: "attempts",
});
const entrySchema = z
  .object({
    operation: hash,
    owner: scalar,
    createdAt: time,
    deadline: time,
    kind: z.enum(["engineering", "learning"]),
    scope: scopeSchema,
    expiresAt: time,
    issuerId: scalar,
    authorityVersion: scalar,
    request: z.string().max(48_000).nullable(),
    state: z.enum([
      "queued",
      "claimed",
      "unknown",
      "held",
      "restricted",
      "checked",
    ]),
    receiptBytes: z.number().int().min(1).max(16_000),
    receipt: z.string().max(200).nullable(),
    proof: z.string().max(16_000).nullable(),
  })
  .strict();
const headSchema = z
  .object({
    policyHash: hash,
    observedAt: time,
    entries: z.array(entrySchema).max(32),
  })
  .strict()
  .superRefine((h, ctx) => {
    if (
      new Set(h.entries.map((e) => e.operation)).size !== h.entries.length ||
      h.entries.some(
        (e) =>
          (e.state === "checked") !==
            (e.receipt !== null && e.proof !== null) ||
          (e.state === "queued" && e.request === null) ||
          (e.state !== "checked" && (e.receipt !== null || e.proof !== null)) ||
          (e.proof !== null && e.proof.length > e.receiptBytes) ||
          (["held", "restricted", "checked", "unknown"].includes(e.state) &&
            e.request !== null) ||
          (e.receipt !== null &&
            new TextEncoder().encode(e.receipt).length > e.receiptBytes),
      )
    )
      ctx.addIssue({ code: "custom", message: "Invalid check attempt head" });
  });
type Head = z.infer<typeof headSchema>;
/** One finite funded pool. No automatic expiry, reclaim, rotation or paid retry. */
export const independentCheckAttempts = defineCollection<Head>({
  name: "pegma.support-independent-checks.attempts.v1",
  key: () => KEY,
  codec: {
    encode(value) {
      const checked = headSchema.parse(value);
      const record = { ...KEY, format: 1, payload: JSON.stringify(checked) };
      if (new TextEncoder().encode(JSON.stringify(record)).length > 60_000)
        throw new TypeError("Check attempt capacity");
      return record;
    },
    decode(record) {
      if (
        record.partition !== KEY.partition ||
        record.id !== KEY.id ||
        record.format !== 1 ||
        typeof record.payload !== "string" ||
        Object.keys(record).length !== 4 ||
        new TextEncoder().encode(JSON.stringify(record)).length > 60_000
      )
        throw new TypeError("Invalid check attempt record");
      return headSchema.parse(JSON.parse(record.payload));
    },
  },
});
function b64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}
function unb64(text: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/u.test(text))
    throw new TypeError("Invalid check receipt");
  const result = Uint8Array.from(
    atob(text.replaceAll("-", "+").replaceAll("_", "/")),
    (c) => c.charCodeAt(0),
  );
  if (b64(result) !== text)
    throw new TypeError("Invalid check receipt encoding");
  return result;
}
const bytes = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value));
function plain(value: unknown): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw new TypeError("Invalid check data");
  return value as Record<string, unknown>;
}
function exact(value: unknown, fields: readonly string[]) {
  const result = plain(value);
  if (
    Object.keys(result).length !== fields.length ||
    fields.some((f) => !Object.hasOwn(result, f))
  )
    throw new TypeError("Invalid check data");
  return result;
}
async function equal(a: unknown, b: unknown) {
  return (await knowledgeDigest(a)) === (await knowledgeDigest(b));
}
class Held extends Error {}
function requireCheck(condition: unknown): asserts condition {
  if (!condition) throw new Held("Independent check unavailable");
}

async function redactStoredRequests(
  store: Store,
  clock: Clock,
  selected: (entry: z.infer<typeof entrySchema>, now: number) => boolean,
): Promise<number> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let count = 0;
  try {
    await Promise.race([
      store.collection(independentCheckAttempts).update(
        KEY,
        (current) => {
          count = 0;
          if (!current) return { action: "keep" };
          const now = Date.parse(clock.now());
          requireCheck(Number.isFinite(now));
          const entries = current.entries.map((entry) => {
            if (entry.request === null || !selected(entry, now)) return entry;
            count++;
            return {
              ...entry,
              state:
                entry.state === "claimed"
                  ? ("unknown" as const)
                  : ("held" as const),
              request: null,
            };
          });
          // Redaction grants no authority and never moves admission time backward.
          return count
            ? {
                action: "write",
                value: {
                  ...current,
                  observedAt: new Date(
                    Math.max(now, Date.parse(current.observedAt)),
                  ).toISOString(),
                  entries,
                },
              }
            : { action: "keep" };
        },
        { maxAttempts: 2 },
      ),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Held()), 5_000);
      }),
    ]);
    return count;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Existing nonpaid maintenance can redact expired text after configuration or
 * credentials are removed. No secrets or application instance are needed. */
export function purgeSupportIndependentCheckRequests(options: {
  readonly store: Store;
  readonly clock: Clock;
}): Promise<number> {
  return redactStoredRequests(
    options.store,
    options.clock,
    (entry, now) => now >= Date.parse(entry.expiresAt),
  );
}

/** Uses real authorized domain reads. Does not grant publication or outbound approval. */
export function createSupportIndependentChecks(
  options: SupportIndependentChecksOptions,
  logicalHost: string,
) {
  const host = checkedLogicalHost(logicalHost);
  const model = createSupportIndependentCheckModel(options, host);
  const policy =
    options.usagePolicy === undefined
      ? undefined
      : structuredClone(options.usagePolicy);
  const usage = createSupportModelUsageLedger<
    IndependentCheckContext,
    IndependentCheckContext
  >(
    {
      store: options.store,
      clock: options.clock,
      ...(policy === undefined ? {} : { policy }),
    },
    {
      purpose: INDEPENDENT_CHECK_PURPOSE,
      collection: "pegma.support-independent-checks.usage.v1",
      key: { partition: INDEPENDENT_CHECK_PURPOSE, id: "budget" },
      binding: (c) => c.inputFingerprint,
      identity: (c) => c,
    },
  );
  const operationLimit = options.maxOperationMilliseconds ?? 5_000;
  const receiptLimit = options.maxReceiptMilliseconds ?? 60_000;
  const deferredRetention = options.deferredRetentionMilliseconds ?? 60_000;
  if (
    !Number.isSafeInteger(operationLimit) ||
    operationLimit < 1 ||
    operationLimit > 20_000
  )
    throw new TypeError("Invalid check deadline");
  if (
    !Number.isSafeInteger(receiptLimit) ||
    receiptLimit < 1 ||
    receiptLimit > 300_000
  )
    throw new TypeError("Invalid check receipt lifetime");
  if (
    !Number.isSafeInteger(deferredRetention) ||
    deferredRetention < 1 ||
    deferredRetention > 300_000
  )
    throw new TypeError("Invalid deferred check retention");
  const now = () => {
    const n = Date.parse(options.clock.now());
    requireCheck(Number.isFinite(n));
    return n;
  };
  function key() {
    const k = options.readReceiptKey?.();
    requireCheck(
      k &&
        scalar.safeParse(k.id).success &&
        time.safeParse(k.validUntil).success &&
        Date.parse(k.validUntil) > now() &&
        k.key.type === "secret" &&
        k.key.algorithm.name === "HMAC" &&
        "hash" in k.key.algorithm &&
        (k.key.algorithm.hash as KeyAlgorithm).name === "SHA-256" &&
        k.key.usages.includes("sign") &&
        k.key.usages.includes("verify"),
    );
    return k;
  }
  async function bounded<T>(
    deadline: number,
    outer: AbortSignal | undefined,
    action: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    outer?.addEventListener("abort", abort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      requireCheck(!outer?.aborted && now() < deadline);
      const stopped = new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener("abort", () => reject(new Held()), {
          once: true,
        });
        timer = setTimeout(abort, Math.max(1, deadline - now()));
      });
      return await Promise.race([action(controller.signal), stopped]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      outer?.removeEventListener("abort", abort);
      controller.abort();
    }
  }
  async function authority(
    kind: Kind,
    signal: AbortSignal,
    previous?: Authority,
  ) {
    const resolved = await options.authority.resolve(signal);
    requireCheck(!signal.aborted && resolved.outcome === "ready");
    const a = resolved.authority.access;
    scalar.parse(a.principalId);
    requireCheck(
      hasPermission(a, supportPermissions.queueRead) &&
        hasPermission(
          a,
          kind === "engineering"
            ? supportPermissions.engineeringRead
            : supportPermissions.learningRead,
        ),
    );
    const version = scalar.parse(resolved.authority.authorityVersion);
    const usageScopeRef = scalar.parse(resolved.authority.usageScopeRef);
    if (previous)
      requireCheck(
        a.principalId === previous.access.principalId &&
          version === previous.version &&
          usageScopeRef === previous.usageScopeRef &&
          previous.access.permissions.every((p) => hasPermission(a, p)),
      );
    return { access: a, version, usageScopeRef };
  }
  async function inspect(
    kind: Kind,
    scope: IndependentCheckScope,
    signal: AbortSignal,
    input: Input,
    original?: Authority,
  ) {
    scope = scopeSchema.parse(scope);
    const resolved = await authority(kind, signal, original);
    const access = resolved.access;
    const app = options.application();
    const source =
      kind === "engineering"
        ? await app.readEngineeringSource(access, scope.ticketId)
        : await app.readResolutionLearningSource(access, scope.ticketId);
    requireCheck(
      source.state === "eligible" &&
        source.sourceGeneration === scope.sourceGeneration &&
        source.sourceBindingHash &&
        source.evidenceFingerprint &&
        source.evidence &&
        source.product,
    );
    if ("security" in source) requireCheck(source.security === "ordinary");
    const evidenceUntil =
      "test" in source.evidence
        ? source.evidence.test.validUntil
        : source.product.validUntil;
    const validUntil = new Date(
      Math.min(
        Date.parse(source.product.validUntil),
        Date.parse(evidenceUntil),
      ),
    ).toISOString();
    requireCheck(Date.parse(validUntil) > now());
    const work =
      kind === "engineering"
        ? await app.readEngineeringWork(access, scope)
        : await app.readResolutionLearningWork(access, scope);
    const retained =
      kind === "engineering" &&
      "previousRequest" in input &&
      input.previousRequest !== undefined &&
      "proposal" in work
        ? work.proposal
        : undefined;
    requireCheck(
      work.sourceBindingHash === source.sourceBindingHash &&
        work.candidateHash &&
        (work.candidate || retained) &&
        !["superseded"].includes(work.status),
    );
    const ticket = await app.readStaffTicket(access, scope.ticketId);
    const ids =
      kind === "engineering"
        ? "visibleMessageIds" in source.evidence
          ? source.evidence.visibleMessageIds
          : []
        : "workingSolutionMessageIds" in work
          ? work.workingSolutionMessageIds
          : [];
    const messages = ids.map((id) => {
      const message = ticket.messages.find(
        (m) => m.id === id && m.visibility === "customer",
      );
      requireCheck(message);
      return message.body;
    });
    requireCheck(
      messages.length > 0 &&
        (!work.candidate ||
          (await knowledgeDigest(work.candidate)) === work.candidateHash),
    );
    const product = {
      productId: source.product.productId,
      version: source.product.version,
      buildId: source.product.buildId,
    };
    const facts = {
      product,
      messages,
      evidenceKind: source.evidence.kind,
      ...("expectedBehavior" in source.evidence
        ? {
            expectedBehavior: source.evidence.expectedBehavior,
            actualBehavior: source.evidence.actualBehavior,
            reproductionSteps: source.evidence.reproductionSteps,
          }
        : {}),
    };
    const sourceStamp = await knowledgeDigest({
      sourceBindingHash: source.sourceBindingHash,
      evidenceFingerprint: source.evidenceFingerprint,
      candidateHash: work.candidateHash,
      facts,
    });
    let outbound: unknown;
    let comparison: unknown;
    let target: z.infer<typeof targetSchema> | undefined;
    if (input) {
      requireCheck(
        input.binding.sourceBindingHash === source.sourceBindingHash &&
          input.binding.candidateHash === work.candidateHash,
      );
      if ("candidate" in input && input.candidate !== undefined)
        requireCheck(await equal(input.candidate, work.candidate));
    }
    if (kind === "engineering") {
      requireCheck(
        work.candidate
          ? "security" in work.candidate &&
              work.candidate.security === "ordinary"
          : retained,
      );
      const currentPolicy = await app.readRepositoryPolicy(access);
      const binding = input.binding;
      requireCheck(
        binding &&
          "policyHash" in binding &&
          binding.policyGeneration === currentPolicy.generation &&
          binding.policyHash === currentPolicy.policyHash &&
          currentPolicy.policy.enabled,
      );
      if (input) {
        const value = input as EngineeringInput;
        const request = value.exactRequest;
        if (value.previousRequest !== undefined)
          requireCheck(
            "proposal" in work &&
              work.proposal &&
              (await equal(value.previousRequest, work.proposal.request)),
          );
        const descriptor = currentPolicy.policy.repositories.find(
          (r) => r.repositoryId === request.repository.repositoryId,
        );
        requireCheck(descriptor?.enabled && options.repositories);
        const metadata = await options.repositories.resolve(
          request.repository.repositoryId,
          signal,
        );
        requireCheck(
          metadata &&
            (await equal(metadata, request.repository)) &&
            metadata.owner === descriptor.owner &&
            metadata.name === descriptor.name &&
            metadata.visibility === descriptor.visibility,
        );
        let routingHash: string;
        if (retained) {
          requireCheck(
            retained.policyGeneration === currentPolicy.generation &&
              retained.policyHash === currentPolicy.policyHash,
          );
          routingHash = retained.routingBindingHash;
        } else if ("staffSelection" in work && work.staffSelection) {
          requireCheck(
            work.staffSelection.policyGeneration === currentPolicy.generation &&
              work.staffSelection.policyHash === currentPolicy.policyHash &&
              work.staffSelection.repositoryId === descriptor.repositoryId,
          );
          routingHash = await engineeringStaffSelectionHash(
            work.staffSelection,
          );
        } else {
          const last = work.modelAttempts.at(-1);
          requireCheck(
            last &&
              "parserVersion" in last.binding &&
              work.candidate &&
              "routing" in work.candidate &&
              work.candidate.routing.outcome === "selected" &&
              work.candidate.routing.repositoryId === descriptor.repositoryId,
          );
          routingHash = await engineeringRoutingBindingHash(
            await engineeringRoutingBinding({
              sourceBindingHash: source.sourceBindingHash,
              evidenceFingerprint: source.evidenceFingerprint,
              candidateHash: work.candidateHash,
              inputFingerprint: last.binding.inputFingerprint,
              routing: work.candidate.routing,
              policyGeneration: currentPolicy.generation,
              policyHash: currentPolicy.policyHash,
              modelVersion: last.binding.modelVersion,
              promptVersion: last.binding.promptVersion,
              parserVersion: last.binding.parserVersion,
              repositoryId: descriptor.repositoryId,
            }),
          );
        }
        requireCheck(
          await equal(
            value.binding,
            await engineeringExportChecksBinding({
              sourceBindingHash: source.sourceBindingHash,
              evidenceFingerprint: source.evidenceFingerprint,
              candidateHash: work.candidateHash,
              routingBindingHash: routingHash,
              exactRequest: request,
              policyGeneration: currentPolicy.generation,
              policyHash: currentPolicy.policyHash,
            }),
          ),
        );
        // Preserve every outbound byte, including hidden Markdown, labels and templates.
        outbound = request.bundle;
        comparison = {
          operation: request.operation,
          repository: {
            owner: descriptor.owner,
            name: descriptor.name,
            visibility: descriptor.visibility,
            responsibilities: descriptor.responsibilities,
          },
        };
      }
    } else {
      requireCheck(options.knowledge && options.knowledgeAccess);
      const value = input as LearningInput;
      const r = value.exactRequest;
      const articleId = r.articleId;
      const originalGeneration = r.originalExpectedGeneration;
      const payload = exact(JSON.parse(r.draftPayload), [
        "draft",
        "scope",
        "configurationHash",
        "policyBinding",
        "requirements",
        "base",
      ]);
      requireCheck(
        (await equal(value.workingSolution, messages)) &&
          value.targetComparison.operation === r.operation,
      );
      requireCheck(
        await equal(
          value.binding,
          await resolutionLearningDeliveryBinding({
            candidateHash: work.candidateHash,
            sourceBindingHash: source.sourceBindingHash,
            policyVersion: value.binding.policyVersion,
            targetDecisionHash: value.binding.targetDecisionHash,
            applicability: value.candidate.applicability,
            exactRequest: r,
          }),
        ),
      );
      // Validate structural metadata locally; send all authored draft fields, never source/proof IDs.
      const draft = exact(payload.draft, [
        "kind",
        "title",
        "summary",
        "content",
        "tags",
        "applicability",
      ]);
      requireCheck(
        await equal(draft.applicability, {
          productId: product.productId,
          productVersion: product.version,
          buildId: product.buildId,
        }),
      );
      const references = r.sourceReferences;
      requireCheck(
        references.length > 0 &&
          references.some(
            (ref) =>
              ref.id === source.sourceId &&
              ref.system === "pegma.support-desk" &&
              ref.resourceId === scope.ticketId &&
              ref.version === source.sourceBindingHash,
          ),
      );
      outbound = {
        operation: r.operation,
        draft,
        requirements: payload.requirements,
      };
      const outgoingHash = await knowledgeDigest(draft);
      const ka = await options.knowledgeAccess.resolve(signal);
      requireCheck(ka.outcome === "ready");
      let originalHash: string | null = null;
      let existing: unknown;
      try {
        const current = await options.knowledge.getDraft(ka.authority.access, {
          articleId,
        });
        const r = current.revision;
        existing = {
          kind: r.kind,
          title: r.title,
          summary: r.summary,
          content: r.content,
          tags: r.tags,
          applicability: r.applicability,
        };
        const currentHash = await knowledgeDigest(existing);
        requireCheck(
          current.generation === originalGeneration && originalGeneration > 0,
        );
        originalHash = currentHash;
      } catch (error) {
        if (
          !(error instanceof KnowledgeBaseNotFoundError) ||
          originalGeneration !== 0
        )
          throw error;
      }
      if (value)
        requireCheck(
          value.targetComparison.existingDraft === undefined
            ? originalHash === null
            : originalHash !== null &&
                (await equal(
                  JSON.parse(value.targetComparison.existingDraft),
                  existing,
                )),
        );
      target = {
        articleId,
        originalGeneration,
        originalHash,
        outboundHash: outgoingHash,
      };
      comparison = existing;
      const freshKA = await options.knowledgeAccess.resolve(signal);
      requireCheck(
        freshKA.outcome === "ready" &&
          freshKA.authority.access.principalId ===
            ka.authority.access.principalId &&
          freshKA.authority.authorityVersion ===
            ka.authority.authorityVersion &&
          ka.authority.access.permissions.every((p) =>
            hasPermission(freshKA.authority.access, p),
          ),
      );
    }
    await authority(kind, signal, resolved);
    requireCheck(!signal.aborted && Date.parse(validUntil) > now());
    const privateValues = [
      ticket.ticket.requester.principalId,
      ticket.ticket.requester.email,
      ...ticket.messages
        .filter((m) => m.visibility === "internal")
        .map((m) => m.body),
      source.sourceId,
      source.proofIdentity,
    ].filter((v): v is string => typeof v === "string" && v.length > 0);
    if (input)
      requireCheck(
        !privateValues.some((v) => JSON.stringify(outbound).includes(v)),
      );
    return {
      sourceStamp,
      facts,
      candidate: work.candidate ?? { retainedDraft: retained!.request.bundle },
      outbound,
      comparison,
      target,
      validUntil,
      workDeadline: work.deadline,
      authority: resolved,
    };
  }
  function currentFence(
    k: IndependentCheckReceiptKey,
    version: string,
    deadline: number,
    signal: AbortSignal,
  ) {
    const current = key();
    requireCheck(
      !signal.aborted &&
        now() < deadline &&
        current.id === k.id &&
        current.key === k.key &&
        model.currentRoute(version),
    );
  }
  function header(receipt: string): ReceiptHeader {
    requireCheck(typeof receipt === "string" && receipt.length <= 200);
    const parts = receipt.split(".");
    requireCheck(parts.length === 7 && parts[0] === "ic2");
    const operation = hash.parse(parts[1]);
    const issuer = parts[2]!;
    requireCheck(unb64(issuer).length === 32);
    const instant = (value: string) => {
      requireCheck(/^[0-9a-z]{1,11}$/u.test(value));
      const milliseconds = Number.parseInt(value, 36);
      requireCheck(
        Number.isSafeInteger(milliseconds) &&
          milliseconds >= 0 &&
          milliseconds.toString(36) === value,
      );
      return time.parse(new Date(milliseconds).toISOString());
    };
    const verifiedAt = instant(parts[3]!);
    const validUntil = instant(parts[4]!);
    const flag = z.enum(["p", "n", "l"]).parse(parts[5]);
    const signature = unb64(parts[6]!);
    requireCheck(
      signature.length === 32 &&
        Date.parse(verifiedAt) <= now() &&
        now() < Date.parse(validUntil) &&
        Date.parse(verifiedAt) < Date.parse(validUntil),
    );
    return { operation, issuer, verifiedAt, validUntil, flag, signature };
  }
  async function issuerBinding(issuerId: string, authorityVersion: string) {
    const digest = await knowledgeDigest({
      purpose: INDEPENDENT_CHECK_PURPOSE,
      issuerId,
      authorityVersion,
    });
    return b64(
      Uint8Array.from({ length: 32 }, (_, i) =>
        Number.parseInt(digest.slice(i * 2, i * 2 + 2), 16),
      ),
    );
  }
  function macInput(
    kind: Kind,
    binding: Binding,
    h: Omit<ReceiptHeader, "signature">,
    configured: NonNullable<Awaited<ReturnType<typeof model.resolve>>>,
    current: IndependentCheckReceiptKey,
  ) {
    requireCheck(
      kind === "engineering"
        ? h.flag === "p" || h.flag === "n"
        : h.flag === "l",
    );
    return bytes({
      domain: `${host}.support-independent-checks.v2`,
      purpose: INDEPENDENT_CHECK_PURPOSE,
      kind,
      operationId: h.operation,
      issuerBinding: h.issuer,
      binding:
        kind === "engineering"
          ? engineeringBinding.parse(binding)
          : learningBinding.parse(binding),
      keyId: current.id,
      policyVersion: configured.policy.version,
      policyBinding: configured.policy.binding,
      configurationVersion: configured.configuration.version,
      promptVersion: configured.configuration.promptVersion,
      modelVersion: configured.configuration.modelVersion,
      verifierVersion: configured.configuration.parserVersion,
      routePolicyHash: model.currentRoute(configured.configuration.version)!
        .approval.requestPolicySha256,
      verifiedAt: h.verifiedAt,
      validUntil: h.validUntil,
      result:
        kind === "engineering"
          ? {
              privacy: "passed",
              factual: "passed",
              security: "clear",
              publicReproduction: h.flag === "p" ? "passed" : "not_applicable",
            }
          : {
              privacy: "passed",
              factual: "passed",
              applicability: "passed",
              duplication: "passed",
            },
    });
  }
  async function currentSource(
    p: Payload,
    signal: AbortSignal,
    original?: Authority,
  ) {
    const resolved = await authority(p.kind, signal, original);
    const access = resolved.access;
    requireCheck(
      access.principalId === p.issuerId &&
        resolved.version === p.authorityVersion,
    );
    const app = options.application();
    const source =
      p.kind === "engineering"
        ? await app.readEngineeringSource(access, p.scope.ticketId)
        : await app.readResolutionLearningSource(access, p.scope.ticketId);
    requireCheck(
      source.state === "eligible" &&
        source.sourceGeneration === p.scope.sourceGeneration &&
        source.sourceBindingHash === p.binding.sourceBindingHash &&
        source.product &&
        Date.parse(source.product.validUntil) > now(),
    );
    requireCheck(
      source.evidence &&
        (!("test" in source.evidence) ||
          Date.parse(source.evidence.test.validUntil) > now()),
    );
    if (p.kind === "engineering")
      requireCheck(
        "security" in source &&
          source.security === "ordinary" &&
          source.evidenceFingerprint === p.binding.evidenceFingerprint,
      );
    await authority(p.kind, signal, resolved);
    return resolved;
  }
  async function verify(
    kind: Kind,
    receipt: string,
    binding: Binding,
    outer?: AbortSignal,
    scope?: IndependentCheckScope,
    known?: z.infer<typeof entrySchema>,
    sourceRead = true,
  ) {
    try {
      return await bounded(now() + operationLimit, outer, async (signal) => {
        const h = header(receipt);
        const k = key();
        const configured = await model.resolve(undefined, signal);
        requireCheck(
          configured &&
            Date.parse(h.validUntil) <=
              Math.min(
                Date.parse(k.validUntil),
                Date.parse(configured.policy.validUntil),
              ),
        );
        requireCheck(
          await crypto.subtle.verify(
            "HMAC",
            k.key,
            h.signature,
            macInput(kind, binding, h, configured, k),
          ),
        );
        if (scope)
          requireCheck(
            h.operation ===
              (await knowledgeDigest({
                kind,
                scope,
                binding,
                policyVersion: configured.policy.version,
                policyBinding: configured.policy.binding,
              })),
          );
        // Exact request/candidate/target and final opaque versions remain the SDK's
        // current commit fences. Reuse does not re-run paid checks or hydrate them.
        if (sourceRead) {
          const entry =
            known ??
            (
              await options.store.collection(independentCheckAttempts).get(KEY)
            )?.entries.find((e) => e.operation === h.operation);
          requireCheck(
            entry?.state === "checked" &&
              entry.receipt === receipt &&
              entry.proof,
          );
          const p = payloadSchema.parse(
            JSON.parse(
              new TextDecoder("utf-8", { fatal: true }).decode(
                unb64(entry.proof),
              ),
            ),
          );
          requireCheck(
            p.kind === kind &&
              p.keyId === k.id &&
              (await equal(p.binding, binding)) &&
              p.receiptId === h.operation &&
              p.verifiedAt === h.verifiedAt &&
              p.validUntil === h.validUntil &&
              p.policyVersion === configured.policy.version &&
              p.policyBinding === configured.policy.binding &&
              p.configurationVersion === configured.configuration.version &&
              p.promptVersion === configured.configuration.promptVersion &&
              p.modelVersion === configured.configuration.modelVersion &&
              p.verifierVersion === configured.configuration.parserVersion &&
              p.routePolicyHash ===
                model.currentRoute()!.approval.requestPolicySha256 &&
              (await issuerBinding(p.issuerId, p.authorityVersion)) ===
                h.issuer &&
              (await knowledgeDigest({
                kind,
                scope: p.scope,
                binding,
                policyVersion: p.policyVersion,
                policyBinding: p.policyBinding,
              })) === h.operation &&
              (p.kind !== "engineering" ||
                p.publicReproduction ===
                  (h.flag === "p" ? "passed" : "not_applicable")),
          );
          await currentSource(p, signal);
        }
        currentFence(
          k,
          configured.configuration.version,
          Math.min(
            Date.parse(h.validUntil),
            Date.parse(configured.policy.validUntil),
          ),
          signal,
        );
        return {
          kind,
          publicReproduction:
            h.flag === "p" ? ("passed" as const) : ("not_applicable" as const),
          metadata: {
            binding: structuredClone(binding),
            privacy: "passed" as const,
            factual: "passed" as const,
            verifierReceiptId: h.operation,
            verifierVersion: configured.configuration.parserVersion,
            verifiedAt: h.verifiedAt,
            validUntil: h.validUntil,
          },
        };
      });
    } catch {
      return null;
    }
  }
  async function check(
    kind: Kind,
    scope: IndependentCheckScope,
    raw: Input,
    external: { deadline: string; signal: AbortSignal },
    queued?: z.infer<typeof entrySchema>,
    admission?: () => boolean,
  ) {
    let owner: string | undefined;
    let operation: string | undefined;
    let context: IndependentCheckContext | undefined;
    let called = false;
    let accounted = false;
    let committing = false;
    const records = options.store.collection(independentCheckAttempts);
    async function settle(
      state: "unknown" | "held" | "restricted" | "checked",
      receipt: string | null = null,
      proof: string | null = null,
    ) {
      if (!owner || !operation) return;
      const result = await records.update(
        KEY,
        (current) => {
          requireCheck(current);
          const found = current.entries.find((e) => e.operation === operation);
          if (
            !found ||
            found.owner !== owner ||
            found.state === "checked" ||
            (state === "checked" && found.state !== "claimed")
          )
            return { action: "keep" };
          requireCheck(now() >= Date.parse(current.observedAt));
          return {
            action: "write",
            value: {
              ...current,
              observedAt: options.clock.now(),
              entries: current.entries.map((e) =>
                e === found
                  ? { ...e, state, receipt, proof, request: null }
                  : e,
              ),
            },
          };
        },
        { maxAttempts: 2 },
      );
      return (
        state !== "checked" ||
        result.value?.entries.some(
          (e) =>
            e.operation === operation &&
            e.owner === owner &&
            e.state === "checked" &&
            e.receipt === receipt,
        )
      );
    }
    try {
      const deadline = Math.min(
        Date.parse(time.parse(external.deadline)),
        now() + operationLimit,
      );
      return await bounded(deadline, external.signal, async (signal) => {
        requireCheck(policy);
        requireCheck(!admission || admission() === true);
        const configured = await model.resolve(undefined, signal);
        requireCheck(configured);
        const k = key();
        const input = structuredClone(raw);
        const binding =
          kind === "engineering"
            ? engineeringBinding.parse(input.binding)
            : learningBinding.parse(input.binding);
        requireCheck(
          kind === "engineering"
            ? "checkPolicyVersion" in input &&
                input.checkPolicyVersion === configured.policy.version
            : "policyVersion" in binding &&
                binding.policyVersion === configured.policy.version,
        );
        const initial = await inspect(kind, scope, signal, input);
        requireCheck(
          initial.authority.usageScopeRef === configured.usageScopeRef,
        );
        if (queued)
          requireCheck(
            initial.authority.access.principalId === queued.issuerId &&
              initial.authority.version === queued.authorityVersion,
          );
        const modelInput: IndependentCheckInput = {
          trustedInstructions: configured.configuration.trustedInstructions,
          kind,
          facts: initial.facts,
          candidate: initial.candidate,
          outbound: initial.outbound,
          ...(initial.comparison === undefined
            ? {}
            : { comparison: initial.comparison }),
        };
        requireCheck(model.withinBudget(modelInput, configured.configuration));
        const inputFingerprint = await knowledgeDigest(modelInput);
        operation = await knowledgeDigest({
          kind,
          scope,
          binding,
          policyVersion: configured.policy.version,
          policyBinding: configured.policy.binding,
        });
        if (queued) requireCheck(operation === queued.operation);
        const terminalDeadline = Math.min(
          deadline,
          Date.parse(configured.policy.validUntil),
          Date.parse(k.validUntil),
          Date.parse(initial.validUntil),
          Date.parse(initial.workDeadline),
          Date.parse(policy.validUntil),
          queued ? Date.parse(queued.expiresAt) : Infinity,
        );
        requireCheck(terminalDeadline > now());
        const receiptTime = new Date(
          Math.min(
            now() + receiptLimit,
            Date.parse(configured.policy.validUntil),
            Date.parse(k.validUntil),
            Date.parse(initial.validUntil),
            Date.parse(policy.validUntil),
          ),
        ).toISOString();
        const common = {
          version: 1 as const,
          keyId: k.id,
          scope,
          issuerId: initial.authority.access.principalId,
          authorityVersion: initial.authority.version,
          policyVersion: configured.policy.version,
          policyBinding: configured.policy.binding,
          verifierVersion: configured.configuration.parserVersion,
          configurationVersion: configured.configuration.version,
          promptVersion: configured.configuration.promptVersion,
          modelVersion: configured.configuration.modelVersion,
          routePolicyHash: model.currentRoute(configured.configuration.version)!
            .approval.requestPolicySha256,
          sourceStamp: initial.sourceStamp,
          receiptId: operation,
          verifiedAt: options.clock.now(),
          validUntil: receiptTime,
        };
        const template =
          kind === "engineering"
            ? payloadSchema.parse({
                ...common,
                kind,
                binding,
                publicReproduction: "not_applicable",
              })
            : payloadSchema.parse({
                ...common,
                kind,
                binding,
                target: initial.target,
              });
        const receiptBytes = 7 + Math.ceil(bytes(template).length / 3) * 4 + 43;
        owner = crypto.randomUUID();
        const policyHash = await knowledgeDigest(policy);
        const proposed = {
          operation,
          owner,
          createdAt: options.clock.now(),
          deadline: receiptTime,
          kind,
          scope,
          expiresAt: receiptTime,
          issuerId: initial.authority.access.principalId,
          authorityVersion: initial.authority.version,
          request: null,
          state: "claimed" as const,
          receiptBytes,
          receipt: null,
          proof: null,
        };
        const claim = await records.update(
          KEY,
          (current) => {
            requireCheck(
              !signal.aborted &&
                now() < terminalDeadline &&
                (!current ||
                  (current.policyHash === policyHash &&
                    Date.parse(current.observedAt) <= now())),
            );
            const existing = current?.entries.find(
              (e) => e.operation === operation,
            );
            if (existing) {
              if (
                !queued ||
                existing.state !== "queued" ||
                existing.owner !== queued.owner
              )
                return { action: "keep" };
              requireCheck(
                Date.parse(existing.expiresAt) > now() &&
                  receiptBytes <= existing.receiptBytes,
              );
              return {
                action: "write",
                value: {
                  ...current!,
                  observedAt: options.clock.now(),
                  entries: current!.entries.map((e) =>
                    e === existing
                      ? {
                          ...existing,
                          owner: owner!,
                          state: "claimed" as const,
                          deadline: new Date(terminalDeadline).toISOString(),
                          receiptBytes,
                        }
                      : e,
                  ),
                },
              };
            }
            requireCheck(
              (current?.entries.length ?? 0) < policy.maxReservations,
            );
            const next = {
              policyHash,
              observedAt: options.clock.now(),
              entries: [...(current?.entries ?? []), proposed],
            };
            // Reserve the eventual full receipt envelope for every admitted attempt.
            independentCheckAttempts.codec.encode({
              ...next,
              entries: next.entries.map((e) => ({
                ...e,
                state: "checked",
                request: null,
                proof: "x".repeat(e.receiptBytes),
                receipt: "x".repeat(200),
              })),
            });
            return { action: "write", value: next };
          },
          { maxAttempts: 2 },
        );
        const owned = claim.value?.entries.find(
          (e) => e.operation === operation,
        );
        requireCheck(owned);
        if (owned.owner !== owner) {
          if (kind === "engineering" && owned.state === "restricted")
            return { outcome: "restricted" as const };
          if (
            owned.state === "checked" &&
            owned.receipt &&
            (await verify(kind, owned.receipt, binding, signal, scope, owned))
          )
            return { outcome: "checked" as const, receipt: owned.receipt };
          return { outcome: "held" as const };
        }
        context = {
          purpose: INDEPENDENT_CHECK_PURPOSE,
          configurationVersion: configured.configuration.version,
          promptVersion: configured.configuration.promptVersion,
          modelVersion: configured.configuration.modelVersion,
          usageScopeRef: configured.usageScopeRef,
          deadline: new Date(terminalDeadline).toISOString(),
          signal,
          budgets: configured.configuration.budgets,
          operationId: operation,
          attemptId: owner,
          inputFingerprint,
          usageReservationId: "independent-check:" + operation,
          ...(admission === undefined ? {} : { current: admission }),
          onPhysicalCall: () => {
            called = true;
          },
          async beforePhysicalCall(physicalSignal) {
            // After synchronous key capture, resolve current facts/authority,
            // then hand a synchronous final fence to the actual transport.
            const active = await currentSource(
              template,
              physicalSignal,
              initial.authority,
            );
            if (kind === "engineering") {
              const latestPolicy = await options
                .application()
                .readRepositoryPolicy(active.access);
              requireCheck(
                "policyHash" in binding &&
                  latestPolicy.policy.enabled &&
                  latestPolicy.generation === binding.policyGeneration &&
                  latestPolicy.policyHash === binding.policyHash,
              );
            }
            await authority(kind, physicalSignal, active);
            return () => {
              requireCheck(!admission || admission() === true);
              currentFence(
                k,
                configured.configuration.version,
                terminalDeadline,
                physicalSignal,
              );
              return true;
            };
          },
        };
        const reservation = await usage.reserve(context);
        requireCheck(reservation.outcome === "reserved");
        requireCheck(!admission || admission() === true);
        currentFence(
          k,
          configured.configuration.version,
          terminalDeadline,
          signal,
        );
        const result = await model.generate(
          modelInput,
          context,
          configured.configuration,
        );
        accounted =
          (await usage.reconcile(context, {
            state: "known",
            usage: result.usage,
          })) === "reconciled";
        requireCheck(accounted);
        const verdict = model.parseVerdict(result.outputJson);
        const fresh = await inspect(
          kind,
          scope,
          signal,
          input,
          initial.authority,
        );
        requireCheck(!admission || admission() === true);
        requireCheck(
          fresh.sourceStamp === initial.sourceStamp &&
            (await equal(fresh.target ?? null, initial.target ?? null)),
        );
        requireCheck(
          await model.resolve(configured.configuration.version, signal),
        );
        currentFence(
          k,
          configured.configuration.version,
          terminalDeadline,
          signal,
        );
        if (verdict.security !== "clear") {
          await settle(kind === "engineering" ? "restricted" : "held");
          return {
            outcome:
              kind === "engineering"
                ? ("restricted" as const)
                : ("held" as const),
          };
        }
        requireCheck(
          verdict.privacy === "passed" &&
            verdict.factual === "passed" &&
            verdict.findings.length === 0 &&
            (kind === "engineering"
              ? (input as EngineeringInput).exactRequest.repository
                  .visibility === "public"
                ? verdict.publicReproduction === "passed"
                : ["passed", "not_applicable"].includes(
                    verdict.publicReproduction,
                  )
              : verdict.applicability === "passed" &&
                verdict.duplication === "passed"),
        );
        const payload = payloadSchema.parse({
          ...template,
          ...(kind === "engineering"
            ? { publicReproduction: verdict.publicReproduction }
            : {}),
        });
        const data = bytes(payload);
        const signedHeader = {
          operation,
          issuer: await issuerBinding(
            payload.issuerId,
            payload.authorityVersion,
          ),
          verifiedAt: payload.verifiedAt,
          validUntil: payload.validUntil,
          flag:
            payload.kind === "learning"
              ? ("l" as const)
              : payload.publicReproduction === "passed"
                ? ("p" as const)
                : ("n" as const),
        };
        const signature = new Uint8Array(
          await crypto.subtle.sign(
            "HMAC",
            k.key,
            macInput(kind, binding, signedHeader, configured, k),
          ),
        );
        currentFence(
          k,
          configured.configuration.version,
          terminalDeadline,
          signal,
        );
        const proof = b64(data);
        const receipt = [
          "ic2",
          operation,
          signedHeader.issuer,
          Date.parse(signedHeader.verifiedAt).toString(36),
          Date.parse(signedHeader.validUntil).toString(36),
          signedHeader.flag,
          b64(signature),
        ].join(".");
        requireCheck(receipt.length <= 200);
        requireCheck(proof.length <= receiptBytes);
        committing = true;
        requireCheck(await settle("checked", receipt, proof));
        await currentSource(payload, signal, initial.authority);
        currentFence(
          k,
          configured.configuration.version,
          terminalDeadline,
          signal,
        );
        return { outcome: "checked" as const, receipt };
      });
    } catch {
      try {
        await bounded(now() + operationLimit, undefined, async () => {
          if (context && !accounted) {
            try {
              await usage.reconcile(context, {
                state: called ? "unknown" : "not_called",
              });
            } catch {
              /* The reserved amount remains held. */
            }
          }
          await settle(
            called && (!accounted || committing) ? "unknown" : "held",
          );
        });
      } catch {
        /* Unknown ownership/accounting is retained for bounded cleanup. */
      }
      return {
        outcome:
          called && (!accounted || committing)
            ? ("unknown" as const)
            : ("held" as const),
      };
    }
  }
  const resolvePolicy: EngineeringChecksPort["resolvePolicy"] = async (
    expected,
    signal,
  ) => {
    try {
      return await bounded(
        now() + operationLimit,
        signal,
        async (freshSignal) => {
          key();
          const resolved = await model.resolve(undefined, freshSignal);
          if (
            !resolved ||
            (expected !== undefined && expected !== resolved.policy.version)
          )
            return { outcome: "unavailable" as const };
          return { outcome: "ready" as const, policy: resolved.policy };
        },
      );
    } catch {
      return { outcome: "unavailable" };
    }
  };
  const engineeringVerify: EngineeringChecksPort["verify"] = async (
    receipt,
    binding,
  ) => {
    const result = await verify("engineering", receipt, binding);
    return result?.kind === "engineering"
      ? {
          ...result.metadata,
          binding,
          security: "clear",
          publicReproduction: result.publicReproduction,
        }
      : null;
  };
  const learningVerify: LearningChecksPort["verify"] = async (
    receipt,
    binding,
    signal,
  ) => {
    const result = await verify("learning", receipt, binding, signal);
    return result?.kind === "learning"
      ? {
          ...result.metadata,
          binding,
          applicability: "passed",
          duplication: "passed",
        }
      : null;
  };
  function boundEngineeringVerify(
    scope?: IndependentCheckScope,
  ): EngineeringChecksPort["verify"] {
    return async (receipt, binding) => {
      const result = await verify(
        "engineering",
        receipt,
        binding,
        undefined,
        scope,
        undefined,
        false,
      );
      return result?.kind === "engineering"
        ? {
            ...result.metadata,
            binding,
            security: "clear",
            publicReproduction: result.publicReproduction,
          }
        : null;
    };
  }
  function boundLearningVerify(
    scope?: IndependentCheckScope,
  ): LearningChecksPort["verify"] {
    return async (receipt, binding, signal) => {
      const result = await verify(
        "learning",
        receipt,
        binding,
        signal,
        scope,
        undefined,
        false,
      );
      return result?.kind === "learning"
        ? {
            ...result.metadata,
            binding,
            applicability: "passed",
            duplication: "passed",
          }
        : null;
    };
  }
  async function readCheckedReceipt(
    kind: Kind,
    scope: IndependentCheckScope,
    binding: Binding,
    expectedPolicyVersion: string,
    signal?: AbortSignal,
  ) {
    try {
      return await bounded(
        now() + operationLimit,
        signal,
        async (currentSignal) => {
          const configured = await model.resolve(undefined, currentSignal);
          requireCheck(
            configured && configured.policy.version === expectedPolicyVersion,
          );
          scope = scopeSchema.parse(scope);
          const fixedBinding =
            kind === "engineering"
              ? engineeringBinding.parse(binding)
              : learningBinding.parse(binding);
          const operation = await knowledgeDigest({
            kind,
            scope,
            binding: fixedBinding,
            policyVersion: configured.policy.version,
            policyBinding: configured.policy.binding,
          });
          const head = await options.store
            .collection(independentCheckAttempts)
            .get(KEY);
          const entry = head?.entries.find((e) => e.operation === operation);
          if (!entry || entry.state !== "checked" || !entry.receipt)
            return null;
          return (await verify(
            kind,
            entry.receipt,
            fixedBinding,
            currentSignal,
            scope,
            entry,
          ))
            ? entry.receipt
            : null;
        },
      );
    } catch {
      return null;
    }
  }
  async function defer(
    kind: Kind,
    scope: IndependentCheckScope,
    raw: Input,
    external: { deadline: string; signal: AbortSignal },
    capture: IndependentCheckCapture,
  ) {
    function notify(entry: z.infer<typeof entrySchema> | undefined) {
      if (
        entry?.state === "queued" &&
        entry.request &&
        Date.parse(entry.expiresAt) > now()
      )
        capture.onDurablyDeferred?.(
          Object.freeze({
            kind: entry.kind,
            operationId: entry.operation,
            scope: Object.freeze({ ...entry.scope }),
            expiresAt: entry.expiresAt,
          }),
        );
    }
    try {
      return await bounded(
        Math.min(
          now() + operationLimit,
          Date.parse(time.parse(external.deadline)),
        ),
        external.signal,
        async (signal) => {
          requireCheck(policy);
          const configured = await model.resolve(undefined, signal);
          requireCheck(configured);
          const k = key();
          const input = structuredClone(raw);
          const binding =
            kind === "engineering"
              ? engineeringBinding.parse(input.binding)
              : learningBinding.parse(input.binding);
          if (kind === "engineering") {
            const value = input as EngineeringInput;
            requireCheck(
              value.checkPolicyVersion === configured.policy.version &&
                (await equal(
                  binding,
                  await engineeringExportChecksBinding({
                    ...(binding as EngineeringExportChecksBinding),
                    exactRequest: value.exactRequest,
                  }),
                )),
            );
            if (value.candidate)
              requireCheck(
                (await knowledgeDigest(value.candidate)) ===
                  binding.candidateHash,
              );
          } else {
            const value = input as LearningInput;
            requireCheck(
              "policyVersion" in binding &&
                binding.policyVersion === configured.policy.version &&
                (await knowledgeDigest(value.candidate)) ===
                  binding.candidateHash &&
                (await equal(
                  binding,
                  await resolutionLearningDeliveryBinding({
                    ...(binding as ResolutionLearningChecksBinding),
                    applicability: value.candidate.applicability,
                    exactRequest: value.exactRequest,
                  }),
                )),
            );
          }
          const request = JSON.stringify(input);
          requireCheck(request.length <= 48_000);
          const policyHash = await knowledgeDigest(policy);
          const operation = await knowledgeDigest({
            kind,
            scope,
            binding,
            policyVersion: configured.policy.version,
            policyBinding: configured.policy.binding,
          });
          const records = options.store.collection(independentCheckAttempts);
          const previous = (await records.get(KEY))?.entries.find(
            (e) => e.operation === operation,
          );
          if (previous?.state === "checked" && previous.receipt) {
            return (await verify(
              kind,
              previous.receipt,
              binding,
              signal,
              scope,
              previous,
              false,
            ))
              ? { outcome: "checked" as const, receipt: previous.receipt }
              : { outcome: "held" as const };
          }
          if (previous) {
            notify(previous);
            return {
              outcome:
                kind === "engineering" && previous.state === "restricted"
                  ? ("restricted" as const)
                  : ("held" as const),
            };
          }
          const actor = await authority(kind, signal);
          requireCheck(actor.usageScopeRef === configured.usageScopeRef);
          const expiresAt = new Date(
            Math.min(
              now() + deferredRetention,
              Date.parse(policy.validUntil),
              Date.parse(k.validUntil),
              Date.parse(configured.policy.validUntil),
            ),
          ).toISOString();
          requireCheck(Date.parse(expiresAt) > now());
          // Size a future receipt without signing or asserting any semantic result.
          const shape = {
            version: 1,
            keyId: k.id,
            scope,
            issuerId: actor.access.principalId,
            authorityVersion: actor.version,
            policyVersion: configured.policy.version,
            policyBinding: configured.policy.binding,
            verifierVersion: configured.configuration.parserVersion,
            configurationVersion: configured.configuration.version,
            promptVersion: configured.configuration.promptVersion,
            modelVersion: configured.configuration.modelVersion,
            routePolicyHash: model.currentRoute()!.approval.requestPolicySha256,
            sourceStamp: "0".repeat(64),
            receiptId: operation,
            verifiedAt: options.clock.now(),
            validUntil: expiresAt,
          };
          const template =
            kind === "engineering"
              ? {
                  ...shape,
                  kind,
                  binding,
                  publicReproduction: "not_applicable",
                }
              : {
                  ...shape,
                  kind,
                  binding,
                  target: {
                    articleId: (input as LearningInput).exactRequest.articleId,
                    originalGeneration: (input as LearningInput).exactRequest
                      .originalExpectedGeneration,
                    originalHash: "0".repeat(64),
                    outboundHash: "0".repeat(64),
                  },
                };
          const receiptBytes =
            7 + Math.ceil(bytes(template).length / 3) * 4 + 43;
          const result = await records.update(
            KEY,
            (current) => {
              requireCheck(
                !signal.aborted &&
                  now() < Date.parse(expiresAt) &&
                  (!current ||
                    (current.policyHash === policyHash &&
                      Date.parse(current.observedAt) <= now())),
              );
              if (current?.entries.some((e) => e.operation === operation))
                return { action: "keep" };
              requireCheck(
                (current?.entries.length ?? 0) < policy.maxReservations,
              );
              const entry = {
                operation,
                owner: crypto.randomUUID(),
                kind,
                scope,
                issuerId: actor.access.principalId,
                authorityVersion: actor.version,
                createdAt: options.clock.now(),
                deadline: external.deadline,
                expiresAt,
                request,
                state: "queued" as const,
                receiptBytes,
                receipt: null,
                proof: null,
              };
              const next = {
                policyHash,
                observedAt: options.clock.now(),
                entries: [...(current?.entries ?? []), entry],
              };
              independentCheckAttempts.codec.encode(next);
              independentCheckAttempts.codec.encode({
                ...next,
                entries: next.entries.map((e) => ({
                  ...e,
                  state: "checked",
                  request: null,
                  proof: "x".repeat(e.receiptBytes),
                  receipt: "x".repeat(200),
                })),
              });
              return { action: "write", value: next };
            },
            { maxAttempts: 2 },
          );
          const entry = result.value?.entries.find(
            (e) => e.operation === operation,
          );
          notify(entry);
          if (kind === "engineering" && entry?.state === "restricted")
            return { outcome: "restricted" as const };
          if (
            entry?.state === "checked" &&
            entry.receipt &&
            (await verify(
              kind,
              entry.receipt,
              binding,
              signal,
              scope,
              entry,
              false,
            ))
          )
            return { outcome: "checked" as const, receipt: entry.receipt };
          // Engineering unavailable has a restriction meaning in the SDK. Deferred
          // transport/qualification failures must retain the ordinary candidate.
          return { outcome: "held" as const };
        },
      );
    } catch {
      return { outcome: "held" as const };
    }
  }
  async function redact(
    operation: string | undefined,
    owner: string | undefined,
    scope?: IndependentCheckScope,
    expiredOnly = false,
    ticket?: { readonly kind: Kind; readonly ticketId: string },
  ) {
    return redactStoredRequests(
      options.store,
      options.clock,
      (entry, at) =>
        (operation === undefined || entry.operation === operation) &&
        (owner === undefined || entry.owner === owner) &&
        (!scope ||
          (entry.scope.ticketId === scope.ticketId &&
            entry.scope.sourceGeneration === scope.sourceGeneration)) &&
        (!expiredOnly || at >= Date.parse(entry.expiresAt)) &&
        (!ticket ||
          (entry.kind === ticket.kind &&
            entry.scope.ticketId === ticket.ticketId)),
    );
  }
  return Object.freeze({
    resolvePolicy,
    engineeringVerifier: Object.freeze({ verify: engineeringVerify }),
    learningVerifier: Object.freeze({ verify: learningVerify }),
    /** Global App verifier options, exclusively inside the SDK's current
     * Source/Work/target/authority + final conditional-commit boundary. The
     * authenticated receipt supplies its original scope without mutable state.
     */
    engineeringSdkVerifier: Object.freeze({ verify: boundEngineeringVerify() }),
    learningSdkVerifier: Object.freeze({ verify: boundLearningVerify() }),
    /** Separate precompute result lookup. It never starts or retries a model call. */
    readEngineeringReceipt: (
      scope: IndependentCheckScope,
      binding: EngineeringExportChecksBinding,
      policyVersion: string,
      signal?: AbortSignal,
    ) =>
      readCheckedReceipt("engineering", scope, binding, policyVersion, signal),
    readLearningReceipt: (
      scope: IndependentCheckScope,
      binding: ResolutionLearningChecksBinding,
      policyVersion: string,
      signal?: AbortSignal,
    ) => readCheckedReceipt("learning", scope, binding, policyVersion, signal),
    /** One finite head, at most the funded 32 entries. No request text escapes. */
    async scanPending(signal?: AbortSignal) {
      return bounded(now() + operationLimit, signal, async () => {
        const head = await options.store
          .collection(independentCheckAttempts)
          .get(KEY);
        return (head?.entries ?? [])
          .filter(
            (e) => e.state === "queued" && Date.parse(e.expiresAt) > now(),
          )
          .map((e) => ({
            operationId: e.operation,
            kind: e.kind,
            scope: e.scope,
            expiresAt: e.expiresAt,
          }));
      });
    },
    /** Root schedules one physical precompute invocation, never an inline retry. */
    async precomputePending(
      operationId: string,
      context: { deadline: string; signal: AbortSignal },
      expectedScope?: IndependentCheckScope,
      admission?: () => boolean,
    ) {
      try {
        return await bounded(
          Math.min(
            now() + operationLimit,
            Date.parse(time.parse(context.deadline)),
          ),
          context.signal,
          async (signal) => {
            const operation = hash.parse(operationId);
            const head = await options.store
              .collection(independentCheckAttempts)
              .get(KEY);
            const entry = head?.entries.find((e) => e.operation === operation);
            if (entry && ["claimed", "unknown"].includes(entry.state))
              return { outcome: "unknown" as const };
            if (!entry || entry.state !== "queued" || !entry.request)
              return { outcome: "held" as const };
            if (
              expectedScope &&
              !(await equal(entry.scope, scopeSchema.parse(expectedScope)))
            )
              return { outcome: "held" as const };
            try {
              if (Date.parse(entry.expiresAt) <= now())
                return { outcome: "held" as const };
              return await check(
                entry.kind,
                entry.scope,
                JSON.parse(entry.request),
                { ...context, signal },
                entry,
                admission,
              );
            } finally {
              // Failed authorization/source/expiry before claim also removes text.
              await bounded(now() + operationLimit, undefined, () =>
                redact(entry.operation, entry.owner),
              );
            }
          },
        );
      } catch {
        return { outcome: "held" as const };
      }
    },
    /** Wire to the host's existing privacy/delete path and existing cleanup lane. */
    discardPending: (scope: IndependentCheckScope) =>
      bounded(now() + operationLimit, undefined, () =>
        redact(undefined, undefined, scopeSchema.parse(scope)),
      ),
    discardTicket: (kind: Kind, ticketId: string) =>
      bounded(now() + operationLimit, undefined, () =>
        redact(undefined, undefined, undefined, false, {
          kind: z.enum(["engineering", "learning"]).parse(kind),
          ticketId: scalar.parse(ticketId),
        }),
      ),
    purgeExpired: () =>
      bounded(now() + operationLimit, undefined, () =>
        redact(undefined, undefined, undefined, true),
      ),
    /** SDK-private port: the receipt proves the original exact independent check.
     * The real SDK must retain current Source/Work/target/authority and final CAS
     * guards. This verifier alone is not a Source eligibility capability.
     */
    engineeringFor(
      scope: IndependentCheckScope,
      capture: IndependentCheckCapture = {},
    ): EngineeringChecksPort {
      const fixed = scopeSchema.parse(scope);
      return Object.freeze({
        resolvePolicy,
        verify: boundEngineeringVerify(fixed),
        async check(
          input: EngineeringInput,
          context: Parameters<EngineeringChecksPort["check"]>[1],
        ) {
          const result = await (options.deferred === false
            ? check("engineering", fixed, input, context)
            : defer("engineering", fixed, input, context, capture));
          return result.outcome === "checked"
            ? result
            : {
                outcome:
                  result.outcome === "unknown"
                    ? ("held" as const)
                    : result.outcome,
              };
        },
      });
    },
    learningFor(
      scope: IndependentCheckScope,
      capture: IndependentCheckCapture = {},
    ): LearningChecksPort {
      const fixed = scopeSchema.parse(scope);
      return Object.freeze({
        resolvePolicy,
        verify: boundLearningVerify(fixed),
        async check(
          input: LearningInput,
          context: Parameters<LearningChecksPort["check"]>[1],
        ) {
          const result = await (options.deferred === false
            ? check("learning", fixed, input, context)
            : defer("learning", fixed, input, context, capture));
          return result.outcome === "checked"
            ? result
            : {
                outcome:
                  result.outcome === "restricted" ||
                  result.outcome === "unknown"
                    ? ("held" as const)
                    : result.outcome,
              };
        },
      });
    },
  });
}
