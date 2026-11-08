import type { AccessContext } from "@pegma/authorization-core";
import {
  knowledgePermissions,
  type PrivateSourceReference,
  type PrivateSourcesVerifier,
  type SourceEligibilityRequest,
} from "@pegma/knowledge-base-application";
import {
  supportPermissions,
  type ResolutionLearningApplication,
} from "@pegma/support-desk-application";
import { describe, expect, it, vi } from "vitest";
import { createSupportDeskLearningSourceVerifier } from "../packages/ai/src/learning-sources.js";
import type {
  LearningCheckPolicyPort,
  LearningServiceAccessPort,
  LearningServiceAuthority,
  VerifiedLearningCheckPolicy,
} from "../packages/ai/src/learning-ports.js";
import { handlingBarrier } from "../test/handling-fixtures.js";
import {
  learningCustomer,
  learningService,
  learningStaff,
  learningStores,
} from "../test/resolution-learning-fixtures.js";
import { learningKbFixture } from "../test/resolution-learning-kb-fixtures.js";

type Fixture = Awaited<ReturnType<typeof learningKbFixture>>;
type SourceApplication = Pick<
  ResolutionLearningApplication,
  | "readResolutionLearningSource"
  | "confirmResolutionLearningSource"
  | "confirmResolutionLearningTargetReview"
  | "readResolutionLearningReconciliation"
>;

/** Only external authority/policy ports are scripted; every source fact is real. */
function sourceVerifier(
  f: Fixture,
  options: {
    readonly application?: SourceApplication;
    readonly otherSources?: PrivateSourcesVerifier;
    readonly maxOperationMilliseconds?: number;
  } = {},
) {
  const state: {
    authority: LearningServiceAuthority;
    authorityOutcome: "ready" | "inactive" | "unavailable";
    policy: VerifiedLearningCheckPolicy;
    policyOutcome: "ready" | "disabled" | "unavailable";
  } = {
    authority: {
      access: learningService,
      authorityVersion: "current-source-service-v1",
      usageScopeRef: "source-service-scope",
    },
    authorityOutcome: "ready",
    policy: {
      version: "synthetic-check-policy-v1",
      binding: "current-source-review-policy",
      verifiedAt: f.support.clock.now(),
      validUntil: new Date(
        Date.parse(f.support.clock.now()) + 3_600_000,
      ).toISOString(),
    },
    policyOutcome: "ready",
  };
  const resolveAuthority = vi.fn<LearningServiceAccessPort["resolve"]>(
    async () =>
      state.authorityOutcome === "ready"
        ? { outcome: "ready", authority: structuredClone(state.authority) }
        : { outcome: state.authorityOutcome },
  );
  const resolvePolicy = vi.fn<LearningCheckPolicyPort["resolvePolicy"]>(
    async () =>
      state.policyOutcome === "ready"
        ? { outcome: "ready", policy: structuredClone(state.policy) }
        : { outcome: state.policyOutcome },
  );
  const real = options.application ?? f.support.app;
  const application = {
    readResolutionLearningSource: vi.fn<
      SourceApplication["readResolutionLearningSource"]
    >((...args) => real.readResolutionLearningSource(...args)),
    confirmResolutionLearningSource: vi.fn<
      SourceApplication["confirmResolutionLearningSource"]
    >((...args) => real.confirmResolutionLearningSource(...args)),
    confirmResolutionLearningTargetReview: vi.fn<
      SourceApplication["confirmResolutionLearningTargetReview"]
    >((...args) => real.confirmResolutionLearningTargetReview(...args)),
    readResolutionLearningReconciliation: vi.fn<
      SourceApplication["readResolutionLearningReconciliation"]
    >((...args) => real.readResolutionLearningReconciliation(...args)),
  };
  const sources = createSupportDeskLearningSourceVerifier({
    application,
    serviceAccess: { resolve: resolveAuthority },
    reviewPolicy: { resolvePolicy },
    clock: f.support.clock,
    ...(options.otherSources === undefined
      ? {}
      : { otherSources: options.otherSources }),
    ...(options.maxOperationMilliseconds === undefined
      ? {}
      : { maxOperationMilliseconds: options.maxOperationMilliseconds }),
  });
  return { sources, state, resolveAuthority, resolvePolicy, application };
}

async function currentContext(
  f: Fixture,
  articleId: string,
): Promise<SourceEligibilityRequest> {
  const draft = await f.kb.getDraft(f.access.admin, { articleId });
  const provenance = await f.kb.getProvenance(f.access.admin, { articleId });
  return { article: draft.revision, snapshot: provenance.snapshot };
}

async function setSources(
  f: Fixture,
  articleId: string,
  references: readonly PrivateSourceReference[],
) {
  const draft = await f.kb.getDraft(f.access.admin, { articleId });
  await f.kb.setProvenance(f.access.admin, {
    ...f.command("staff-source-edit", draft.generation),
    articleId,
    references,
  });
  return currentContext(f, articleId);
}

function foreignVerifier() {
  return {
    canRead: vi.fn<PrivateSourcesVerifier["canRead"]>(async () => true),
    isCurrent: vi.fn<PrivateSourcesVerifier["isCurrent"]>(async () => true),
    canPublish: vi.fn<PrivateSourcesVerifier["canPublish"]>(async () => true),
  };
}

function draftInput(request: SourceEligibilityRequest) {
  const { kind, title, summary, content, tags, applicability } =
    request.article;
  return { kind, title, summary, content, tags, applicability };
}

async function aggregate(f: Fixture) {
  const first = await f.eligible();
  const draft = await f.processToDraft(first);
  const second = await f.eligible("staff_verified_fix", "second-contributor");
  f.updateTarget(draft.articleId);
  await f.processToDraft(second);
  return { articleId: draft.articleId, first, second };
}

for (const [name, createStore] of learningStores) {
  describe(`learning source verifier with actual Support and released KB (${name})`, () => {
    it("checks known source identity, resource, version and current resolution cycle against real source facts", async () => {
      const f = await learningKbFixture(createStore());
      const first = await f.eligible();
      const draft = await f.processToDraft(first);
      const other = await f.eligible(
        "customer_confirmation",
        "different-ticket",
      );
      const valid = await currentContext(f, draft.articleId);
      const reference = valid.snapshot.references[0]!;
      const verifier = sourceVerifier(f);
      expect(await verifier.sources.isCurrent(valid)).toBe(true);
      for (const replacement of [
        { ...reference, id: `${reference.id}:wrong` },
        { ...reference, resourceId: other.ticketId },
        { ...reference, version: "wrong-source-binding" },
      ]) {
        // These are actual KB snapshots accepted under current source-read
        // authority, not invented hashes or filtered callback contexts.
        const context = await setSources(f, draft.articleId, [replacement]);
        expect(await verifier.sources.isCurrent(context)).toBe(false);
        expect(await verifier.sources.canPublish(context)).toBe(false);
      }
      const restored = await setSources(f, draft.articleId, [reference]);
      expect(await verifier.sources.isCurrent(restored)).toBe(true);
      const originalCycle = (await f.support.source()).resolutionCycle;
      await f.support.app.reopenTicket(
        learningStaff,
        f.support.command("reopen-source-cycle"),
      );
      expect(await verifier.sources.isCurrent(restored)).toBe(false);
      await f.support.app.resolveTicket(
        learningStaff,
        f.support.command("resolve-next-cycle"),
      );
      await f.support.confirm();
      const nextSource = await f.support.source();
      expect(nextSource.resolutionCycle).toBeGreaterThan(originalCycle);
      expect(nextSource.sourceGeneration).toBeGreaterThan(
        first.sourceGeneration,
      );
      expect(await verifier.sources.isCurrent(restored)).toBe(false);
      const next = await setSources(f, draft.articleId, [await f.reference()]);
      expect(await verifier.sources.isCurrent(next)).toBe(true);
      expect(await verifier.sources.canPublish(next)).toBe(false);
    });

    it("requires every contributor current but only one exact aggregate Support approval, retaining the old publication approval", async () => {
      const f = await learningKbFixture(createStore());
      const first = await f.eligible();
      const draft = await f.processToDraft(first);
      await f.supportReview(draft.articleId);
      await f.issueGuideEvidence(draft.articleId);
      const published = await f.publish(draft.articleId);
      const publicationContext = await currentContext(f, draft.articleId);
      const second = await f.eligible(
        "staff_verified_fix",
        "second-contributor",
      );
      f.updateTarget(draft.articleId);
      await f.processToDraft(second);
      const aggregateContext = await currentContext(f, draft.articleId);
      const verifier = sourceVerifier(f);
      expect(aggregateContext.snapshot.references).toHaveLength(2);
      expect(await verifier.sources.isCurrent(aggregateContext)).toBe(true);
      expect(await verifier.sources.canPublish(aggregateContext)).toBe(false);
      await f.supportReview(draft.articleId, second.ticketId);
      expect(await verifier.sources.canPublish(aggregateContext)).toBe(true);
      expect(await verifier.sources.canPublish(publicationContext)).toBe(true);
      expect(
        await f.kb.getPublishedArticle(f.access.customer, {
          articleId: draft.articleId,
        }),
      ).toEqual(published);
      await f.support.app.reopenTicket(
        learningStaff,
        f.support.command("reopen-unreviewed-contributor"),
      );
      expect(await verifier.sources.isCurrent(aggregateContext)).toBe(false);
      expect(await verifier.sources.canPublish(aggregateContext)).toBe(false);
    });

    it.each(["content", "reference-order", "new-snapshot"] as const)(
      "invalidates exact Support approval after a real KB %s change",
      async (change) => {
        const f = await learningKbFixture(createStore());
        const { articleId, second } = await aggregate(f);
        await f.supportReview(articleId);
        const original = await currentContext(f, articleId);
        const originalTarget = await f.currentTarget(articleId);
        const verifier = sourceVerifier(f);
        expect(await verifier.sources.canPublish(original)).toBe(true);
        if (change === "content") {
          const current = await f.kb.getDraft(f.access.admin, { articleId });
          await f.kb.updateDraft(f.access.admin, {
            ...f.command("local-staff-content-edit", current.generation),
            articleId,
            collectionId: current.revision.collectionId,
            draft: {
              ...draftInput(original),
              content: {
                format: "plain_text",
                text: "Locally edited, unreviewed export instructions.",
              },
            },
          });
        } else {
          await setSources(
            f,
            articleId,
            change === "reference-order"
              ? [...original.snapshot.references].reverse()
              : original.snapshot.references,
          );
        }
        const changed = await currentContext(f, articleId);
        expect(await f.currentTarget(articleId)).not.toEqual(originalTarget);
        expect(await verifier.sources.isCurrent(changed)).toBe(true);
        expect(await verifier.sources.canPublish(changed)).toBe(false);
        await f.supportReview(articleId, second.ticketId);
        expect(await verifier.sources.canPublish(changed)).toBe(true);
      },
    );

    it("allows Support approval before a KB review snapshot while retaining KB evidence and publication gates", async () => {
      const f = await learningKbFixture(createStore());
      const draft = await f.processToDraft(await f.eligible());
      await expect(
        f.kb.getReview(f.access.admin, { articleId: draft.articleId }),
      ).rejects.toThrow();
      const context = await currentContext(f, draft.articleId);
      expect(await f.sources.canPublish(context)).toBe(false);
      await f.supportReview(draft.articleId);
      expect(await f.sources.canPublish(context)).toBe(true);
      const before = await f.kb.getDraft(f.access.admin, {
        articleId: draft.articleId,
      });
      await expect(
        f.kb.submitForReview(f.access.guideAuthor, {
          ...f.command("kb-still-needs-evidence", before.generation),
          articleId: draft.articleId,
        }),
      ).rejects.toThrow();
      expect(
        await f.kb.getDraft(f.access.admin, { articleId: draft.articleId }),
      ).toEqual(before);
      await f.issueGuideEvidence(draft.articleId);
      expect(await f.publish(draft.articleId)).toMatchObject({
        articleId: draft.articleId,
      });
    });

    it("keeps currentness independent of generation switches, provider outages, and aging accepted source proofs", async () => {
      const f = await learningKbFixture(createStore());
      const draft = await f.processToDraft(await f.eligible("successful_test"));
      await f.supportReview(draft.articleId);
      const context = await currentContext(f, draft.articleId);
      const accepted = await f.support.source();
      const stoppedWorkers = f.support.freshApplication({
        resolutionLearning: { enabled: false },
      });
      const verifier = sourceVerifier(f, { application: stoppedWorkers });
      f.support.advance(120_000);
      expect(Date.parse(f.support.clock.now())).toBeGreaterThan(
        Date.parse(accepted.product!.validUntil),
      );
      f.state.configurationOutcome = "disabled";
      f.state.reserveOutcome = "denied";
      f.setModel(async () => {
        throw new Error("Synthetic provider unavailable");
      });
      f.ports.resolveConfiguration.mockClear();
      f.ports.generate.mockClear();
      expect(await verifier.sources.isCurrent(context)).toBe(true);
      expect(await verifier.sources.canPublish(context)).toBe(true);
      verifier.state.policyOutcome = "disabled";
      expect(await verifier.sources.isCurrent(context)).toBe(true);
      expect(await verifier.sources.canPublish(context)).toBe(false);
      expect(f.ports.resolveConfiguration).not.toHaveBeenCalled();
      expect(f.ports.generate).not.toHaveBeenCalled();
    });

    it("fails closed on independent current service-source authority and policy revocation", async () => {
      const f = await learningKbFixture(createStore());
      const draft = await f.processToDraft(await f.eligible());
      await f.supportReview(draft.articleId);
      const context = await currentContext(f, draft.articleId);
      const verifier = sourceVerifier(f);
      for (const removed of [
        supportPermissions.learningRead,
        supportPermissions.learningProcess,
      ]) {
        verifier.state.authority = {
          ...verifier.state.authority,
          access: {
            ...learningService,
            permissions: learningService.permissions.filter(
              (permission) => permission !== removed,
            ),
          },
        };
        expect(await verifier.sources.isCurrent(context)).toBe(false);
        expect(await verifier.sources.canPublish(context)).toBe(false);
      }
      verifier.state.authority = {
        ...verifier.state.authority,
        access: learningService,
      };
      for (const outcome of ["inactive", "unavailable"] as const) {
        verifier.state.authorityOutcome = outcome;
        expect(await verifier.sources.isCurrent(context)).toBe(false);
        expect(await verifier.sources.canPublish(context)).toBe(false);
      }
      verifier.state.authorityOutcome = "ready";
      verifier.state.policy = {
        ...verifier.state.policy,
        version: "changed-review-policy",
      };
      expect(await verifier.sources.isCurrent(context)).toBe(true);
      expect(await verifier.sources.canPublish(context)).toBe(false);
    });

    it("delegates the full unchanged mixed-source context while requiring Support's own exact approval", async () => {
      const f = await learningKbFixture(createStore());
      const { articleId, second } = await aggregate(f);
      const existing = await currentContext(f, articleId);
      const foreign: PrivateSourceReference = {
        id: "foreign-source",
        system: "synthetic.other-system",
        resourceId: "opaque-other-resource",
        version: "other-version-1",
      };
      const context = await setSources(f, articleId, [
        existing.snapshot.references[0]!,
        foreign,
        existing.snapshot.references[1]!,
      ]);
      const otherSources = foreignVerifier();
      const verifier = sourceVerifier(f, { otherSources });
      expect(await verifier.sources.isCurrent(context)).toBe(true);
      expect(otherSources.isCurrent.mock.calls.at(-1)![0]).toBe(context);
      expect(await verifier.sources.canPublish(context)).toBe(false);
      expect(otherSources.canPublish.mock.calls.at(-1)![0]).toBe(context);
      await f.supportReview(articleId, second.ticketId);
      expect(await verifier.sources.canPublish(context)).toBe(true);
      expect(otherSources.isCurrent.mock.calls.at(-1)![0]).toBe(context);
      expect(otherSources.canPublish.mock.calls.at(-1)![0]).toBe(context);
      expect(context.snapshot.references).toHaveLength(3);
      otherSources.isCurrent.mockResolvedValue(false);
      expect(await verifier.sources.isCurrent(context)).toBe(false);
      expect(await verifier.sources.canPublish(context)).toBe(false);
      otherSources.isCurrent.mockResolvedValue(true);
      otherSources.canPublish.mockResolvedValue(false);
      expect(await verifier.sources.isCurrent(context)).toBe(true);
      expect(await verifier.sources.canPublish(context)).toBe(false);
      otherSources.canPublish.mockResolvedValue(true);
      await f.support.app.reopenTicket(
        learningStaff,
        f.support.command("reopen-known-mixed-contributor"),
      );
      expect(await verifier.sources.isCurrent(context)).toBe(false);
      expect(await verifier.sources.canPublish(context)).toBe(false);
    });

    it("rejects a real KB publication when a contributing ticket reopens during awaited foreign confirmation", async () => {
      const f = await learningKbFixture(createStore());
      const draft = await f.processToDraft(await f.eligible());
      const initial = await currentContext(f, draft.articleId);
      const foreign: PrivateSourceReference = {
        id: "publication-foreign-source",
        system: "synthetic.other-system",
        resourceId: "opaque-publication-source",
        version: "other-version-1",
      };
      await setSources(f, draft.articleId, [
        ...initial.snapshot.references,
        foreign,
      ]);
      await f.supportReview(draft.articleId);
      await f.issueGuideEvidence(draft.articleId);
      const current = await f.kb.getDraft(f.access.admin, {
        articleId: draft.articleId,
      });
      await f.kb.submitForReview(f.access.guideAuthor, {
        ...f.command("kb-review-before-source-race", current.generation),
        articleId: draft.articleId,
      });
      const review = await f.kb.getReview(f.access.admin, {
        articleId: draft.articleId,
      });
      const context = await currentContext(f, draft.articleId);
      const barrier = handlingBarrier();
      f.otherSources.isCurrent.mockImplementationOnce(async (request) => {
        expect(request).toEqual(context);
        await barrier.wait();
        return true;
      });
      const pending = f.kb
        .publishArticle(f.access.admin, {
          ...f.command("publish-with-current-source-guard", review.generation),
          articleId: draft.articleId,
          review: review.review,
        })
        .then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
      try {
        await Promise.race([
          barrier.reached,
          pending.then(() => {
            throw new Error(
              "Actual publication did not reach foreign confirmation",
            );
          }),
        ]);
        await f.support.app.reopenTicket(
          learningStaff,
          f.support.command("reopen-during-kb-publication"),
        );
      } finally {
        barrier.release();
      }
      expect(await pending).toMatchObject({
        error: { name: "KnowledgeBasePrerequisiteError" },
      });
      expect(
        await f.kb.getDraft(f.access.admin, { articleId: draft.articleId }),
      ).toMatchObject({ generation: review.generation, hasPublication: false });
      await expect(
        f.kb.getPublishedArticle(f.access.customer, {
          articleId: draft.articleId,
        }),
      ).rejects.toThrow();
    });

    it.each(["publication", "published-read"] as const)(
      "denies actual KB %s when another Support contributor reopens during the final foreign publication gate",
      async (operation) => {
        const f = await learningKbFixture(createStore());
        const { articleId, first, second } = await aggregate(f);
        const original = await currentContext(f, articleId);
        const foreign: PrivateSourceReference = {
          id: "final-foreign-publication-gate",
          system: "synthetic.other-system",
          resourceId: "opaque-final-foreign-source",
          version: "foreign-version-1",
        };
        await setSources(f, articleId, [
          ...original.snapshot.references,
          foreign,
        ]);
        await f.supportReview(articleId, first.ticketId);
        await f.issueGuideEvidence(articleId);
        let review: Awaited<ReturnType<typeof f.kb.getReview>> | undefined;
        if (operation === "published-read") {
          await f.publish(articleId);
        } else {
          const draft = await f.kb.getDraft(f.access.admin, { articleId });
          await f.kb.submitForReview(f.access.guideAuthor, {
            ...f.command("review-before-final-foreign-race", draft.generation),
            articleId,
          });
          review = await f.kb.getReview(f.access.admin, { articleId });
        }
        const context = await currentContext(f, articleId);
        const target = await f.currentTarget(articleId);
        expect(context.snapshot.references).toHaveLength(3);
        expect(
          await f.support.app.confirmResolutionLearningTargetReview(
            learningService,
            {
              ticketId: first.ticketId,
              target,
              policyVersion: f.state.policy.version,
            },
          ),
        ).toBe(true);
        expect(
          await f.support.app.confirmResolutionLearningTargetReview(
            learningService,
            {
              ticketId: second.ticketId,
              target,
              policyVersion: f.state.policy.version,
            },
          ),
        ).toBe(false);
        expect(await f.sources.canPublish(context)).toBe(true);

        const barrier = handlingBarrier();
        const delegated = f.otherSources.canPublish.getMockImplementation();
        if (delegated === undefined)
          throw new Error("Expected actual fixture foreign source port");
        let delegatedCalls = 0;
        f.ports.resolvePolicy.mockClear();
        f.otherSources.canPublish.mockImplementation(async (request) => {
          // Delegate the entire actual A+B+F request, including its immutable
          // revision and source snapshot; never fabricate a foreign-only hash.
          expect(request).toEqual(context);
          const allowed = await delegated(request);
          delegatedCalls += 1;
          if (delegatedCalls === 2) await barrier.wait();
          return allowed;
        });
        let pending: Promise<
          { readonly value: unknown } | { readonly error: unknown }
        >;
        if (operation === "publication") {
          if (review === undefined)
            throw new Error("Expected actual KB review");
          pending = f.kb
            .publishArticle(f.access.admin, {
              ...f.command(
                "publish-during-final-foreign-gate",
                review.generation,
              ),
              articleId,
              review: review.review,
            })
            .then(
              (value) => ({ value }),
              (error: unknown) => ({ error }),
            );
        } else {
          pending = f.kb
            .getPublishedArticle(f.access.customer, { articleId })
            .then(
              (value) => ({ value }),
              (error: unknown) => ({ error }),
            );
        }
        try {
          await Promise.race([
            barrier.reached,
            pending.then(() => {
              throw new Error(
                "Actual KB guard did not reach its final foreign gate",
              );
            }),
          ]);
          expect(delegatedCalls).toBe(2);
          expect(
            f.ports.resolvePolicy.mock.calls.some(
              ([version]) => version === f.state.policy.version,
            ),
          ).toBe(true);
          await f.support.app.reopenTicket(
            learningStaff,
            f.support.command(
              "reopen-during-final-foreign-gate",
              second.ticketId,
            ),
          );
          // A's exact aggregate decision still exists. B's independently live
          // source fact must also survive the awaited final foreign callback.
          expect(
            await f.support.app.confirmResolutionLearningTargetReview(
              learningService,
              {
                ticketId: first.ticketId,
                target,
                policyVersion: f.state.policy.version,
              },
            ),
          ).toBe(true);
        } finally {
          barrier.release();
          f.otherSources.canPublish.mockImplementation(delegated);
        }
        expect(await pending).toMatchObject({
          error: {
            name:
              operation === "publication"
                ? "KnowledgeBasePrerequisiteError"
                : "KnowledgeBaseNotFoundError",
          },
        });
        expect(await f.sources.isCurrent(context)).toBe(false);
        expect(await f.sources.canPublish(context)).toBe(false);
        expect(
          await f.kb.getDraft(f.access.admin, { articleId }),
        ).toMatchObject({
          hasPublication: operation === "published-read",
          ...(review === undefined ? {} : { generation: review.generation }),
        });
        await expect(
          f.kb.getPublishedArticle(f.access.customer, { articleId }),
        ).rejects.toThrow();
      },
    );

    it("denies unknown namespaces without a delegate and treats real empty provenance as neutral", async () => {
      const f = await learningKbFixture(createStore());
      const foreign: PrivateSourceReference = {
        id: "foreign-only",
        system: "synthetic.other-system",
        resourceId: "opaque-resource",
        version: "version-1",
      };
      await f.createGuide("unknown-source-guide", undefined, [foreign]);
      const unknown = await currentContext(f, "unknown-source-guide");
      const verifier = sourceVerifier(f);
      expect(await verifier.sources.isCurrent(unknown)).toBe(false);
      expect(await verifier.sources.canPublish(unknown)).toBe(false);
      expect(
        await verifier.sources.canRead({
          access: f.access.admin,
          articleId: "unknown-source-guide",
          reference: foreign,
        }),
      ).toBe(false);
      await f.createGuide("source-free-guide");
      const empty = await currentContext(f, "source-free-guide");
      verifier.resolveAuthority.mockClear();
      verifier.resolvePolicy.mockClear();
      expect(await verifier.sources.isCurrent(empty)).toBe(true);
      expect(await verifier.sources.canPublish(empty)).toBe(true);
      expect(verifier.resolveAuthority).not.toHaveBeenCalled();
      expect(verifier.resolvePolicy).not.toHaveBeenCalled();
    });

    it("authorizes private metadata using the actual caller rather than fixed service authority", async () => {
      const f = await learningKbFixture(createStore());
      const draft = await f.processToDraft(await f.eligible());
      const context = await currentContext(f, draft.articleId);
      const reference = context.snapshot.references[0]!;
      const verifier = sourceVerifier(f);
      verifier.state.authorityOutcome = "inactive";
      const reader: AccessContext = {
        ...learningStaff,
        permissions: [
          supportPermissions.queueRead,
          supportPermissions.learningRead,
        ],
      };
      const localAgent: AccessContext = {
        ...f.access.draftService,
        permissions: [
          knowledgePermissions.draftRead,
          knowledgePermissions.draftWrite,
          knowledgePermissions.provenanceRead,
        ],
      };
      expect(
        await verifier.sources.canRead({
          access: reader,
          articleId: draft.articleId,
          reference,
        }),
      ).toBe(true);
      for (const access of [
        learningCustomer,
        localAgent,
        { ...reader, permissions: [supportPermissions.queueRead] },
        { ...reader, permissions: [supportPermissions.learningRead] },
      ])
        expect(
          await verifier.sources.canRead({
            access,
            articleId: draft.articleId,
            reference,
          }),
        ).toBe(false);
      await expect(
        f.kb.getProvenance(f.access.customer, { articleId: draft.articleId }),
      ).rejects.toThrow();
      await expect(
        f.kb.getProvenance(localAgent, { articleId: draft.articleId }),
      ).rejects.toThrow();
      expect(await verifier.sources.isCurrent(context)).toBe(false);
    });

    it("permits only body-free registered withdrawal metadata after actual ticket-body deletion", async () => {
      const f = await learningKbFixture(createStore());
      const draft = await f.processToDraft(
        await f.eligible("staff_verified_fix"),
      );
      const context = await currentContext(f, draft.articleId);
      const reference = context.snapshot.references[0]!;
      const bodies = (await f.support.rows())
        .filter((row) => row.kind === "message")
        .map((row) => row.message.body);
      await f.support.app.withdrawResolutionLearningSource(learningStaff, {
        ...f.support.command("withdraw-source-for-body-deletion"),
        reason: "privacy_withdrawal",
      });
      await f.deleteTicketBody();
      const processor: AccessContext = {
        ...learningService,
        permissions: [supportPermissions.learningProcess],
      };
      const verifier = sourceVerifier(f);
      const retained = await f.support.app.readResolutionLearningReconciliation(
        processor,
        "ticket",
      );
      expect(retained).toMatchObject({
        state: "withdrawn",
        destinations: [expect.objectContaining({ articleId: draft.articleId })],
      });
      for (const body of bodies)
        expect(JSON.stringify(retained)).not.toContain(body);
      expect(JSON.stringify(retained)).not.toContain(
        "PRIVATE_KB_LEARNING_PROOF",
      );
      expect(
        await verifier.sources.canRead({
          access: processor,
          articleId: draft.articleId,
          reference,
        }),
      ).toBe(true);
      expect(
        await verifier.sources.canRead({
          access: processor,
          articleId: "unrelated-article",
          reference,
        }),
      ).toBe(false);
      expect(
        await verifier.sources.canRead({
          access: learningCustomer,
          articleId: draft.articleId,
          reference,
        }),
      ).toBe(false);
      expect(
        await verifier.sources.canRead({
          access: { ...processor, permissions: [] },
          articleId: draft.articleId,
          reference,
        }),
      ).toBe(false);
      expect(await verifier.sources.isCurrent(context)).toBe(false);
      expect(await verifier.sources.canPublish(context)).toBe(false);
    });

    it("uses only real Support read guards without KB recursion, publication, or provider calls", async () => {
      const f = await learningKbFixture(createStore());
      const draft = await f.processToDraft(await f.eligible());
      await f.supportReview(draft.articleId);
      const context = await currentContext(f, draft.articleId);
      const verifier = sourceVerifier(f);
      f.ports.knowledgeCalls.length = 0;
      f.ports.generate.mockClear();
      f.ports.resolveConfiguration.mockClear();
      expect(
        await verifier.sources.canRead({
          access: f.access.admin,
          articleId: draft.articleId,
          reference: context.snapshot.references[0]!,
        }),
      ).toBe(true);
      expect(await verifier.sources.isCurrent(context)).toBe(true);
      expect(await verifier.sources.canPublish(context)).toBe(true);
      expect(
        verifier.application.readResolutionLearningSource,
      ).toHaveBeenCalled();
      expect(
        verifier.application.confirmResolutionLearningSource,
      ).toHaveBeenCalled();
      expect(
        verifier.application.confirmResolutionLearningTargetReview,
      ).toHaveBeenCalled();
      expect(f.ports.knowledgeCalls).toEqual([]);
      expect(f.ports.generate).not.toHaveBeenCalled();
      expect(f.ports.resolveConfiguration).not.toHaveBeenCalled();
    });

    it("bounds real pending authority waits with a frozen host clock and aborts late work", async () => {
      const f = await learningKbFixture(createStore());
      const draft = await f.processToDraft(await f.eligible());
      const context = await currentContext(f, draft.articleId);
      const verifier = sourceVerifier(f, { maxOperationMilliseconds: 25 });
      const barrier = handlingBarrier();
      let signal: AbortSignal | undefined;
      verifier.resolveAuthority.mockImplementationOnce(
        async (currentSignal) => {
          signal = currentSignal;
          await barrier.wait();
          return {
            outcome: "ready",
            authority: structuredClone(verifier.state.authority),
          };
        },
      );
      const frozen = f.support.clock.now();
      const started = performance.now();
      const pending = verifier.sources.isCurrent(context);
      try {
        await Promise.race([
          barrier.reached,
          pending.then(() => {
            throw new Error("Source authority did not reach its real wait");
          }),
        ]);
        expect(await pending).toBe(false);
        expect(performance.now() - started).toBeLessThan(2_000);
        expect(f.support.clock.now()).toBe(frozen);
        expect(signal?.aborted).toBe(true);
        expect(
          verifier.application.readResolutionLearningSource,
        ).not.toHaveBeenCalled();
      } finally {
        barrier.release();
      }
    });

    it("rechecks the source clock after an actual awaited authority callback advances it", async () => {
      const f = await learningKbFixture(createStore());
      const draft = await f.processToDraft(await f.eligible());
      const context = await currentContext(f, draft.articleId);
      const verifier = sourceVerifier(f, { maxOperationMilliseconds: 100 });
      verifier.resolveAuthority.mockImplementationOnce(async () => {
        f.support.advance(101);
        return {
          outcome: "ready",
          authority: structuredClone(verifier.state.authority),
        };
      });
      expect(await verifier.sources.isCurrent(context)).toBe(false);
      expect(verifier.resolveAuthority).toHaveBeenCalledOnce();
      expect(
        verifier.application.readResolutionLearningSource,
      ).not.toHaveBeenCalled();
    });

    it.each([supportPermissions.queueRead, supportPermissions.learningRead])(
      "rejects loss of %s during a real source read even when principal/version and processing permission remain",
      async (removed) => {
        const f = await learningKbFixture(createStore());
        const draft = await f.processToDraft(await f.eligible());
        await f.supportReview(draft.articleId);
        const context = await currentContext(f, draft.articleId);
        for (const operation of ["isCurrent", "canPublish"] as const) {
          const barrier = handlingBarrier();
          const actualRead = vi.fn<
            SourceApplication["readResolutionLearningSource"]
          >(async (...args) => {
            const actualSource =
              await f.support.app.readResolutionLearningSource(...args);
            await barrier.wait();
            return actualSource;
          });
          const verifier = sourceVerifier(f, {
            application: {
              ...f.support.app,
              readResolutionLearningSource: actualRead,
            },
          });
          const version = verifier.state.authority.authorityVersion;
          const pending = verifier.sources[operation](context);
          try {
            await Promise.race([
              barrier.reached,
              pending.then(() => {
                throw new Error("Actual source read was not reached");
              }),
            ]);
            verifier.state.authority = {
              ...verifier.state.authority,
              access: {
                ...learningService,
                permissions: learningService.permissions.filter(
                  (permission) => permission !== removed,
                ),
              },
            };
            expect(verifier.state.authority.authorityVersion).toBe(version);
            expect(verifier.state.authority.access.permissions).toContain(
              supportPermissions.learningProcess,
            );
          } finally {
            barrier.release();
          }
          expect(await pending).toBe(false);
          expect(actualRead).toHaveBeenCalledOnce();
        }
      },
    );

    it("refreshes the same review policy version and full binding after an actual positive target review", async () => {
      const f = await learningKbFixture(createStore());
      const draft = await f.processToDraft(await f.eligible());
      await f.supportReview(draft.articleId);
      const context = await currentContext(f, draft.articleId);
      for (const change of ["disabled", "version", "binding"] as const) {
        const barrier = handlingBarrier();
        const actualFacts: boolean[] = [];
        const confirmReview = vi.fn<
          SourceApplication["confirmResolutionLearningTargetReview"]
        >(async (...args) => {
          const actual =
            await f.support.app.confirmResolutionLearningTargetReview(...args);
          actualFacts.push(actual);
          await barrier.wait();
          return actual;
        });
        const verifier = sourceVerifier(f, {
          application: {
            ...f.support.app,
            confirmResolutionLearningTargetReview: confirmReview,
          },
        });
        const version = verifier.state.policy.version;
        const pending = verifier.sources.canPublish(context);
        try {
          await Promise.race([
            barrier.reached,
            pending.then(() => {
              throw new Error("Actual target review was not reached");
            }),
          ]);
          if (change === "disabled") verifier.state.policyOutcome = "disabled";
          else
            verifier.state.policy = {
              ...verifier.state.policy,
              [change]: "changed-after-positive-review",
            };
        } finally {
          barrier.release();
        }
        expect(await pending).toBe(false);
        expect(actualFacts).toEqual([true]);
        expect(verifier.resolvePolicy).toHaveBeenLastCalledWith(
          version,
          expect.anything(),
        );
      }
    });

    it.each(["reopen-other-contributor", "reject-reviewed-owner"] as const)(
      "rechecks all contributors and exact aggregate approval after policy refresh when %s occurs",
      async (change) => {
        const f = await learningKbFixture(createStore());
        const { articleId, first, second } = await aggregate(f);
        await f.supportReview(articleId, first.ticketId);
        await f.issueGuideEvidence(articleId);
        let review: Awaited<ReturnType<typeof f.kb.getReview>> | undefined;
        if (change === "reject-reviewed-owner") {
          await f.publish(articleId);
        } else {
          const draft = await f.kb.getDraft(f.access.admin, { articleId });
          await f.kb.submitForReview(f.access.guideAuthor, {
            ...f.command(
              "kb-review-before-policy-refresh-race",
              draft.generation,
            ),
            articleId,
          });
          review = await f.kb.getReview(f.access.admin, { articleId });
        }
        const context = await currentContext(f, articleId);
        const target = await f.currentTarget(articleId);
        expect(context.snapshot.references).toHaveLength(2);
        expect(
          await f.support.app.confirmResolutionLearningTargetReview(
            learningService,
            {
              ticketId: first.ticketId,
              target,
              policyVersion: f.state.policy.version,
            },
          ),
        ).toBe(true);
        expect(
          await f.support.app.confirmResolutionLearningTargetReview(
            learningService,
            {
              ticketId: second.ticketId,
              target,
              policyVersion: f.state.policy.version,
            },
          ),
        ).toBe(false);
        expect(await f.sources.canPublish(context)).toBe(true);

        const barrier = handlingBarrier();
        const resolvePolicy = f.ports.resolvePolicy.getMockImplementation();
        if (resolvePolicy === undefined)
          throw new Error("Expected actual fixture policy resolver");
        let pausedRefresh = false;
        f.ports.resolvePolicy.mockImplementation(
          async (expectedVersion, signal) => {
            const observation = await resolvePolicy(expectedVersion, signal);
            if (expectedVersion !== undefined && !pausedRefresh) {
              pausedRefresh = true;
              await barrier.wait();
            }
            return observation;
          },
        );
        let pending: Promise<
          { readonly value: unknown } | { readonly error: unknown }
        >;
        if (change === "reopen-other-contributor") {
          if (review === undefined)
            throw new Error("Expected actual KB review");
          pending = f.kb
            .publishArticle(f.access.admin, {
              ...f.command("publish-during-policy-refresh", review.generation),
              articleId,
              review: review.review,
            })
            .then(
              (value) => ({ value }),
              (error: unknown) => ({ error }),
            );
        } else {
          pending = f.kb
            .getPublishedArticle(f.access.customer, { articleId })
            .then(
              (value) => ({ value }),
              (error: unknown) => ({ error }),
            );
        }
        try {
          await Promise.race([
            barrier.reached,
            pending.then(() => {
              throw new Error("Actual KB guard did not reach policy refresh");
            }),
          ]);
          if (change === "reopen-other-contributor") {
            await f.support.app.reopenTicket(
              learningStaff,
              f.support.command(
                "reopen-contributor-during-policy-refresh",
                second.ticketId,
              ),
            );
          } else {
            const before = await f.support.app.readResolutionLearningSource(
              learningStaff,
              first.ticketId,
            );
            const work = await f.support.app.readResolutionLearningWork(
              learningStaff,
              first,
            );
            await f.learning.reviewProposal(f.access.staff, {
              ...f.support.command(
                "reject-exact-target-during-policy-refresh",
                first.ticketId,
              ),
              sourceGeneration: first.sourceGeneration,
              expectedWorkGeneration: work.workGeneration,
              target,
              decision: "reject",
              policyVersion: f.state.policy.version,
            });
            const after = await f.support.app.readResolutionLearningSource(
              learningStaff,
              first.ticketId,
            );
            expect(after.sourceGeneration).toBe(before.sourceGeneration);
            expect(
              await f.support.app.confirmResolutionLearningTargetReview(
                learningService,
                {
                  ticketId: first.ticketId,
                  target,
                  policyVersion: f.state.policy.version,
                },
              ),
            ).toBe(false);
          }
        } finally {
          barrier.release();
          f.ports.resolvePolicy.mockImplementation(resolvePolicy);
        }
        expect(pausedRefresh).toBe(true);
        expect(await pending).toMatchObject({
          error: {
            name:
              change === "reopen-other-contributor"
                ? "KnowledgeBasePrerequisiteError"
                : "KnowledgeBaseNotFoundError",
          },
        });
        expect(await f.sources.canPublish(context)).toBe(false);
        if (change === "reject-reviewed-owner") {
          expect(await f.sources.isCurrent(context)).toBe(true);
        } else {
          expect(await f.sources.isCurrent(context)).toBe(false);
          expect(
            await f.kb.getDraft(f.access.admin, { articleId }),
          ).toMatchObject({
            generation: review!.generation,
            hasPublication: false,
          });
        }
        await expect(
          f.kb.getPublishedArticle(f.access.customer, { articleId }),
        ).rejects.toThrow();
      },
    );

    it("rejects an initially delayed policy observation whose lifetime already elapsed under a frozen clock", async () => {
      const f = await learningKbFixture(createStore());
      const draft = await f.processToDraft(await f.eligible());
      await f.supportReview(draft.articleId);
      await f.issueGuideEvidence(draft.articleId);
      const current = await f.kb.getDraft(f.access.admin, {
        articleId: draft.articleId,
      });
      await f.kb.submitForReview(f.access.guideAuthor, {
        ...f.command(
          "kb-review-before-initial-policy-delay",
          current.generation,
        ),
        articleId: draft.articleId,
      });
      const review = await f.kb.getReview(f.access.admin, {
        articleId: draft.articleId,
      });
      const context = await currentContext(f, draft.articleId);
      expect(await f.sources.canPublish(context)).toBe(true);

      const frozen = f.support.clock.now();
      const original = f.ports.resolvePolicy.getMockImplementation();
      if (original === undefined)
        throw new Error("Expected actual fixture policy resolver");
      const policy = {
        ...f.state.policy,
        verifiedAt: frozen,
        validUntil: new Date(Date.parse(frozen) + 10).toISOString(),
      };
      const timers = new Set<ReturnType<typeof setTimeout>>();
      const elapsedObservations: number[] = [];
      f.ports.resolvePolicy.mockClear();
      f.ports.resolvePolicy.mockImplementation(
        async (expectedVersion, signal) => {
          if (expectedVersion !== undefined)
            return original(expectedVersion, signal);
          const requested = performance.now();
          await new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
              timers.delete(timer);
              resolve();
            }, 30);
            timers.add(timer);
          });
          elapsedObservations.push(performance.now() - requested);
          return { outcome: "ready", policy: structuredClone(policy) };
        },
      );
      try {
        expect(await f.sources.canPublish(context)).toBe(false);
        await expect(
          f.kb.publishArticle(f.access.admin, {
            ...f.command(
              "publish-with-elapsed-initial-policy",
              review.generation,
            ),
            articleId: draft.articleId,
            review: review.review,
          }),
        ).rejects.toMatchObject({ name: "KnowledgeBasePrerequisiteError" });
        expect(f.support.clock.now()).toBe(frozen);
        expect(elapsedObservations).toHaveLength(2);
        for (const elapsed of elapsedObservations)
          expect(elapsed).toBeGreaterThanOrEqual(25);
        expect(
          f.ports.resolvePolicy.mock.calls.every(
            ([expected]) => expected === undefined,
          ),
        ).toBe(true);
        expect(
          await f.kb.getDraft(f.access.admin, { articleId: draft.articleId }),
        ).toMatchObject({
          generation: review.generation,
          hasPublication: false,
        });
      } finally {
        f.ports.resolvePolicy.mockImplementation(original);
        for (const timer of timers) clearTimeout(timer);
      }
    });

    it("expires review policy when the source clock advances during a positive actual target review", async () => {
      const f = await learningKbFixture(createStore());
      const draft = await f.processToDraft(await f.eligible());
      await f.supportReview(draft.articleId);
      const context = await currentContext(f, draft.articleId);
      const actualFacts: boolean[] = [];
      const confirmReview = vi.fn<
        SourceApplication["confirmResolutionLearningTargetReview"]
      >(async (...args) => {
        const actual =
          await f.support.app.confirmResolutionLearningTargetReview(...args);
        actualFacts.push(actual);
        f.support.advance(1_001);
        return actual;
      });
      const verifier = sourceVerifier(f, {
        application: {
          ...f.support.app,
          confirmResolutionLearningTargetReview: confirmReview,
        },
      });
      verifier.state.policy = {
        ...verifier.state.policy,
        validUntil: new Date(
          Date.parse(f.support.clock.now()) + 1_000,
        ).toISOString(),
      };
      expect(await verifier.sources.canPublish(context)).toBe(false);
      expect(actualFacts).toEqual([true]);
    });

    it("expires review policy in elapsed real time even while the host clock remains frozen", async () => {
      const f = await learningKbFixture(createStore());
      const draft = await f.processToDraft(await f.eligible());
      await f.supportReview(draft.articleId);
      const context = await currentContext(f, draft.articleId);
      const barrier = handlingBarrier();
      const actualFacts: boolean[] = [];
      const confirmReview = vi.fn<
        SourceApplication["confirmResolutionLearningTargetReview"]
      >(async (...args) => {
        const actual =
          await f.support.app.confirmResolutionLearningTargetReview(...args);
        actualFacts.push(actual);
        await barrier.wait();
        return actual;
      });
      const verifier = sourceVerifier(f, {
        application: {
          ...f.support.app,
          confirmResolutionLearningTargetReview: confirmReview,
        },
      });
      const frozen = f.support.clock.now();
      verifier.state.policy = {
        ...verifier.state.policy,
        validUntil: new Date(Date.parse(frozen) + 100).toISOString(),
      };
      const pending = verifier.sources.canPublish(context);
      try {
        const reached = await Promise.race([
          barrier.reached.then(() => true),
          pending.then(() => false),
        ]);
        // A slower actual store may already consume this short policy lifetime.
        // Otherwise hold the real positive review beyond its remaining lifetime.
        if (reached)
          await new Promise<void>((resolve) => setTimeout(resolve, 110));
      } finally {
        barrier.release();
      }
      expect(await pending).toBe(false);
      expect(f.support.clock.now()).toBe(frozen);
      expect(
        verifier.application.readResolutionLearningSource,
      ).toHaveBeenCalled();
      if (actualFacts.length > 0) expect(actualFacts).toEqual([true]);
    });
  });
}
