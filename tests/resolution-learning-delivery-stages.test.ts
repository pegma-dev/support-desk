import { createMemoryStore, type Store } from "@pegma/storage-core";
import {
  hasDirectResolutionLearningDelivery,
  supportRecords,
  supportPermissions,
  resolutionLearningDeliveryBinding,
  type ResolutionLearningWorkRecord,
  type ResolutionLearningDeliveryObservation,
} from "@pegma/support-desk-application";
import { describe, expect, it } from "vitest";
import { createSupportDeskLearning } from "../packages/ai/src/learning-coordinator.js";
import type { SupportDeskLearningOptions } from "../packages/ai/src/learning-integration-types.js";
import {
  learningKbFixture,
  learningKbBarrier,
  learningKbStores,
} from "../test/resolution-learning-kb-fixtures.js";

async function fixture(store: Store = createMemoryStore()) {
  const f = await learningKbFixture(store);
  const options: SupportDeskLearningOptions = {
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
      count: (text) => new TextEncoder().encode(text).byteLength,
    },
    deliveryMode: "staged",
  };
  const learning = createSupportDeskLearning(options);
  const key = await f.eligible("staff_verified_fix");
  const process = () =>
    learning.processWork({
      ...key,
      workerId: "staged-learning",
      leaseMilliseconds: 30_000,
    });
  const work = () =>
    f.support.app.readResolutionLearningWork(f.access.staff, key);
  return { ...f, options, learning, key, process, work };
}

function committedAckLoss(
  stage: "prepared" | "acknowledged" | "completed",
  backing: Store = createMemoryStore(),
) {
  let lost = false;
  const isWork = (value: unknown): value is ResolutionLearningWorkRecord =>
    value !== null &&
    typeof value === "object" &&
    "kind" in value &&
    value.kind === "resolution_learning_work";
  const store: Store = {
    collection(definition) {
      const target = backing.collection(definition);
      const transact: typeof target.transact = async (...args) => {
        const result = await target.transact(...args);
        if (result.committed && !lost)
          for (const action of args[1]) {
            if (!("value" in action) || !isWork(action.value)) continue;
            const row = action.value;
            const matches =
              stage === "prepared"
                ? row.exactRequest !== undefined &&
                  row.acknowledgement === undefined &&
                  row.claim === undefined
                : stage === "acknowledged"
                  ? row.acknowledgement !== undefined &&
                    row.target === undefined &&
                    row.claim === undefined
                  : row.status === "completed" && row.target !== undefined;
            if (matches) {
              lost = true;
              throw new Error("Fictional committed ACK loss");
            }
          }
        return result;
      };
      return new Proxy(target, {
        get(object, property) {
          if (property === "transact") return transact;
          const value: unknown = Reflect.get(object, property, object);
          return typeof value === "function" ? value.bind(object) : value;
        },
      });
    },
  };
  return { store, lost: () => lost };
}

async function reach(
  f: Awaited<ReturnType<typeof fixture>>,
  phase: "prepare" | "write" | "confirm",
) {
  expect((await f.process()).outcome).toBe("candidate");
  if (phase !== "prepare")
    expect(await f.process()).toMatchObject({ checkpoint: "prepared" });
  if (phase === "confirm")
    expect(await f.process()).toMatchObject({ checkpoint: "acknowledged" });
}

for (const [backend, createStore] of learningKbStores) {
  describe(`staged existing learning updates (${backend})`, () => {
    it.each(["normal", "prepared", "acknowledged"] as const)(
      "resumes the exact update without create-only comparison metadata after %s ACK",
      async (stage) => {
        const backing = createStore();
        const fault =
          stage === "normal" ? undefined : committedAckLoss(stage, backing);
        const f = await fixture(fault?.store ?? backing);
        const original = await f.createGuide(
          "staged-existing-update",
          "Retain the existing verified export instructions while adding the new fix.",
        );
        f.updateTarget(original.articleId);
        expect((await f.process()).outcome).toBe("candidate");
        const preparation = await f.process();
        expect(preparation).toMatchObject({
          outcome: "pending",
          stage: "delivery",
        });
        if (stage !== "prepared")
          expect(preparation).toHaveProperty("checkpoint", "prepared");
        const prepared = await f.work();
        expect(prepared.exactRequest?.operation).toBe("update");
        expect(prepared.exactRequest?.articleId).toBe(original.articleId);
        expect(
          Object.hasOwn(
            JSON.parse(prepared.exactRequest!.draftPayload),
            "comparisonSelection",
          ),
        ).toBe(false);
        expect(
          f.ports.knowledgeCalls.filter(
            (call) => call.operation === "updateDraft",
          ),
        ).toHaveLength(0);
        const written = await f.process();
        expect(written).toMatchObject({
          outcome: "pending",
          stage: "delivery",
        });
        if (stage !== "acknowledged")
          expect(written).toHaveProperty("checkpoint", "acknowledged");
        const acknowledged = await f.work();
        expect(acknowledged.acknowledgement?.id).toBe(original.articleId);
        expect(acknowledged.exactRequest).toEqual(prepared.exactRequest);
        if (fault !== undefined) expect(fault.lost()).toBe(true);
        expect((await f.process()).outcome).toBe("delivered");
        const completed = await f.work();
        expect(completed.exactRequest).toEqual(prepared.exactRequest);
        expect(completed.acknowledgement).toEqual(acknowledged.acknowledgement);
        expect(completed.target?.articleId).toBe(original.articleId);
        expect(
          f.ports.knowledgeCalls.filter(
            (call) => call.operation === "updateDraft",
          ),
        ).toHaveLength(1);
        expect(
          f.ports.knowledgeCalls.filter(
            (call) => call.operation === "createDraft",
          ),
        ).toHaveLength(0);
        expect(f.ports.generate).toHaveBeenCalledOnce();
        const target = await f.kb.getDraft(f.access.draftService, {
          articleId: original.articleId,
        });
        expect(target.revision.number).toBe(original.revision.number + 1);
        expect(target.revision.content.text).toContain(
          original.revision.content.text,
        );
      },
    );
  });
}

describe("opt-in physical learning delivery stages (Memory)", () => {
  it("prepares, writes and confirms in distinct claims without publication or a second paid model", async () => {
    const f = await fixture();
    expect((await f.process()).outcome).toBe("candidate");
    expect(await f.process()).toMatchObject({
      outcome: "pending",
      stage: "delivery",
      checkpoint: "prepared",
    });
    const prepared = await f.work();
    expect(prepared.exactRequest).toBeDefined();
    expect(prepared.claim).toBeUndefined();
    expect(prepared.acknowledgement).toBeUndefined();
    expect(
      f.ports.knowledgeCalls.some((call) => call.operation === "createDraft"),
    ).toBe(false);
    expect(await f.process()).toMatchObject({
      outcome: "pending",
      stage: "delivery",
      checkpoint: "acknowledged",
    });
    const written = await f.work();
    expect(written.acknowledgement?.id).toBe(prepared.exactRequest?.articleId);
    expect(written.target).toBeUndefined();
    expect(written.claim).toBeUndefined();
    expect(written.exactRequest).toEqual(prepared.exactRequest);
    expect((await f.process()).outcome).toBe("delivered");
    const completed = await f.work();
    expect(completed.status).toBe("completed");
    expect(completed.target).toBeDefined();
    expect(completed.exactRequest).toEqual(prepared.exactRequest);
    expect(f.ports.generate).toHaveBeenCalledOnce();
    const target = await f.kb.getDraft(f.access.draftService, {
      articleId: completed.target!.articleId,
    });
    expect(target.hasPublication).toBe(false);
    expect(
      f.ports.knowledgeCalls.filter((call) => call.operation === "createDraft"),
    ).toHaveLength(1);
  });

  it.each(["missing", "copied", "replaced", "proxied"] as const)(
    "holds a %s capability before claiming or invoking callbacks",
    async (kind) => {
      const f = await fixture();
      const { stagedResolutionLearningDelivery: capability, ...legacy } =
        f.options.application;
      if (!capability) throw new Error("Actual SDK capability missing");
      expect(hasDirectResolutionLearningDelivery(capability)).toBe(true);
      const fake =
        kind === "proxied"
          ? new Proxy(capability, {})
          : {
              ...capability,
              ...(kind === "replaced"
                ? {
                    write: async () => {
                      throw new Error("Must not invoke a replacement");
                    },
                  }
                : {}),
            };
      const learning = createSupportDeskLearning({
        ...f.options,
        application:
          kind === "missing"
            ? legacy
            : { ...legacy, stagedResolutionLearningDelivery: fake },
      });
      const before = await f.backing
        .collection(supportRecords)
        .list(f.key.ticketId);
      expect(
        await learning.processWork({
          ...f.key,
          workerId: "untrusted-capability",
          leaseMilliseconds: 30_000,
        }),
      ).toEqual({ outcome: "held", reason: "staged_delivery_unavailable" });
      expect(
        await f.backing.collection(supportRecords).list(f.key.ticketId),
      ).toEqual(before);
      expect(f.ports.generate).not.toHaveBeenCalled();
    },
  );

  for (const phase of ["prepare", "write", "confirm"] as const) {
    it.each([
      "Source withdrawal",
      "reopen",
      "Support authority",
      "Knowledge authority",
      "receipt expiry",
    ] as const)(
      `holds ${phase} after late %s across the actual requirements read`,
      async (change) => {
        const f = await fixture();
        await reach(f, phase);
        const gate = learningKbBarrier();
        let armed = true;
        if (change === "receipt expiry") {
          const original = f.ports.verifyChecks.getMockImplementation()!;
          const expires = new Date(
            Date.parse(f.support.clock.now()) + 100,
          ).toISOString();
          f.ports.verifyChecks.mockImplementation(async (...args) => {
            const verified = await original(...args);
            return verified === null
              ? null
              : { ...verified, validUntil: expires };
          });
        }
        f.interceptKnowledge(async (call, invoke) => {
          const value = await invoke();
          if (armed && call.operation === "getValidationRequirements") {
            armed = false;
            await gate.wait();
          }
          return value;
        });
        const pending = f.process();
        try {
          await Promise.race([
            gate.reached,
            pending.then(() => {
              throw new Error("Actual proof barrier was not reached");
            }),
          ]);
          if (change === "Source withdrawal")
            await f.support.app.withdrawResolutionLearningSource(
              f.access.staff,
              {
                ...f.support.command("late-stage-withdrawal"),
                reason: "privacy_withdrawal",
              },
            );
          else if (change === "reopen")
            await f.support.app.reopenTicket(
              f.access.staff,
              f.support.command("late-stage-reopen"),
            );
          else if (change === "Support authority")
            f.state.serviceOutcome = "inactive";
          else if (change === "Knowledge authority")
            f.state.knowledgeOutcome = "inactive";
          else f.support.advance(101);
        } finally {
          gate.release();
        }
        const result = await pending;
        expect(result.outcome).not.toBe("delivered");
        expect(result).not.toHaveProperty("checkpoint");
        expect(
          f.ports.knowledgeCalls.filter(
            (call) => call.operation === "createDraft",
          ),
        ).toHaveLength(phase === "confirm" ? 1 : 0);
        expect(f.ports.generate).toHaveBeenCalledOnce();
      },
    );
  }

  it.each(["prepared", "acknowledged"] as const)(
    "recovers committed %s ACK loss without a false checkpoint or second KB mutation",
    async (stage) => {
      const fault = committedAckLoss(stage);
      const f = await fixture(fault.store);
      await reach(f, stage === "prepared" ? "prepare" : "write");
      expect(await f.process()).toEqual({
        outcome: "pending",
        stage: "delivery",
      });
      expect(fault.lost()).toBe(true);
      const retained = await f.work();
      expect(retained.exactRequest).toBeDefined();
      expect(retained.claim).toBeUndefined();
      if (stage === "prepared")
        expect(await f.process()).toMatchObject({ checkpoint: "acknowledged" });
      expect((await f.process()).outcome).toBe("delivered");
      expect(
        f.ports.knowledgeCalls.filter(
          (call) => call.operation === "createDraft",
        ),
      ).toHaveLength(1);
      expect((await f.work()).exactRequest).toEqual(retained.exactRequest);
    },
  );

  it("replays the exact KB packet after a committed KB response is lost", async () => {
    const f = await fixture();
    await reach(f, "write");
    let lose = true;
    const request = (await f.work()).exactRequest;
    f.interceptKnowledge(async (call, invoke) => {
      const value = await invoke();
      if (lose && call.operation === "createDraft") {
        lose = false;
        throw new Error("Fictional lost KB ACK");
      }
      return value;
    });
    expect(await f.process()).toEqual({
      outcome: "pending",
      stage: "delivery",
    });
    expect(await f.process()).toMatchObject({ checkpoint: "acknowledged" });
    expect((await f.process()).outcome).toBe("delivered");
    const writes = f.ports.knowledgeCalls.filter(
      (call) => call.operation === "createDraft",
    );
    expect(writes).toHaveLength(2);
    expect(writes[1]!.args).toEqual(writes[0]!.args);
    const completed = await f.work();
    expect(completed.exactRequest).toEqual(request);
    expect(completed.acknowledgement?.articleRevision).toBe(1);
    expect(f.ports.generate).toHaveBeenCalledOnce();
  });

  it.each(["Ticket", "Work"] as const)(
    "rejects a genuine concurrent %s opaque change before a staged KB write",
    async (change) => {
      const f = await fixture();
      await reach(f, "write");
      const gate = learningKbBarrier();
      let armed = true;
      f.interceptKnowledge(async (call, invoke) => {
        const result = await invoke();
        if (armed && call.operation === "getValidationRequirements") {
          armed = false;
          await gate.wait();
        }
        return result;
      });
      const pending = f.process();
      try {
        await Promise.race([
          gate.reached,
          pending.then(() => {
            throw new Error("Proof did not reach its actual read");
          }),
        ]);
        if (change === "Ticket")
          await f.support.app.addNote(f.access.staff, {
            ...f.support.command("concurrent-note"),
            messageId: "concurrent-note",
            body: "Private operational note.",
          });
        else {
          const claimed = await f.work();
          if (!claimed.claim) throw new Error("Actual Work claim missing");
          await f.support.app.finishResolutionLearningWork(
            f.state.serviceAuthority.access,
            {
              ...claimed.claim,
              stepId: claimed.stepId!,
              requestHash: claimed.requestHash!,
              disposition: "retry",
            },
          );
        }
      } finally {
        gate.release();
      }
      expect(await pending).not.toHaveProperty("checkpoint");
      expect(
        f.ports.knowledgeCalls.filter(
          (call) => call.operation === "createDraft",
        ),
      ).toHaveLength(0);
      expect((await f.work()).acknowledgement).toBeUndefined();
    },
  );

  it("holds a post-KB-write metadata CAS conflict and retries only the exact accepted KB packet", async () => {
    const f = await fixture();
    await reach(f, "write");
    let armed = true;
    f.interceptKnowledge(async (call, invoke) => {
      const result = await invoke();
      if (armed && call.operation === "createDraft") {
        armed = false;
        await f.support.app.addNote(f.access.staff, {
          ...f.support.command("after-kb-write-note"),
          messageId: "after-kb-write-note",
          body: "Private concurrent note.",
        });
      }
      return result;
    });
    expect(await f.process()).toEqual({
      outcome: "pending",
      stage: "delivery",
    });
    expect((await f.work()).acknowledgement).toBeUndefined();
    expect(await f.process()).toMatchObject({ checkpoint: "acknowledged" });
    expect((await f.process()).outcome).toBe("delivered");
    const writes = f.ports.knowledgeCalls.filter(
      (call) => call.operation === "createDraft",
    );
    expect(writes).toHaveLength(2);
    expect(writes[1]!.args).toEqual(writes[0]!.args);
    expect((await f.work()).acknowledgement?.articleRevision).toBe(1);
  });

  it("expires observations and requires their private confirmation rather than a true callback result", async () => {
    const f = await fixture();
    await reach(f, "write");
    const owner = await f.support.app.claimResolutionLearningWork(
      f.state.serviceAuthority.access,
      {
        ...f.key,
        workerId: "direct-scope",
        claimId: "direct-scope",
        leaseMilliseconds: 30_000,
      },
    );
    if (!owner?.work.exactRequest) throw new Error("Prepared claim missing");
    const cap = f.support.app.stagedResolutionLearningDelivery!;
    const command = {
      ...owner.fence,
      step: "kb_delivery" as const,
      candidateHash: owner.work.candidateHash!,
      verifiedCheckReceipt: owner.work.verifiedCheckReceipt!,
      policyVersion: owner.work.checkPolicyVersion!,
      targetDecisionHash: owner.work.targetDecisionHash!,
      exactRequest: owner.work.exactRequest,
    };
    await expect(
      cap.prepare(
        f.state.serviceAuthority.access,
        command,
        async () => () => true,
      ),
    ).rejects.toThrow("not confirmed");
    let observed: ResolutionLearningDeliveryObservation | undefined;
    await cap.prepare(
      f.state.serviceAuthority.access,
      command,
      async (observation) => {
        observed = observation;
        expect(() =>
          observation.read({
            ...f.state.serviceAuthority.access,
            principalId: "another-service",
          }),
        ).toThrow();
        expect(() =>
          observation.read({
            ...f.state.serviceAuthority.access,
            permissions: f.state.serviceAuthority.access.permissions.filter(
              (name) => name !== supportPermissions.learningRead,
            ),
          }),
        ).toThrow();
        expect(
          observation.read(f.state.serviceAuthority.access).work.exactRequest,
        ).toEqual(command.exactRequest);
        await observation.confirm(f.state.serviceAuthority.access);
        return () => true;
      },
    );
    if (!observed) throw new Error("Observation not captured");
    const expired = observed;
    expect(() => expired.read(f.state.serviceAuthority.access)).toThrow(
      "expired",
    );
    await expect(
      expired.confirm(f.state.serviceAuthority.access),
    ).rejects.toThrow("expired");
  });

  it("recovers a completed transaction's lost ACK before repeating target proof", async () => {
    const fault = committedAckLoss("completed");
    const f = await fixture(fault.store);
    await reach(f, "confirm");
    const owner = await f.support.app.claimResolutionLearningWork(
      f.state.serviceAuthority.access,
      {
        ...f.key,
        workerId: "direct-complete",
        claimId: "direct-complete",
        leaseMilliseconds: 30_000,
      },
    );
    if (!owner?.work.acknowledgement) throw new Error("Historical ACK missing");
    const command = {
      ...owner.fence,
      stepId: owner.work.stepId!,
      requestHash: owner.work.requestHash!,
    };
    const cap = f.support.app.stagedResolutionLearningDelivery!;
    await expect(
      cap.complete(
        f.state.serviceAuthority.access,
        command,
        async (observation) => {
          const target = await f.currentTarget(owner.work.acknowledgement!.id);
          await observation.confirm(f.state.serviceAuthority.access);
          return { target, assertCurrent: () => true };
        },
      ),
    ).rejects.toThrow("committed ACK loss");
    expect(fault.lost()).toBe(true);
    const before = await f.backing
      .collection(supportRecords)
      .list(f.key.ticketId);
    expect(
      await cap.complete(f.state.serviceAuthority.access, command, async () => {
        throw new Error("Historical receipt must win");
      }),
    ).toMatchObject({ status: "completed" });
    expect(
      await f.backing.collection(supportRecords).list(f.key.ticketId),
    ).toEqual(before);
    expect(
      f.ports.knowledgeCalls.filter((call) => call.operation === "createDraft"),
    ).toHaveLength(1);
  });

  it("retains the historical ACK while privacy withdrawal scrubs the prepared body and proof", async () => {
    const f = await fixture();
    await reach(f, "confirm");
    const before = await f.work();
    await f.support.app.withdrawResolutionLearningSource(f.access.staff, {
      ...f.support.command("withdraw-acknowledged"),
      reason: "privacy_withdrawal",
    });
    const retained = await f.work();
    expect(retained.acknowledgement).toEqual(before.acknowledgement);
    expect(retained.exactRequest).toBeUndefined();
    expect(retained.verifiedCheckReceipt).toBeUndefined();
    expect(retained.withdrawnRequest?.commandId).toBe(
      before.exactRequest?.commandId,
    );
    expect(retained.modelAttempts).toEqual([]);
    expect(retained.usageTombstones).toHaveLength(1);
    expect((await f.process()).outcome).toBe("not_claimed");
  });

  it("enforces the returned receipt deadline after the final asynchronous handoff", async () => {
    const f = await fixture();
    await reach(f, "write");
    const owner = await f.support.app.claimResolutionLearningWork(
      f.state.serviceAuthority.access,
      {
        ...f.key,
        workerId: "deadline-owner",
        claimId: "deadline-owner",
        leaseMilliseconds: 30_000,
      },
    );
    if (!owner?.work.exactRequest || !owner.work.product)
      throw new Error("Prepared Work missing");
    const command = {
      ...owner.fence,
      step: "kb_delivery" as const,
      candidateHash: owner.work.candidateHash!,
      verifiedCheckReceipt: owner.work.verifiedCheckReceipt!,
      policyVersion: owner.work.checkPolicyVersion!,
      targetDecisionHash: owner.work.targetDecisionHash!,
      exactRequest: owner.work.exactRequest,
    };
    const binding = await resolutionLearningDeliveryBinding({
      candidateHash: command.candidateHash,
      sourceBindingHash: owner.sourceFence.sourceBindingHash,
      policyVersion: command.policyVersion,
      targetDecisionHash: command.targetDecisionHash,
      exactRequest: command.exactRequest,
      applicability: {
        productId: owner.work.product.productId,
        version: owner.work.product.version,
        buildId: owner.work.product.buildId,
      },
    });
    const expires = new Date(
      Date.parse(f.support.clock.now()) + 50,
    ).toISOString();
    const original = f.ports.verifyChecks.getMockImplementation()!;
    f.ports.verifyChecks.mockImplementation(async (...args) => {
      const result = await original(...args);
      return result === null ? null : { ...result, validUntil: expires };
    });
    const before = await f.work();
    let assertions = 0;
    await expect(
      f.support.app.stagedResolutionLearningDelivery!.prepare(
        f.state.serviceAuthority.access,
        command,
        async (observation) => {
          const verified = await f.checks.verify(
            command.verifiedCheckReceipt,
            binding,
          );
          if (!verified) throw new Error("Actual checked receipt missing");
          await observation.confirm(f.state.serviceAuthority.access);
          queueMicrotask(() => f.support.advance(51));
          return () => {
            assertions += 1;
            if (
              Date.parse(f.support.clock.now()) >=
              Date.parse(verified.validUntil)
            )
              throw new Error("Exact receipt expired at handoff");
            return true;
          };
        },
      ),
    ).rejects.toThrow("Exact receipt expired at handoff");
    expect(assertions).toBe(1);
    expect(await f.work()).toEqual(before);
  });

  it("keeps unpublished staged arguments out of legacy prepare calls", async () => {
    const f = await fixture();
    await reach(f, "write");
    const owner = await f.support.app.claimResolutionLearningWork(
      f.state.serviceAuthority.access,
      {
        ...f.key,
        workerId: "legacy-prepare",
        claimId: "legacy-prepare",
        leaseMilliseconds: 30_000,
      },
    );
    if (!owner?.work.exactRequest) throw new Error("Prepared claim missing");
    let extraCalled = false;
    await Reflect.apply(
      f.support.app.prepareResolutionLearningStep,
      f.support.app,
      [
        f.state.serviceAuthority.access,
        {
          ...owner.fence,
          step: "kb_delivery",
          candidateHash: owner.work.candidateHash,
          verifiedCheckReceipt: owner.work.verifiedCheckReceipt,
          policyVersion: owner.work.checkPolicyVersion,
          targetDecisionHash: owner.work.targetDecisionHash,
          exactRequest: owner.work.exactRequest,
        },
        () => {
          extraCalled = true;
          throw new Error("Legacy extra arguments remain ignored");
        },
      ],
    );
    expect(extraCalled).toBe(false);
    expect((await f.work()).claim).toEqual(owner.fence);
  });

  it("rejects an expired old claim without dispatching and lets a new physical claimant recover", async () => {
    const f = await fixture();
    await reach(f, "write");
    const owner = await f.support.app.claimResolutionLearningWork(
      f.state.serviceAuthority.access,
      {
        ...f.key,
        workerId: "expired-owner",
        claimId: "expired-owner",
        leaseMilliseconds: 1,
      },
    );
    if (!owner) throw new Error("Prepared claim missing");
    f.support.advance(2);
    let invoked = false;
    await expect(
      f.support.app.stagedResolutionLearningDelivery!.write(
        f.state.serviceAuthority.access,
        {
          ...owner.fence,
          stepId: owner.work.stepId!,
          requestHash: owner.work.requestHash!,
        },
        async () => {
          invoked = true;
          throw new Error("Expired owner must not dispatch");
        },
      ),
    ).rejects.toThrow("claim or source fence");
    expect(invoked).toBe(false);
    expect(await f.process()).toMatchObject({ checkpoint: "acknowledged" });
    expect((await f.process()).outcome).toBe("delivered");
    expect(f.ports.generate).toHaveBeenCalledOnce();
  });
  for (const mode of ["staged", "inline"] as const) {
    it.each(["policy", "receipt", "configuration"] as const)(
      `refuses ${mode} completion when %s is revoked during final target readback`,
      async (change) => {
        const f = await fixture();
        if (mode === "staged") await reach(f, "confirm");
        else expect((await f.process()).outcome).toBe("candidate");
        const { deliveryMode: _mode, ...inlineOptions } = f.options;
        void _mode;
        const inline = createSupportDeskLearning(inlineOptions);
        let provenanceReads = 0;
        let changed = false;
        f.interceptKnowledge(async (call, invoke) => {
          const result = await invoke();
          if (
            call.operation === "getProvenance" &&
            ++provenanceReads === (mode === "staged" ? 1 : 2)
          ) {
            changed = true;
            if (change === "policy") f.state.policyOutcome = "unavailable";
            else if (change === "receipt") f.state.checksReadable = false;
            else f.state.configurationOutcome = "disabled";
          }
          return result;
        });
        const result =
          mode === "staged"
            ? await f.process()
            : await inline.processWork({
                ...f.key,
                workerId: "inline-final-proof",
                leaseMilliseconds: 30_000,
              });
        expect(changed).toBe(true);
        expect(result.outcome).not.toBe("delivered");
        expect(result).not.toHaveProperty("checkpoint");
        expect((await f.work()).status).not.toBe("completed");
        expect(
          f.ports.knowledgeCalls.filter(
            (call) => call.operation === "createDraft",
          ),
        ).toHaveLength(1);
      },
    );
  }
});

function createDeliveryAzuriteStore(): Store {
  const provider = learningKbStores.find(([name]) => name === "Azurite");
  if (provider === undefined)
    throw new Error("Existing Azurite fixture missing");
  return provider[1]();
}

describe("opt-in physical learning delivery stages (Azurite)", () => {
  it("runs separate released claims through one private draft and rejects a stale opaque version", async () => {
    const f = await fixture(createDeliveryAzuriteStore());
    expect((await f.process()).outcome).toBe("candidate");
    const candidate = await f.work();
    const records = f.backing.collection(supportRecords);
    const key = { partition: candidate.partition, id: candidate.id };
    const original = await records.getVersioned(key);
    if (original === null) throw new Error("Actual Azure Work missing");
    expect(await f.process()).toMatchObject({
      outcome: "pending",
      stage: "delivery",
      checkpoint: "prepared",
    });
    const prepared = await f.work();
    const preparedVersion = await records.getVersioned(key);
    if (preparedVersion === null)
      throw new Error("Prepared Azure Work missing");
    expect(prepared.claim).toBeUndefined();
    expect(prepared.leaseUntil).toBeUndefined();
    expect(prepared.exactRequest).toBeDefined();
    expect(preparedVersion.version).not.toBe(original.version);
    expect(
      await records.putIfUnchanged(preparedVersion.value, original.version),
    ).toBe(false);
    expect(await f.work()).toEqual(prepared);
    expect(await f.process()).toMatchObject({
      outcome: "pending",
      stage: "delivery",
      checkpoint: "acknowledged",
    });
    const acknowledged = await f.work();
    expect(acknowledged.claim).toBeUndefined();
    expect(acknowledged.leaseUntil).toBeUndefined();
    expect(acknowledged.exactRequest).toEqual(prepared.exactRequest);
    expect(acknowledged.acknowledgement?.articleRevision).toBe(1);
    expect(acknowledged.target).toBeUndefined();
    expect((await f.process()).outcome).toBe("delivered");
    const completed = await f.work();
    expect(completed.status).toBe("completed");
    const target = await f.kb.getDraft(f.access.draftService, {
      articleId: completed.target!.articleId,
    });
    expect(target.hasPublication).toBe(false);
    expect(target.revision.number).toBe(1);
    expect(f.ports.generate).toHaveBeenCalledOnce();
    expect(
      f.ports.knowledgeCalls.filter((call) => call.operation === "createDraft"),
    ).toHaveLength(1);
  });

  it("recovers a committed KB response loss by replaying byte-identical mutation arguments", async () => {
    const f = await fixture(createDeliveryAzuriteStore());
    await reach(f, "write");
    const original = (await f.work()).exactRequest;
    let lose = true;
    f.interceptKnowledge(async (call, invoke) => {
      const result = await invoke();
      if (lose && call.operation === "createDraft") {
        lose = false;
        throw new Error("Fictional Azure KB response loss");
      }
      return result;
    });
    expect(await f.process()).toEqual({
      outcome: "pending",
      stage: "delivery",
    });
    expect((await f.work()).exactRequest).toEqual(original);
    expect(await f.process()).toMatchObject({ checkpoint: "acknowledged" });
    expect((await f.process()).outcome).toBe("delivered");
    const writes = f.ports.knowledgeCalls.filter(
      (call) => call.operation === "createDraft",
    );
    expect(writes).toHaveLength(2);
    expect(JSON.stringify(writes[1]!.args)).toBe(
      JSON.stringify(writes[0]!.args),
    );
    expect((await f.work()).acknowledgement?.articleRevision).toBe(1);
    expect(f.ports.generate).toHaveBeenCalledOnce();
  });

  it("recovers an ACK checkpoint committed before response loss without another KB write", async () => {
    const fault = committedAckLoss(
      "acknowledged",
      createDeliveryAzuriteStore(),
    );
    const f = await fixture(fault.store);
    await reach(f, "write");
    expect(await f.process()).toEqual({
      outcome: "pending",
      stage: "delivery",
    });
    expect(fault.lost()).toBe(true);
    const retained = await f.work();
    expect(retained.claim).toBeUndefined();
    expect(retained.acknowledgement).toBeDefined();
    expect((await f.process()).outcome).toBe("delivered");
    expect((await f.work()).exactRequest).toEqual(retained.exactRequest);
    expect(
      f.ports.knowledgeCalls.filter((call) => call.operation === "createDraft"),
    ).toHaveLength(1);
  });

  it("rejects an identical-body Azure Work rewrite at the private prewrite version fence", async () => {
    const f = await fixture(createDeliveryAzuriteStore());
    await reach(f, "write");
    const gate = learningKbBarrier();
    let armed = true;
    f.interceptKnowledge(async (call, invoke) => {
      const result = await invoke();
      if (armed && call.operation === "getValidationRequirements") {
        armed = false;
        await gate.wait();
      }
      return result;
    });
    const pending = f.process();
    try {
      await Promise.race([
        gate.reached,
        pending.then(() => {
          throw new Error("Azure proof barrier was not reached");
        }),
      ]);
      const work = await f.work();
      const records = f.backing.collection(supportRecords);
      const key = { partition: work.partition, id: work.id };
      const before = await records.getVersioned(key);
      if (before === null) throw new Error("Azure claimed Work missing");
      expect(await records.putIfUnchanged(before.value, before.version)).toBe(
        true,
      );
      const after = await records.getVersioned(key);
      expect(after?.value).toEqual(before.value);
      expect(after?.version).not.toBe(before.version);
    } finally {
      gate.release();
    }
    expect(await pending).not.toHaveProperty("checkpoint");
    expect((await f.work()).acknowledgement).toBeUndefined();
    expect(
      f.ports.knowledgeCalls.filter((call) => call.operation === "createDraft"),
    ).toHaveLength(0);
  });

  it("holds an identical-body Azure rewrite after KB commit and recovers the exact receipt", async () => {
    const f = await fixture(createDeliveryAzuriteStore());
    await reach(f, "write");
    let rewrite = true;
    f.interceptKnowledge(async (call, invoke) => {
      const result = await invoke();
      if (rewrite && call.operation === "createDraft") {
        rewrite = false;
        const work = await f.work();
        const records = f.backing.collection(supportRecords);
        const key = { partition: work.partition, id: work.id };
        const before = await records.getVersioned(key);
        if (before === null)
          throw new Error("Azure Work missing after actual KB commit");
        expect(await records.putIfUnchanged(before.value, before.version)).toBe(
          true,
        );
        const after = await records.getVersioned(key);
        expect(after?.value).toEqual(before.value);
        expect(after?.version).not.toBe(before.version);
      }
      return result;
    });
    expect(await f.process()).toEqual({
      outcome: "pending",
      stage: "delivery",
    });
    expect((await f.work()).acknowledgement).toBeUndefined();
    expect(await f.process()).toMatchObject({ checkpoint: "acknowledged" });
    expect((await f.process()).outcome).toBe("delivered");
    const writes = f.ports.knowledgeCalls.filter(
      (call) => call.operation === "createDraft",
    );
    expect(writes).toHaveLength(2);
    expect(JSON.stringify(writes[1]!.args)).toBe(
      JSON.stringify(writes[0]!.args),
    );
    expect((await f.work()).acknowledgement?.articleRevision).toBe(1);
  });

  it.each(["Source", "process grant"] as const)(
    "denies a late %s change during actual Azure-backed proof",
    async (change) => {
      const f = await fixture(createDeliveryAzuriteStore());
      await reach(f, "write");
      const gate = learningKbBarrier();
      let armed = true;
      f.interceptKnowledge(async (call, invoke) => {
        const result = await invoke();
        if (armed && call.operation === "getValidationRequirements") {
          armed = false;
          await gate.wait();
        }
        return result;
      });
      const pending = f.process();
      try {
        await Promise.race([
          gate.reached,
          pending.then(() => {
            throw new Error("Azure proof did not reach its read");
          }),
        ]);
        if (change === "Source")
          await f.support.app.withdrawResolutionLearningSource(f.access.staff, {
            ...f.support.command("azure-late-withdrawal"),
            reason: "privacy_withdrawal",
          });
        else
          f.state.serviceAuthority = {
            ...f.state.serviceAuthority,
            access: {
              ...f.state.serviceAuthority.access,
              permissions: f.state.serviceAuthority.access.permissions.filter(
                (name) => name !== supportPermissions.learningProcess,
              ),
            },
          };
      } finally {
        gate.release();
      }
      const result = await pending;
      expect(result.outcome).not.toBe("delivered");
      expect(result).not.toHaveProperty("checkpoint");
      expect(
        f.ports.knowledgeCalls.filter(
          (call) => call.operation === "createDraft",
        ),
      ).toHaveLength(0);
      expect((await f.work()).acknowledgement).toBeUndefined();
    },
  );
});
