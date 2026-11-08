import { describe, expect, it } from "vitest";
import {
  assistantAnswer,
  assistantBindingWithinBytes,
  assistantTurnFixture,
  maximumAssistantProcessing,
} from "../test/assistant-turn-fixtures.js";
import {
  handlingAgent as agent,
  handlingCustomer as customer,
  handlingStaff as staff,
  handlingStores,
} from "../test/handling-fixtures.js";

for (const [name, createStore] of handlingStores) {
  describe(`durable assistant turn ownership (${name})`, () => {
    it("requires dedicated service permissions for every turn operation", async () => {
      const f = assistantTurnFixture(createStore());
      await f.create();
      const claim = await f.claim();
      const prepared = await f.prepare(claim);
      const before = await f.rows();
      await expect(
        f.app.scanAssistantTurnCandidates(customer, { limit: 100 }),
      ).rejects.toMatchObject({ name: "SupportDeskAuthorizationError" });
      await expect(
        f.app.claimAssistantTurn(customer, {
          ticketId: claim.fence.ticketId,
          turnId: claim.fence.turnId,
          workerId: "customer-selected-worker",
          claimId: "customer-selected-claim",
          leaseMilliseconds: 10_000,
        }),
      ).rejects.toMatchObject({ name: "SupportDeskAuthorizationError" });
      await expect(
        f.app.prepareAssistantTurnAttempt(customer, {
          ...claim.fence,
          binding: f.binding(claim),
        }),
      ).rejects.toMatchObject({ name: "SupportDeskAuthorizationError" });
      let guards = 0;
      await expect(
        f.app.completeAssistantTurn(
          customer,
          assistantAnswer(claim, prepared.inputFingerprint),
          () => {
            guards += 1;
          },
        ),
      ).rejects.toMatchObject({ name: "SupportDeskAuthorizationError" });
      await expect(
        f.app.finishAssistantTurnAttempt(customer, {
          ...claim.fence,
          disposition: "retry",
          accounting: "not_called",
        }),
      ).rejects.toMatchObject({ name: "SupportDeskAuthorizationError" });
      expect(guards).toBe(0);
      expect(await f.rows()).toEqual(before);
    });

    it("returns the same live claim and immutable preparation without changing ticket revision or generation", async () => {
      const f = assistantTurnFixture(createStore());
      await f.create();
      const before = (await f.app.readStaffTicket(staff, "ticket")).ticket;
      const claim = await f.claim();
      const claimedRows = await f.rows();
      expect(
        await f.app.claimAssistantTurn(agent, {
          ticketId: claim.fence.ticketId,
          turnId: claim.fence.turnId,
          workerId: claim.fence.workerId,
          claimId: claim.fence.claimId,
          leaseMilliseconds: 10_000,
        }),
      ).toEqual(claim);
      expect(await f.rows()).toEqual(claimedRows);
      const binding = f.binding(claim);
      const input = { ...claim.fence, binding };
      const prepared = await f.app.prepareAssistantTurnAttempt(agent, input);
      const preparedRows = await f.rows();
      expect(await f.app.prepareAssistantTurnAttempt(agent, input)).toEqual(
        prepared,
      );
      expect(await f.rows()).toEqual(preparedRows);
      expect(preparedRows).toHaveLength(7);
      expect((await f.app.readStaffTicket(staff, "ticket")).ticket).toEqual(
        before,
      );
      expect(claim.fence.attempt).toBe(1);
      expect(prepared.attemptId).toBe(claim.fence.attemptId);
      expect(claim.requesterPrincipalId).toBe(customer.principalId);
      await expect(
        f.app.prepareAssistantTurnAttempt(agent, {
          ...claim.fence,
          binding: { ...binding, contextBinding: "different-context" },
        }),
      ).rejects.toThrow();
      expect(await f.rows()).toEqual(preparedRows);
    });

    it("gives two competing workers exactly one authoritative owner", async () => {
      const f = assistantTurnFixture(createStore());
      await f.create();
      const key = await f.candidate();
      const claims = await Promise.all([
        f.app.claimAssistantTurn(agent, {
          ...key,
          workerId: "worker-a",
          claimId: "claim-a",
          leaseMilliseconds: 10_000,
        }),
        f.freshApplication().claimAssistantTurn(agent, {
          ...key,
          workerId: "worker-b",
          claimId: "claim-b",
          leaseMilliseconds: 10_000,
        }),
      ]);
      expect(claims.filter((claim) => claim !== null)).toHaveLength(1);
      const owner = claims.find((claim) => claim !== null)!;
      expect(owner.fence.attempt).toBe(1);
      const job = (await f.rows()).find((row) => row.kind === "assistant_turn");
      expect(job).toMatchObject({
        attempt: 1,
        claimGeneration: 1,
        claim: owner.fence,
      });
    });

    it("reclaims an expired lease with a fresh fence and keeps the old prepared attempt unknown", async () => {
      const f = assistantTurnFixture(createStore());
      await f.create();
      const first = await f.claim();
      const prepared = await f.prepare(first);
      f.advance(10_001);
      const second = await f.claim("claim-2", "worker-1");
      expect(second.fence.attempt).toBe(2);
      expect(second.fence.claimGeneration).toBeGreaterThan(
        first.fence.claimGeneration,
      );
      expect(second.fence.attemptId).not.toBe(first.fence.attemptId);
      expect(second.preparedAttempts).toEqual([
        expect.objectContaining({
          attemptId: first.fence.attemptId,
          inputFingerprint: prepared.inputFingerprint,
          accounting: "unknown",
        }),
      ]);
      const before = await f.rows();
      await expect(f.prepare(first)).rejects.toThrow();
      let guardCalls = 0;
      await expect(
        f.app.completeAssistantTurn(
          agent,
          assistantAnswer(first, prepared.inputFingerprint),
          () => {
            guardCalls += 1;
          },
        ),
      ).rejects.toThrow();
      expect(guardCalls).toBe(0);
      expect(await f.rows()).toEqual(before);
      expect(
        (await f.app.readCustomerTicket(customer, "ticket")).messages,
      ).toHaveLength(1);
    });

    it("loads only the visible conversation and keeps service-only requester identity outside it", async () => {
      const f = assistantTurnFixture(createStore());
      await f.create();
      await f.app.addNote(staff, {
        ...f.command("private-note"),
        messageId: "private-note",
        body: "PRIVATE_ASSISTANT_TURN_NOTE",
      });
      const claim = await f.claim();
      expect(claim.requesterPrincipalId).toBe(customer.principalId);
      expect(claim.conversation.messages).toHaveLength(1);
      const visible = JSON.stringify(claim.conversation);
      expect(visible).not.toContain("PRIVATE_ASSISTANT_TURN_NOTE");
      expect(visible).not.toContain(customer.principalId);
      expect(visible).not.toContain(staff.principalId);
      await f.prepare(claim);
      const job = (await f.rows()).find((row) => row.kind === "assistant_turn");
      expect(JSON.stringify(job)).not.toContain(
        "How do I export my workspace?",
      );
      expect(JSON.stringify(job)).not.toContain("PRIVATE_ASSISTANT_TURN_NOTE");
    });

    it.each([
      "enumerable",
      "nonenumerable",
      "accessor",
      "too many references",
      "encoded binding",
    ] as const)(
      "rejects %s preparation inputs without changing durable state or evaluating accessors",
      async (invalid) => {
        const f = assistantTurnFixture(createStore());
        await f.create();
        const claim = await f.claim();
        const binding = f.binding(claim);
        let getterCalls = 0;
        if (invalid === "enumerable")
          Object.defineProperty(binding, "rawPrompt", {
            value: "RAW_PROMPT",
            enumerable: true,
          });
        else if (invalid === "nonenumerable")
          Object.defineProperty(binding, "rawPrompt", {
            value: "RAW_PROMPT",
            enumerable: false,
          });
        else if (invalid === "accessor")
          Object.defineProperty(binding, "rawPrompt", {
            get() {
              getterCalls += 1;
              return "RAW_PROMPT";
            },
          });
        const input = {
          ...claim.fence,
          binding:
            invalid === "too many references"
              ? {
                  ...binding,
                  references: Array.from(
                    { length: 33 },
                    () => binding.references[0]!,
                  ),
                }
              : invalid === "encoded binding"
                ? {
                    ...binding,
                    references: [
                      { ...binding.references[0]!, binding: "x".repeat(6_000) },
                    ],
                  }
                : binding,
        };
        const before = await f.rows();
        await expect(
          f.app.prepareAssistantTurnAttempt(agent, input),
        ).rejects.toThrow();
        expect(getterCalls).toBe(0);
        expect(await f.rows()).toEqual(before);
      },
    );

    it("rejects a provider deadline beyond the current lease before recording preparation", async () => {
      const f = assistantTurnFixture(createStore());
      await f.create();
      const claim = await f.claim();
      const before = await f.rows();
      await expect(
        f.app.prepareAssistantTurnAttempt(agent, {
          ...claim.fence,
          binding: f.binding(claim, { deadline: claim.turnDeadline }),
        }),
      ).rejects.toThrow();
      expect(await f.rows()).toEqual(before);
    });

    it("replays an exact retry schedule and rejects a changed retryAt on the same finished claim", async () => {
      const f = assistantTurnFixture(createStore());
      await f.create();
      const claim = await f.claim();
      await f.prepare(claim);
      const input = {
        ...claim.fence,
        disposition: "retry" as const,
        accounting: "not_called" as const,
        retryAt: new Date(Date.parse(f.clock.now()) + 1_000).toISOString(),
      };
      const accepted = await f.app.finishAssistantTurnAttempt(agent, input);
      expect(accepted).toMatchObject({
        outcome: "retry_scheduled",
        nextAttemptAt: input.retryAt,
      });
      const rows = await f.rows();
      expect(await f.app.finishAssistantTurnAttempt(agent, input)).toEqual(
        accepted,
      );
      expect(await f.rows()).toEqual(rows);
      await expect(
        f.app.finishAssistantTurnAttempt(agent, {
          ...input,
          retryAt: new Date(Date.parse(input.retryAt) + 1_000).toISOString(),
        }),
      ).rejects.toMatchObject({ name: "SupportDeskConflictError" });
      expect(await f.rows()).toEqual(rows);
      expect(rows.find((row) => row.kind === "assistant_turn")).toMatchObject({
        status: "retry",
        nextAttemptAt: input.retryAt,
      });
    });

    it("updates bounded attempts in place and retains unknown usage while preserving terminal record headroom", async () => {
      const f = assistantTurnFixture(createStore(), {
        assistantTurns: {
          maxAttempts: 4,
          maxTurnMilliseconds: 60_000,
          maxLeaseMilliseconds: 10_000,
        },
      });
      await f.create();
      const before = (await f.app.readStaffTicket(staff, "ticket")).ticket;
      const key = await f.candidate();
      for (let attempt = 1; attempt <= 4; attempt += 1) {
        const claim = await f.claim(`claim-${attempt}`);
        await f.app.prepareAssistantTurnAttempt(agent, {
          ...claim.fence,
          binding: f.binding(claim, {
            inputFingerprint: `input-${attempt}`,
            references: [
              {
                namespace: "knowledge",
                resourceId: "workspace-export",
                revision: "1",
                binding: "x".repeat(3_000),
              },
            ],
          }),
        });
        const retryAt = new Date(
          Date.parse(f.clock.now()) + 1_000,
        ).toISOString();
        const finished = await f.app.finishAssistantTurnAttempt(agent, {
          ...claim.fence,
          disposition: "retry",
          accounting: "unknown",
          retryAt,
          processing: {
            provider: "synthetic-provider",
            model: "synthetic-model",
            requestId: `request-${attempt}`,
            failureCategory: "synthetic-provider-timeout",
          },
        });
        expect(finished.outcome).toBe(
          attempt === 4 ? "escalated" : "retry_scheduled",
        );
        const rows = await f.rows();
        const job = rows.find((row) => row.kind === "assistant_turn");
        expect(job?.kind).toBe("assistant_turn");
        if (job?.kind !== "assistant_turn")
          throw new Error("Missing durable turn");
        expect(job.preparedAttempts).toHaveLength(attempt);
        expect(
          job.preparedAttempts.every(
            (prepared) => prepared.accounting === "unknown",
          ),
        ).toBe(true);
        expect(JSON.stringify(job).length * 2).toBeLessThanOrEqual(60_000);
        if (attempt < 4) {
          expect(rows).toHaveLength(7);
          expect((await f.app.readStaffTicket(staff, "ticket")).ticket).toEqual(
            before,
          );
          expect(JSON.stringify(job).length * 2).toBeLessThanOrEqual(52_000);
          expect(
            await f.app.claimAssistantTurn(agent, {
              ...key,
              workerId: "too-early",
              claimId: `too-early-${attempt}`,
              leaseMilliseconds: 10_000,
            }),
          ).toBeNull();
          f.advance(1_000);
        } else {
          expect(rows).toHaveLength(10);
          expect(
            rows.filter((row) => row.kind === "handoff_work"),
          ).toHaveLength(1);
        }
      }
      expect(
        (await f.app.readStaffTicket(staff, "ticket")).ticket.handling?.state,
      ).toBe("human-pending");
      expect(
        await f.app.claimAssistantTurn(agent, {
          ...key,
          workerId: "after-exhaustion",
          claimId: "after-exhaustion",
          leaseMilliseconds: 10_000,
        }),
      ).toBeNull();
    });

    it("leaves room for maximum Unicode processing metadata after every admitted full binding", async () => {
      const f = assistantTurnFixture(createStore(), {
        assistantTurns: {
          maxAttempts: 4,
          maxTurnMilliseconds: 60_000,
          maxLeaseMilliseconds: 10_000,
        },
      });
      const ticketId = '"'.repeat(200);
      await f.app.createCustomerTicket(customer, {
        ...f.createInput(true, ticketId),
        messageId: "initial-wide-ticket",
      });
      const processing = maximumAssistantProcessing();
      const acceptedBindings = [];
      for (let attempt = 1; attempt <= 4; attempt += 1) {
        const claim = await f.claim(`claim-${attempt}`, "worker", ticketId);
        const binding = assistantBindingWithinBytes(f.binding(claim), 12_000);
        expect(JSON.stringify(binding).length * 2).toBeGreaterThan(11_988);
        expect(JSON.stringify(binding).length * 2).toBeLessThanOrEqual(12_000);
        const before = await f.rows(ticketId);
        const preparation = await f.app
          .prepareAssistantTurnAttempt(agent, {
            ...claim.fence,
            binding,
          })
          .then(
            (prepared) => ({ prepared }),
            (error: unknown) => ({ error }),
          );
        if ("error" in preparation) {
          expect(preparation.error).toMatchObject({
            name: "SupportDeskLimitError",
            field: "serialized_record",
          });
          expect(await f.rows(ticketId)).toEqual(before);
          expect(
            await f.app.finishAssistantTurnAttempt(agent, {
              ...claim.fence,
              disposition: "escalate",
              accounting: "not_called",
              processing,
              summary: "\ud800".repeat(2_000),
            }),
          ).toMatchObject({ outcome: "escalated" });
          break;
        }
        acceptedBindings.push(binding);
        expect(preparation.prepared.binding).toEqual(binding);
        const result = await f.app.finishAssistantTurnAttempt(agent, {
          ...claim.fence,
          disposition: "retry",
          accounting: "unknown",
          processing,
          retryAt: new Date(Date.parse(f.clock.now()) + 1).toISOString(),
          summary: "\ud800".repeat(2_000),
        });
        expect(result.outcome).toBe(
          attempt === 4 ? "escalated" : "retry_scheduled",
        );
        const job = (await f.rows(ticketId)).find(
          (row) => row.kind === "assistant_turn",
        );
        if (job?.kind !== "assistant_turn")
          throw new Error("Missing durable turn");
        expect(job.processing).toEqual(processing);
        expect(job.preparedAttempts.at(-1)?.processing).toEqual(processing);
        expect(JSON.stringify(job).length * 2).toBeLessThanOrEqual(60_000);
        if (result.outcome === "retry_scheduled") f.advance(1);
      }
      expect(acceptedBindings.length).toBeGreaterThan(0);
      const rows = await f.rows(ticketId);
      const terminal = rows.find((row) => row.kind === "assistant_turn");
      if (terminal?.kind !== "assistant_turn")
        throw new Error("Missing durable turn");
      expect(terminal.status).toBe("escalated");
      expect(terminal.processing).toEqual(processing);
      expect(
        terminal.preparedAttempts.map((attempt) => attempt.binding),
      ).toEqual(acceptedBindings);
      expect(
        terminal.preparedAttempts.every(
          (attempt) =>
            JSON.stringify(attempt.processing) === JSON.stringify(processing),
        ),
      ).toBe(true);
      expect(JSON.stringify(terminal).length * 2).toBeLessThanOrEqual(60_000);
      expect(await f.app.readHandoffWork(staff, ticketId)).toHaveLength(1);
      expect(
        (await f.app.readStaffTicket(staff, ticketId)).ticket.handling?.state,
      ).toBe("human-pending");
    });

    it("completes an admitted answer with full processing metadata after retaining an earlier full attempt", async () => {
      const f = assistantTurnFixture(createStore(), {
        assistantTurns: {
          maxAttempts: 4,
          maxTurnMilliseconds: 60_000,
          maxLeaseMilliseconds: 10_000,
        },
      });
      const ticketId = '"'.repeat(200);
      await f.app.createCustomerTicket(customer, {
        ...f.createInput(true, ticketId),
        messageId: "initial-wide-ticket",
      });
      const processing = maximumAssistantProcessing();
      const first = await f.claim("first", "worker", ticketId);
      const firstBinding = assistantBindingWithinBytes(
        f.binding(first),
        12_000,
      );
      expect(JSON.stringify(processing).length * 2).toBe(10_898);
      expect(JSON.stringify(firstBinding).length * 2).toBeGreaterThan(11_988);
      await f.app.prepareAssistantTurnAttempt(agent, {
        ...first.fence,
        binding: firstBinding,
      });
      await f.app.finishAssistantTurnAttempt(agent, {
        ...first.fence,
        disposition: "retry",
        accounting: "unknown",
        processing,
        retryAt: f.clock.now(),
      });
      const second = await f.claim("second", "worker", ticketId);
      const secondBinding = assistantBindingWithinBytes(
        f.binding(second),
        3_000,
      );
      // The remaining allowance also has to retain this attempt's maximum
      // processing metadata and admit a replacement owner's maximum IDs.
      expect(JSON.stringify(secondBinding).length * 2).toBeGreaterThan(2_988);
      expect(JSON.stringify(secondBinding).length * 2).toBeLessThanOrEqual(
        3_000,
      );
      await f.app.prepareAssistantTurnAttempt(agent, {
        ...second.fence,
        binding: secondBinding,
      });
      const prepared = (await f.rows(ticketId)).find(
        (row) => row.kind === "assistant_turn",
      );
      expect(JSON.stringify(prepared).length * 2).toBeLessThanOrEqual(52_000);
      const command = {
        ...assistantAnswer(second, secondBinding.inputFingerprint),
        outcome: {
          kind: "answer" as const,
          messageId: "回".repeat(200),
          body: "Open Workspace and choose Export.",
        },
        processing,
      };
      const result = await f.app.completeAssistantTurn(
        agent,
        command,
        () => {},
      );
      const rows = await f.rows(ticketId);
      const terminal = rows.find((row) => row.kind === "assistant_turn");
      if (terminal?.kind !== "assistant_turn")
        throw new Error("Missing durable turn");
      expect(terminal.status).toBe("completed");
      expect(terminal.processing).toEqual(processing);
      expect(terminal.preparedAttempts[0]).toMatchObject({
        binding: firstBinding,
        processing,
        accounting: "unknown",
      });
      expect(terminal.preparedAttempts[1]?.binding).toEqual(secondBinding);
      expect(JSON.stringify(terminal).length * 2).toBeLessThanOrEqual(60_000);
      expect(
        (await f.app.readCustomerTicket(customer, ticketId)).messages.at(-1)
          ?.id,
      ).toBe(command.outcome.messageId);
      expect(
        await f.app.completeAssistantTurn(agent, command, () => {}),
      ).toEqual(result);
      expect(await f.rows(ticketId)).toEqual(rows);
    });

    it.each(["turn deadline", "retry after deadline"] as const)(
      "atomically hands off at the %s instead of leaving an assistant job stuck",
      async (expiration) => {
        const f = assistantTurnFixture(createStore(), {
          assistantTurns: {
            maxAttempts: 3,
            maxTurnMilliseconds: 1_000,
            maxLeaseMilliseconds: 500,
          },
        });
        await f.create();
        const key = await f.candidate();
        if (expiration === "turn deadline") {
          f.advance(1_001);
          expect(
            await f.app.claimAssistantTurn(agent, {
              ...key,
              workerId: "worker",
              claimId: "late-claim",
              leaseMilliseconds: 500,
            }),
          ).toBeNull();
        } else {
          const claim = await f.claim("claim", "worker", "ticket", 500);
          await f.prepare(claim);
          expect(
            await f.app.finishAssistantTurnAttempt(agent, {
              ...claim.fence,
              disposition: "retry",
              accounting: "not_called",
              retryAt: new Date(
                Date.parse(claim.turnDeadline) + 1,
              ).toISOString(),
            }),
          ).toMatchObject({ outcome: "escalated" });
        }
        const rows = await f.rows();
        expect(rows.filter((row) => row.kind === "handoff_work")).toHaveLength(
          1,
        );
        expect(rows.find((row) => row.kind === "assistant_turn")).toMatchObject(
          { status: "escalated" },
        );
        expect(
          (await f.app.readStaffTicket(staff, "ticket")).ticket.handling?.state,
        ).toBe("human-pending");
        expect(
          (await f.app.readCustomerTicket(customer, "ticket")).messages,
        ).toHaveLength(1);
      },
    );
  });
}
