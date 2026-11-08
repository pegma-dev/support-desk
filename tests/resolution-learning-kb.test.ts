import {
  knowledgePermissions,
  type ArticleRevision,
} from "@pegma/knowledge-base-contracts";
import type { CreateDraftInput } from "@pegma/knowledge-base-application";
import type { ResolutionLearningKey } from "@pegma/support-desk-application";
import { describe, expect, it } from "vitest";
import {
  learningKbBarrier,
  learningKbCanaries,
  learningKbCollectionId,
  learningKbFixture,
  learningKbProduct,
  learningKbStores,
} from "../test/resolution-learning-kb-fixtures.js";

type Fixture = Awaited<ReturnType<typeof learningKbFixture>>;
function writes(f: Fixture) {
  return f.ports.knowledgeCalls.filter(
    (call) =>
      call.operation === "createDraft" || call.operation === "updateDraft",
  );
}
function draftOf(revision: ArticleRevision): CreateDraftInput["draft"] {
  return {
    kind: revision.kind,
    title: revision.title,
    summary: revision.summary,
    content: revision.content,
    tags: revision.tags,
    applicability: revision.applicability,
  };
}
async function modelStage(f: Fixture, key: ResolutionLearningKey) {
  expect(
    (
      await f.learning.processWork({
        ...key,
        workerId: "integration-model",
        leaseMilliseconds: 30_000,
      })
    ).outcome,
  ).toBe("candidate");
}
async function recoverDelivery(f: Fixture, key: ResolutionLearningKey) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const result = await f.learning.processWork({
      ...key,
      workerId: "integration-delivery",
      leaseMilliseconds: 30_000,
    });
    if (result.outcome === "delivered") return result;
    if (
      result.outcome !== "pending" &&
      result.outcome !== "not_claimed" &&
      !(
        result.outcome === "held" &&
        (await f.support.app.readResolutionLearningWork(f.access.staff, key))
          .exactRequest !== undefined
      )
    )
      throw new Error(
        `Delivery did not retain a retryable state: ${JSON.stringify(result)}`,
      );
    f.support.advance(31_000);
  }
  throw new Error("Delivery exceeded four bounded recovery invocations");
}

for (const [name, createStore] of learningKbStores) {
  describe(`released KB learning integration (${name})`, () => {
    it.each([
      "customer_confirmation",
      "staff_verified_fix",
      "successful_test",
    ] as const)(
      "learns %s into one private checked draft and publishes only after exact staff and guide verification",
      async (proof) => {
        const f = await learningKbFixture(createStore());
        const key = await f.eligible(proof);
        const draft = await f.processToDraft(key);
        expect(draft.hasPublication).toBe(false);
        expect(writes(f)).toHaveLength(1);
        expect(f.ports.generate).toHaveBeenCalledOnce();
        const checked = f.ports.check.mock.calls[0]![0];
        const rendered = JSON.parse(checked.exactRequest.draftPayload) as {
          draft: CreateDraftInput["draft"];
          requirements: { checks: readonly { id: string }[] };
        };
        expect(rendered.draft.content.text).toContain(
          "Verify that the downloaded export opens.",
        );
        expect(rendered.requirements.checks.map((check) => check.id)).toContain(
          "explanation-content",
        );
        expect(checked.exactRequest.sourceReferences).toHaveLength(1);
        expect(f.access.draftService.permissions).not.toContain(
          knowledgePermissions.publish,
        );
        expect(f.access.draftService.permissions).not.toContain(
          knowledgePermissions.retire,
        );
        expect(f.access.retirementService.permissions).not.toContain(
          knowledgePermissions.draftWrite,
        );
        expect(f.access.retirementService.permissions).not.toContain(
          knowledgePermissions.publish,
        );
        await expect(
          f.kb.submitForReview(f.access.guideAuthor, {
            ...f.command("unverified-guide", draft.generation),
            articleId: draft.articleId,
          }),
        ).rejects.toThrow();
        await f.issueGuideEvidence(draft.articleId);
        const evidenced = await f.kb.getDraft(f.access.guideAuthor, {
          articleId: draft.articleId,
        });
        await expect(
          f.kb.submitForReview(f.access.guideAuthor, {
            ...f.command("no-support-review", evidenced.generation),
            articleId: draft.articleId,
          }),
        ).rejects.toThrow();
        await f.supportReview(draft.articleId);
        const published = await f.publish(draft.articleId);
        expect(published.content.text).toContain(
          "Download the completed workspace export.",
        );
        expect(
          await f.kb.getArticleIndexStatus(f.access.admin, {
            articleId: draft.articleId,
          }),
        ).toMatchObject({ status: "ready", indexed: true });
        expect(
          (
            await f.kb.retrieveAnswerSources(
              {
                ...f.access.bot,
                permissions: f.access.bot.permissions.filter(
                  (permission) =>
                    permission !== knowledgePermissions.articleRead,
                ),
              },
              {
                collectionIds: [learningKbCollectionId],
                query: "workspace export",
                applicability: learningKbProduct,
                limit: 5,
              },
            )
          ).outcome,
        ).toBe("no_result");
        const bot = await f.kb.retrieveAnswerSources(f.access.bot, {
          collectionIds: [learningKbCollectionId],
          query: "workspace export",
          applicability: learningKbProduct,
          limit: 5,
        });
        const search = await f.kb.searchPublishedArticles(f.access.customer, {
          collectionId: learningKbCollectionId,
          query: "workspace export",
          applicability: learningKbProduct,
          limit: 5,
        });
        expect(bot.outcome).toBe("results");
        expect(search.outcome).toBe("results");
        for (const secret of [
          ...learningKbCanaries,
          f.access.supportCustomer.principalId,
          "sourceReferences",
          "verificationReference",
          "reviewerId",
          "PRIVATE_KB_LEARNING_VERIFICATION_STEPS",
        ])
          expect(JSON.stringify({ published, bot, search })).not.toContain(
            secret,
          );
        expect(
          JSON.stringify(f.ports.generate.mock.calls[0]![0]),
        ).not.toContain("PRIVATE_KB_LEARNING_NOTE");
        const current = await f.kb.getDraft(f.access.admin, {
          articleId: draft.articleId,
        });
        await expect(
          f.kb.retireArticle(f.access.draftService, {
            ...f.command("draft-service-cannot-retire", current.generation),
            articleId: draft.articleId,
          }),
        ).rejects.toThrow();
      },
    );

    it("requires a fresh exact Support review after a local guide edit even when fresh guide evidence exists", async () => {
      const f = await learningKbFixture(createStore());
      await f.eligible();
      const draft = await f.processToDraft();
      await f.supportReview(draft.articleId);
      await f.issueGuideEvidence(draft.articleId);
      const current = await f.kb.getDraft(f.access.admin, {
        articleId: draft.articleId,
      });
      await f.kb.updateDraft(f.access.admin, {
        ...f.command("local-guide-edit", current.generation),
        articleId: draft.articleId,
        collectionId: current.revision.collectionId,
        draft: {
          ...draftOf(current.revision),
          content: {
            format: "plain_text",
            text: `${current.revision.content.text}\nVerify the export file opens in the supported reader.`,
          },
        },
      });
      await f.issueGuideEvidence(draft.articleId);
      const edited = await f.kb.getDraft(f.access.guideAuthor, {
        articleId: draft.articleId,
      });
      await expect(
        f.kb.submitForReview(f.access.guideAuthor, {
          ...f.command("stale-support-approval", edited.generation),
          articleId: draft.articleId,
        }),
      ).rejects.toThrow();
      await f.supportReview(draft.articleId);
      expect((await f.publish(draft.articleId)).content.text).toContain(
        "supported reader",
      );
    });

    it("gives two physical processWork invocations one lease and one paid model call", async () => {
      const f = await learningKbFixture(createStore());
      const key = await f.eligible();
      const gate = learningKbBarrier();
      f.setModel(async () => {
        await gate.wait();
        return {
          outputJson: JSON.stringify({
            problem: "Workspace export",
            applicability: {
              productId: "workspace",
              version: "2.3.0",
              buildId: "build-verified-230",
            },
            steps: ["Choose Export."],
            solution: "Download the export.",
            validationRequirements: ["Open the export."],
          }),
          provider: f.state.configuration.provider,
          model: f.state.configuration.model,
          requestId: "concurrent-learning-request",
          usage: {
            inputTokens: 100,
            outputTokens: 30,
            costMicros: 10,
            currency: "USD",
          },
        };
      });
      const first = f.learning.processWork({
        ...key,
        workerId: "physical-worker",
        leaseMilliseconds: 30_000,
      });
      try {
        await Promise.race([
          gate.reached,
          first.then(() => {
            throw new Error("Model did not reach its bounded barrier");
          }),
        ]);
        expect(
          (
            await f.learning.processWork({
              ...key,
              workerId: "physical-worker",
              leaseMilliseconds: 30_000,
            })
          ).outcome,
        ).toBe("not_claimed");
      } finally {
        gate.release();
      }
      expect((await first).outcome).toBe("candidate");
      expect(f.ports.generate).toHaveBeenCalledOnce();
      expect(f.ports.reserve).toHaveBeenCalledOnce();
      await f.processToDraft(key);
      expect(f.ports.generate).toHaveBeenCalledOnce();
      expect(writes(f)).toHaveLength(1);
    });

    for (const operation of ["createDraft", "updateDraft"] as const) {
      it.each(["before commit", "accepted acknowledgement"] as const)(
        `retries the exact ${operation} after lost %s without another model request`,
        async (loss) => {
          const f = await learningKbFixture(createStore());
          if (operation === "updateDraft") {
            await f.publishIndependentGuide("existing-export");
            f.updateTarget("existing-export");
          }
          const key = await f.eligible();
          await modelStage(f, key);
          let lost = false;
          f.interceptKnowledge(async (call, invoke) => {
            if (call.operation !== operation || lost) return invoke();
            lost = true;
            if (loss === "accepted acknowledgement") await invoke();
            throw new Error("Synthetic lost KB acknowledgement");
          });
          await recoverDelivery(f, key);
          const attempts = writes(f).filter(
            (call) => call.operation === operation,
          );
          expect(attempts.length).toBeGreaterThan(1);
          for (const attempt of attempts)
            expect(attempt.args).toEqual(attempts[0]!.args);
          expect(f.ports.generate).toHaveBeenCalledOnce();
          const work = await f.support.work();
          expect(work.status).toBe("completed");
          const current = await f.kb.getDraft(f.access.admin, {
            articleId: work.target!.articleId,
          });
          expect(current.revision.number).toBe(
            operation === "createDraft" ? 1 : 2,
          );
          expect(
            (
              await f.kb.getProvenance(f.access.admin, {
                articleId: current.articleId,
              })
            ).snapshot.references,
          ).toEqual(
            (attempts[0]!.args[1] as CreateDraftInput).sourceReferences,
          );
        },
      );
    }

    it("updates an explicitly selected draft by merging guidance and replacing only its own ordered reference", async () => {
      const f = await learningKbFixture(createStore());
      await f.eligible();
      const firstReference = await f.reference();
      await f.eligible("customer_confirmation", "contributor-first");
      await f.eligible("staff_verified_fix", "contributor-last");
      const before = await f.reference("contributor-first");
      const after = await f.reference("contributor-last");
      await f.createGuide("merged-export", "PRESERVED_EXISTING_GUIDANCE", [
        before,
        firstReference,
        after,
      ]);
      const ticket = (
        await f.support.app.readStaffTicket(f.access.staff, "ticket")
      ).ticket;
      const visible = await f.support.app.readCustomerTicket(
        f.access.supportCustomer,
        "ticket",
      );
      await f.support.app.submitResolutionEvidence(f.access.staff, {
        ...f.support.command("new-staff-proof"),
        expectedRevision: ticket.revision,
        resolutionCycle: (await f.support.source()).resolutionCycle,
        evidence: {
          kind: "staff_verified_fix",
          solutionMessageId: visible.messages.at(-1)!.id,
          verificationReference: "distinct-current-export-verification",
        },
      });
      f.updateTarget("merged-export");
      const updated = await f.processToDraft();
      expect(updated.revision.content.text).toContain(
        "PRESERVED_EXISTING_GUIDANCE",
      );
      expect(updated.revision.content.text).toContain(
        "Download the completed workspace export.",
      );
      expect(
        (
          await f.kb.getProvenance(f.access.admin, {
            articleId: updated.articleId,
          })
        ).snapshot.references,
      ).toEqual([before, await f.reference(), after]);
      expect(
        f.ports.check.mock.calls[0]![0].exactRequest.sourceReferences,
      ).toEqual([before, await f.reference(), after]);
    });

    it("holds unreadable inherited provenance without a draft write or dropping its reference", async () => {
      const f = await learningKbFixture(createStore());
      await f.createGuide(
        "unreadable-contributor",
        "Existing export guidance.",
        [
          {
            id: "protected-source",
            system: "synthetic-docs",
            resourceId: "protected-document",
            version: "1",
          },
        ],
      );
      f.updateTarget("unreadable-contributor");
      const key = await f.eligible();
      await modelStage(f, key);
      f.state.otherRead = false;
      const result = await f.learning.processWork({
        ...key,
        workerId: "unreadable-target",
        leaseMilliseconds: 30_000,
      });
      expect(result.outcome).not.toBe("delivered");
      expect(writes(f)).toEqual([]);
      f.state.otherRead = true;
      expect(
        (
          await f.kb.getProvenance(f.access.admin, {
            articleId: "unreadable-contributor",
          })
        ).snapshot.references,
      ).toHaveLength(1);
    });

    it("holds mixed foreign provenance when replacing its own stale reference cannot prove the full aggregate current", async () => {
      const f = await learningKbFixture(createStore());
      await f.eligible();
      const own = await f.reference();
      const foreign = {
        id: "independent-mixed-source",
        system: "synthetic-docs",
        resourceId: "independent-mixed-document",
        version: "1",
      };
      await f.createGuide("mixed-stale-export", "PRESERVED_MIXED_GUIDANCE", [
        foreign,
        own,
      ]);
      const ticket = (
        await f.support.app.readStaffTicket(f.access.staff, "ticket")
      ).ticket;
      const visible = await f.support.app.readCustomerTicket(
        f.access.supportCustomer,
        "ticket",
      );
      await f.support.app.submitResolutionEvidence(f.access.staff, {
        ...f.support.command("new-proof-with-mixed-provenance"),
        expectedRevision: ticket.revision,
        resolutionCycle: (await f.support.source()).resolutionCycle,
        evidence: {
          kind: "staff_verified_fix",
          solutionMessageId: visible.messages.at(-1)!.id,
          verificationReference: "distinct-mixed-export-verification",
        },
      });
      f.updateTarget("mixed-stale-export");
      const key = await f.support.candidate();
      await modelStage(f, key);
      const result = await f.learning.processWork({
        ...key,
        workerId: "mixed-contributor-uncertainty",
        leaseMilliseconds: 30_000,
      });
      expect(result).toMatchObject({
        outcome: "held",
        reason: "contributor_changed",
      });
      expect(writes(f)).toEqual([]);
      expect(
        (
          await f.kb.getProvenance(f.access.admin, {
            articleId: "mixed-stale-export",
          })
        ).snapshot.references,
      ).toEqual([foreign, own]);
      expect((await f.support.work()).candidate).toBeDefined();
    });

    it("holds a newer unpublished target draft that was not explicitly authorized for selection", async () => {
      const f = await learningKbFixture(createStore());
      const published = await f.publishIndependentGuide(
        "newer-unpublished-target",
      );
      const original = await f.kb.getDraft(f.access.admin, {
        articleId: published.articleId,
      });
      await f.kb.updateDraft(f.access.admin, {
        ...f.command("unpublished-local-edit", original.generation),
        articleId: published.articleId,
        collectionId: original.revision.collectionId,
        draft: {
          ...draftOf(original.revision),
          content: { format: "plain_text", text: "UNREVIEWED_NEWER_DRAFT" },
        },
      });
      f.state.targetArticleId = published.articleId;
      expect(f.state.scope.explicitDraftIds).toEqual([]);
      const key = await f.eligible();
      await modelStage(f, key);
      expect(
        (
          await f.learning.processWork({
            ...key,
            workerId: "unlisted-newer-draft",
            leaseMilliseconds: 30_000,
          })
        ).outcome,
      ).not.toBe("delivered");
      expect(writes(f)).toEqual([]);
      expect(
        (
          await f.kb.getDraft(f.access.admin, {
            articleId: published.articleId,
          })
        ).revision.content.text,
      ).toBe("UNREVIEWED_NEWER_DRAFT");
    });

    it.each(["held", "unavailable"] as const)(
      "retains an uncertain %s target proposal privately",
      async (outcome) => {
        const f = await learningKbFixture(createStore());
        const key = await f.eligible();
        await modelStage(f, key);
        f.state.selectionOutcome = outcome;
        expect(
          (
            await f.learning.processWork({
              ...key,
              workerId: "uncertain-target",
              leaseMilliseconds: 30_000,
            })
          ).outcome,
        ).not.toBe("delivered");
        expect(writes(f)).toEqual([]);
        expect((await f.support.work()).candidate).toBeDefined();
      },
    );

    it("checks the full rendered request and keeps rejected target text out of KB writes and discovery queries", async () => {
      const f = await learningKbFixture(createStore());
      const key = await f.eligible();
      await modelStage(f, key);
      f.setTargetScript(async (input) => ({
        outcome: "selected",
        operation: "create",
        articleId: input.newArticleId,
        draft: {
          kind: input.scope.kind,
          title: "Export your workspace",
          summary: "Workspace export.",
          content: {
            format: "plain_text",
            text: `PRIVATE_UNSAFE_RENDERED_TARGET\n${input.candidate.validationRequirements.join("\n")}`,
          },
          tags: ["export"],
          applicability: learningKbProduct,
        },
      }));
      f.ports.check.mockImplementation(async (input) => {
        expect(input.exactRequest.draftPayload).toContain(
          "PRIVATE_UNSAFE_RENDERED_TARGET",
        );
        expect(JSON.stringify(input.candidate)).not.toContain(
          "PRIVATE_UNSAFE_RENDERED_TARGET",
        );
        return { outcome: "held" };
      });
      expect(
        (
          await f.learning.processWork({
            ...key,
            workerId: "unsafe-request",
            leaseMilliseconds: 30_000,
          })
        ).outcome,
      ).not.toBe("delivered");
      expect(f.ports.check).toHaveBeenCalledOnce();
      expect(writes(f)).toEqual([]);
      expect((await f.support.work()).candidate).toBeDefined();
      for (const search of f.ports.knowledgeCalls.filter(
        (call) => call.operation === "searchPublishedArticles",
      )) {
        expect(search.args[1]).toMatchObject({ query: "workspace export" });
        expect(JSON.stringify(search.args)).not.toContain(
          "PRIVATE_UNSAFE_RENDERED_TARGET",
        );
      }
    });

    it.each([
      "knowledge authority",
      "configuration",
      "scope",
      "source",
      "reopen",
    ] as const)(
      "rechecks %s after awaited independent checks before the actual KB write",
      async (change) => {
        const f = await learningKbFixture(createStore());
        const key = await f.eligible();
        await modelStage(f, key);
        const gate = learningKbBarrier();
        const original = f.ports.check.getMockImplementation()!;
        f.ports.check.mockImplementation(async (...args) => {
          const result = await original(...args);
          await gate.wait();
          return result;
        });
        const pending = f.learning.processWork({
          ...key,
          workerId: "awaited-boundary",
          leaseMilliseconds: 30_000,
        });
        try {
          await Promise.race([
            gate.reached,
            pending.then(() => {
              throw new Error(
                "Delivery did not reach its independent-check barrier",
              );
            }),
          ]);
          if (change === "knowledge authority")
            f.state.knowledgeOutcome = "inactive";
          else if (change === "configuration")
            f.state.configurationOutcome = "disabled";
          else if (change === "scope")
            f.state.scope = {
              ...f.state.scope,
              version: "changed-target-scope",
            };
          else if (change === "reopen")
            await f.support.app.reopenTicket(
              f.access.staff,
              f.support.command("reopen-during-check"),
            );
          else
            await f.support.app.withdrawResolutionLearningSource(
              f.access.staff,
              {
                ...f.support.command("withdraw-during-check"),
                reason: "privacy_withdrawal",
              },
            );
        } finally {
          gate.release();
        }
        expect((await pending).outcome).not.toBe("delivered");
        expect(writes(f)).toEqual([]);
      },
    );

    for (const phase of ["first preflight", "final pre-write"] as const) {
      it.each(["frozen", "backward"] as const)(
        `expires a valid independent receipt across ${phase} configuration await with a %s host clock`,
        async (clockMode) => {
          const f = await learningKbFixture(createStore());
          const frozen = f.support.clock.now();
          const earlier = new Date(Date.parse(frozen) - 60_000).toISOString();
          f.state.configuration = {
            ...f.state.configuration,
            dataControls: {
              ...f.state.configuration.dataControls,
              verifiedAt: earlier,
            },
          };
          f.state.policy = { ...f.state.policy, verifiedAt: earlier };
          const key = await f.eligible();
          await modelStage(f, key);
          const receiptMilliseconds = 1_500;
          const expiresAt = new Date(
            Date.parse(frozen) + receiptMilliseconds,
          ).toISOString();
          const originalVerify = f.ports.verifyChecks.getMockImplementation()!;
          let firstReceiptAt: number | undefined;
          f.ports.verifyChecks.mockImplementation(async (...args) => {
            const verified = await originalVerify(...args);
            if (verified === null) return null;
            firstReceiptAt ??= performance.now();
            return { ...verified, verifiedAt: earlier, validUntil: expiresAt };
          });
          const gate = learningKbBarrier();
          const originalConfiguration =
            f.ports.resolveConfiguration.getMockImplementation()!;
          const awaitedConfiguration = phase === "first preflight" ? 1 : 3;
          let configurationsAfterReceipt = 0;
          f.ports.resolveConfiguration.mockImplementation(async (...args) => {
            const configuration = await originalConfiguration(...args);
            if (
              firstReceiptAt !== undefined &&
              ++configurationsAfterReceipt === awaitedConfiguration
            )
              await gate.wait();
            return configuration;
          });
          const pending = f.learning.processWork({
            ...key,
            workerId: "expiring-independent-receipt",
            leaseMilliseconds: 30_000,
          });
          try {
            await Promise.race([
              gate.reached,
              pending.then(() => {
                throw new Error(
                  "Delivery did not reach the intended post-verification configuration barrier",
                );
              }),
            ]);
            expect(firstReceiptAt).toBeDefined();
            expect(configurationsAfterReceipt).toBe(awaitedConfiguration);
            if (clockMode === "backward") f.support.advance(-50);
            // This bounded real-time delay is the expiry condition under test;
            // the trusted host clock deliberately cannot expire the receipt.
            const remaining = Math.max(
              1,
              firstReceiptAt! + receiptMilliseconds + 100 - performance.now(),
            );
            await new Promise<void>((resolve) =>
              setTimeout(resolve, remaining),
            );
          } finally {
            gate.release();
          }
          expect((await pending).outcome).toBe("held");
          expect(f.support.clock.now()).toBe(
            clockMode === "frozen"
              ? frozen
              : new Date(Date.parse(frozen) - 50).toISOString(),
          );
          expect(writes(f)).toEqual([]);
          const work = await f.support.work();
          expect(work.status).toBe("held");
          expect(JSON.stringify(work)).toContain(
            "Export a workspace to a downloadable file.",
          );
          expect(f.ports.generate).toHaveBeenCalledOnce();
          expect(f.ports.verifyChecks).toHaveBeenCalled();
        },
      );
    }

    it("retires affected published guidance after permanent withdrawal and physical ticket-body deletion", async () => {
      const f = await learningKbFixture(createStore());
      await f.eligible();
      const draft = await f.processToDraft();
      await f.reviewAndPublish(draft.articleId);
      await f.support.app.withdrawResolutionLearningSource(f.access.staff, {
        ...f.support.command("withdraw-published-source"),
        reason: "source_deleted",
      });
      await f.deleteTicketBody();
      const retained = await f.support.app.readResolutionLearningReconciliation(
        f.access.service,
        "ticket",
      );
      expect(retained.destinations[0]!.requestIdentityStatus).toBe("available");
      expect(JSON.stringify(retained)).not.toContain("draftPayload");
      await expect(
        f.kb.getPublishedArticle(f.access.customer, {
          articleId: draft.articleId,
        }),
      ).rejects.toThrow();
      await f.learning.reconcileSource("ticket");
      expect(
        (await f.kb.getDraft(f.access.admin, { articleId: draft.articleId }))
          .state,
      ).toBe("retired");
      expect(
        (
          await f.support.app.readResolutionLearningReconciliation(
            f.access.service,
            "ticket",
          )
        ).reconciliationPending,
      ).toBe(false);
      expect(
        (
          await f.kb.retrieveAnswerSources(f.access.bot, {
            collectionIds: [learningKbCollectionId],
            query: "workspace export",
            applicability: learningKbProduct,
          })
        ).outcome,
      ).toBe("no_result");
      const calls = f.ports.knowledgeCalls.filter(
        (call) => call.operation === "retireArticle",
      );
      expect(calls.length).toBeGreaterThan(0);
      expect((calls[0]!.args[0] as { principalId: string }).principalId).toBe(
        f.access.retirementService.principalId,
      );
    });

    it("preserves an independent publication when the invalid source exists only in its newer pending draft", async () => {
      const f = await learningKbFixture(createStore());
      const publication = await f.publishIndependentGuide(
        "independent-publication",
        "INDEPENDENT_APPROVED_EXPORT_GUIDANCE",
      );
      f.updateTarget(publication.articleId);
      await f.eligible();
      await f.processToDraft();
      await f.support.app.withdrawResolutionLearningSource(f.access.staff, {
        ...f.support.command("withdraw-pending-source"),
        reason: "privacy_withdrawal",
      });
      await f.deleteTicketBody();
      await f.learning.reconcileSource("ticket");
      expect(
        (
          await f.kb.getPublishedArticle(f.access.customer, {
            articleId: publication.articleId,
          })
        ).content.text,
      ).toBe("INDEPENDENT_APPROVED_EXPORT_GUIDANCE");
      expect(
        f.ports.knowledgeCalls.filter(
          (call) => call.operation === "retireArticle",
        ),
      ).toEqual([]);
    });

    it("recovers an accepted retirement acknowledgement and fences an original late create replay", async () => {
      const f = await learningKbFixture(createStore());
      await f.eligible();
      const draft = await f.processToDraft();
      await f.reviewAndPublish(draft.articleId);
      const originalWrite = writes(f)[0]!;
      await f.support.app.withdrawResolutionLearningSource(f.access.staff, {
        ...f.support.command("withdraw-before-retirement-ack-loss"),
        reason: "privacy_withdrawal",
      });
      await f.deleteTicketBody();
      let lost = false;
      f.interceptKnowledge(async (call, invoke) => {
        const value = await invoke();
        if (call.operation === "retireArticle" && !lost) {
          lost = true;
          throw new Error("Synthetic retirement acknowledgement lost");
        }
        return value;
      });
      await f.learning.reconcileSource("ticket");
      await f.learning.reconcileSource("ticket");
      const retired = await f.kb.getDraft(f.access.admin, {
        articleId: draft.articleId,
      });
      expect(retired.state).toBe("retired");
      const retirementCalls = f.ports.knowledgeCalls.filter(
        (call) => call.operation === "retireArticle",
      );
      expect(retirementCalls.length).toBeGreaterThan(0);
      for (const call of retirementCalls)
        expect(call.args).toEqual(retirementCalls[0]!.args);
      const originalInput = originalWrite.args[1] as CreateDraftInput;
      expect(retired.generation).toBeGreaterThan(
        originalInput.expectedGeneration,
      );
      const replay = await f.kb
        .createDraft(f.access.draftService, originalInput)
        .then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
      if ("value" in replay) expect(replay.value.replayed).toBe(true);
      expect(
        await f.kb.getDraft(f.access.admin, { articleId: draft.articleId }),
      ).toEqual(retired);
      await expect(
        f.kb.getPublishedArticle(f.access.customer, {
          articleId: draft.articleId,
        }),
      ).rejects.toThrow();
      expect(writes(f)).toHaveLength(1);
    });

    it("never clears an uncertain create merely because the actual KB reads absent or the job ages out", async () => {
      const f = await learningKbFixture(createStore());
      const key = await f.eligible();
      await modelStage(f, key);
      f.interceptKnowledge(async (call, invoke) => {
        if (call.operation === "createDraft")
          throw new Error("Synthetic unknown remote acceptance");
        return invoke();
      });
      await f.learning.processWork({
        ...key,
        workerId: "uncertain-create",
        leaseMilliseconds: 30_000,
      });
      const attempted = writes(f).length;
      expect(attempted).toBeGreaterThan(0);
      await f.support.app.withdrawResolutionLearningSource(f.access.staff, {
        ...f.support.command("withdraw-uncertain-create"),
        reason: "privacy_withdrawal",
      });
      await f.deleteTicketBody();
      f.support.advance(3_600_001);
      await f.learning.reconcileSource("ticket");
      const retained = await f.support.app.readResolutionLearningReconciliation(
        f.access.service,
        "ticket",
      );
      expect(retained.reconciliationPending).toBe(true);
      expect(retained.destinations).toHaveLength(1);
      expect(retained.destinations[0]!.requestIdentityStatus).toBe("available");
      expect(writes(f)).toHaveLength(attempted);
      expect(
        f.ports.knowledgeCalls.filter(
          (call) => call.operation === "retireArticle",
        ),
      ).toEqual([]);
    });
  });
}
