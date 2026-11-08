import {
  resolutionLearningDeliveryBinding,
  supportPermissions,
  supportRecords,
  type ResolutionLearningCandidate,
  type ResolutionLearningChecksBinding,
  type ResolutionLearningChecksPort,
  type ResolutionLearningClaim,
  type ResolutionLearningDeliveryRequest,
  type ResolutionLearningTarget,
  type SupportRecord,
} from "@pegma/support-desk-application";
import { describe, expect, it } from "vitest";
import { handlingStores } from "../test/handling-fixtures.js";
import {
  learningCustomer as customer,
  learningService as service,
  learningStaff as staff,
  resolutionLearningFixture,
} from "../test/resolution-learning-fixtures.js";

type Fixture = ReturnType<typeof resolutionLearningFixture>;

const candidate: ResolutionLearningCandidate = {
  problem: "Workspace export requires the export permission.",
  applicability: {
    productId: "workspace",
    version: "2.3.0",
    buildId: "build-verified-230",
  },
  steps: ["Open Workspace.", "Choose Export."],
  solution: "An authorized workspace member can export the workspace.",
  validationRequirements: ["Verify the export in the supported build."],
};

function independentChecks(
  observe: (binding: ResolutionLearningChecksBinding) => void = () => {},
): ResolutionLearningChecksPort {
  return {
    async verify(receipt, binding) {
      observe(structuredClone(binding));
      if (receipt !== "independent-check-pass") return null;
      return {
        binding,
        privacy: "passed",
        factual: "passed",
        applicability: "passed",
        duplication: "passed",
        verifierReceiptId: "trusted-independent-check-receipt",
        verifierVersion: "synthetic-checker-v1",
        verifiedAt: "2026-11-07T15:00:00.000Z",
        validUntil: "2026-11-07T16:00:00.000Z",
      };
    },
  };
}

async function eligible(f: Fixture) {
  await f.create(false);
  await f.app.replyAsStaff(staff, {
    ...f.command("working-solution"),
    messageId: "working-solution",
    body: "Open Workspace and choose Export.",
  });
  await f.app.confirmCustomerSuccess(customer, {
    ...f.command("working-confirmation"),
    lastSeenVisibleMessageId: "working-solution",
  });
  const source = await f.app.readResolutionLearningSource(staff, "ticket");
  expect(source.state).toBe("eligible");
  return { ticketId: "ticket", sourceGeneration: source.sourceGeneration };
}

async function claim(
  f: Fixture,
  key: { ticketId: string; sourceGeneration: number },
  claimId = "claim-a",
  workerId = "worker-a",
  leaseMilliseconds = 10_000,
): Promise<ResolutionLearningClaim> {
  const value = await f.app.claimResolutionLearningWork(service, {
    ticketId: key.ticketId,
    sourceGeneration: key.sourceGeneration,
    claimId,
    workerId,
    leaseMilliseconds,
  });
  if (value === null) throw new Error("Expected an eligible learning claim");
  return value;
}

function stepFence(prepared: {
  readonly stepId: string;
  readonly requestHash: string;
}) {
  return { stepId: prepared.stepId, requestHash: prepared.requestHash };
}

function loseNextSupportAcknowledgement(f: Fixture) {
  let lost = false;
  f.observed.intercept(async (trace, commit) => {
    const outcome = await commit();
    if (
      !lost &&
      trace.collection === supportRecords.name &&
      outcome.committed
    ) {
      lost = true;
      throw new Error("Synthetic storage acknowledgement lost");
    }
    return outcome;
  });
}

async function prepareCandidate(f: Fixture, owner: ResolutionLearningClaim) {
  const prepared = await f.app.prepareResolutionLearningStep(service, {
    ...owner.fence,
    step: "model",
    binding: f.modelBinding(owner),
  });
  const work = await f.app.completeResolutionLearningStep(
    service,
    {
      ...owner.fence,
      ...stepFence(prepared),
      step: "model",
      candidate,
      accounting: "accounted",
      processing: { provider: "synthetic", inputTokens: 100, outputTokens: 50 },
    },
    () => {},
  );
  if (work.candidateHash === undefined)
    throw new Error("Model completion did not bind its candidate");
  return { prepared, work, candidateHash: work.candidateHash };
}

async function deliveryRequest(
  f: Fixture,
  owner: ResolutionLearningClaim,
  articleId = "workspace-export",
): Promise<ResolutionLearningDeliveryRequest> {
  const source = await f.app.readResolutionLearningSource(
    staff,
    owner.fence.ticketId,
  );
  return {
    operation: "update",
    articleId,
    collectionId: "workspace-help",
    draftPayload: JSON.stringify(candidate),
    sourceReferences: [
      {
        id: "inherited-first",
        system: "synthetic",
        resourceId: "first",
        version: "3",
      },
      {
        id: source.sourceId,
        system: "pegma.support-desk",
        resourceId: owner.fence.ticketId,
        version: owner.sourceFence.sourceBindingHash,
      },
      {
        id: "inherited-last",
        system: "synthetic",
        resourceId: "last",
        version: "7",
      },
    ],
    originalExpectedGeneration: 11,
    commandId: `fixed-learning-kb-command:${articleId}`,
    correlationId: "fixed-learning-kb-correlation",
  };
}

function target(
  overrides: Partial<ResolutionLearningTarget> = {},
): ResolutionLearningTarget {
  return {
    articleId: "workspace-export",
    collectionId: "workspace-help",
    articleRevision: 12,
    contentHash: "d".repeat(64),
    sourceSnapshotGeneration: 5,
    sourceSnapshotHash: "e".repeat(64),
    orderedReferencesHash: "f".repeat(64),
    ...overrides,
  };
}

async function prepareDelivery(
  f: Fixture,
  owner: ResolutionLearningClaim,
  articleId = "workspace-export",
) {
  const proposal = await prepareCandidate(f, owner);
  const deliveryOwner = await claim(
    f,
    owner.fence,
    `kb-${owner.fence.claimId}`,
    owner.fence.workerId,
  );
  const exactRequest = await deliveryRequest(f, deliveryOwner, articleId);
  const command = {
    ...deliveryOwner.fence,
    step: "kb_delivery" as const,
    candidateHash: proposal.candidateHash,
    verifiedCheckReceipt: "independent-check-pass",
    policyVersion: "synthetic-check-policy-v1",
    targetDecisionHash: "1".repeat(64),
    exactRequest,
  };
  const prepared = await f.app.prepareResolutionLearningStep(service, command);
  return { ...proposal, command, prepared, exactRequest, owner: deliveryOwner };
}

async function reconciliationSources(f: Fixture) {
  const ticketIds: string[] = [];
  let cursor: string | undefined;
  for (let pageNumber = 0; pageNumber < 64; pageNumber += 1) {
    const page = await f.app.scanResolutionLearningCandidates(service, {
      limit: 100,
      ...(cursor === undefined ? {} : { cursor }),
    });
    ticketIds.push(...page.reconciliationSources);
    if (page.nextCursor === null) return ticketIds;
    cursor = page.nextCursor;
  }
  throw new Error("Reconciliation fixture exceeded its physical scan bound");
}

for (const [name, createStore] of handlingStores) {
  describe(`resolution learning work fencing (${name})`, () => {
    it("serializes claims and job changes with the source and unchanged ticket without a domain revision", async () => {
      const f = resolutionLearningFixture(createStore());
      const key = await eligible(f);
      const before = (await f.app.readStaffTicket(staff, "ticket")).ticket;
      const beforeRows = await f.rows();
      f.observed.transactions.length = 0;
      const owner = await claim(f, key);
      await prepareCandidate(f, owner);
      expect((await f.app.readStaffTicket(staff, "ticket")).ticket).toEqual(
        before,
      );
      expect(await f.rows()).toHaveLength(beforeRows.length);
      const changes = f.observed.transactions.filter(
        (trace) => trace.collection === supportRecords.name,
      );
      expect(changes.length).toBeGreaterThanOrEqual(3);
      for (const trace of changes) {
        expect(trace.partition).toBe("ticket");
        const updates = trace.actions.filter(
          (action) => action.action !== "delete",
        );
        expect(
          updates.map((action) => (action.value as SupportRecord).kind),
        ).toEqual(
          expect.arrayContaining([
            "ticket",
            "resolution_learning_source",
            "resolution_learning_work",
          ]),
        );
        expect(
          updates.filter(
            (action) => (action.value as SupportRecord).kind === "ticket",
          ),
        ).toEqual([
          expect.objectContaining({
            action: "putIfUnchanged",
            value: expect.objectContaining({ ticket: before }),
          }),
        ]);
        expect(
          new Set(updates.map((action) => (action.value as SupportRecord).id))
            .size,
        ).toBe(updates.length);
      }
    });

    it("gives competing physical workers one claim and does not let a different invocation borrow it", async () => {
      const f = resolutionLearningFixture(createStore());
      const key = await eligible(f);
      const candidates = await Promise.all([
        f.app.claimResolutionLearningWork(service, {
          ...key,
          claimId: "physical-a",
          workerId: "worker",
          leaseMilliseconds: 10_000,
        }),
        f.app.claimResolutionLearningWork(service, {
          ...key,
          claimId: "physical-b",
          workerId: "worker",
          leaseMilliseconds: 10_000,
        }),
      ]);
      expect(candidates.filter((item) => item !== null)).toHaveLength(1);
      const owner = candidates.find((item) => item !== null)!;
      const before = await f.rows();
      expect(
        await f.app.claimResolutionLearningWork(service, {
          ...key,
          workerId: "other-worker",
          claimId: owner.fence.claimId,
          leaseMilliseconds: 10_000,
        }),
      ).toBeNull();
      expect(await f.rows()).toEqual(before);
      expect(
        (await f.app.readResolutionLearningWork(staff, key)).modelAttempts,
      ).toHaveLength(0);
    });

    it("replays an exact model preparation and completion once and rejects an altered replay", async () => {
      const f = resolutionLearningFixture(createStore());
      const owner = await claim(f, await eligible(f));
      const input = {
        ...owner.fence,
        step: "model" as const,
        binding: f.modelBinding(owner),
      };
      loseNextSupportAcknowledgement(f);
      await expect(
        f.app.prepareResolutionLearningStep(service, input),
      ).rejects.toThrow("Synthetic storage acknowledgement lost");
      f.observed.intercept(undefined);
      const durablePreparation = await f.rows();
      const prepared = await f.app.prepareResolutionLearningStep(
        service,
        input,
      );
      expect(await f.rows()).toEqual(durablePreparation);
      const rows = await f.rows();
      expect(await f.app.prepareResolutionLearningStep(service, input)).toEqual(
        prepared,
      );
      expect(await f.rows()).toEqual(rows);
      await expect(
        f.app.prepareResolutionLearningStep(service, {
          ...input,
          binding: { ...input.binding, modelVersion: "different-model" },
        }),
      ).rejects.toThrow();
      const complete = {
        ...owner.fence,
        ...stepFence(prepared),
        step: "model" as const,
        candidate,
        accounting: "accounted" as const,
      };
      loseNextSupportAcknowledgement(f);
      await expect(
        f.app.completeResolutionLearningStep(service, complete, () => {}),
      ).rejects.toThrow("Synthetic storage acknowledgement lost");
      f.observed.intercept(undefined);
      const durableCompletion = await f.rows();
      const accepted = await f.app.completeResolutionLearningStep(
        service,
        complete,
        () => {},
      );
      expect(await f.rows()).toEqual(durableCompletion);
      const committed = await f.rows();
      expect(
        await f.app.completeResolutionLearningStep(service, complete, () => {}),
      ).toEqual(accepted);
      expect(await f.rows()).toEqual(committed);
      await expect(
        f.app.completeResolutionLearningStep(
          service,
          {
            ...complete,
            candidate: { ...candidate, solution: "An altered proposal" },
          },
          () => {},
        ),
      ).rejects.toThrow();
      await expect(
        f.app.completeResolutionLearningStep(
          {
            ...service,
            permissions: service.permissions.filter(
              (permission) => permission !== supportPermissions.learningProcess,
            ),
          },
          complete,
          () => {},
        ),
      ).rejects.toThrow();
      expect(await f.rows()).toEqual(committed);
      expect((await f.work()).modelAttempts).toHaveLength(1);
    });

    it("rejects expired and replaced claims before the final guard can run", async () => {
      const f = resolutionLearningFixture(createStore());
      const key = await eligible(f);
      const first = await claim(f, key);
      const prepared = await f.app.prepareResolutionLearningStep(service, {
        ...first.fence,
        step: "model",
        binding: f.modelBinding(first),
      });
      f.advance(10_001);
      const second = await claim(f, key, "replacement", "worker-b");
      expect(second.fence.claimGeneration).toBeGreaterThan(
        first.fence.claimGeneration,
      );
      expect(second.fence.claimId).not.toBe(first.fence.claimId);
      const before = await f.rows();
      let guardCalls = 0;
      await expect(
        f.app.completeResolutionLearningStep(
          service,
          {
            ...first.fence,
            ...stepFence(prepared),
            step: "model",
            candidate,
            accounting: "accounted",
          },
          () => {
            guardCalls += 1;
          },
        ),
      ).rejects.toThrow();
      await expect(
        f.app.completeResolutionLearningStep(
          service,
          {
            ...second.fence,
            ...stepFence(prepared),
            step: "model",
            candidate,
            accounting: "accounted",
          },
          () => {
            guardCalls += 1;
          },
        ),
      ).rejects.toThrow();
      await expect(
        f.app.finishResolutionLearningWork(service, {
          ...first.fence,
          ...stepFence(prepared),
          disposition: "retry",
          accounting: "unknown",
          retryAt: f.clock.now(),
        }),
      ).rejects.toThrow();
      expect(guardCalls).toBe(0);
      expect(await f.rows()).toEqual(before);
    });

    it("requires the full prepared model step fence when its owning claim finishes", async () => {
      const f = resolutionLearningFixture(createStore());
      const owner = await claim(f, await eligible(f));
      const prepared = await f.app.prepareResolutionLearningStep(service, {
        ...owner.fence,
        step: "model",
        binding: f.modelBinding(owner),
      });
      const command = {
        ...owner.fence,
        disposition: "retry" as const,
        accounting: "not_called" as const,
        retryAt: f.clock.now(),
      };
      const before = await f.rows();
      for (const incompleteFence of [
        {},
        { stepId: prepared.stepId },
        { requestHash: prepared.requestHash },
      ]) {
        await expect(
          f.app.finishResolutionLearningWork(service, {
            ...command,
            ...incompleteFence,
          }),
        ).rejects.toThrow();
        expect(await f.rows()).toEqual(before);
      }
      await f.app.finishResolutionLearningWork(service, {
        ...command,
        ...stepFence(prepared),
      });
      const work = await f.work();
      expect(work.status).toBe("retry");
      expect(work.claim).toBeUndefined();
      expect(work.modelAttempts).toEqual([
        expect.objectContaining({
          stepId: prepared.stepId,
          requestHash: prepared.requestHash,
          accounting: "not_called",
        }),
      ]);
    });

    it("keeps earlier accounted model work intact when a later exhausted claim finishes without a step", async () => {
      const f = resolutionLearningFixture(createStore(), {
        resolutionLearning: { maxModelAttempts: 1 },
      });
      const key = await eligible(f);
      const first = await claim(f, key);
      const prepared = await f.app.prepareResolutionLearningStep(service, {
        ...first.fence,
        step: "model",
        binding: f.modelBinding(first),
      });
      await f.app.finishResolutionLearningWork(service, {
        ...first.fence,
        ...stepFence(prepared),
        disposition: "retry",
        accounting: "accounted",
        retryAt: f.clock.now(),
        processing: {
          requestId: "paid-model-request",
          inputTokens: 20,
          outputTokens: 5,
        },
      });
      const previousAttempt = (await f.work()).modelAttempts[0]!;
      const source = await f.source();
      const ticket = (await f.app.readStaffTicket(staff, "ticket")).ticket;
      const later = await claim(f, key, "budget-exhausted-claim");
      await expect(
        f.app.prepareResolutionLearningStep(service, {
          ...later.fence,
          step: "model",
          binding: f.modelBinding(later),
        }),
      ).rejects.toThrow();
      await f.app.finishResolutionLearningWork(service, {
        ...later.fence,
        disposition: "held",
        accounting: "not_called",
        reason: "no new model request was admitted",
      });
      expect((await f.work()).modelAttempts).toEqual([previousAttempt]);
      expect(previousAttempt).toMatchObject({
        stepId: prepared.stepId,
        requestHash: prepared.requestHash,
        accounting: "accounted",
      });
      expect(await f.source()).toEqual(source);
      expect((await f.app.readStaffTicket(staff, "ticket")).ticket).toEqual(
        ticket,
      );
    });

    it("keeps an unapproved candidate private and requires independent checks before automatic draft transfer", async () => {
      const verified: ResolutionLearningChecksBinding[] = [];
      const f = resolutionLearningFixture(createStore(), {
        resolutionLearning: {
          checks: independentChecks((binding) => verified.push(binding)),
        },
      });
      const owner = await claim(f, await eligible(f));
      const proposal = await prepareCandidate(f, owner);
      const visible = JSON.stringify(
        await f.app.readCustomerTicket(customer, "ticket"),
      );
      expect(visible).not.toContain(candidate.problem);
      expect(visible).not.toContain("candidateHash");
      expect(verified).toEqual([]);
      const deliveryOwner = await claim(f, owner.fence, "checked-delivery");
      const exactRequest = await deliveryRequest(f, deliveryOwner);
      const input = {
        ...deliveryOwner.fence,
        step: "kb_delivery" as const,
        candidateHash: proposal.candidateHash,
        verifiedCheckReceipt: "model-self-declared-private",
        policyVersion: "synthetic-check-policy-v1",
        targetDecisionHash: "1".repeat(64),
        exactRequest,
      };
      await expect(
        f.app.prepareResolutionLearningStep(service, input),
      ).rejects.toThrow();
      expect(
        (await f.app.readResolutionLearningWork(staff, owner.fence))
          .exactRequest,
      ).toBeUndefined();
      const prepared = await f.app.prepareResolutionLearningStep(service, {
        ...input,
        verifiedCheckReceipt: "independent-check-pass",
      });
      expect(prepared.step).toBe("kb_delivery");
      expect(verified.at(-1)).toEqual(
        await resolutionLearningDeliveryBinding({
          candidateHash: proposal.candidateHash,
          sourceBindingHash: owner.sourceFence.sourceBindingHash,
          policyVersion: input.policyVersion,
          targetDecisionHash: input.targetDecisionHash,
          applicability: candidate.applicability,
          exactRequest,
        }),
      );
      expect(
        (await f.rows()).filter(
          (row) => row.kind === "resolution_learning_review",
        ),
      ).toEqual([]);
    });

    it("rejects a trusted receipt bound to a different exact request", async () => {
      const f = resolutionLearningFixture(createStore(), {
        resolutionLearning: {
          checks: {
            async verify(receipt, binding) {
              const valid = await independentChecks().verify(receipt, binding);
              return valid === null
                ? null
                : {
                    ...valid,
                    binding: { ...binding, requestHash: "0".repeat(64) },
                  };
            },
          },
        },
      });
      const owner = await claim(f, await eligible(f));
      const proposal = await prepareCandidate(f, owner);
      const deliveryOwner = await claim(
        f,
        owner.fence,
        "mismatched-check-delivery",
      );
      await expect(
        f.app.prepareResolutionLearningStep(service, {
          ...deliveryOwner.fence,
          step: "kb_delivery",
          candidateHash: proposal.candidateHash,
          verifiedCheckReceipt: "independent-check-pass",
          policyVersion: "synthetic-check-policy-v1",
          targetDecisionHash: "1".repeat(64),
          exactRequest: await deliveryRequest(f, deliveryOwner),
        }),
      ).rejects.toThrow();
      expect(
        (await f.app.readResolutionLearningWork(staff, owner.fence))
          .exactRequest,
      ).toBeUndefined();
    });

    it("recovers ambiguous KB acceptance with the original fixed request and no new model attempt", async () => {
      const f = resolutionLearningFixture(createStore(), {
        resolutionLearning: { checks: independentChecks() },
      });
      const key = await eligible(f);
      const first = await claim(f, key);
      const delivery = await prepareDelivery(f, first);
      const finish = {
        ...delivery.owner.fence,
        stepId: delivery.prepared.stepId,
        requestHash: delivery.prepared.requestHash,
        disposition: "unknown" as const,
        reason: "kb_call_may_have_been_accepted",
      };
      loseNextSupportAcknowledgement(f);
      await expect(
        f.app.finishResolutionLearningWork(service, finish),
      ).rejects.toThrow("Synthetic storage acknowledgement lost");
      f.observed.intercept(undefined);
      const durableFinish = await f.rows();
      const unknown = await f.app.finishResolutionLearningWork(service, finish);
      expect(await f.rows()).toEqual(durableFinish);
      const unknownRows = await f.rows();
      expect(await f.app.finishResolutionLearningWork(service, finish)).toEqual(
        unknown,
      );
      await expect(
        f.app.finishResolutionLearningWork(service, {
          ...finish,
          reason: "altered-finish-replay",
        }),
      ).rejects.toThrow();
      expect(await f.rows()).toEqual(unknownRows);
      f.advance(10_001);
      const second = await claim(f, key, "recovery-claim", "recovery-worker");
      expect(second.work.exactRequest).toEqual(delivery.exactRequest);
      expect(second.work.stepId).toBe(delivery.prepared.stepId);
      expect(second.work.requestHash).toBe(delivery.prepared.requestHash);
      expect(second.work.modelAttempts).toHaveLength(1);
      const reclaimed = await f.rows();
      for (const incompleteFence of [
        {},
        { stepId: delivery.prepared.stepId },
        { requestHash: delivery.prepared.requestHash },
      ]) {
        await expect(
          f.app.finishResolutionLearningWork(service, {
            ...second.fence,
            ...incompleteFence,
            disposition: "unknown",
            reason: "replacement claim must name the prepared KB operation",
          }),
        ).rejects.toThrow();
        expect(await f.rows()).toEqual(reclaimed);
      }
      expect(
        await f.app.prepareResolutionLearningStep(service, {
          ...delivery.command,
          ...second.fence,
        }),
      ).toEqual(delivery.prepared);
      for (const changedRequest of [
        { ...delivery.exactRequest, originalExpectedGeneration: 12 },
        { ...delivery.exactRequest, commandId: "replacement-command" },
        {
          ...delivery.exactRequest,
          sourceReferences: [
            ...delivery.exactRequest.sourceReferences,
          ].reverse(),
        },
      ]) {
        await expect(
          f.app.prepareResolutionLearningStep(service, {
            ...delivery.command,
            ...second.fence,
            exactRequest: changedRequest,
          }),
        ).rejects.toThrow();
      }
      const currentTargetBinding = target();
      const complete = {
        ...second.fence,
        ...stepFence(delivery.prepared),
        step: "kb_delivery" as const,
        historicalAck: {
          id: currentTargetBinding.articleId,
          generation: 12,
          articleRevision: currentTargetBinding.articleRevision,
          contentHash: currentTargetBinding.contentHash,
          state: "draft",
        },
        currentTargetBinding,
      };
      const accepted = await f.app.completeResolutionLearningStep(
        service,
        complete,
        () => {},
      );
      const committed = await f.rows();
      expect(
        await f.app.completeResolutionLearningStep(service, complete, () => {}),
      ).toEqual(accepted);
      expect(await f.rows()).toEqual(committed);
      expect((await f.work()).modelAttempts).toHaveLength(1);
      expect((await f.work()).exactRequest).toEqual(delivery.exactRequest);
    });

    it("keeps first-destination reconciliation discoverable after the derivation job expires", async () => {
      const f = resolutionLearningFixture(createStore(), {
        resolutionLearning: { checks: independentChecks() },
      });
      const key = await eligible(f);
      expect(await reconciliationSources(f)).toEqual([]);
      const delivery = await prepareDelivery(f, await claim(f, key));
      expect((await f.source()).reconciliationPending).toBe(true);
      expect(await reconciliationSources(f)).toEqual(["ticket"]);
      await f.app.finishResolutionLearningWork(service, {
        ...delivery.owner.fence,
        ...stepFence(delivery.prepared),
        disposition: "unknown",
        reason: "remote acceptance remains uncertain",
      });
      f.advance(300_001);
      expect(
        await f.app.claimResolutionLearningWork(service, {
          ...key,
          workerId: "expired-recovery-worker",
          claimId: "expired-recovery-claim",
          leaseMilliseconds: 10_000,
        }),
      ).toBeNull();
      expect((await f.source()).reconciliationPending).toBe(true);
      expect(await reconciliationSources(f)).toEqual(["ticket"]);
      expect(
        (await f.work("ticket", key.sourceGeneration)).exactRequest,
      ).toEqual(delivery.exactRequest);
    });

    it.each([false, true])(
      "requires terminal reconciliation of an earlier source target before clearing all work (earlier unknown: %s)",
      async (earlierUnknown) => {
        const f = resolutionLearningFixture(createStore(), {
          resolutionLearning: { checks: independentChecks() },
        });
        const firstKey = await eligible(f);
        const first = await prepareDelivery(f, await claim(f, firstKey));
        const firstTarget = target();
        expect((await f.source()).reconciliationPending).toBe(true);
        if (earlierUnknown) {
          await f.app.finishResolutionLearningWork(service, {
            ...first.owner.fence,
            ...stepFence(first.prepared),
            disposition: "unknown",
            reason: "first target acceptance unknown",
          });
        } else {
          await f.app.completeResolutionLearningStep(
            service,
            {
              ...first.owner.fence,
              ...stepFence(first.prepared),
              step: "kb_delivery",
              historicalAck: {
                id: firstTarget.articleId,
                generation: 12,
                articleRevision: firstTarget.articleRevision,
                contentHash: firstTarget.contentHash,
                state: "draft",
              },
              currentTargetBinding: firstTarget,
            },
            () => {},
          );
          expect((await f.source()).reconciliationPending).toBe(false);
          expect(await reconciliationSources(f)).toEqual([]);
        }
        const ticket = (await f.app.readStaffTicket(staff, "ticket")).ticket;
        const source = await f.source();
        await f.app.submitResolutionEvidence(staff, {
          ...f.command("new-proof-for-second-destination"),
          expectedRevision: ticket.revision,
          resolutionCycle: source.resolutionCycle,
          evidence: {
            kind: "staff_verified_fix",
            solutionMessageId: "working-solution",
            verificationReference: "second-distinct-working-proof",
          },
        });
        const secondKey = await f.candidate();
        const second = await prepareDelivery(
          f,
          await claim(f, secondKey, "second-destination-model"),
          "workspace-export-secondary",
        );
        expect((await f.source()).reconciliationPending).toBe(true);
        const secondTarget = target({
          articleId: "workspace-export-secondary",
        });
        await f.app.completeResolutionLearningStep(
          service,
          {
            ...second.owner.fence,
            ...stepFence(second.prepared),
            step: "kb_delivery",
            historicalAck: {
              id: secondTarget.articleId,
              generation: 12,
              articleRevision: secondTarget.articleRevision,
              contentHash: secondTarget.contentHash,
              state: "draft",
            },
            currentTargetBinding: secondTarget,
          },
          () => {},
        );
        const currentSource = await f.source();
        expect(currentSource.destinations).toHaveLength(2);
        expect(
          currentSource.destinations.filter(
            (item) => item.reconciliation === "confirmed",
          ),
        ).toHaveLength(1);
        expect(currentSource.reconciliationPending).toBe(true);
        expect(await reconciliationSources(f)).toEqual(["ticket"]);
        const pending = await f.app.readResolutionLearningReconciliation(
          service,
          "ticket",
        );
        const oldTarget = pending.destinations.find(
          (item) => item.articleId === firstTarget.articleId,
        )!;
        expect(oldTarget.reconciliation).toBe("pending");
        const terminal = {
          ticketId: "ticket",
          expectedSourceGeneration: pending.sourceGeneration,
          expectedSourceWorkGeneration: pending.sourceWorkGeneration,
          articleId: oldTarget.articleId,
          stepId: oldTarget.stepId,
          requestHash: oldTarget.requestHash,
          disposition: "retired" as const,
        };
        const beforeTerminal = await f.rows();
        await expect(
          f.app.recordResolutionLearningReconciliation(
            service,
            terminal,
            () => {},
          ),
        ).rejects.toThrow();
        expect(await f.rows()).toEqual(beforeTerminal);
        f.trust.setTarget(firstTarget);
        let terminalGuardCalls = 0;
        const terminalCommand = {
          ...terminal,
          proof: {
            kind: "revision_fence" as const,
            binding: "synthetic-retired-target-and-late-write-fence",
          },
        };
        const verifyTerminalObservation = async () => {
          await f.trust.targetGuard(firstTarget)();
          terminalGuardCalls += 1;
        };
        const reconciled = await f.app.recordResolutionLearningReconciliation(
          service,
          terminalCommand,
          verifyTerminalObservation,
        );
        expect(terminalGuardCalls).toBe(1);
        expect(
          reconciled.destinations.every(
            (item) => item.reconciliation === "confirmed",
          ),
        ).toBe(true);
        expect(reconciled.reconciliationPending).toBe(false);
        expect(await reconciliationSources(f)).toEqual([]);
        expect(await f.rows()).toHaveLength(beforeTerminal.length);
        const committed = await f.rows();
        expect(
          await f.app.recordResolutionLearningReconciliation(
            service,
            terminalCommand,
            verifyTerminalObservation,
          ),
        ).toEqual(reconciled);
        expect(terminalGuardCalls).toBe(2);
        expect(await f.rows()).toEqual(committed);
      },
    );

    it("checks final current authority before committing a model or KB completion", async () => {
      const f = resolutionLearningFixture(createStore(), {
        resolutionLearning: { checks: independentChecks() },
      });
      const owner = await claim(f, await eligible(f));
      const prepared = await f.app.prepareResolutionLearningStep(service, {
        ...owner.fence,
        step: "model",
        binding: f.modelBinding(owner),
      });
      const before = await f.rows();
      const denied = () => {
        throw new Error("current processing authority revoked");
      };
      await expect(
        f.app.completeResolutionLearningStep(
          service,
          {
            ...owner.fence,
            ...stepFence(prepared),
            step: "model",
            candidate,
            accounting: "accounted",
          },
          denied,
        ),
      ).rejects.toThrow("current processing authority revoked");
      expect(await f.rows()).toEqual(before);
      const delivery = await prepareDelivery(f, owner);
      const beforeKb = await f.rows();
      const currentTargetBinding = target();
      await expect(
        f.app.completeResolutionLearningStep(
          service,
          {
            ...delivery.owner.fence,
            ...stepFence(delivery.prepared),
            step: "kb_delivery",
            historicalAck: {
              id: currentTargetBinding.articleId,
              generation: 12,
              articleRevision: 12,
              contentHash: currentTargetBinding.contentHash,
              state: "draft",
            },
            currentTargetBinding,
          },
          denied,
        ),
      ).rejects.toThrow("current processing authority revoked");
      expect(await f.rows()).toEqual(beforeKb);
    });

    it("rechecks the read-only final guard after a real ticket CAS conflict", async () => {
      const f = resolutionLearningFixture(createStore());
      const owner = await claim(f, await eligible(f));
      const prepared = await f.app.prepareResolutionLearningStep(service, {
        ...owner.fence,
        step: "model",
        binding: f.modelBinding(owner),
      });
      let conflicted = false;
      f.observed.intercept(async (trace, commit) => {
        if (
          !conflicted &&
          trace.actions.some(
            (action) =>
              action.action !== "delete" &&
              (action.value as SupportRecord).kind ===
                "resolution_learning_work",
          )
        ) {
          conflicted = true;
          await f.app.changePriority(staff, {
            ...f.command("metadata-during-learning-commit"),
            priority: "high",
          });
        }
        return commit();
      });
      let guardCalls = 0;
      await f.app.completeResolutionLearningStep(
        service,
        {
          ...owner.fence,
          ...stepFence(prepared),
          step: "model",
          candidate,
          accounting: "accounted",
        },
        () => {
          guardCalls += 1;
        },
      );
      f.observed.intercept(undefined);
      expect(conflicted).toBe(true);
      expect(guardCalls).toBe(2);
      expect((await f.source()).state).toBe("eligible");
      expect((await f.work()).candidate).toEqual(candidate);
      expect(
        (await f.app.readStaffTicket(staff, "ticket")).ticket.priority,
      ).toBe("high");
    });

    it("reviews a fresh local edit against the actual full target snapshot and rejects stale or unauthorized review", async () => {
      const f = resolutionLearningFixture(createStore(), {
        resolutionLearning: {
          checks: independentChecks(),
          maxReviewBindings: 3,
        },
      });
      const key = await eligible(f);
      const owner = await claim(f, key);
      const delivery = await prepareDelivery(f, owner);
      const deliveredTarget = target();
      f.trust.setTarget(deliveredTarget);
      await f.app.completeResolutionLearningStep(
        service,
        {
          ...delivery.owner.fence,
          ...stepFence(delivery.prepared),
          step: "kb_delivery",
          historicalAck: {
            id: deliveredTarget.articleId,
            generation: 12,
            articleRevision: 12,
            contentHash: deliveredTarget.contentHash,
            state: "draft",
          },
          currentTargetBinding: deliveredTarget,
        },
        f.trust.targetGuard(deliveredTarget),
      );
      const editedTarget = target({
        articleRevision: 13,
        contentHash: "2".repeat(64),
        sourceSnapshotGeneration: 6,
        sourceSnapshotHash: "3".repeat(64),
        orderedReferencesHash: "4".repeat(64),
      });
      f.trust.setTarget(editedTarget);
      const work = await f.app.readResolutionLearningWork(staff, key);
      const review = {
        ...f.command("review-actual-local-edit"),
        ...key,
        expectedWorkGeneration: work.workGeneration,
        target: editedTarget,
        decision: "approve" as const,
        policyVersion: "current-staff-policy-v2",
        reason: "Verified this edited revision and every current source.",
      };
      let guardCalls = 0;
      await f.app.reviewResolutionLearningProposal(staff, review, async () => {
        guardCalls += 1;
        await f.trust.targetGuard(editedTarget)();
      });
      expect(guardCalls).toBeGreaterThan(0);
      const source = await f.app.readResolutionLearningSource(staff, "ticket");
      expect(source.reviewBindingCount).toBe(1);
      expect(
        (await f.rows()).filter(
          (row) => row.kind === "resolution_learning_review",
        ),
      ).toEqual([
        expect.objectContaining({
          target: editedTarget,
          reviewerId: staff.principalId,
          policyVersion: review.policyVersion,
          sourceGeneration: key.sourceGeneration,
          sourceBindingHash: owner.sourceFence.sourceBindingHash,
        }),
      ]);
      const before = await f.rows();
      await expect(
        f.app.reviewResolutionLearningProposal(
          staff,
          {
            ...review,
            ...f.command("stale-target-review"),
            target: deliveredTarget,
          },
          () => {
            throw new Error("KB draft or complete provenance changed");
          },
        ),
      ).rejects.toThrow();
      await expect(
        f.app.reviewResolutionLearningProposal(
          {
            ...staff,
            permissions: staff.permissions.filter(
              (permission) => permission !== supportPermissions.learningReview,
            ),
          },
          review,
          () => {},
        ),
      ).rejects.toThrow();
      expect(await f.rows()).toEqual(before);
      expect(
        await f.app.confirmResolutionLearningTargetReview(service, {
          ticketId: "ticket",
          target: editedTarget,
          policyVersion: review.policyVersion,
        }),
      ).toBe(true);
      expect(
        await f.app.confirmResolutionLearningTargetReview(service, {
          ticketId: "ticket",
          target: deliveredTarget,
          policyVersion: review.policyVersion,
        }),
      ).toBe(false);
      expect(
        await f.app.confirmResolutionLearningTargetReview(service, {
          ticketId: "ticket",
          target: editedTarget,
          policyVersion: "changed-review-policy",
        }),
      ).toBe(false);
      const laterTargets = [
        target({
          articleRevision: 14,
          contentHash: "5".repeat(64),
          sourceSnapshotGeneration: 7,
          sourceSnapshotHash: "6".repeat(64),
          orderedReferencesHash: "7".repeat(64),
        }),
        target({
          articleRevision: 15,
          contentHash: "8".repeat(64),
          sourceSnapshotGeneration: 8,
          sourceSnapshotHash: "9".repeat(64),
          orderedReferencesHash: "0".repeat(64),
        }),
      ];
      for (const laterTarget of laterTargets) {
        const beforeReview = await f.rows();
        f.trust.setTarget(laterTarget);
        await f.app.reviewResolutionLearningProposal(
          staff,
          {
            ...review,
            ...f.command(`review-later-draft-${laterTarget.articleRevision}`),
            expectedWorkGeneration: (await f.work()).workGeneration,
            target: laterTarget,
          },
          f.trust.targetGuard(laterTarget),
        );
        expect(await f.rows()).toHaveLength(beforeReview.length + 3);
        expect(
          await f.app.confirmResolutionLearningTargetReview(service, {
            ticketId: "ticket",
            target: editedTarget,
            policyVersion: review.policyVersion,
          }),
        ).toBe(true);
        expect(
          await f.app.confirmResolutionLearningTargetReview(service, {
            ticketId: "ticket",
            target: laterTarget,
            policyVersion: review.policyVersion,
          }),
        ).toBe(true);
      }
      expect((await f.source()).reviewBindingCount).toBe(3);
      expect(
        (await f.rows()).filter(
          (row) => row.kind === "resolution_learning_review",
        ),
      ).toHaveLength(3);
      const exactRejectedTarget = laterTargets[1]!;
      const beforeRejection = await f.rows();
      await f.app.reviewResolutionLearningProposal(
        staff,
        {
          ...review,
          ...f.command("reject-exact-current-draft"),
          expectedWorkGeneration: (await f.work()).workGeneration,
          target: exactRejectedTarget,
          decision: "reject",
          reason: "This exact draft needs a correction.",
        },
        f.trust.targetGuard(exactRejectedTarget),
      );
      expect(await f.rows()).toHaveLength(beforeRejection.length + 2);
      expect((await f.source()).reviewBindingCount).toBe(3);
      expect(
        await f.app.confirmResolutionLearningTargetReview(service, {
          ticketId: "ticket",
          target: exactRejectedTarget,
          policyVersion: review.policyVersion,
        }),
      ).toBe(false);
      expect(
        await f.app.confirmResolutionLearningTargetReview(service, {
          ticketId: "ticket",
          target: laterTargets[0]!,
          policyVersion: review.policyVersion,
        }),
      ).toBe(true);
      expect(
        await f.app.confirmResolutionLearningTargetReview(service, {
          ticketId: "ticket",
          target: editedTarget,
          policyVersion: review.policyVersion,
        }),
      ).toBe(true);
      const fourthTarget = target({
        articleRevision: 16,
        contentHash: "a".repeat(64),
        sourceSnapshotGeneration: 9,
        sourceSnapshotHash: "b".repeat(64),
        orderedReferencesHash: "c".repeat(64),
      });
      f.trust.setTarget(fourthTarget);
      const saturated = await f.rows();
      await expect(
        f.app.reviewResolutionLearningProposal(
          staff,
          {
            ...review,
            ...f.command("new-review-binding-at-capacity"),
            expectedWorkGeneration: (await f.work()).workGeneration,
            target: fourthTarget,
          },
          f.trust.targetGuard(fourthTarget),
        ),
      ).rejects.toMatchObject({ name: "SupportDeskLimitError" });
      expect(await f.rows()).toEqual(saturated);
      expect(
        await f.app.confirmResolutionLearningTargetReview(service, {
          ticketId: "ticket",
          target: editedTarget,
          policyVersion: review.policyVersion,
        }),
      ).toBe(true);
      const disabled = f.freshApplication({
        assistantHandlingEnabled: false,
        resolutionLearning: { enabled: false },
      });
      expect(
        await disabled.confirmResolutionLearningSource(
          service,
          owner.sourceFence,
        ),
      ).toBe(true);
      expect(
        await disabled.confirmResolutionLearningTargetReview(service, {
          ticketId: "ticket",
          target: editedTarget,
          policyVersion: review.policyVersion,
        }),
      ).toBe(true);
      await disabled.reopenTicket(staff, f.command("reopened-reviewed-source"));
      expect(
        await disabled.confirmResolutionLearningSource(
          service,
          owner.sourceFence,
        ),
      ).toBe(false);
      expect(
        await disabled.confirmResolutionLearningTargetReview(service, {
          ticketId: "ticket",
          target: editedTarget,
          policyVersion: review.policyVersion,
        }),
      ).toBe(false);
      await expect(
        f.app.reviewResolutionLearningProposal(
          staff,
          { ...review, ...f.command("stale-source-review") },
          f.trust.targetGuard(exactRejectedTarget),
        ),
      ).rejects.toThrow();
      await disabled.resolveTicket(
        staff,
        f.command("reresolve-reviewed-source"),
      );
      expect(
        await disabled.confirmResolutionLearningSource(
          service,
          owner.sourceFence,
        ),
      ).toBe(false);
      const currentTicket = (await f.app.readStaffTicket(staff, "ticket"))
        .ticket;
      const currentSource = await f.source();
      await f.app.submitResolutionEvidence(staff, {
        ...f.command("fresh-proof-after-reviewed-cycle"),
        expectedRevision: currentTicket.revision,
        resolutionCycle: currentSource.resolutionCycle,
        evidence: {
          kind: "staff_verified_fix",
          solutionMessageId: "working-solution",
          verificationReference: "new-cycle-human-verification",
        },
      });
      expect((await f.source()).state).toBe("eligible");
      expect(
        await f.app.confirmResolutionLearningSource(service, owner.sourceFence),
      ).toBe(false);
      expect(
        await f.app.confirmResolutionLearningTargetReview(service, {
          ticketId: "ticket",
          target: editedTarget,
          policyVersion: review.policyVersion,
        }),
      ).toBe(false);
      expect(
        await f.app.confirmResolutionLearningTargetReview(service, {
          ticketId: "ticket",
          target: laterTargets[0]!,
          policyVersion: review.policyVersion,
        }),
      ).toBe(false);
    });

    it("retains a body-free request identity for reconciliation after the host deletes the ticket row", async () => {
      const f = resolutionLearningFixture(createStore(), {
        resolutionLearning: { checks: independentChecks() },
      });
      const key = await eligible(f);
      const delivery = await prepareDelivery(f, await claim(f, key));
      await f.app.finishResolutionLearningWork(service, {
        ...delivery.owner.fence,
        ...stepFence(delivery.prepared),
        disposition: "unknown",
        reason: "remote write may have been accepted",
      });
      await f.app.withdrawResolutionLearningSource(staff, {
        ...f.command("withdraw-before-host-ticket-deletion"),
        reason: "privacy_withdrawal",
      });
      const retained = await f.rows();
      const source = retained.find(
        (row) => row.kind === "resolution_learning_source",
      );
      const work = retained.find(
        (row) => row.kind === "resolution_learning_work",
      );
      expect(source).toMatchObject({
        state: "withdrawn",
        reconciliationPending: true,
      });
      expect(work).not.toHaveProperty("candidate");
      expect(work).not.toHaveProperty("exactRequest");
      await f.backing
        .collection(supportRecords)
        .delete({ partition: "ticket", id: "ticket" });
      const remaining = await f.rows();
      expect(remaining).toHaveLength(retained.length - 1);
      expect(remaining).toEqual(
        expect.arrayContaining(retained.filter((row) => row.id !== "ticket")),
      );
      const view = await f.app.readResolutionLearningReconciliation(
        service,
        "ticket",
      );
      expect(view).toMatchObject({
        state: "withdrawn",
        reconciliationPending: true,
      });
      expect(view.destinations).toHaveLength(1);
      expect(view.destinations[0]).toMatchObject({
        stepId: delivery.prepared.stepId,
        requestHash: delivery.prepared.requestHash,
        requestIdentityStatus: "available",
      });
      expect(view.destinations[0]!.requestIdentity).toEqual({
        operation: delivery.exactRequest.operation,
        commandId: delivery.exactRequest.commandId,
        articleId: delivery.exactRequest.articleId,
        originalExpectedGeneration:
          delivery.exactRequest.originalExpectedGeneration,
      });
      const privateView = JSON.stringify(view);
      for (const forbidden of [
        "draftPayload",
        "sourceReferences",
        "candidate",
        candidate.problem,
        candidate.solution,
        "Open Workspace and choose Export.",
        ...delivery.exactRequest.sourceReferences.map(
          (reference) => reference.id,
        ),
      ])
        expect(privateView).not.toContain(forbidden);
      expect(await f.rows()).toEqual(remaining);
    });

    it("scrubs withdrawn private bodies while retaining the uncertain destination and exact opaque recovery fence", async () => {
      const f = resolutionLearningFixture(createStore(), {
        resolutionLearning: { checks: independentChecks() },
      });
      const key = await eligible(f);
      const delivery = await prepareDelivery(f, await claim(f, key));
      await f.app.finishResolutionLearningWork(service, {
        ...delivery.owner.fence,
        ...stepFence(delivery.prepared),
        disposition: "unknown",
        reason: "possible late remote acceptance",
      });
      const destinations = (await f.source()).destinations;
      expect(destinations).toHaveLength(1);
      await f.app.withdrawResolutionLearningSource(staff, {
        ...f.command("privacy-withdrawal"),
        reason: "privacy_withdrawal",
      });
      const source = await f.source();
      const work = await f.work("ticket", key.sourceGeneration);
      expect(source).toMatchObject({
        state: "withdrawn",
        reconciliationPending: true,
        destinations,
      });
      expect(source.evidence).toBeUndefined();
      expect(source.product).toBeUndefined();
      expect(work.candidate).toBeUndefined();
      expect(work.exactRequest).toBeUndefined();
      expect(work.evidence).toBeUndefined();
      expect(work.product).toBeUndefined();
      expect(work.stepId).toBe(delivery.prepared.stepId);
      expect(work.requestHash).toBe(delivery.prepared.requestHash);
      expect(JSON.stringify({ source, work })).not.toContain(candidate.problem);
      await expect(
        f.app.prepareResolutionLearningStep(service, delivery.command),
      ).rejects.toThrow();
      const currentTicket = (await f.app.readStaffTicket(staff, "ticket"))
        .ticket;
      const beforeFreshProof = await f.rows();
      await f.app.submitResolutionEvidence(staff, {
        ...f.command("new-proof-cannot-reactivate-withdrawn-source"),
        expectedRevision: currentTicket.revision,
        resolutionCycle: source.resolutionCycle,
        evidence: {
          kind: "staff_verified_fix",
          solutionMessageId: "working-solution",
          verificationReference: "new-verification-after-permanent-withdrawal",
        },
      });
      expect((await f.source()).state).toBe("withdrawn");
      expect((await f.source()).evidence).toBeUndefined();
      expect(
        (await f.rows()).filter(
          (row) => row.kind === "resolution_learning_work",
        ),
      ).toHaveLength(
        beforeFreshProof.filter(
          (row) => row.kind === "resolution_learning_work",
        ).length,
      );
      f.advance(3_600_001);
      expect((await f.source()).destinations).toEqual(destinations);
      expect(
        await f.app.claimResolutionLearningWork(service, {
          ...key,
          workerId: "recovery",
          claimId: "after-withdrawal",
          leaseMilliseconds: 10_000,
        }),
      ).toBeNull();
    });
  });
}
