import {
  createInboundMailProcessor,
  supportRecords,
  type CompleteAssistantTurnCommand,
  type SupportRecord,
} from "@pegma/support-desk-application";
import { describe, expect, it } from "vitest";
import {
  assistantAnswer,
  assistantTurnFixture,
} from "../test/assistant-turn-fixtures.js";
import {
  handlingAgent as agent,
  handlingBarrier,
  handlingCustomer as customer,
  handlingStaff as staff,
  handlingStores,
} from "../test/handling-fixtures.js";

for (const [name, createStore] of handlingStores) {
  describe(`durable assistant completion (${name})`, () => {
    it.each(["answer", "escalate"] as const)(
      "commits %s with terminal job, ticket, audit and receipt in one transaction",
      async (outcome) => {
        const f = assistantTurnFixture(createStore());
        await f.create();
        const claim = await f.claim();
        const prepared = await f.prepare(claim);
        const before = await f.rows();
        f.observed.transactions.length = 0;
        const command: CompleteAssistantTurnCommand = {
          ...claim.fence,
          inputFingerprint: prepared.inputFingerprint,
          outcome:
            outcome === "answer"
              ? assistantAnswer(claim, prepared.inputFingerprint).outcome
              : {
                  kind: "escalate",
                  reason: "no_guidance",
                  summary: "PRIVATE_HANDOFF_SUMMARY",
                  attemptedGuideIds: ["workspace-export"],
                },
          processing: {
            provider: "synthetic-provider",
            model: "synthetic-model",
            requestId: "synthetic-request",
            inputTokens: 100,
            outputTokens: 20,
            costMicros: 2,
            currency: "USD",
          },
        };
        let guardCalls = 0;
        const result = await f.app.completeAssistantTurn(agent, command, () => {
          guardCalls += 1;
        });
        expect(guardCalls).toBe(1);
        const rows = await f.rows();
        expect(rows).toHaveLength(before.length + 3);
        expect(rows.find((row) => row.kind === "assistant_turn")).toMatchObject(
          {
            status: outcome === "answer" ? "completed" : "escalated",
            terminalResult: result,
          },
        );
        const transactions = f.observed.transactions.filter(
          (trace) => trace.collection === supportRecords.name,
        );
        expect(transactions).toHaveLength(1);
        expect(transactions[0]?.partition).toBe("ticket");
        const atomicKinds = transactions[0]?.actions
          .filter((action) => action.action !== "delete")
          .map((action) => (action.value as SupportRecord).kind);
        expect(atomicKinds).toEqual(
          expect.arrayContaining([
            "ticket",
            "assistant_turn",
            "audit",
            "command",
          ]),
        );
        if (outcome === "answer")
          expect(atomicKinds).toEqual(
            expect.arrayContaining(["message", "ticket_quota"]),
          );
        else {
          expect(atomicKinds).toContain("handoff_work");
          expect(atomicKinds).not.toContain("message");
          expect(atomicKinds).not.toContain("ticket_quota");
          expect(rows.find((row) => row.kind === "ticket_quota")).toEqual(
            before.find((row) => row.kind === "ticket_quota"),
          );
        }
        const visible = await f.app.readCustomerTicket(customer, "ticket");
        expect(visible.messages).toHaveLength(outcome === "answer" ? 2 : 1);
        expect(JSON.stringify(visible)).not.toContain(
          "PRIVATE_HANDOFF_SUMMARY",
        );
        const ticket = (await f.app.readStaffTicket(staff, "ticket")).ticket;
        expect(ticket).not.toHaveProperty("firstStaffRespondedAt");
        if (outcome === "answer")
          expect(visible.messages.at(-1)?.authorKind).toBe("assistant");
        else expect(ticket.handling?.state).toBe("human-pending");
        expect(
          await f.app.completeAssistantTurn(agent, command, () => {
            throw new Error("Committed replay must not revalidate sources");
          }),
        ).toEqual(result);
        expect(await f.rows()).toEqual(rows);
      },
    );

    it("replays the historical acknowledgment after a lost commit response, human takeover and lease expiry", async () => {
      const f = assistantTurnFixture(createStore());
      await f.create();
      const claim = await f.claim();
      const prepared = await f.prepare(claim);
      const command = assistantAnswer(claim, prepared.inputFingerprint);
      let dropped = false;
      f.observed.intercept(async (trace, commit) => {
        const result = await commit();
        if (
          !dropped &&
          result.committed &&
          trace.collection === supportRecords.name &&
          trace.actions.some(
            (action) =>
              action.action !== "delete" &&
              (action.value as SupportRecord).kind === "message",
          )
        ) {
          dropped = true;
          throw new Error("Synthetic lost completion acknowledgment");
        }
        return result;
      });
      await f.app
        .completeAssistantTurn(agent, command, () => {})
        .catch(() => undefined);
      f.observed.intercept(undefined);
      expect(dropped).toBe(true);
      const completed = (await f.rows()).find(
        (row) => row.kind === "assistant_turn",
      );
      if (completed?.kind !== "assistant_turn")
        throw new Error("Missing durable turn");
      expect(completed.status).toBe("completed");
      const current = (await f.app.readStaffTicket(staff, "ticket")).ticket;
      await f.app.takeOverTicket(staff, {
        ...f.command("takeover-after-completion"),
        expectedRevision: current.revision,
        expectedHandlingGeneration: current.handling!.generation,
      });
      f.advance(60_001);
      const afterTakeover = await f.rows();
      let guardCalls = 0;
      expect(
        await f.freshApplication().completeAssistantTurn(agent, command, () => {
          guardCalls += 1;
          throw new Error(
            "A historical acknowledgment needs no new model/source work",
          );
        }),
      ).toEqual(completed.terminalResult);
      expect(guardCalls).toBe(0);
      expect(await f.rows()).toEqual(afterTakeover);
      expect(
        (await f.app.readCustomerTicket(customer, "ticket")).messages.filter(
          (message) => message.authorKind === "assistant",
        ),
      ).toHaveLength(1);
      await expect(
        f.app.completeAssistantTurn(
          agent,
          {
            ...command,
            outcome: {
              ...command.outcome,
              body: "Different uncommitted answer",
            },
          },
          () => {},
        ),
      ).rejects.toThrow();
      expect(await f.rows()).toEqual(afterTakeover);
    });

    it("leaves no partial reply when the transaction is refused and accepts the exact command once on retry", async () => {
      const f = assistantTurnFixture(createStore(), { maxConflictAttempts: 1 });
      await f.create();
      const claim = await f.claim();
      const prepared = await f.prepare(claim);
      const command = assistantAnswer(claim, prepared.inputFingerprint);
      const before = await f.rows();
      f.observed.intercept(async (trace, commit) =>
        trace.collection === supportRecords.name
          ? { committed: false, reason: "changed" }
          : commit(),
      );
      await expect(
        f.app.completeAssistantTurn(agent, command, () => {}),
      ).rejects.toThrow();
      f.observed.intercept(undefined);
      expect(await f.rows()).toEqual(before);
      const accepted = await f.app.completeAssistantTurn(
        agent,
        command,
        () => {},
      );
      const committed = await f.rows();
      expect(
        await f.app.completeAssistantTurn(agent, command, () => {}),
      ).toEqual(accepted);
      expect(await f.rows()).toEqual(committed);
    });

    it("reruns the trusted asynchronous source guard before every CAS retry", async () => {
      const f = assistantTurnFixture(createStore());
      await f.create();
      const claim = await f.claim();
      const prepared = await f.prepare(claim);
      const before = await f.rows();
      let currentSource = true;
      let transactions = 0;
      let guards = 0;
      f.observed.intercept(async (trace, commit) => {
        if (trace.collection === supportRecords.name) {
          transactions += 1;
          if (transactions === 1) {
            currentSource = false;
            return { committed: false, reason: "changed" };
          }
        }
        return commit();
      });
      await expect(
        f.app.completeAssistantTurn(
          agent,
          assistantAnswer(claim, prepared.inputFingerprint),
          async () => {
            guards += 1;
            await Promise.resolve();
            if (!currentSource) throw new Error("Synthetic source was revoked");
          },
        ),
      ).rejects.toThrow("Synthetic source was revoked");
      f.observed.intercept(undefined);
      expect(guards).toBe(2);
      expect(transactions).toBe(1);
      expect(await f.rows()).toEqual(before);
    });

    it.each(["lease", "turn deadline"] as const)(
      "does not post when the %s expires during the trusted guard",
      async (expiration) => {
        const f = assistantTurnFixture(createStore(), {
          assistantTurns: {
            maxAttempts: 3,
            maxTurnMilliseconds: expiration === "lease" ? 60_000 : 1_000,
            maxLeaseMilliseconds: 10_000,
          },
        });
        await f.create();
        const claim = await f.claim();
        const prepared = await f.prepare(claim);
        const before = await f.rows();
        const gate = handlingBarrier();
        const pending = f.app
          .completeAssistantTurn(
            agent,
            assistantAnswer(claim, prepared.inputFingerprint),
            () => gate.wait(),
          )
          .then(
            (value) => ({ value }),
            (error: unknown) => ({ error }),
          );
        try {
          await Promise.race([
            gate.reached,
            pending.then(() => {
              throw new Error("Completion never reached guard");
            }),
          ]);
          f.advance(expiration === "lease" ? 10_001 : 1_001);
        } finally {
          gate.release();
        }
        expect(await pending).toHaveProperty("error");
        expect(await f.rows()).toEqual(before);
        expect(
          (await f.app.readCustomerTicket(customer, "ticket")).messages,
        ).toHaveLength(1);
      },
    );

    it.each([
      "customer reply",
      "takeover",
      "request person",
      "staff reply",
      "resolve",
      "reopen",
      "internal note",
    ] as const)(
      "rejects an old fence after %s before invoking the trusted guard",
      async (change) => {
        const f = assistantTurnFixture(createStore());
        await f.create();
        const claim = await f.claim();
        const prepared = await f.prepare(claim);
        const command = f.command("interleaved-change");
        switch (change) {
          case "customer reply":
            await f.app.replyToCustomerTicket(customer, {
              ...command,
              messageId: "new-customer",
              body: "New export question",
            });
            break;
          case "takeover":
            await f.app.takeOverTicket(staff, {
              ...command,
              expectedRevision: claim.fence.expectedRevision,
              expectedHandlingGeneration:
                claim.fence.expectedHandlingGeneration,
            });
            break;
          case "request person":
            await f.app.requestPerson(customer, command);
            break;
          case "staff reply":
            await f.app.replyAsStaff(staff, {
              ...command,
              messageId: "human-answer",
              body: "Human response",
            });
            break;
          case "resolve":
            await f.app.resolveTicket(staff, command);
            break;
          case "reopen":
            await f.app.resolveTicket(
              staff,
              f.command("resolve-before-reopen"),
            );
            await f.app.reopenTicket(staff, command);
            break;
          case "internal note":
            await f.app.addNote(staff, {
              ...command,
              messageId: "private-note",
              body: "PRIVATE_DURING_TURN",
            });
            break;
        }
        const afterChange = await f.rows();
        let guards = 0;
        await expect(
          f.app.completeAssistantTurn(
            agent,
            assistantAnswer(claim, prepared.inputFingerprint),
            () => {
              guards += 1;
            },
          ),
        ).rejects.toThrow();
        expect(guards).toBe(0);
        expect(await f.rows()).toEqual(afterChange);
        if (change === "internal note") {
          expect(
            await f.app.finishAssistantTurnAttempt(agent, {
              ...claim.fence,
              disposition: "retry",
              accounting: "not_called",
              retryAt: f.clock.now(),
            }),
          ).toMatchObject({ outcome: "retry_scheduled" });
          const next = await f.claim("after-note");
          expect(next.fence.triggerMessageId).toBe(
            claim.fence.triggerMessageId,
          );
          expect(next.fence.expectedRevision).toBeGreaterThan(
            claim.fence.expectedRevision,
          );
          expect(next.fence.attempt).toBe(2);
          expect(JSON.stringify(next.conversation)).not.toContain(
            "PRIVATE_DURING_TURN",
          );
        }
      },
    );

    it.each(["during guard", "reopens terminal ticket"] as const)(
      "atomically hands a qualified email to humans when it %s and never schedules an email turn",
      async (timing) => {
        const f = assistantTurnFixture(createStore());
        const created = await f.app.createCustomerTicket(customer, {
          ...f.createInput(),
          requesterEmail: "customer@fixtures.invalid",
        });
        const claim = await f.claim();
        const prepared = await f.prepare(claim);
        if (timing === "reopens terminal ticket")
          await f.app.resolveTicket(staff, f.command("resolve-before-email"));
        const processor = createInboundMailProcessor({
          store: f.store,
          clock: f.clock,
          subjectMarkerPrefix: "SD",
          accountMatcher: {
            matchSenderEmail: async () => ({
              matches: "one",
              principalId: customer.principalId,
            }),
          },
          routingPolicy: {
            routeNewConversation: () => ({ priority: "normal" }),
          },
        });
        const gate = handlingBarrier();
        const pending =
          timing === "during guard"
            ? f.app
                .completeAssistantTurn(
                  agent,
                  assistantAnswer(claim, prepared.inputFingerprint),
                  () => gate.wait(),
                )
                .then(
                  (value) => ({ value }),
                  (error: unknown) => ({ error }),
                )
            : undefined;
        try {
          if (pending !== undefined)
            await Promise.race([
              gate.reached,
              pending.then(() => {
                throw new Error("Completion never reached guard");
              }),
            ]);
          expect(
            await processor.processInboundEmail({
              channelId: "synthetic-mail",
              providerEventId: `email-${timing}`,
              ticketId: "unused-fallback",
              messageId: "email-reply",
              correlationId: "synthetic-email",
              from: "customer@fixtures.invalid",
              subject: `Re: [SD-${created.ticket.number}] Synthetic workspace export`,
              body: "Further detail by email",
              senderAuthentication: {
                method: "host_identity",
                result: "pass",
                email: "customer@fixtures.invalid",
              },
            }),
          ).toMatchObject({ outcome: "replied", ticketId: "ticket" });
        } finally {
          gate.release();
        }
        if (pending !== undefined)
          expect(await pending).toHaveProperty("error");
        else
          await expect(
            f.app.completeAssistantTurn(
              agent,
              assistantAnswer(claim, prepared.inputFingerprint),
              () => {},
            ),
          ).rejects.toThrow();
        const detail = await f.app.readStaffTicket(staff, "ticket");
        expect(detail.ticket.channel).toBe("web");
        expect(detail.ticket.handling?.state).toBe("human-pending");
        expect(detail.ticket.status).toBe("waiting_on_support");
        expect(detail.messages.map((message) => message.channel)).toEqual([
          "web",
          "email",
        ]);
        const rows = await f.rows();
        expect(
          rows.filter((row) => row.kind === "assistant_turn"),
        ).toHaveLength(1);
        expect(
          (await f.app.readHandoffWork(staff, "ticket")).map(
            (work) => work.reason,
          ),
        ).toContain("email_reply");
        const emailTransaction = f.observed.transactions.find((trace) =>
          trace.actions.some(
            (action) =>
              action.action !== "delete" &&
              (action.value as SupportRecord).kind === "handoff_work" &&
              (action.value as { reason?: string }).reason === "email_reply",
          ),
        );
        expect(
          emailTransaction?.actions
            .filter((action) => action.action !== "delete")
            .map((action) => (action.value as SupportRecord).kind),
        ).toEqual(
          expect.arrayContaining([
            "ticket",
            "message",
            "ticket_quota",
            "handoff_work",
            "audit",
            "command",
          ]),
        );
      },
    );
  });
}
