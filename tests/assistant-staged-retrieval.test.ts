import {
  createSupportDeskAssistant,
  type SupportDeskAssistantOptions,
} from "@pegma/support-desk-ai";
import { createSupportDeskApplication } from "@pegma/support-desk-application";
import { describe, expect, it, vi } from "vitest";
import { assistantAiFixture } from "../test/assistant-ai-fixtures.js";
import {
  handlingBarrier,
  handlingCustomer as customer,
  handlingStaff as staff,
  handlingStores,
} from "../test/handling-fixtures.js";

type Fixture = Awaited<ReturnType<typeof assistantAiFixture>>;

function staged(
  f: Fixture,
  overrides: Partial<SupportDeskAssistantOptions> = {},
) {
  return createSupportDeskAssistant({
    ...f.baseOptions,
    stagedRetrieval: true,
    storageCommandAttempts: 1,
    ...overrides,
  });
}

async function turn(f: Fixture) {
  const row = (await f.rows()).find(
    (record) => record.kind === "assistant_turn",
  );
  if (row?.kind !== "assistant_turn") throw new Error("Missing synthetic turn");
  return row;
}

async function assistantMessages(f: Fixture) {
  return (await f.app.readCustomerTicket(customer, "ticket")).messages.filter(
    (message) => message.authorKind === "assistant",
  );
}

for (const [name, createStore] of handlingStores) {
  describe(`opt-in durable staged retrieval (${name})`, () => {
    it("prepares without paid work, then reconstructs the exact request in a fresh invocation with every generation guard", async () => {
      const f = await assistantAiFixture(createStore());
      const retrieve = vi.fn(f.knowledge.app.retrieveAnswerSources);
      const confirm = vi.fn(f.knowledge.app.confirmAnswerSources);
      const evaluate = vi.fn<
        NonNullable<SupportDeskAssistantOptions["escalationPolicy"]>["evaluate"]
      >(() => null);
      const options = {
        knowledge: {
          retrieveAnswerSources: retrieve,
          confirmAnswerSources: confirm,
        },
        escalationPolicy: { evaluate },
      };
      const command = await f.nextCommand();
      const prepared = await staged(f, options).processTurn(command);
      expect(prepared).toMatchObject({
        outcome: "prepared",
        ticketId: command.ticketId,
        turnId: command.turnId,
      });
      // Only the public result's declared fields are returned, not command ownership.
      expect(prepared).not.toHaveProperty("workerId");
      expect(f.generate).not.toHaveBeenCalled();
      expect(f.reserve).not.toHaveBeenCalled();
      expect(f.reconcile).not.toHaveBeenCalled();
      expect(confirm).not.toHaveBeenCalled();
      const first = await turn(f);
      expect(first).toMatchObject({
        status: "retry",
        attempt: 1,
        claimGeneration: 1,
        preparedAttempts: [
          {
            accounting: "not_called",
            binding: {
              versions: { supportAnswerStage: "support-answer-retrieval-1" },
            },
          },
        ],
      });
      expect(first).not.toHaveProperty("claim");
      expect(first).not.toHaveProperty("leaseUntil");
      const stored = JSON.stringify(first);
      for (const body of [
        "How do I export my workspace?",
        "choose Export",
        f.state.configuration.trustedInstructions,
      ])
        expect(stored).not.toContain(body);
      // The first execution deadline is deliberately expired. Only its immutable
      // content identity survives; the next execution receives a fresh deadline.
      f.advance(6_000);
      expect(await staged(f, options).processTurn(command)).toMatchObject({
        outcome: "completed",
      });
      expect(retrieve).toHaveBeenCalledOnce();
      expect(confirm).toHaveBeenCalledTimes(3);
      expect(f.reserve).toHaveBeenCalledOnce();
      expect(f.generate).toHaveBeenCalledOnce();
      const [input, context] = f.generate.mock.calls[0]!;
      expect(input).toEqual(evaluate.mock.calls[0]![0]);
      expect(context).toMatchObject({
        attempt: 2,
        fence: { attempt: 2, claimGeneration: 2 },
        stagedRetrieval: {
          stage: "generation",
          preparationAttemptId: first.preparedAttempts[0]!.attemptId,
        },
      });
      expect(evaluate.mock.calls[0]![1]).toMatchObject({
        attempt: 1,
        stagedRetrieval: { stage: "preparation" },
      });
      expect(
        context.deadline > first.preparedAttempts[0]!.binding.deadline,
      ).toBe(true);
      expect(context.usageReservationId).toMatch(/^usage:/u);
      expect(await turn(f)).toMatchObject({
        status: "completed",
        attempt: 2,
        claimGeneration: 2,
        preparedAttempts: [
          { accounting: "not_called" },
          {
            accounting: "unknown",
            binding: {
              versions: { supportAnswerStage: "support-answer-generation-1" },
            },
          },
        ],
      });
      expect(await assistantMessages(f)).toHaveLength(1);
      expect((await staged(f).processTurn(command)).outcome).toBe(
        "not_claimed",
      );
      expect(f.generate).toHaveBeenCalledOnce();
    });

    it("does not let overlapping callbacks share either the preparation or paid owner", async () => {
      const f = await assistantAiFixture(createStore());
      const retrieval = handlingBarrier();
      const knowledge = {
        ...f.knowledge.app,
        async retrieveAnswerSources(
          ...args: Parameters<typeof f.knowledge.app.retrieveAnswerSources>
        ) {
          const result = await f.knowledge.app.retrieveAnswerSources(...args);
          await retrieval.wait();
          return result;
        },
      };
      const command = await f.nextCommand();
      const preparing = staged(f, { knowledge }).processTurn(command);
      await retrieval.reached;
      expect((await staged(f).processTurn(command)).outcome).toBe(
        "not_claimed",
      );
      retrieval.release();
      expect((await preparing).outcome).toBe("prepared");
      const generation = handlingBarrier();
      f.setModel(async (_input, context) => {
        await generation.wait();
        return f.answer(context.allSourceReferences);
      });
      const generating = staged(f).processTurn(command);
      await generation.reached;
      expect((await staged(f).processTurn(command)).outcome).toBe(
        "not_claimed",
      );
      expect(f.reserve).toHaveBeenCalledOnce();
      expect(f.reconcile).not.toHaveBeenCalled();
      generation.release();
      expect((await generating).outcome).toBe("completed");
      expect(f.generate).toHaveBeenCalledOnce();
      expect(await assistantMessages(f)).toHaveLength(1);
    });

    it("retains the final all-source guard when an uncited source is retired during generation", async () => {
      const f = await assistantAiFixture(createStore(), {
        guides: [
          { id: "article/export", text: "Choose Export for a CSV." },
          {
            id: "article/export-safety",
            text: "Select the workspace before export.",
          },
        ],
      });
      const command = await f.nextCommand();
      expect((await staged(f).processTurn(command)).outcome).toBe("prepared");
      const barrier = handlingBarrier();
      f.setModel(async (_input, context) => {
        await barrier.wait();
        return f.answer(
          context.allSourceReferences.slice(0, 1),
          "STALE_STAGED_PROSE",
        );
      });
      const pending = staged(f).processTurn(command);
      await barrier.reached;
      const references = f.generate.mock.calls[0]![1].allSourceReferences;
      expect(references).toHaveLength(2);
      await f.knowledge.retire(references[1]!.articleId);
      barrier.release();
      await pending;
      expect(await assistantMessages(f)).toEqual([]);
      expect(f.generate).toHaveBeenCalledOnce();
      expect(f.reconcile).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ state: "known" }),
      );
      expect(
        JSON.stringify(await f.app.readCustomerTicket(customer, "ticket")),
      ).not.toContain("STALE_STAGED_PROSE");
    });
  });
}

describe("staged retrieval acknowledgment and fail-closed boundaries", () => {
  it("leaves the default coordinator monolithic", async () => {
    const f = await assistantAiFixture();
    expect((await f.assistant.processTurn(await f.nextCommand())).outcome).toBe(
      "completed",
    );
    expect(f.generate).toHaveBeenCalledOnce();
    expect(f.generate.mock.calls[0]![1]).not.toHaveProperty("stagedRetrieval");
    expect(await turn(f)).toMatchObject({ attempt: 1, claimGeneration: 1 });
  });

  it.each(["configuration", "application"] as const)(
    "does not claim prepared when the %s only allows one attempt",
    async (variant) => {
      const f = await assistantAiFixture();
      if (variant === "configuration")
        f.state.configuration = {
          ...f.state.configuration,
          budgets: { ...f.state.configuration.budgets, maxAttempts: 1 },
        };
      const application =
        variant === "application"
          ? createSupportDeskApplication({
              store: f.store,
              clock: f.clock,
              assistantHandlingEnabled: true,
              assistantTurns: { maxAttempts: 1 },
            })
          : f.app;
      const result = await staged(f, { application }).processTurn(
        await f.nextCommand(),
      );
      expect(result.outcome).toBe("finished");
      expect(await turn(f)).toMatchObject({ status: "escalated", attempt: 1 });
      expect(f.reserve).not.toHaveBeenCalled();
      expect(f.generate).not.toHaveBeenCalled();
    },
  );

  it("never resumes a preparation whose storage ACK was lost before its no-call finish", async () => {
    const f = await assistantAiFixture();
    const command = await f.nextCommand();
    const first = await staged(f, {
      application: {
        ...f.app,
        async prepareAssistantTurnAttempt(...args) {
          await f.app.prepareAssistantTurnAttempt(...args);
          throw new Error("Synthetic lost preparation ACK");
        },
      },
    }).processTurn(command);
    expect(first).toEqual({ outcome: "pending", stage: "prepare" });
    expect(await turn(f)).toMatchObject({
      status: "claimed",
      preparedAttempts: [{ accounting: "unknown" }],
    });
    f.advance(31_000);
    expect((await staged(f).processTurn(command)).outcome).toBe("finished");
    expect(f.generate).not.toHaveBeenCalled();
    expect(f.reserve).not.toHaveBeenCalled();
    expect(f.reconcile).not.toHaveBeenCalled();
    expect(await turn(f)).toMatchObject({
      status: "escalated",
      attempt: 2,
      preparedAttempts: [{ accounting: "unknown" }],
    });
  });

  it("does not report prepared for an ambiguous finish, but a later invocation can observe its durable no-call state", async () => {
    const f = await assistantAiFixture();
    const command = await f.nextCommand();
    const result = await staged(f, {
      application: {
        ...f.app,
        async finishAssistantTurnAttempt(...args) {
          await f.app.finishAssistantTurnAttempt(...args);
          throw new Error("Synthetic lost finish ACK");
        },
      },
    }).processTurn(command);
    expect(result).toEqual({ outcome: "pending", stage: "finish" });
    expect(await turn(f)).toMatchObject({
      status: "retry",
      preparedAttempts: [{ accounting: "not_called" }],
    });
    expect((await staged(f).processTurn(command)).outcome).toBe("completed");
    expect(f.generate).toHaveBeenCalledOnce();
  });

  it("does not resume a failed no-call finish or relabel its unknown preparation", async () => {
    const f = await assistantAiFixture();
    const command = await f.nextCommand();
    const result = await staged(f, {
      application: {
        ...f.app,
        async finishAssistantTurnAttempt() {
          throw new Error("Synthetic finish failure before commit");
        },
      },
    }).processTurn(command);
    expect(result).toEqual({ outcome: "pending", stage: "finish" });
    expect(await turn(f)).toMatchObject({
      status: "claimed",
      preparedAttempts: [{ accounting: "unknown" }],
    });
    f.advance(31_000);
    expect((await staged(f).processTurn(command)).outcome).toBe("finished");
    expect(f.generate).not.toHaveBeenCalled();
    expect(f.reserve).not.toHaveBeenCalled();
    expect((await turn(f)).preparedAttempts).toMatchObject([
      { accounting: "unknown" },
    ]);
  });

  it("does not report prepared if a customer handoff wins the no-call finish race", async () => {
    const f = await assistantAiFixture();
    const barrier = handlingBarrier();
    const pending = staged(f, {
      application: {
        ...f.app,
        async finishAssistantTurnAttempt(...args) {
          await barrier.wait();
          return f.app.finishAssistantTurnAttempt(...args);
        },
      },
    }).processTurn(await f.nextCommand());
    await barrier.reached;
    await f.app.requestPerson(customer, f.command("handoff"));
    barrier.release();
    expect((await pending).outcome).not.toBe("prepared");
    expect(f.reserve).not.toHaveBeenCalled();
    expect(f.generate).not.toHaveBeenCalled();
    expect(await assistantMessages(f)).toEqual([]);
  });

  it("never adopts an old untagged paid preparation and retains its unknown reconciliation", async () => {
    const f = await assistantAiFixture();
    const command = await f.nextCommand();
    const old = createSupportDeskAssistant({
      ...f.baseOptions,
      storageCommandAttempts: 1,
      application: {
        ...f.app,
        async prepareAssistantTurnAttempt(...args) {
          await f.app.prepareAssistantTurnAttempt(...args);
          throw new Error("Synthetic old paid preparation ACK lost");
        },
      },
    });
    expect(await old.processTurn(command)).toEqual({
      outcome: "pending",
      stage: "prepare",
    });
    f.advance(31_000);
    expect((await staged(f).processTurn(command)).outcome).toBe("finished");
    expect(f.reconcile).toHaveBeenCalledWith(expect.anything(), {
      state: "unknown",
    });
    expect(f.generate).not.toHaveBeenCalled();
    expect(f.reserve).not.toHaveBeenCalled();
    expect((await turn(f)).preparedAttempts).toMatchObject([
      { accounting: "unknown" },
    ]);
  });

  it("retries an identical lost finish ACK within the first invocation without generating", async () => {
    const f = await assistantAiFixture();
    let lost = false;
    const finish = vi.fn<typeof f.app.finishAssistantTurnAttempt>(
      async (...args) => {
        const result = await f.app.finishAssistantTurnAttempt(...args);
        if (!lost) {
          lost = true;
          throw new Error("Synthetic first finish ACK lost");
        }
        return result;
      },
    );
    const result = await staged(f, {
      storageCommandAttempts: 2,
      application: { ...f.app, finishAssistantTurnAttempt: finish },
    }).processTurn(await f.nextCommand());
    expect(result.outcome).toBe("prepared");
    expect(finish).toHaveBeenCalledTimes(2);
    expect(finish.mock.calls[0]![1]).toEqual(finish.mock.calls[1]![1]);
    expect(f.generate).not.toHaveBeenCalled();
    expect((await turn(f)).attempt).toBe(1);
  });

  it("does not report prepared after cancellation while the no-call finish ACK is pending", async () => {
    const f = await assistantAiFixture();
    const command = await f.nextCommand();
    const barrier = handlingBarrier();
    const controller = new AbortController();
    const pending = staged(f, {
      application: {
        ...f.app,
        async finishAssistantTurnAttempt(...args) {
          const result = await f.app.finishAssistantTurnAttempt(...args);
          await barrier.wait();
          return result;
        },
      },
    }).processTurn(command, { signal: controller.signal });
    await barrier.reached;
    controller.abort();
    barrier.release();
    expect((await pending).outcome).not.toBe("prepared");
    expect(f.generate).not.toHaveBeenCalled();
    expect(f.reserve).not.toHaveBeenCalled();
    expect((await staged(f).processTurn(command)).outcome).toBe("completed");
  });

  it.each([
    "authority",
    "configuration",
    "budget",
    "source",
    "note",
    "takeover",
    "new-message",
  ] as const)(
    "rejects a changed %s between the two invocations without retrieval fallback or paid work",
    async (variant) => {
      const f = await assistantAiFixture();
      const retrieve = vi.fn(f.knowledge.app.retrieveAnswerSources);
      const knowledge = { ...f.knowledge.app, retrieveAnswerSources: retrieve };
      const command = await f.nextCommand();
      expect(
        (await staged(f, { knowledge }).processTurn(command)).outcome,
      ).toBe("prepared");
      if (variant === "authority")
        f.state.authority = {
          ...f.state.authority,
          audienceVersion: "changed-audience",
        };
      if (variant === "configuration")
        f.state.configuration = {
          ...f.state.configuration,
          trustedInstructions: "Changed trusted instructions",
        };
      if (variant === "budget")
        f.state.configuration = {
          ...f.state.configuration,
          budgets: { ...f.state.configuration.budgets, maxCostMicros: 9_999 },
        };
      if (variant === "source") await f.knowledge.retire("article/export");
      if (variant === "note")
        await f.app.addNote(staff, {
          ...f.command("note"),
          messageId: "note",
          body: "PRIVATE_STAGED_NOTE",
        });
      if (variant === "takeover") {
        const current = await f.app.readStaffTicket(staff, "ticket");
        await f.app.takeOverTicket(staff, {
          ...f.command("takeover"),
          expectedRevision: current.ticket.revision,
          expectedHandlingGeneration: current.ticket.handling!.generation,
        });
      }
      if (variant === "new-message")
        await f.app.replyToCustomerTicket(customer, {
          ...f.command("new-message"),
          messageId: "new-message",
          body: "Another export question",
        });
      expect(
        (await staged(f, { knowledge }).processTurn(command)).outcome,
      ).not.toBe("prepared");
      expect(retrieve).toHaveBeenCalledOnce();
      expect(f.reserve).not.toHaveBeenCalled();
      expect(f.generate).not.toHaveBeenCalled();
      expect(await assistantMessages(f)).toEqual([]);
    },
  );

  it("retains the authority guard after the resumed usage reservation", async () => {
    const f = await assistantAiFixture();
    const command = await f.nextCommand();
    expect((await staged(f).processTurn(command)).outcome).toBe("prepared");
    const barrier = handlingBarrier();
    const pending = staged(f, {
      usage: {
        reconcile: f.reconcile,
        async reserve(context) {
          const result = await f.reserve(context);
          await barrier.wait();
          return result;
        },
      },
    }).processTurn(command);
    await barrier.reached;
    f.state.authorityOutcome = "inactive";
    barrier.release();
    await pending;
    expect(f.generate).not.toHaveBeenCalled();
    expect(f.reconcile).toHaveBeenCalledWith(expect.anything(), {
      state: "not_called",
    });
    expect(await assistantMessages(f)).toEqual([]);
  });

  it("never repeats a paid call after a lost completion ACK", async () => {
    const f = await assistantAiFixture();
    const command = await f.nextCommand();
    expect((await staged(f).processTurn(command)).outcome).toBe("prepared");
    const result = await staged(f, {
      application: {
        ...f.app,
        async completeAssistantTurn(...args) {
          await f.app.completeAssistantTurn(...args);
          throw new Error("Synthetic lost completion ACK");
        },
      },
    }).processTurn(command);
    expect(result).toEqual({ outcome: "pending", stage: "complete" });
    expect((await staged(f).processTurn(command)).outcome).toBe("not_claimed");
    expect(f.generate).toHaveBeenCalledOnce();
    expect(await assistantMessages(f)).toHaveLength(1);
  });
});
