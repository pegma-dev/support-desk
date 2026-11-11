import { TableClient } from "@azure/data-tables";
import { createAzureTablesStore } from "@pegma/storage-azure-tables";
import { createMemoryStore, type Store } from "@pegma/storage-core";
import { describe, expect, it, vi } from "vitest";
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

async function deletionFixture(store: Store) {
  const ticketId = `deletion-${crypto.randomUUID()}`;
  const blobs = new Map<string, Uint8Array>();
  const remove = vi.fn(async (key: string) => {
    blobs.delete(key);
  });
  const app = createSupportDeskApplication({
    store,
    clock: { now: () => "2026-11-01T10:00:00.000Z" },
    attachments: {
      blobs: {
        async put(key, bytes) {
          blobs.set(key, new Uint8Array(bytes));
        },
        async get(key) {
          return new Uint8Array(blobs.get(key)!);
        },
        delete: remove,
      },
    },
  });
  const bytes = new TextEncoder().encode("Synthetic diagnostic");
  const view = await app.createCustomerTicket(customer, {
    ticketId,
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
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    ],
  });
  const command = {
    ticketId,
    messageId: "message",
    attachmentId: view.messages[0]!.attachments![0]!.id,
    commandId: "delete",
    correlationId: "correlation",
  };
  return {
    ticketId,
    app,
    blobs,
    remove,
    command,
    records: store.collection(supportRecords),
  };
}

for (const [name, factory] of [
  ["memory", createMemoryStore],
  ["Azurite", azureStore],
] as const) {
  describe(`attachments via published entry (${name})`, () => {
    it.each([
      { caller: "legacy-derived", order: "before" },
      { caller: "legacy-derived", order: "after" },
      { caller: "literal-percent", order: "before" },
      { caller: "literal-percent", order: "after" },
    ])(
      "keeps caller $caller Audit distinct when its command runs $order deletion",
      async ({ caller, order }) => {
        const f = await deletionFixture(factory());
        const callerId =
          caller === "legacy-derived"
            ? `attachment-fence-${createHash("sha256")
                .update(JSON.stringify({ commandId: f.command.commandId }))
                .digest("hex")}`
            : "%00support.attachment.fence:" + f.command.commandId;
        const runCaller = () =>
          f.app.setTags(staff, {
            ticketId: f.ticketId,
            commandId: callerId,
            correlationId: "caller",
            tags: [],
          });
        if (order === "before") await runCaller();
        await f.app.deleteAttachment(staff, f.command);
        if (order === "after") await runCaller();
        expect(f.blobs.size).toBe(0);
        const rows = await f.records.list(f.ticketId);
        const callerAudit = rows.find(
          (row) => row.kind === "audit" && row.event.id === callerId,
        );
        const fenceAudit = rows.find(
          (row) =>
            row.kind === "audit" &&
            row.event.action === "support.ticket.attachment_deleting",
        );
        expect(callerAudit?.kind).toBe("audit");
        expect(fenceAudit?.kind).toBe("audit");
        if (callerAudit?.kind !== "audit" || fenceAudit?.kind !== "audit")
          throw new Error("Missing actual Audit events");
        expect(callerAudit.id).not.toBe(fenceAudit.id);
        expect(fenceAudit.event.id).toBe(
          "\u0000support.attachment.fence:" + f.command.commandId,
        );
        expect(fenceAudit.event.details?.commandId).toBe(f.command.commandId);
        expect(fenceAudit.id).toContain("%00support.attachment.fence:");
        if (caller === "literal-percent")
          expect(callerAudit.id).toContain("%2500support.attachment.fence:");
        expect(
          await f.app.readTicketAuditHistory(staff, f.ticketId),
        ).toHaveLength(4);
      },
    );

    it("reports same-ID changed payload when the original receipt appears after a causal null read", async () => {
      const backing = factory();
      let armed = false;
      let observedStale!: () => void;
      let releaseStale!: () => void;
      const staleRead = new Promise<void>((resolve) => {
        observedStale = resolve;
      });
      const resumeRead = new Promise<void>((resolve) => {
        releaseStale = resolve;
      });
      const store: Store = {
        collection(definition) {
          const collection = backing.collection(definition);
          return new Proxy(collection, {
            get(target, property) {
              if (property !== "getVersioned") {
                const value = Reflect.get(target, property, target);
                return typeof value === "function" ? value.bind(target) : value;
              }
              return async (
                ...args: Parameters<typeof collection.getVersioned>
              ) => {
                const value = await collection.getVersioned(...args);
                if (
                  armed &&
                  args[0].id === "command:delete" &&
                  value === null
                ) {
                  armed = false;
                  observedStale();
                  await resumeRead;
                }
                return value;
              };
            },
          });
        },
      };
      const f = await deletionFixture(store);
      let observedBlob!: () => void;
      let releaseBlob!: () => void;
      const blobStarted = new Promise<void>((resolve) => {
        observedBlob = resolve;
      });
      const resumeBlob = new Promise<void>((resolve) => {
        releaseBlob = resolve;
      });
      f.remove.mockImplementationOnce(async (key) => {
        observedBlob();
        await resumeBlob;
        f.blobs.delete(key);
      });
      armed = true;
      const changed = f.app.deleteAttachment(staff, {
        ...f.command,
        correlationId: "changed",
      });
      await staleRead;
      const original = f.app.deleteAttachment(staff, f.command);
      try {
        await blobStarted;
        const during = await f.records.listVersioned(f.ticketId);
        releaseStale();
        await expect(changed).rejects.toThrow(
          "Command ID reused with different input",
        );
        expect(await f.records.listVersioned(f.ticketId)).toEqual(during);
        expect(f.remove).toHaveBeenCalledTimes(1);
      } finally {
        releaseStale();
        releaseBlob();
      }
      await original;
      expect(f.blobs.size).toBe(0);
    });

    it("refuses an occupied original deletion ID before changing metadata or bytes", async () => {
      const f = await deletionFixture(factory());
      const before = await f.records.listVersioned(f.ticketId);
      await expect(
        f.app.deleteAttachment(staff, { ...f.command, commandId: "create" }),
      ).rejects.toThrow("Command ID reused");
      expect(f.remove).not.toHaveBeenCalled();
      expect(f.blobs.size).toBe(1);
      expect(await f.records.listVersioned(f.ticketId)).toEqual(before);
      await f.app.deleteAttachment(staff, f.command);
      expect(f.blobs.size).toBe(0);
    });

    it("keeps the original pending identity across competing actors and exact finalizers", async () => {
      const f = await deletionFixture(factory());
      let started!: () => void;
      let release!: () => void;
      const observed = new Promise<void>((resolve) => {
        started = resolve;
      });
      const resume = new Promise<void>((resolve) => {
        release = resolve;
      });
      f.remove.mockImplementationOnce(async (key) => {
        started();
        await resume;
        f.blobs.delete(key);
      });
      const first = f.app.deleteAttachment(staff, f.command);
      await observed;
      try {
        const pending = await f.records.get({
          partition: f.ticketId,
          id: "command:delete",
        });
        expect(pending).toMatchObject({
          attachmentDeletion: {
            phase: "pending",
            actorId: staff.principalId,
            messageId: "message",
            attachmentId: f.command.attachmentId,
          },
        });
        await expect(
          f.app.deleteAttachment(staff, {
            ...f.command,
            commandId: "other-delete",
          }),
        ).rejects.toThrow("another identity");
        await expect(
          f.app.deleteAttachment(
            { ...staff, principalId: "other-staff" },
            f.command,
          ),
        ).rejects.toThrow("another identity");
        await expect(
          f.app.setTags(staff, {
            ticketId: f.ticketId,
            commandId: "delete",
            correlationId: "correlation",
            tags: [],
          }),
        ).rejects.toThrow();
        expect(f.remove).toHaveBeenCalledTimes(1);
        // The same actor and exact packet can finish the accepted operation.
        await f.app.deleteAttachment(staff, f.command);
      } finally {
        release();
      }
      await first;
      await f.app.deleteAttachment(staff, f.command);
      expect(f.remove).toHaveBeenCalledTimes(2);
      expect(
        await f.records.get({ partition: f.ticketId, id: "command:delete" }),
      ).toMatchObject({
        attachmentDeletion: { phase: "complete", actorId: staff.principalId },
      });
      expect(
        (await f.app.readTicketAuditHistory(staff, f.ticketId)).map(
          (event) => event.action,
        ),
      ).toEqual([
        "support.ticket.created",
        "support.ticket.attachment_deleting",
        "support.ticket.attachment_deleted",
      ]);
    });

    it.each(["pending", "complete"] as const)(
      "recovers a genuinely committed %s transaction whose ACK was lost",
      async (phase) => {
        const backing = factory();
        let armed = false;
        let losses = 0;
        const store: Store = {
          collection(definition) {
            const collection = backing.collection(definition);
            return new Proxy(collection, {
              get(target, property) {
                if (property !== "transact") {
                  const value = Reflect.get(target, property, target);
                  return typeof value === "function"
                    ? value.bind(target)
                    : value;
                }
                return async (
                  ...args: Parameters<typeof collection.transact>
                ) => {
                  const result = await collection.transact(...args);
                  if (
                    result.committed &&
                    armed &&
                    args[1].some((action) => {
                      if (
                        action.action !== "insert" &&
                        action.action !== "putIfUnchanged"
                      )
                        return false;
                      const value: unknown = action.value;
                      if (
                        value === null ||
                        typeof value !== "object" ||
                        !("attachmentDeletion" in value)
                      )
                        return false;
                      const marker = value.attachmentDeletion;
                      return (
                        marker !== null &&
                        typeof marker === "object" &&
                        "phase" in marker &&
                        marker.phase === phase
                      );
                    })
                  ) {
                    armed = false;
                    losses++;
                    throw new Error("committed deletion ACK lost");
                  }
                  return result;
                };
              },
            });
          },
        };
        const f = await deletionFixture(store);
        armed = true;
        await expect(f.app.deleteAttachment(staff, f.command)).rejects.toThrow(
          "committed deletion ACK lost",
        );
        expect(losses).toBe(1);
        expect(
          await f.records.get({ partition: f.ticketId, id: "command:delete" }),
        ).toMatchObject({ attachmentDeletion: { phase } });
        expect(f.remove).toHaveBeenCalledTimes(phase === "pending" ? 0 : 1);
        await f.app.deleteAttachment(staff, f.command);
        expect(f.remove).toHaveBeenCalledTimes(1);
        expect(f.blobs.size).toBe(0);
        expect(await f.records.list(f.ticketId)).toHaveLength(9);
        expect(
          await f.app.readTicketAuditHistory(staff, f.ticketId),
        ).toHaveLength(3);
      },
    );

    it("retains a pending receipt after unknown blob ACK and reads omitted-phase completed receipts", async () => {
      const f = await deletionFixture(factory());
      f.remove.mockImplementationOnce(async (key) => {
        f.blobs.delete(key);
        throw new Error("blob ACK lost");
      });
      await expect(f.app.deleteAttachment(staff, f.command)).rejects.toThrow(
        "blob ACK lost",
      );
      expect(f.blobs.size).toBe(0);
      expect(
        await f.records.get({ partition: f.ticketId, id: "command:delete" }),
      ).toMatchObject({ attachmentDeletion: { phase: "pending" } });
      await f.app.deleteAttachment(staff, f.command);
      const key = { partition: f.ticketId, id: "command:delete" };
      const completed = await f.records.getVersioned(key);
      expect(completed?.value.kind).toBe("command");
      if (completed?.value.kind !== "command")
        throw new Error("Missing actual completion");
      // Structural old-format fixture, derived from a real completed producer
      // receipt. This is not a claim that an old writer ran in this case.
      const { attachmentDeletion: _phase, ...legacy } = completed.value;
      expect(await f.records.putIfUnchanged(legacy, completed.version)).toBe(
        true,
      );
      const before = await f.records.listVersioned(f.ticketId);
      await f.app.deleteAttachment(staff, f.command);
      expect(await f.records.listVersioned(f.ticketId)).toEqual(before);
      expect(f.remove).toHaveBeenCalledTimes(2);
    });

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
