import { hasPermission, type AccessContext } from "@pegma/authorization-core";
import type { KnowledgeBaseApplication } from "@pegma/knowledge-base-application";
import { defineCollection, type Store } from "@pegma/storage-core";
import {
  engineeringFollowupChecksBinding,
  engineeringFollowupRetestProductBinding,
  engineeringFollowupRetestRequestId,
  supportPermissions,
  type SupportDeskApplication,
  type EngineeringFollowupApplication,
  type EngineeringFollowupKey,
  type EngineeringFollowupChecksPort,
  type EngineeringFollowupChecksBinding,
  type EngineeringFollowupReleaseEvidencePort,
} from "@pegma/support-desk-application";
import type { ReleaseFollowupChecksPort } from "../release-followup-ports.js";
import type { LearningServiceAccessPort } from "../learning-ports.js";
import type { LearningKnowledgeAccessPort } from "../learning-integration-types.js";
import {
  releaseFollowupProofContext,
  releaseFollowupProofSnapshot,
} from "../release-followup-request.js";
import { releaseFollowupContent } from "../release-followup-output.js";
import { snapshot } from "../boundary.js";
import { canonical } from "./support-openrouter-model.js";
import { containsPrivateText } from "./private-text.js";
import { checkedLogicalHost, knowledgeDigest } from "./canonical-digest.js";
import {
  createSupportIndependentCheckModel,
  INDEPENDENT_CHECK_PURPOSE,
  type IndependentCheckContext,
  type IndependentCheckModelOptions,
  type ReleaseFollowupIndependentCheckInput,
} from "./support-independent-checks-model.js";
import {
  createSupportModelUsageLedger,
  type SupportModelUsagePolicy,
} from "./support-model-usage-ledger.js";
import type { IndependentCheckReceiptKey } from "./support-independent-checks.js";
import { z } from "zod";

export interface SupportReleaseFollowupChecksOptions extends IndependentCheckModelOptions {
  readonly store: Store;
  readonly application: () => Pick<SupportDeskApplication, "readStaffTicket"> &
    Pick<
      EngineeringFollowupApplication,
      | "readEngineeringFollowupWork"
      | "confirmEngineeringFollowupCurrent"
      | "readEngineeringFollowupReassessment"
    >;
  readonly authority: LearningServiceAccessPort;
  readonly releaseEvidence: EngineeringFollowupReleaseEvidencePort;
  readonly knowledge?: Pick<
    KnowledgeBaseApplication,
    "getDraft" | "getValidationRequirements"
  >;
  readonly knowledgeAccess?: LearningKnowledgeAccessPort;
  /** The existing shared independent-check pool, not generator funding. */
  readonly usagePolicy?: SupportModelUsagePolicy;
  readonly readReceiptKey?: () => IndependentCheckReceiptKey | null;
  readonly maxOperationMilliseconds?: number;
  readonly maxReceiptMilliseconds?: number;
}
type CheckInput = Parameters<ReleaseFollowupChecksPort["check"]>[0];
const scalar = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[^\u0000-\u001f\u007f]+$/u);
const hash = z.string().regex(/^[0-9a-f]{64}$/u);
const instant = z.string().datetime({ precision: 3 });
const scopeSchema = z.object({ ticketId: scalar, workId: scalar }).strict();
const proofSchema = z
  .object({
    scope: scopeSchema,
    sourceStamp: hash,
    issuer: scalar,
    authorityVersion: scalar,
    target: z
      .object({
        articleId: scalar,
        generation: z.number().int().positive(),
        requirementsHash: hash,
      })
      .strict()
      .nullable(),
  })
  .strict();
const entrySchema = z
  .object({
    operation: hash,
    owner: scalar,
    state: z.enum(["claimed", "held", "restricted", "checked"]),
    proof: z.string().max(8000),
    receipt: z.string().max(200).nullable(),
  })
  .strict();
const headSchema = z
  .object({
    policyHash: hash,
    observedAt: instant,
    entries: z.array(entrySchema).max(32),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      new Set(value.entries.map((e) => e.operation)).size !==
        value.entries.length ||
      value.entries.some(
        (e) => (e.state === "checked") !== (e.receipt !== null),
      )
    )
      ctx.addIssue({
        code: "custom",
        message: "Invalid follow-up checks head",
      });
  });
type Head = z.infer<typeof headSchema>;
const KEY = Object.freeze({
  partition: "support_release_followup",
  id: "attempts",
});
/** Bounded private ownership only; this is not a scheduler or evidence ledger. */
export const releaseFollowupCheckAttempts = defineCollection<Head>({
  name: "pegma.support-release-followup-checks.attempts.v1",
  key: () => KEY,
  codec: {
    encode(value) {
      const record = {
        ...KEY,
        format: 1,
        payload: JSON.stringify(headSchema.parse(value)),
      };
      if (new TextEncoder().encode(JSON.stringify(record)).length > 60000)
        throw new TypeError("Follow-up check capacity");
      return record;
    },
    decode(value) {
      if (
        value.partition !== KEY.partition ||
        value.id !== KEY.id ||
        value.format !== 1 ||
        typeof value.payload !== "string" ||
        new TextEncoder().encode(JSON.stringify(value)).length > 60000 ||
        Object.keys(value).sort().join(",") !== "format,id,partition,payload"
      )
        throw new TypeError("Invalid follow-up checks record");
      return headSchema.parse(JSON.parse(value.payload));
    },
  },
});
class Held extends Error {}
function requireCheck(value: unknown): asserts value {
  if (!value) throw new Held();
}
function b64(value: Uint8Array) {
  return btoa(String.fromCharCode(...value))
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_")
    .replace(/=+$/u, "");
}
function unb64(value: string) {
  requireCheck(/^[A-Za-z0-9_-]{43}$/u.test(value));
  const decoded = Uint8Array.from(
    atob(value.replace(/-/gu, "+").replace(/_/gu, "/") + "="),
    (c) => c.charCodeAt(0),
  );
  requireCheck(b64(decoded) === value);
  return decoded;
}

/** Original options callbacks stay live. Receipts have a distinct SD05 MAC domain. */
export function createSupportReleaseFollowupChecks(
  options: SupportReleaseFollowupChecksOptions,
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
      ...(policy ? { policy } : {}),
    },
    {
      purpose: INDEPENDENT_CHECK_PURPOSE,
      collection: "pegma.support-independent-checks.usage.v1",
      key: { partition: INDEPENDENT_CHECK_PURPOSE, id: "budget" },
      binding: (c) => c.inputFingerprint,
      identity: (c) => c,
    },
  );
  const limit = options.maxOperationMilliseconds ?? 5000;
  const receiptLimit = options.maxReceiptMilliseconds ?? 60000;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 20000 ||
    !Number.isSafeInteger(receiptLimit) ||
    receiptLimit < 1 ||
    receiptLimit > 300000
  )
    throw new TypeError("Invalid follow-up checks bounds");
  const now = () => {
    const at = options.clock.now();
    const n = Date.parse(at);
    requireCheck(Number.isFinite(n) && new Date(n).toISOString() === at);
    return n;
  };
  async function bounded<T>(
    outer: AbortSignal | undefined,
    deadline: number,
    run: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    outer?.addEventListener("abort", abort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      requireCheck(!outer?.aborted && now() < deadline);
      const stop = new Promise<never>((_, reject) => {
        controller.signal.addEventListener("abort", () => reject(new Held()), {
          once: true,
        });
        timer = setTimeout(abort, Math.max(1, deadline - now()));
      });
      return await Promise.race([run(controller.signal), stop]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      outer?.removeEventListener("abort", abort);
      controller.abort();
    }
  }
  function key() {
    const k = options.readReceiptKey?.();
    requireCheck(
      k &&
        scalar.safeParse(k.id).success &&
        instant.safeParse(k.validUntil).success &&
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
  async function configured(signal: AbortSignal, expected?: string) {
    const result = await model.resolve(undefined, signal);
    const r = model.currentRoute();
    requireCheck(
      result &&
        r?.releaseFollowup &&
        Date.parse(r.releaseFollowup.verifiedAt) <= now() &&
        now() < Date.parse(r.releaseFollowup.validUntil) &&
        Date.parse(r.approval.validUntil) <=
          Date.parse(r.releaseFollowup.validUntil) &&
        (expected === undefined || result.policy.version === expected),
    );
    return { ...result, route: r };
  }
  // Approval windows are current observations, not semantic policy identity.
  // Receipt timestamps stay signed and are independently bounded by current
  // route, purpose, key and policy expiry on every verification.
  function policyIdentity(
    policy: Awaited<ReturnType<typeof configured>>["policy"],
  ) {
    return { version: policy.version, binding: policy.binding };
  }
  function routeIdentity(
    route: Awaited<ReturnType<typeof configured>>["route"],
  ) {
    const { verifiedAt, validUntil, ...approval } = route.approval;
    void verifiedAt;
    void validUntil;
    return { ...route, approval };
  }
  function sameAttemptRoute(
    current: Awaited<ReturnType<typeof configured>>["route"],
    captured: Awaited<ReturnType<typeof configured>>["route"],
  ) {
    // A fresh approval may extend the window without changing the paid request.
    // The attempt and receipt keep their original expiry bounds.
    return (
      Date.parse(current.approval.validUntil) >=
        Date.parse(captured.approval.validUntil) &&
      canonical(routeIdentity(current)) === canonical(routeIdentity(captured))
    );
  }
  async function authority(
    signal: AbortSignal,
    previous?: { access: AccessContext; version: string; scope: string },
    reviewAuthority?: LearningServiceAccessPort,
  ) {
    const r = await (reviewAuthority ?? options.authority).resolve(signal);
    requireCheck(!signal.aborted && r.outcome === "ready");
    const {
      access,
      authorityVersion: version,
      usageScopeRef: scope,
    } = snapshot(r.authority);
    scalar.parse(access.principalId);
    scalar.parse(version);
    scalar.parse(scope);
    requireCheck(
      [
        supportPermissions.queueRead,
        supportPermissions.engineeringFollowupRead,
        reviewAuthority
          ? supportPermissions.engineeringFollowupReview
          : supportPermissions.engineeringFollowupProcess,
      ].every((p) => hasPermission(access, p)),
    );
    if (previous)
      requireCheck(
        previous.access.principalId === access.principalId &&
          previous.version === version &&
          previous.scope === scope &&
          previous.access.permissions.every((p) => hasPermission(access, p)),
      );
    return { access, version, scope };
  }
  async function inspect(
    scope: EngineeringFollowupKey,
    signal: AbortSignal,
    input?: CheckInput,
    previous?: Awaited<ReturnType<typeof authority>>,
    saved?: z.infer<typeof proofSchema>,
    reviewAuthority?: LearningServiceAccessPort,
  ) {
    const a = await authority(signal, previous, reviewAuthority);
    const app = options.application();
    const reassessment = reviewAuthority
      ? await app.readEngineeringFollowupReassessment(a.access, scope)
      : undefined;
    const stored =
      reassessment?.work ??
      (await app.readEngineeringFollowupWork(a.access, scope));
    // These fields come only from the actual authorized reassessment observation.
    const work = reassessment
      ? {
          ...stored,
          context: reassessment.proof.context,
          association: reassessment.proofContext.association,
          acceptedTicketRevision: reassessment.proofContext.ticketRevision,
          lastVisibleMessageId: reassessment.proofContext.lastVisibleMessageId,
          parentSourceGeneration:
            reassessment.proofContext.parentSourceGeneration,
          workBindingHash: reassessment.prospectiveWorkBindingHash,
        }
      : stored;
    requireCheck(
      !signal.aborted &&
        work.ticketId === scope.ticketId &&
        work.workId === scope.workId &&
        work.security === "ordinary" &&
        work.withdrawn !== true &&
        work.context &&
        (reassessment !== undefined ||
          (Date.parse(work.deadline) > now() &&
            !["held", "restricted", "superseded"].includes(work.status))),
    );
    const raw = await options.releaseEvidence.confirm(
      work.context,
      reassessment?.proofContext ?? releaseFollowupProofContext(work),
      signal,
    );
    requireCheck(raw);
    const proof = releaseFollowupProofSnapshot(raw, work, now());
    const ticket = await app.readStaffTicket(a.access, scope.ticketId);
    const messages = ticket.messages.filter((m) => m.visibility === "customer");
    requireCheck(
      ticket.ticket.revision === work.acceptedTicketRevision &&
        messages.at(-1)?.id === work.lastVisibleMessageId &&
        messages.length > 0 &&
        messages.length <= 100,
    );
    let target: z.infer<typeof proofSchema>["target"] = saved?.target ?? null;
    let baseline: CheckInput["targetBaseline"] = null;
    let requirements: CheckInput["validationRequirements"] = null;
    const selected = input?.exactBundle.kbProposal?.target;
    if (
      selected?.kind === "article" ||
      (input?.exactBundle.kbProposal === null && input.targetBaseline !== null)
    ) {
      requireCheck(input?.targetBaseline && input.validationRequirements);
      target = {
        articleId:
          selected?.kind === "article"
            ? selected.articleId
            : input.targetBaseline.articleId,
        generation: input!.targetBaseline!.generation,
        requirementsHash: await knowledgeDigest(input!.validationRequirements),
      };
    }
    if (target) {
      requireCheck(options.knowledge && options.knowledgeAccess);
      const ka = await options.knowledgeAccess.resolve(signal);
      requireCheck(ka.outcome === "ready");
      const observed = snapshot(ka.authority);
      baseline = await options.knowledge.getDraft(observed.access, {
        articleId: target.articleId,
      });
      requirements = await options.knowledge.getValidationRequirements(
        observed.access,
        {
          collectionId: baseline.revision.collectionId,
          kind: baseline.revision.kind,
        },
      );
      requireCheck(
        baseline.generation === target.generation &&
          (await knowledgeDigest(requirements)) === target.requirementsHash,
      );
      const closing = await options.knowledgeAccess.resolve(signal);
      requireCheck(
        closing.outcome === "ready" &&
          canonical(snapshot(closing.authority)) === canonical(observed),
      );
    }
    if (input) {
      const authored = {
        customerDraft: input.exactBundle.customerDraft,
        kbProposal:
          input.exactBundle.kbProposal === null
            ? null
            : {
                summary: input.exactBundle.kbProposal.summary,
                changes: input.exactBundle.kbProposal.changes,
                advisoryValidationRequirements:
                  input.exactBundle.kbProposal.advisoryValidationRequirements,
              },
        retestRequests: input.exactBundle.retestRequests.map((r) => ({
          steps: r.steps,
          expectedBehavior: r.expectedBehavior,
        })),
      };
      requireCheck(
        canonical(releaseFollowupContent(authored)) ===
          canonical(input.candidate),
      );
      const ids =
        selected?.kind === "article" ? selected.validationRequirementIds : [];
      if (selected?.kind === "article")
        requireCheck(
          baseline &&
            requirements &&
            selected.articleId === baseline.articleId &&
            selected.collectionId === baseline.revision.collectionId &&
            selected.articleRevision === baseline.revision.number &&
            selected.contentHash === baseline.revision.contentHash &&
            selected.validationRequirementsHash ===
              (await knowledgeDigest(requirements)) &&
            canonical(ids) === canonical(requirements.checks.map((c) => c.id)),
        );
      const product = await engineeringFollowupRetestProductBinding(
        proof.context,
      );
      for (let i = 0; i < input.exactBundle.retestRequests.length; i++) {
        const request = input.exactBundle.retestRequests[i]!;
        requireCheck(
          request.productBinding === product &&
            canonical(request.validationRequirementIds) === canonical(ids) &&
            request.requestId ===
              (await engineeringFollowupRetestRequestId({
                workId: scope.workId,
                index: i,
                steps: request.steps,
                expectedBehavior: request.expectedBehavior,
                productBinding: product,
                validationRequirementIds: ids,
              })),
        );
      }
      requireCheck(
        work.candidateHash === input.binding.candidateHash &&
          canonical(releaseFollowupContent(input.candidate)) ===
            canonical(input.candidate) &&
          canonical(input.targetBaseline) === canonical(baseline) &&
          canonical(input.validationRequirements) === canonical(requirements) &&
          canonical(input.releaseProof.context) === canonical(proof.context) &&
          (await knowledgeDigest(input.releaseProof.publicFacts)) ===
            (await knowledgeDigest(proof.publicFacts)),
      );
      requireCheck(
        canonical(
          await engineeringFollowupChecksBinding({
            workBindingHash: work.workBindingHash,
            candidateHash: work.candidateHash!,
            exactBundle: input.exactBundle,
            checkPolicyVersion: input.binding.checkPolicyVersion,
            followupRevocationEpoch: work.association.followupRevocationEpoch,
            context: proof.context,
          }),
        ) === canonical(input.binding),
      );
    }
    const stamp = await knowledgeDigest({
      workBindingHash: work.workBindingHash,
      candidateHash: work.candidateHash ?? null,
      association: work.association,
      context: work.context,
      ticketRevision: ticket.ticket.revision,
      messages: messages.map((m) => ({
        id: m.id,
        body: m.body,
        authorKind: m.authorKind,
      })),
      publicFacts: proof.publicFacts,
      target: baseline,
      requirements,
    });
    if (saved)
      requireCheck(
        stamp === saved.sourceStamp &&
          a.access.principalId === saved.issuer &&
          a.version === saved.authorityVersion,
      );
    if (reassessment) {
      const closing = await app.readEngineeringFollowupReassessment(
        a.access,
        scope,
      );
      requireCheck(
        closing.workGeneration === reassessment.workGeneration &&
          closing.prospectiveWorkBindingHash ===
            reassessment.prospectiveWorkBindingHash &&
          canonical(closing.proofContext) ===
            canonical(reassessment.proofContext) &&
          canonical(closing.proof.context) ===
            canonical(reassessment.proof.context),
      );
    } else {
      requireCheck(
        await app.confirmEngineeringFollowupCurrent(a.access, {
          ...scope,
          workBindingHash: work.workBindingHash,
          expectedWorkGeneration: work.workGeneration,
        }),
      );
    }
    await authority(signal, a, reviewAuthority);
    requireCheck(!signal.aborted);
    return {
      authority: a,
      proof: proofSchema.parse({
        scope,
        sourceStamp: stamp,
        issuer: a.access.principalId,
        authorityVersion: a.version,
        target,
      }),
      validUntil: Math.min(
        Date.parse(proof.attestation.validUntil),
        reassessment ? Number.POSITIVE_INFINITY : Date.parse(work.deadline),
      ),
      facts: {
        messages: messages.map((m) => m.body),
        publicReleaseFacts: proof.publicFacts.map((f, i) => ({
          ref: "release-" + (i + 1),
          text: f.text,
        })),
      },
      privateValues: [
        ticket.ticket.requester.principalId,
        ticket.ticket.requester.email,
        ...ticket.messages
          .filter((m) => m.visibility === "internal")
          .map((m) => m.body),
      ].filter((v): v is string => typeof v === "string" && v.length > 0),
    };
  }
  function fence(
    k: IndependentCheckReceiptKey,
    expected: Awaited<ReturnType<typeof configured>>,
    deadline: number,
    signal: AbortSignal,
  ) {
    const fresh = key();
    const route = model.currentRoute(expected.configuration.version);
    requireCheck(
      !signal.aborted &&
        now() < deadline &&
        fresh.id === k.id &&
        fresh.key === k.key &&
        route &&
        sameAttemptRoute(route, expected.route),
    );
  }
  function header(receipt: string) {
    requireCheck(typeof receipt === "string" && receipt.length <= 200);
    const p = receipt.split(".");
    requireCheck(p.length === 5 && p[0] === "sf1");
    const operation = hash.parse(p[1]);
    const from = Number.parseInt(p[2]!, 36),
      until = Number.parseInt(p[3]!, 36);
    requireCheck(
      Number.isSafeInteger(from) &&
        Number.isSafeInteger(until) &&
        from <= now() &&
        now() < until &&
        from.toString(36) === p[2] &&
        until.toString(36) === p[3],
    );
    return {
      operation,
      verifiedAt: new Date(from).toISOString(),
      validUntil: new Date(until).toISOString(),
      signature: unb64(p[4]!),
    };
  }
  function mac(
    binding: EngineeringFollowupChecksBinding,
    h: { operation: string; verifiedAt: string; validUntil: string },
    k: IndependentCheckReceiptKey,
    c: Awaited<ReturnType<typeof configured>>,
  ) {
    return new TextEncoder().encode(
      canonical({
        domain: host + ".support-release-followup-checks.v1",
        purpose: "support_release_followup",
        keyId: k.id,
        operation: h.operation,
        verifiedAt: h.verifiedAt,
        validUntil: h.validUntil,
        binding,
        route: c.route.approval.requestPolicySha256,
        configuration: c.configuration.version,
        policy: policyIdentity(c.policy),
      }),
    );
  }
  async function verify(
    receipt: string,
    binding: EngineeringFollowupChecksBinding,
    signal: AbortSignal,
    scope?: EngineeringFollowupKey,
    reviewAuthority?: LearningServiceAccessPort,
    sourceRead = true,
  ) {
    try {
      return await bounded(signal, now() + limit, async (current) => {
        const h = header(receipt),
          k = key(),
          c = await configured(current, binding.checkPolicyVersion);
        requireCheck(
          Date.parse(h.validUntil) <=
            Math.min(
              Date.parse(k.validUntil),
              Date.parse(c.policy.validUntil),
              Date.parse(c.route.releaseFollowup!.validUntil),
            ) &&
            (await crypto.subtle.verify(
              "HMAC",
              k.key,
              h.signature,
              mac(binding, h, k, c),
            )),
        );
        if (scope)
          requireCheck(
            h.operation ===
              (await knowledgeDigest({
                host,
                kind: "release_followup",
                scope,
                binding,
                policy: policyIdentity(c.policy),
              })),
          );
        if (scope && sourceRead) {
          const row = await options.store
            .collection(releaseFollowupCheckAttempts)
            .get(KEY);
          const e = row?.entries.find((e) => e.operation === h.operation);
          requireCheck(e?.state === "checked" && e.receipt === receipt);
          const saved = proofSchema.parse(JSON.parse(e.proof));
          requireCheck(canonical(saved.scope) === canonical(scope));
          await inspect(
            scope,
            current,
            undefined,
            undefined,
            saved,
            reviewAuthority,
          );
        }
        fence(k, c, Date.parse(h.validUntil), current);
        return {
          binding: structuredClone(binding),
          privacy: "passed" as const,
          factual: "passed" as const,
          applicability: "passed" as const,
          security: "clear" as const,
          verifierReceiptId: h.operation,
          verifierVersion: c.configuration.parserVersion,
          verifiedAt: h.verifiedAt,
          validUntil: h.validUntil,
        };
      });
    } catch {
      return null;
    }
  }
  const resolvePolicy: ReleaseFollowupChecksPort["resolvePolicy"] = async (
    expected,
    signal,
  ) => {
    try {
      return await bounded(signal, now() + limit, async (current) => {
        key();
        const c = await configured(current, expected);
        return { outcome: "ready" as const, policy: c.policy };
      });
    } catch {
      return { outcome: "unavailable" };
    }
  };
  const portFor = (
    rawScope: EngineeringFollowupKey,
    reviewAuthority?: LearningServiceAccessPort,
  ): ReleaseFollowupChecksPort => {
    const scope = Object.freeze(scopeSchema.parse(rawScope));
    return Object.freeze<ReleaseFollowupChecksPort>({
      resolvePolicy,
      verify: (receipt, binding, signal) =>
        verify(receipt, binding, signal, scope, reviewAuthority, false),
      async check(raw, external) {
        // The optional policy permits verifier-only/default-off composition.
        // Admission for a new paid check needs explicit finite funding.
        if (policy === undefined) return { outcome: "unavailable" };
        let context: IndependentCheckContext | undefined;
        let called = false;
        let accounted = false;
        let operation: string | undefined;
        let owner: string | undefined;
        let commitFence: (() => void) | undefined;
        const records = options.store.collection(releaseFollowupCheckAttempts);
        const settle = async (
          state: "held" | "restricted" | "checked",
          receipt: string | null = null,
        ) => {
          if (!operation || !owner) return;
          await records.update(
            KEY,
            (current) => {
              if (
                !current ||
                !current.entries.some(
                  (e) =>
                    e.operation === operation &&
                    e.owner === owner &&
                    e.state === "claimed",
                )
              )
                return { action: "keep" };
              if (state === "checked") {
                requireCheck(commitFence);
                commitFence();
              }
              return {
                action: "write",
                value: {
                  ...current,
                  observedAt: options.clock.now(),
                  entries: current.entries.map((e) =>
                    e.operation === operation && e.owner === owner
                      ? { ...e, state, receipt }
                      : e,
                  ),
                },
              };
            },
            { maxAttempts: 2 },
          );
        };
        try {
          return await bounded(
            external.signal,
            Math.min(now() + limit, Date.parse(external.deadline)),
            async (signal) => {
              requireCheck(external.purpose === "support_release_followup");
              const input = structuredClone(raw);
              const k = key(),
                c = await configured(signal, input.binding.checkPolicyVersion);
              const initial = await inspect(
                scope,
                signal,
                input,
                undefined,
                undefined,
                reviewAuthority,
              );
              requireCheck(initial.authority.scope === c.usageScopeRef);
              const modelInput: ReleaseFollowupIndependentCheckInput = {
                trustedInstructions: c.configuration.trustedInstructions,
                kind: "release_followup",
                purpose: "support_release_followup",
                facts: initial.facts,
                candidate: input.candidate,
                outbound: input.exactBundle,
                binding: input.binding,
                targetBaseline: input.targetBaseline,
                validationRequirements: input.validationRequirements,
              };
              requireCheck(
                !containsPrivateText(
                  canonical(modelInput),
                  initial.privateValues,
                ) && model.withinBudget(modelInput, c.configuration),
              );
              operation = await knowledgeDigest({
                host,
                kind: "release_followup",
                scope,
                binding: input.binding,
                policy: policyIdentity(c.policy),
              });
              owner = crypto.randomUUID();
              const policyHash = await knowledgeDigest(policy ?? null);
              const proof = JSON.stringify(initial.proof);
              const proposed = {
                operation,
                owner,
                state: "claimed" as const,
                proof,
                receipt: null,
              };
              const claim = await records.update(
                KEY,
                (current) => {
                  requireCheck(
                    !signal.aborted &&
                      (!current ||
                        (current.policyHash === policyHash &&
                          Date.parse(current.observedAt) <= now())),
                  );
                  if (current?.entries.some((e) => e.operation === operation))
                    return { action: "keep" };
                  requireCheck(
                    (current?.entries.length ?? 0) <
                      (policy?.maxReservations ?? 0),
                  );
                  const next = {
                    policyHash,
                    observedAt: options.clock.now(),
                    entries: [...(current?.entries ?? []), proposed],
                  };
                  releaseFollowupCheckAttempts.codec.encode({
                    ...next,
                    entries: next.entries.map((e) => ({
                      ...e,
                      state: "checked",
                      receipt: "x".repeat(200),
                    })),
                  });
                  return { action: "write", value: next };
                },
                { maxAttempts: 2 },
              );
              const retained = claim.value?.entries.find(
                (e) => e.operation === operation,
              );
              requireCheck(retained);
              if (retained.owner !== owner) {
                if (
                  retained.state === "checked" &&
                  retained.receipt &&
                  (await verify(
                    retained.receipt,
                    input.binding,
                    signal,
                    scope,
                    reviewAuthority,
                  ))
                )
                  return {
                    outcome: "checked" as const,
                    receipt: retained.receipt,
                  };
                return {
                  outcome:
                    retained.state === "restricted"
                      ? ("restricted" as const)
                      : ("held" as const),
                };
              }
              const end = Math.min(
                Date.parse(external.deadline),
                now() + limit,
                initial.validUntil,
                Date.parse(k.validUntil),
                Date.parse(c.policy.validUntil),
                Date.parse(c.route.releaseFollowup!.validUntil),
              );
              context = {
                purpose: INDEPENDENT_CHECK_PURPOSE,
                operationId: operation,
                attemptId: operation,
                inputFingerprint: await knowledgeDigest(modelInput),
                usageReservationId: operation,
                configurationVersion: c.configuration.version,
                promptVersion: c.configuration.promptVersion,
                modelVersion: c.configuration.modelVersion,
                usageScopeRef: c.usageScopeRef,
                deadline: new Date(end).toISOString(),
                signal,
                budgets: c.configuration.budgets,
                onPhysicalCall: () => {
                  called = true;
                },
                beforePhysicalCall: async (current) => {
                  const fresh = await inspect(
                    scope,
                    current,
                    input,
                    initial.authority,
                    undefined,
                    reviewAuthority,
                  );
                  requireCheck(
                    fresh.proof.sourceStamp === initial.proof.sourceStamp,
                  );
                  const currentConfiguration = await configured(
                    current,
                    input.binding.checkPolicyVersion,
                  );
                  requireCheck(
                    sameAttemptRoute(currentConfiguration.route, c.route),
                  );
                  fence(k, c, end, current);
                  return () => {
                    fence(k, c, end, current);
                    return true;
                  };
                },
              };
              requireCheck(
                (await usage.reserve(context)).outcome === "reserved",
              );
              fence(k, c, end, signal);
              const result = await model.generate(
                modelInput,
                context,
                c.configuration,
              );
              accounted =
                (await usage.reconcile(context, {
                  state: "known",
                  usage: result.usage,
                })) === "reconciled";
              requireCheck(accounted);
              const verdict = model.parseVerdict(result.outputJson);
              if (verdict.security !== "clear") {
                await settle("restricted");
                return { outcome: "restricted" as const };
              }
              requireCheck(
                verdict.privacy === "passed" &&
                  verdict.factual === "passed" &&
                  verdict.applicability === "passed" &&
                  verdict.findings.length === 0,
              );
              const fresh = await inspect(
                scope,
                signal,
                input,
                initial.authority,
                undefined,
                reviewAuthority,
              );
              requireCheck(
                fresh.proof.sourceStamp === initial.proof.sourceStamp,
              );
              const currentConfiguration = await configured(
                signal,
                input.binding.checkPolicyVersion,
              );
              requireCheck(
                sameAttemptRoute(currentConfiguration.route, c.route),
              );
              const h = {
                operation,
                verifiedAt: options.clock.now(),
                validUntil: new Date(
                  Math.min(
                    now() + receiptLimit,
                    fresh.validUntil,
                    Date.parse(k.validUntil),
                    Date.parse(c.policy.validUntil),
                    Date.parse(c.route.releaseFollowup!.validUntil),
                    Date.parse(policy!.validUntil),
                  ),
                ).toISOString(),
              };
              const signature = new Uint8Array(
                await crypto.subtle.sign(
                  "HMAC",
                  k.key,
                  mac(input.binding, h, k, c),
                ),
              );
              fence(k, c, end, signal);
              const receipt = [
                "sf1",
                operation,
                Date.parse(h.verifiedAt).toString(36),
                Date.parse(h.validUntil).toString(36),
                b64(signature),
              ].join(".");
              requireCheck(receipt.length <= 200);
              commitFence = () => fence(k, c, end, signal);
              await settle("checked", receipt);
              fence(k, c, end, signal);
              return { outcome: "checked" as const, receipt };
            },
          );
        } catch {
          try {
            await bounded(undefined, now() + limit, async () => {
              if (context && !accounted)
                await usage.reconcile(context, {
                  state: called ? "unknown" : "not_called",
                });
              await settle("held");
            });
          } catch {
            /* Conservative ownership and funding remain held. */
          }
          return { outcome: "held" as const };
        }
      },
    });
  };
  const sdkVerifier: EngineeringFollowupChecksPort =
    Object.freeze<EngineeringFollowupChecksPort>({
      verify: (receipt, binding, signal) => verify(receipt, binding, signal),
    });
  return Object.freeze({
    resolvePolicy,
    forWork: (scope: EngineeringFollowupKey) => portFor(scope),
    forReassessment: (
      scope: EngineeringFollowupKey,
      reviewAuthority: LearningServiceAccessPort,
    ) => {
      if (!reviewAuthority || typeof reviewAuthority.resolve !== "function")
        throw new TypeError("Current staff review authority required");
      return portFor(scope, reviewAuthority);
    },
    currentVerifierFor: (
      scope: EngineeringFollowupKey,
      reviewAuthority?: LearningServiceAccessPort,
    ): EngineeringFollowupChecksPort => {
      const fixed = Object.freeze(scopeSchema.parse(scope));
      return Object.freeze<EngineeringFollowupChecksPort>({
        verify: (receipt, binding, signal) =>
          verify(receipt, binding, signal, fixed, reviewAuthority),
      });
    },
    sdkVerifier,
  });
}
