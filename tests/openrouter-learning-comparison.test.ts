import { describe, expect, it, vi } from "vitest";
import type { Store } from "@pegma/storage-core";
import { resolveAccess } from "@pegma/authorization-core";
import { knowledgePermissions } from "@pegma/knowledge-base-contracts";
import {
  KnowledgeBaseAuthorizationError,
  KnowledgeBaseNotFoundError,
} from "@pegma/knowledge-base-application";
import {
  createSupportIndependentChecks,
  independentCheckAttempts,
  type IndependentCheckPendingHint,
  type SupportIndependentChecksOptions,
} from "@pegma/support-desk-ai/openrouter";
import {
  supportPermissions,
  type ResolutionLearningKey,
} from "@pegma/support-desk-application";
import {
  createSupportDeskLearning,
  type LearningChecksPort,
} from "@pegma/support-desk-ai";
import { knowledgeDigest } from "../packages/ai/src/openrouter/canonical-digest.js";
import type { LearningComparisonKnowledge } from "../packages/ai/src/learning-comparison.js";
import {
  checkerModelFixture,
  CHECK_PASS,
} from "../test/openrouter-fixtures.js";
import {
  learningKbFixture,
  learningKbStores,
  learningKbCollectionId,
  learningKbAudience,
  learningKbBarrier,
} from "../test/resolution-learning-kb-fixtures.js";

const incompleteResourceRead = async () => {
  throw new Error(
    "Incomplete comparison must not read or fabricate resource state",
  );
};

/** Real Support/KB/Store. Only generation, independent model HTTP, route/key and
 * external test attestations are fictional. No completeness result is mocked. */
async function fixture(store: Store, staged = false) {
  const f = await learningKbFixture(store);
  let usageMutations = 0;
  const checkerStore: Store = {
    collection(definition) {
      const target = store.collection(definition);
      if (definition.name !== "pegma.support-independent-checks.usage.v1")
        return target;
      const update: typeof target.update = (...args) => {
        usageMutations++;
        return target.update(...args);
      };
      return new Proxy(target, {
        get(object, property) {
          if (property === "update") return update;
          const value: unknown = Reflect.get(object, property, object);
          return typeof value === "function" ? value.bind(object) : value;
        },
      });
    },
  };
  const p = await checkerModelFixture(
    "pegma.dev",
    f.state.policy.version,
    f.support.clock.now(),
  );
  Object.assign(f.state.policy, {
    binding: p.c.policyBinding,
    verifiedAt: p.route.approval.verifiedAt,
    validUntil: p.route.approval.validUntil,
  });
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode("FICTIONAL_COMPARISON_TEST_KEY_32_BYTES"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  const providerKey = vi.fn(() => "fictional-provider-key");
  const options: SupportIndependentChecksOptions = {
    ...p.options,
    readApiKey: providerKey,
    store: checkerStore,
    clock: f.support.clock,
    application: () => f.support.app,
    knowledge: f.kb,
    knowledgeSources: f.sources,
    knowledgeAccess: { resolve: f.ports.resolveKnowledge },
    deferred: true,
    authority: {
      async resolve(signal) {
        const current = await f.ports.resolveService(signal);
        return current.outcome === "ready"
          ? {
              ...current,
              authority: {
                ...current.authority,
                usageScopeRef: p.route.usageScopeRef,
              },
            }
          : current;
      },
    },
    readReceiptKey: () => ({
      id: "fictional-comparison-key",
      key,
      validUntil: p.route.approval.validUntil,
    }),
    usagePolicy: {
      version: "fictional-comparison-funding",
      scopeRef: p.route.usageScopeRef,
      configurationVersion: p.c.version,
      modelVersion: p.c.modelVersion,
      pricingRef: p.c.pricingRef,
      currency: "USD",
      maxCostMicros: 8000,
      maxReservationCostMicros: 1000,
      maxReservations: 8,
      validFrom: f.support.clock.now(),
      validUntil: p.route.approval.validUntil,
      terminalRetentionMilliseconds: 3600000,
    },
  };
  const controller = createSupportIndependentChecks(options, "pegma.dev");
  const learning = staged
    ? createSupportDeskLearning({
        application: f.support.app,
        knowledge: f.ports.knowledge,
        sources: f.sources,
        clock: f.support.clock,
        serviceAccess: { resolve: f.ports.resolveService },
        knowledgeAccess: { resolve: f.ports.resolveKnowledge },
        retirementAccess: { resolve: f.ports.resolveRetirement },
        configuration: { resolve: f.ports.resolveConfiguration },
        checks: f.checks,
        model: { generate: f.ports.generate },
        usage: { reserve: f.ports.reserve, reconcile: f.ports.reconcileUsage },
        targets: { resolveScope: f.ports.resolveScope, select: f.ports.select },
        tokenCounter: {
          count: (text) => new TextEncoder().encode(text).length,
        },
        deliveryMode: "staged",
      })
    : f.learning;
  let scope: ResolutionLearningKey | undefined;
  let hint: IndependentCheckPendingHint | undefined;
  f.ports.resolvePolicy.mockImplementation(controller.resolvePolicy);
  f.ports.verifyChecks.mockImplementation(
    controller.learningSdkVerifier.verify,
  );
  f.ports.check.mockImplementation((input, context) => {
    if (!scope) throw new Error("Actual eligible Source required");
    return controller
      .learningFor(scope, {
        onDurablyDeferred(value) {
          hint = value;
        },
      })
      .check(input, context);
  });
  async function enqueue() {
    scope = await f.eligible("staff_verified_fix");
    expect((await process()).outcome).toBe("candidate");
    const result = await process();
    return result;
  }
  function process() {
    if (!scope) throw new Error("Actual Source scope missing");
    return learning.processWork({
      ...scope,
      workerId: "comparison-background",
      leaseMilliseconds: 30000,
    });
  }
  async function precompute() {
    if (!hint || !scope) throw new Error("Actual deferred hint unavailable");
    return controller.precomputePending(
      hint.operationId,
      {
        deadline: new Date(
          Date.parse(f.support.clock.now()) + 5000,
        ).toISOString(),
        signal: new AbortController().signal,
      },
      scope,
    );
  }
  const knowledge: LearningComparisonKnowledge = f.kb;
  return {
    f,
    p,
    controller,
    options,
    providerKey,
    knowledge,
    enqueue,
    process,
    precompute,
    get hint() {
      return hint;
    },
    get scope() {
      return scope;
    },
    get usageMutations() {
      return usageMutations;
    },
  };
}

async function intrinsicKnowledgeAccess(
  t: Awaited<ReturnType<typeof fixture>>,
) {
  // Public Auth resolver, exact intrinsic draft/source capabilities only.
  // This is a fictional service profile, not a copied host policy or new grant.
  const access = resolveAccess(
    { principalId: "fictional-intrinsic-learning-draft" },
    {
      version: "fictional-intrinsic-draft-v1",
      defaults: [
        supportPermissions.queueRead,
        supportPermissions.learningRead,
        supportPermissions.learningProcess,
        knowledgePermissions.articleRead,
        knowledgePermissions.draftRead,
        knowledgePermissions.draftWrite,
        knowledgePermissions.provenanceRead,
        knowledgePermissions.provenanceWrite,
      ],
    },
  );
  t.f.state.knowledgeAuthority = { ...t.f.state.knowledgeAuthority, access };
  return access;
}

/** The pre-comparison ic2/l wire format, signed with this fixture's fictional
 * key. It exercises supported legacy bytes, not a comparison attestation. All
 * Source/candidate/request coordinates and accepted ACKs come from the real SDK. */
async function legacyIssuer(t: Awaited<ReturnType<typeof fixture>>) {
  const issued = new Map<
    string,
    {
      binding: Parameters<LearningChecksPort["verify"]>[1];
      metadata: NonNullable<Awaited<ReturnType<LearningChecksPort["verify"]>>>;
      mac: Uint8Array<ArrayBuffer>;
      signature: Uint8Array<ArrayBuffer>;
    }
  >();
  const key = t.options.readReceiptKey!()!;
  const policyHash = await knowledgeDigest(t.options.usagePolicy!);
  t.f.ports.check.mockImplementation(async (input) => {
    if (!t.scope) throw new Error("Actual Source required");
    const current = await t.options.authority.resolve(
      new AbortController().signal,
    );
    if (current.outcome !== "ready")
      throw new Error("Actual test authority required");
    const binding = {
      candidateHash: input.binding.candidateHash,
      sourceBindingHash: input.binding.sourceBindingHash,
      policyVersion: input.binding.policyVersion,
      applicabilityHash: input.binding.applicabilityHash,
      targetDecisionHash: input.binding.targetDecisionHash,
      requestHash: input.binding.requestHash,
    };
    const operation = await knowledgeDigest({
      kind: "learning",
      scope: t.scope,
      binding,
      policyVersion: t.p.c.policyVersion,
      policyBinding: t.p.c.policyBinding,
    });
    const issuer = Buffer.from(
      await knowledgeDigest({
        purpose: "support_independent_check",
        issuerId: current.authority.access.principalId,
        authorityVersion: current.authority.authorityVersion,
      }),
      "hex",
    ).toString("base64url");
    const verifiedAt = t.f.support.clock.now();
    const validUntil = t.p.route.approval.validUntil;
    const common = {
      domain: "pegma.dev.support-independent-checks.v2",
      purpose: "support_independent_check",
      kind: "learning",
      operationId: operation,
      issuerBinding: issuer,
      binding,
      keyId: key.id,
      policyVersion: t.p.c.policyVersion,
      policyBinding: t.p.c.policyBinding,
      configurationVersion: t.p.c.version,
      promptVersion: t.p.c.promptVersion,
      modelVersion: t.p.c.modelVersion,
      verifierVersion: t.p.c.parserVersion,
      routePolicyHash: t.p.route.approval.requestPolicySha256,
      verifiedAt,
      validUntil,
      result: {
        privacy: "passed",
        factual: "passed",
        applicability: "passed",
        duplication: "passed",
      },
    };
    const mac = new TextEncoder().encode(JSON.stringify(common));
    const signature = new Uint8Array(
      await crypto.subtle.sign("HMAC", key.key, mac),
    );
    const receipt = [
      "ic2",
      operation,
      issuer,
      Date.parse(verifiedAt).toString(36),
      Date.parse(validUntil).toString(36),
      "l",
      Buffer.from(signature).toString("base64url"),
    ].join(".");
    const payload = JSON.parse(input.exactRequest.draftPayload);
    const source = await t.f.support.app.readResolutionLearningSource(
      t.f.access.service,
      t.scope.ticketId,
    );
    const proof = Buffer.from(
      JSON.stringify({
        version: 1,
        keyId: key.id,
        scope: t.scope,
        issuerId: current.authority.access.principalId,
        authorityVersion: current.authority.authorityVersion,
        policyVersion: t.p.c.policyVersion,
        policyBinding: t.p.c.policyBinding,
        verifierVersion: t.p.c.parserVersion,
        configurationVersion: t.p.c.version,
        promptVersion: t.p.c.promptVersion,
        modelVersion: t.p.c.modelVersion,
        routePolicyHash: t.p.route.approval.requestPolicySha256,
        sourceStamp: await knowledgeDigest(source),
        receiptId: operation,
        verifiedAt,
        validUntil,
        kind: "learning",
        binding,
        target: {
          articleId: input.exactRequest.articleId,
          originalGeneration: input.exactRequest.originalExpectedGeneration,
          originalHash:
            input.targetComparison.existingDraft === undefined
              ? null
              : await knowledgeDigest(
                  JSON.parse(input.targetComparison.existingDraft),
                ),
          outboundHash: await knowledgeDigest(payload.draft),
        },
      }),
    ).toString("base64url");
    await t.f.backing.collection(independentCheckAttempts).update(
      {
        partition: "support_independent_check",
        id: "attempts",
      },
      () => ({
        action: "write",
        value: {
          policyHash,
          observedAt: verifiedAt,
          entries: [
            {
              operation,
              owner: "legacy-format-fixture",
              createdAt: verifiedAt,
              deadline: validUntil,
              kind: "learning",
              scope: t.scope!,
              expiresAt: validUntil,
              issuerId: current.authority.access.principalId,
              authorityVersion: current.authority.authorityVersion,
              request: null,
              state: "checked",
              receiptBytes: proof.length,
              receipt,
              proof,
            },
          ],
        },
      }),
    );
    const metadata = {
      binding,
      privacy: "passed" as const,
      factual: "passed" as const,
      applicability: "passed" as const,
      duplication: "passed" as const,
      verifierReceiptId: operation,
      verifierVersion: t.p.c.parserVersion,
      verifiedAt,
      validUntil,
    };
    issued.set(receipt, { binding, metadata, mac, signature });
    return { outcome: "checked", receipt };
  });
  const verify: LearningChecksPort["verify"] = async (receipt, binding) => {
    const value = issued.get(receipt);
    return value &&
      (await knowledgeDigest(value.binding)) ===
        (await knowledgeDigest(binding)) &&
      (await crypto.subtle.verify("HMAC", key.key, value.signature, value.mac))
      ? structuredClone(value.metadata)
      : null;
  };
  return {
    verify,
    restoreCurrent() {
      t.f.ports.verifyChecks.mockImplementation(
        t.controller.learningSdkVerifier.verify,
      );
    },
  };
}

for (const [backend, createStore] of learningKbStores) {
  describe("real learning comparison (" + backend + ")", () => {
    it("holds missing strict capability without trusting the ordinary empty search", async () => {
      const t = await fixture(createStore());
      // The actual application remains underneath; omit only the optional port.
      Reflect.set(t.options, "knowledge", { getDraft: t.f.kb.getDraft });
      const result = await t.enqueue();
      expect(result.outcome).toBe("held");
      expect(t.hint).toBeUndefined();
      expect(t.providerKey).not.toHaveBeenCalled();
      expect(t.p.state.calls).toBe(0);
      expect(t.usageMutations).toBe(0);
      expect(
        await t.f.backing.collection(independentCheckAttempts).get({
          partition: "support_independent_check",
          id: "attempts",
        }),
      ).toBeNull();
    });

    it.each(["partial", "unavailable"] as const)(
      "holds an explicit %s observation before reserve, key or provider",
      async (outcome) => {
        const t = await fixture(createStore());
        const observe = vi.fn(async () => ({ outcome, articles: [] as const }));
        const confirm = vi.fn();
        // A negative capability response cannot attest coverage; no fake complete
        // response or model result is used in this failure-boundary test.
        Reflect.set(t.options, "knowledge", {
          getDraft: t.f.kb.getDraft,
          publishedSearchObservations: {
            observe,
            confirm,
            readScope: incompleteResourceRead,
            readArticle: incompleteResourceRead,
          },
        });
        await t.enqueue();
        expect(t.hint).toBeDefined();
        expect(observe).not.toHaveBeenCalled();
        expect((await t.precompute()).outcome).toBe("held");
        expect(observe).toHaveBeenCalledOnce();
        expect(confirm).not.toHaveBeenCalled();
        expect(t.providerKey).not.toHaveBeenCalled();
        expect(t.p.state.calls).toBe(0);
        expect(t.usageMutations).toBe(0);
      },
    );

    it("rejects malformed and cross-scope selection clones without asking a port to assert completeness", async () => {
      const t = await fixture(createStore());
      await t.enqueue();
      const original = t.f.ports.check.mock.calls[0]![0];
      const context = t.f.ports.check.mock.calls[0]![1];
      const before = await t.f.backing
        .collection(independentCheckAttempts)
        .get({
          partition: "support_independent_check",
          id: "attempts",
        });
      const observe = vi.fn(async () => ({
        outcome: "partial" as const,
        articles: [] as const,
      }));
      Reflect.set(t.options, "knowledge", {
        getDraft: t.f.kb.getDraft,
        publishedSearchObservations: {
          observe,
          confirm: vi.fn(),
          readScope: incompleteResourceRead,
          readArticle: incompleteResourceRead,
        },
      });
      for (const change of [
        "missing",
        "scope",
        "extra",
        "oversized",
      ] as const) {
        const input = structuredClone(original);
        const selection = input.targetComparison.selection!;
        if (change === "missing")
          Reflect.deleteProperty(input.targetComparison, "selection");
        if (change === "scope")
          selection.scope.collectionId = "another-authorized-scope";
        if (change === "extra") Reflect.set(selection, "complete", true);
        if (change === "oversized")
          selection.scope.explicitDraftIds = Array.from(
            { length: 6 },
            (_, i) => "unconfirmed-" + i,
          );
        expect(
          (await t.controller.learningFor(t.scope!).check(input, context))
            .outcome,
        ).toBe("held");
      }
      expect(observe).not.toHaveBeenCalled();
      expect(t.providerKey).not.toHaveBeenCalled();
      expect(t.p.state.calls).toBe(0);
      expect(t.usageMutations).toBe(0);
      expect(
        await t.f.backing.collection(independentCheckAttempts).get({
          partition: "support_independent_check",
          id: "attempts",
        }),
      ).toEqual(before);
    });

    it("retains legacy update checks without requiring the new create-only scope capability", async () => {
      const t = await fixture(createStore());
      await t.f.createGuide(
        "legacy-update-target",
        "Existing guidance that the actual current target selection merges.",
      );
      t.f.updateTarget("legacy-update-target");
      Reflect.set(t.options, "deferred", false);
      const result = await t.enqueue();
      expect(result.outcome).toBe("delivered");
      expect(t.p.state.calls).toBe(1);
      const head = await t.f.backing.collection(independentCheckAttempts).get({
        partition: "support_independent_check",
        id: "attempts",
      });
      const receipt = head!.entries[0]!.receipt!;
      expect(receipt.split(".")[5]).toBe("l");
      const input = t.f.ports.check.mock.calls[0]![0];
      expect(
        await t.controller.learningSdkVerifier.verify(receipt, input.binding),
      ).not.toBeNull();
    });

    it("rejects a signed old-l create for a new KB write even with a caller-supplied accepted-ACK claim", async () => {
      const t = await fixture(createStore());
      await legacyIssuer(t);
      expect((await t.enqueue()).outcome).toBe("held");
      const head = await t.f.backing.collection(independentCheckAttempts).get({
        partition: "support_independent_check",
        id: "attempts",
      });
      const receipt = head!.entries[0]!.receipt!;
      const input = t.f.ports.check.mock.calls[0]![0];
      expect(
        await t.controller.learningSdkVerifier.verify(receipt, input.binding),
      ).toBeNull();
      expect(
        await t.controller
          .learningFor(t.scope!)
          .verify(receipt, input.binding, undefined, {
            acceptedAcknowledgement: {
              id: input.exactRequest.articleId,
              generation: 1,
              articleRevision: 1,
              contentHash: "a".repeat(64),
              state: "draft",
            },
          }),
      ).toBeNull();
      expect(
        t.f.ports.knowledgeCalls.filter((c) => c.operation === "createDraft"),
      ).toHaveLength(0);
      expect(t.providerKey).not.toHaveBeenCalled();
      expect(t.p.state.calls).toBe(0);
    });

    it("recovers a real already-accepted legacy create ACK without a second KB write or new comparison claim", async () => {
      const t = await fixture(createStore(), true);
      const legacy = await legacyIssuer(t);
      // Reproduce the prior trusted issuer boundary only while the real SDK
      // prepares and accepts the exact request. No Work/KB row is fabricated.
      t.f.ports.verifyChecks.mockImplementation(legacy.verify);
      expect(await t.enqueue()).toMatchObject({ checkpoint: "prepared" });
      expect(await t.process()).toMatchObject({ checkpoint: "acknowledged" });
      const before = await t.f.support.app.readResolutionLearningWork(
        t.f.access.staff,
        t.scope!,
      );
      expect(before.acknowledgement).toBeDefined();
      expect(before.target).toBeUndefined();
      legacy.restoreCurrent();
      const input = t.f.ports.check.mock.calls[0]![0];
      // The normal App two-argument verifier never authorizes old-l create.
      expect(
        await t.controller.learningSdkVerifier.verify(
          before.verifiedCheckReceipt!,
          input.binding,
        ),
      ).toBeNull();
      expect((await t.process()).outcome).toBe("delivered");
      const after = await t.f.support.app.readResolutionLearningWork(
        t.f.access.staff,
        t.scope!,
      );
      expect(after.acknowledgement).toEqual(before.acknowledgement);
      expect(after.target?.articleId).toBe(before.acknowledgement?.id);
      expect(
        t.f.ports.knowledgeCalls.filter((c) => c.operation === "createDraft"),
      ).toHaveLength(1);
      expect(t.providerKey).not.toHaveBeenCalled();
      expect(t.p.state.calls).toBe(0);
    });

    it("holds KB-accepted legacy delivery with a lost SDK ACK instead of replaying a possibly new write", async () => {
      const t = await fixture(createStore(), true);
      const legacy = await legacyIssuer(t);
      t.f.ports.verifyChecks.mockImplementation(legacy.verify);
      expect(await t.enqueue()).toMatchObject({ checkpoint: "prepared" });
      let lost = false;
      t.f.interceptKnowledge(async (call, invoke) => {
        if (call.operation !== "createDraft" || lost) return invoke();
        await invoke();
        lost = true;
        throw new Error("Fictional actual KB acceptance with lost SDK ACK");
      });
      expect((await t.process()).outcome).toBe("pending");
      const before = await t.f.support.app.readResolutionLearningWork(
        t.f.access.staff,
        t.scope!,
      );
      expect(lost).toBe(true);
      expect(before.acknowledgement).toBeUndefined();
      const accepted = await t.f.kb.getDraft(t.f.access.admin, {
        articleId: before.exactRequest!.articleId,
      });
      expect(accepted.revision.number).toBe(1);
      legacy.restoreCurrent();
      expect((await t.process()).outcome).toBe("held");
      const after = await t.f.support.app.readResolutionLearningWork(
        t.f.access.staff,
        t.scope!,
      );
      expect(after.acknowledgement).toBeUndefined();
      expect(after.exactRequest).toEqual(before.exactRequest);
      expect(after.requestHash).toBe(before.requestHash);
      const source = await t.f.support.app.readResolutionLearningSource(
        t.f.access.staff,
        t.scope!.ticketId,
      );
      expect(source.reconciliationPending).toBe(true);
      expect(
        source.destinations.find((row) => row.articleId === accepted.articleId)
          ?.acceptance,
      ).toBe("unknown");
      expect(
        t.f.ports.knowledgeCalls.filter((c) => c.operation === "createDraft"),
      ).toHaveLength(1);
      expect(t.providerKey).not.toHaveBeenCalled();
      expect(t.p.state.calls).toBe(0);
    });

    it.each(["private", "bot-only"] as const)(
      "uses the intrinsic draft ceiling for %s guidance and fresh parallel proof/scope reads",
      async (mode) => {
        const t = await fixture(createStore());
        if (mode === "bot-only") {
          const preview = await t.f.kb.previewCollectionPolicy(
            t.f.access.admin,
            {
              collectionId: learningKbCollectionId,
              uses: {
                portal: { enabled: false },
                bot: {
                  enabled: true,
                  audience: {
                    kind: "permission",
                    permission: learningKbAudience,
                  },
                },
              },
            },
          );
          await t.f.kb.updateCollectionPolicy(t.f.access.admin, {
            ...t.f.command("bot-only-authoring-scope", preview.generation),
            collectionId: learningKbCollectionId,
            preview: preview.preview,
          });
        }
        // Publish through the actual KB approval path, without using a portal
        // read/index fixture that cannot operate in a bot-only collection.
        await t.f.createGuide(
          "private-comparison-guide",
          "Distinct approved workspace reference available to authoring staff.",
        );
        await t.f.issueGuideEvidence("private-comparison-guide");
        const draft = await t.f.kb.getDraft(t.f.access.guideAuthor, {
          articleId: "private-comparison-guide",
        });
        await t.f.kb.submitForReview(t.f.access.guideAuthor, {
          ...t.f.command("authoring-comparison-review", draft.generation),
          articleId: draft.articleId,
        });
        const review = await t.f.kb.getReview(t.f.access.admin, {
          articleId: draft.articleId,
        });
        await t.f.kb.publishArticle(t.f.access.admin, {
          ...t.f.command("authoring-comparison-publish", review.generation),
          articleId: draft.articleId,
          review: review.review,
        });
        const access = await intrinsicKnowledgeAccess(t);
        expect(access.permissions).not.toContain(
          knowledgePermissions.collectionRead,
        );
        expect(access.permissions).not.toContain(learningKbAudience);
        await expect(
          t.f.kb.getCollection(access, {
            collectionId: learningKbCollectionId,
          }),
        ).rejects.toBeInstanceOf(KnowledgeBaseAuthorizationError);
        await expect(
          t.f.kb.getPublishedArticle(access, { articleId: draft.articleId }),
        ).rejects.toBeInstanceOf(KnowledgeBaseNotFoundError);
        await t.f.kb.getValidationRequirements(access, {
          collectionId: learningKbCollectionId,
          kind: "explanation",
        });
        const observer = t.knowledge.publishedSearchObservations;
        if (!observer?.readArticle)
          throw new Error(
            "Actual KB background observation capability required",
          );
        expect(
          (await observer.readArticle(access, { articleId: draft.articleId }))
            .articleId,
        ).toBe(draft.articleId);
        await t.enqueue();
        const checked = await t.precompute();
        if (checked.outcome !== "checked")
          throw new Error("Actual checked snapshot required");
        const wire = JSON.parse(String(t.p.state.requests[0]!.init.body));
        expect(
          JSON.parse(wire.messages[1].content).comparison.publishedMatches[0]
            .content.text,
        ).toContain("Distinct approved workspace reference");
        const input = t.f.ports.check.mock.calls[0]![0];
        const headGate = learningKbBarrier();
        const scopeGate = learningKbBarrier();
        const backing = t.options.store;
        const store: Store = {
          collection(definition) {
            const target = backing.collection(definition);
            if (definition.name !== independentCheckAttempts.name)
              return target;
            const get: typeof target.get = async (...args) => {
              const actual = await target.get(...args);
              await headGate.wait();
              return actual;
            };
            return new Proxy(target, {
              get(object, property) {
                if (property === "get") return get;
                const value: unknown = Reflect.get(object, property, object);
                return typeof value === "function" ? value.bind(object) : value;
              },
            });
          },
        };
        const readScope = vi.fn(
          async (...args: Parameters<typeof observer.readScope>) => {
            const actual = await observer.readScope(...args);
            await scopeGate.wait();
            return actual;
          },
        );
        Reflect.set(t.options, "store", store);
        Reflect.set(t.options, "knowledge", {
          ...t.knowledge,
          publishedSearchObservations: { ...observer, readScope },
        });
        const pending = t.controller
          .learningFor(t.scope!)
          .verify(checked.receipt, input.binding, undefined, {
            comparisonScope: { collectionId: learningKbCollectionId },
          });
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            Promise.all([headGate.reached, scopeGate.reached]),
            pending.then(() => {
              throw new Error(
                "Receipt returned before both genuine reads reached their barriers",
              );
            }),
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(
                () =>
                  reject(
                    new Error(
                      "Sequential read mutant cannot reach both barriers",
                    ),
                  ),
                2000,
              );
            }),
          ]);
        } finally {
          if (timer !== undefined) clearTimeout(timer);
          headGate.release();
          scopeGate.release();
          await pending;
        }
        expect(await pending).not.toBeNull();
        expect(readScope).toHaveBeenCalledOnce();
        expect(
          await t.controller
            .learningFor(t.scope!)
            .verify(checked.receipt, input.binding, undefined, {
              comparisonScope: { collectionId: "different-signed-scope" },
            }),
        ).toBeNull();
        expect(t.p.state.calls).toBe(1);
      },
    );

    it("uses genuine complete empty scoped evidence only in deferred precompute, then writes one checked draft", async () => {
      const t = await fixture(createStore(), true);
      const access = await intrinsicKnowledgeAccess(t);
      expect(access.permissions).not.toContain(learningKbAudience);
      expect(access.permissions).not.toContain(
        knowledgePermissions.collectionRead,
      );
      const observer = t.knowledge.publishedSearchObservations;
      if (!observer)
        throw new Error("Actual KB background observation capability required");
      const observe = vi.fn(observer.observe.bind(observer));
      const confirm = vi.fn(observer.confirm.bind(observer));
      Reflect.set(t.options, "knowledge", {
        getDraft: t.f.kb.getDraft,
        getProvenance: t.f.kb.getProvenance,
        getPublishedArticle: t.f.kb.getPublishedArticle,
        publishedSearchObservations: {
          observe,
          confirm,
          readScope: observer.readScope.bind(observer),
          readArticle: observer.readArticle?.bind(observer),
        },
      });
      await t.enqueue();
      expect(observe).not.toHaveBeenCalled();
      expect(t.providerKey).not.toHaveBeenCalled();
      const result = await t.precompute();
      expect(result.outcome).toBe("checked");
      if (result.outcome !== "checked")
        throw new Error("Genuine complete check required");
      expect(result.receipt.split(".")[5]).toBe("c");
      expect(result.receipt.length).toBeLessThanOrEqual(200);
      expect(observe).toHaveBeenCalledOnce();
      expect(confirm).toHaveBeenCalledOnce();
      expect(t.p.state.calls).toBe(1);
      const wire = JSON.parse(String(t.p.state.requests[0]!.init.body));
      const input = JSON.parse(wire.messages[1].content);
      expect(input.comparison.scope.coverage).toBe(
        "complete_authorized_search_scope",
      );
      expect(input.comparison.scope.globalAbsenceClaim).toBe(false);
      expect(input.comparison.publishedMatches).toEqual([]);
      expect(input.comparison.explicitDrafts).toEqual([]);
      expect(JSON.stringify(input.comparison)).not.toContain(
        learningKbCollectionId,
      );
      expect(await t.process()).toMatchObject({ checkpoint: "prepared" });
      const prepared = await t.f.support.app.readResolutionLearningWork(
        t.f.access.staff,
        t.scope!,
      );
      expect(prepared.exactRequest).toEqual(
        t.f.ports.check.mock.calls[0]![0].exactRequest,
      );
      // Point-in-time coverage is not a membership lock. This later new member
      // is for the next background comparison, not an inline corpus rescan.
      const beforeMember = await observer.readScope(
        t.f.state.knowledgeAuthority.access,
        { collectionId: learningKbCollectionId },
      );
      await t.f.publishIndependentGuide(
        "added-after-snapshot",
        "New independently verified workspace reference.",
      );
      expect(
        await observer.readScope(t.f.state.knowledgeAuthority.access, {
          collectionId: learningKbCollectionId,
        }),
      ).toEqual(beforeMember);
      expect(await t.process()).toMatchObject({ checkpoint: "acknowledged" });
      const delivered = await t.process();
      expect(delivered, JSON.stringify(delivered)).toMatchObject({
        outcome: "delivered",
      });
      const completed = await t.f.support.app.readResolutionLearningWork(
        t.f.access.staff,
        t.scope!,
      );
      expect(completed.exactRequest).toEqual(prepared.exactRequest);
      expect(observe).toHaveBeenCalledOnce();
      expect(confirm).toHaveBeenCalledOnce();
      expect(t.p.state.calls).toBe(1);
      expect(
        t.f.ports.knowledgeCalls.filter((c) => c.operation === "createDraft"),
      ).toHaveLength(1);
      const captured = t.f.ports.check.mock.calls[0]![0];
      expect(
        await t.controller
          .learningFor(t.scope!)
          .verify(result.receipt.replace(".c.", ".l."), captured.binding),
      ).toBeNull();
      expect(
        await t.controller
          .learningFor({
            ticketId: "different-source",
            sourceGeneration: t.scope!.sourceGeneration,
          })
          .verify(result.receipt, captured.binding),
      ).toBeNull();
    });

    it("holds an actual comparison scope with more results than its bound before provider admission", async () => {
      const t = await fixture(createStore());
      for (let i = 0; i < 6; i++)
        await t.f.publishIndependentGuide(
          "matching-guide-" + i,
          "Distinct approved workspace export reference " + i + ".",
        );
      await t.enqueue();
      expect(t.hint).toBeDefined();
      expect((await t.precompute()).outcome).toBe("held");
      expect(t.providerKey).not.toHaveBeenCalled();
      expect(t.p.state.calls).toBe(0);
      expect(
        t.f.ports.knowledgeCalls.filter((c) => c.operation === "createDraft"),
      ).toHaveLength(0);
    });

    it("invalidates an empty checked snapshot after the actual collection closes", async () => {
      const t = await fixture(createStore());
      await t.enqueue();
      const checked = await t.precompute();
      if (checked.outcome !== "checked")
        throw new Error("Actual checked empty snapshot required");
      const preview = await t.f.kb.previewCollectionPolicy(t.f.access.admin, {
        collectionId: learningKbCollectionId,
        uses: { portal: { enabled: false }, bot: { enabled: false } },
      });
      await t.f.kb.updateCollectionPolicy(t.f.access.admin, {
        ...t.f.command("close-empty-comparison", preview.generation),
        collectionId: learningKbCollectionId,
        preview: preview.preview,
      });
      const input = t.f.ports.check.mock.calls[0]![0];
      expect(
        await t.controller
          .learningFor(t.scope!)
          .verify(checked.receipt, input.binding),
      ).toBeNull();
      expect((await t.process()).outcome).toBe("held");
      expect(
        t.f.ports.knowledgeCalls.filter((c) => c.operation === "createDraft"),
      ).toHaveLength(0);
      expect(t.p.state.calls).toBe(1);
    });

    it("uses current intrinsic access for the real closing observation and withholds after late authority revocation", async () => {
      const t = await fixture(createStore());
      const access = await intrinsicKnowledgeAccess(t);
      const observer = t.knowledge.publishedSearchObservations;
      if (!observer)
        throw new Error("Actual KB background observation capability required");
      const confirm = vi.fn(
        async (...args: Parameters<typeof observer.confirm>) => {
          expect(args[0]).toEqual(access);
          await observer.confirm(...args);
          t.f.state.knowledgeOutcome = "inactive";
        },
      );
      Reflect.set(t.options, "knowledge", {
        ...t.knowledge,
        publishedSearchObservations: { ...observer, confirm },
      });
      await t.enqueue();
      expect((await t.precompute()).outcome).toBe("held");
      expect(confirm).toHaveBeenCalledOnce();
      expect(t.p.state.calls).toBe(1);
      const head = await t.f.backing.collection(independentCheckAttempts).get({
        partition: "support_independent_check",
        id: "attempts",
      });
      expect(head!.entries[0]).toMatchObject({
        state: "held",
        proof: null,
        receipt: null,
      });
      expect(
        t.f.ports.knowledgeCalls.filter((c) => c.operation === "createDraft"),
      ).toHaveLength(0);
    });

    it("compares actual authorized explicit draft content while excluding its provenance and resource IDs", async () => {
      const t = await fixture(createStore());
      await t.f.createGuide(
        "explicit-private-draft",
        "Approved comparison content for an unpublished workspace guide.",
        [
          {
            id: "PRIVATE_COMPARISON_REFERENCE",
            system: "synthetic-docs",
            resourceId: "PRIVATE_COMPARISON_DOCUMENT",
            version: "1",
          },
        ],
      );
      t.f.state.scope = {
        ...t.f.state.scope,
        explicitDraftIds: ["explicit-private-draft"],
      };
      await t.enqueue();
      expect((await t.precompute()).outcome).toBe("checked");
      const wire = JSON.parse(String(t.p.state.requests[0]!.init.body));
      const input = JSON.parse(wire.messages[1].content);
      expect(input.comparison.explicitDrafts).toHaveLength(1);
      expect(input.comparison.explicitDrafts[0].content.text).toContain(
        "Approved comparison content",
      );
      expect(JSON.stringify(input.comparison)).not.toContain(
        "explicit-private-draft",
      );
      expect(JSON.stringify(input.comparison)).not.toContain(
        "sourceReferences",
      );
      expect(JSON.stringify(input.comparison)).not.toContain("provenance");
      expect(JSON.stringify(input.comparison)).not.toContain(
        "PRIVATE_COMPARISON_REFERENCE",
      );
      expect(JSON.stringify(input.comparison)).not.toContain(
        "PRIVATE_COMPARISON_DOCUMENT",
      );
      expect(t.f.otherSources.canRead).toHaveBeenCalled();
      expect(t.p.state.calls).toBe(1);
    });

    it("does not turn earlier caller-empty hints into a passing absence claim when a real matching guide appears", async () => {
      const t = await fixture(createStore());
      await t.enqueue();
      const selected =
        t.f.ports.check.mock.calls[0]![0].targetComparison.selection;
      expect(selected?.published).toEqual([]);
      await t.f.publishIndependentGuide(
        "comparison-existing",
        "Existing approved workspace export procedure. Open Workspace and choose Export.",
      );
      t.p.state.document.choices[0]!.message.content = JSON.stringify({
        ...CHECK_PASS,
        duplication: "failed",
        findings: [
          {
            dimension: "duplication",
            exactText: "Open Workspace.",
            reason: "This procedure repeats the supplied existing guide.",
          },
        ],
      });
      expect((await t.precompute()).outcome).toBe("held");
      expect(t.p.state.calls).toBe(1);
      const wire = JSON.parse(String(t.p.state.requests[0]!.init.body));
      const input = JSON.parse(wire.messages[1].content);
      expect(input.comparison.publishedMatches).toHaveLength(1);
      expect(input.comparison.publishedMatches[0].content.text).toContain(
        "Existing approved",
      );
      expect(JSON.stringify(input.comparison)).not.toContain(
        "comparison-existing",
      );
      expect(
        t.f.ports.knowledgeCalls.filter((c) => c.operation === "createDraft"),
      ).toHaveLength(0);
    });

    it("withholds a receipt when the real compared KB resources change during the model await", async () => {
      const t = await fixture(createStore());
      await t.f.publishIndependentGuide(
        "comparison-changed",
        "Existing workspace guide with distinct explanation.",
      );
      await t.enqueue();
      const fetch = t.options.fetch!;
      const changedFetch: NonNullable<
        SupportIndependentChecksOptions["fetch"]
      > = async (url, init) => {
        const response = await fetch(url, init);
        const current = await t.f.kb.getDraft(t.f.access.admin, {
          articleId: "comparison-changed",
        });
        await t.f.kb.updateDraft(t.f.access.admin, {
          ...t.f.command("changed-during-check", current.generation),
          articleId: current.articleId,
          collectionId: learningKbCollectionId,
          draft: {
            kind: current.revision.kind,
            title: current.revision.title,
            summary: current.revision.summary,
            content: {
              format: "plain_text",
              text: "Changed authoritative workspace guidance.",
            },
            tags: current.revision.tags,
            applicability: current.revision.applicability,
          },
          sourceReferences: [],
        });
        return response;
      };
      Reflect.set(t.options, "fetch", changedFetch);
      expect((await t.precompute()).outcome).toBe("held");
      expect(t.p.state.calls).toBe(1);
      expect(
        t.f.ports.knowledgeCalls.filter((c) => c.operation === "createDraft"),
      ).toHaveLength(0);
    });

    it("invalidates the checked snapshot after a retained publication is retired without a new corpus scan", async () => {
      const t = await fixture(createStore());
      await t.f.publishIndependentGuide(
        "comparison-retired",
        "Existing workspace reference with a different useful purpose.",
      );
      await t.enqueue();
      const checked = await t.precompute();
      expect(checked.outcome).toBe("checked");
      if (checked.outcome !== "checked")
        throw new Error("Checked snapshot required");
      const current = await t.f.kb.getDraft(t.f.access.admin, {
        articleId: "comparison-retired",
      });
      await t.f.kb.retireArticle(t.f.access.admin, {
        ...t.f.command("retire-comparison", current.generation),
        articleId: current.articleId,
      });
      const captured = t.f.ports.check.mock.calls[0]![0];
      expect(
        await t.controller
          .learningFor(t.scope!)
          .verify(checked.receipt, captured.binding),
      ).toBeNull();
      expect((await t.process()).outcome).toBe("held");
      expect(t.p.state.calls).toBe(1);
      expect(
        t.f.ports.knowledgeCalls.filter((c) => c.operation === "createDraft"),
      ).toHaveLength(0);
    });
  });
}
