import { TableClient } from "@azure/data-tables";
import { createAzureTablesStore } from "@pegma/storage-azure-tables";
import { createMemoryStore, type Store } from "@pegma/storage-core";
import { describe, expect, it } from "vitest";
import {
  createSupportDeskApplication,
  supportRecords,
} from "@pegma/support-desk-application";
import {
  EXAMPLE_CUSTOMER as customer,
  EXAMPLE_STAFF as staff,
} from "../examples/composition/composition.js";
import { TABLE_PORT } from "../test/azurite.js";
import { createHash } from "node:crypto";

function azureStore(): Store {
  const connection = `DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;TableEndpoint=http://127.0.0.1:${TABLE_PORT}/devstoreaccount1;`;
  return createAzureTablesStore({
    client: TableClient.fromConnectionString(
      connection,
      `attachments${process.pid}`,
      { allowInsecureConnection: true },
    ),
  });
}
for (const [name, factory] of [
  ["memory", createMemoryStore],
  ["Azurite", azureStore],
] as const) {
  describe(`attachments via published entry (${name})`, () => {
    it("commits message metadata, receipt, Audit and notification; gates bytes and deletes", async () => {
      const store = factory();
      const blobs = new Map<string, Uint8Array>();
      const app = createSupportDeskApplication({
        store,
        clock: { now: () => "2026-11-01T10:00:00.000Z" },
        attachments: {
          blobs: {
            async put(key, bytes) {
              blobs.set(key, new Uint8Array(bytes));
            },
            async get(key) {
              return blobs.get(key)!;
            },
            async delete(key) {
              blobs.delete(key);
            },
          },
        },
      });
      const bytes = new TextEncoder().encode("Synthetic diagnostic");
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const command = {
        ticketId: "ticket",
        messageId: "message",
        commandId: "create",
        correlationId: "correlation",
        subject: "Question",
        body: "Details",
        attachments: [
          {
            filename: "diagnostic.txt",
            contentType: "text/plain",
            bytes,
            sha256,
          },
        ],
        notification: {
          id: "notification",
          recipientRef: "staff",
          templateId: "new-ticket",
          templateVersion: 1,
          variables: {},
          subject: "Ticket {{ticket_number}}",
          outboundMessageId: "<attachment@example.test>",
        },
      };
      const created = await app.createCustomerTicket(customer, command);
      expect(await app.createCustomerTicket(customer, command)).toEqual(
        created,
      );
      expect(blobs.size).toBe(1);
      const rows = await store.collection(supportRecords).list("ticket");
      for (const kind of [
        "ticket",
        "message",
        "command",
        "audit",
        "delivery_job",
      ])
        expect(rows.some((row) => row.kind === kind)).toBe(true);
      const state = {
        ticketId: "ticket",
        messageId: "message",
        attachmentId: created.messages[0]!.attachments![0]!.id,
        commandId: "scan",
        correlationId: "correlation",
      };
      await expect(app.downloadAttachment(customer, state)).rejects.toThrow();
      await app.recordAttachmentScanResult(staff, {
        ...state,
        sha256,
        verdict: "clean",
      });
      expect((await app.downloadAttachment(customer, state)).bytes).toEqual(
        bytes,
      );
      await app.deleteAttachment(staff, { ...state, commandId: "delete" });
      expect(blobs.size).toBe(0);
      expect(
        (await app.readTicketAuditHistory(staff, "ticket")).map(
          (event) => event.action,
        ),
      ).toEqual([
        "support.ticket.created",
        "support.ticket.attachment_scan",
        "support.ticket.attachment_deleting",
        "support.ticket.attachment_deleted",
      ]);
    });
  });
}
