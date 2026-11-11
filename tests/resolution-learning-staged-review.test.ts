import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  supportRecords,
  supportPermissions,
  type ReviewResolutionLearningProposalCommand,
} from "@pegma/support-desk-application";
import {
  learningKbBarrier,
  learningKbFixture,
  learningKbStores,
} from "../test/resolution-learning-kb-fixtures.js";
import type { HandlingTransaction } from "../test/handling-fixtures.js";

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError("Fixture requires JSON data");
  return encoded;
}
const digest = (value: unknown) =>
  createHash("sha256").update(canonical(value)).digest("hex");
function hasReview(trace: HandlingTransaction): boolean {
  return trace.actions.some(
    (action) =>
      "value" in action &&
      typeof action.value === "object" &&
      action.value !== null &&
      "kind" in action.value &&
      action.value.kind === "resolution_learning_review",
  );
}
async function barrierReached(
  gate: ReturnType<typeof learningKbBarrier>,
  pending: Promise<unknown>,
) {
  await Promise.race([
    gate.reached,
    pending.then(
      () => {
        throw new Error("Operation settled before its real Store barrier");
      },
      (error: unknown) => {
        throw error;
      },
    ),
  ]);
}
for (const [name, createStore] of learningKbStores) {
  describe(`staged learning application review (${name})`, () => {
    async function fixture() {
      const f = await learningKbFixture(createStore());
      const key = await f.eligible("staff_verified_fix");
      await f.processToDraft(key);
      const { intent } = await f.learning.prepareReviewIntent(
        f.access.staff,
        key,
      );
      const command: ReviewResolutionLearningProposalCommand = {
        ticketId: intent.ticketId,
        sourceGeneration: intent.sourceGeneration,
        expectedWorkGeneration: intent.expectedWorkGeneration,
        target: intent.target,
        policyVersion: intent.policy.version,
        intentBinding: digest(intent),
        commandId: "EXACT-STAGED-REVIEW",
        correlationId: "synthetic-staged-review",
        decision: "approve",
        reason: "PRIVATE_STAGE_REASON",
      };
      const app = f.support.freshApplication({
        resolutionLearning: { stagedReviews: true },
      });
      const stage = app.stagedResolutionLearningReviews;
      if (stage === undefined)
        throw new Error("Explicit staged review capability is absent");
      const guard = async () => {
        const fresh = await f.learning.prepareReviewIntent(f.access.staff, key);
        expect(fresh.intent).toEqual(intent);
      };
      const claim = async (id: string, leaseMilliseconds = 20_000) => {
        const result = await stage.claim(f.access.staff, {
          ticketId: command.ticketId,
          commandId: command.commandId,
          workerId: "synthetic-review-worker",
          claimId: id,
          leaseMilliseconds,
        });
        if (result === null) throw new Error("Expected a real staged claim");
        return result;
      };
      const admit = () => stage.admit(f.access.staff, command, intent, guard);
      const prepare = async () => {
        await admit();
        const first = await claim("proof");
        await stage.prepare(
          f.access.staff,
          {
            fence: first.fence,
            proof: {
              binding: digest(intent),
              validUntil: intent.policy.validUntil,
            },
          },
          guard,
        );
        return claim("commit");
      };
      return { f, app, stage, intent, command, guard, claim, admit, prepare };
    }
    it("keeps staged review absent by default and requires explicit learning opt-in", async () => {
      const x = await fixture();
      expect(x.f.support.app.stagedResolutionLearningReviews).toBeUndefined();
      expect(
        x.f.support.freshApplication({
          resolutionLearning: { enabled: false, stagedReviews: true },
        }).stagedResolutionLearningReviews,
      ).toBeUndefined();
      expect(x.app.stagedResolutionLearningReviews).toBeDefined();
    });
    it("admits without approving and atomically completes with distinct admission and final Audit identities", async () => {
      const x = await fixture();
      const before = await x.f.support.rows();
      expect(await x.admit()).toMatchObject({
        outcome: "pending",
        phase: "proof",
        claimed: false,
      });
      const admitted = await x.f.support.rows();
      expect(admitted).toHaveLength(before.length + 2);
      expect(
        admitted.filter((row) => row.kind === "resolution_learning_review"),
      ).toEqual(
        before.filter((row) => row.kind === "resolution_learning_review"),
      );
      expect(
        admitted.filter(
          (row) =>
            row.kind === "audit" &&
            row.event.action === "support.learning.review_requested",
        ),
      ).toHaveLength(1);
      await x.admit();
      expect(await x.f.support.rows()).toEqual(admitted);
      const proof = await x.claim("proof");
      await x.stage.prepare(
        x.f.access.staff,
        {
          fence: proof.fence,
          proof: {
            binding: digest(x.intent),
            validUntil: x.intent.policy.validUntil,
          },
        },
        x.guard,
      );
      expect(
        await x.stage.readStatus(x.f.access.staff, x.command),
      ).toMatchObject({ outcome: "pending", phase: "commit", claimed: false });
      const owner = await x.claim("commit");
      expect(
        (await x.stage.complete(x.f.access.staff, owner.fence, x.guard))
          .outcome,
      ).toBe("accepted");
      const rows = await x.f.support.rows();
      const audit = rows.flatMap((row) =>
        row.kind === "audit" &&
        row.event.details?.commandId === x.command.commandId
          ? [row]
          : [],
      );
      expect(audit).toHaveLength(2);
      expect(new Set(audit.map((row) => row.id)).size).toBe(2);
      expect(audit.map((row) => row.event.id)).toEqual(
        expect.arrayContaining([
          x.command.commandId,
          String.fromCharCode(0) +
            `support.learning.review.requested:${x.command.commandId}`,
        ]),
      );
      expect(
        rows.find((row) => row.kind === "resolution_learning_review_attempt"),
      ).toMatchObject({ state: "accepted", completionRows: 0 });
      const committed = x.f.support.observed.transactions
        .filter(hasReview)
        .at(-1)!;
      const values = committed.actions.flatMap((action) =>
        "value" in action ? [action.value] : [],
      );
      for (const kind of [
        "ticket",
        "resolution_learning_source",
        "resolution_learning_work",
        "resolution_learning_review_attempt",
        "resolution_learning_review",
        "audit",
        "resolution_learning_receipt",
      ])
        expect(
          values.some(
            (value) =>
              typeof value === "object" &&
              value !== null &&
              "kind" in value &&
              value.kind === kind,
          ),
        ).toBe(true);
    });
    it.each(["decision", "reason", "target"] as const)(
      "refuses changed %s under the original canonical command",
      async (field) => {
        const x = await fixture();
        await x.admit();
        const before = await x.f.support.rows();
        const changed =
          field === "decision"
            ? { ...x.command, decision: "reject" as const }
            : field === "reason"
              ? { ...x.command, reason: "Different intent" }
              : {
                  ...x.command,
                  target: {
                    ...x.command.target,
                    articleRevision: x.command.target.articleRevision + 1,
                  },
                };
        await expect(
          x.stage.admit(x.f.access.staff, changed, x.intent, x.guard),
        ).rejects.toThrow();
        expect(await x.f.support.rows()).toEqual(before);
      },
    );
    it("binds claim and status to original actor and actual current named grants", async () => {
      const x = await fixture();
      await x.admit();
      const before = await x.f.support.rows();
      const other = {
        ...x.f.access.staff,
        principalId: "different-current-reviewer",
      };
      await expect(
        x.stage.claim(other, {
          ticketId: x.command.ticketId,
          commandId: x.command.commandId,
          workerId: "worker",
          claimId: "other",
          leaseMilliseconds: 1000,
        }),
      ).rejects.toThrow();
      await expect(x.stage.readStatus(other, x.command)).rejects.toThrow();
      const revoked = {
        ...x.f.access.staff,
        permissions: x.f.access.staff.permissions.filter(
          (name) => name !== supportPermissions.learningReview,
        ),
      };
      await expect(x.stage.readStatus(revoked, x.command)).rejects.toThrow();
      expect(await x.f.support.rows()).toEqual(before);
    });
    it("does not write P1 after a denied guard or expiry across the real awaited proof", async () => {
      const x = await fixture();
      await x.admit();
      const owner = await x.claim("proof");
      const before = await x.f.support.rows();
      const command = {
        fence: owner.fence,
        proof: {
          binding: digest(x.intent),
          validUntil: x.intent.policy.validUntil,
        },
      };
      await expect(
        x.stage.prepare(x.f.access.staff, command, async () => {
          throw new Error("Current proof denied");
        }),
      ).rejects.toThrow("Current proof denied");
      expect(await x.f.support.rows()).toEqual(before);
      await expect(
        x.stage.prepare(x.f.access.staff, command, async () => {
          await x.guard();
          x.f.support.advance(60_000);
        }),
      ).rejects.toThrow();
      expect(await x.f.support.rows()).toEqual(before);
    });
    it("runs the synchronous P2 assertion after final awaited proof and commits no review on denial", async () => {
      const x = await fixture();
      const owner = await x.prepare();
      const before = await x.f.support.rows();
      await expect(
        x.stage.complete(x.f.access.staff, owner.fence, async () => {
          await x.guard();
          return () => {
            throw new Error("Exact final authority changed");
          };
        }),
      ).rejects.toThrow("Exact final authority changed");
      expect(await x.f.support.rows()).toEqual(before);
    });
    it("fences a genuinely suspended transaction after opaque-version lease reclaim with one attempt", async () => {
      const x = await fixture();
      const owner = await x.prepare();
      const gate = learningKbBarrier();
      let observed = 0;
      x.f.support.observed.intercept(async (trace, commit) => {
        if (hasReview(trace) && observed++ === 0) await gate.wait();
        return commit();
      });
      const old = x.stage.complete(x.f.access.staff, owner.fence, x.guard);
      try {
        await barrierReached(gate, old);
        x.f.support.advance(20_001);
        const next = await x.claim("new-physical-invocation");
        expect(next.fence.claimGeneration).toBe(
          owner.fence.claimGeneration + 1,
        );
        gate.release();
        await expect(old).rejects.toThrow();
        expect(observed).toBe(1);
        expect(
          await x.app.readResolutionLearningReviewReceipt(
            x.f.access.staff,
            x.command,
          ),
        ).toBeNull();
        expect(
          (await x.stage.complete(x.f.access.staff, next.fence, x.guard))
            .outcome,
        ).toBe("accepted");
      } finally {
        gate.release();
        await old.catch(() => {});
        x.f.support.observed.intercept(undefined);
      }
    });
    it("lets cancellation beat suspended P2 and recovers before expired lease and lower capacity", async () => {
      const x = await fixture();
      const owner = await x.prepare();
      const gate = learningKbBarrier();
      let first = true;
      x.f.support.observed.intercept(async (trace, commit) => {
        if (hasReview(trace) && first) {
          first = false;
          await gate.wait();
        }
        return commit();
      });
      const old = x.stage.complete(x.f.access.staff, owner.fence, x.guard);
      try {
        await barrierReached(gate, old);
        expect(
          (await x.stage.cancel(x.f.access.staff, x.command, async () => {}))
            .outcome,
        ).toBe("cancelled");
        gate.release();
        await expect(old).rejects.toThrow();
        const rows = await x.f.support.rows();
        x.f.support.advance(60_000);
        const stage = x.f.support.freshApplication({
          limits: { maxRecordsPerTicket: rows.length - 1 },
          resolutionLearning: { stagedReviews: true },
        }).stagedResolutionLearningReviews!;
        let called = 0;
        expect(
          (
            await stage.complete(x.f.access.staff, owner.fence, async () => {
              called++;
            })
          ).outcome,
        ).toBe("cancelled");
        expect(called).toBe(0);
        expect(await x.f.support.rows()).toEqual(rows);
      } finally {
        gate.release();
        await old.catch(() => {});
        x.f.support.observed.intercept(undefined);
      }
    });
    it("recovers a genuinely committed P2 with lost ACK under lower capacity without repeating proof", async () => {
      const x = await fixture();
      const owner = await x.prepare();
      let lost = true;
      x.f.support.observed.intercept(async (trace, commit) => {
        const result = await commit();
        if (hasReview(trace) && result.committed && lost) {
          lost = false;
          throw new Error("Actual accepted ACK lost");
        }
        return result;
      });
      await expect(
        x.stage.complete(x.f.access.staff, owner.fence, x.guard),
      ).rejects.toThrow("Actual accepted ACK lost");
      x.f.support.observed.intercept(undefined);
      const before = await x.f.support.rows();
      x.f.support.advance(60_000);
      const stage = x.f.support.freshApplication({
        limits: { maxRecordsPerTicket: before.length - 1 },
        resolutionLearning: { stagedReviews: true },
      }).stagedResolutionLearningReviews!;
      let calls = 0;
      expect(
        (
          await stage.complete(x.f.access.staff, owner.fence, async () => {
            calls++;
            throw new Error("Old proof must not run");
          })
        ).outcome,
      ).toBe("accepted");
      expect(calls).toBe(0);
      expect(await stage.readStatus(x.f.access.staff, x.command)).toMatchObject(
        { outcome: "accepted" },
      );
      expect(await x.f.support.rows()).toEqual(before);
    });
    it.each(["accepted", "cancelled"] as const)(
      "recovers a %s receipt from the original fence after privacy scrubs command reason",
      async (winner) => {
        const x = await fixture();
        const owner = await x.prepare();
        if (winner === "accepted")
          await x.stage.complete(x.f.access.staff, owner.fence, x.guard);
        else await x.stage.cancel(x.f.access.staff, x.command, async () => {});
        await x.app.withdrawResolutionLearningSource(x.f.access.staff, {
          ...x.f.support.command(
            "terminal-private-withdrawal",
            x.command.ticketId,
          ),
          reason: "privacy_withdrawal",
        });
        const before = await x.f.support.rows();
        expect(
          JSON.stringify(
            before.filter(
              (row) => row.kind === "resolution_learning_review_attempt",
            ),
          ),
        ).not.toContain("PRIVATE_STAGE_REASON");
        let called = 0;
        expect(
          (
            await x.stage.complete(x.f.access.staff, owner.fence, async () => {
              called++;
              throw new Error("Historical proof must not run");
            })
          ).outcome,
        ).toBe(winner);
        expect(called).toBe(0);
        expect(await x.f.support.rows()).toEqual(before);
      },
    );
    it.each(["review", "cancel"] as const)(
      "terminalizes a staged attempt when legacy %s wins and releases its reserve",
      async (winner) => {
        const x = await fixture();
        await x.admit();
        if (winner === "review")
          await x.app.reviewResolutionLearningProposal(
            x.f.access.staff,
            x.command,
            x.guard,
          );
        else
          await x.app.cancelResolutionLearningReview(
            x.f.access.staff,
            x.command,
            async () => {},
          );
        expect(
          (await x.f.support.rows()).find(
            (row) => row.kind === "resolution_learning_review_attempt",
          ),
        ).toMatchObject({
          state: winner === "review" ? "accepted" : "cancelled",
          completionRows: 0,
        });
        expect(
          await x.stage.readPending(x.f.access.service, {
            ticketId: x.command.ticketId,
            commandId: x.command.commandId,
          }),
        ).toBeNull();
        expect(
          (await x.stage.readStatus(x.f.access.staff, x.command))?.outcome,
        ).toBe(winner === "review" ? "accepted" : "cancelled");
      },
    );
    it("scrubs pending private reason and claims on withdrawal while retaining exact cancel ownership", async () => {
      const x = await fixture();
      await x.admit();
      const owner = await x.claim("proof");
      await x.app.withdrawResolutionLearningSource(x.f.access.staff, {
        ...x.f.support.command("withdraw-private", x.command.ticketId),
        reason: "privacy_withdrawal",
      });
      const row = (await x.f.support.rows()).find(
        (row) => row.kind === "resolution_learning_review_attempt",
      );
      expect(row).toMatchObject({ state: "held", completionRows: 3 });
      expect(JSON.stringify(row)).not.toContain("PRIVATE_STAGE_REASON");
      expect(row).not.toHaveProperty("claim");
      expect(row).not.toHaveProperty("leaseUntil");
      await expect(
        x.stage.prepare(
          x.f.access.staff,
          {
            fence: owner.fence,
            proof: {
              binding: digest(x.intent),
              validUntil: x.intent.policy.validUntil,
            },
          },
          x.guard,
        ),
      ).rejects.toThrow();
      expect(
        (await x.stage.cancel(x.f.access.staff, x.command, async () => {}))
          .outcome,
      ).toBe("cancelled");
    });
    it("bounds all retained attempts including cancelled rows and preserves one-transaction privacy scrub", async () => {
      const x = await fixture();
      const app = x.f.support.freshApplication({
        resolutionLearning: {
          stagedReviews: true,
          maxStagedReviewAttempts: 24,
        },
      });
      const stage = app.stagedResolutionLearningReviews!;
      for (const id of Array.from(
        { length: 24 },
        (_, index) => `retained-${index}`,
      )) {
        const command = { ...x.command, commandId: id };
        await stage.admit(x.f.access.staff, command, x.intent, x.guard);
        expect(
          (await stage.cancel(x.f.access.staff, command, async () => {}))
            .outcome,
        ).toBe("cancelled");
      }
      const before = await x.f.support.rows();
      await expect(
        stage.admit(
          x.f.access.staff,
          { ...x.command, commandId: "twenty-fifth-refused" },
          x.intent,
          x.guard,
        ),
      ).rejects.toThrow();
      expect(await x.f.support.rows()).toEqual(before);
      await app.withdrawResolutionLearningSource(x.f.access.staff, {
        ...x.f.support.command("bounded-withdrawal", x.command.ticketId),
        reason: "privacy_withdrawal",
      });
      const after = await x.f.support.rows();
      expect(
        after.filter(
          (row) => row.kind === "resolution_learning_review_attempt",
        ),
      ).toHaveLength(24);
      for (const row of after.filter(
        (row) => row.kind === "resolution_learning_review_attempt",
      ))
        expect(JSON.stringify(row)).not.toContain("PRIVATE_STAGE_REASON");
      expect(
        x.f.support.observed.transactions.at(-1)!.actions.length,
      ).toBeLessThanOrEqual(100);
    });
    it("counts every physical scan row and never turns a dispatch hint into customer authority", async () => {
      const x = await fixture();
      await x.admit();
      let cursor: string | undefined;
      let physical = 0;
      const keys: string[] = [];
      do {
        const page = await x.stage.scanPending(x.f.access.service, {
          limit: 1,
          ...(cursor === undefined ? {} : { cursor }),
        });
        expect(page.pages).toBe(1);
        expect(page.physicalRows).toBeLessThanOrEqual(1);
        physical += page.physicalRows;
        keys.push(...page.candidates.map((value) => value.commandId));
        cursor = page.nextCursor ?? undefined;
      } while (cursor !== undefined);
      expect(physical).toBeGreaterThan(1);
      expect(keys).toEqual([x.command.commandId]);
      await expect(
        x.stage.scanPending(x.f.access.supportCustomer, { limit: 1 }),
      ).rejects.toThrow();
      await expect(
        x.stage.readPending(x.f.access.supportCustomer, {
          ticketId: x.command.ticketId,
          commandId: x.command.commandId,
        }),
      ).rejects.toThrow();
    });
    it("rejects a copied attempt at another real Store key and accepts maximum escaped claim identifiers", async () => {
      const x = await fixture();
      await x.admit();
      const row = (await x.f.support.rows()).find(
        (row) => row.kind === "resolution_learning_review_attempt",
      );
      if (row?.kind !== "resolution_learning_review_attempt")
        throw new Error("Missing real attempt");
      await expect(
        x.f.support.store.collection(supportRecords).insertIfAbsent({
          ...row,
          partition: "other-ticket",
          ticketId: "other-ticket",
        }),
      ).rejects.toThrow();
      const owner = await x.stage.claim(x.f.access.staff, {
        ticketId: x.command.ticketId,
        commandId: x.command.commandId,
        workerId: String.fromCharCode(0xd800).repeat(200),
        claimId: String.fromCharCode(0xd800).repeat(200),
        leaseMilliseconds: 1000,
      });
      expect(owner?.fence.workerId).toHaveLength(200);
    });
  });
}
