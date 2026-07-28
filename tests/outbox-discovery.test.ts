import { TableClient } from "@azure/data-tables";
import type { AccessContext } from "@pegma/authorization-core";
import { fixedClock } from "@pegma/spine";
import { createAzureTablesStore } from "@pegma/storage-azure-tables";
import {
  createMemoryStore,
  type CollectionDefinition,
  type CollectionStore,
  type Store,
} from "@pegma/storage-core";
import {
  createSupportDeskApplication,
  type DeliveryJob,
  type SupportRecord,
  supportPermissions,
  supportRecords,
} from "@pegma/support-desk-application";
import {
  createDeliveryWorker,
  type DeliveryScanOutcome,
  type MailSendRequest,
  type MailSendResult,
  outboundMessageId,
  ticketSubject,
} from "@pegma/support-desk-mail";
import { defineTemplate } from "@pegma/support-desk-templates";
import { describe, expect, it, vi } from "vitest";

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

const caller: AccessContext = {
  principalId: "customer",
  policyVersion: "test",
  roles: [],
  entitlements: [],
  permissions: [
    supportPermissions.create,
    supportPermissions.readOwn,
    supportPermissions.replyOwn,
  ],
};
const template = defineTemplate({
  id: "staff.new-ticket",
  version: 1,
  variables: ["ticket_number"],
  plainText: "New ticket {{ticket_number}}",
  html: "<p>New ticket {{ticket_number}}</p>",
});

interface StoreFixture {
  readonly store: Store;
  /** A new adapter/facade instance over the same durable rows. */
  freshStore(): Store;
}

let azureTableOrdinal = 0;

function memoryFixture(): StoreFixture {
  const store = createMemoryStore();
  return {
    store,
    freshStore() {
      return {
        collection<T>(definition: CollectionDefinition<T>): CollectionStore<T> {
          return store.collection(definition);
        },
      };
    },
  };
}

function azureFixture(): StoreFixture {
  azureTableOrdinal += 1;
  const table = `pegmaoutbox${process.pid}${azureTableOrdinal}`;
  const freshStore = () =>
    createAzureTablesStore({
      client: TableClient.fromConnectionString(CONNECTION_STRING, table, {
        allowInsecureConnection: true,
      }),
    });
  return { store: freshStore(), freshStore };
}

async function createTicket(
  store: Store,
  ticketId: string,
  ticketNumber: number,
): Promise<void> {
  await createSupportDeskApplication({
    store,
    clock: fixedClock("2026-07-27T12:00:00.000Z"),
  }).createCustomerTicket(caller, {
    commandId: `create-${ticketId}`,
    correlationId: `correlation-${ticketId}`,
    ticketId,
    ticketNumber,
    messageId: `message-${ticketId}`,
    subject: "Question",
    body: "Help.",
    notification: {
      id: `notify-${ticketId}`,
      recipientRef: "support",
      templateId: template.id,
      templateVersion: template.version,
      variables: { ticket_number: String(ticketNumber) },
      subject: ticketSubject(ticketNumber, "Question"),
      outboundMessageId: outboundMessageId(
        `notify-${ticketNumber}`,
        "example.test",
      ),
    },
  });
}

function worker(
  store: Store,
  send: (request: MailSendRequest) => Promise<MailSendResult>,
) {
  return createDeliveryWorker({
    store,
    clock: fixedClock("2026-07-27T12:00:01.000Z"),
    workerId: "worker",
    reconciliation: {
      reconcile: async () => ({ status: "unknown" as const }),
    },
    delivery: { send },
    templates: { get: () => template },
  });
}

async function completeCycle(
  deliveryWorker: ReturnType<typeof createDeliveryWorker>,
  limit: number,
): Promise<DeliveryScanOutcome[]> {
  let cursor: string | undefined;
  const outcomes: DeliveryScanOutcome[] = [];
  do {
    const page = await deliveryWorker.runPage({
      now: "2026-07-27T12:00:01.000Z",
      limit,
      ...(cursor === undefined ? {} : { cursor }),
    });
    outcomes.push(...page.outcomes);
    cursor = page.nextCursor ?? undefined;
    if (page.nextCursor === null) {
      return outcomes;
    }
  } while (true);
}

async function exerciseCommitCrashBoundary(
  fixture: StoreFixture,
): Promise<void> {
  const send = vi.fn(async () => ({ providerMessageRef: "provider-ref" }));

  const beforeCommit = await worker(fixture.freshStore(), send).runPage({
    now: "2026-07-27T12:00:00.000Z",
    limit: 2,
  });
  expect(beforeCommit).toEqual({ outcomes: [], nextCursor: null });
  expect(send).not.toHaveBeenCalled();

  await createTicket(fixture.store, "ticket", 1);

  // This worker and Store instance carry no cursor or post-commit hint from
  // the process that committed the application state and delivery job.
  const outcomes = await completeCycle(worker(fixture.freshStore(), send), 2);
  expect(outcomes.map(({ result }) => result.status)).toEqual(["accepted"]);
  expect(send).toHaveBeenCalledTimes(1);
}

async function exerciseCrashBeforeCursorSave(
  fixture: StoreFixture,
): Promise<void> {
  await createTicket(fixture.store, "ticket", 1);
  const collection = fixture.store.collection(supportRecords);
  let cursor: string | undefined;
  let candidateCursor: string | undefined;
  do {
    const page = await collection.scan({
      limit: 1,
      ...(cursor === undefined ? {} : { cursor }),
    });
    if (page.records[0]?.value.kind === "delivery_job") {
      candidateCursor = cursor;
      expect(page.nextCursor).not.toBeNull();
      break;
    }
    cursor = page.nextCursor ?? undefined;
    if (page.nextCursor === null) {
      throw new Error("delivery job was not found in authoritative scan");
    }
  } while (true);

  const send = vi.fn(async () => ({ providerMessageRef: "provider-ref" }));
  const deliveryWorker = worker(fixture.freshStore(), send);
  const input = {
    now: "2026-07-27T12:00:01.000Z",
    limit: 1,
    ...(candidateCursor === undefined ? {} : { cursor: candidateCursor }),
  };
  const first = await deliveryWorker.runPage(input);
  expect(first.outcomes[0]?.result.status).toBe("accepted");

  // Simulate a crash before first.nextCursor is durably saved.
  const repeated = await worker(fixture.freshStore(), send).runPage(input);
  expect(repeated.nextCursor).toBe(first.nextCursor);
  expect(repeated.outcomes).toEqual([]);
  expect(send).toHaveBeenCalledTimes(1);
}

async function exerciseCompleteCycleFairness(
  fixture: StoreFixture,
): Promise<void> {
  await createTicket(fixture.store, "middle", 1);
  await createTicket(fixture.store, "zulu", 2);
  const send = vi.fn(async () => ({ providerMessageRef: "provider-ref" }));
  const deliveryWorker = worker(fixture.freshStore(), send);

  const firstPage = await deliveryWorker.runPage({
    now: "2026-07-27T12:00:01.000Z",
    limit: 1,
  });
  expect(firstPage.nextCursor).not.toBeNull();

  // This row may fall behind an adapter's live continuation. The contract
  // guarantees it through repeated complete cycles, not this in-flight one.
  await createTicket(fixture.store, "alpha", 3);

  let cursor = firstPage.nextCursor;
  while (cursor !== null) {
    const page = await deliveryWorker.runPage({
      now: "2026-07-27T12:00:01.000Z",
      limit: 1,
      cursor,
    });
    cursor = page.nextCursor;
  }
  await completeCycle(deliveryWorker, 1);

  expect(send).toHaveBeenCalledTimes(3);
}

async function duplicateDeliveryRecordStore(store: Store): Promise<Store> {
  const collection = store.collection(supportRecords);
  let cursor: string | undefined;
  let found:
    | {
        readonly key: { readonly partition: string; readonly id: string };
        readonly value: DeliveryJob;
        readonly version: string;
      }
    | undefined;
  do {
    const page = await collection.scan({
      limit: 10,
      ...(cursor === undefined ? {} : { cursor }),
    });
    const record = page.records.find(
      (
        value,
      ): value is {
        readonly key: { readonly partition: string; readonly id: string };
        readonly value: DeliveryJob;
        readonly version: string;
      } => value.value.kind === "delivery_job",
    );
    if (record !== undefined) {
      found = record;
      break;
    }
    cursor = page.nextCursor ?? undefined;
    if (page.nextCursor === null) {
      break;
    }
  } while (true);
  if (found === undefined) {
    throw new Error("delivery job was not found");
  }

  const mismatchedValue: DeliveryJob = {
    ...found.value,
    partition: "payload-ticket-is-not-authority",
    ticketId: "payload-ticket-is-not-authority",
    id: "delivery:payload-id-is-not-authority",
  };
  const duplicate = { ...found, value: mismatchedValue };
  return {
    collection<T>(definition: CollectionDefinition<T>): CollectionStore<T> {
      if (definition.name !== supportRecords.name) {
        return store.collection(definition);
      }
      const authoritative = store.collection(
        supportRecords,
      ) as CollectionStore<SupportRecord>;
      return {
        ...authoritative,
        async scan() {
          return {
            records: [duplicate, duplicate],
            nextCursor: null,
          };
        },
      } as unknown as CollectionStore<T>;
    },
  };
}

describe("atomic outbox discovery", () => {
  for (const [name, createFixture] of [
    ["memory", memoryFixture],
    ["Azurite", azureFixture],
  ] as const) {
    it(`${name}: a fresh worker/store discovers only post-commit durable work`, async () => {
      await exerciseCommitCrashBoundary(createFixture());
    });

    it(`${name}: a crash before cursor persistence repeats rather than loses work`, async () => {
      await exerciseCrashBeforeCursorSave(createFixture());
    });

    it(`${name}: repeated complete cycles cover live-prefix insertions`, async () => {
      await exerciseCompleteCycleFairness(createFixture());
    });
  }

  it("derives candidates from physical keys and tolerates duplicate scan rows", async () => {
    const store = createMemoryStore();
    await createTicket(store, "authoritative-ticket", 1);
    const send = vi.fn(async () => ({ providerMessageRef: "provider-ref" }));
    const page = await worker(
      await duplicateDeliveryRecordStore(store),
      send,
    ).runPage({
      now: "2026-07-27T12:00:01.000Z",
      limit: 2,
    });

    expect(
      page.outcomes.map(({ ticketId, deliveryJobId, result }) => ({
        ticketId,
        deliveryJobId,
        status: result.status,
      })),
    ).toEqual([
      {
        ticketId: "authoritative-ticket",
        deliveryJobId: "notify-authoritative-ticket",
        status: "accepted",
      },
      {
        ticketId: "authoritative-ticket",
        deliveryJobId: "notify-authoritative-ticket",
        status: "not_claimed",
      },
    ]);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
