import {
  createSupportDeskApplication,
  resolutionLearningDeliveryBinding,
  type CompleteResolutionLearningStepCommand,
  type PrepareResolutionLearningStepCommand,
  type ResolutionLearningClaim,
  type SupportRecord,
} from "@pegma/support-desk-application";
import { describe, expect, it, vi } from "vitest";
import { createLearningModelExecutor } from "../packages/ai/src/learning-model.js";
import type {
  LearningModelResult,
  VerifiedLearningConfiguration,
} from "../packages/ai/src/learning-ports.js";
import {
  privateLearningCanaries,
  resolutionLearningAiFixture,
} from "../test/resolution-learning-ai-fixtures.js";
import { handlingBarrier } from "../test/handling-fixtures.js";
import {
  learningCustomer,
  learningService,
  learningStaff,
  learningStores,
} from "../test/resolution-learning-fixtures.js";

type Fixture = Awaited<ReturnType<typeof resolutionLearningAiFixture>>;

async function run(f: Fixture) {
  return f.executor.processClaim(await f.claim());
}

async function waitForModelHook(
  barrier: ReturnType<typeof handlingBarrier>,
  pending: ReturnType<Fixture["executor"]["processClaim"]>,
) {
  await Promise.race([
    barrier.reached,
    pending.then((result) => {
      throw new Error(
        `Provider hook was not reached before processing returned: ${JSON.stringify(result)}`,
      );
    }),
  ]);
}

function unsafeConfiguration(f: Fixture, changes: Record<string, unknown>) {
  f.state.configuration = {
    ...f.state.configuration,
    ...changes,
  } as unknown as VerifiedLearningConfiguration;
}

async function expectPrivateHeld(f: Fixture, claim?: ResolutionLearningClaim) {
  const work =
    claim === undefined
      ? await f.work()
      : await f.app.readResolutionLearningWork(learningStaff, claim.fence);
  expect(work.status).toBe("held");
  expect(work.candidate).toBeUndefined();
  expect(work.exactRequest).toBeUndefined();
  expect(work.acknowledgement).toBeUndefined();
  return work;
}

for (const [name, createStore] of learningStores) {
  describe(`private resolution learning model (${name})`, () => {
    it("persists the exact visible-input manifest before reservation and one unapproved candidate without exposing private context", async () => {
      const f = await resolutionLearningAiFixture(createStore());
      const before = await f.app.readCustomerTicket(learningCustomer, "ticket");
      const claim = await f.claim();
      const scan = vi.spyOn(f.app, "scanResolutionLearningCandidates");
      const claimAgain = vi.spyOn(f.app, "claimResolutionLearningWork");
      f.reserve.mockImplementation(async (context) => {
        const work = await f.work();
        expect(work).toMatchObject({
          status: "prepared",
          stage: "model",
          stepId: context.attemptId,
        });
        expect(work.modelAttempts).toHaveLength(1);
        const binding = work.modelAttempts[0]!.binding;
        expect(binding).toMatchObject({
          inputFingerprint: context.inputFingerprint,
          inputManifestHash: context.inputManifestHash,
          usageReservationId: context.usageReservationId,
          configVersion: context.configurationVersion,
          checkPolicyVersion: context.checkPolicyVersion,
        });
        expect(binding.inputManifest.messages).toEqual(
          claim.messages.map(({ messageId, ordinal }) => ({
            messageId,
            ordinal,
          })),
        );
        expect(binding.inputManifest.workingSolutionMessageIds).toEqual(
          claim.workingSolutionMessageIds,
        );
        expect(JSON.stringify(binding.inputManifest)).not.toContain(
          "Open Workspace",
        );
        return {
          outcome: "reserved",
          usageReservationId: context.usageReservationId,
        };
      });
      f.setModel(async (input, context) => {
        expect(context.purpose).toBe("support_learning");
        expect(f.reserve).toHaveBeenCalledOnce();
        expect((await f.work()).modelAttempts[0]?.stepId).toBe(
          context.attemptId,
        );
        expect(input.workingSolution).toEqual([
          "Open Workspace and choose Export.",
        ]);
        return f.answer();
      });
      const result = await f.executor.processClaim(claim);
      expect(result).toMatchObject({
        outcome: "candidate",
        result: { status: "candidate" },
      });
      expect(f.generate).toHaveBeenCalledOnce();
      expect(scan).not.toHaveBeenCalled();
      expect(claimAgain).not.toHaveBeenCalled();
      expect(
        await f.app.readCustomerTicket(learningCustomer, "ticket"),
      ).toEqual(before);
      const work = await f.work();
      expect(work.candidate).toEqual(f.candidate());
      expect(work.candidateHash).toMatch(/^[a-f0-9]{64}$/u);
      expect(work.modelAttempts).toMatchObject([{ accounting: "accounted" }]);
      expect(work.exactRequest).toBeUndefined();
      expect(work.verifiedCheckReceipt).toBeUndefined();
      expect(
        (await f.rows()).filter(
          (row) => row.kind === "resolution_learning_review",
        ),
      ).toEqual([]);
      expect((await f.source()).destinations).toEqual([]);
      expect(f.trust.checkCalls).toEqual([]);
      const [input, context] = f.generate.mock.calls[0]!;
      expect(Object.keys(input).sort()).toEqual([
        "messages",
        "trustedInstructions",
        "workingSolution",
      ]);
      expect(input.messages).toEqual(
        claim.messages.map(({ speaker, body }) => ({ speaker, text: body })),
      );
      for (const value of [
        ...privateLearningCanaries,
        learningCustomer.principalId,
        learningStaff.principalId,
        claim.sourceFence.sourceBindingHash,
        claim.work.product!.receiptId,
        context.operationId,
        context.attemptId,
        context.usageReservationId,
      ])
        expect(JSON.stringify(input)).not.toContain(value);
      expect(f.reconcile).toHaveBeenCalledWith(
        expect.objectContaining({
          purpose: "support_learning",
          attemptId: context.attemptId,
        }),
        { state: "known", usage: f.answer().usage },
      );
    });

    it.each([
      "disabled",
      "unavailable",
      "wrong-purpose",
      "unverified-controls",
      "wrong-controls-purpose",
      "wrong-binding",
      "expired-controls",
      "missing-controls",
      "inactive-authority",
      "missing-processing-permission",
      "unavailable-policy",
      "expired-policy",
    ] as const)(
      "makes no reservation or paid call for %s admission",
      async (variant) => {
        const f = await resolutionLearningAiFixture(createStore());
        if (variant === "disabled" || variant === "unavailable")
          f.state.configurationOutcome = variant;
        if (variant === "wrong-purpose")
          unsafeConfiguration(f, { purpose: "support_answer" });
        if (variant === "unverified-controls")
          unsafeConfiguration(f, {
            dataControls: {
              ...f.state.configuration.dataControls,
              status: "unverified",
            },
          });
        if (variant === "wrong-controls-purpose")
          unsafeConfiguration(f, {
            dataControls: {
              ...f.state.configuration.dataControls,
              purpose: "support_answer",
            },
          });
        if (variant === "wrong-binding")
          unsafeConfiguration(f, {
            dataControls: {
              ...f.state.configuration.dataControls,
              configurationBinding: "another-configuration",
            },
          });
        if (variant === "expired-controls")
          unsafeConfiguration(f, {
            dataControls: {
              ...f.state.configuration.dataControls,
              validUntil: f.clock.now(),
            },
          });
        if (variant === "missing-controls")
          unsafeConfiguration(f, { dataControls: null });
        if (variant === "inactive-authority")
          f.state.authorityOutcome = "inactive";
        if (variant === "missing-processing-permission")
          f.state.authority = {
            ...f.state.authority,
            access: { ...learningService, permissions: [] },
          };
        if (variant === "unavailable-policy")
          f.state.checkPolicyOutcome = "unavailable";
        if (variant === "expired-policy")
          f.state.checkPolicy = {
            ...f.state.checkPolicy,
            validUntil: f.clock.now(),
          };
        await run(f);
        expect(f.generate).not.toHaveBeenCalled();
        expect(f.reserve).not.toHaveBeenCalled();
        expect((await f.work()).candidate).toBeUndefined();
        expect((await f.work()).exactRequest).toBeUndefined();
        expect((await f.source()).state).toBe("eligible");
      },
    );

    it.each([
      "messages",
      "whole-prompt-bytes",
      "whole-prompt-tokens",
      "framing",
      "context",
    ] as const)(
      "accounts for %s before model preparation or paid admission",
      async (variant) => {
        const f = await resolutionLearningAiFixture(createStore());
        if (variant === "messages") f.setBudgets({ maxMessages: 1 });
        if (variant === "whole-prompt-bytes")
          f.setBudgets({ maxInputBytes: 200 });
        if (variant === "whole-prompt-tokens")
          f.setBudgets({ maxInputTokens: 200 });
        if (variant === "framing" || variant === "context") {
          f.countTokens.mockReturnValue(100);
          f.setBudgets(
            variant === "framing"
              ? { maxInputTokens: 100 }
              : { maxContextTokens: 120 },
          );
        }
        await run(f);
        expect(f.generate).not.toHaveBeenCalled();
        expect(f.reserve).not.toHaveBeenCalled();
        expect((await expectPrivateHeld(f)).modelAttempts).toEqual([]);
        if (variant === "whole-prompt-tokens") {
          const serialized = f.countTokens.mock.calls[0]![0];
          expect(serialized).toContain(
            f.state.configuration.trustedInstructions,
          );
          expect(serialized).toContain("workingSolution");
          expect(serialized).toContain("How do I export my workspace?");
        }
      },
    );

    it.each(["configuration", "source", "authority", "policy"] as const)(
      "rechecks %s after the awaited reservation and reconciles not-called usage",
      async (variant) => {
        const f = await resolutionLearningAiFixture(createStore());
        const claim = await f.claim();
        f.reserve.mockImplementation(async (context) => {
          if (variant === "configuration")
            f.state.configurationOutcome = "disabled";
          if (variant === "source")
            await f.app.invalidateResolutionEvidence(learningStaff, {
              ...f.command("revoke-after-reserve"),
              reason: "evidence_revoked",
            });
          if (variant === "authority")
            f.state.authority = {
              ...f.state.authority,
              authorityVersion: "synthetic-replaced-service-v2",
            };
          if (variant === "policy")
            f.state.checkPolicy = {
              ...f.state.checkPolicy,
              binding: "synthetic-replaced-policy-binding-v2",
            };
          return {
            outcome: "reserved",
            usageReservationId: context.usageReservationId,
          };
        });
        await f.executor.processClaim(claim);
        expect(f.reserve).toHaveBeenCalledOnce();
        expect(f.generate).not.toHaveBeenCalled();
        expect(f.reconcile).toHaveBeenCalledWith(expect.anything(), {
          state: "not_called",
        });
        expect((await expectPrivateHeld(f, claim)).modelAttempts).toMatchObject(
          [{ accounting: "not_called" }],
        );
      },
    );

    it.each([
      "product",
      "version",
      "build",
      "self-approval",
      "extra-field",
      "missing-field",
      "malformed",
    ] as const)(
      "holds %s output privately and settles its known provider usage",
      async (variant) => {
        const f = await resolutionLearningAiFixture(createStore());
        const candidate = f.candidate();
        let value: unknown = candidate;
        if (
          variant === "product" ||
          variant === "version" ||
          variant === "build"
        )
          value = {
            ...candidate,
            applicability: {
              ...candidate.applicability,
              ...(variant === "product" ? { productId: "other-product" } : {}),
              ...(variant === "version" ? { version: "2.4.0" } : {}),
              ...(variant === "build"
                ? { buildId: "unverified-customer-build" }
                : {}),
            },
          };
        if (variant === "self-approval")
          value = { ...candidate, privacy: "passed", factual: "passed" };
        if (variant === "extra-field")
          value = { ...candidate, sourceReferences: ["PRIVATE_MODEL_SOURCE"] };
        if (variant === "missing-field") {
          const { validationRequirements: _validation, ...rest } = candidate;
          value = rest;
        }
        f.setModel(async () =>
          f.answer({
            outputJson:
              variant === "malformed" ? "{BROKEN_JSON" : JSON.stringify(value),
          }),
        );
        await run(f);
        expect(f.generate).toHaveBeenCalledOnce();
        expect((await expectPrivateHeld(f)).modelAttempts).toMatchObject([
          { accounting: "accounted" },
        ]);
        expect(f.reconcile).toHaveBeenCalledWith(expect.anything(), {
          state: "known",
          usage: f.answer().usage,
        });
        expect(f.trust.checkCalls).toEqual([]);
        expect((await f.source()).destinations).toEqual([]);
      },
    );

    it("checks raw UTF-8 bytes before parsing or tokenizing output", async () => {
      const f = await resolutionLearningAiFixture(createStore());
      const raw = "{" + "\u00e9".repeat(100);
      expect(raw.length).toBeLessThan(150);
      f.setBudgets({ maxOutputBytes: 150 });
      f.setModel(async () => f.answer({ outputJson: raw }));
      await run(f);
      expect((await expectPrivateHeld(f)).heldReason).toBe("oversized_output");
      expect(f.countTokens.mock.calls.some(([text]) => text === raw)).toBe(
        false,
      );
      expect(f.reconcile).toHaveBeenCalledWith(expect.anything(), {
        state: "known",
        usage: f.answer().usage,
      });
    });

    it("bounds the actual serialized output tokens independently of the provider's reported usage", async () => {
      const f = await resolutionLearningAiFixture(createStore());
      f.setBudgets({ maxOutputTokens: 100 });
      const raw = f.answer().outputJson;
      expect(new TextEncoder().encode(raw).byteLength).toBeGreaterThan(100);
      await run(f);
      expect(f.generate).toHaveBeenCalledOnce();
      expect(f.countTokens.mock.calls.some(([text]) => text === raw)).toBe(
        true,
      );
      expect((await expectPrivateHeld(f)).heldReason).toBe("budget_exceeded");
      expect(f.reconcile).toHaveBeenCalledWith(expect.anything(), {
        state: "known",
        usage: f.answer().usage,
      });
    });

    it.each(["denied", "unavailable"] as const)(
      "keeps a %s usage reservation from reaching the provider",
      async (variant) => {
        const f = await resolutionLearningAiFixture(createStore());
        f.state.reserveOutcome = variant;
        await run(f);
        expect(f.reserve).toHaveBeenCalledOnce();
        expect(f.generate).not.toHaveBeenCalled();
        expect((await expectPrivateHeld(f)).modelAttempts).toMatchObject([
          { accounting: "not_called" },
        ]);
        expect(f.reconcile).toHaveBeenCalledWith(expect.anything(), {
          state: "not_called",
        });
      },
    );

    it.each(["plain", "json-escaping"] as const)(
      "enforces the whole 16,000-byte UTF-16 JSON candidate bound without truncating %s content",
      async (variant) => {
        const f = await resolutionLearningAiFixture(createStore());
        f.countTokens.mockReturnValue(1);
        f.setBudgets({ maxOutputBytes: 32_000 });
        const candidate = f.candidate({
          solution: variant === "plain" ? "x".repeat(8_000) : '"'.repeat(4_000),
        });
        const raw = JSON.stringify(candidate);
        expect(new TextEncoder().encode(raw).byteLength).toBeLessThan(16_000);
        expect(raw.length * 2).toBeGreaterThan(16_000);
        f.setModel(async () => f.answer({ outputJson: raw }));
        await run(f);
        expect((await expectPrivateHeld(f)).heldReason).toBe("candidate_limit");
        expect(f.generate).toHaveBeenCalledOnce();
        expect(
          (await f.app.readCustomerTicket(learningCustomer, "ticket")).messages,
        ).toHaveLength(2);
      },
    );

    it.each([
      "request-id-tab",
      "request-id-lf",
      "request-id-cr",
      "output-tokens",
      "input-tokens",
      "context",
      "cost",
      "currency",
    ] as const)(
      "reconciles known billable usage when %s makes the result unusable",
      async (variant) => {
        const f = await resolutionLearningAiFixture(createStore());
        if (variant === "context")
          f.setBudgets({
            maxInputTokens: 4_000,
            maxOutputTokens: 4_000,
            maxContextTokens: 7_000,
          });
        const answer = f.answer();
        const usage = {
          ...answer.usage,
          ...(variant === "input-tokens"
            ? { inputTokens: f.state.configuration.budgets.maxInputTokens + 1 }
            : {}),
          ...(variant === "output-tokens"
            ? {
                outputTokens: f.state.configuration.budgets.maxOutputTokens + 1,
              }
            : {}),
          ...(variant === "context"
            ? { inputTokens: 4_000, outputTokens: 4_000 }
            : {}),
          ...(variant === "cost"
            ? { costMicros: f.state.configuration.budgets.maxCostMicros + 1 }
            : {}),
          ...(variant === "currency" ? { currency: "EUR" } : {}),
        };
        const controls = {
          "request-id-tab": "\t",
          "request-id-lf": "\n",
          "request-id-cr": "\r",
        };
        const control =
          variant in controls ? controls[variant as keyof typeof controls] : "";
        f.setModel(async () =>
          f.answer({
            usage,
            ...(control === ""
              ? {}
              : { requestId: `provider${control}request` }),
          }),
        );
        await run(f);
        expect(f.generate).toHaveBeenCalledOnce();
        expect(f.reconcile).toHaveBeenCalledWith(expect.anything(), {
          state: "known",
          usage,
        });
        expect((await expectPrivateHeld(f)).modelAttempts).toMatchObject([
          { accounting: "accounted" },
        ]);
      },
    );

    it.each([
      ["provider mismatch", { provider: "other-learning-provider" }],
      ["model mismatch", { model: "other-learning-model" }],
      ["provider control character", { provider: "provider\tidentity" }],
      ["model control character", { model: "model\nidentity" }],
      ["missing provider", { provider: null }],
      ["non-string model", { model: 42 }],
    ] as const)(
      "reconciles known usage despite %s and holds the unusable result privately",
      async (_label, changes) => {
        const f = await resolutionLearningAiFixture(createStore());
        const usage = f.answer().usage;
        f.setModel(
          async () =>
            ({
              ...f.answer(),
              ...changes,
            }) as unknown as LearningModelResult,
        );
        await run(f);
        expect(f.generate).toHaveBeenCalledOnce();
        expect(f.reconcile).toHaveBeenCalledWith(expect.anything(), {
          state: "known",
          usage,
        });
        expect((await expectPrivateHeld(f)).modelAttempts).toMatchObject([
          { accounting: "accounted" },
        ]);
      },
    );

    it("keeps malformed provider usage unknown rather than manufacturing a zero-cost observation", async () => {
      const f = await resolutionLearningAiFixture(createStore());
      f.setModel(async () =>
        f.answer({ usage: { ...f.answer().usage, costMicros: Number.NaN } }),
      );
      await run(f);
      expect(f.generate).toHaveBeenCalledOnce();
      expect(f.reconcile).toHaveBeenCalledWith(expect.anything(), {
        state: "unknown",
      });
      expect((await expectPrivateHeld(f)).modelAttempts).toMatchObject([
        { accounting: "unknown" },
      ]);
    });

    it("settles known usage conservatively when durable usage reconciliation remains pending", async () => {
      const f = await resolutionLearningAiFixture(createStore());
      f.state.reconciliationOutcome = "pending";
      expect(await run(f)).toMatchObject({ outcome: "candidate" });
      expect((await f.work()).modelAttempts).toMatchObject([
        { accounting: "unknown" },
      ]);
      expect(f.reconcile).toHaveBeenCalledWith(expect.anything(), {
        state: "known",
        usage: f.answer().usage,
      });
    });

    it("does not commit a candidate after the real source changes while generation is in flight", async () => {
      const f = await resolutionLearningAiFixture(createStore());
      const barrier = handlingBarrier();
      f.setModel(async () => {
        await barrier.wait();
        return f.answer();
      });
      const claim = await f.claim();
      const pending = f.executor.processClaim(claim);
      try {
        await waitForModelHook(barrier, pending);
        await f.app.invalidateResolutionEvidence(learningStaff, {
          ...f.command("revoke-during-model"),
          reason: "product_binding_revoked",
        });
      } finally {
        barrier.release();
      }
      await pending;
      expect(f.generate).toHaveBeenCalledOnce();
      await expectPrivateHeld(f, claim);
      expect(f.reconcile).toHaveBeenCalledWith(expect.anything(), {
        state: "known",
        usage: f.answer().usage,
      });
      expect((await f.source()).state).toBe("held");
    });

    it("retries an unknown preparation acknowledgement with the exact command before any paid admission", async () => {
      const f = await resolutionLearningAiFixture(createStore());
      const commands: PrepareResolutionLearningStepCommand[] = [];
      const prepare = vi.fn<typeof f.app.prepareResolutionLearningStep>(
        async (...args) => {
          commands.push(structuredClone(args[1]));
          const result = await f.app.prepareResolutionLearningStep(...args);
          if (commands.length === 1) {
            expect(f.reserve).not.toHaveBeenCalled();
            expect(f.generate).not.toHaveBeenCalled();
            throw new Error(
              "Synthetic preparation acknowledgement lost after commit",
            );
          }
          return result;
        },
      );
      const executor = createLearningModelExecutor({
        ...f.baseOptions,
        application: { ...f.app, prepareResolutionLearningStep: prepare },
      });
      expect(await executor.processClaim(await f.claim())).toMatchObject({
        outcome: "candidate",
      });
      expect(commands.length).toBeGreaterThanOrEqual(3);
      expect(
        commands.every(
          (command) => JSON.stringify(command) === JSON.stringify(commands[0]),
        ),
      ).toBe(true);
      expect(f.reserve).toHaveBeenCalledOnce();
      expect(f.generate).toHaveBeenCalledOnce();
      expect((await f.work()).modelAttempts).toHaveLength(1);
    });

    it("permits at most one reservation and provider call when two dispatches borrow the same authoritative claim", async () => {
      const f = await resolutionLearningAiFixture(createStore());
      const claim = await f.claim();
      const barrier = handlingBarrier();
      f.setModel(async () => {
        await barrier.wait();
        return f.answer();
      });
      const first = f.executor.processClaim(claim);
      try {
        await waitForModelHook(barrier, first);
        const second = await f.executor.processClaim(claim);
        expect(second).toEqual({ outcome: "pending", stage: "prepare" });
        expect((await f.work()).status).toBe("prepared");
        expect((await f.work()).claim).toEqual(claim.fence);
        expect(f.generate).toHaveBeenCalledOnce();
        expect(f.reserve).toHaveBeenCalledOnce();
      } finally {
        barrier.release();
      }
      expect(await first).toMatchObject({ outcome: "candidate" });
      expect((await f.work()).modelAttempts).toHaveLength(1);
      expect((await f.work()).status).toBe("candidate");
    });

    it("calls the provider once outside application conflicts and retries the exact completed candidate after lost acknowledgement", async () => {
      const f = await resolutionLearningAiFixture(createStore());
      const completions: CompleteResolutionLearningStepCommand[] = [];
      let conflicts = 1;
      f.observed.intercept(async (trace, commit) => {
        const completes = trace.actions.some(
          (action) =>
            action.action !== "delete" &&
            (action.value as SupportRecord).kind ===
              "resolution_learning_work" &&
            (action.value as { status?: string }).status === "candidate",
        );
        if (completes && conflicts-- > 0)
          return { committed: false, reason: "changed" };
        return commit();
      });
      const complete = vi.fn<typeof f.app.completeResolutionLearningStep>(
        async (...args) => {
          completions.push(structuredClone(args[1]));
          const result = await f.app.completeResolutionLearningStep(...args);
          if (completions.length === 1)
            throw new Error(
              "Synthetic candidate acknowledgement lost after commit",
            );
          return result;
        },
      );
      const executor = createLearningModelExecutor({
        ...f.baseOptions,
        application: { ...f.app, completeResolutionLearningStep: complete },
      });
      expect(await executor.processClaim(await f.claim())).toMatchObject({
        outcome: "candidate",
      });
      expect(f.generate).toHaveBeenCalledOnce();
      expect(f.reserve).toHaveBeenCalledOnce();
      expect(completions).toHaveLength(2);
      expect(completions[1]).toEqual(completions[0]);
      expect((await f.work()).candidate).toEqual(f.candidate());
      expect((await f.work()).modelAttempts).toHaveLength(1);
    });

    it("retains an accepted candidate and known accounting when its acknowledgement is lost after the real source reopens", async () => {
      const f = await resolutionLearningAiFixture(createStore());
      const claim = await f.claim();
      const independent = createSupportDeskApplication({
        store: f.backing,
        clock: f.clock,
        assistantHandlingEnabled: true,
        resolutionLearning: f.learningOptions,
      });
      let acceptedWork:
        | Awaited<ReturnType<typeof f.app.readResolutionLearningWork>>
        | undefined;
      let lostAcknowledgement = false;
      f.observed.intercept(async (trace, commit) => {
        const completes = trace.actions.some(
          (action) =>
            action.action !== "delete" &&
            (action.value as SupportRecord).kind ===
              "resolution_learning_work" &&
            (action.value as { status?: string }).status === "candidate",
        );
        const outcome = await commit();
        if (completes && outcome.committed && !lostAcknowledgement) {
          lostAcknowledgement = true;
          acceptedWork = await independent.readResolutionLearningWork(
            learningStaff,
            claim.fence,
          );
          await independent.reopenTicket(
            learningStaff,
            f.command("reopen-after-accepted-candidate"),
          );
          throw new Error(
            "Synthetic candidate acknowledgement lost after acceptance and reopen",
          );
        }
        return outcome;
      });

      expect(await f.executor.processClaim(claim)).toEqual({
        outcome: "pending",
        stage: "complete",
      });
      expect(lostAcknowledgement).toBe(true);
      expect(acceptedWork).toMatchObject({
        status: "candidate",
        candidate: f.candidate(),
        modelAttempts: [{ accounting: "accounted" }],
      });
      expect(acceptedWork!.claim).toBeUndefined();
      const retained = await f.app.readResolutionLearningWork(
        learningStaff,
        claim.fence,
      );
      expect(retained).toEqual(acceptedWork);
      expect(retained.lastFinish).toBeUndefined();
      expect(await f.source()).toMatchObject({
        state: "held",
        heldReason: "reopened",
        sourceGeneration: claim.fence.sourceGeneration + 1,
        resolutionCycle: claim.sourceFence.resolutionCycle + 1,
      });
      expect(
        await f.app.confirmResolutionLearningSource(
          learningService,
          claim.sourceFence,
        ),
      ).toBe(false);
      expect(f.generate).toHaveBeenCalledOnce();
      expect(f.reserve).toHaveBeenCalledOnce();
      expect(f.reconcile).toHaveBeenCalledWith(expect.anything(), {
        state: "known",
        usage: f.answer().usage,
      });
    });

    it("never calls a recovered prepared attempt and requires a bounded new attempt with conservative old accounting", async () => {
      const f = await resolutionLearningAiFixture(createStore());
      const prepare = vi.fn<typeof f.app.prepareResolutionLearningStep>(
        async (...args) => {
          await f.app.prepareResolutionLearningStep(...args);
          throw new Error(
            "Synthetic repeated preparation acknowledgement loss",
          );
        },
      );
      const uncertain = createLearningModelExecutor({
        ...f.baseOptions,
        application: { ...f.app, prepareResolutionLearningStep: prepare },
      });
      expect(await uncertain.processClaim(await f.claim())).toEqual({
        outcome: "pending",
        stage: "prepare",
      });
      const old = (await f.work()).modelAttempts[0]!;
      expect(f.generate).not.toHaveBeenCalled();
      expect(f.reserve).not.toHaveBeenCalled();
      f.advance(10_001);
      const recovered = await f.claim("recovery-claim", "recovery-worker");
      expect(recovered.recoveredModelPreparation).toBe(true);
      expect(await f.executor.processClaim(recovered)).toMatchObject({
        outcome: "finished",
        result: { status: "retry" },
      });
      expect(f.generate).not.toHaveBeenCalled();
      expect(f.reserve).not.toHaveBeenCalled();
      expect(f.reconcile).toHaveBeenCalledWith(
        expect.objectContaining({
          attemptId: old.stepId,
          usageReservationId: old.binding.usageReservationId,
        }),
        { state: "unknown" },
      );
      const next = await f.claim("new-attempt-claim", "new-attempt-worker");
      expect(next.recoveredModelPreparation).toBe(false);
      f.setModel(async () =>
        f.answer({ outputJson: "{UNUSABLE_SECOND_ATTEMPT" }),
      );
      await f.executor.processClaim(next);
      expect(f.generate).toHaveBeenCalledOnce();
      expect(f.reserve).toHaveBeenCalledOnce();
      const attempts = (await f.work()).modelAttempts;
      expect(attempts).toHaveLength(2);
      expect(attempts[0]).toEqual(old);
      expect(attempts[1]?.stepId).not.toBe(old.stepId);
      expect(attempts[1]?.binding.usageReservationId).not.toBe(
        old.binding.usageReservationId,
      );
      const exhausted = await f.claim(
        "attempt-budget-claim",
        "attempt-budget-worker",
      );
      await f.executor.processClaim(exhausted);
      expect(f.generate).toHaveBeenCalledOnce();
      expect(f.reserve).toHaveBeenCalledOnce();
      expect((await f.work()).modelAttempts).toHaveLength(2);
    });

    it("keeps already accepted working facts current when the learning worker is disabled", async () => {
      const f = await resolutionLearningAiFixture(createStore());
      const claim = await f.claim();
      const source = await f.source();
      f.state.configurationOutcome = "disabled";
      await f.executor.processClaim(claim);
      expect(
        await f.app.confirmResolutionLearningSource(
          learningService,
          claim.sourceFence,
        ),
      ).toBe(true);
      expect((await f.source()).evidence).toEqual(source.evidence);
      expect((await f.source()).sourceGeneration).toBe(source.sourceGeneration);
      const disabled = f.freshApplication({
        resolutionLearning: { enabled: false },
      });
      expect(
        await disabled.confirmResolutionLearningSource(
          learningService,
          claim.sourceFence,
        ),
      ).toBe(true);
    });

    it("stops at a private candidate and refuses real application work prepared for the KB delivery stage", async () => {
      const f = await resolutionLearningAiFixture(createStore());
      await run(f);
      const claim = await f.claim(
        "delivery-stage-claim",
        "delivery-stage-worker",
      );
      const source = await f.source();
      const work = await f.work();
      const request = {
        operation: "create" as const,
        articleId: "article/synthetic-export",
        collectionId: "collection/synthetic-learning",
        draftPayload: JSON.stringify(work.candidate),
        sourceReferences: [
          {
            id: source.sourceId,
            system: "pegma.support-desk",
            resourceId: "ticket",
            version: source.sourceBindingHash!,
          },
        ],
        originalExpectedGeneration: 0,
        commandId: "synthetic-delivery-command",
        correlationId: "synthetic-delivery-correlation",
      };
      const binding = await resolutionLearningDeliveryBinding({
        candidateHash: work.candidateHash!,
        sourceBindingHash: source.sourceBindingHash!,
        policyVersion: "synthetic-check-policy-v1",
        targetDecisionHash: "synthetic-create-decision",
        applicability: work.candidate!.applicability,
        exactRequest: request,
      });
      const command = {
        ...claim.fence,
        step: "kb_delivery" as const,
        candidateHash: work.candidateHash!,
        verifiedCheckReceipt: "synthetic-independent-check-receipt",
        policyVersion: binding.policyVersion,
        targetDecisionHash: binding.targetDecisionHash,
        exactRequest: request,
      };
      await expect(
        f.app.prepareResolutionLearningStep(learningService, command),
      ).rejects.toThrow();
      expect((await f.work()).exactRequest).toBeUndefined();
      f.trust.issueChecks(command.verifiedCheckReceipt, binding);
      await f.app.prepareResolutionLearningStep(learningService, command);
      const delivery = await f.claim(
        "delivery-stage-claim",
        "delivery-stage-worker",
      );
      expect(delivery.work.stage).toBe("kb_delivery");
      const before = await f.work();
      const prepare = vi.spyOn(f.app, "prepareResolutionLearningStep");
      await expect(f.executor.processClaim(delivery)).rejects.toThrow();
      expect(prepare).not.toHaveBeenCalled();
      expect(f.generate).toHaveBeenCalledOnce();
      expect(f.reserve).toHaveBeenCalledOnce();
      expect(await f.work()).toEqual(before);
    });
  });
}

describe("resolution learning phase deadlines", () => {
  it("uses elapsed real time with a frozen application clock and discards abort-ignorant late output", async () => {
    const [, createStore] = learningStores[0];
    const f = await resolutionLearningAiFixture(createStore());
    const barrier = handlingBarrier();
    f.setBudgets({ maxDurationMilliseconds: 250 });
    f.setModel(async () => {
      await barrier.wait();
      return f.answer();
    });
    const executor = createLearningModelExecutor({
      ...f.baseOptions,
      maxOperationMilliseconds: 2_000,
      commitReserveMilliseconds: 100,
    });
    const frozen = f.clock.now();
    const pending = executor.processClaim(await f.claim());
    try {
      await waitForModelHook(barrier, pending);
      const result = await pending;
      expect(result).toMatchObject({ outcome: "finished" });
      expect(f.clock.now()).toBe(frozen);
      expect(f.generate.mock.calls[0]![1].signal.aborted).toBe(true);
    } finally {
      barrier.release();
    }
    await Promise.resolve();
    await Promise.resolve();
    expect((await expectPrivateHeld(f)).heldReason).toBe("deadline");
    expect(f.reconcile).toHaveBeenCalledWith(expect.anything(), {
      state: "unknown",
    });
  });

  it("does not extend an expired prepared deadline when the host clock advances during generation", async () => {
    const [, createStore] = learningStores[0];
    const f = await resolutionLearningAiFixture(createStore());
    f.setModel(async () => {
      f.advance(10_001);
      return f.answer();
    });
    const claim = await f.claim();
    await f.executor.processClaim(claim);
    expect(f.generate).toHaveBeenCalledOnce();
    const work = await f.work();
    expect(work.candidate).toBeUndefined();
    expect(work.modelAttempts).toHaveLength(1);
    expect(work.modelAttempts[0]!.binding.deadline).toBe(claim.leaseUntil);
    expect(work.status).toBe("prepared");
  });
});
