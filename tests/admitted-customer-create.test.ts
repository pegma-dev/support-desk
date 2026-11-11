import {
  createSupportDeskApplication,
  customerTicketIndex,
  pruneCustomerTicketIndex,
  supportPermissions,
  ticketNumberPartition,
  ticketNumberRecordId,
  ticketNumbers,
  type CreateAdmittedCustomerTicketOptions,
  type SupportRecord,
} from "@pegma/support-desk-application";
import { describe, expect, it, vi } from "vitest";
import {
  handlingBarrier,
  handlingCustomer as customer,
  handlingFixture,
  handlingStores,
} from "../test/handling-fixtures.js";

const standard = {
  ...customer,
  permissions: customer.permissions.filter(
    (permission) => permission !== supportPermissions.assistantStart,
  ),
};
const createAuthorityAssertion = () => (): true => true;
type Fixture = ReturnType<typeof handlingFixture>;

function packet(f: Fixture, ticketId = "ticket") {
  return {
    ...f.createInput(false, ticketId),
    commandId: "Create-" + ticketId,
    messageId: "Initial-" + ticketId,
    preference: "assistant_if_available" as const,
    disclosureVersion: "approved-notice-v1",
  };
}

function number(f: Fixture) {
  return f.backing.collection(ticketNumbers).get({
    partition: ticketNumberPartition,
    id: ticketNumberRecordId,
  });
}

function reservation(f: Fixture) {
  return f.backing.collection(customerTicketIndex).get({
    partition: customer.principalId,
    id: "tickets",
  });
}

function containsFirstMessage(trace: { actions: readonly unknown[] }) {
  return trace.actions.some((action) => {
    const item = action as { action: string; value?: SupportRecord };
    return item.action === "insert" && item.value?.kind === "message";
  });
}

async function waitFor(
  gate: ReturnType<typeof handlingBarrier>,
  operation: Promise<unknown>,
) {
  await Promise.race([
    gate.reached,
    operation.then(() => {
      throw new Error("Admitted create never reached the barrier");
    }),
  ]);
}

for (const [backend, createStore] of handlingStores) {
  describe(`receipt-first admitted customer create (${backend})`, () => {
    it("recovers a committed managed receipt after ACK loss, handoff and qualification loss", async () => {
      const f = handlingFixture(createStore(), {
        assistantTurns: { maxAttempts: 2 },
        allowedCategories: ["product"],
      });
      const input = { ...packet(f), category: "product" };
      const resolveAssistantStart = vi.fn(() => customer);
      const verifyBeforeCommit = vi.fn(createAuthorityAssertion);
      f.observed.intercept(async (trace, commit) => {
        const result = await commit();
        if (result.committed && containsFirstMessage(trace))
          throw new Error("Synthetic lost create acknowledgement");
        return result;
      });
      await expect(
        f.app.createAdmittedCustomerTicket(standard, input, {
          resolveAssistantStart,
          verifyBeforeCommit,
        }),
      ).rejects.toThrow("lost create acknowledgement");
      f.observed.intercept(undefined);
      const committed = await f.rows();
      expect(committed.filter((row) => row.kind === "message")).toHaveLength(1);
      expect(
        committed.filter((row) => row.kind === "assistant_turn"),
      ).toHaveLength(1);
      expect(committed).toContainEqual(
        expect.objectContaining({
          kind: "command",
          commandType: "create_admitted_customer_ticket",
          commandId: input.commandId,
          messageId: input.messageId,
          initialMode: "assistant",
        }),
      );
      await f.app.requestPerson(standard, f.command("current-person"));
      const afterHandoff = await f.rows();
      const beforeNumber = await number(f);
      const off = createSupportDeskApplication({
        store: f.backing,
        clock: f.clock,
        limits: { maxMessageCharacters: 1 },
      });
      const noAdmission = vi.fn(() => {
        throw new Error("Exact replay must skip admission");
      });
      const recovered = await off.createAdmittedCustomerTicket(
        standard,
        {
          ...input,
          correlationId: "new-server-correlation",
        },
        {
          resolveAssistantStart: noAdmission,
          verifyBeforeCommit: noAdmission,
        },
      );
      expect(recovered.initialMode).toBe("assistant");
      expect(recovered.view.ticket.handling).toBe("human-pending");
      expect(recovered.view.messages).toHaveLength(1);
      expect(await off.createAdmittedCustomerTicket(standard, input)).toEqual(
        recovered,
      );
      expect(noAdmission).not.toHaveBeenCalled();
      expect(resolveAssistantStart).toHaveBeenCalledOnce();
      expect(verifyBeforeCommit).toHaveBeenCalledOnce();
      expect(await f.rows()).toEqual(afterHandoff);
      expect(await number(f)).toEqual(beforeNumber);
      await expect(
        off.createAdmittedCustomerTicket(
          { ...standard, permissions: [supportPermissions.readOwn] },
          input,
        ),
      ).rejects.toMatchObject({ permission: supportPermissions.create });
    });

    it("reads the original admission fields once before sharing the create path", async () => {
      const f = handlingFixture(createStore(), {
        assistantTurns: { maxAttempts: 2 },
      });
      const input = packet(f);
      const fields: PropertyKey[] = [];
      const inspected = new Proxy(input, {
        getOwnPropertyDescriptor(target, key) {
          fields.push(key);
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      });

      const accepted = await f.app.createAdmittedCustomerTicket(
        standard,
        inspected,
        { verifyBeforeCommit: createAuthorityAssertion },
      );

      expect(fields).toEqual(Reflect.ownKeys(input));
      expect(accepted.initialMode).toBe("human");
      expect(accepted.view.messages).toHaveLength(1);
      expect(await f.app.createAdmittedCustomerTicket(standard, input)).toEqual(
        accepted,
      );
    });

    it("requires new authority when the exact receipt is absent", async () => {
      const f = handlingFixture(createStore(), {
        assistantTurns: { maxAttempts: 2 },
      });
      const input = packet(f);
      await expect(
        f.app.createAdmittedCustomerTicket(standard, input),
      ).rejects.toThrow("Fresh create admission");
      const verifyBeforeCommit = vi.fn(createAuthorityAssertion);
      await expect(
        f.app.createAdmittedCustomerTicket(standard, input, {
          resolveAssistantStart: () => standard,
          verifyBeforeCommit,
        }),
      ).rejects.toMatchObject({
        permission: supportPermissions.assistantStart,
      });
      await expect(
        f.app.createAdmittedCustomerTicket(standard, input, {
          resolveAssistantStart: () => ({
            ...customer,
            principalId: "foreign",
          }),
          verifyBeforeCommit,
        }),
      ).rejects.toMatchObject({ permission: supportPermissions.create });
      expect(verifyBeforeCommit).not.toHaveBeenCalled();
      expect(await f.rows()).toEqual([]);
      expect(await number(f)).toBeNull();
      expect(await reservation(f)).toBeNull();
    });

    it.each([
      "human preference",
      "no disclosure",
      "disabled worker",
      "unqualified",
    ] as const)("creates one ordinary human ticket for %s", async (reason) => {
      const f = handlingFixture(createStore(), {
        assistantHandlingEnabled: reason !== "disabled worker",
        assistantTurns: { maxAttempts: 2 },
      });
      const { disclosureVersion, ...input } = packet(f);
      const command = {
        ...input,
        ...(reason === "human preference"
          ? { preference: "human" as const }
          : {}),
        ...(reason === "no disclosure" ? {} : { disclosureVersion }),
      };
      const resolveAssistantStart = vi.fn(() =>
        reason === "unqualified" ? null : customer,
      );
      const verifyBeforeCommit = vi.fn<
        CreateAdmittedCustomerTicketOptions["verifyBeforeCommit"]
      >(createAuthorityAssertion);
      const result = await f.app.createAdmittedCustomerTicket(
        standard,
        command,
        {
          resolveAssistantStart,
          verifyBeforeCommit,
        },
      );
      expect(result.initialMode).toBe("human");
      expect(verifyBeforeCommit).toHaveBeenCalledOnce();
      expect(verifyBeforeCommit).toHaveBeenCalledWith("human");
      expect(resolveAssistantStart).toHaveBeenCalledTimes(
        reason === "unqualified" ? 1 : 0,
      );
      expect(
        (await f.rows()).filter((row) => row.kind === "assistant_turn"),
      ).toEqual([]);
      const beforeNumber = await number(f);
      const restored = createSupportDeskApplication({
        store: f.backing,
        clock: f.clock,
        assistantHandlingEnabled: true,
        assistantTurns: { maxAttempts: 2 },
      });
      expect(
        await restored.createAdmittedCustomerTicket(standard, command),
      ).toEqual(result);
      expect(await number(f)).toEqual(beforeNumber);
    });

    it("refuses changed or cross-version command identity before another reservation", async () => {
      const f = handlingFixture(createStore(), {
        assistantTurns: { maxAttempts: 2 },
      });
      const input = packet(f);
      await f.app.createAdmittedCustomerTicket(standard, input, {
        verifyBeforeCommit: createAuthorityAssertion,
      });
      const priorNumber = await number(f);
      const rows = await f.rows();
      const verifyBeforeCommit = vi.fn(createAuthorityAssertion);
      for (const different of [
        { ...input, body: "different" },
        { ...input, messageId: "different" },
        { ...input, preference: "human" as const },
        { ...input, disclosureVersion: "different" },
      ]) {
        await expect(
          f.app.createAdmittedCustomerTicket(standard, different, {
            verifyBeforeCommit,
          }),
        ).rejects.toThrow("command changed");
      }
      await expect(
        f.app.createAdmittedCustomerTicket(
          { ...standard, principalId: "foreign" },
          input,
          { verifyBeforeCommit },
        ),
      ).rejects.toThrow("command changed");
      const oldInput = f.createInput(false, "legacy");
      await f.app.createCustomerTicket(standard, oldInput);
      const beforeLegacyCollision = await number(f);
      await expect(
        f.app.createAdmittedCustomerTicket(
          standard,
          { ...oldInput, preference: "human" },
          { verifyBeforeCommit },
        ),
      ).rejects.toThrow("command changed");
      expect(verifyBeforeCommit).not.toHaveBeenCalled();
      expect(await f.rows()).toEqual(rows);
      expect(beforeLegacyCollision?.lastIssued).toBe(
        (priorNumber?.lastIssued ?? 0) + 1,
      );
      expect(await number(f)).toEqual(beforeLegacyCollision);
    });

    it("withholds the write after original authority loss and reuses the same index reservation", async () => {
      const f = handlingFixture(createStore(), {
        assistantTurns: { maxAttempts: 2 },
      });
      const input = packet(f);
      const grant = { ...standard, permissions: [...standard.permissions] };
      const gate = handlingBarrier();
      const pending = f.app.createAdmittedCustomerTicket(grant, input, {
        resolveAssistantStart: () => customer,
        async verifyBeforeCommit() {
          await gate.wait();
          return (): true => true;
        },
      });
      try {
        await waitFor(gate, pending);
        grant.permissions = [supportPermissions.readOwn];
      } finally {
        gate.release();
      }
      await expect(pending).rejects.toMatchObject({
        permission: supportPermissions.create,
      });
      expect(await f.rows()).toEqual([]);
      expect(f.observed.transactions).toEqual([]);
      const prior = (await reservation(f))?.entries[0];
      expect(prior).toMatchObject({
        state: "reserved",
        ticketId: input.ticketId,
      });
      const result = await f.app.createAdmittedCustomerTicket(standard, input, {
        verifyBeforeCommit: createAuthorityAssertion,
      });
      expect(result.initialMode).toBe("human");
      expect(result.view.messages).toHaveLength(1);
      expect((await reservation(f))?.entries).toEqual([
        { ...prior, state: "confirmed" },
      ]);
    });

    it("reclaims a late-refused reservation through the existing fenced prune", async () => {
      const f = handlingFixture(createStore(), {
        assistantTurns: { maxAttempts: 2 },
        limits: { maxTicketsPerPrincipal: 1 },
      });
      const first = packet(f);
      await expect(
        f.app.createAdmittedCustomerTicket(standard, first, {
          verifyBeforeCommit() {
            throw new Error("Synthetic late denial");
          },
        }),
      ).rejects.toThrow("late denial");
      const next = packet(f, "next");
      await expect(
        f.app.createAdmittedCustomerTicket(standard, next, {
          verifyBeforeCommit: createAuthorityAssertion,
        }),
      ).rejects.toMatchObject({ field: "customer_tickets" });
      f.advance(60_000);
      expect(
        await pruneCustomerTicketIndex(f.backing, standard.principalId, {
          reservedBefore: f.clock.now(),
        }),
      ).toEqual([]);
      expect((await f.rows()).filter((row) => row.kind === "ticket")).toEqual(
        [],
      );
      const result = await f.app.createAdmittedCustomerTicket(standard, next, {
        verifyBeforeCommit: createAuthorityAssertion,
      });
      expect(result.view.ticket.id).toBe(next.ticketId);
      expect((await reservation(f))?.entries).toHaveLength(1);
    });

    it("rechecks a trusted deadline after the asynchronous guard handoff", async () => {
      const f = handlingFixture(createStore(), {
        assistantTurns: { maxAttempts: 2 },
      });
      const input = packet(f);
      const end = Date.parse(f.clock.now()) + 2_000;
      async function confirmCurrent() {
        return (): true => {
          if (Date.parse(f.clock.now()) >= end)
            throw new Error("Synthetic authority expired");
          return true;
        };
      }
      await expect(
        f.app.createAdmittedCustomerTicket(standard, input, {
          resolveAssistantStart: () => customer,
          async verifyBeforeCommit() {
            const current = await confirmCurrent();
            f.advance(2_001);
            return current;
          },
        }),
      ).rejects.toThrow("authority expired");
      expect(await f.rows()).toEqual([]);
      expect(f.observed.transactions).toEqual([]);
    });

    it.each([
      ["assistant resolver", "cancellation"],
      ["assistant resolver", "host deadline"],
      ["commit verifier", "cancellation"],
      ["commit verifier", "host deadline"],
    ] as const)(
      "settles a held %s on %s without a late create",
      async (boundary, stop) => {
        const f = handlingFixture(createStore(), {
          assistantTurns: { maxAttempts: 2 },
        });
        const input = packet(f);
        const gate = handlingBarrier();
        const controller = new AbortController();
        const resolveAssistantStart = vi.fn(async () => {
          if (boundary === "assistant resolver") await gate.wait();
          return customer;
        });
        const verifyBeforeCommit = vi.fn(async () => {
          if (boundary === "commit verifier") await gate.wait();
          return createAuthorityAssertion();
        });
        const pending = f.app.createAdmittedCustomerTicket(standard, input, {
          signal: controller.signal,
          resolveAssistantStart,
          verifyBeforeCommit,
        });
        const observed = pending.then(
          () => ({ accepted: true as const }),
          (error: unknown) => ({ error }),
        );
        let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
        let watchdog: ReturnType<typeof setTimeout> | undefined;
        let reserved: Awaited<ReturnType<typeof reservation>> = null;
        try {
          await waitFor(gate, pending);
          reserved = await reservation(f);
          if (stop === "host deadline")
            deadlineTimer = setTimeout(() => controller.abort(), 10);
          else controller.abort();
          const stopped = await Promise.race([
            observed,
            new Promise<{ stillWaiting: true }>((resolve) => {
              watchdog = setTimeout(
                () => resolve({ stillWaiting: true }),
                1_000,
              );
            }),
          ]);
          expect(stopped).toMatchObject({
            error: {
              name: "SupportDeskConflictError",
              message: "Admitted create was cancelled",
            },
          });
          // The callback is still held. Cancellation must settle before it can return.
          expect(await f.rows()).toEqual([]);
          expect(f.observed.transactions).toEqual([]);
        } finally {
          if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
          if (watchdog !== undefined) clearTimeout(watchdog);
          gate.release();
          await observed;
        }
        expect(await f.rows()).toEqual([]);
        expect(f.observed.transactions).toEqual([]);
        if (boundary === "assistant resolver") {
          expect(await number(f)).toBeNull();
          expect(await reservation(f)).toBeNull();
          expect(verifyBeforeCommit).not.toHaveBeenCalled();
        } else {
          expect(reserved).not.toBeNull();
          expect((await reservation(f))?.entries).toEqual(reserved?.entries);
          expect(verifyBeforeCommit).toHaveBeenCalledOnce();
        }
        const retried = await f.app.createAdmittedCustomerTicket(
          standard,
          input,
          {
            verifyBeforeCommit: createAuthorityAssertion,
          },
        );
        expect(retried.initialMode).toBe("human");
        expect(retried.view.messages).toHaveLength(1);
        if (reserved !== null)
          expect((await reservation(f))?.entries).toEqual(
            reserved.entries.map((entry) => ({ ...entry, state: "confirmed" })),
          );
      },
    );

    it("recovers an assistant winner from a human-only contender as a historical receipt", async () => {
      const f = handlingFixture(createStore(), {
        assistantTurns: { maxAttempts: 2 },
      });
      const input = packet(f);
      const gate = handlingBarrier();
      let paused = false;
      f.observed.intercept(async (trace, commit) => {
        if (!paused && containsFirstMessage(trace)) {
          paused = true;
          await gate.wait();
        }
        return commit();
      });
      const humanResolution = vi.fn(() => null);
      const humanVerification = vi.fn(createAuthorityAssertion);
      const losing = f.app.createAdmittedCustomerTicket(standard, input, {
        resolveAssistantStart: humanResolution,
        verifyBeforeCommit: humanVerification,
      });
      let winner:
        | Awaited<ReturnType<typeof f.app.createAdmittedCustomerTicket>>
        | undefined;
      let acceptedRows: Awaited<ReturnType<typeof f.rows>> | undefined;
      const assistantVerification = vi.fn(createAuthorityAssertion);
      try {
        await waitFor(gate, losing);
        winner = await f.app.createAdmittedCustomerTicket(standard, input, {
          resolveAssistantStart: () => customer,
          verifyBeforeCommit: assistantVerification,
        });
        acceptedRows = await f.rows();
      } finally {
        gate.release();
      }
      expect(await losing).toEqual(winner);
      expect(winner?.initialMode).toBe("assistant");
      expect(standard.permissions).not.toContain(
        supportPermissions.assistantStart,
      );
      expect(humanResolution).toHaveBeenCalledOnce();
      expect(humanVerification).toHaveBeenCalledOnce();
      expect(humanVerification).toHaveBeenCalledWith("human");
      expect(assistantVerification).toHaveBeenCalledOnce();
      expect(assistantVerification).toHaveBeenCalledWith("assistant");
      expect(await f.rows()).toEqual(acceptedRows);
      expect(
        acceptedRows?.filter((row) => row.kind === "message"),
      ).toHaveLength(1);
      expect(
        acceptedRows?.filter((row) => row.kind === "command"),
      ).toHaveLength(1);
      expect(
        acceptedRows?.filter((row) => row.kind === "assistant_turn"),
      ).toHaveLength(1);
      expect((await reservation(f))?.entries).toHaveLength(1);
    });

    it("replays the one atomic winner when exact contenders choose different modes", async () => {
      const f = handlingFixture(createStore(), {
        assistantTurns: { maxAttempts: 2 },
      });
      const input = packet(f);
      const gate = handlingBarrier();
      let paused = false;
      f.observed.intercept(async (trace, commit) => {
        if (!paused && containsFirstMessage(trace)) {
          paused = true;
          await gate.wait();
        }
        return commit();
      });
      const first = f.app.createAdmittedCustomerTicket(standard, input, {
        resolveAssistantStart: () => customer,
        verifyBeforeCommit: createAuthorityAssertion,
      });
      let second;
      try {
        await waitFor(gate, first);
        second = await f.app.createAdmittedCustomerTicket(standard, input, {
          verifyBeforeCommit: createAuthorityAssertion,
        });
      } finally {
        gate.release();
      }
      expect(await first).toEqual(second);
      expect(second?.initialMode).toBe("human");
      const rows = await f.rows();
      expect(rows.filter((row) => row.kind === "message")).toHaveLength(1);
      expect(rows.filter((row) => row.kind === "command")).toHaveLength(1);
      expect(rows.filter((row) => row.kind === "assistant_turn")).toEqual([]);
      expect((await reservation(f))?.entries).toHaveLength(1);
    });
  });
}
