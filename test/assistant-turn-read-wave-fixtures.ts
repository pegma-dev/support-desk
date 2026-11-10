import type {
  CollectionDefinition,
  CollectionStore,
  Store,
  TransactionOutcome,
} from "@pegma/storage-core";
import {
  supportRecords,
  type SupportRecord,
} from "@pegma/support-desk-application";
import { describe, expect, it } from "vitest";
import {
  assistantAnswer,
  assistantTurnFixture,
} from "./assistant-turn-fixtures.js";
import {
  handlingAgent as agent,
  handlingCustomer as customer,
  handlingStaff as staff,
} from "./handling-fixtures.js";

type Key = Parameters<CollectionStore<SupportRecord>["getVersioned"]>[0];
const phases = ["claim", "prepare"] as const;
type Phase = (typeof phases)[number];

function signal() {
  let release = () => {};
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { ready, release };
}

function sameKey(left: Key, right: Key) {
  return left.partition === right.partition && left.id === right.id;
}

/** Only observes/defer returns from the real Store; it owns no record state. */
function observeReads(backing: Store) {
  let pause:
    | {
        turn: Key;
        ticket: Key;
        held: boolean;
        turnRead: ReturnType<typeof signal>;
        ticketRead: ReturnType<typeof signal>;
        resume: ReturnType<typeof signal>;
      }
    | undefined;
  let failure: { key: Key; error: Error } | undefined;
  let reads = 0;
  const store: Store = {
    collection<T>(definition: CollectionDefinition<T>) {
      const target = backing.collection(definition);
      return new Proxy(target, {
        get(object, property) {
          if (
            definition.name === supportRecords.name &&
            property === "getVersioned"
          )
            return async (key: Key) => {
              reads += 1;
              const active = pause;
              const value = await object.getVersioned(key);
              if (active !== undefined) {
                if (sameKey(key, active.ticket)) active.ticketRead.release();
                if (sameKey(key, active.turn) && !active.held) {
                  active.held = true;
                  active.turnRead.release();
                  await active.resume.ready;
                }
              }
              // Deliberate operational fault after the actual keyed read.
              if (failure !== undefined && sameKey(key, failure.key))
                throw failure.error;
              return value;
            };
          const value: unknown = Reflect.get(object, property, object);
          return typeof value === "function" ? value.bind(object) : value;
        },
      });
    },
  };
  return {
    store,
    get reads() {
      return reads;
    },
    failRead(key: Key, error: Error) {
      failure = { key, error };
    },
    hold(turn: Key, ticket: Key) {
      if (pause !== undefined)
        throw new Error("A read barrier is already armed");
      const active = {
        turn,
        ticket,
        held: false,
        turnRead: signal(),
        ticketRead: signal(),
        resume: signal(),
      };
      pause = active;
      return {
        reached: Promise.all([active.turnRead.ready, active.ticketRead.ready]),
        release() {
          if (pause === active) pause = undefined;
          active.resume.release();
        },
      };
    },
  };
}

function settled<T>(operation: Promise<T>) {
  return operation.then(
    (value) => ({ outcome: "returned" as const, value }),
    (error: unknown) => ({ outcome: "threw" as const, error }),
  );
}

async function reached(ready: Promise<unknown>, operation: Promise<unknown>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      ready,
      operation.then(() => {
        throw new Error("Public operation missed its read barrier");
      }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(new Error("Independent keyed reads did not both complete")),
          2_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function world(factory: () => Store | Promise<Store>, phase: Phase) {
  const backing = await factory();
  const observer = observeReads(backing);
  const f = assistantTurnFixture(observer.store, { maxConflictAttempts: 1 });
  await f.create();
  const claim = phase === "prepare" ? await f.claim() : undefined;
  const key = claim === undefined ? await f.candidate() : claim.fence;
  const rows = await f.rows();
  const turn = rows.find(
    (row) => row.kind === "assistant_turn" && row.turnId === key.turnId,
  );
  const ticket = rows.find((row) => row.kind === "ticket");
  if (turn?.kind !== "assistant_turn" || ticket?.kind !== "ticket")
    throw new Error(
      "Actual public create did not produce the expected records",
    );
  const command = {
    ticketId: key.ticketId,
    turnId: key.turnId,
    workerId: "wave-worker",
    claimId: "wave-claim",
    leaseMilliseconds: 10_000,
  };
  const binding = claim === undefined ? undefined : f.binding(claim);
  async function run() {
    if (claim === undefined) return f.app.claimAssistantTurn(agent, command);
    return f.app.prepareAssistantTurnAttempt(agent, {
      ...claim.fence,
      binding: f.binding(claim),
    });
  }
  return { f, backing, observer, turn, ticket, claim, binding, command, run };
}

/** Public SDK scenarios reusable with a genuine native adapter supplied by Root.
 * These are read-scheduling/correctness cases, not physical query-count proof. */
export function registerAssistantTurnReadWaveCases(
  name: string,
  factory: () => Store | Promise<Store>,
) {
  describe(`S1 assistant keyed read waves (${name})`, () => {
    it.each(phases)(
      "completes independent reads before awaiting %s, preserving exact replay",
      async (phase) => {
        const w = await world(factory, phase);
        const before = (await w.f.app.readStaffTicket(staff, "ticket")).ticket;
        const pause = w.observer.hold(w.turn, w.ticket);
        const pending = settled(w.run());
        try {
          await reached(pause.reached, pending);
        } finally {
          pause.release();
          await pending;
        }
        const result = await pending;
        expect(result.outcome).toBe("returned");
        if (result.outcome !== "returned") throw result.error;
        if (phase === "claim") {
          expect(result.value).toMatchObject({
            fence: {
              ticketId: w.command.ticketId,
              turnId: w.command.turnId,
              workerId: w.command.workerId,
              claimId: w.command.claimId,
              attempt: 1,
              claimGeneration: 1,
            },
          });
        } else {
          expect(result.value).toEqual({
            attemptId: w.claim!.fence.attemptId,
            inputFingerprint: w.binding!.inputFingerprint,
            binding: w.binding,
          });
        }
        const committed = await w.f.rows();
        expect(await w.run()).toEqual(result.value);
        expect(await w.f.rows()).toEqual(committed);
        expect((await w.f.app.readStaffTicket(staff, "ticket")).ticket).toEqual(
          before,
        );
      },
    );

    it.each(phases)(
      "does not overwrite a real takeover during paired %s reads",
      async (phase) => {
        const w = await world(factory, phase);
        const pause = w.observer.hold(w.turn, w.ticket);
        const pending = settled(w.run());
        let afterTakeover: readonly SupportRecord[] = [];
        try {
          await reached(pause.reached, pending);
          await w.f.app.takeOverTicket(staff, {
            ...w.f.command("takeover"),
            expectedRevision: w.ticket.ticket.revision,
            expectedHandlingGeneration: w.ticket.ticket.handling!.generation,
          });
          afterTakeover = await w.f.rows();
        } finally {
          pause.release();
          await pending;
        }
        expect(await pending).toMatchObject({
          outcome: "threw",
          error: { name: "SupportDeskConflictError" },
        });
        expect(await w.f.rows()).toEqual(afterTakeover);
        expect(
          (await w.f.app.readStaffTicket(staff, "ticket")).ticket.handling
            ?.state,
        ).toBe("human-active");
        expect(
          (await w.f.app.readCustomerTicket(customer, "ticket")).messages,
        ).toHaveLength(1);
      },
    );

    it("rechecks an actual lease expiry after the paired preparation reads", async () => {
      const w = await world(factory, "prepare");
      const before = await w.f.rows();
      const pause = w.observer.hold(w.turn, w.ticket);
      const pending = settled(w.run());
      try {
        await reached(pause.reached, pending);
        w.f.advance(10_001);
      } finally {
        pause.release();
        await pending;
      }
      expect(await pending).toMatchObject({
        outcome: "threw",
        error: { name: "SupportDeskConflictError" },
      });
      expect(await w.f.rows()).toEqual(before);
      const replacement = await w.f.claim("replacement", "replacement-worker");
      expect(replacement.fence.claimGeneration).toBeGreaterThan(
        w.claim!.fence.claimGeneration,
      );
      await expect(w.f.prepare(w.claim!)).rejects.toMatchObject({
        name: "SupportDeskConflictError",
      });
    });

    for (const phase of phases) {
      it.each(["ticket", "turn"] as const)(
        `retains the observed %s version in the ${phase} transaction`,
        async (changed) => {
          const w = await world(factory, phase);
          let afterWriter: readonly SupportRecord[] = [];
          let outcome: TransactionOutcome | undefined;
          w.f.observed.intercept(async (trace, commit) => {
            if (trace.collection !== supportRecords.name) return commit();
            w.f.observed.intercept(undefined);
            if (changed === "ticket") {
              await w.f.app.addNote(staff, {
                ...w.f.command("racing-note"),
                messageId: "private-racing-note",
                body: "PRIVATE_SYNTHETIC_RACING_NOTE",
              });
            } else if (phase === "claim") {
              expect(
                await w.f.freshApplication().claimAssistantTurn(agent, {
                  ...w.command,
                  workerId: "winning-worker",
                  claimId: "winning-claim",
                }),
              ).not.toBeNull();
            } else {
              await w.f.freshApplication().prepareAssistantTurnAttempt(agent, {
                ...w.claim!.fence,
                binding: {
                  ...w.binding!,
                  contextBinding: "different-current-context",
                },
              });
            }
            afterWriter = await w.f.rows();
            outcome = await commit();
            return outcome;
          });
          await expect(w.run()).rejects.toMatchObject({
            name: "SupportDeskConflictError",
          });
          expect(outcome).toMatchObject({
            committed: false,
            reason: "changed",
          });
          expect(await w.f.rows()).toEqual(afterWriter);
          expect(
            (await w.f.app.readCustomerTicket(customer, "ticket")).messages,
          ).toHaveLength(1);
        },
      );
    }

    it.each(phases)(
      "does not replace a captured missing ticket with a later insertion during %s",
      async (phase) => {
        const w = await world(factory, phase);
        const records = w.backing.collection(supportRecords);
        const existing = await records.getVersioned(w.ticket);
        if (existing === null) throw new Error("Expected the actual ticket");
        expect(
          await records.deleteIfUnchanged(w.ticket, existing.version),
        ).toBe(true);
        const pause = w.observer.hold(w.turn, w.ticket);
        const pending = settled(w.run());
        let restored: readonly SupportRecord[] = [];
        try {
          await reached(pause.reached, pending);
          const inserted = await records.insertIfAbsent(existing.value);
          expect(inserted.inserted).toBe(true);
          expect(inserted.value).toEqual(existing.value);
          restored = await w.f.rows();
        } finally {
          pause.release();
          await pending;
        }
        if (phase === "claim")
          expect(await pending).toEqual({ outcome: "returned", value: null });
        else
          expect(await pending).toMatchObject({
            outcome: "threw",
            error: { name: "SupportDeskConflictError" },
          });
        expect(await w.f.rows()).toEqual(restored);
        expect((await settled(w.run())).outcome).toBe("returned");
      },
    );

    it("preserves a terminal claim result when an unused ticket read fails", async () => {
      const w = await world(factory, "prepare");
      const prepared = await w.f.prepare(w.claim!);
      await w.f.app.completeAssistantTurn(
        agent,
        assistantAnswer(w.claim!, prepared.inputFingerprint),
        () => {},
      );
      const before = await w.f.rows();
      w.observer.failRead(
        w.ticket,
        new Error("Unused synthetic ticket observation failed"),
      );
      expect(await w.f.app.claimAssistantTurn(agent, w.command)).toBeNull();
      expect(await w.f.rows()).toEqual(before);
    });

    it("preserves missing-turn error precedence over an unused ticket failure", async () => {
      const w = await world(factory, "claim");
      const before = await w.f.rows();
      w.observer.failRead(
        w.ticket,
        new Error("Unused synthetic ticket observation failed"),
      );
      await expect(
        w.f.app.claimAssistantTurn(agent, {
          ...w.command,
          turnId: "0".repeat(64),
        }),
      ).rejects.toThrow("Assistant turn is unavailable");
      expect(await w.f.rows()).toEqual(before);
    });

    it.each(phases)(
      "requires current dedicated service grants before any %s read",
      async (phase) => {
        const w = await world(factory, phase);
        const before = w.observer.reads;
        if (phase === "claim")
          await expect(
            w.f.app.claimAssistantTurn(customer, w.command),
          ).rejects.toMatchObject({ name: "SupportDeskAuthorizationError" });
        else
          await expect(
            w.f.app.prepareAssistantTurnAttempt(customer, {
              ...w.claim!.fence,
              binding: w.binding!,
            }),
          ).rejects.toMatchObject({ name: "SupportDeskAuthorizationError" });
        expect(w.observer.reads).toBe(before);
      },
    );
  });
}
