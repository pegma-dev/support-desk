import type {
  CollectionDefinition,
  CollectionStore,
  EntityKey,
  Store,
  TransactionOutcome,
} from "@pegma/storage-core";
import { ConcurrencyError } from "@pegma/storage-core";
import {
  createSupportDeskApplication,
  projectTicketToQueue,
  queueIndex,
  supportRecords,
  type AssistantTurnCommitGuard,
  type SupportRecord,
} from "@pegma/support-desk-application";
import { describe, expect, it } from "vitest";
import {
  assistantAnswer,
  assistantTurnFixture,
} from "./assistant-turn-fixtures.js";
import { engineeringFixture } from "./engineering-fixtures.js";
import { delegateCollection } from "./delegating-collection.js";
import { reached, settled, signal } from "./read-interleaving.js";
import {
  handlingAgent as agent,
  handlingCustomer as customer,
  handlingStaff as staff,
} from "./handling-fixtures.js";

interface Read {
  readonly collection: string;
  readonly method: "get" | "getVersioned" | "list";
  readonly key: EntityKey;
}
const queueKey = { partition: "ticket", id: "queue" };

/** Observe/defer actual public Store operations; no parallel persistence. */
function observe(backing: Store) {
  const reads: Read[] = [];
  let beforeRead: ((read: Read) => Promise<void>) | undefined;
  let sampled: ((read: Read, value: unknown) => Promise<void>) | undefined;
  let afterRead: ((read: Read) => Promise<void>) | undefined;
  let beforeProjectionWrite: (() => Promise<void>) | undefined;
  let projectionResult: ((written: boolean) => Promise<void>) | undefined;
  const store: Store = {
    collection<T>(definition: CollectionDefinition<T>): CollectionStore<T> {
      const target = backing.collection(definition);
      return delegateCollection(target, {
        async get(key) {
          const value = await target.get(key);
          const read: Read = {
            collection: definition.name,
            method: "get",
            key,
          };
          reads.push(read);
          await sampled?.(read, value);
          await afterRead?.(read);
          return value;
        },
        async getVersioned(key) {
          const read: Read = {
            collection: definition.name,
            method: "getVersioned",
            key,
          };
          await beforeRead?.(read);
          const value = await target.getVersioned(key);
          reads.push(read);
          await sampled?.(read, value);
          await afterRead?.(read);
          return value;
        },
        async list(partition) {
          const value = await target.list(partition);
          const read: Read = {
            collection: definition.name,
            method: "list",
            key: { partition, id: "" },
          };
          reads.push(read);
          await afterRead?.(read);
          return value;
        },
        async update(key, decide, options) {
          if (definition.name !== queueIndex.name)
            return target.update(key, decide, options);
          return target.update(
            key,
            async (current) => {
              await beforeProjectionWrite?.();
              return decide(current);
            },
            options,
          );
        },
        async putIfUnchanged(value, version) {
          if (definition.name === queueIndex.name)
            await beforeProjectionWrite?.();
          const written = await target.putIfUnchanged(value, version);
          if (definition.name === queueIndex.name)
            await projectionResult?.(written);
          return written;
        },
        async insertIfAbsent(value) {
          if (definition.name === queueIndex.name)
            await beforeProjectionWrite?.();
          return target.insertIfAbsent(value);
        },
        async deleteIfUnchanged(key, version) {
          if (definition.name === queueIndex.name)
            await beforeProjectionWrite?.();
          return target.deleteIfUnchanged(key, version);
        },
      });
    },
  };
  return {
    store,
    reads,
    beforeSample(value: typeof beforeRead) {
      beforeRead = value;
    },
    onSample(value: typeof sampled) {
      sampled = value;
    },
    onRead(value: typeof afterRead) {
      afterRead = value;
    },
    onProjectionWrite(value: typeof beforeProjectionWrite) {
      beforeProjectionWrite = value;
    },
    onProjectionResult(value: typeof projectionResult) {
      projectionResult = value;
    },
    hold(
      primary: (read: Read) => boolean,
      companions: readonly ((read: Read) => boolean)[] = [],
    ) {
      const entered = signal();
      const resume = signal();
      const completed = companions.map(() => signal());
      let held = false;
      afterRead = async (read) => {
        companions.forEach((match, index) => {
          if (match(read)) completed[index]!.release();
        });
        if (primary(read) && !held) {
          held = true;
          entered.release();
          await resume.ready;
        }
      };
      return {
        reached: Promise.all([
          entered.ready,
          ...completed.map((entry) => entry.ready),
        ]),
        release() {
          afterRead = undefined;
          resume.release();
        },
      };
    },
  };
}

type Factory = () => Store | Promise<Store>;
type Options = {
  readonly enrolled?: boolean;
  readonly descendants?: boolean;
  readonly constrained?: boolean;
  readonly maxConflictAttempts?: number;
  readonly logger?: Parameters<
    typeof createSupportDeskApplication
  >[0]["logger"];
};
async function world(factory: Factory, options: Options = {}) {
  const backing = await factory();
  const observed = observe(backing);
  const engineering = engineeringFixture(backing);
  const enrolled = options.enrolled !== false;
  const limits: NonNullable<
    Parameters<typeof createSupportDeskApplication>[0]["limits"]
  > = options.constrained
    ? { maxRecordsPerTicket: 22, maxMessagesPerTicket: 3 }
    : {};
  const f = assistantTurnFixture(observed.store, {
    maxConflictAttempts: options.maxConflictAttempts ?? 1,
    queueTerminalRetentionMilliseconds: 1_000,
    limits,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    ...(enrolled
      ? {
          resolutionLearning: { enabled: true },
          engineering: engineering.engineeringOptions,
        }
      : {}),
  });
  await f.create();
  if (options.descendants) await engineering.eligible();
  const claim = await f.claim();
  const prepared = await f.prepare(claim);
  const command = assistantAnswer(claim, prepared.inputFingerprint);
  const record = async (kind: SupportRecord["kind"]) => {
    const row = (await f.rows()).find((entry) => entry.kind === kind);
    if (row === undefined) throw new Error(`Missing actual ${kind} record`);
    return row;
  };
  const complete = (guard: AssistantTurnCommitGuard = () => {}) =>
    f.app.completeAssistantTurn(agent, command, guard);
  const project = () =>
    projectTicketToQueue("ticket", {
      store: observed.store,
      clock: f.clock,
      terminalRetentionMilliseconds: 1_000,
      maxConflictAttempts: 2,
    });
  return {
    backing,
    observed,
    f,
    engineering,
    claim,
    prepared,
    command,
    record,
    complete,
    project,
  };
}
const isTicket = (read: Read) =>
  read.collection === supportRecords.name && read.key.id === "ticket";
const matches = (row: EntityKey) => (read: Read) =>
  read.collection === supportRecords.name &&
  read.method === "getVersioned" &&
  read.key.partition === row.partition &&
  read.key.id === row.id;
const isProjection = (read: Read) =>
  read.collection === queueIndex.name && read.method === "getVersioned";

/** Public producer scenarios; a native fixture may inject a genuine async Store.
 * Scheduling observations do not establish physical D1 or host adoption gates. */
export function registerAssistantCompletionReadWaveCases(
  name: string,
  factory: Factory,
) {
  describe(`S2 closed completion read waves (${name})`, () => {
    it.each(["answer", "escalate"] as const)(
      "recovers a speculative absent receipt when the delayed ticket samples the exact winning %s completion",
      async (outcome) => {
        const w = await world(factory);
        const command =
          outcome === "answer"
            ? w.command
            : {
                ...w.command,
                outcome: {
                  kind: "escalate" as const,
                  reason: "other" as const,
                  summary: "Synthetic exact competing escalation.",
                },
              };
        const records = w.backing.collection(supportRecords);
        const ticketWaiting = signal();
        const receiptSampled = signal();
        const releaseTicket = signal();
        let held = false;
        let sampledAbsentReceipt = false;
        let released = false;
        let sampledWinningTicket = false;
        let originalGuards = 0;
        let winnerGuards = 0;
        w.observed.beforeSample(async (read) => {
          if (isTicket(read) && read.method === "getVersioned" && !held) {
            held = true;
            ticketWaiting.release();
            // Pause BEFORE the real adapter samples Ticket, not after it has
            // captured an older version. The receipt companion remains live.
            await releaseTicket.ready;
          }
        });
        w.observed.onSample(async (read, value) => {
          if (read.collection !== supportRecords.name) return;
          if (
            read.method === "get" &&
            read.key.id === `command:${command.commandId}` &&
            !sampledAbsentReceipt
          ) {
            expect(value).toBeNull();
            sampledAbsentReceipt = true;
            receiptSampled.release();
          }
          if (released && isTicket(read) && read.method === "getVersioned") {
            expect(value).toMatchObject({
              value: {
                kind: "ticket",
                ticket: {
                  revision: command.expectedRevision + 1,
                },
              },
            });
            sampledWinningTicket = true;
          }
        });
        const pending = settled(
          w.f.app.completeAssistantTurn(agent, command, () => {
            originalGuards += 1;
          }),
        );
        let winner: Awaited<ReturnType<typeof w.complete>> | undefined;
        let committed: readonly SupportRecord[] = [];
        try {
          await reached(
            Promise.all([ticketWaiting.ready, receiptSampled.ready]),
            pending,
            "Speculative receipt and ticket observations did not complete",
          );
          expect(sampledAbsentReceipt).toBe(true);
          expect(
            await records.get({
              partition: "ticket",
              id: `command:${command.commandId}`,
            }),
          ).toBeNull();
          // A separate real public application wins the exact command while
          // the original receipt observation is already irrevocably absent.
          w.observed.beforeSample(undefined);
          winner = await w.f
            .freshApplication()
            .completeAssistantTurn(agent, command, () => {
              winnerGuards += 1;
            });
          committed = await records.list("ticket");
          expect(winner).toMatchObject({
            ticketId: "ticket",
            revision: command.expectedRevision + 1,
          });
          expect(committed).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                kind: "command",
                commandId: command.commandId,
              }),
              expect.objectContaining({
                kind: "assistant_turn",
                status: outcome === "answer" ? "completed" : "escalated",
                terminalResult: winner,
              }),
            ]),
          );
          released = true;
          releaseTicket.release();
          expect(await pending).toEqual({ outcome: "returned", value: winner });
          expect(sampledWinningTicket).toBe(true);
          expect(originalGuards).toBe(0);
          expect(winnerGuards).toBe(1);
          expect(await records.list("ticket")).toEqual(committed);
          expect(
            committed.filter(
              (row) =>
                row.kind === "command" && row.commandId === command.commandId,
            ),
          ).toHaveLength(1);
          expect(
            committed.filter(
              (row) =>
                row.kind === "audit" && row.event.id === command.commandId,
            ),
          ).toHaveLength(1);
          expect(
            committed.filter((row) =>
              outcome === "answer"
                ? row.kind === "message" &&
                  row.message.authorKind === "assistant"
                : row.kind === "handoff_work",
            ),
          ).toHaveLength(1);
        } finally {
          w.observed.beforeSample(undefined);
          w.observed.onSample(undefined);
          releaseTicket.release();
          await pending;
        }
      },
    );

    it("completes independent S2 ticket and receipt reads before awaiting the ticket", async () => {
      const w = await world(factory);
      const pause = w.observed.hold(isTicket, [
        (read) =>
          read.collection === supportRecords.name &&
          read.method === "get" &&
          read.key.id === `command:${w.command.commandId}`,
      ]);
      const pending = settled(w.complete());
      try {
        await reached(
          pause.reached,
          pending,
          "Independent completion reads did not complete",
        );
      } finally {
        pause.release();
        await pending;
      }
      expect((await pending).outcome).toBe("returned");
      expect(
        (await w.f.app.readCustomerTicket(customer, "ticket")).messages.at(-1)
          ?.id,
      ).toBe(w.command.outcome.messageId);
    });

    it("completes independent S2 source quota and job observations before awaiting learning", async () => {
      const w = await world(factory);
      const source = await w.record("resolution_learning_source");
      const companions = await Promise.all([
        w.record("engineering_source"),
        w.record("ticket_quota"),
        w.record("assistant_turn"),
      ]);
      const pause = w.observed.hold(matches(source), companions.map(matches));
      const pending = settled(w.complete());
      try {
        await reached(
          pause.reached,
          pending,
          "Independent completion reads did not complete",
        );
      } finally {
        pause.release();
        await pending;
      }
      expect((await pending).outcome).toBe("returned");
      expect(await w.record("assistant_turn")).toMatchObject({
        status: "completed",
      });
      expect(
        w.observed.reads.some(
          (read) =>
            read.method === "list" && read.collection === supportRecords.name,
        ),
      ).toBe(true);
    });

    it("recovers a real committed lost ACK before unavailable or deleted fresh metadata", async () => {
      const w = await world(factory);
      let committed = false;
      w.f.observed.intercept(async (trace, commit) => {
        const outcome = await commit();
        if (trace.collection === supportRecords.name && outcome.committed) {
          committed = true;
          throw new Error("Synthetic lost actual completion ACK");
        }
        return outcome;
      });
      await expect(w.complete()).rejects.toThrow("lost actual completion ACK");
      expect(committed).toBe(true);
      w.f.observed.intercept(undefined);
      const records = w.backing.collection(supportRecords);
      const accepted = await w.record("assistant_turn");
      if (
        accepted.kind !== "assistant_turn" ||
        accepted.terminalResult === undefined
      )
        throw new Error("Expected the committed turn result");
      for (const kind of ["assistant_turn", "ticket_quota"] as const) {
        const row = await w.record(kind);
        const versioned = await records.getVersioned(row);
        if (versioned === null) throw new Error("Actual metadata vanished");
        expect(await records.deleteIfUnchanged(row, versioned.version)).toBe(
          true,
        );
      }
      const before = await records.list("ticket");
      let freshReads = 0;
      w.observed.onRead(async (read) => {
        if (
          read.collection === supportRecords.name &&
          !isTicket(read) &&
          read.key.id !== `command:${w.command.commandId}`
        ) {
          freshReads += 1;
          throw new Error("Unused fresh metadata is unavailable");
        }
      });
      const disabled = createSupportDeskApplication({
        store: w.observed.store,
        clock: w.f.clock,
        assistantHandlingEnabled: false,
        assistantTurns: {},
      });
      let guards = 0;
      expect(
        await disabled.completeAssistantTurn(agent, w.command, () => {
          guards += 1;
          throw new Error("Unused current guard");
        }),
      ).toEqual(accepted.terminalResult);
      expect(guards).toBe(0);
      expect(freshReads).toBe(0);
      await expect(
        disabled.completeAssistantTurn(
          agent,
          {
            ...w.command,
            outcome: { ...w.command.outcome, body: "Changed payload" },
          },
          () => {},
        ),
      ).rejects.toMatchObject({ name: "SupportDeskConflictError" });
      expect(freshReads).toBe(0);
      expect(await records.list("ticket")).toEqual(before);
      expect(
        before.filter(
          (row) =>
            row.kind === "message" && row.message.authorKind === "assistant",
        ),
      ).toHaveLength(1);
      expect(
        before.filter(
          (row) =>
            row.kind === "command" && row.commandId === w.command.commandId,
        ),
      ).toHaveLength(1);
    });

    it.each([
      "ticket",
      "ticket_quota",
      "assistant_turn",
      "engineering_source",
      "engineering_work",
    ] as const)(
      "retains the original opaque %s version through the completion transaction",
      async (kind) => {
        const w = await world(factory, { descendants: true });
        const records = w.backing.collection(supportRecords);
        const row = await w.record(kind);
        const original = await records.getVersioned(row);
        if (original === null) throw new Error("Actual observed row missing");
        let afterWriter: readonly SupportRecord[] = [];
        let outcome: TransactionOutcome | undefined;
        w.f.observed.intercept(async (trace, commit) => {
          if (trace.collection !== supportRecords.name) return commit();
          w.f.observed.intercept(undefined);
          expect(
            trace.actions.some(
              (action) =>
                action.action === "putIfUnchanged" &&
                (action.value as SupportRecord).kind === kind &&
                action.version === original.version,
            ),
          ).toBe(true);
          expect(
            await records.putIfUnchanged(original.value, original.version),
          ).toBe(true);
          expect((await records.getVersioned(row))?.version).not.toBe(
            original.version,
          );
          afterWriter = await records.list("ticket");
          outcome = await commit();
          return outcome;
        });
        await expect(w.complete()).rejects.toMatchObject({
          name: "SupportDeskConflictError",
        });
        expect(outcome).toMatchObject({ committed: false, reason: "changed" });
        expect(await records.list("ticket")).toEqual(afterWriter);
        expect(
          afterWriter.some(
            (entry) =>
              entry.kind === "command" &&
              entry.commandId === w.command.commandId,
          ),
        ).toBe(false);
      },
    );

    it.each(["learning", "engineering"] as const)(
      "keeps the whole-attempt Ticket fence after absent-to-present %s enrollment",
      async (kind) => {
        const w = await world(factory, { enrolled: false });
        const missingId =
          kind === "learning" ? "learning-source" : "engineering-source";
        const pause = w.observed.hold(
          (read) =>
            read.collection === supportRecords.name &&
            read.method === "getVersioned" &&
            read.key.id === missingId,
        );
        const pending = settled(w.complete());
        let afterEnrollment: readonly SupportRecord[] = [];
        try {
          await reached(
            pause.reached,
            pending,
            "Independent completion reads did not complete",
          );
          const app = createSupportDeskApplication({
            store: w.backing,
            clock: w.f.clock,
            assistantHandlingEnabled: true,
            assistantTurns: {},
            resolutionLearning: { enabled: true },
            engineering: { enabled: true },
          });
          const command = {
            ...w.f.command("concurrent-enrollment"),
            expectedRevision: w.claim.fence.expectedRevision,
          };
          if (kind === "learning")
            await app.enrollResolutionLearning(staff, command);
          else await app.enrollEngineeringSource(staff, command);
          afterEnrollment = await w.backing
            .collection(supportRecords)
            .list("ticket");
        } finally {
          pause.release();
          await pending;
        }
        expect(await pending).toMatchObject({
          outcome: "threw",
          error: { name: "SupportDeskConflictError" },
        });
        expect(await w.f.rows()).toEqual(afterEnrollment);
        // A new complete attempt observes enrollment and can safely finish.
        expect(await w.complete()).toMatchObject({
          messageId: w.command.outcome.messageId,
        });
      },
    );

    it.each(["lease", "takeover"] as const)(
      "retains final fresh %s checks after all completion planning awaits",
      async (race) => {
        const w = await world(factory);
        let afterGuard = await w.f.rows();
        let guards = 0;
        await expect(
          w.complete(async () => {
            guards += 1;
            await Promise.resolve();
            if (race === "lease") w.f.advance(10_001);
            else
              await w.f.app.takeOverTicket(staff, {
                ...w.f.command("last-guard-takeover"),
                expectedRevision: w.claim.fence.expectedRevision,
                expectedHandlingGeneration:
                  w.claim.fence.expectedHandlingGeneration,
              });
            afterGuard = await w.f.rows();
          }),
        ).rejects.toMatchObject({ name: "SupportDeskConflictError" });
        expect(guards).toBe(1);
        expect(await w.f.rows()).toEqual(afterGuard);
        expect(
          afterGuard.filter(
            (row) =>
              row.kind === "message" && row.message.authorKind === "assistant",
          ),
        ).toHaveLength(0);
      },
    );

    it("keeps the complete atomic assistant audit receipt quota source and job action set", async () => {
      const w = await world(factory, { descendants: true });
      w.f.observed.transactions.length = 0;
      const result = await w.complete();
      const transactions = w.f.observed.transactions.filter(
        (trace) => trace.collection === supportRecords.name,
      );
      expect(transactions).toHaveLength(1);
      expect(transactions[0]?.partition).toBe("ticket");
      expect(
        transactions[0]?.actions
          .filter((action) => action.action !== "delete")
          .map((action) => (action.value as SupportRecord).kind),
      ).toEqual(
        expect.arrayContaining([
          "ticket",
          "ticket_quota",
          "assistant_turn",
          "engineering_source",
          "engineering_work",
          "message",
          "audit",
          "command",
        ]),
      );
      const rows = await w.f.rows();
      expect(
        await w.complete(() => {
          throw new Error("Replay has no fresh guard");
        }),
      ).toEqual(result);
      expect(await w.f.rows()).toEqual(rows);
      expect(
        JSON.stringify(await w.f.app.readCustomerTicket(customer, "ticket")),
      ).not.toContain("PRIVATE_ENGINEERING");
    });

    it("preserves the prepaid human tail after an admitted completion at the ordinary boundary", async () => {
      const w = await world(factory, { enrolled: false, constrained: true });
      await w.complete();
      const before = await w.f.rows();
      expect(22 - before.length).toBe(12);
      await expect(
        w.f.app.replyToCustomerTicket(customer, {
          ...w.f.command("ordinary-over-tail"),
          messageId: "ordinary-over-tail",
          body: "Additional synthetic detail",
        }),
      ).rejects.toMatchObject({ name: "SupportDeskLimitError" });
      expect(await w.f.rows()).toEqual(before);
      expect(
        (
          await w.f.app.requestPerson(
            customer,
            w.f.command("funded-human-request"),
          )
        ).ticket.handling,
      ).toBe("human-pending");
    });

    it("completes independent S2 authoritative and projection reads before awaiting Ticket", async () => {
      const w = await world(factory);
      const pause = w.observed.hold(isTicket, [isProjection]);
      const pending = settled(w.project());
      try {
        await reached(
          pause.reached,
          pending,
          "Independent completion reads did not complete",
        );
      } finally {
        pause.release();
        await pending;
      }
      expect(await pending).toEqual({ outcome: "returned", value: "kept" });
    });

    it.each(["present", "absent"] as const)(
      "rereads both observations after a real %s projection CAS race",
      async (initial) => {
        const w = await world(factory);
        const projections = w.backing.collection(queueIndex);
        const existing = await projections.getVersioned(queueKey);
        if (existing === null)
          throw new Error("Expected the created projection");
        if (initial === "absent")
          expect(
            await projections.deleteIfUnchanged(queueKey, existing.version),
          ).toBe(true);
        else {
          let projectionFailed = false;
          w.observed.onRead(async (read) => {
            if (read.collection === queueIndex.name) {
              projectionFailed = true;
              throw new Error("Synthetic postcommit projection-read outage");
            }
          });
          try {
            await w.f.app.changePriority(staff, {
              ...w.f.command("committed-before-projection-repair"),
              priority: "low",
            });
          } finally {
            w.observed.onRead(undefined);
          }
          expect(projectionFailed).toBe(true);
          const current = (await w.f.app.readStaffTicket(staff, "ticket"))
            .ticket;
          expect(current.priority).toBe("low");
          expect(current.revision).toBeGreaterThan(
            existing.value.projectedRevision,
          );
          // A genuine committed change left the original actual row untouched.
          expect(await projections.getVersioned(queueKey)).toEqual(existing);
        }
        let afterWriter = 0;
        let writes = 0;
        w.observed.onProjectionWrite(async () => {
          writes += 1;
          w.observed.onProjectionWrite(undefined);
          await w.f.app.changePriority(staff, {
            ...w.f.command("newer-projection"),
            priority: "high",
          });
          afterWriter = w.observed.reads.length;
        });
        await w.project();
        expect(writes).toBe(1);
        const retried = w.observed.reads.slice(afterWriter);
        expect(retried.some(isTicket)).toBe(true);
        expect(retried.some(isProjection)).toBe(true);
        const ticket = (await w.f.app.readStaffTicket(staff, "ticket")).ticket;
        expect(await projections.get(queueKey)).toMatchObject({
          projectedRevision: ticket.revision,
          priority: "high",
        });
      },
    );

    it("rereads both observations after a failed terminal delete and keeps a real reopened row", async () => {
      const w = await world(factory);
      await w.f.app.resolveTicket(staff, w.f.command("terminal-before-prune"));
      w.f.advance(2_000);
      let afterWriter = 0;
      w.observed.onProjectionWrite(async () => {
        w.observed.onProjectionWrite(undefined);
        await w.f.app.reopenTicket(staff, w.f.command("reopen-during-prune"));
        afterWriter = w.observed.reads.length;
      });
      expect(await w.project()).toBe("kept");
      const retried = w.observed.reads.slice(afterWriter);
      expect(retried.some(isTicket)).toBe(true);
      expect(retried.some(isProjection)).toBe(true);
      const ticket = (await w.f.app.readStaffTicket(staff, "ticket")).ticket;
      expect(
        await w.backing.collection(queueIndex).get(queueKey),
      ).toMatchObject({ projectedRevision: ticket.revision, state: "active" });
    });

    it("enriches the exact legacy projection but refuses divergent equal-revision data", async () => {
      const w = await world(factory);
      const projections = w.backing.collection(queueIndex);
      const original = await projections.get(queueKey);
      if (original === null) throw new Error("Expected actual projection");
      const { handling: _handling, ...legacy } = original;
      await projections.put(legacy);
      expect(await w.project()).toBe("written");
      expect(await projections.get(queueKey)).toEqual(original);
      await projections.put({ ...original, priority: "high" });
      const divergent = await projections.getVersioned(queueKey);
      await expect(w.project()).rejects.toMatchObject({
        name: "SupportDeskConflictError",
      });
      expect(await projections.getVersioned(queueKey)).toEqual(divergent);
    });

    it("conditionally removes an orphaned queue row without recreating Ticket", async () => {
      const w = await world(factory);
      const records = w.backing.collection(supportRecords);
      const row = await w.record("ticket");
      const ticket = await records.getVersioned(row);
      if (ticket === null) throw new Error("Expected actual Ticket");
      expect(await records.deleteIfUnchanged(row, ticket.version)).toBe(true);
      expect(await w.project()).toBe("deleted");
      expect(await records.get(row)).toBeNull();
      expect(await w.backing.collection(queueIndex).get(queueKey)).toBeNull();
    });

    it("preserves real Core projection exhaustion, a committed ACK and repair convergence", async () => {
      const events: {
        level: string;
        event: string;
        fields?: Readonly<Record<string, unknown>> | undefined;
      }[] = [];
      const w = await world(factory, {
        maxConflictAttempts: 2,
        logger: {
          log(level, event, fields) {
            events.push({ level, event, fields });
          },
        },
      });
      const projections = w.backing.collection(queueIndex);
      const records = w.backing.collection(supportRecords);
      const initial = await projections.getVersioned(queueKey);
      if (initial === null)
        throw new Error("Expected a genuine initial projection");
      expect(w.f.app.queueProjectionHealth().consecutiveFailures).toBe(0);
      const versionWrites: { before: string; after: string }[] = [];
      const lostWrites: boolean[] = [];
      async function competingRewrite() {
        const current = await projections.getVersioned(queueKey);
        if (current === null) throw new Error("Competing row disappeared");
        // Preserve the actual SDK-created payload. Only its adapter-issued
        // opaque version changes before the original real CAS is delegated.
        expect(
          await projections.putIfUnchanged(current.value, current.version),
        ).toBe(true);
        const rewritten = await projections.getVersioned(queueKey);
        if (rewritten === null)
          throw new Error("Competing rewrite disappeared");
        expect(rewritten.value).toEqual(current.value);
        expect(rewritten.version).not.toBe(current.version);
        versionWrites.push({
          before: current.version,
          after: rewritten.version,
        });
      }
      w.observed.onProjectionWrite(competingRewrite);
      w.observed.onProjectionResult(async (written) => {
        lostWrites.push(written);
      });
      let authoritative: readonly SupportRecord[] = [];
      const expected = new ConcurrencyError(queueIndex.name, queueKey, 2);
      try {
        const accepted = await w.complete();
        expect(versionWrites).toHaveLength(2);
        expect(lostWrites).toEqual([false, false]);
        expect(accepted).toMatchObject({
          ticketId: "ticket",
          messageId: w.command.outcome.messageId,
        });
        authoritative = await records.list("ticket");
        expect(authoritative).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              kind: "assistant_turn",
              status: "completed",
              terminalResult: accepted,
            }),
            expect.objectContaining({ kind: "ticket_quota", messageCount: 2 }),
          ]),
        );
        expect(
          authoritative.filter(
            (row) =>
              row.kind === "command" && row.commandId === w.command.commandId,
          ),
        ).toHaveLength(1);
        expect(
          authoritative.filter(
            (row) =>
              row.kind === "audit" && row.event.id === w.command.commandId,
          ),
        ).toHaveLength(1);
        expect(
          authoritative.filter(
            (row) =>
              row.kind === "message" && row.message.authorKind === "assistant",
          ),
        ).toHaveLength(1);
        const currentTicket = (await w.f.app.readStaffTicket(staff, "ticket"))
          .ticket;
        expect(currentTicket.revision).toBeGreaterThan(
          initial.value.projectedRevision,
        );
        expect((await projections.get(queueKey))?.projectedRevision).toBe(
          initial.value.projectedRevision,
        );
        expect(w.f.app.queueProjectionHealth()).toMatchObject({
          consecutiveFailures: 1,
          lastFailureTicketId: "ticket",
          lastFailureMessage: expected.message,
        });
        expect(
          events.filter(
            (entry) => entry.event === "support-desk.queue.projection_failed",
          ),
        ).toEqual([
          {
            level: "error",
            event: "support-desk.queue.projection_failed",
            fields: { ticketId: "ticket", message: expected.message },
          },
        ]);
        // Exact receipt recovery does not repeat the already accepted effect
        // or convert its best-effort projection failure into command failure.
        expect(await w.complete()).toEqual(accepted);
        expect(await records.list("ticket")).toEqual(authoritative);
        expect(versionWrites).toHaveLength(2);
        const direct = await settled(w.project());
        expect(direct.outcome).toBe("threw");
        if (
          direct.outcome !== "threw" ||
          !(direct.error instanceof ConcurrencyError)
        )
          throw new Error(
            "Direct repair did not expose the genuine Core ConcurrencyError",
          );
        expect(direct.error).toMatchObject({
          collection: queueIndex.name,
          key: queueKey,
          attempts: 2,
          message: expected.message,
        });
        expect(versionWrites).toHaveLength(4);
        expect(lostWrites).toEqual([false, false, false, false]);
        expect(await records.list("ticket")).toEqual(authoritative);
        w.observed.onProjectionWrite(undefined);
        w.observed.onProjectionResult(undefined);
        // This is the old public update contract itself, with two genuine
        // competing version changes inside its async decider, not a fake false.
        const core = await settled(
          projections.update(
            queueKey,
            async (current) => {
              if (current === null)
                throw new Error("Core oracle needs the existing real row");
              await competingRewrite();
              return { action: "write", value: current };
            },
            { maxAttempts: 2 },
          ),
        );
        expect(core.outcome).toBe("threw");
        if (
          core.outcome !== "threw" ||
          !(core.error instanceof ConcurrencyError)
        )
          throw new Error(
            "Actual public Core update did not exhaust by throwing",
          );
        expect(core.error).toMatchObject({
          collection: queueIndex.name,
          key: queueKey,
          attempts: 2,
        });
        expect(versionWrites).toHaveLength(6);
        const failedHealth = w.f.app.queueProjectionHealth();
        expect(await w.project()).toBe("written");
        expect(await projections.get(queueKey)).toMatchObject({
          projectedRevision: currentTicket.revision,
          status: currentTicket.status,
          priority: currentTicket.priority,
          handling: currentTicket.handling,
        });
        expect(await records.list("ticket")).toEqual(authoritative);
        // Direct repair does not mutate this application's health observation.
        expect(w.f.app.queueProjectionHealth()).toEqual(failedHealth);
      } finally {
        w.observed.onProjectionWrite(undefined);
        w.observed.onProjectionResult(undefined);
      }
    });

    it("keeps the durable ACK when a real postcommit projection read fails", async () => {
      const w = await world(factory);
      let failed = false;
      w.observed.onRead(async (read) => {
        if (read.collection === queueIndex.name) {
          failed = true;
          throw new Error("Synthetic projection read outage");
        }
      });
      const result = await w.complete();
      expect(failed).toBe(true);
      w.observed.onRead(undefined);
      expect(await w.record("assistant_turn")).toMatchObject({
        status: "completed",
        terminalResult: result,
      });
      expect(
        await w.complete(() => {
          throw new Error("Committed replay has no new guard");
        }),
      ).toEqual(result);
      expect(
        (await w.f.app.readCustomerTicket(customer, "ticket")).messages.filter(
          (message) => message.authorKind === "assistant",
        ),
      ).toHaveLength(1);
    });

    it("recovers the exact competing receipt after a genuine failed transaction without fresh metadata", async () => {
      const w = await world(factory);
      const records = w.backing.collection(supportRecords);
      let accepted: Awaited<ReturnType<typeof w.complete>> | undefined;
      let refused: TransactionOutcome | undefined;
      let freshReads = 0;
      let afterWinner: readonly SupportRecord[] = [];
      w.f.observed.intercept(async (trace, commit) => {
        if (trace.collection !== supportRecords.name) return commit();
        w.f.observed.intercept(undefined);
        accepted = await w.f
          .freshApplication()
          .completeAssistantTurn(agent, w.command, () => {});
        for (const kind of ["assistant_turn", "ticket_quota"] as const) {
          const row = (await records.list("ticket")).find(
            (entry) => entry.kind === kind,
          );
          if (row === undefined)
            throw new Error("Winner did not persist its metadata");
          const current = await records.getVersioned(row);
          if (current === null) throw new Error("Winner metadata disappeared");
          expect(await records.deleteIfUnchanged(row, current.version)).toBe(
            true,
          );
        }
        afterWinner = await records.list("ticket");
        w.observed.onRead(async (read) => {
          if (
            read.collection === supportRecords.name &&
            !isTicket(read) &&
            read.key.id !== `command:${w.command.commandId}`
          ) {
            freshReads += 1;
            throw new Error("Post-loop metadata is unavailable");
          }
        });
        // This is the original Store transaction, now losing to real writes.
        refused = await commit();
        return refused;
      });
      expect(await w.complete()).toEqual(accepted);
      expect(accepted).toMatchObject({
        messageId: w.command.outcome.messageId,
      });
      expect(refused).toMatchObject({ committed: false });
      expect(freshReads).toBe(0);
      expect(await records.list("ticket")).toEqual(afterWinner);
      expect(
        afterWinner.filter(
          (row) =>
            row.kind === "command" && row.commandId === w.command.commandId,
        ),
      ).toHaveLength(1);
      expect(
        afterWinner.filter(
          (row) =>
            row.kind === "message" && row.message.authorKind === "assistant",
        ),
      ).toHaveLength(1);
    });
  });
}
