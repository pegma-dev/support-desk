import { hasPermission, type AccessContext } from "@pegma/authorization-core";
import { knowledgePermissions } from "@pegma/knowledge-base-contracts";
import {
  SupportDeskAuthorizationError,
  supportPermissions,
  type ResolutionLearningStagedReviewApplication,
} from "@pegma/support-desk-application";
import {
  createSupportDeskLearning,
  createSupportDeskStagedLearningReviews,
  createSupportDeskLearningSourceVerifier,
  type LearningReviewCommand,
  type SupportDeskLearningOptions,
  type SupportDeskStagedLearningReviewOptions,
} from "@pegma/support-desk-ai";
import { describe, expect, it, vi } from "vitest";
import {
  learningKbBarrier,
  learningKbFixture,
  learningKbStores,
} from "../test/resolution-learning-kb-fixtures.js";

async function fixture(store: Parameters<typeof learningKbFixture>[0]) {
  const f = await learningKbFixture(store);
  const app = f.support.freshApplication({
    resolutionLearning: { stagedReviews: true },
  });
  let current: AccessContext | null = f.access.staff;
  const resolveActor = vi.fn<
    SupportDeskStagedLearningReviewOptions["resolveActor"]
  >(async ({ principalId }) =>
    current !== null && current.principalId === principalId
      ? structuredClone(current)
      : null,
  );
  const sources = createSupportDeskLearningSourceVerifier({
    application: app,
    serviceAccess: { resolve: f.ports.resolveService },
    reviewPolicy: f.checks,
    otherSources: f.otherSources,
    clock: f.support.clock,
    readScheduling: "sdk",
  });
  const options: SupportDeskStagedLearningReviewOptions = {
    application: app,
    knowledge: f.ports.knowledge,
    sources,
    checks: f.checks,
    serviceAccess: { resolve: f.ports.resolveService },
    clock: f.support.clock,
    resolveActor,
    readScheduling: "sdk",
  };
  const staged = createSupportDeskStagedLearningReviews(options);
  const human = async () => {
    if (current === null)
      throw new SupportDeskAuthorizationError(
        supportPermissions.learningReview,
      );
    for (const grant of [
      supportPermissions.learningReview,
      supportPermissions.queueRead,
    ])
      if (!hasPermission(current, grant))
        throw new SupportDeskAuthorizationError(grant);
  };
  const admission = async () => {
    await human();
    for (const grant of [
      knowledgePermissions.draftRead,
      knowledgePermissions.provenanceRead,
    ])
      if (current === null || !hasPermission(current, grant))
        throw new SupportDeskAuthorizationError(grant);
  };
  async function packet(): Promise<LearningReviewCommand> {
    const key = await f.eligible("staff_verified_fix");
    await f.processToDraft(key);
    const value = await f.learning.prepareReviewIntent(f.access.staff, key);
    return {
      intent: value.intent,
      commandId: "EXACT-STAGED-Review-A",
      correlationId: "staged-review-fixture",
      decision: "approve",
    };
  }
  const process = (
    command: LearningReviewCommand,
    workerId = "staged-worker-A",
  ) =>
    staged.processReview({
      ticketId: command.intent.ticketId,
      commandId: command.commandId,
      workerId,
      leaseMilliseconds: 30_000,
    });
  return {
    ...f,
    app,
    sources,
    staged,
    options,
    resolveActor,
    human,
    admission,
    packet,
    process,
    setActor(value: AccessContext | null) {
      current = value;
    },
    revoke(grant: string) {
      current = {
        ...f.access.staff,
        permissions: f.access.staff.permissions.filter(
          (value) => value !== grant,
        ),
      };
    },
  };
}
function reviews(
  rows: Awaited<
    ReturnType<Awaited<ReturnType<typeof fixture>>["support"]["rows"]>
  >,
) {
  return rows.filter((row) => row.kind === "resolution_learning_review");
}
async function gateReached(
  gate: ReturnType<typeof learningKbBarrier>,
  operation: Promise<unknown>,
) {
  await Promise.race([
    gate.reached,
    operation.then(() => {
      throw new Error("Review ended before the real read barrier");
    }),
  ]);
}

for (const [name, store] of learningKbStores)
  describe(`staged learning AI (${name})`, () => {
    it("is additive/default-off and requires the real application capability", async () => {
      const f = await fixture(store());
      expect(f.support.app.stagedResolutionLearningReviews).toBeUndefined();
      expect(() =>
        createSupportDeskStagedLearningReviews({
          ...f.options,
          application: f.support.app,
        }),
      ).toThrow(TypeError);
      expect(f.app.stagedResolutionLearningReviews).toBeDefined();
    });

    it("validates runtime read scheduling consistently across all learning factories", async () => {
      const f = await fixture(store());
      const inline: SupportDeskLearningOptions = {
        ...f.options,
        knowledgeAccess: { resolve: f.ports.resolveKnowledge },
        retirementAccess: { resolve: f.ports.resolveRetirement },
        configuration: { resolve: f.ports.resolveConfiguration },
        model: { generate: f.ports.generate },
        usage: { reserve: f.ports.reserve, reconcile: f.ports.reconcileUsage },
        tokenCounter: {
          count: (text) => new TextEncoder().encode(text).byteLength,
        },
        targets: { resolveScope: f.ports.resolveScope, select: f.ports.select },
      };
      const sourceOptions = {
        application: f.app,
        serviceAccess: f.options.serviceAccess,
        reviewPolicy: f.checks,
        clock: f.support.clock,
      };
      for (const value of ["SDK", "serial", null, false, 0, {}, []]) {
        expect(() =>
          Reflect.apply(createSupportDeskLearning, undefined, [
            { ...inline, readScheduling: value },
          ]),
        ).toThrow("Unknown learning read scheduling");
        expect(() =>
          Reflect.apply(createSupportDeskStagedLearningReviews, undefined, [
            { ...f.options, readScheduling: value },
          ]),
        ).toThrow("Unknown learning read scheduling");
        expect(() =>
          Reflect.apply(createSupportDeskLearningSourceVerifier, undefined, [
            { ...sourceOptions, readScheduling: value },
          ]),
        ).toThrow("Unknown learning read scheduling");
      }
      for (const value of [undefined, "sdk"]) {
        expect(
          Reflect.apply(createSupportDeskLearning, undefined, [
            { ...inline, readScheduling: value },
          ]),
        ).toHaveProperty("submitReviewIntent");
        expect(
          Reflect.apply(createSupportDeskStagedLearningReviews, undefined, [
            { ...f.options, readScheduling: value },
          ]),
        ).toHaveProperty("processReview");
        expect(
          Reflect.apply(createSupportDeskLearningSourceVerifier, undefined, [
            { ...sourceOptions, readScheduling: value },
          ]),
        ).toHaveProperty("isCurrent");
      }
    });

    it("durably admits exact intent, then requires two distinct worker invocations and independent complete proofs", async () => {
      const f = await fixture(store());
      const packet = await f.packet();
      const beforeKnowledge = f.ports.knowledgeCalls.length;
      const models = f.ports.generate.mock.calls.length;
      const admitted = await f.staged.admitReviewIntent(
        f.access.staff,
        packet,
        { verifyBeforeCommit: f.admission },
      );
      expect(admitted).toMatchObject({ outcome: "pending", phase: "proof" });
      expect(f.ports.knowledgeCalls).toHaveLength(beforeKnowledge);
      expect(
        await f.staged.admitReviewIntent(f.access.staff, packet, {
          verifyBeforeCommit: f.admission,
        }),
      ).toEqual(admitted);
      expect(reviews(await f.support.rows())).toHaveLength(0);
      const scanned = await f.staged.scanPending({ limit: 100 });
      expect(scanned.candidates).toContainEqual(
        expect.objectContaining({
          reviewerId: f.access.staff.principalId,
          commandId: packet.commandId,
        }),
      );
      expect(scanned.physicalRows).toBeGreaterThanOrEqual(
        scanned.candidates.length,
      );
      expect(scanned.pages).toBe(1);
      const first = await f.process(packet);
      expect(first).toMatchObject({
        outcome: "prepared",
        status: { outcome: "pending", phase: "commit" },
      });
      const afterP1 = f.ports.knowledgeCalls.length;
      expect(afterP1).toBeGreaterThan(beforeKnowledge);
      expect(reviews(await f.support.rows())).toHaveLength(0);
      const second = await f.process(packet);
      expect(second).toMatchObject({
        outcome: "completed",
        receipt: { outcome: "accepted" },
      });
      expect(f.ports.knowledgeCalls.length).toBeGreaterThan(afterP1);
      expect(reviews(await f.support.rows())).toHaveLength(1);
      expect(f.ports.generate).toHaveBeenCalledTimes(models);
      expect(
        f.ports.knowledgeCalls
          .slice(beforeKnowledge)
          .every((call) =>
            ["getDraft", "getProvenance"].includes(call.operation),
          ),
      ).toBe(true);
      expect(
        f.resolveActor.mock.calls.every(
          ([value]) => value.principalId === packet.intent.reviewerId,
        ),
      ).toBe(true);
      expect(await f.process(packet)).toEqual({ outcome: "not_pending" });
    });

    it.each([
      supportPermissions.learningReview,
      supportPermissions.queueRead,
      knowledgePermissions.draftRead,
      knowledgePermissions.provenanceRead,
    ])(
      "cannot complete when the original human loses %s between phases",
      async (permission) => {
        const f = await fixture(store());
        const packet = await f.packet();
        await f.staged.admitReviewIntent(f.access.staff, packet, {
          verifyBeforeCommit: f.admission,
        });
        expect(await f.process(packet)).toMatchObject({ outcome: "prepared" });
        f.revoke(permission);
        expect(await f.process(packet)).toMatchObject({
          outcome: expect.stringMatching(/^(held|pending)$/),
        });
        expect(reviews(await f.support.rows())).toHaveLength(0);
        expect(
          await f.learning.readReviewReceipt(f.access.staff, packet),
        ).toBeNull();
      },
    );

    it("re-resolves the original actor and refuses a service or different human substitution", async () => {
      const f = await fixture(store());
      const packet = await f.packet();
      await f.staged.admitReviewIntent(f.access.staff, packet, {
        verifyBeforeCommit: f.admission,
      });
      f.resolveActor.mockResolvedValue({
        ...f.access.staff,
        principalId: f.access.service.principalId,
      });
      const before = await f.support.rows();
      expect(await f.process(packet)).toMatchObject({
        outcome: "pending",
        phase: "dispatch",
        reason: "authority_unavailable",
      });
      expect(await f.support.rows()).toEqual(before);
      expect(reviews(await f.support.rows())).toHaveLength(0);
    });

    it.each(["dispatch read", "actor resolver"] as const)(
      "retains dispatch-pending ownership through a transient %s failure",
      async (failure) => {
        const f = await fixture(store());
        const packet = await f.packet();
        await f.staged.admitReviewIntent(f.access.staff, packet, {
          verifyBeforeCommit: f.admission,
        });
        const capability = f.app.stagedResolutionLearningReviews;
        if (capability === undefined)
          throw new Error("Missing actual staged capability");
        const fault: ResolutionLearningStagedReviewApplication = {
          ...capability,
          async readPending(...args) {
            const value = await capability.readPending(...args);
            if (failure === "dispatch read")
              throw new Error("Transient dispatch response loss");
            return value;
          },
        };
        if (failure === "actor resolver")
          f.resolveActor.mockRejectedValueOnce(
            new Error("Transient current-actor resolution failure"),
          );
        const worker = createSupportDeskStagedLearningReviews({
          ...f.options,
          application: { ...f.app, stagedResolutionLearningReviews: fault },
        });
        const before = await f.support.rows();
        expect(
          await worker.processReview({
            ticketId: packet.intent.ticketId,
            commandId: packet.commandId,
            workerId: "retry-dispatch",
            leaseMilliseconds: 30_000,
          }),
        ).toEqual({
          outcome: "pending",
          phase: "dispatch",
          reason: "review_unavailable",
        });
        expect(await f.support.rows()).toEqual(before);
        expect(
          await f.staged.readReviewStatus(f.access.staff, packet),
        ).toMatchObject({
          outcome: "pending",
          phase: "proof",
          claimed: false,
          held: false,
        });
        expect(await f.process(packet)).toMatchObject({ outcome: "prepared" });
      },
    );

    it("preserves actual authorization failure diagnostics before a claim", async () => {
      const f = await fixture(store());
      const packet = await f.packet();
      await f.staged.admitReviewIntent(f.access.staff, packet, {
        verifyBeforeCommit: f.admission,
      });
      f.revoke(supportPermissions.queueRead);
      const before = await f.support.rows();
      expect(await f.process(packet)).toEqual({
        outcome: "pending",
        phase: "dispatch",
        reason: "authorization_unavailable",
      });
      expect(await f.support.rows()).toEqual(before);
      expect(reviews(await f.support.rows())).toHaveLength(0);
    });

    it("reports a real privacy-withdrawal hold from authoritative dispatch metadata", async () => {
      const f = await fixture(store());
      const packet = await f.packet();
      await f.staged.admitReviewIntent(f.access.staff, packet, {
        verifyBeforeCommit: f.admission,
      });
      await f.app.withdrawResolutionLearningSource(f.access.staff, {
        ...f.support.command("privacy-hold"),
        reason: "privacy_withdrawal",
      });
      const before = await f.support.rows();
      expect(await f.process(packet)).toEqual({
        outcome: "held",
        reason: "review_held",
      });
      expect(await f.support.rows()).toEqual(before);
      expect(f.resolveActor).not.toHaveBeenCalled();
      expect(reviews(await f.support.rows())).toHaveLength(0);
    });

    it("rechecks every live proof after P1 rather than trusting its retained digest", async () => {
      const f = await fixture(store());
      const packet = await f.packet();
      await f.staged.admitReviewIntent(f.access.staff, packet, {
        verifyBeforeCommit: f.admission,
      });
      expect(await f.process(packet)).toMatchObject({ outcome: "prepared" });
      const draft = await f.kb.getDraft(f.access.draftService, {
        articleId: packet.intent.target.articleId,
      });
      await f.kb.updateDraft(f.access.draftService, {
        ...f.command("edit-between-phases", draft.generation),
        articleId: draft.articleId,
        collectionId: draft.revision.collectionId,
        draft: {
          kind: draft.revision.kind,
          title: "A newer draft",
          summary: draft.revision.summary,
          content: draft.revision.content,
          tags: draft.revision.tags,
          applicability: draft.revision.applicability,
        },
      });
      expect(await f.process(packet)).toMatchObject({
        outcome: "pending",
        phase: "commit",
        reason: "target_changed",
      });
      expect(reviews(await f.support.rows())).toHaveLength(0);
    });

    it("cancellation and an already-running P2 contend on the real canonical receipt", async () => {
      const f = await fixture(store());
      const packet = await f.packet();
      await f.staged.admitReviewIntent(f.access.staff, packet, {
        verifyBeforeCommit: f.admission,
      });
      expect(await f.process(packet)).toMatchObject({ outcome: "prepared" });
      const gate = learningKbBarrier();
      let paused = false;
      f.interceptKnowledge(async (call, invoke) => {
        const value = await invoke();
        if (call.operation === "getDraft" && !paused) {
          paused = true;
          await gate.wait();
        }
        return value;
      });
      const pending = f.process(packet);
      let cancelled;
      try {
        await gateReached(gate, pending);
        cancelled = await f.staged.cancelReview(f.access.staff, packet, {
          verifyBeforeCommit: f.human,
        });
        expect(cancelled).toMatchObject({ outcome: "cancelled" });
      } finally {
        gate.release();
        f.interceptKnowledge(undefined);
      }
      await pending;
      expect(await f.staged.readReviewStatus(f.access.staff, packet)).toEqual(
        cancelled,
      );
      expect(reviews(await f.support.rows())).toHaveLength(0);
    });

    it("returns a completed receipt when cancellation settles P1 before prepare", async () => {
      const f = await fixture(store());
      const packet = await f.packet();
      await f.staged.admitReviewIntent(f.access.staff, packet, {
        verifyBeforeCommit: f.admission,
      });
      const gate = learningKbBarrier();
      let drafts = 0;
      f.interceptKnowledge(async (call, invoke) => {
        const result = await invoke();
        if (call.operation === "getDraft" && ++drafts === 3) await gate.wait();
        return result;
      });
      const pending = f.process(packet);
      let cancelled;
      let afterCancel: Awaited<ReturnType<typeof f.support.rows>> | undefined;
      try {
        await gateReached(gate, pending);
        cancelled = await f.staged.cancelReview(f.access.staff, packet, {
          verifyBeforeCommit: f.human,
        });
        expect(cancelled).toMatchObject({ outcome: "cancelled" });
        afterCancel = await f.support.rows();
      } finally {
        gate.release();
        f.interceptKnowledge(undefined);
      }
      expect(await pending).toEqual({
        outcome: "completed",
        receipt: cancelled,
      });
      expect(await f.support.rows()).toEqual(afterCancel);
      expect(reviews(await f.support.rows())).toHaveLength(0);
    });

    it("retains pending ownership when a real committed claim loses its ACK and resumes only in another invocation", async () => {
      const f = await fixture(store());
      const packet = await f.packet();
      await f.staged.admitReviewIntent(f.access.staff, packet, {
        verifyBeforeCommit: f.admission,
      });
      const capability = f.app.stagedResolutionLearningReviews;
      if (capability === undefined)
        throw new Error("Missing actual staged capability");
      let claims = 0;
      const dropped: ResolutionLearningStagedReviewApplication = {
        ...capability,
        async claim(...args) {
          claims += 1;
          const result = await capability.claim(...args);
          expect(result).not.toBeNull();
          throw new Error("Lost actual committed claim ACK");
        },
      };
      const worker = createSupportDeskStagedLearningReviews({
        ...f.options,
        application: { ...f.app, stagedResolutionLearningReviews: dropped },
      });
      const calls = f.ports.knowledgeCalls.length;
      expect(
        await worker.processReview({
          ticketId: packet.intent.ticketId,
          commandId: packet.commandId,
          workerId: "lost-claim",
          leaseMilliseconds: 30_000,
        }),
      ).toMatchObject({ outcome: "pending", phase: "proof" });
      expect(claims).toBe(1);
      expect(f.ports.knowledgeCalls).toHaveLength(calls);
      expect(
        await f.staged.readReviewStatus(f.access.staff, packet),
      ).toMatchObject({ outcome: "pending", phase: "proof", claimed: true });
      expect(await f.process(packet)).toEqual({ outcome: "not_claimed" });
      expect(reviews(await f.support.rows())).toHaveLength(0);
      f.support.advance(30_001);
      expect(await f.process(packet)).toMatchObject({ outcome: "prepared" });
      expect(await f.process(packet)).toMatchObject({
        outcome: "completed",
        receipt: { outcome: "accepted" },
      });
      expect(reviews(await f.support.rows())).toHaveLength(1);
    });

    it("recovers a lost completed ACK before obsolete KB/source/policy proof and without further writes", async () => {
      const f = await fixture(store());
      const packet = await f.packet();
      await f.staged.admitReviewIntent(f.access.staff, packet, {
        verifyBeforeCommit: f.admission,
      });
      expect(await f.process(packet)).toMatchObject({ outcome: "prepared" });
      const capability = f.app.stagedResolutionLearningReviews;
      if (capability === undefined)
        throw new Error("Missing actual staged capability");
      const discard: ResolutionLearningStagedReviewApplication = {
        ...capability,
        async complete(...args) {
          await capability.complete(...args);
          throw new Error("Lost real committed response");
        },
      };
      const worker = createSupportDeskStagedLearningReviews({
        ...f.options,
        application: { ...f.app, stagedResolutionLearningReviews: discard },
      });
      expect(
        await worker.processReview({
          ticketId: packet.intent.ticketId,
          commandId: packet.commandId,
          workerId: "lost-ack",
          leaseMilliseconds: 30_000,
        }),
      ).toMatchObject({ outcome: "pending", phase: "commit" });
      expect(reviews(await f.support.rows())).toHaveLength(1);
      await f.support.app.reopenTicket(
        f.access.staff,
        f.support.command("reopen"),
      );
      const recoveryAccess: AccessContext = {
        ...f.access.staff,
        permissions: f.access.staff.permissions.filter(
          (permission) =>
            permission !== knowledgePermissions.draftRead &&
            permission !== knowledgePermissions.provenanceRead,
        ),
      };
      f.setActor(recoveryAccess);
      f.state.policyOutcome = "unavailable";
      f.interceptKnowledge(async () => {
        throw new Error("Terminal recovery must precede obsolete KB proof");
      });
      const rows = await f.support.rows();
      const calls = f.ports.knowledgeCalls.length;
      const accepted = await f.staged.readReviewStatus(recoveryAccess, packet);
      expect(accepted).toMatchObject({ outcome: "accepted" });
      expect(
        await f.staged.admitReviewIntent(recoveryAccess, packet, {
          verifyBeforeCommit: f.admission,
        }),
      ).toEqual(accepted);
      expect(
        await f.staged.cancelReview(recoveryAccess, packet, {
          verifyBeforeCommit: f.human,
        }),
      ).toEqual(accepted);
      expect(await f.support.rows()).toEqual(rows);
      expect(f.ports.knowledgeCalls).toHaveLength(calls);
    });

    it("keeps changed payload under the same command identity conflicting", async () => {
      const f = await fixture(store());
      const packet = await f.packet();
      await f.staged.admitReviewIntent(f.access.staff, packet, {
        verifyBeforeCommit: f.admission,
      });
      const rows = await f.support.rows();
      await expect(
        f.staged.admitReviewIntent(
          f.access.staff,
          { ...packet, decision: "reject" },
          { verifyBeforeCommit: f.admission },
        ),
      ).rejects.toThrow();
      expect(await f.support.rows()).toEqual(rows);
    });

    it.each(["proof", "commit"] as const)(
      "rejects changed source-read authority at the final %s draft handoff",
      async (phase) => {
        const f = await fixture(store());
        const packet = await f.packet();
        await f.staged.admitReviewIntent(f.access.staff, packet, {
          verifyBeforeCommit: f.admission,
        });
        if (phase === "commit")
          expect(await f.process(packet)).toMatchObject({
            outcome: "prepared",
          });
        const gate = learningKbBarrier();
        let draftReads = 0;
        f.interceptKnowledge(async (call, invoke) => {
          const result = await invoke();
          if (call.operation === "getDraft" && ++draftReads === 3)
            await gate.wait();
          return result;
        });
        const pending = f.process(packet);
        let rowsAtFinalRead:
          Awaited<ReturnType<typeof f.support.rows>> | undefined;
        try {
          await gateReached(gate, pending);
          expect(draftReads).toBe(3);
          rowsAtFinalRead = await f.support.rows();
          f.revoke(supportPermissions.learningRead);
        } finally {
          gate.release();
          f.interceptKnowledge(undefined);
        }
        expect(await pending).toMatchObject({
          outcome: "pending",
          phase,
          reason: "authority_changed",
        });
        expect(await f.support.rows()).toEqual(rowsAtFinalRead);
        expect(reviews(await f.support.rows())).toHaveLength(0);
        expect(
          await f.learning.readReviewReceipt(f.access.staff, packet),
        ).toBeNull();
        expect(
          await f.staged.readReviewStatus(f.access.staff, packet),
        ).toMatchObject({
          outcome: "pending",
          phase,
        });
      },
    );

    it("accepts normalized authority ordering and grants outside the fixed proof ceiling", async () => {
      const f = await fixture(store());
      const packet = await f.packet();
      const original: AccessContext = {
        ...f.access.staff,
        roles: ["synthetic-review-role-A", "synthetic-review-role-B"],
        entitlements: [
          "synthetic-review-entitlement-A",
          "synthetic-review-entitlement-B",
        ],
      };
      f.setActor(original);
      await f.staged.admitReviewIntent(f.access.staff, packet, {
        verifyBeforeCommit: f.admission,
      });
      expect(await f.process(packet)).toMatchObject({ outcome: "prepared" });
      let draftReads = 0;
      f.interceptKnowledge(async (call, invoke) => {
        const result = await invoke();
        if (call.operation === "getDraft" && ++draftReads === 3)
          f.setActor({
            ...original,
            roles: [...original.roles].reverse(),
            entitlements: [...original.entitlements].reverse(),
            permissions: [...original.permissions]
              .reverse()
              .concat("synthetic.unrelated.permission"),
          });
        return result;
      });
      expect(await f.process(packet)).toMatchObject({
        outcome: "completed",
        receipt: { outcome: "accepted" },
      });
      expect(draftReads).toBe(3);
      expect(reviews(await f.support.rows())).toHaveLength(1);
    });

    it("denies a live actor revoked during the actual P2 proof without any review commit", async () => {
      const f = await fixture(store());
      const packet = await f.packet();
      await f.staged.admitReviewIntent(f.access.staff, packet, {
        verifyBeforeCommit: f.admission,
      });
      expect(await f.process(packet)).toMatchObject({ outcome: "prepared" });
      let revoked = false;
      f.interceptKnowledge(async (call, invoke) => {
        const result = await invoke();
        if (call.operation === "getDraft" && !revoked) {
          revoked = true;
          f.revoke(knowledgePermissions.draftRead);
        }
        return result;
      });
      expect(await f.process(packet)).toMatchObject({
        outcome: "pending",
        phase: "commit",
      });
      expect(revoked).toBe(true);
      expect(reviews(await f.support.rows())).toHaveLength(0);
      expect(
        await f.learning.readReviewReceipt(f.access.staff, packet),
      ).toBeNull();
    });

    it("keeps the synchronous final fence after the last awaited human handoff", async () => {
      const f = await fixture(store());
      const packet = await f.packet();
      await f.staged.admitReviewIntent(f.access.staff, packet, {
        verifyBeforeCommit: f.admission,
      });
      expect(await f.process(packet)).toMatchObject({ outcome: "prepared" });
      const capability = f.app.stagedResolutionLearningReviews;
      if (capability === undefined)
        throw new Error("Missing actual staged capability");
      let reached = false;
      let rowsAtCommit: Awaited<ReturnType<typeof f.support.rows>> | undefined;
      const boundary: ResolutionLearningStagedReviewApplication = {
        ...capability,
        async complete(access, fence, guard) {
          rowsAtCommit = await f.support.rows();
          return capability.complete(access, fence, async () => {
            const assertion = await guard();
            reached = true;
            f.support.advance(30_001);
            return assertion;
          });
        },
      };
      const worker = createSupportDeskStagedLearningReviews({
        ...f.options,
        application: { ...f.app, stagedResolutionLearningReviews: boundary },
      });
      expect(
        await worker.processReview({
          ticketId: packet.intent.ticketId,
          commandId: packet.commandId,
          workerId: "expiry-handoff",
          leaseMilliseconds: 30_000,
        }),
      ).toMatchObject({ outcome: "pending", phase: "commit" });
      expect(reached).toBe(true);
      expect(await f.support.rows()).toEqual(rowsAtCommit);
      expect(reviews(await f.support.rows())).toHaveLength(0);
      expect(
        await f.learning.readReviewReceipt(f.access.staff, packet),
      ).toBeNull();
    });

    it("does not retry P2's costly proof or CAS in one physical invocation after a real transaction failure", async () => {
      const f = await fixture(store());
      const packet = await f.packet();
      await f.staged.admitReviewIntent(f.access.staff, packet, {
        verifyBeforeCommit: f.admission,
      });
      expect(await f.process(packet)).toMatchObject({ outcome: "prepared" });
      let attempts = 0;
      f.support.observed.intercept(async (trace, commit) => {
        if (
          trace.actions.some(
            (action) =>
              "value" in action &&
              typeof action.value === "object" &&
              action.value !== null &&
              "kind" in action.value &&
              action.value.kind === "resolution_learning_review",
          )
        ) {
          attempts += 1;
          throw new Error("Actual transaction handoff unavailable");
        }
        return commit();
      });
      expect(await f.process(packet)).toMatchObject({
        outcome: "pending",
        phase: "commit",
      });
      expect(attempts).toBe(1);
      expect(reviews(await f.support.rows())).toHaveLength(0);
    });
  });
