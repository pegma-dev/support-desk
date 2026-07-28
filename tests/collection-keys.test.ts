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
  customerTicketIndex,
  deliveryCallbackBucket,
  deliveryCallbackReceipts,
  inboundReceiptLocation,
  inboundReceipts,
  pruneCustomerTicketIndex,
  recordDeliveryCallback,
  supportPermissions,
  supportRecords,
  sweepDeliveryCallbackReceipts,
  sweepInboundReceipts,
  sweepTerminalDeliveryJobs,
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

const caller: AccessContext = {
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

let tableCounter = 0;

function freshAzureStore(): Store {
  tableCounter += 1;
  const table = `pegmasupport${tableCounter}t${process.pid}`;
  const client = TableClient.fromConnectionString(CONNECTION_STRING, table, {
    allowInsecureConnection: true,
  });
  return createAzureTablesStore({ client });
}

function expectCodecKey<T>(
  collection: CollectionDefinition<T>,
  value: T,
): void {
  const encoded = collection.codec.encode(value);
  expect({
    partition: encoded.partition,
    id: encoded.id,
  }).toEqual(collection.key(value));
  expect(collection.codec.decode(encoded)).toEqual(value);
}

async function exerciseDeclaredCollections(store: Store): Promise<void> {
  const application = createSupportDeskApplication({
    store,
    clock: fixedClock("2025-01-01T12:00:00.000Z"),
  });
  await application.createCustomerTicket(caller, {
    commandId: "command-1",
    correlationId: "correlation-1",
    ticketId: "ticket-1",
    ticketNumber: 42,
    messageId: "message-1",
    subject: "Cannot open my plan",
    body: "The plan page stays blank.",
    notification: {
      id: "notification-1",
      recipientRef: "support-queue",
      templateId: "staff.new-ticket",
      templateVersion: 1,
      variables: { ticket_number: "42" },
      subject: "[Ticket #42] Cannot open my plan",
      outboundMessageId: "<support.notification-1@example.test>",
    },
  });

  const records = store.collection(supportRecords);
  const supportValues = await records.list("ticket-1");
  expect(supportValues.map((value) => value.kind).sort()).toEqual([
    "audit",
    "command",
    "delivery_job",
    "message",
    "ticket",
    "ticket_quota",
    "ticket_reservation",
  ]);
  for (const value of supportValues) {
    expectCodecKey(supportRecords, value);
    expect(await records.get(supportRecords.key(value))).toEqual(value);
  }

  await application.replyToCustomerTicket(caller, {
    commandId: "reply-z",
    correlationId: "correlation-z",
    ticketId: "ticket-1",
    messageId: "z",
    body: "Committed first.",
  });
  const ordered = await application.replyToCustomerTicket(caller, {
    commandId: "reply-a",
    correlationId: "correlation-a",
    ticketId: "ticket-1",
    messageId: "a",
    body: "Committed second.",
  });
  expect(ordered.messages.map((message) => message.id)).toEqual([
    "message-1",
    "z",
    "a",
  ]);
  expect(
    (await records.list("ticket-1"))
      .filter((record) => record.kind === "message")
      .sort((left, right) => left.ordinal! - right.ordinal!)
      .map((record) => [record.message.id, record.ordinal]),
  ).toEqual([
    ["message-1", 1],
    ["z", 2],
    ["a", 3],
  ]);

  const indexes = store.collection(customerTicketIndex);
  const index = await indexes.get({
    partition: caller.principalId,
    id: "tickets",
  });
  expect(index).not.toBeNull();
  expectCodecKey(customerTicketIndex, index!);
  expect(await indexes.list(caller.principalId)).toEqual([index]);

  await indexes.update(
    { partition: caller.principalId, id: "tickets" },
    (current) => ({
      action: "write",
      value: {
        principalId: caller.principalId,
        entries: [
          ...(current?.entries ?? []),
          {
            ticketId: "missing-ticket",
            reservationToken: "stale-token",
            reservationGeneration: 1,
            reservedAt: "2024-12-01T12:00:00.000Z",
            state: "reserved",
          },
        ],
      },
    }),
  );
  expect(
    await pruneCustomerTicketIndex(store, caller.principalId, {
      reservedBefore: "2025-01-01T00:00:00.000Z",
    }),
  ).toEqual(["ticket-1"]);

  const inboundLocation = await inboundReceiptLocation(
    "email",
    "inbound-event-1",
  );
  const inbound = {
    ...inboundLocation,
    channelId: "email",
    providerEventId: "inbound-event-1",
    payloadFingerprint: "fingerprint",
    status: "processed" as const,
    receivedAt: "2025-01-01T12:00:00.000Z",
    processedAt: "2025-01-01T12:00:01.000Z",
    ticketId: "ticket-1",
    messageId: "message-1",
  };
  const inboundCollection = store.collection(inboundReceipts);
  await inboundCollection.put(inbound);
  expectCodecKey(inboundReceipts, inbound);
  expect(await inboundCollection.get(inboundReceipts.key(inbound))).toEqual(
    inbound,
  );
  expect(await inboundCollection.list(inbound.bucket)).toEqual([inbound]);

  await recordDeliveryCallback(
    store,
    {
      provider: "mail",
      providerEventId: "callback-event-1",
      ticketId: "ticket-1",
      deliveryJobId: "notification-1",
      status: "delivered",
      occurredAt: "2025-01-01T12:00:02.000Z",
    },
    fixedClock("2025-01-01T12:00:03.000Z"),
  );
  const callbackBucket = await deliveryCallbackBucket(
    "mail",
    "callback-event-1",
  );
  const callbackCollection = store.collection(deliveryCallbackReceipts);
  const callbacks = await callbackCollection.list(callbackBucket);
  expect(callbacks).toHaveLength(1);
  expectCodecKey(deliveryCallbackReceipts, callbacks[0]!);
  expect(
    await callbackCollection.get(deliveryCallbackReceipts.key(callbacks[0]!)),
  ).toEqual(callbacks[0]);

  const sweepClock = fixedClock("2026-07-27T12:00:00.000Z");
  expect(
    await sweepInboundReceipts(store, sweepClock, {
      bucket: inbound.bucket,
      processedBefore: "2025-02-01T00:00:00.000Z",
    }),
  ).toBe(1);
  expect(await inboundCollection.list(inbound.bucket)).toEqual([]);

  expect(
    await sweepDeliveryCallbackReceipts(store, sweepClock, {
      bucket: callbackBucket,
      processedBefore: "2025-02-01T00:00:00.000Z",
    }),
  ).toBe(1);
  expect(await callbackCollection.list(callbackBucket)).toEqual([]);

  expect(
    await sweepTerminalDeliveryJobs(store, {
      ticketId: "ticket-1",
      terminalBefore: "2025-02-01T00:00:00.000Z",
    }),
  ).toBe(1);
  expect(
    await records.get({
      partition: "ticket-1",
      id: "delivery:notification-1",
    }),
  ).toBeNull();
}

describe("declared Support Desk collections", () => {
  it("round-trips, lists, and sweeps every collection in memory", async () => {
    await exerciseDeclaredCollections(createMemoryStore());
  });

  it("round-trips, lists, and sweeps every collection in Azurite", async () => {
    await exerciseDeclaredCollections(freshAzureStore());
  });
});
