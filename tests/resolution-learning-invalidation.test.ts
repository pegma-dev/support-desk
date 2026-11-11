import {
  createInboundMailProcessor,
  createSupportDeskApplication,
  type ResolutionLearningSourceRecord,
  type ResolutionSourceFence,
  type SupportRecord,
} from "@pegma/support-desk-application";
import type { CollectionDefinition, Store } from "@pegma/storage-core";
import { describe, expect, it } from "vitest";
import { handlingBarrier } from "../test/handling-fixtures.js";
import {
  learningCustomer as customer,
  learningService as service,
  learningStaff as staff,
  learningStores,
  resolutionLearningFixture,
} from "../test/resolution-learning-fixtures.js";

type Fixture = ReturnType<typeof resolutionLearningFixture>;
const executors = [
  "request person",
  "customer web reply",
  "staff reply",
  "lifecycle reopen",
  "inbound append",
] as const;
type Executor = (typeof executors)[number];

function sourceFence(
  source: ResolutionLearningSourceRecord,
): ResolutionSourceFence {
  return {
    ticketId: source.ticketId,
    sourceGeneration: source.sourceGeneration,
    resolutionCycle: source.resolutionCycle,
    sourceBindingHash: source.sourceBindingHash!,
  };
}

async function mutation(f: Fixture, executor: Executor) {
  const command = f.command("reopening-mutation");
  if (executor === "request person")
    return () => f.app.requestPerson(customer, command);
  if (executor === "customer web reply")
    return () =>
      f.app.replyToCustomerTicket(customer, {
        ...command,
        messageId: "new-customer-reply",
        body: "The export still fails after signing in again.",
      });
  if (executor === "staff reply")
    return () =>
      f.app.replyAsStaff(staff, {
        ...command,
        messageId: "new-staff-reply",
        body: "We are reassessing the export fix.",
      });
  if (executor === "lifecycle reopen")
    return () => f.app.reopenTicket(staff, command);
  const ticket = (await f.app.readStaffTicket(staff, "ticket")).ticket;
  const processor = createInboundMailProcessor({
    store: f.store,
    clock: f.clock,
    maxConflictAttempts: 1,
    subjectMarkerPrefix: "SD",
    accountMatcher: {
      matchSenderEmail: async () => ({
        matches: "one",
        principalId: customer.principalId,
      }),
    },
    routingPolicy: { routeNewConversation: () => ({ priority: "normal" }) },
  });
  return () =>
    processor.processInboundEmail({
      channelId: "synthetic-learning-mail",
      providerEventId: command.commandId,
      ticketId: "unused-inbound-fallback",
      messageId: "new-inbound-reply",
      correlationId: command.correlationId,
      from: "customer@fixtures.invalid",
      senderAuthentication: {
        method: "host_identity",
        result: "pass",
        email: "customer@fixtures.invalid",
      },
      subject: `Re: [SD-${ticket.number}] Synthetic workspace export`,
      body: "The export still fails after signing in again.",
    });
}

for (const [name, createStore] of learningStores) {
  describe(`persisted resolution source invalidation (${name})`, () => {
    for (const status of ["resolved", "closed"] as const) {
      it.each(executors)(
        `invalidates ${status} source atomically through %s`,
        async (executor) => {
          const f = resolutionLearningFixture(createStore());
          await f.terminal();
          await f.confirm();
          if (status === "closed")
            await f.app.closeTicket(staff, f.command("close-source"));
          const before = await f.source();
          const ticketBefore = (await f.app.readStaffTicket(staff, "ticket"))
            .ticket;
          const oldFence = sourceFence(before);
          expect(
            await f.app.confirmResolutionLearningSource(service, oldFence),
          ).toBe(true);
          const invoke = await mutation(f, executor);
          f.observed.transactions.length = 0;
          await invoke();
          const after = await f.source();
          const ticketAfter = (await f.app.readStaffTicket(staff, "ticket"))
            .ticket;
          expect(after).toMatchObject({
            state: "held",
            heldReason: "reopened",
            resolutionCycle: before.resolutionCycle + 1,
            sourceGeneration: before.sourceGeneration + 1,
            reconciliationPending: false,
          });
          expect(ticketAfter.status).not.toBe("resolved");
          expect(ticketAfter.status).not.toBe("closed");
          expect(ticketAfter.resolvedAt).toBeUndefined();
          expect(ticketAfter.revision).toBeGreaterThan(ticketBefore.revision);
          if (executor === "customer web reply") {
            expect(ticketAfter.revision).toBe(ticketBefore.revision + 1);
            expect(ticketAfter.handling?.state).toBe(
              ticketBefore.handling?.state,
            );
          }
          const transactions = f.observed.transactions.filter(
            (trace) =>
              trace.collection === "support-desk.records.v1" &&
              trace.partition === "ticket",
          );
          expect(transactions).toHaveLength(1);
          const writes = transactions[0]!.actions.filter(
            (action) => action.action !== "delete",
          );
          expect(
            writes.filter(
              (action) => (action.value as SupportRecord).kind === "ticket",
            ),
          ).toHaveLength(1);
          expect(
            writes.filter(
              (action) =>
                (action.value as SupportRecord).kind ===
                "resolution_learning_source",
            ),
          ).toHaveLength(1);
          expect(
            new Set(writes.map((action) => (action.value as SupportRecord).id))
              .size,
          ).toBe(writes.length);
          expect(
            writes.find(
              (action) =>
                (action.value as SupportRecord).kind ===
                "resolution_learning_source",
            )?.action,
          ).toBe("putIfUnchanged");
          expect(
            await f.app.confirmResolutionLearningSource(service, oldFence),
          ).toBe(false);
          expect(
            await f.app.claimResolutionLearningWork(service, {
              ticketId: "ticket",
              sourceGeneration: before.sourceGeneration,
              workerId: "stale-worker",
              claimId: "stale-claim",
              leaseMilliseconds: 1_000,
            }),
          ).toBeNull();
          const rows = await f.rows();
          await invoke();
          expect(await f.rows()).toEqual(rows);
          expect(await f.rows("unused-inbound-fallback")).toEqual([]);
        },
      );
    }

    it.each(["resolved", "closed"] as const)(
      "invalidates an assistant-managed %s source after the second customer-reply handoff transition",
      async (status) => {
        const f = resolutionLearningFixture(createStore(), {
          assistantTurns: {},
        });
        await f.terminal();
        await f.confirm();
        if (status === "closed")
          await f.app.closeTicket(
            staff,
            f.command("close-before-disabled-reply"),
          );
        const sourceBefore = await f.source();
        const ticketBefore = (await f.app.readStaffTicket(staff, "ticket"))
          .ticket;
        expect(ticketBefore.handling?.state).toBe("assistant");
        const disabled = f.freshApplication({
          assistantHandlingEnabled: false,
        });
        const command = {
          ...f.command("disabled-assistant-customer-reply"),
          messageId: "disabled-assistant-customer-reply",
          body: "The export needs a person to reassess the fix.",
        };
        f.observed.transactions.length = 0;
        await disabled.replyToCustomerTicket(customer, command);
        const ticketAfter = (await f.app.readStaffTicket(staff, "ticket"))
          .ticket;
        expect(ticketAfter).toMatchObject({
          status: "waiting_on_support",
          revision: ticketBefore.revision + 2,
          handling: { state: "human-pending" },
        });
        expect(ticketAfter.resolvedAt).toBeUndefined();
        expect(await f.source()).toMatchObject({
          state: "held",
          heldReason: "reopened",
          sourceGeneration: sourceBefore.sourceGeneration + 1,
          resolutionCycle: sourceBefore.resolutionCycle + 1,
        });
        const transactions = f.observed.transactions.filter(
          (trace) =>
            trace.collection === "support-desk.records.v1" &&
            trace.partition === "ticket",
        );
        expect(transactions).toHaveLength(1);
        const writes = transactions[0]!.actions.filter(
          (action) => action.action !== "delete",
        );
        const ticketWrites = writes.filter(
          (action) => (action.value as SupportRecord).kind === "ticket",
        );
        const sourceWrites = writes.filter(
          (action) =>
            (action.value as SupportRecord).kind ===
            "resolution_learning_source",
        );
        expect(ticketWrites).toHaveLength(1);
        expect(sourceWrites).toHaveLength(1);
        expect(ticketWrites[0]!.value).toMatchObject({ ticket: ticketAfter });
        expect(sourceWrites[0]!.action).toBe("putIfUnchanged");
        expect(
          writes.map((action) => (action.value as SupportRecord).kind),
        ).toEqual(
          expect.arrayContaining([
            "ticket",
            "resolution_learning_source",
            "message",
            "handoff_work",
            "audit",
            "command",
          ]),
        );
        expect(
          new Set(writes.map((action) => (action.value as SupportRecord).id))
            .size,
        ).toBe(writes.length);
        expect(
          await disabled.confirmResolutionLearningSource(
            service,
            sourceFence(sourceBefore),
          ),
        ).toBe(false);
        const rows = await f.rows();
        await disabled.replyToCustomerTicket(customer, command);
        expect(await f.rows()).toEqual(rows);
      },
    );

    for (const failure of ["changed", "failure"] as const) {
      it.each(executors)(
        `keeps source and ticket unchanged when %s transaction has ${failure}`,
        async (executor) => {
          const f = resolutionLearningFixture(createStore(), {
            maxConflictAttempts: 1,
          });
          await f.terminal();
          await f.confirm();
          const invoke = await mutation(f, executor);
          const before = await f.rows();
          let refused = 0;
          f.observed.intercept(async (trace, commit) => {
            if (
              trace.collection !== "support-desk.records.v1" ||
              trace.partition !== "ticket"
            )
              return commit();
            refused += 1;
            if (failure === "failure")
              throw new Error("Synthetic atomic transaction failure");
            return { committed: false, reason: "changed" };
          });
          await expect(invoke()).rejects.toThrow();
          f.observed.intercept(undefined);
          expect(refused).toBeGreaterThan(0);
          expect(await f.rows()).toEqual(before);
          expect((await f.source()).state).toBe("eligible");
          await invoke();
          expect(await f.source()).toMatchObject({
            state: "held",
            resolutionCycle: 2,
            sourceGeneration: 2,
          });
        },
      );
    }

    it("preserves the resolution cycle and accepted evidence through close and private metadata changes", async () => {
      const f = resolutionLearningFixture(createStore(), {
        allowedTags: ["review"],
      });
      await f.terminal();
      await f.confirm();
      const before = await f.source();
      const fence = sourceFence(before);
      await f.app.closeTicket(staff, f.command("close-only"));
      await f.app.assignTicket(staff, {
        ...f.command("assign-only"),
        assigneeId: "staff/assigned",
      });
      await f.app.changePriority(staff, {
        ...f.command("priority-only"),
        priority: "high",
      });
      await f.app.setTags(staff, {
        ...f.command("tags-only"),
        tags: ["review"],
      });
      await f.app.addNote(staff, {
        ...f.command("note-only"),
        messageId: "private-note-only",
        body: "PRIVATE_METADATA_NOTE_CANARY",
      });
      expect(await f.source()).toEqual(before);
      expect(await f.app.confirmResolutionLearningSource(service, fence)).toBe(
        true,
      );
      expect((await f.app.readStaffTicket(staff, "ticket")).ticket.status).toBe(
        "closed",
      );
      expect(
        JSON.stringify(await f.app.readCustomerTicket(customer, "ticket")),
      ).not.toContain("PRIVATE_METADATA_NOTE_CANARY");
      expect(f.trust.productCalls).toHaveLength(1);
    });

    it("recomputes one source invalidation after a real ticket CAS conflict", async () => {
      const f = resolutionLearningFixture(createStore());
      await f.terminal();
      await f.confirm();
      const before = await f.source();
      const gate = handlingBarrier();
      let paused = false;
      f.observed.intercept(async (trace, commit) => {
        if (
          !paused &&
          trace.collection === "support-desk.records.v1" &&
          trace.actions.some(
            (action) =>
              action.action !== "delete" &&
              (action.value as SupportRecord).kind ===
                "resolution_learning_source",
          )
        ) {
          paused = true;
          await gate.wait();
        }
        return commit();
      });
      const pending = f.app
        .reopenTicket(staff, f.command("racing-reopen"))
        .then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
      try {
        await Promise.race([
          gate.reached,
          pending.then(() => {
            throw new Error(
              "Reopen did not reach its real transaction barrier",
            );
          }),
        ]);
        await f.freshApplication().addNote(staff, {
          ...f.command("concurrent-note"),
          messageId: "concurrent-private-note",
          body: "PRIVATE_CONCURRENT_NOTE",
        });
      } finally {
        gate.release();
      }
      expect(await pending).toHaveProperty("value");
      f.observed.intercept(undefined);
      expect(await f.source()).toMatchObject({
        state: "held",
        sourceGeneration: before.sourceGeneration + 1,
        resolutionCycle: before.resolutionCycle + 1,
      });
      expect(
        (await f.app.readStaffTicket(staff, "ticket")).messages.some(
          (message) => message.id === "concurrent-private-note",
        ),
      ).toBe(true);
      expect(
        (await f.rows()).filter(
          (row) => row.kind === "resolution_learning_work",
        ),
      ).toHaveLength(1);
    });

    it("rejects a stale source confirmation when reopen commits during its awaited versioned partition observation", async () => {
      const f = resolutionLearningFixture(createStore());
      await f.terminal();
      await f.confirm();
      const fence = sourceFence(await f.source());
      const gate = handlingBarrier();
      let paused = false;
      const observed: Store = {
        collection<T>(definition: CollectionDefinition<T>) {
          const target = f.store.collection(definition);
          return new Proxy(target, {
            get(object, property) {
              if (
                definition.name === "support-desk.records.v1" &&
                property === "listVersioned"
              )
                return async (partition: string) => {
                  const rows = await object.listVersioned(partition);
                  if (partition === "ticket" && !paused) {
                    paused = true;
                    await gate.wait();
                  }
                  return rows;
                };
              const value: unknown = Reflect.get(object, property, object);
              return typeof value === "function" ? value.bind(object) : value;
            },
          });
        },
      };
      const confirming = createSupportDeskApplication({
        store: observed,
        clock: f.clock,
        resolutionLearning: f.learningOptions,
      });
      const pending = confirming.confirmResolutionLearningSource(
        service,
        fence,
      );
      try {
        await Promise.race([
          gate.reached,
          pending.then(() => {
            throw new Error(
              "Source confirmation did not reach its real listVersioned barrier",
            );
          }),
        ]);
        await f.app.reopenTicket(
          staff,
          f.command("reopen-during-confirmation"),
        );
        expect(await f.source()).toMatchObject({
          state: "held",
          resolutionCycle: fence.resolutionCycle + 1,
          sourceGeneration: fence.sourceGeneration + 1,
        });
      } finally {
        gate.release();
      }
      expect(await pending).toBe(false);
      expect(await f.app.confirmResolutionLearningSource(service, fence)).toBe(
        false,
      );
    });

    it.each(["disabled", "unconfigured"] as const)(
      "never revives old proof after a %s application reopens and resolves an enrolled source",
      async (configuration) => {
        const f = resolutionLearningFixture(createStore());
        await f.terminal();
        await f.confirm();
        const before = await f.source();
        const fence = sourceFence(before);
        const application = f.freshApplication({
          resolutionLearning:
            configuration === "disabled"
              ? { ...f.learningOptions, enabled: false }
              : undefined,
        });
        expect(
          await application.confirmResolutionLearningSource(service, fence),
        ).toBe(true);
        await application.reopenTicket(staff, f.command("off-reopen"));
        await application.resolveTicket(staff, f.command("off-resolve"));
        expect(
          (await application.readStaffTicket(staff, "ticket")).ticket.status,
        ).toBe("resolved");
        expect(await f.source()).toMatchObject({
          state: "held",
          heldReason: "reopened",
          sourceGeneration: before.sourceGeneration + 1,
          resolutionCycle: before.resolutionCycle + 1,
        });
        expect(
          await application.confirmResolutionLearningSource(service, fence),
        ).toBe(false);
        expect(
          await f.app.confirmResolutionLearningSource(service, fence),
        ).toBe(false);
        expect(
          (await f.rows()).filter(
            (row) => row.kind === "resolution_learning_work",
          ),
        ).toHaveLength(1);
      },
    );

    it("requires fresh current-cycle verification when learning generation capacity is exhausted", async () => {
      const f = resolutionLearningFixture(createStore(), {
        resolutionLearning: { maxGenerations: 1 },
      });
      await f.terminal();
      await f.confirm();
      await f.app.reopenTicket(staff, f.command("reopen-for-new-proof"));
      await f.app.resolveTicket(staff, f.command("resolve-again"));
      const confirmation = await f.confirm();
      expect(confirmation.result.ticket.status).toBe("resolved");
      expect(confirmation.source).toMatchObject({
        state: "held",
        heldReason: "learning_capacity",
        resolutionCycle: 2,
        generationCount: 1,
      });
      expect(
        (await f.rows()).filter((row) => row.kind === "customer_success"),
      ).toHaveLength(2);
      expect(
        (await f.rows()).filter(
          (row) => row.kind === "resolution_learning_work",
        ),
      ).toHaveLength(1);
    });

    it.each([
      "evidence_revoked",
      "product_binding_revoked",
      "check_policy_revoked",
    ] as const)(
      "distinguishes explicit %s from privacy withdrawal",
      async (reason) => {
        const f = resolutionLearningFixture(createStore());
        await f.terminal();
        await f.confirm();
        const before = await f.source();
        const ticket = (await f.app.readStaffTicket(staff, "ticket")).ticket;
        const command = { ...f.command("explicit-invalidation"), reason };
        const invalidated = await f.app.invalidateResolutionEvidence(
          staff,
          command,
        );
        expect(invalidated).toMatchObject({
          state: "held",
          heldReason: reason,
          sourceGeneration: before.sourceGeneration + 1,
          resolutionCycle: before.resolutionCycle,
        });
        expect(await f.source()).toMatchObject({
          evidence: before.evidence,
          product: before.product,
          reconciliationPending: false,
        });
        expect((await f.app.readStaffTicket(staff, "ticket")).ticket).toEqual(
          ticket,
        );
        expect(
          await f.app.confirmResolutionLearningSource(
            service,
            sourceFence(before),
          ),
        ).toBe(false);
        const rows = await f.rows();
        expect(
          await f.app.invalidateResolutionEvidence(staff, command),
        ).toEqual(invalidated);
        expect(await f.rows()).toEqual(rows);
      },
    );

    it.each([
      "privacy_withdrawal",
      "source_access_revoked",
      "source_deleted",
    ] as const)(
      "retains minimal reconciliation identity while scrubbing private derived bodies on %s",
      async (reason) => {
        const f = resolutionLearningFixture(createStore());
        await f.terminal();
        await f.confirm();
        const prepared = await f.prepareCandidate();
        const before = await f.source();
        const ticket = (await f.app.readStaffTicket(staff, "ticket")).ticket;
        const command = { ...f.command("withdraw"), reason };
        const withdrawn = await f.app.withdrawResolutionLearningSource(
          staff,
          command,
        );
        const source = await f.source();
        const work = await f.work("ticket", before.sourceGeneration);
        expect(withdrawn).toMatchObject({
          state: "withdrawn",
          heldReason: reason,
          sourceGeneration: before.sourceGeneration + 1,
        });
        expect(source).toMatchObject({
          sourceId: before.sourceId,
          ticketId: "ticket",
          destinations: before.destinations,
          reconciliationPending: false,
        });
        expect(source.evidence).toBeUndefined();
        expect(source.product).toBeUndefined();
        expect(source.pendingProofReference).toBeUndefined();
        expect(work).toMatchObject({ status: "held", heldReason: reason });
        expect(work.candidate).toBeUndefined();
        expect(work.exactRequest).toBeUndefined();
        expect(work.evidence).toBeUndefined();
        expect(work.product).toBeUndefined();
        expect(JSON.stringify({ source, work })).not.toContain(
          prepared.candidate.problem,
        );
        expect(
          await f.app.confirmResolutionLearningSource(
            service,
            sourceFence(before),
          ),
        ).toBe(false);
        expect((await f.app.readStaffTicket(staff, "ticket")).ticket).toEqual(
          ticket,
        );
        const rows = await f.rows();
        expect(
          await f.app.withdrawResolutionLearningSource(staff, command),
        ).toEqual(withdrawn);
        expect(await f.rows()).toEqual(rows);
      },
    );

    it.each([
      "privacy_withdrawal",
      "source_access_revoked",
      "source_deleted",
    ] as const)(
      "preserves the permanent %s reason through reopening, customer reply, and fresh resolution",
      async (reason) => {
        const f = resolutionLearningFixture(createStore());
        await f.terminal();
        await f.confirm();
        const original = await f.source();
        await f.app.withdrawResolutionLearningSource(staff, {
          ...f.command("withdraw-before-later-human-work"),
          reason,
        });
        const withdrawn = await f.source();
        const remainsWithdrawn = async () => {
          const source = await f.source();
          expect(source).toMatchObject({
            state: "withdrawn",
            heldReason: reason,
          });
          expect(source.evidence).toBeUndefined();
          expect(source.product).toBeUndefined();
          expect(source.proofIdentity).toBeUndefined();
          expect(source.sourceBindingHash).toBeUndefined();
          expect(
            await f.app.confirmResolutionLearningSource(
              service,
              sourceFence(original),
            ),
          ).toBe(false);
        };
        await f.app.reopenTicket(staff, f.command("reopen-withdrawn-source"));
        await remainsWithdrawn();
        await f.app.resolveTicket(staff, f.command("resolve-withdrawn-source"));
        await remainsWithdrawn();
        await f.app.replyToCustomerTicket(customer, {
          ...f.command("reply-to-withdrawn-resolution"),
          messageId: "withdrawn-customer-reply",
          body: "A human still needs to help with the export.",
        });
        await remainsWithdrawn();
        await f.app.resolveTicket(
          staff,
          f.command("resolve-withdrawn-source-again"),
        );
        await remainsWithdrawn();
        await f.confirm();
        await remainsWithdrawn();
        expect(await f.source()).toMatchObject({
          resolutionCycle: withdrawn.resolutionCycle + 2,
          sourceGeneration: withdrawn.sourceGeneration + 2,
        });
        expect(
          (await f.rows()).filter(
            (row) => row.kind === "resolution_learning_work",
          ),
        ).toHaveLength(1);
        expect(
          (await f.app.readCustomerTicket(customer, "ticket")).ticket.status,
        ).toBe("resolved");
      },
    );
  });
}
