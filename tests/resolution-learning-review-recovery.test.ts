import type { AccessContext } from "@pegma/authorization-core";
import {
  createSupportDeskApplication,
  supportPermissions,
  type ReviewResolutionLearningProposalCommand,
  type ResolutionLearningSourceResult,
} from "@pegma/support-desk-application";
import type { LearningReviewCommand } from "@pegma/support-desk-ai";
import { describe, expect, it } from "vitest";
import type { HandlingTransaction } from "../test/handling-fixtures.js";
import {
  learningKbBarrier,
  learningKbFixture,
  learningKbStores,
} from "../test/resolution-learning-kb-fixtures.js";

type Fixture = Awaited<ReturnType<typeof learningKbFixture>>;
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isReview(trace: HandlingTransaction): boolean {
  return trace.actions.some(
    (action) =>
      "value" in action &&
      object(action.value) &&
      action.value.kind === "resolution_learning_review",
  );
}
function hasReceipt(trace: HandlingTransaction, commandId: string): boolean {
  return trace.actions.some(
    (action) =>
      "value" in action &&
      object(action.value) &&
      action.value.kind === "resolution_learning_receipt" &&
      action.value.id === `learning-command:${commandId}`,
  );
}
async function prepared(f: Fixture): Promise<LearningReviewCommand> {
  const key = await f.eligible("staff_verified_fix");
  await f.processToDraft(key);
  const value = await f.learning.prepareReviewIntent(f.access.staff, key);
  return {
    intent: value.intent,
    commandId: "EXACT-REVIEW-COMMAND",
    correlationId: "synthetic-review-recovery",
    decision: "approve",
  };
}
async function edit(f: Fixture, packet: LearningReviewCommand) {
  const draft = await f.kb.getDraft(f.access.guideAuthor, {
    articleId: packet.intent.target.articleId,
  });
  return f.kb.updateDraft(f.access.draftService, {
    ...f.command("concurrent-edit", draft.generation),
    articleId: draft.revision.articleId,
    collectionId: draft.revision.collectionId,
    draft: {
      kind: draft.revision.kind,
      title: "Independently edited export guide",
      summary: draft.revision.summary,
      content: draft.revision.content,
      tags: draft.revision.tags,
      applicability: draft.revision.applicability,
    },
  });
}
async function awaitBarrier(
  gate: ReturnType<typeof learningKbBarrier>,
  pending: Promise<unknown>,
) {
  await Promise.race([
    gate.reached,
    pending.then(
      () => {
        throw new Error(
          "Operation finished before its real transaction barrier",
        );
      },
      (error: unknown) => {
        throw error;
      },
    ),
  ]);
}
const currentHuman = async () => {};

for (const [name, createStore] of learningKbStores) {
  describe(`exact learning review recovery (${name})`, () => {
    it("prepares the actual checked draft and immutable command coordinates without a write or model call", async () => {
      const f = await learningKbFixture(createStore());
      const packet = await prepared(f);
      const before = await f.support.rows();
      const calls = f.ports.generate.mock.calls.length;
      const value = await f.learning.prepareReviewIntent(f.access.staff, {
        ticketId: packet.intent.ticketId,
        sourceGeneration: packet.intent.sourceGeneration,
      });
      expect(value.intent).toEqual(packet.intent);
      expect(value.draft).toEqual(
        await f.kb.getDraft(f.access.staff, {
          articleId: packet.intent.target.articleId,
        }),
      );
      expect(Object.isFrozen(value.intent)).toBe(true);
      expect(Object.isFrozen(value.intent.policy)).toBe(true);
      expect(await f.support.rows()).toEqual(before);
      expect(f.ports.generate).toHaveBeenCalledTimes(calls);
      expect(
        await f.learning.readReviewReceipt(f.access.staff, packet),
      ).toBeNull();
      expect(await f.support.rows()).toEqual(before);
    });

    it("refuses a changed target before acceptance and explicitly cancels the exact intent without approving it", async () => {
      const f = await learningKbFixture(createStore());
      const packet = await prepared(f);
      await edit(f, packet);
      const before = await f.support.rows();
      await expect(
        f.learning.submitReviewIntent(f.access.staff, packet),
      ).rejects.toThrow();
      expect(await f.support.rows()).toEqual(before);
      expect(
        await f.learning.readReviewReceipt(f.access.staff, packet),
      ).toBeNull();
      const cancelled = await f.learning.cancelReview(f.access.staff, packet, {
        verifyBeforeCommit: currentHuman,
      });
      expect(cancelled).toEqual({
        outcome: "cancelled",
        ticketId: packet.intent.ticketId,
        commandId: packet.commandId,
      });
      expect(
        await f.learning.readReviewReceipt(f.access.staff, packet),
      ).toEqual(cancelled);
      const after = await f.support.rows();
      expect(after).toHaveLength(before.length + 2);
      expect(
        after.filter((row) => row.kind === "resolution_learning_review"),
      ).toEqual([]);
      expect(
        after.some(
          (row) =>
            row.kind === "audit" &&
            row.event.action === "support.learning.review_cancelled",
        ),
      ).toBe(true);
      await expect(
        f.learning.submitReviewIntent(f.access.staff, packet),
      ).rejects.toThrow();
      expect(
        await f.learning.cancelReview(f.access.staff, packet, {
          verifyBeforeCommit: currentHuman,
        }),
      ).toEqual(cancelled);
      expect(await f.support.rows()).toEqual(after);
    });

    it("cancels an obsolete policy intent and permits only a separately prepared command to submit the renewed proof", async () => {
      const f = await learningKbFixture(createStore());
      const packet = await prepared(f);
      f.state.policy = {
        ...f.state.policy,
        verifiedAt: new Date(
          Date.parse(f.state.policy.verifiedAt) - 1,
        ).toISOString(),
      };
      const before = await f.support.rows();
      await expect(
        f.learning.submitReviewIntent(f.access.staff, packet),
      ).rejects.toThrow();
      expect(await f.support.rows()).toEqual(before);
      expect(
        await f.learning.cancelReview(f.access.staff, packet, {
          verifyBeforeCommit: currentHuman,
        }),
      ).toMatchObject({ outcome: "cancelled" });
      const next = await f.learning.prepareReviewIntent(f.access.staff, {
        ticketId: packet.intent.ticketId,
        sourceGeneration: packet.intent.sourceGeneration,
      });
      expect(next.intent.policy).toEqual(f.state.policy);
      await expect(
        f.learning.submitReviewIntent(f.access.staff, {
          ...packet,
          intent: next.intent,
        }),
      ).rejects.toThrow();
      const accepted = await f.learning.submitReviewIntent(f.access.staff, {
        ...packet,
        commandId: "SEPARATELY-CONFIRMED-REVIEW",
        intent: next.intent,
      });
      expect(accepted.ticketId).toBe(packet.intent.ticketId);
      expect(
        (await f.support.rows()).filter(
          (row) => row.kind === "resolution_learning_review",
        ),
      ).toHaveLength(1);
    });

    it.each(["reopen", "withdraw"] as const)(
      "recovers a committed lost acknowledgement after %s and obsolete policy without a new approval",
      async (change) => {
        const f = await learningKbFixture(createStore());
        const packet = await prepared(f);
        let accepted: ResolutionLearningSourceResult | undefined;
        await expect(
          (async () => {
            accepted = await f.learning.submitReviewIntent(
              f.access.staff,
              packet,
            );
            throw new Error(
              "Synthetic committed review transport acknowledgement loss",
            );
          })(),
        ).rejects.toThrow("acknowledgement loss");
        if (change === "reopen")
          await f.support.app.reopenTicket(
            f.access.staff,
            f.support.command("source-reopened"),
          );
        else
          await f.support.app.withdrawResolutionLearningSource(f.access.staff, {
            ...f.support.command("source-withdrawn"),
            reason: "privacy_withdrawal",
          });
        f.support.advance(3_600_001);
        f.state.policyOutcome = "unavailable";
        f.state.serviceOutcome = "unavailable";
        f.state.configurationOutcome = "disabled";
        const before = await f.support.rows();
        expect(
          await f.learning.submitReviewIntent(f.access.staff, packet),
        ).toEqual(accepted);
        expect(
          await f.learning.readReviewReceipt(f.access.staff, packet),
        ).toEqual({ outcome: "accepted", result: accepted });
        expect(
          await f.learning.cancelReview(f.access.staff, packet, {
            verifyBeforeCommit: currentHuman,
          }),
        ).toEqual({ outcome: "accepted", result: accepted });
        expect(await f.support.rows()).toEqual(before);
        const current = await f.support.app.readResolutionLearningSource(
          f.access.staff,
          packet.intent.ticketId,
        );
        expect(current.state).not.toBe("eligible");
        expect(
          await f.kb.getDraft(f.access.staff, {
            articleId: packet.intent.target.articleId,
          }),
        ).toMatchObject({ hasPublication: false });
      },
    );

    it("lets atomic cancellation win against an already guarded late review transaction", async () => {
      const f = await learningKbFixture(createStore());
      const packet = await prepared(f);
      const gate = learningKbBarrier();
      let paused = false;
      f.support.observed.intercept(async (trace, commit) => {
        if (!paused && isReview(trace)) {
          paused = true;
          await gate.wait();
        }
        return commit();
      });
      const pending = f.learning.submitReviewIntent(f.access.staff, packet);
      const observed = pending.then(
        () => "accepted",
        () => "refused",
      );
      try {
        await awaitBarrier(gate, pending);
        expect(
          await f.learning.readReviewReceipt(f.access.staff, packet),
        ).toBeNull();
        expect(
          await f.learning.cancelReview(f.access.staff, packet, {
            verifyBeforeCommit: currentHuman,
          }),
        ).toMatchObject({ outcome: "cancelled" });
      } finally {
        gate.release();
      }
      expect(await observed).toBe("refused");
      expect(
        (await f.support.rows()).filter(
          (row) => row.kind === "resolution_learning_review",
        ),
      ).toEqual([]);
      expect(
        await f.learning.readReviewReceipt(f.access.staff, packet),
      ).toMatchObject({ outcome: "cancelled" });
    });

    it("recovers the accepted winner when review commits before a paused cancellation", async () => {
      const f = await learningKbFixture(createStore());
      const packet = await prepared(f);
      const gate = learningKbBarrier();
      let paused = false;
      f.support.observed.intercept(async (trace, commit) => {
        if (
          !paused &&
          hasReceipt(trace, packet.commandId) &&
          !isReview(trace)
        ) {
          paused = true;
          await gate.wait();
        }
        return commit();
      });
      const pending = f.learning.cancelReview(f.access.staff, packet, {
        verifyBeforeCommit: currentHuman,
      });
      let accepted: ResolutionLearningSourceResult | undefined;
      try {
        await awaitBarrier(gate, pending);
        accepted = await f.learning.submitReviewIntent(f.access.staff, packet);
      } finally {
        gate.release();
      }
      expect(await pending).toEqual({ outcome: "accepted", result: accepted });
      const rows = await f.support.rows();
      expect(
        rows.filter((row) => row.kind === "resolution_learning_review"),
      ).toHaveLength(1);
      expect(
        rows.some(
          (row) =>
            row.kind === "audit" &&
            row.event.action === "support.learning.review_cancelled",
        ),
      ).toBe(false);
    });

    it("recovers a lost cancellation acknowledgement from its real retained receipt without duplicate rows", async () => {
      const f = await learningKbFixture(createStore());
      const packet = await prepared(f);
      const before = await f.support.rows();
      let lose = true;
      f.support.observed.intercept(async (trace, commit) => {
        const result = await commit();
        if (
          lose &&
          result.committed &&
          hasReceipt(trace, packet.commandId) &&
          !isReview(trace)
        ) {
          lose = false;
          throw new Error("Synthetic committed cancellation response loss");
        }
        return result;
      });
      expect(
        await f.learning.cancelReview(f.access.staff, packet, {
          verifyBeforeCommit: currentHuman,
        }),
      ).toMatchObject({ outcome: "cancelled" });
      const after = await f.support.rows();
      expect(after).toHaveLength(before.length + 2);
      expect(
        await f.learning.cancelReview(f.access.staff, packet, {
          verifyBeforeCommit: currentHuman,
        }),
      ).toMatchObject({ outcome: "cancelled" });
      expect(await f.support.rows()).toEqual(after);
      const row = after.find(
        (value) => value.id === `learning-command:${packet.commandId}`,
      );
      expect(Object.keys(row!).sort()).toEqual([
        "fingerprint",
        "id",
        "kind",
        "partition",
        "result",
      ]);
    });

    it("binds full policy timestamps, decision and actor even when a historical receipt exists", async () => {
      const f = await learningKbFixture(createStore());
      const packet = await prepared(f);
      await f.learning.submitReviewIntent(f.access.staff, packet);
      const before = await f.support.rows();
      const changedPolicy: LearningReviewCommand = {
        ...packet,
        intent: {
          ...packet.intent,
          policy: {
            ...packet.intent.policy,
            verifiedAt: new Date(
              Date.parse(packet.intent.policy.verifiedAt) - 1,
            ).toISOString(),
          },
        },
      };
      for (const changed of [
        changedPolicy,
        { ...packet, decision: "reject" as const },
      ]) {
        await expect(
          f.learning.readReviewReceipt(f.access.staff, changed),
        ).rejects.toThrow();
        await expect(
          f.learning.cancelReview(f.access.staff, changed, {
            verifyBeforeCommit: currentHuman,
          }),
        ).rejects.toThrow();
      }
      const extended = { ...packet, unexpected: "synthetic-untrusted-extra" };
      await expect(
        f.learning.readReviewReceipt(f.access.staff, extended),
      ).rejects.toThrow();
      const foreign: AccessContext = {
        ...f.access.staff,
        principalId: "synthetic-other-reviewer",
      };
      await expect(
        f.learning.readReviewReceipt(foreign, packet),
      ).rejects.toThrow();
      await expect(
        f.learning.cancelReview(foreign, packet, {
          verifyBeforeCommit: currentHuman,
        }),
      ).rejects.toThrow();
      expect(await f.support.rows()).toEqual(before);
    });

    it("rechecks current human authority before cancellation and withholds a committed result after authority loss", async () => {
      const f = await learningKbFixture(createStore());
      const packet = await prepared(f);
      const before = await f.support.rows();
      let current = false;
      const guard = async () => {
        if (!current) throw new Error("Synthetic human authority revoked");
      };
      await expect(
        f.learning.cancelReview(f.access.staff, packet, {
          verifyBeforeCommit: guard,
        }),
      ).rejects.toThrow();
      expect(await f.support.rows()).toEqual(before);
      current = true;
      f.support.observed.intercept(async (trace, commit) => {
        const result = await commit();
        if (result.committed && hasReceipt(trace, packet.commandId))
          current = false;
        return result;
      });
      await expect(
        f.learning.cancelReview(f.access.staff, packet, {
          verifyBeforeCommit: guard,
        }),
      ).rejects.toThrow();
      expect(
        await f.learning.readReviewReceipt(f.access.staff, packet),
      ).toMatchObject({ outcome: "cancelled" });
      expect(await f.support.rows()).toHaveLength(before.length + 2);
    });

    it("keeps missing human grants and exhausted ticket capacity fail closed without pretending cancellation", async () => {
      const f = await learningKbFixture(createStore());
      const packet = await prepared(f);
      const before = await f.support.rows();
      const denied = {
        ...f.access.staff,
        permissions: f.access.staff.permissions.filter(
          (p) => p !== supportPermissions.learningReview,
        ),
      };
      await expect(
        f.learning.prepareReviewIntent(denied, {
          ticketId: packet.intent.ticketId,
          sourceGeneration: packet.intent.sourceGeneration,
        }),
      ).rejects.toThrow();
      await expect(
        f.learning.cancelReview(denied, packet, {
          verifyBeforeCommit: currentHuman,
        }),
      ).rejects.toThrow();
      await expect(
        f.learning.readReviewReceipt(denied, packet),
      ).rejects.toThrow();
      const app = createSupportDeskApplication({
        store: f.support.store,
        clock: f.support.clock,
        limits: { maxRecordsPerTicket: before.length },
        resolutionLearning: f.support.learningOptions,
      });
      const intent = packet.intent;
      const legacy: ReviewResolutionLearningProposalCommand = {
        ticketId: intent.ticketId,
        sourceGeneration: intent.sourceGeneration,
        expectedWorkGeneration: intent.expectedWorkGeneration,
        target: intent.target,
        policyVersion: intent.policy.version,
        commandId: "CAPACITY-CANCEL",
        correlationId: packet.correlationId,
        decision: packet.decision,
      };
      await expect(
        app.cancelResolutionLearningReview(
          f.access.staff,
          legacy,
          currentHuman,
        ),
      ).rejects.toThrow();
      expect(
        await app.readResolutionLearningReviewReceipt(f.access.staff, legacy),
      ).toBeNull();
      expect(await f.support.rows()).toEqual(before);
    });

    it.each(["accepted", "cancelled"] as const)(
      "recovers the %s winner under a lowered capacity without new rows and still denies a deleted ticket",
      async (winner) => {
        const f = await learningKbFixture(createStore());
        const packet = await prepared(f);
        const intent = packet.intent;
        const command: ReviewResolutionLearningProposalCommand = {
          ticketId: intent.ticketId,
          sourceGeneration: intent.sourceGeneration,
          expectedWorkGeneration: intent.expectedWorkGeneration,
          target: intent.target,
          policyVersion: intent.policy.version,
          commandId: `LOWER-CAPACITY-${winner}`,
          correlationId: packet.correlationId,
          decision: packet.decision,
        };
        if (winner === "accepted")
          await f.learning.reviewProposal(f.access.staff, command);
        else
          await f.support.app.cancelResolutionLearningReview(
            f.access.staff,
            command,
            currentHuman,
          );
        const receipt = await f.support.app.readResolutionLearningReviewReceipt(
          f.access.staff,
          command,
        );
        expect(receipt).toMatchObject({ outcome: winner });
        const before = await f.support.rows();
        const transactions = f.support.observed.transactions.length;
        // Existing rows exceed this new configuration. A receipt replay must
        // not enter the full partition load or admit another mutation.
        const app = createSupportDeskApplication({
          store: f.support.store,
          clock: f.support.clock,
          limits: { maxRecordsPerTicket: before.length - 1 },
          resolutionLearning: f.support.learningOptions,
        });
        let guardCalls = 0;
        let current = true;
        const guard = async () => {
          guardCalls += 1;
          if (!current) throw new Error("Synthetic human authority revoked");
        };
        expect(
          await app.cancelResolutionLearningReview(
            f.access.staff,
            command,
            guard,
          ),
        ).toEqual(receipt);
        expect(guardCalls).toBe(1);
        expect(await f.support.rows()).toEqual(before);
        expect(f.support.observed.transactions).toHaveLength(transactions);
        current = false;
        await expect(
          app.cancelResolutionLearningReview(f.access.staff, command, guard),
        ).rejects.toThrow("human authority revoked");
        expect(await f.support.rows()).toEqual(before);
        const fresh = { ...command, commandId: "NEW-CANCELLATION-AT-CAPACITY" };
        await expect(
          app.cancelResolutionLearningReview(
            f.access.staff,
            fresh,
            currentHuman,
          ),
        ).rejects.toThrow();
        expect(
          await app.readResolutionLearningReviewReceipt(f.access.staff, fresh),
        ).toBeNull();
        expect(await f.support.rows()).toEqual(before);
        expect(f.support.observed.transactions).toHaveLength(transactions);
        // Respect withdrawal-before-deletion ordering. A retained receipt is
        // not permission to recover a private resource that no longer exists.
        await f.support.app.withdrawResolutionLearningSource(f.access.staff, {
          ...f.support.command("withdraw-before-delete"),
          reason: "privacy_withdrawal",
        });
        await f.deleteTicketBody();
        const deleted = await f.support.rows();
        const afterDeletionTransactions =
          f.support.observed.transactions.length;
        current = true;
        const beforeDeniedGuard = guardCalls;
        await expect(
          app.cancelResolutionLearningReview(f.access.staff, command, guard),
        ).rejects.toThrow();
        expect(guardCalls).toBe(beforeDeniedGuard);
        expect(await f.support.rows()).toEqual(deleted);
        expect(f.support.observed.transactions).toHaveLength(
          afterDeletionTransactions,
        );
      },
    );

    it("retains legacy full-command review and receipt recovery after reopening with the original generic layout", async () => {
      const f = await learningKbFixture(createStore());
      const packet = await prepared(f);
      const intent = packet.intent;
      const legacy: ReviewResolutionLearningProposalCommand = {
        ticketId: intent.ticketId,
        sourceGeneration: intent.sourceGeneration,
        expectedWorkGeneration: intent.expectedWorkGeneration,
        target: intent.target,
        policyVersion: intent.policy.version,
        commandId: "LEGACY-COMMAND",
        correlationId: packet.correlationId,
        decision: packet.decision,
      };
      const accepted = await f.learning.reviewProposal(f.access.staff, legacy);
      await f.support.app.reopenTicket(
        f.access.staff,
        f.support.command("reopen-legacy"),
      );
      const before = await f.support.rows();
      expect(await f.learning.reviewProposal(f.access.staff, legacy)).toEqual(
        accepted,
      );
      expect(
        await f.support.app.readResolutionLearningReviewReceipt(
          f.access.staff,
          legacy,
        ),
      ).toEqual({ outcome: "accepted", result: accepted });
      expect(await f.support.rows()).toEqual(before);
      const stored = before.find(
        (row) => row.id === `learning-command:${legacy.commandId}`,
      );
      expect(Object.keys(stored!).sort()).toEqual([
        "fingerprint",
        "id",
        "kind",
        "partition",
        "result",
      ]);
    });
  });
}
