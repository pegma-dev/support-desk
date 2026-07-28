import { TableClient, type TableEntity } from "@azure/data-tables";
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
  supportPermissions,
  supportRecords,
} from "@pegma/support-desk-application";
import {
  createDeliveryWorker,
  type CommittedDeliveryJobDiscovery,
  type DeliveryWorkStore,
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

function isSendCandidate(job: DeliveryJob, now: string): boolean {
  return (
    ((job.status === "pending" || job.status === "retrying") &&
      job.availableAt <= now) ||
    (job.status === "leased" &&
      job.leasePurpose === "send" &&
      job.leaseExpiresAt !== undefined &&
      job.leaseExpiresAt <= now)
  );
}

function candidate(job: DeliveryJob) {
  return {
    ticketId: job.ticketId,
    deliveryJobId: job.id.slice("delivery:".length),
  };
}

function attachDiscovery(
  store: Store,
  discovery: CommittedDeliveryJobDiscovery,
): DeliveryWorkStore {
  return {
    collection<T>(definition: CollectionDefinition<T>): CollectionStore<T> {
      return store.collection(definition);
    },
    committedDeliveryJobs: discovery,
  };
}

function memoryAuthoritativeRows(store: Store): CommittedDeliveryJobDiscovery {
  return {
    consistency: "authoritative_rows",
    async peek(now) {
      const records = await store.collection(supportRecords).list("ticket");
      const job = records.find(
        (record): record is DeliveryJob =>
          record.kind === "delivery_job" && isSendCandidate(record, now),
      );
      return job === undefined ? null : candidate(job);
    },
  };
}

function statusCode(error: unknown): number | undefined {
  return typeof error === "object" && error !== null
    ? (error as { readonly statusCode?: number }).statusCode
    : undefined;
}

function azureAuthoritativeRows(
  client: TableClient,
): CommittedDeliveryJobDiscovery {
  return {
    consistency: "authoritative_rows",
    async peek(now) {
      try {
        for await (const entity of client.listEntities<
          TableEntity<Record<string, unknown>>
        >()) {
          if (
            typeof entity.partitionKey !== "string" ||
            !entity.partitionKey.startsWith(`${supportRecords.name}:`) ||
            typeof entity.rowKey !== "string" ||
            !entity.rowKey.startsWith("delivery:") ||
            typeof entity["payload"] !== "string"
          ) {
            continue;
          }
          const value = JSON.parse(entity["payload"]) as unknown;
          if (
            value !== null &&
            typeof value === "object" &&
            (value as { readonly kind?: unknown }).kind === "delivery_job" &&
            isSendCandidate(value as DeliveryJob, now)
          ) {
            return candidate(value as DeliveryJob);
          }
        }
      } catch (error) {
        if (statusCode(error) !== 404) {
          throw error;
        }
      }
      return null;
    },
  };
}

async function exerciseCrashBoundary(
  store: Store,
  createDiscovery: () => CommittedDeliveryJobDiscovery,
): Promise<void> {
  const send = vi.fn(async () => ({ providerMessageRef: "provider-ref" }));
  const worker = () =>
    createDeliveryWorker({
      store: attachDiscovery(store, createDiscovery()),
      clock: fixedClock("2026-07-27T12:00:01.000Z"),
      workerId: "worker",
      reconciliation: {
        reconcile: async () => ({ status: "unknown" as const }),
      },
      delivery: { send },
      templates: { get: () => template },
    });

  // Discovery exists before the transaction but cannot produce a phantom.
  expect(await worker().runOnce("2026-07-27T12:00:00.000Z")).toBeNull();
  expect(send).not.toHaveBeenCalled();

  await createSupportDeskApplication({
    store,
    clock: fixedClock("2026-07-27T12:00:00.000Z"),
  }).createCustomerTicket(caller, {
    commandId: "create",
    correlationId: "correlation",
    ticketId: "ticket",
    ticketNumber: 1,
    messageId: "message",
    subject: "Question",
    body: "Help.",
    notification: {
      id: "notify",
      recipientRef: "support",
      templateId: template.id,
      templateVersion: template.version,
      variables: { ticket_number: "1" },
      subject: "[Ticket #1] Question",
      outboundMessageId: "<support.notify@example.test>",
    },
  });

  // A new worker/source instance represents a crash immediately after commit:
  // it carries no cursor or post-commit hint from the creating process.
  expect((await worker().runOnce("2026-07-27T12:00:01.000Z"))?.status).toBe(
    "accepted",
  );
  expect(send).toHaveBeenCalledTimes(1);
}

describe("atomic outbox discovery", () => {
  it("survives the commit/crash boundary with a D1-style authoritative row scan", async () => {
    const store = createMemoryStore();
    await exerciseCrashBoundary(store, () => memoryAuthoritativeRows(store));
  });

  it("survives the commit/crash boundary by scanning authoritative Azurite rows", async () => {
    const table = `pegmaoutbox${process.pid}`;
    const client = TableClient.fromConnectionString(CONNECTION_STRING, table, {
      allowInsecureConnection: true,
    });
    const store = createAzureTablesStore({ client });
    await exerciseCrashBoundary(store, () => azureAuthoritativeRows(client));
  });
});
