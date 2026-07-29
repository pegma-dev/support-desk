import { TableClient } from "@azure/data-tables";
import type { AccessContext } from "@pegma/authorization-core";
import { fixedClock } from "@pegma/spine";
import { createAzureTablesStore } from "@pegma/storage-azure-tables";
import {
  createMemoryStore,
  type CollectionDefinition,
  type Store,
} from "@pegma/storage-core";
import { describe, expect, it } from "vitest";

import {
  createSupportDeskApplication,
  projectTicketToQueue,
  queueIndex,
  repairQueueProjectionPage,
  SupportDeskAuthorizationError,
  SupportDeskQueueCapacityError,
  supportPermissions,
  supportRecords,
  sweepInactiveQueueProjections,
  type QueueIndexRecord,
} from "../packages/application/src/index.js";
import { TABLE_PORT } from "../test/azurite.js";

const ACCOUNT = "devstoreaccount1";
const KEY =
  "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==";
const CONNECTION_STRING = [
  "DefaultEndpointsProtocol=http",
  `AccountName=${ACCOUNT}`,
  `AccountKey=${KEY}`,
  `TableEndpoint=http://127.0.0.1:${TABLE_PORT}/${ACCOUNT};`,
].join(";");

const customer: AccessContext = {
  principalId: "customer-1",
  policyVersion: "test",
  roles: [],
  entitlements: [],
  permissions: [
    supportPermissions.create,
    supportPermissions.readOwn,
    supportPermissions.replyOwn,
  ],
};

const staff: AccessContext = {
  principalId: "staff-1",
  policyVersion: "test",
  roles: [],
  entitlements: [],
  permissions: [
    supportPermissions.queueRead,
    supportPermissions.replyAny,
    supportPermissions.note,
    supportPermissions.assign,
    supportPermissions.manage,
    supportPermissions.auditRead,
  ],
};

interface StoreFixture {
  readonly store: Store;
  freshStore(): Store;
}

let azureTableOrdinal = 0;

function memoryFixture(): StoreFixture {
  const store = createMemoryStore();
  return {
    store,
    freshStore() {
      return {
        collection<T>(definition: CollectionDefinition<T>) {
          return store.collection(definition);
        },
      };
    },
  };
}

function azureFixture(): StoreFixture {
  azureTableOrdinal += 1;
  const table = `pegmaqueue${process.pid}${azureTableOrdinal}`;
  const freshStore = () =>
    createAzureTablesStore({
      client: TableClient.fromConnectionString(CONNECTION_STRING, table, {
        allowInsecureConnection: true,
      }),
    });
  return { store: freshStore(), freshStore };
}

function mutableClock(start: string) {
  let current = start;
  return {
    now: () => current,
    set(next: string) {
      current = next;
    },
  };
}

async function createTicket(
  store: Store,
  ticketId: string,
  options: {
    readonly now?: string;
    readonly subject?: string;
    readonly body?: string;
  } = {},
) {
  const application = createSupportDeskApplication({
    store,
    clock: fixedClock(options.now ?? "2026-07-27T12:00:00.000Z"),
  });
  await application.createCustomerTicket(customer, {
    commandId: `create-${ticketId}`,
    correlationId: `correlation-${ticketId}`,
    ticketId,
    messageId: `message-${ticketId}`,
    subject: options.subject ?? `Subject ${ticketId}`,
    body: options.body ?? `Body ${ticketId}`,
  });
  return application;
}

function describeQueueProjection(label: string, fixture: () => StoreFixture) {
  describe(label, () => {
    it("projects after create and lists confirmed active tickets", async () => {
      const { store } = fixture();
      await createTicket(store, "ticket-a");
      const application = createSupportDeskApplication({
        store,
        clock: fixedClock("2026-07-27T12:00:00.000Z"),
      });
      const projection = await store.collection(queueIndex).get({
        partition: "ticket-a",
        id: "queue",
      });
      expect(projection).toMatchObject({
        ticketId: "ticket-a",
        id: "queue",
        state: "active",
        status: "open",
        projectedRevision: 1,
        requesterAssociation: "authenticated",
        channel: "web",
      });
      expect(projection).not.toHaveProperty("email");
      const queue = await application.listStaffQueue(staff);
      expect(queue.items.map((item) => item.ticketId)).toEqual(["ticket-a"]);
    });

    it("repairs a crash after ticket commit before projection", async () => {
      const { store } = fixture();
      await createTicket(store, "ticket-crash");
      await store.collection(queueIndex).delete({
        partition: "ticket-crash",
        id: "queue",
      });
      expect(
        await store.collection(queueIndex).get({
          partition: "ticket-crash",
          id: "queue",
        }),
      ).toBeNull();

      const repaired = await repairQueueProjectionPage({
        store,
        clock: fixedClock("2026-07-27T12:00:01.000Z"),
        limit: 100,
      });
      expect(repaired.projected).toBeGreaterThanOrEqual(1);
      expect(
        await store.collection(queueIndex).get({
          partition: "ticket-crash",
          id: "queue",
        }),
      ).toMatchObject({
        ticketId: "ticket-crash",
        state: "active",
        projectedRevision: 1,
      });
    });

    it("does not roll back a committed command when projection fails", async () => {
      const { store: inner } = fixture();
      const logs: Array<{ level: string; message: string }> = [];
      const store: Store = {
        collection(definition) {
          const collection = inner.collection(definition);
          if (definition.name !== "support-desk.queue-index.v1") {
            return collection;
          }
          return {
            get: collection.get.bind(collection),
            getVersioned: collection.getVersioned.bind(collection),
            insertIfAbsent: collection.insertIfAbsent.bind(collection),
            put: collection.put.bind(collection),
            putIfUnchanged: collection.putIfUnchanged.bind(collection),
            list: collection.list.bind(collection),
            listVersioned: collection.listVersioned.bind(collection),
            scan: collection.scan.bind(collection),
            delete: collection.delete.bind(collection),
            deleteIfUnchanged: collection.deleteIfUnchanged.bind(collection),
            transact: collection.transact.bind(collection),
            update: async () => {
              throw new Error("simulated projection storage failure");
            },
          };
        },
      };
      const application = createSupportDeskApplication({
        store,
        clock: fixedClock("2026-07-27T12:00:00.000Z"),
        logger: {
          log(level, message) {
            logs.push({ level, message });
          },
        },
      });

      const created = await application.createCustomerTicket(customer, {
        commandId: "create-fail-projection",
        correlationId: "c-fail",
        ticketId: "ticket-fail-projection",
        messageId: "message-fail-projection",
        subject: "Still commits",
        body: "Projection fails after.",
      });
      expect(created.ticket.id).toBe("ticket-fail-projection");
      expect(
        await inner.collection(supportRecords).get({
          partition: "ticket-fail-projection",
          id: "ticket",
        }),
      ).not.toBeNull();
      const health = application.queueProjectionHealth();
      expect(health.consecutiveFailures).toBeGreaterThanOrEqual(1);
      expect(logs.some((entry) => entry.message.includes("projection"))).toBe(
        true,
      );

      // Replay must not duplicate the command or re-create the ticket.
      const replay = await application.createCustomerTicket(customer, {
        commandId: "create-fail-projection",
        correlationId: "c-fail",
        ticketId: "ticket-fail-projection",
        messageId: "message-fail-projection",
        subject: "Still commits",
        body: "Projection fails after.",
      });
      expect(replay.ticket.number).toBe(created.ticket.number);
    });

    it("rejects stale projection writes that would overtake a newer revision", async () => {
      const { store } = fixture();
      await createTicket(store, "ticket-stale");
      const application = createSupportDeskApplication({
        store,
        clock: fixedClock("2026-07-27T12:05:00.000Z"),
      });
      await application.replyAsStaff(staff, {
        commandId: "staff-reply-stale",
        correlationId: "c-stale",
        ticketId: "ticket-stale",
        messageId: "reply-stale",
        body: "Newer revision",
      });
      expect(
        (
          await store.collection(queueIndex).get({
            partition: "ticket-stale",
            id: "queue",
          })
        )?.projectedRevision,
      ).toBe(2);

      // A row claiming a future revision must not be overwritten by the current
      // authoritative ticket's older projected revision.
      await store.collection(queueIndex).put({
        ticketId: "ticket-stale",
        id: "queue",
        projectedRevision: 5,
        state: "active",
        status: "waiting_on_customer",
        priority: "normal",
        requesterAssociation: "authenticated",
        channel: "web",
        updatedAt: "2026-07-27T12:10:00.000Z",
      });
      const fenced = await projectTicketToQueue("ticket-stale", {
        store,
        clock: fixedClock("2026-07-27T12:10:00.000Z"),
      });
      expect(fenced).toBe("kept");
      expect(
        (
          await store.collection(queueIndex).get({
            partition: "ticket-stale",
            id: "queue",
          })
        )?.projectedRevision,
      ).toBe(5);
    });

    it("delayed projector after reclamation cannot resurrect a terminal snapshot", async () => {
      const clock = mutableClock("2026-07-01T00:00:00.000Z");
      const { store } = fixture();
      const application = createSupportDeskApplication({
        store,
        clock,
        queueTerminalRetentionMilliseconds: 1_000,
      });
      await application.createCustomerTicket(customer, {
        commandId: "create-reclaim",
        correlationId: "c-reclaim",
        ticketId: "ticket-reclaim",
        messageId: "message-reclaim",
        subject: "Reclaim me",
        body: "Please",
      });
      await application.resolveTicket(staff, {
        commandId: "resolve-reclaim",
        correlationId: "c-resolve",
        ticketId: "ticket-reclaim",
      });
      expect(
        (
          await store.collection(queueIndex).get({
            partition: "ticket-reclaim",
            id: "queue",
          })
        )?.state,
      ).toBe("inactive");

      clock.set("2026-07-01T00:00:02.000Z");
      await sweepInactiveQueueProjections({
        store,
        clock,
        terminalRetentionMilliseconds: 1_000,
        limit: 100,
      });
      expect(
        await store.collection(queueIndex).get({
          partition: "ticket-reclaim",
          id: "queue",
        }),
      ).toBeNull();

      // Delayed projector reloads current terminal state beyond cutoff.
      const delayed = await projectTicketToQueue("ticket-reclaim", {
        store,
        clock,
        terminalRetentionMilliseconds: 1_000,
      });
      expect(["absent", "deleted", "kept"]).toContain(delayed);
      expect(
        await store.collection(queueIndex).get({
          partition: "ticket-reclaim",
          id: "queue",
        }),
      ).toBeNull();

      // Reopening recreates an active projection.
      clock.set("2026-07-01T00:00:03.000Z");
      await application.reopenTicket(staff, {
        commandId: "reopen-reclaim",
        correlationId: "c-reopen",
        ticketId: "ticket-reclaim",
      });
      expect(
        await store.collection(queueIndex).get({
          partition: "ticket-reclaim",
          id: "queue",
        }),
      ).toMatchObject({ state: "active", status: "waiting_on_support" });
    });

    it("repair does not recreate a reclaimed terminal projection", async () => {
      const clock = mutableClock("2026-07-01T00:00:00.000Z");
      const { store } = fixture();
      const application = createSupportDeskApplication({
        store,
        clock,
        queueTerminalRetentionMilliseconds: 1_000,
      });
      await application.createCustomerTicket(customer, {
        commandId: "create-repair-terminal",
        correlationId: "c",
        ticketId: "ticket-repair-terminal",
        messageId: "m",
        subject: "Terminal",
        body: "Body",
      });
      await application.resolveTicket(staff, {
        commandId: "resolve-repair-terminal",
        correlationId: "c2",
        ticketId: "ticket-repair-terminal",
      });
      clock.set("2026-07-01T00:00:05.000Z");
      await projectTicketToQueue("ticket-repair-terminal", {
        store,
        clock,
        terminalRetentionMilliseconds: 1_000,
      });
      expect(
        await store.collection(queueIndex).get({
          partition: "ticket-repair-terminal",
          id: "queue",
        }),
      ).toBeNull();

      await repairQueueProjectionPage({
        store,
        clock,
        terminalRetentionMilliseconds: 1_000,
        limit: 100,
      });
      expect(
        await store.collection(queueIndex).get({
          partition: "ticket-repair-terminal",
          id: "queue",
        }),
      ).toBeNull();
    });

    it("inactive and corrupted projection rows do not expose a ticket", async () => {
      const { store } = fixture();
      await createTicket(store, "ticket-active");
      await createTicket(store, "ticket-inactive");
      const application = createSupportDeskApplication({
        store,
        clock: fixedClock("2026-07-27T13:00:00.000Z"),
      });
      await application.resolveTicket(staff, {
        commandId: "resolve-inactive",
        correlationId: "c",
        ticketId: "ticket-inactive",
      });

      // Corrupted projection: points at a ticket with wrong revision.
      await store.collection(queueIndex).put({
        ticketId: "ticket-active",
        id: "queue",
        projectedRevision: 999,
        state: "active",
        status: "open",
        priority: "normal",
        requesterAssociation: "authenticated",
        channel: "web",
        updatedAt: "2026-07-27T12:00:00.000Z",
      });

      const queue = await application.listStaffQueue(staff);
      expect(queue.items.map((item) => item.ticketId)).toEqual([]);
    });

    it("applies every filter and both sort directions after confirmation", async () => {
      const clock = mutableClock("2026-07-27T12:00:00.000Z");
      const { store } = fixture();
      const application = createSupportDeskApplication({ store, clock });

      await application.createCustomerTicket(customer, {
        commandId: "create-1",
        correlationId: "c1",
        ticketId: "ticket-filter-1",
        messageId: "m1",
        subject: "One",
        body: "Body",
      });
      clock.set("2026-07-27T12:01:00.000Z");
      await application.createCustomerTicket(
        {
          ...customer,
          principalId: "customer-2",
        },
        {
          commandId: "create-2",
          correlationId: "c2",
          ticketId: "ticket-filter-2",
          messageId: "m2",
          subject: "Two",
          body: "Body",
        },
      );
      clock.set("2026-07-27T12:02:00.000Z");
      await application.assignTicket(staff, {
        commandId: "assign-1",
        correlationId: "ca",
        ticketId: "ticket-filter-1",
        assigneeId: "staff-1",
      });
      clock.set("2026-07-27T12:03:00.000Z");
      await application.changePriority(staff, {
        commandId: "priority-2",
        correlationId: "cp",
        ticketId: "ticket-filter-2",
        priority: "high",
      });
      clock.set("2026-07-27T12:04:00.000Z");
      await application.replyAsStaff(staff, {
        commandId: "reply-2",
        correlationId: "cr",
        ticketId: "ticket-filter-2",
        messageId: "reply-2",
        body: "Working",
      });

      const newest = await application.listStaffQueue(staff, {
        sort: "updated_newest",
      });
      expect(newest.items.map((item) => item.ticketId)).toEqual([
        "ticket-filter-2",
        "ticket-filter-1",
      ]);

      const oldest = await application.listStaffQueue(staff, {
        sort: "updated_oldest",
      });
      expect(oldest.items.map((item) => item.ticketId)).toEqual([
        "ticket-filter-1",
        "ticket-filter-2",
      ]);

      const byStatus = await application.listStaffQueue(staff, {
        status: "waiting_on_customer",
      });
      expect(byStatus.items.map((item) => item.ticketId)).toEqual([
        "ticket-filter-2",
      ]);

      const byPriority = await application.listStaffQueue(staff, {
        priority: "high",
      });
      expect(byPriority.items.map((item) => item.ticketId)).toEqual([
        "ticket-filter-2",
      ]);

      const byAssignee = await application.listStaffQueue(staff, {
        assignedTo: "staff-1",
      });
      expect(byAssignee.items.map((item) => item.ticketId)).toEqual([
        "ticket-filter-1",
      ]);

      const unassigned = await application.listStaffQueue(staff, {
        unassignedOnly: true,
      });
      expect(unassigned.items.map((item) => item.ticketId)).toEqual([
        "ticket-filter-2",
      ]);

      const byChannel = await application.listStaffQueue(staff, {
        channel: "web",
      });
      expect(byChannel.items).toHaveLength(2);

      const byAssociation = await application.listStaffQueue(staff, {
        association: "authenticated",
      });
      expect(byAssociation.items).toHaveLength(2);
    });

    it("scan pages may repeat and are not ordered or snapshots", async () => {
      const { store } = fixture();
      await createTicket(store, "ticket-scan-a");
      await createTicket(store, "ticket-scan-b");
      const first = await repairQueueProjectionPage({
        store,
        clock: fixedClock("2026-07-27T12:00:00.000Z"),
        limit: 1,
      });
      expect(first.nextCursor).not.toBeNull();
      // Starting again without a cursor begins a new cycle; pages may repeat.
      const again = await repairQueueProjectionPage({
        store,
        clock: fixedClock("2026-07-27T12:00:00.000Z"),
        limit: 1,
      });
      expect(again.physicalRows).toBe(1);

      // A complete repair cycle converges projections without promising order.
      let cursor: string | undefined;
      for (let guard = 0; guard < 100; guard += 1) {
        const page =
          cursor === undefined
            ? await repairQueueProjectionPage({
                store,
                clock: fixedClock("2026-07-27T12:00:00.000Z"),
                limit: 10,
              })
            : await repairQueueProjectionPage({
                store,
                clock: fixedClock("2026-07-27T12:00:00.000Z"),
                limit: 10,
                cursor,
              });
        if (page.nextCursor === null) {
          break;
        }
        cursor = page.nextCursor;
      }
      const projected = await store.collection(queueIndex).scan({ limit: 100 });
      const ids = new Set(
        projected.records.map((record) => record.value.ticketId),
      );
      expect(ids.has("ticket-scan-a")).toBe(true);
      expect(ids.has("ticket-scan-b")).toBe(true);
    });

    it("persists repair cursor only after a whole page and never reuses online cursors", async () => {
      const { store } = fixture();
      await createTicket(store, "ticket-cursor-1");
      await createTicket(store, "ticket-cursor-2");
      await createTicket(store, "ticket-cursor-3");

      const firstPage = await repairQueueProjectionPage({
        store,
        clock: fixedClock("2026-07-27T12:00:00.000Z"),
        limit: 1,
      });
      // Host would persist only after success:
      expect(firstPage.nextCursor).not.toBeNull();
      const hostCursor = firstPage.nextCursor as string;

      const secondPage = await repairQueueProjectionPage({
        store,
        clock: fixedClock("2026-07-27T12:00:00.000Z"),
        limit: 1,
        cursor: hostCursor,
      });
      expect(secondPage.physicalRows).toBe(1);

      const application = createSupportDeskApplication({
        store,
        clock: fixedClock("2026-07-27T12:00:00.000Z"),
      });
      // Online queue never accepts or reuses another request's cursor.
      const queueA = await application.listStaffQueue(staff);
      const queueB = await application.listStaffQueue(staff);
      expect(queueA.items.map((item) => item.ticketId).sort()).toEqual(
        queueB.items.map((item) => item.ticketId).sort(),
      );
    });

    it("fails physical-row, page, and active-result budgets without partial queues", async () => {
      const { store } = fixture();
      for (let index = 0; index < 3; index += 1) {
        await createTicket(store, `ticket-budget-${index}`);
      }

      const physical = createSupportDeskApplication({
        store,
        clock: fixedClock("2026-07-27T12:00:00.000Z"),
        queueScanBudgets: {
          maxPhysicalRows: 1,
          maxScanPages: 100,
          maxActiveResults: 100,
          scanPageSize: 1,
        },
      });
      await expect(physical.listStaffQueue(staff)).rejects.toEqual(
        new SupportDeskQueueCapacityError("physical_rows", 1),
      );

      const pages = createSupportDeskApplication({
        store,
        clock: fixedClock("2026-07-27T12:00:00.000Z"),
        queueScanBudgets: {
          maxPhysicalRows: 10_000,
          maxScanPages: 1,
          maxActiveResults: 100,
          scanPageSize: 1,
        },
      });
      await expect(pages.listStaffQueue(staff)).rejects.toEqual(
        new SupportDeskQueueCapacityError("scan_pages", 1),
      );

      const actives = createSupportDeskApplication({
        store,
        clock: fixedClock("2026-07-27T12:00:00.000Z"),
        queueScanBudgets: {
          maxPhysicalRows: 10_000,
          maxScanPages: 100,
          maxActiveResults: 1,
          scanPageSize: 100,
        },
      });
      await expect(actives.listStaffQueue(staff)).rejects.toEqual(
        new SupportDeskQueueCapacityError("active_results", 1),
      );
    });

    it("requires support.queue.read for the staff queue", async () => {
      const { store } = fixture();
      await createTicket(store, "ticket-authz");
      const application = createSupportDeskApplication({
        store,
        clock: fixedClock("2026-07-27T12:00:00.000Z"),
      });
      await expect(
        application.listStaffQueue({
          ...staff,
          permissions: [supportPermissions.manage],
        }),
      ).rejects.toEqual(
        new SupportDeskAuthorizationError(supportPermissions.queueRead),
      );
    });
  });
}

describeQueueProjection("staff queue projection (memory)", memoryFixture);
describeQueueProjection("staff queue projection (Azurite)", azureFixture);

describe("queue index codec", () => {
  it("round-trips projection rows without message or email fields", () => {
    const row: QueueIndexRecord = {
      ticketId: "ticket-codec",
      id: "queue",
      projectedRevision: 3,
      state: "active",
      status: "open",
      priority: "urgent",
      category: "bug",
      requesterAssociation: "unverified",
      channel: "email",
      assignedTo: "staff-9",
      updatedAt: "2026-07-27T12:00:00.000Z",
    };
    const encoded = queueIndex.codec.encode(row);
    expect(encoded.partition).toBe("ticket-codec");
    expect(encoded.id).toBe("queue");
    expect(String(encoded.payload)).not.toMatch(/@/);
    expect(queueIndex.codec.decode(encoded)).toEqual(row);
    expect(queueIndex.key(row)).toEqual({
      partition: "ticket-codec",
      id: "queue",
    });
  });
});
