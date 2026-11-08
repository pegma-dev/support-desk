import {
  defaultSupportDeskLimits,
  resolutionLearningDeliveryBinding,
  supportPermissions,
  type NotificationInput,
  type ResolutionLearningCandidate,
  type ResolutionLearningClaim,
  type ResolutionLearningDeliveryRequest,
  type ResolutionLearningModelBinding,
  type ResolutionLearningPreparedStep,
  type ResolutionLearningProcessing,
} from "@pegma/support-desk-application";
import { describe, expect, it } from "vitest";
import { observeAssistantScans } from "../test/assistant-turn-fixtures.js";
import {
  learningCustomer as customer,
  learningService as service,
  learningStaff as staff,
  learningStores,
  resolutionLearningFixture,
} from "../test/resolution-learning-fixtures.js";

type Fixture = ReturnType<typeof resolutionLearningFixture>;

const notification: NotificationInput = {
  id: "learning-human-notification",
  recipientRef: "synthetic-support-queue",
  templateId: "synthetic.ticket",
  templateVersion: 1,
  variables: {},
  subject: "Synthetic support update",
  outboundMessageId: "<learning-capacity@fixtures.invalid>",
};

function maximumProcessing(): ResolutionLearningProcessing {
  const escaped = "\ud800".repeat(200);
  return {
    provider: escaped,
    model: escaped,
    requestId: escaped,
    failureCategory: escaped,
    currency: escaped,
    inputTokens: Number.MAX_SAFE_INTEGER,
    outputTokens: Number.MAX_SAFE_INTEGER,
    costMicros: Number.MAX_SAFE_INTEGER,
  };
}

function bytes(value: unknown): number {
  return JSON.stringify(value).length * 2;
}

async function eligible(f: Fixture) {
  await f.terminal("ticket", false, false);
  await f.confirm();
  expect((await f.source()).state).toBe("eligible");
}

async function prepareDelivery(
  f: Fixture,
  articleId = "workspace-export",
  references?: ResolutionLearningDeliveryRequest["sourceReferences"],
) {
  const proposal = await f.prepareCandidate();
  const owner = await f.claim(`kb-${articleId}`, "kb-worker");
  const source = await f.source();
  const exactRequest: ResolutionLearningDeliveryRequest = {
    operation: "create",
    articleId,
    collectionId: "workspace-help",
    draftPayload: JSON.stringify(proposal.candidate),
    sourceReferences: references ?? [
      {
        id: source.sourceId,
        system: "pegma.support-desk",
        resourceId: "ticket",
        version: owner.sourceFence.sourceBindingHash,
      },
    ],
    originalExpectedGeneration: 0,
    commandId: `fixed-create-${articleId}`,
    correlationId: "synthetic-learning-capacity",
  };
  const policyVersion = "synthetic-check-policy-v1";
  const targetDecisionHash = "d".repeat(64);
  const binding = await resolutionLearningDeliveryBinding({
    candidateHash: proposal.candidateHash,
    sourceBindingHash: owner.sourceFence.sourceBindingHash,
    policyVersion,
    targetDecisionHash,
    applicability: proposal.candidate.applicability,
    exactRequest,
  });
  f.trust.issueChecks("independent-checks", binding);
  const command = {
    ...owner.fence,
    step: "kb_delivery" as const,
    candidateHash: proposal.candidateHash,
    verifiedCheckReceipt: "independent-checks",
    policyVersion,
    targetDecisionHash,
    exactRequest,
  };
  return { owner, exactRequest, command };
}

for (const [name, createStore] of learningStores) {
  describe(`resolution learning physical capacity (${name})`, () => {
    it.each([false, true])(
      "preallocates one source row, thirteen human rows and two withdrawal rows at the exact create boundary (mail: %s)",
      async (withMail) => {
        const minimum = withMail ? 24 : 23;
        for (const maximum of [minimum - 1, minimum]) {
          const f = resolutionLearningFixture(createStore(), {
            assistantTurns: {},
            limits: { maxRecordsPerTicket: maximum, maxMessagesPerTicket: 2 },
          });
          const input = {
            ...f.createInput(),
            ...(withMail ? { notification } : {}),
          };
          if (maximum < minimum) {
            await expect(
              f.app.createCustomerTicket(customer, input),
            ).rejects.toMatchObject({
              name: "SupportDeskLimitError",
              field: "ticket_partition",
            });
            expect(await f.rows()).toEqual([]);
          } else {
            await f.app.createCustomerTicket(customer, input);
            const rows = await f.rows();
            expect(rows).toHaveLength(withMail ? 9 : 8);
            expect(
              rows.filter((row) => row.kind === "resolution_learning_source"),
            ).toHaveLength(1);
            expect(maximum - rows.length).toBe(15);
          }
        }
      },
    );

    it("retains the twelve-row reserve for unenrolled assistant tickets", async () => {
      const f = resolutionLearningFixture(createStore(), {
        assistantTurns: {},
        resolutionLearning: { enabled: false },
        limits: { maxRecordsPerTicket: 19, maxMessagesPerTicket: 2 },
      });
      await f.create();
      const rows = await f.rows();
      expect(rows).toHaveLength(7);
      expect(
        rows.some((row) => row.kind === "resolution_learning_source"),
      ).toBe(false);
      expect(19 - rows.length).toBe(12);
      await f.app.requestPerson(customer, f.command("unenrolled-person"));
      const current = (await f.app.readStaffTicket(staff, "ticket")).ticket;
      await f.app.takeOverTicket(staff, {
        ...f.command("unenrolled-takeover"),
        expectedRevision: current.revision,
        expectedHandlingGeneration: current.handling!.generation,
      });
      await f.app.replyAsStaff(staff, {
        ...f.command("unenrolled-human"),
        messageId: "human",
        body: "A human response",
        notification,
      });
      await f.app.confirmCustomerSuccess(customer, {
        ...f.command("unenrolled-success"),
        lastSeenVisibleMessageId: "human",
      });
      expect(await f.rows()).toHaveLength(19);
    });

    it.each([false, true])(
      "spends the enrolled reserve only on handoff, takeover, eligible confirmation and the first human delivery (create mail: %s)",
      async (withCreateMail) => {
        const maximum = withCreateMail ? 24 : 23;
        const f = resolutionLearningFixture(createStore(), {
          assistantTurns: {},
          limits: { maxRecordsPerTicket: maximum, maxMessagesPerTicket: 2 },
        });
        await f.app.createCustomerTicket(customer, {
          ...f.createInput(),
          ...(withCreateMail
            ? { notification: { ...notification, id: "create-notification" } }
            : {}),
        });
        const before = await f.rows();
        await expect(
          f.app.replyToCustomerTicket(customer, {
            ...f.command("ordinary-at-learning-reserve"),
            messageId: "ordinary",
            body: "One more detail",
          }),
        ).rejects.toMatchObject({ name: "SupportDeskLimitError" });
        expect(await f.rows()).toEqual(before);
        await f.app.requestPerson(
          customer,
          f.command("person-at-learning-reserve"),
        );
        expect(await f.rows()).toHaveLength(before.length + 3);
        const current = (await f.app.readStaffTicket(staff, "ticket")).ticket;
        await f.app.takeOverTicket(staff, {
          ...f.command("takeover-at-learning-reserve"),
          expectedRevision: current.revision,
          expectedHandlingGeneration: current.handling!.generation,
        });
        expect(await f.rows()).toHaveLength(before.length + 5);
        const controls = await f.rows();
        await expect(
          f.app.addNote(staff, {
            ...f.command("note-cannot-spend-human-tail"),
            messageId: "note",
            body: "Private investigation",
          }),
        ).rejects.toMatchObject({ name: "SupportDeskLimitError" });
        expect(await f.rows()).toEqual(controls);
        await f.app.replyAsStaff(staff, {
          ...f.command("reserved-first-human"),
          messageId: "first-human",
          body: "A human verified the export instructions.",
          notification,
        });
        expect(await f.rows()).toHaveLength(before.length + 9);
        await f.confirm();
        const rows = await f.rows();
        expect(rows).toHaveLength(maximum - 2);
        expect(
          rows.filter((row) => row.kind === "resolution_learning_work"),
        ).toHaveLength(1);
        expect((await f.source()).state).toBe("eligible");
        expect(
          (await f.app.readCustomerTicket(customer, "ticket")).messages,
        ).toHaveLength(2);
        await expect(
          f.app.changePriority(staff, {
            ...f.command("ordinary-cannot-spend-withdrawal-reserve"),
            priority: "high",
          }),
        ).rejects.toMatchObject({
          name: "SupportDeskLimitError",
          field: "ticket_partition",
        });
        const withdrawal = {
          ...f.command("permanent-withdrawal-at-ordinary-cap"),
          reason: "privacy_withdrawal" as const,
        };
        const withdrawn = await f.app.withdrawResolutionLearningSource(
          staff,
          withdrawal,
        );
        expect(withdrawn.state).toBe("withdrawn");
        const full = await f.rows();
        expect(full).toHaveLength(maximum);
        expect(
          full
            .filter((row) => !rows.some((prior) => prior.id === row.id))
            .map((row) => row.kind)
            .sort(),
        ).toEqual(["audit", "resolution_learning_receipt"]);
        expect(
          await f.app.withdrawResolutionLearningSource(staff, withdrawal),
        ).toEqual(withdrawn);
        await f.app.withdrawResolutionLearningSource(staff, {
          ...f.command("already-withdrawn-noop"),
          reason: "source_access_revoked",
        });
        expect(await f.rows()).toEqual(full);
      },
    );

    it("preserves the six-row human-and-withdrawal tail through controls, then spends four rows on human delivery", async () => {
      const f = resolutionLearningFixture(createStore(), {
        limits: { maxRecordsPerTicket: 25, maxMessagesPerTicket: 3 },
      });
      await f.create();
      const answer = await f.assistantInput();
      await f.app.replyAsAssistant(service, answer);
      await f.confirm();
      await f.app.requestPerson(
        customer,
        f.command("request-after-confirmation"),
      );
      const current = (await f.app.readStaffTicket(staff, "ticket")).ticket;
      await f.app.takeOverTicket(staff, {
        ...f.command("takeover-at-six-row-tail"),
        expectedRevision: current.revision,
        expectedHandlingGeneration: current.handling!.generation,
      });
      const tail = await f.rows();
      expect(25 - tail.length).toBe(6);
      await expect(
        f.app.confirmCustomerSuccess(customer, {
          ...f.command("control-cannot-spend-six-row-tail"),
          lastSeenVisibleMessageId: answer.messageId,
        }),
      ).rejects.toMatchObject({
        name: "SupportDeskLimitError",
        field: "ticket_partition",
      });
      expect(await f.rows()).toEqual(tail);
      await f.app.replyAsStaff(staff, {
        ...f.command("human-spends-four-row-tail"),
        messageId: "human-at-tail",
        body: "A human can continue this conversation.",
        notification,
      });
      const afterHuman = await f.rows();
      expect(25 - afterHuman.length).toBe(2);
      await f.app.withdrawResolutionLearningSource(staff, {
        ...f.command("withdrawal-spends-final-two-rows"),
        reason: "privacy_withdrawal",
      });
      expect(await f.rows()).toHaveLength(25);
    });

    it("persists enrollment and its withdrawal reserve independently of the processing switch", async () => {
      const f = resolutionLearningFixture(createStore(), {
        resolutionLearning: { enabled: false },
        limits: { maxRecordsPerTicket: 11 },
      });
      await f.create(false);
      const expectedRevision = (await f.app.readStaffTicket(staff, "ticket"))
        .ticket.revision;
      const before = await f.rows();
      await expect(
        f.app.enrollResolutionLearning(staff, {
          ...f.command("enrollment-disabled"),
          expectedRevision,
        }),
      ).rejects.toThrow();
      expect(await f.rows()).toEqual(before);
      const enabled = f.freshApplication({
        resolutionLearning: { enabled: true },
      });
      await enabled.enrollResolutionLearning(staff, {
        ...f.command("explicit-enrollment"),
        expectedRevision,
      });
      const enrolled = await f.rows();
      expect(enrolled).toHaveLength(9);
      expect(
        enrolled.filter((row) => row.kind === "resolution_learning_source"),
      ).toHaveLength(1);
      const disabled = f.freshApplication({
        resolutionLearning: { enabled: false },
      });
      await expect(
        disabled.changePriority(staff, {
          ...f.command("disabled-source-still-reserves-withdrawal"),
          priority: "high",
        }),
      ).rejects.toMatchObject({
        name: "SupportDeskLimitError",
        field: "ticket_partition",
      });
      expect(await f.rows()).toEqual(enrolled);
      await disabled.withdrawResolutionLearningSource(staff, {
        ...f.command("disabled-source-permanent-withdrawal"),
        reason: "source_deleted",
      });
      const withdrawn = await f.rows();
      expect(withdrawn).toHaveLength(11);
      expect(
        (
          await enabled.enrollResolutionLearning(staff, {
            ...f.command("cannot-reactivate-withdrawn-enrollment"),
            expectedRevision,
          })
        ).state,
      ).toBe("withdrawn");
      expect(await f.rows()).toEqual(withdrawn);
    });

    it("keeps the configured physical cap at its existing default and hard maximum", () => {
      expect(defaultSupportDeskLimits.maxRecordsPerTicket).toBe(512);
      expect(() =>
        resolutionLearningFixture(createStore(), {
          limits: { maxRecordsPerTicket: 2_000 },
        }),
      ).not.toThrow();
      expect(() =>
        resolutionLearningFixture(createStore(), {
          limits: { maxRecordsPerTicket: 2_001 },
        }),
      ).toThrow();
      expect(() =>
        resolutionLearningFixture(createStore(), {
          resolutionLearning: { maxReviewBindings: 64 },
        }),
      ).not.toThrow();
    });

    it.each([
      { maxGenerations: 9 },
      { maxTargets: 5 },
      { maxModelAttempts: 5 },
      { maxReviewBindings: 65 },
      { maxLeaseMilliseconds: 300_001 },
      { maxWorkMilliseconds: 3_600_001 },
    ])(
      "rejects a learning configuration beyond its hard bounds (%j)",
      (resolutionLearning) => {
        expect(() =>
          resolutionLearningFixture(createStore(), { resolutionLearning }),
        ).toThrow();
      },
    );

    it.each([
      { configured: undefined, maximum: 4 },
      { configured: 8, maximum: 8 },
    ])(
      "retains at most $maximum generation jobs without blocking a new human resolution",
      async ({ configured, maximum }) => {
        const f = resolutionLearningFixture(createStore(), {
          resolutionLearning: {
            ...(configured === undefined ? {} : { maxGenerations: configured }),
          },
        });
        await eligible(f);
        for (let generation = 2; generation <= maximum + 1; generation += 1) {
          await f.app.reopenTicket(staff, f.command(`reopen-${generation}`));
          await f.app.replyAsStaff(staff, {
            ...f.command(`solution-${generation}`),
            messageId: `solution-${generation}`,
            body: `A human verified solution ${generation}.`,
          });
          await f.confirm();
          expect(
            (await f.app.readStaffTicket(staff, "ticket")).ticket.status,
          ).toBe("resolved");
        }
        const rows = await f.rows();
        expect(
          rows.filter((row) => row.kind === "resolution_learning_work"),
        ).toHaveLength(maximum);
        expect(
          rows.filter((row) => row.kind === "customer_success"),
        ).toHaveLength(maximum + 1);
        expect(await f.source()).toMatchObject({
          generationCount: maximum,
          heldReason: "learning_capacity",
        });
        await f.app.replyToCustomerTicket(customer, {
          ...f.command("customer-after-learning-saturation"),
          messageId: "customer-after-saturation",
          body: "I still need a person.",
        });
        await f.app.replyAsStaff(staff, {
          ...f.command("staff-after-learning-saturation"),
          messageId: "staff-after-saturation",
          body: "A human can continue helping.",
        });
        expect(
          (await f.rows()).filter(
            (row) => row.kind === "resolution_learning_work",
          ),
        ).toHaveLength(maximum);
      },
    );

    it.each([
      { configured: undefined, maximum: 2 },
      { configured: 4, maximum: 4 },
    ])(
      "retains $maximum unknown target bindings at saturation and preserves ordinary human work",
      async ({ configured, maximum }) => {
        const f = resolutionLearningFixture(createStore(), {
          resolutionLearning: {
            maxGenerations: maximum + 1,
            ...(configured === undefined ? {} : { maxTargets: configured }),
          },
        });
        await eligible(f);
        const retainedWorks = [];
        for (let targetNumber = 1; targetNumber <= maximum; targetNumber += 1) {
          const delivery = await prepareDelivery(
            f,
            `unknown-target-${targetNumber}`,
          );
          const prepared = await f.app.prepareResolutionLearningStep(
            service,
            delivery.command,
          );
          await f.app.finishResolutionLearningWork(service, {
            ...delivery.owner.fence,
            stepId: prepared.stepId,
            requestHash: prepared.requestHash,
            disposition: "unknown",
            reason: "write may have been accepted",
          });
          retainedWorks.push(await f.work());
          if (targetNumber < maximum) {
            await f.app.reopenTicket(
              staff,
              f.command(`target-cycle-${targetNumber}`),
            );
            await f.app.replyAsStaff(staff, {
              ...f.command(`target-solution-${targetNumber}`),
              messageId: `target-solution-${targetNumber}`,
              body: "A different human-verified solution.",
            });
            await f.confirm();
          }
        }
        const sourceBefore = await f.source();
        expect(sourceBefore.destinations).toHaveLength(maximum);
        await f.app.replyToCustomerTicket(customer, {
          ...f.command("customer-with-unknown-destination"),
          messageId: "new-customer",
          body: "The solution needs a small correction.",
        });
        await f.app.replyAsStaff(staff, {
          ...f.command("human-with-unknown-destination"),
          messageId: "new-human",
          body: "A corrected human solution.",
        });
        await f.confirm();
        expect(await f.source()).toMatchObject({
          state: "eligible",
          destinations: sourceBefore.destinations,
        });
        const excessTarget = await prepareDelivery(
          f,
          "target-beyond-retained-capacity",
        );
        const beforeTargetAdmission = await f.rows();
        await expect(
          f.app.prepareResolutionLearningStep(service, excessTarget.command),
        ).rejects.toMatchObject({
          name: "SupportDeskLimitError",
          field: "ticket_partition",
        });
        expect(await f.rows()).toEqual(beforeTargetAdmission);
        await f.app.finishResolutionLearningWork(service, {
          ...excessTarget.owner.fence,
          disposition: "held",
          reason: "learning_capacity",
        });
        expect(await f.work()).toMatchObject({ status: "held" });
        expect((await f.work()).exactRequest).toBeUndefined();
        expect((await f.source()).state).toBe("eligible");
        for (const workBefore of retainedWorks) {
          const retained = await f.work("ticket", workBefore.sourceGeneration);
          expect(retained.exactRequest).toEqual(workBefore.exactRequest);
          expect(retained.stepId).toBe(workBefore.stepId);
          expect(retained.requestHash).toBe(workBefore.requestHash);
        }
        expect(
          (await f.rows()).filter(
            (row) => row.kind === "resolution_learning_work",
          ),
        ).toHaveLength(maximum + 1);
        await f.app.changePriority(staff, {
          ...f.command("human-after-target-admission-hold"),
          priority: "high",
        });
        f.advance(3_600_001);
        expect((await f.source()).destinations).toEqual(
          sourceBefore.destinations,
        );
      },
    );

    it.each([
      { configured: undefined, maximum: 2 },
      { configured: 4, maximum: 4 },
    ])(
      "bounds new model preparations at $maximum while retaining earlier attempts and unknown accounting in the same row",
      async ({ configured, maximum }) => {
        const f = resolutionLearningFixture(createStore(), {
          resolutionLearning: {
            ...(configured === undefined
              ? {}
              : { maxModelAttempts: configured }),
          },
        });
        await eligible(f);
        const rowCount = (await f.rows()).length;
        for (let attempt = 1; attempt <= maximum; attempt += 1) {
          const owner = await f.claim(`attempt-${attempt}`);
          const prepared = await f.app.prepareResolutionLearningStep(service, {
            ...owner.fence,
            step: "model",
            binding: f.modelBinding(owner, {
              usageReservationId: `usage-${attempt}`,
              inputFingerprint: String(attempt).repeat(64),
            }),
          });
          await f.app.finishResolutionLearningWork(service, {
            ...owner.fence,
            stepId: prepared.stepId,
            requestHash: prepared.requestHash,
            disposition: "retry",
            retryAt: f.clock.now(),
            accounting: "unknown",
            processing: { requestId: `request-${attempt}` },
          });
          const work = await f.work();
          expect(work.modelAttempts).toHaveLength(attempt);
          expect(
            work.modelAttempts.every((item) => item.accounting === "unknown"),
          ).toBe(true);
          expect(await f.rows()).toHaveLength(rowCount);
        }
        const exhausted = await f.claim("exhausted-attempt");
        const before = await f.rows();
        await expect(
          f.app.prepareResolutionLearningStep(service, {
            ...exhausted.fence,
            step: "model",
            binding: f.modelBinding(exhausted),
          }),
        ).rejects.toThrow();
        expect(await f.rows()).toEqual(before);
      },
    );

    it("reserves complete UTF-16 completion, receipt and replacement-claim envelopes before admitting paid work", async () => {
      const f = resolutionLearningFixture(createStore(), {
        resolutionLearning: { maxModelAttempts: 4 },
      });
      await eligible(f);
      const escaped = "\ud800".repeat(200);
      let admitted = 0;
      for (let attempt = 1; attempt <= 4; attempt += 1) {
        const owner = await f.claim(`${attempt}${escaped.slice(1)}`, escaped);
        const binding = f.modelBinding(
          owner,
          attempt === 1
            ? { usageReservationId: `${attempt}${escaped.slice(1)}` }
            : {
                inputFingerprint: "f".repeat(64),
                configVersion: escaped,
                promptVersion: escaped,
                modelVersion: escaped,
                checkPolicyVersion: escaped,
                budgetsHash: "e".repeat(64),
                usageReservationId: `${attempt}${escaped.slice(1)}`,
              },
        );
        expect(owner.fence.workerId.length).toBe(200);
        expect(owner.fence.claimId.length).toBe(200);
        expect(binding.usageReservationId.length).toBe(200);
        expect(bytes(binding.usageReservationId)).toBe(2 * (2 + 1 + 199 * 6));
        const before = await f.rows();
        const result = await f.app
          .prepareResolutionLearningStep(service, {
            ...owner.fence,
            step: "model",
            binding,
          })
          .then(
            (prepared) => ({ prepared }),
            (error: unknown) => ({ error }),
          );
        if ("error" in result) {
          expect(result.error).toMatchObject({
            name: "SupportDeskLimitError",
            field: "serialized_record",
            maximum: 60_000,
          });
          expect(await f.rows()).toEqual(before);
          break;
        }
        admitted += 1;
        const finish = {
          ...owner.fence,
          stepId: result.prepared.stepId,
          requestHash: result.prepared.requestHash,
          disposition: "retry" as const,
          retryAt: f.clock.now(),
          reason: escaped,
          accounting: "unknown" as const,
          processing: maximumProcessing(),
        };
        await f.app.finishResolutionLearningWork(service, finish);
        const work = await f.work();
        expect(bytes(work)).toBeLessThanOrEqual(60_000);
        expect(work.modelAttempts).toHaveLength(admitted);
        const rows = await f.rows();
        await f.app.finishResolutionLearningWork(service, finish);
        expect(await f.rows()).toEqual(rows);
      }
      expect(admitted).toBeGreaterThan(0);
      expect(admitted).toBeLessThan(4);
      await f.app.replyToCustomerTicket(customer, {
        ...f.command("customer-after-byte-hold"),
        messageId: "customer-byte-hold",
        body: "Human support remains available.",
      });
      await f.app.replyAsStaff(staff, {
        ...f.command("staff-after-byte-hold"),
        messageId: "staff-byte-hold",
        body: "A human can continue this ticket.",
      });
    });

    it("rejects a paid-work boundary that only fits when the candidate hash and accounted usage are omitted", async () => {
      const escaped = "\ud800".repeat(200);
      const processing = maximumProcessing();
      const baseCandidate: ResolutionLearningCandidate = {
        problem: "Export a workspace.",
        applicability: {
          productId: "workspace",
          version: "2.3.0",
          buildId: "build-verified-230",
        },
        steps: ["Open Workspace."],
        solution: "Download the export.",
        validationRequirements: ["Verify the export opens."],
      };
      const candidateRoom = 16_000 - bytes(baseCandidate);
      const candidate: ResolutionLearningCandidate = {
        ...baseCandidate,
        solution:
          baseCandidate.solution +
          "\ud800".repeat(Math.floor(candidateRoom / 12)) +
          "x".repeat((candidateRoom % 12) / 2),
      };
      expect(bytes(candidate)).toBe(16_000);

      const setup = async (f: Fixture) => {
        await eligible(f);
        const first = await f.claim("first-model-claim", "model-worker");
        const prepared = await f.app.prepareResolutionLearningStep(service, {
          ...first.fence,
          step: "model",
          binding: f.modelBinding(first),
        });
        await f.app.finishResolutionLearningWork(service, {
          ...first.fence,
          stepId: prepared.stepId,
          requestHash: prepared.requestHash,
          disposition: "retry",
          accounting: "accounted",
          retryAt: f.clock.now(),
          processing,
        });
        return f.claim("second-model-claim", "model-worker");
      };
      const completeAndReclaim = async (
        f: Fixture,
        owner: ResolutionLearningClaim,
        prepared: ResolutionLearningPreparedStep,
      ) => {
        const preparedWorkGeneration = (await f.work()).workGeneration;
        await f.app.completeResolutionLearningStep(
          service,
          {
            ...owner.fence,
            stepId: prepared.stepId,
            requestHash: prepared.requestHash,
            step: "model",
            candidate,
            processing,
            accounting: "accounted",
          },
          () => {},
        );
        const completed = await f.work();
        expect(completed.candidateHash).toMatch(/^[a-f0-9]{64}$/);
        expect(
          completed.modelAttempts.every(
            (attempt) => attempt.accounting === "accounted",
          ),
        ).toBe(true);
        expect(bytes(completed)).toBeLessThanOrEqual(60_000);
        const replacement = await f.claim(escaped, "\ud801".repeat(200));
        expect(bytes(await f.work())).toBeLessThanOrEqual(60_000);
        await f.app.finishResolutionLearningWork(service, {
          ...replacement.fence,
          disposition: "retry",
          retryAt: f.clock.now(),
          reason: escaped,
        });
        expect(bytes(await f.work())).toBeLessThanOrEqual(60_000);
        const reclaimed = await f.claim(
          "\ud802".repeat(200),
          "\ud801".repeat(200),
        );
        const final = await f.work();
        expect(final.candidate).toEqual(candidate);
        expect(final.candidateHash).toBe(completed.candidateHash);
        expect(final.modelAttempts).toEqual(completed.modelAttempts);
        expect(final.claim).toEqual(reclaimed.fence);
        expect(bytes(final)).toBeLessThanOrEqual(60_000);
        return {
          preparedWorkGeneration,
          work: final,
          finalBytes: bytes(final),
        };
      };

      // Measure every wrapper, retained attempt, receipt and escaped claim using
      // real application writes. Padding a retained binding changes only its
      // encoded text length: the request, step and completion digests stay 64 hex.
      const control = resolutionLearningFixture(createStore());
      const controlOwner = await setup(control);
      const controlBinding = control.modelBinding(controlOwner);
      const controlPrepared = await control.app.prepareResolutionLearningStep(
        service,
        { ...controlOwner.fence, step: "model", binding: controlBinding },
      );
      const measured = await completeAndReclaim(
        control,
        controlOwner,
        controlPrepared,
      );
      const unsafeFinalBytes = 60_002;
      const binding: ResolutionLearningModelBinding = { ...controlBinding };
      let remaining = (unsafeFinalBytes - measured.finalBytes) / 2;
      expect(remaining).toBeGreaterThan(0);
      for (const field of [
        "configVersion",
        "promptVersion",
        "modelVersion",
        "checkPolicyVersion",
        "usageReservationId",
      ] as const) {
        if (remaining === 0) break;
        const previous = bytes(binding[field]) / 2 - 2;
        const target = Math.min(1_200, previous + remaining);
        const surrogates = Math.floor(target / 6);
        const ascii = Math.min(200 - surrogates, target - surrogates * 6);
        const padded = "\ud800".repeat(surrogates) + "x".repeat(ascii);
        remaining -= bytes(padded) / 2 - 2 - previous;
        Object.assign(binding, { [field]: padded });
        expect(padded.length).toBeLessThanOrEqual(200);
      }
      expect(remaining).toBe(0);
      expect(measured.finalBytes + bytes(binding) - bytes(controlBinding)).toBe(
        unsafeFinalBytes,
      );

      const hashFieldBytes =
        bytes({ candidateHash: "f".repeat(64) }) - bytes({}) + 2;
      const accountedBytes = bytes("accounted") - bytes("unknown");
      expect(hashFieldBytes).toBe(166);
      expect(accountedBytes).toBe(4);
      // Independent byte arithmetic for the old unsafe admission: even its wide
      // claim counters and string payload allowance did not cover these fields.
      const wideClaimCounters =
        2 *
        (bytes(Number.MAX_SAFE_INTEGER) - bytes(measured.work.claimGeneration));
      const stringPayloadAllowance =
        bytes("\ud800".repeat(Math.ceil(bytes(candidate) / 12))) -
        bytes(candidate);
      const workCounterDifference =
        bytes(measured.preparedWorkGeneration) -
        bytes(measured.work.workGeneration);
      const oldReservationBytes =
        unsafeFinalBytes -
        hashFieldBytes -
        accountedBytes +
        wideClaimCounters +
        stringPayloadAllowance +
        workCounterDifference;
      expect(oldReservationBytes).toBeLessThanOrEqual(60_000);
      expect(unsafeFinalBytes).toBeGreaterThan(60_000);

      const boundary = resolutionLearningFixture(createStore());
      const owner = await setup(boundary);
      const normal = boundary.modelBinding(owner);
      expect(bytes(normal)).toBe(bytes(controlBinding));
      const request = {
        ...normal,
        configVersion: binding.configVersion,
        promptVersion: binding.promptVersion,
        modelVersion: binding.modelVersion,
        checkPolicyVersion: binding.checkPolicyVersion,
        usageReservationId: binding.usageReservationId,
      };
      const before = await boundary.rows();
      let paidCalls = 0;
      const admission = await boundary.app
        .prepareResolutionLearningStep(service, {
          ...owner.fence,
          step: "model",
          binding: request,
        })
        .then(
          (prepared) => ({ prepared }),
          (error: unknown) => ({ error }),
        );
      if ("error" in admission) {
        expect(admission.error).toMatchObject({
          name: "SupportDeskLimitError",
          field: "serialized_record",
          maximum: 60_000,
        });
        expect(paidCalls).toBe(0);
        expect(await boundary.rows()).toEqual(before);
        expect((await boundary.work()).claim).toEqual(owner.fence);
      } else {
        paidCalls += 1;
        const completed = await completeAndReclaim(
          boundary,
          owner,
          admission.prepared,
        );
        expect(paidCalls).toBe(1);
        expect(completed.finalBytes).toBe(unsafeFinalBytes);
      }
    });

    it("holds a valid thirty-two-reference KB request that exceeds the full row envelope without truncating it", async () => {
      const f = resolutionLearningFixture(createStore());
      await eligible(f);
      const source = await f.source();
      const references = [
        {
          id: source.sourceId,
          system: "pegma.support-desk",
          resourceId: "ticket",
          version: source.sourceBindingHash!,
        },
        ...Array.from({ length: 31 }, (_, index) => ({
          id: `${index}-${"\ud800".repeat(196)}`,
          system: "\ud800".repeat(200),
          resourceId: "\ud800".repeat(200),
          version: "\ud800".repeat(200),
        })),
      ];
      const delivery = await prepareDelivery(
        f,
        "oversized-inherited-request",
        references,
      );
      expect(delivery.exactRequest.sourceReferences).toHaveLength(32);
      expect(bytes(delivery.exactRequest)).toBeGreaterThan(60_000);
      const before = await f.rows();
      await expect(
        f.app.prepareResolutionLearningStep(service, delivery.command),
      ).rejects.toMatchObject({
        name: "SupportDeskLimitError",
        field: "serialized_record",
      });
      expect(await f.rows()).toEqual(before);
      expect((await f.work()).exactRequest).toBeUndefined();
      expect(delivery.exactRequest.sourceReferences).toEqual(references);
      await f.app.replyAsStaff(staff, {
        ...f.command("human-after-oversized-inheritance"),
        messageId: "human-after-oversize",
        body: "The human workflow continues.",
      });
    });

    it("counts every physical adapter row and returns its cursor without treating a candidate as source authority", async () => {
      const observer = observeAssistantScans(createStore());
      const f = resolutionLearningFixture(observer.store);
      await eligible(f);
      const expectedRows = (await f.rows()).length;
      let cursor: string | undefined;
      let physicalRows = 0;
      const candidates: { ticketId: string; sourceGeneration: number }[] = [];
      for (let pageNumber = 0; pageNumber < expectedRows + 1; pageNumber += 1) {
        const page = await f.app.scanResolutionLearningCandidates(service, {
          limit: 2,
          ...(cursor === undefined ? {} : { cursor }),
        });
        expect(page.pages).toBe(1);
        expect(page.physicalRows).toBeLessThanOrEqual(2);
        expect(page.physicalRows).toBeGreaterThanOrEqual(
          page.candidates.length,
        );
        physicalRows += page.physicalRows;
        candidates.push(...page.candidates);
        expect(observer.calls.at(-1)?.cursor).toBe(cursor);
        if (page.nextCursor === null) break;
        cursor = page.nextCursor;
      }
      expect(physicalRows).toBe(expectedRows);
      expect(candidates).toEqual([
        {
          ticketId: "ticket",
          sourceGeneration: (await f.source()).sourceGeneration,
        },
      ]);
      await f.app.reopenTicket(staff, f.command("source-changed-after-scan"));
      expect(
        await f.app.claimResolutionLearningWork(service, {
          ...candidates[0]!,
          claimId: "stale-hint",
          workerId: "scan-worker",
          leaseMilliseconds: 10_000,
        }),
      ).toBeNull();
      const scans = observer.calls.length;
      await expect(
        f.app.scanResolutionLearningCandidates(
          {
            ...service,
            permissions: service.permissions.filter(
              (permission) => permission !== supportPermissions.learningProcess,
            ),
          },
          { limit: 2 },
        ),
      ).rejects.toThrow();
      expect(observer.calls).toHaveLength(scans);
    });

    it.each(["source invalidation", "work deadline"] as const)(
      "omits work after %s while retaining physical scan progress and reconciliation hints",
      async (invalidation) => {
        const observer = observeAssistantScans(createStore());
        const f = resolutionLearningFixture(observer.store);
        await eligible(f);
        const delivery = await prepareDelivery(f);
        const prepared = await f.app.prepareResolutionLearningStep(
          service,
          delivery.command,
        );
        await f.app.finishResolutionLearningWork(service, {
          ...delivery.owner.fence,
          stepId: prepared.stepId,
          requestHash: prepared.requestHash,
          disposition: "unknown",
          reason: "remote acceptance still needs reconciliation",
        });
        if (invalidation === "source invalidation")
          await f.app.reopenTicket(
            staff,
            f.command("source-invalid-before-candidate-scan"),
          );
        else f.advance(300_001);
        const retained = await f.rows();
        const candidates: { ticketId: string; sourceGeneration: number }[] = [];
        const reconciliation: string[] = [];
        let physicalRows = 0;
        let cursor: string | undefined;
        for (
          let pageNumber = 0;
          pageNumber < retained.length + 1;
          pageNumber += 1
        ) {
          const page = await f.app.scanResolutionLearningCandidates(service, {
            limit: 2,
            ...(cursor === undefined ? {} : { cursor }),
          });
          expect(page.physicalRows).toBeLessThanOrEqual(2);
          expect(page.pages).toBe(1);
          expect(observer.calls.at(-1)?.cursor).toBe(cursor);
          candidates.push(...page.candidates);
          reconciliation.push(...page.reconciliationSources);
          physicalRows += page.physicalRows;
          if (page.nextCursor === null) break;
          cursor = page.nextCursor;
        }
        expect(candidates).toEqual([]);
        expect(physicalRows).toBe(retained.length);
        expect(reconciliation).toEqual(["ticket"]);
        expect((await f.source()).reconciliationPending).toBe(true);
        expect(
          (await f.work("ticket", delivery.owner.fence.sourceGeneration))
            .exactRequest,
        ).toEqual(delivery.exactRequest);
        expect(await f.rows()).toEqual(retained);
      },
    );

    it("rejects an adapter candidate whose physical key disagrees with its authoritative ticket identity", async () => {
      const observer = observeAssistantScans(createStore());
      const f = resolutionLearningFixture(observer.store);
      await eligible(f);
      observer.transformPage((page) => ({
        ...page,
        records: page.records.map((row) =>
          row.value.kind === "resolution_learning_work"
            ? { ...row, key: { ...row.key, partition: "another-ticket" } }
            : row,
        ),
      }));
      await expect(
        f.app.scanResolutionLearningCandidates(service, { limit: 100 }),
      ).rejects.toThrow();
    });
  });
}
