import { resolveAccess } from "@pegma/authorization-core";
import { describe, expect, it, vi } from "vitest";
import { createSupportDeskLearning } from "../packages/ai/src/learning-coordinator.js";
import type { SupportDeskLearningOptions } from "../packages/ai/src/learning-integration-types.js";
import {
  learningKbFixture,
  learningKbStores,
} from "../test/resolution-learning-kb-fixtures.js";

type Fixture = Awaited<ReturnType<typeof learningKbFixture>>;

function staged(
  f: Fixture,
  retirementAccess: SupportDeskLearningOptions["retirementAccess"] = {
    resolve: f.ports.resolveRetirement,
  },
) {
  return createSupportDeskLearning({
    application: f.support.app,
    knowledge: f.ports.knowledge,
    sources: f.sources,
    serviceAccess: { resolve: f.ports.resolveService },
    knowledgeAccess: { resolve: f.ports.resolveKnowledge },
    retirementAccess,
    configuration: { resolve: f.ports.resolveConfiguration },
    checks: f.checks,
    model: { generate: f.ports.generate },
    usage: { reserve: f.ports.reserve, reconcile: f.ports.reconcileUsage },
    tokenCounter: {
      count: (text) => new TextEncoder().encode(text).byteLength,
    },
    targets: { resolveScope: f.ports.resolveScope, select: f.ports.select },
    clock: f.support.clock,
    deliveryMode: "staged",
    storageCommandAttempts: 2,
  });
}

function retirements(f: Fixture) {
  return f.ports.knowledgeCalls.filter(
    (call) => call.operation === "retireArticle",
  );
}

function view(f: Fixture) {
  return f.support.app.readResolutionLearningReconciliation(
    f.access.service,
    "ticket",
  );
}

async function withdrawnDraft(f: Fixture) {
  await f.eligible("staff_verified_fix");
  const draft = await f.processToDraft();
  await f.support.app.withdrawResolutionLearningSource(f.access.staff, {
    ...f.support.command("withdraw-for-staged-retirement"),
    reason: "privacy_withdrawal",
  });
  f.ports.knowledgeCalls.length = 0;
  return draft;
}

// These are current external authority-port facts resolved through the real
// Authorization Core policy. The host integration owns durable RoleStore proof.
function currentRetirementAuthority(f: Fixture) {
  let active = true;
  const resolve = vi.fn<
    SupportDeskLearningOptions["retirementAccess"]["resolve"]
  >(async () => ({
    outcome: "ready",
    authority: {
      authorityVersion: "current-retirement-policy-v1",
      access: resolveAccess(
        {
          principalId: f.access.retirementService.principalId,
          roles: active ? ["retirement"] : [],
        },
        {
          version: "current-retirement-policy-v1",
          roles: { retirement: f.access.retirementService.permissions },
        },
      ),
    },
  }));
  return {
    resolve,
    revoke() {
      active = false;
    },
    restore() {
      active = true;
    },
  };
}

for (const [name, createStore] of learningKbStores) {
  describe(`staged learning retirement (${name})`, () => {
    it("yields after a committed retirement and freshly confirms in a new coordinator", async () => {
      const f = await learningKbFixture(createStore());
      const draft = await withdrawnDraft(f);
      const generated = f.ports.generate.mock.calls.length;
      f.state.configurationOutcome = "disabled";

      const first = await staged(f).reconcileSource("ticket");
      expect(first).toMatchObject({
        outcome: "pending",
        processedDestinations: 1,
        reason: "reconciliation_pending",
      });
      expect((await view(f)).reconciliationPending).toBe(true);
      expect(retirements(f)).toHaveLength(1);
      expect(f.ports.knowledgeCalls.at(-1)?.operation).toBe("retireArticle");
      expect(
        (await f.kb.getDraft(f.access.admin, { articleId: draft.articleId }))
          .state,
      ).toBe("retired");

      const second = await staged(f).reconcileSource("ticket");
      expect(second.outcome).toBe("reconciled");
      expect((await view(f)).reconciliationPending).toBe(false);
      expect(retirements(f)).toHaveLength(1);
      expect(f.ports.generate).toHaveBeenCalledTimes(generated);
    });

    it("retains committed retirement after lost ACK without repeating the KB write", async () => {
      const f = await learningKbFixture(createStore());
      const draft = await withdrawnDraft(f);
      f.interceptKnowledge(async (call, invoke) => {
        const result = await invoke();
        if (call.operation === "retireArticle")
          throw new Error("Synthetic accepted retirement lost acknowledgement");
        return result;
      });
      expect((await staged(f).reconcileSource("ticket")).outcome).toBe(
        "pending",
      );
      expect((await view(f)).reconciliationPending).toBe(true);
      expect(
        (await f.kb.getDraft(f.access.admin, { articleId: draft.articleId }))
          .state,
      ).toBe("retired");
      f.interceptKnowledge(undefined);
      expect((await staged(f).reconcileSource("ticket")).outcome).toBe(
        "reconciled",
      );
      expect(retirements(f)).toHaveLength(1);
    });

    it("ends an unknown unaccepted attempt and reuses the exact KB command next invocation", async () => {
      const f = await learningKbFixture(createStore());
      const draft = await withdrawnDraft(f);
      f.interceptKnowledge(async (call, invoke) => {
        if (call.operation === "retireArticle")
          throw new Error(
            "Synthetic transport failed before remote acceptance",
          );
        return invoke();
      });
      expect((await staged(f).reconcileSource("ticket")).outcome).toBe(
        "pending",
      );
      expect(retirements(f)).toHaveLength(1);
      expect(
        (await f.kb.getDraft(f.access.admin, { articleId: draft.articleId }))
          .state,
      ).toBe("draft");
      const original = structuredClone(retirements(f)[0]!.args);
      f.interceptKnowledge(undefined);
      expect((await staged(f).reconcileSource("ticket")).outcome).toBe(
        "pending",
      );
      expect(retirements(f)).toHaveLength(2);
      expect(retirements(f)[1]!.args).toEqual(original);
      expect((await staged(f).reconcileSource("ticket")).outcome).toBe(
        "reconciled",
      );
      expect(retirements(f)).toHaveLength(2);
    });

    it("advances only one unconfirmed destination and skips earlier confirmed destinations", async () => {
      const f = await learningKbFixture(createStore());
      await f.eligible("staff_verified_fix");
      const first = await f.processToDraft();
      const source = await f.support.source();
      const detail = await f.support.app.readStaffTicket(
        f.access.staff,
        "ticket",
      );
      const solution = detail.messages.find(
        (message) => message.authorKind === "assistant",
      );
      if (solution === undefined)
        throw new Error("Actual learning fixture has no visible solution");
      await f.support.app.submitResolutionEvidence(f.access.staff, {
        ...f.support.command("second-distinct-source-proof"),
        expectedRevision: detail.ticket.revision,
        resolutionCycle: source.resolutionCycle,
        evidence: {
          kind: "staff_verified_fix",
          solutionMessageId: solution.id,
          verificationReference: "second-distinct-working-proof",
        },
      });
      const current = await f.support.source();
      const second = await f.processToDraft({
        ticketId: "ticket",
        sourceGeneration: current.sourceGeneration,
      });
      expect(second.articleId).not.toBe(first.articleId);
      await f.support.app.withdrawResolutionLearningSource(f.access.staff, {
        ...f.support.command("withdraw-two-destinations"),
        reason: "privacy_withdrawal",
      });
      expect((await view(f)).destinations).toHaveLength(2);
      f.ports.knowledgeCalls.length = 0;

      const firstPass = await staged(f).reconcileSource("ticket");
      expect(firstPass).toMatchObject({
        outcome: "pending",
        processedDestinations: 1,
      });
      expect(retirements(f)).toHaveLength(1);
      const firstRetired = await f.kb.getDraft(f.access.admin, {
        articleId: first.articleId,
      });
      expect(firstRetired.state).toBe("retired");
      expect(
        (await f.kb.getDraft(f.access.admin, { articleId: second.articleId }))
          .state,
      ).toBe("draft");
      const confirmed = await staged(f).reconcileSource("ticket");
      expect(confirmed).toMatchObject({
        outcome: "pending",
        processedDestinations: 1,
      });
      expect(
        (await view(f)).destinations.filter(
          (d) => d.reconciliation === "confirmed",
        ),
      ).toHaveLength(1);
      expect(retirements(f)).toHaveLength(1);
      expect(
        (await staged(f).reconcileSource("ticket")).processedDestinations,
      ).toBe(1);
      expect(retirements(f)).toHaveLength(2);
      expect((await staged(f).reconcileSource("ticket")).outcome).toBe(
        "reconciled",
      );
      expect(
        (await view(f)).destinations.every(
          (d) => d.reconciliation === "confirmed",
        ),
      ).toBe(true);
      expect(retirements(f)).toHaveLength(2);
    });

    it("re-resolves current retirement permissions before attempting the KB mutation", async () => {
      const f = await learningKbFixture(createStore());
      const draft = await withdrawnDraft(f);
      const authority = currentRetirementAuthority(f);
      f.interceptKnowledge(async (call, invoke) => {
        const result = await invoke();
        if (call.operation === "getProvenance") authority.revoke();
        return result;
      });
      expect(
        (await staged(f, authority).reconcileSource("ticket")).outcome,
      ).not.toBe("reconciled");
      expect(authority.resolve.mock.calls.length).toBeGreaterThan(2);
      expect(retirements(f)).toEqual([]);
      expect((await view(f)).reconciliationPending).toBe(true);
      expect(
        (await f.kb.getDraft(f.access.admin, { articleId: draft.articleId }))
          .state,
      ).toBe("draft");
    });

    it("keeps the final fresh authority fence after a committed retirement", async () => {
      const f = await learningKbFixture(createStore());
      const draft = await withdrawnDraft(f);
      const authority = currentRetirementAuthority(f);
      f.interceptKnowledge(async (call, invoke) => {
        const result = await invoke();
        if (call.operation === "retireArticle") authority.revoke();
        return result;
      });
      expect(
        await staged(f, authority).reconcileSource("ticket"),
      ).toMatchObject({
        outcome: "pending",
        reason: "reconciliation_unavailable",
      });
      expect((await view(f)).reconciliationPending).toBe(true);
      expect(
        (await f.kb.getDraft(f.access.admin, { articleId: draft.articleId }))
          .state,
      ).toBe("retired");
      expect(retirements(f)).toHaveLength(1);
      authority.restore();
      f.interceptKnowledge(undefined);
      expect(
        (await staged(f, authority).reconcileSource("ticket")).outcome,
      ).toBe("reconciled");
      expect(retirements(f)).toHaveLength(1);
    });

    it("refuses stale source observations before retirement", async () => {
      const f = await learningKbFixture(createStore());
      await f.eligible();
      const draft = await f.processToDraft();
      await f.support.app.reopenTicket(
        f.access.staff,
        f.support.command("reopen-before-source-race"),
      );
      let changed = false;
      f.ports.knowledgeCalls.length = 0;
      f.interceptKnowledge(async (call, invoke) => {
        const result = await invoke();
        if (call.operation === "getProvenance" && !changed) {
          changed = true;
          await f.support.app.withdrawResolutionLearningSource(f.access.staff, {
            ...f.support.command("withdraw-during-observation"),
            reason: "privacy_withdrawal",
          });
        }
        return result;
      });
      const result = await staged(f).reconcileSource("ticket");
      expect(result).toMatchObject({
        outcome: "blocked",
        reason: "reconciliation_source_changed",
      });
      expect(retirements(f)).toEqual([]);
      expect((await view(f)).reconciliationPending).toBe(true);
      expect(
        (await f.kb.getDraft(f.access.admin, { articleId: draft.articleId }))
          .state,
      ).toBe("draft");
    });

    it("preserves a concurrent independent KB revision and confirms its fresh generation later", async () => {
      const f = await learningKbFixture(createStore());
      const draft = await withdrawnDraft(f);
      let provenanceReads = 0;
      f.interceptKnowledge(async (call, invoke) => {
        const result = await invoke();
        if (call.operation === "getProvenance" && ++provenanceReads === 2) {
          const current = await f.kb.getDraft(f.access.admin, {
            articleId: draft.articleId,
          });
          await f.kb.updateDraft(f.access.admin, {
            ...f.command("independent-concurrent-revision", current.generation),
            articleId: draft.articleId,
            collectionId: current.revision.collectionId,
            draft: {
              kind: current.revision.kind,
              title: current.revision.title,
              summary: current.revision.summary,
              content: {
                format: "plain_text",
                text: "INDEPENDENT_CURRENT_GUIDANCE",
              },
              tags: current.revision.tags,
              applicability: current.revision.applicability,
            },
            sourceReferences: [],
          });
        }
        return result;
      });
      expect((await staged(f).reconcileSource("ticket")).outcome).toBe(
        "pending",
      );
      expect(retirements(f)).toHaveLength(1);
      const independent = await f.kb.getDraft(f.access.admin, {
        articleId: draft.articleId,
      });
      expect(independent.state).toBe("draft");
      expect(independent.revision.content.text).toBe(
        "INDEPENDENT_CURRENT_GUIDANCE",
      );
      expect((await view(f)).reconciliationPending).toBe(true);
      f.interceptKnowledge(undefined);
      expect((await staged(f).reconcileSource("ticket")).outcome).toBe(
        "reconciled",
      );
      expect(retirements(f)).toHaveLength(1);
      expect(
        await f.kb.getDraft(f.access.admin, { articleId: draft.articleId }),
      ).toEqual(independent);
    });
  });
}
