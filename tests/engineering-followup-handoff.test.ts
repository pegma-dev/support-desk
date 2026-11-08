import { createSupportDeskReleaseFollowup } from "@pegma/support-desk-ai";
import { engineeringFollowupRetestProductBinding } from "@pegma/support-desk-application";
import { describe, expect, it } from "vitest";
import {
  engineeringFollowupAiFixture,
  followupPrivateKnowledgeText,
  waitForFollowupHook,
} from "../test/engineering-followup-ai-fixtures.js";
import {
  engineeringFollowupBarrier,
  engineeringFollowupCustomer,
  engineeringFollowupStaff,
  engineeringFollowupStores,
} from "../test/engineering-followup-fixtures.js";
import {
  acceptanceCases,
  fixtureInstances,
} from "../test/knowledge-ai/corpus.js";
import { evaluateObservation } from "../test/knowledge-ai/evaluate.js";
import type {
  Artifact,
  InstanceId,
  Observation,
} from "../test/knowledge-ai/types.js";

type Fixture = Awaited<ReturnType<typeof engineeringFollowupAiFixture>>;

async function capturedObservation(
  f: Fixture,
  instanceId: InstanceId,
): Promise<Observation> {
  const work = await f.work();
  const bundle = work.preparedBundle?.bundle;
  const artifacts: Artifact[] = [];
  if (bundle !== undefined) {
    artifacts.push({
      kind: "draft",
      id: `${work.workId}:customer`,
      instanceId,
      text: bundle.customerDraft.body,
    });
    if (bundle.kbProposal !== null)
      artifacts.push({
        kind: "draft",
        id: `${work.workId}:kb`,
        instanceId,
        text: JSON.stringify(bundle.kbProposal),
      });
    for (const request of bundle.retestRequests)
      artifacts.push({
        kind: "retest",
        id: request.requestId,
        instanceId,
        text: JSON.stringify(request),
      });
  }
  return {
    instanceId,
    outcome:
      work.status === "bundle_prepared" ? "awaiting_approval" : work.status,
    modelRequests: f.generate.mock.calls.map(([input, context, config]) => ({
      operationId: context.operationId,
      instanceId,
      purpose: "follow_up",
      trigger: {
        ticketId: work.ticketId,
        revision: work.acceptedTicketRevision,
        generation: work.workGeneration,
      },
      promptVersion: context.promptVersion,
      configurationVersion: context.configurationVersion,
      providerVerificationRef: config.dataControls.configurationBinding,
      messages: input.messages.map((message) => {
        if (message.speaker === "notification")
          throw new Error("This corpus workflow has no notification input");
        return {
          role: message.speaker === "support" ? "staff" : message.speaker,
          content: message.text,
        };
      }),
      sources: [],
      budget: {
        inputTokens: context.budgets.maxInputTokens,
        outputTokens: context.budgets.maxOutputTokens,
        deadlineMilliseconds: context.budgets.maxDurationMilliseconds,
      },
    })),
    artifacts,
  };
}

for (const [name, createStore] of engineeringFollowupStores) {
  describe(`private release handoffs (${name})`, () => {
    it("checks the entire exact bundle against the real KB draft and authoritative requirements without KB writes", async () => {
      const f = await engineeringFollowupAiFixture(createStore(), {
        knowledge: true,
      });
      const knowledge = f.knowledge!;
      const initial = await knowledge.kb.getDraft(knowledge.access.admin, {
        articleId: knowledge.articleId,
      });
      const work = await f.prepareBundle();
      const [checked] = f.check.mock.calls[0]!;
      expect(checked.candidate).toEqual(f.candidate());
      expect(checked.exactBundle).toEqual(work.preparedBundle!.bundle);
      expect(checked.targetBaseline).toEqual(initial);
      expect(checked.targetBaseline!.revision.content.text).toBe(
        followupPrivateKnowledgeText,
      );
      const requirements = await knowledge.kb.getValidationRequirements(
        knowledge.access.draftService,
        {
          collectionId: initial.revision.collectionId,
          kind: initial.revision.kind,
        },
      );
      expect(checked.validationRequirements).toEqual(requirements);
      expect(checked.exactBundle.kbProposal!.target).toMatchObject({
        kind: "article",
        articleId: initial.articleId,
        collectionId: initial.revision.collectionId,
        articleRevision: initial.revision.number,
        contentHash: initial.revision.contentHash,
        validationRequirementIds: requirements.checks.map((check) => check.id),
      });
      for (const request of checked.exactBundle.retestRequests)
        expect(request.validationRequirementIds).toEqual(
          requirements.checks.map((check) => check.id),
        );
      for (const request of checked.exactBundle.retestRequests)
        expect(request.productBinding).toBe(
          await engineeringFollowupRetestProductBinding(work.context!),
        );
      expect(checked.binding.bundleHash).toBe(work.preparedBundle!.bundleHash);
      expect(
        new Set(knowledge.ports.knowledgeCalls.map((call) => call.operation)),
      ).toEqual(new Set(["getDraft", "getValidationRequirements"]));
      expect(JSON.stringify(f.generate.mock.calls[0]![0])).not.toContain(
        followupPrivateKnowledgeText,
      );
      expect(JSON.stringify(f.generate.mock.calls[0]![0])).not.toContain(
        knowledge.articleId,
      );
      expect(
        await knowledge.kb.getDraft(knowledge.access.admin, {
          articleId: knowledge.articleId,
        }),
      ).toEqual(initial);
      expect((await f.work()).delivered).toBeUndefined();
    });

    it("performs zero KB or knowledge-authority reads for an explicit none target", async () => {
      const f = await engineeringFollowupAiFixture(createStore(), {
        knowledge: true,
      });
      f.state.targetKind = "none";
      const work = await f.prepareBundle();
      expect(work.preparedBundle!.bundle.kbProposal!.target).toEqual({
        kind: "none",
      });
      expect(f.knowledge!.ports.knowledgeCalls).toEqual([]);
      expect(f.resolveKnowledge).not.toHaveBeenCalled();
      expect(f.check.mock.calls[0]![0].targetBaseline).toBeNull();
      expect(f.check.mock.calls[0]![0].validationRequirements).toBeNull();
    });

    it("posts product-bound advisory retests without KB requirement IDs when the selected article has no proposed change", async () => {
      const f = await engineeringFollowupAiFixture(createStore(), {
        knowledge: true,
      });
      const knowledge = f.knowledge!;
      const initial = await knowledge.kb.getDraft(knowledge.access.admin, {
        articleId: knowledge.articleId,
      });
      const requirements = await knowledge.kb.getValidationRequirements(
        knowledge.access.draftService,
        {
          collectionId: initial.revision.collectionId,
          kind: initial.revision.kind,
        },
      );
      expect(requirements.checks.length).toBeGreaterThan(0);
      const candidate = f.candidate({ kbProposal: null });
      expect(candidate.retestRequests.length).toBeGreaterThan(0);
      f.setModel(async () =>
        f.answer({ outputJson: JSON.stringify(candidate) }),
      );
      expect(await f.followup.processWork(f.nextCommand())).toMatchObject({
        outcome: "candidate",
      });
      expect((await f.work()).candidate).toEqual(candidate);
      const prepared = await f.prepareBundle();
      const checked = f.check.mock.calls[0]![0];
      const exactBundle = prepared.preparedBundle!.bundle;
      expect(checked.candidate).toEqual(candidate);
      expect(checked.exactBundle).toEqual(exactBundle);
      expect(checked.targetBaseline).toEqual(initial);
      expect(checked.validationRequirements).toEqual(requirements);
      expect(exactBundle.kbProposal).toBeNull();
      expect(exactBundle.retestRequests).toHaveLength(
        candidate.retestRequests.length,
      );
      for (const request of exactBundle.retestRequests) {
        expect(request.validationRequirementIds).toEqual([]);
        expect(request.productBinding).toBe(
          await engineeringFollowupRetestProductBinding(prepared.context!),
        );
      }
      expect(checked.binding.bundleHash).toBe(
        prepared.preparedBundle!.bundleHash,
      );
      const verifiedBefore = f.checksVerify.mock.calls.length;
      const sdkReadsBefore = knowledge.ports.knowledgeCalls.length;
      const command = await f.postCommand("post-advisory-retest-only-notice");
      const posted = await f.followup.approveAndPostWebUpdate(
        engineeringFollowupStaff,
        command,
      );
      expect(posted.bundleHash).toBe(prepared.preparedBundle!.bundleHash);
      expect(f.checksVerify.mock.calls.length).toBeGreaterThan(verifiedBefore);
      expect(f.checksVerify).toHaveBeenCalledWith(
        prepared.preparedBundle!.checksReceipt,
        checked.binding,
        expect.any(AbortSignal),
      );
      expect(knowledge.ports.knowledgeCalls.length).toBeGreaterThan(
        sdkReadsBefore,
      );
      const delivered = await f.work();
      expect(delivered.status).toBe("delivered");
      expect(delivered.delivered!.bundleHash).toBe(posted.bundleHash);
      expect(delivered.handoff).toEqual({
        kbProposal: null,
        retestRequests: exactBundle.retestRequests,
      });
      expect(
        (
          await f.app.readCustomerTicket(engineeringFollowupCustomer, "ticket")
        ).messages.find((message) => message.id === posted.messageId)?.body,
      ).toBe(exactBundle.customerDraft.body);
      expect(
        new Set(knowledge.ports.knowledgeCalls.map((call) => call.operation)),
      ).toEqual(new Set(["getDraft", "getValidationRequirements"]));
      expect(
        await knowledge.kb.getDraft(knowledge.access.admin, {
          articleId: knowledge.articleId,
        }),
      ).toEqual(initial);
      await expect(
        knowledge.kb.getPublishedArticle(knowledge.access.customer, {
          articleId: knowledge.articleId,
        }),
      ).rejects.toThrow();
      expect(f.generate).toHaveBeenCalledOnce();
      expect(f.reserve).toHaveBeenCalledOnce();
    });

    it("blocks stale staff posting after the actual KB draft changes", async () => {
      const f = await engineeringFollowupAiFixture(createStore(), {
        knowledge: true,
      });
      await f.prepareBundle();
      const command = await f.postCommand();
      const knowledge = f.knowledge!;
      const current = await knowledge.kb.getDraft(knowledge.access.admin, {
        articleId: knowledge.articleId,
      });
      const revision = current.revision;
      await knowledge.kb.updateDraft(knowledge.access.admin, {
        ...knowledge.command("changed-followup-baseline", current.generation),
        articleId: knowledge.articleId,
        collectionId: revision.collectionId,
        draft: {
          kind: revision.kind,
          title: revision.title,
          summary: revision.summary,
          tags: revision.tags,
          applicability: revision.applicability,
          content: {
            format: "plain_text",
            text: `${revision.content.text}\nA new independently edited validation step.`,
          },
        },
      });
      await expect(
        f.followup.approveAndPostWebUpdate(engineeringFollowupStaff, command),
      ).rejects.toThrow();
      expect(
        (
          await f.app.readCustomerTicket(engineeringFollowupCustomer, "ticket")
        ).messages.some((message) => message.id === command.messageId),
      ).toBe(false);
      expect((await f.work()).delivered).toBeUndefined();
      expect(f.generate).toHaveBeenCalledOnce();
    });

    it("requires an independently matching check receipt for the complete bundle", async () => {
      const f = await engineeringFollowupAiFixture(createStore());
      await f.prepareBundle();
      const prepared = (await f.work()).preparedBundle!;
      f.trust.issueChecks(prepared.checksReceipt, {
        ...prepared.binding,
        bundleHash: "different-complete-bundle",
      });
      await expect(
        f.followup.approveAndPostWebUpdate(
          engineeringFollowupStaff,
          await f.postCommand(),
        ),
      ).rejects.toThrow();
      expect((await f.work()).delivered).toBeUndefined();
    });

    it("rechecks actual source withdrawal after a captured real SDK requirements read before posting", async () => {
      const f = await engineeringFollowupAiFixture(createStore(), {
        knowledge: true,
      });
      await f.prepareBundle();
      const command = await f.postCommand();
      const barrier = engineeringFollowupBarrier();
      let captured = false;
      const followup = createSupportDeskReleaseFollowup({
        ...f.baseOptions,
        knowledge: {
          ...f.baseOptions.knowledge!,
          async getValidationRequirements(...args) {
            const requirements =
              await f.baseOptions.knowledge!.getValidationRequirements(...args);
            if (!captured) {
              captured = true;
              await barrier.wait();
            }
            return requirements;
          },
        },
      });
      const pending = followup.approveAndPostWebUpdate(
        engineeringFollowupStaff,
        command,
        { signal: AbortSignal.timeout(10_000) },
      );
      try {
        await waitForFollowupHook(barrier, pending);
        await f.app.withdrawEngineeringSource(engineeringFollowupStaff, {
          ...f.command("withdraw-during-kb-requirements"),
          reason: "privacy_withdrawal",
        });
      } finally {
        barrier.release();
      }
      await expect(pending).rejects.toThrow();
      expect(captured).toBe(true);
      expect(
        (
          await f.app.readCustomerTicket(engineeringFollowupCustomer, "ticket")
        ).messages.some((message) => message.id === command.messageId),
      ).toBe(false);
      expect((await f.work()).delivered).toBeUndefined();
      expect(f.generate).toHaveBeenCalledOnce();
    });

    it("does not treat inaccessible authoritative validation requirements as an empty checklist", async () => {
      const f = await engineeringFollowupAiFixture(createStore(), {
        knowledge: true,
      });
      expect(await f.followup.processWork(f.nextCommand())).toMatchObject({
        outcome: "candidate",
      });
      const followup = createSupportDeskReleaseFollowup({
        ...f.baseOptions,
        knowledge: {
          ...f.baseOptions.knowledge!,
          async getValidationRequirements() {
            throw new Error("Actual SDK requirements unavailable");
          },
        },
      });
      await followup.processWork(f.nextCommand());
      expect((await f.work()).preparedBundle).toBeUndefined();
      expect(f.check).not.toHaveBeenCalled();
      expect((await f.work()).delivered).toBeUndefined();
    });

    it.each(["request", "build", "runner"] as const)(
      "requires a trusted retest receipt for the exact %s binding",
      async (variant) => {
        const f = await engineeringFollowupAiFixture(createStore());
        await f.prepareBundle();
        const before = await f.work();
        const binding = await f.retestBinding();
        const receipt = `wrong-retest-${variant}`;
        f.trust.issueRetest(
          receipt,
          {
            ...binding,
            ...(variant === "request"
              ? { requestHash: "foreign-request-hash" }
              : {}),
            ...(variant === "build"
              ? { productBinding: "foreign-deployed-build" }
              : {}),
          },
          "passed",
          variant === "runner" ? { runnerId: "untrusted-runner" } : {},
        );
        await expect(
          f.app.submitEngineeringFollowupRetestResult(
            engineeringFollowupStaff,
            {
              ...f.command(`reject-${variant}-retest`),
              ...f.key,
              retestRequestId: binding.requestId,
              receiptReference: receipt,
            },
          ),
        ).rejects.toThrow();
        expect(await f.work()).toEqual(before);
      },
    );

    it("keeps a passing retest held until explicit fresh staff reassessment and preserves semantic identity and paid counters", async () => {
      const f = await engineeringFollowupAiFixture(createStore());
      await f.prepareBundle();
      const before = await f.work();
      const binding = await f.retestBinding();
      f.trust.issueRetest("trusted-failed-followup-retest", binding, "failed");
      await f.app.submitEngineeringFollowupRetestResult(
        engineeringFollowupStaff,
        {
          ...f.command("failed-advisory-retest"),
          ...f.key,
          retestRequestId: binding.requestId,
          receiptReference: "trusted-failed-followup-retest",
        },
      );
      expect((await f.work()).status).toBe("held");
      f.trust.issueRetest("trusted-passed-followup-retest", binding, "passed");
      await f.app.submitEngineeringFollowupRetestResult(
        engineeringFollowupStaff,
        {
          ...f.command("passed-advisory-retest"),
          ...f.key,
          retestRequestId: binding.requestId,
          receiptReference: "trusted-passed-followup-retest",
        },
      );
      const held = await f.work();
      expect(held.status).toBe("held");
      expect(held.completionRows).toBe(0);
      expect(held.messageSlots).toBe(0);
      expect(held.delivered).toBeUndefined();
      f.state.configurationOutcome = "disabled";
      const checkedBefore = f.check.mock.calls.length;
      await f.followup.prepareStaffReassessment(engineeringFollowupStaff, {
        ...f.command("explicit-staff-followup-reassessment"),
        ...f.key,
        expectedWorkGeneration: held.workGeneration,
      });
      const reassessed = await f.work();
      expect(reassessed.status).toBe("bundle_prepared");
      expect(reassessed.workId).toBe(before.workId);
      expect(reassessed.modelAttempts).toEqual(before.modelAttempts);
      expect(reassessed.usageTombstones).toEqual(before.usageTombstones);
      expect(reassessed.usageTombstones).toHaveLength(1);
      expect(reassessed.bundleRevision).toBe(before.bundleRevision + 1);
      expect(reassessed.completionRows).toBe(3);
      expect(reassessed.messageSlots).toBe(1);
      expect(f.check.mock.calls.length).toBeGreaterThan(checkedBefore);
      expect(f.generate).toHaveBeenCalledOnce();
      expect(f.reserve).toHaveBeenCalledOnce();
      expect((await f.head()).workCount).toBe(1);
      await f.followup.approveAndPostWebUpdate(
        engineeringFollowupStaff,
        await f.postCommand(),
      );
      expect((await f.work()).status).toBe("delivered");
    });

    it.each(
      (["workshop", "observatory"] as const).flatMap((instanceId) =>
        (["released-fix", "duplicate-release"] as const).map(
          (suffix) => [instanceId, suffix] as const,
        ),
      ),
    )(
      "executes P00 %s/%s through actual committed private handoffs",
      async (instanceId, suffix) => {
        const profile = fixtureInstances[instanceId];
        const scenario = acceptanceCases.find(
          (value) => value.id === `${instanceId}/${suffix}`,
        )!;
        const f = await engineeringFollowupAiFixture(createStore(), {
          support: {
            initialBody: `${profile.publicSentinel}: exporting a workspace loses its rows.`,
            privateNote: [
              profile.staffSentinel,
              profile.provenanceSentinel,
              profile.privateLink,
            ].join(" "),
          },
        });
        const before = await f.app.readCustomerTicket(
          engineeringFollowupCustomer,
          "ticket",
        );
        const originalKey = { ...f.key };
        if (suffix === "duplicate-release") {
          const pending = await f.work();
          for (let delivery = 0; delivery < 3; delivery += 1) {
            const observed = await f.observe();
            expect(observed.outcome).toBe("unchanged");
            if (observed.workId !== undefined)
              expect(observed.workId).toBe(originalKey.workId);
            expect(f.key).toEqual(originalKey);
            expect(await f.work()).toEqual(pending);
          }
        }
        const prepared = await f.prepareBundle();
        if (suffix === "duplicate-release") {
          const observed = await f.observe();
          expect(observed.outcome).toBe("unchanged");
          if (observed.workId !== undefined)
            expect(observed.workId).toBe(originalKey.workId);
          expect(f.key).toEqual(originalKey);
          expect(await f.work()).toEqual(prepared);
        }
        const observation = await capturedObservation(f, instanceId);
        expect(evaluateObservation(scenario, observation)).toEqual([]);
        expect((await f.head()).workCount).toBe(1);
        expect(f.generate).toHaveBeenCalledOnce();
        expect(
          await f.app.readCustomerTicket(engineeringFollowupCustomer, "ticket"),
        ).toEqual(before);
        expect((await f.work()).delivered).toBeUndefined();
      },
    );
  });
}
