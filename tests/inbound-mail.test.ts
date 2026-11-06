import { TableClient } from "@azure/data-tables";
import type { AccessContext } from "@pegma/authorization-core";
import { createAzureTablesStore } from "@pegma/storage-azure-tables";
import { createMemoryStore, type Store } from "@pegma/storage-core";
import {
  createInboundMailProcessor,
  createSupportDeskApplication,
  inboundReceiptLocation,
  inboundReceipts,
  repairThreadIndexPage,
  supportPermissions,
  sweepInboundReceipts,
  sweepThreadIndexPage,
  threadIndex,
  type InboundEmailInput,
} from "@pegma/support-desk-application";
import { describe, expect, it } from "vitest";

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

let tableCounter = 0;
function freshAzureStore(): Store {
  tableCounter += 1;
  const table = `pegmainbound${tableCounter}t${process.pid}`;
  const client = TableClient.fromConnectionString(CONNECTION_STRING, table, {
    allowInsecureConnection: true,
  });
  return createAzureTablesStore({ client });
}

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
  permissions: [supportPermissions.queueRead],
};

const TOKEN = "rt_publicentry0123456789abcdef";
const DAY = 86_400_000;

function clockAt(start: string) {
  let current = start;
  return {
    now: () => current,
    advance(milliseconds: number) {
      current = new Date(Date.parse(current) + milliseconds).toISOString();
    },
  };
}

function mail(
  providerEventId: string,
  overrides: Partial<InboundEmailInput> = {},
): InboundEmailInput {
  return {
    channelId: "support-mailbox",
    providerEventId,
    ticketId: `ticket-${providerEventId}`,
    messageId: `message-${providerEventId}`,
    correlationId: `correlation-${providerEventId}`,
    from: "visitor@example.org",
    subject: "Question about invoices",
    body: "Where can I download last month's invoice?",
    ...overrides,
  };
}

async function exerciseInboundMail(store: Store): Promise<void> {
  const clock = clockAt("2026-09-01T12:00:00.000Z");
  const application = createSupportDeskApplication({ store, clock });
  const processor = createInboundMailProcessor({
    store,
    clock,
    accountMatcher: {
      async matchSenderEmail({ email }) {
        return email.toLowerCase() === "member@example.org"
          ? { matches: "one", principalId: "member-1" }
          : { matches: "none" };
      },
    },
    routingPolicy: {
      routeNewConversation: ({ association }) => ({
        priority: association === "matched_email" ? "normal" : "low",
      }),
    },
    notificationPolicy: {
      notificationFor: (context) => ({
        id: `alert-${context.messageId}`,
        recipientRef: "support-queue",
        templateId: "staff.inbound",
        templateVersion: 1,
        variables: {},
        subject: "[SD-{{ticket_number}}] Inbound mail",
        outboundMessageId: `<alert.${context.messageId}@support.example.test>`,
      }),
    },
    subjectMarkerPrefix: "SD",
    supportAddresses: ["support@example.test"],
  });

  await application.createCustomerTicket(customer, {
    commandId: "web-create",
    correlationId: "web-create",
    ticketId: "web-ticket",
    messageId: "web-message",
    subject: "Export fails",
    body: "The export button is disabled.",
    requesterEmail: "customer@example.org",
    notification: {
      id: "web-confirmation",
      recipientRef: "customer-recipient",
      templateId: "customer.created",
      templateVersion: 1,
      variables: {},
      subject: "[SD-{{ticket_number}}] Export fails",
      outboundMessageId: "<created.web-ticket@support.example.test>",
      replyRoutingToken: TOKEN,
    },
  });

  // Unknown sender: one low-priority unverified ticket, even when retried.
  const unknown = mail("event-unknown");
  const created = await processor.processInboundEmail(unknown);
  expect(created).toMatchObject({
    outcome: "created",
    association: "unverified",
    ticketId: unknown.ticketId,
  });
  expect(
    await processor.processInboundEmail({
      ...unknown,
      ticketId: "retry-ticket",
      messageId: "retry-message",
    }),
  ).toEqual({ ...created, duplicateDelivery: true });

  // Unique account match routes without granting web access.
  const member = mail("event-member", { from: "member@example.org" });
  expect(await processor.processInboundEmail(member)).toMatchObject({
    association: "matched_email",
  });
  expect(await application.listCustomerTickets(customer)).toHaveLength(1);

  // Replies join by routing token, then by Message-ID threading.
  expect(
    await processor.processInboundEmail(
      mail("event-token-reply", {
        from: "customer@example.org",
        replyRoutingToken: TOKEN,
      }),
    ),
  ).toMatchObject({ outcome: "replied", ticketId: "web-ticket" });
  expect(
    await processor.processInboundEmail(
      mail("event-header-reply", {
        from: "customer@example.org",
        inReplyTo: "<created.web-ticket@support.example.test>",
      }),
    ),
  ).toMatchObject({ outcome: "replied", matchMethod: "message_id" });

  // An auto-reply never loops back into the conversation.
  expect(
    await processor.processInboundEmail(
      mail("event-auto-reply", {
        from: "customer@example.org",
        replyRoutingToken: TOKEN,
        loopSignals: { autoSubmitted: "auto-replied" },
      }),
    ),
  ).toMatchObject({ outcome: "suppressed", reason: "auto_submitted" });

  const view = await application.readCustomerTicket(customer, "web-ticket");
  expect(view.messages.map((message) => message.channel)).toEqual([
    "web",
    "email",
    "email",
  ]);
  const queue = await application.listStaffQueue(staff, {
    channel: "email",
  });
  expect(queue.items.map((item) => item.requesterAssociation).sort()).toEqual([
    "matched_email",
    "unverified",
  ]);

  // Every thread-index row round-trips through the codec and its own key.
  const index = store.collection(threadIndex);
  const rows: { key: { partition: string; id: string } }[] = [];
  let cursor: string | undefined;
  do {
    const page = await index.scan({
      limit: 3,
      ...(cursor === undefined ? {} : { cursor }),
    });
    for (const entry of page.records) {
      expect(threadIndex.key(entry.value)).toEqual(entry.key);
      const encoded = threadIndex.codec.encode(entry.value);
      expect(threadIndex.codec.decode(encoded)).toEqual(entry.value);
      rows.push(entry);
    }
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  expect(rows.length).toBeGreaterThanOrEqual(6);

  // Repair is idempotent over a complete authoritative cycle.
  let repaired = 0;
  cursor = undefined;
  do {
    const page = await repairThreadIndexPage({
      store,
      clock,
      threadIndexRetentionMilliseconds: 30 * DAY,
      limit: 5,
      ...(cursor === undefined ? {} : { cursor }),
    });
    repaired += page.indexed;
    expect(page.collisions).toBe(0);
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  expect(repaired).toBe(0);

  // After retention, message rows are swept and receipts age out.
  clock.advance(45 * DAY);
  let deleted = 0;
  cursor = undefined;
  do {
    const page = await sweepThreadIndexPage({
      store,
      clock,
      threadIndexRetentionMilliseconds: 30 * DAY,
      ...(cursor === undefined ? {} : { cursor }),
    });
    deleted += page.deleted;
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  expect(deleted).toBeGreaterThan(0);
  const remaining = await index.scan({ limit: 100 });
  expect(
    remaining.records.every((entry) => entry.value.kind === "ticket_number"),
  ).toBe(true);

  const location = await inboundReceiptLocation(
    unknown.channelId,
    unknown.providerEventId,
  );
  expect(
    await sweepInboundReceipts(store, clock, {
      bucket: location.bucket,
      processedBefore: clock.now(),
    }),
  ).toBe(1);
  expect(await store.collection(inboundReceipts).list(location.bucket)).toEqual(
    [],
  );
}

describe("inbound mail through public entry points", () => {
  it("processes, threads, deduplicates, and sweeps in memory", async () => {
    await exerciseInboundMail(createMemoryStore());
  });

  it("matches the memory behavior against Azurite", async () => {
    await exerciseInboundMail(freshAzureStore());
  });
});
