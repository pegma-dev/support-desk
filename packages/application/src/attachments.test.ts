import { createMemoryStore, type Store } from "@pegma/storage-core";
import type { AccessContext } from "@pegma/authorization-core";
import { describe, expect, it, vi } from "vitest";
import {
  createSupportDeskApplication,
  supportPermissions,
  supportRecords,
  sweepExpiredAttachments,
  cleanupUnreferencedAttachmentBlobs,
  type AttachmentOptions,
} from "./index.js";
import { attachmentDigest } from "./attachments.js";

const customer: AccessContext = {
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
const staff: AccessContext = {
  ...customer,
  principalId: "staff",
  permissions: [
    supportPermissions.queueRead,
    supportPermissions.manage,
    supportPermissions.note,
    supportPermissions.replyAny,
    supportPermissions.auditRead,
  ],
};
const base = {
  ticketId: "ticket",
  messageId: "message",
  commandId: "create",
  correlationId: "correlation",
  subject: "Question",
  body: "Details",
};
async function fixture(
  overrides: Partial<AttachmentOptions> = {},
  suppliedStore?: Store,
) {
  const store = suppliedStore ?? createMemoryStore();
  const data = new Map<string, Uint8Array>();
  const blobs = {
    put: vi.fn(
      async (key: string, bytes: Uint8Array): Promise<void | "exists"> => {
        if (data.has(key)) throw new Error("collision");
        data.set(key, new Uint8Array(bytes));
      },
    ),
    get: vi.fn(async (key: string, max: number) => {
      const bytes = data.get(key);
      if (!bytes || bytes.length > max) throw new Error("missing/oversized");
      return new Uint8Array(bytes);
    }),
    delete: vi.fn(async (key: string) => {
      data.delete(key);
    }),
  };
  let now = "2026-11-01T10:00:00.000Z";
  const clock = { now: () => now };
  const app = createSupportDeskApplication({
    store,
    clock,
    attachments: { blobs, ...overrides },
  });
  const bytes = new TextEncoder().encode("safe text");
  const input = {
    filename: '../file\r\n".txt',
    contentType: "text/plain",
    bytes,
    sha256: await attachmentDigest(bytes),
  };
  const create = { ...base, attachments: [input] };
  const state = (attachmentId: string, commandId = "scan") => ({
    ticketId: base.ticketId,
    messageId: base.messageId,
    attachmentId,
    commandId,
    correlationId: base.correlationId,
  });
  return {
    store,
    data,
    blobs,
    clock,
    app,
    input,
    create,
    state,
    advance: () => {
      now = "2027-01-01T10:00:00.000Z";
    },
  };
}

describe("attachments public services", () => {
  it("never deletes a colliding immutable key owned by another write", async () => {
    const f = await fixture();
    f.blobs.put.mockResolvedValueOnce("exists");
    await expect(
      f.app.createCustomerTicket(customer, f.create),
    ).rejects.toThrow("collision");
    expect(f.blobs.delete).not.toHaveBeenCalled();
    await f.app.createCustomerTicket(customer, f.create);
    expect(f.data.size).toBe(1);
  });

  it("preserves cleanup capacity even when ordinary commands fill the ticket", async () => {
    const f = await fixture();
    const app = createSupportDeskApplication({
      store: f.store,
      clock: f.clock,
      limits: { maxRecordsPerTicket: 14 },
      attachments: { blobs: f.blobs },
    });
    const created = await app.createCustomerTicket(customer, f.create);
    await app.setTags(staff, {
      ticketId: base.ticketId,
      commandId: "tags",
      correlationId: "c",
      tags: [],
    });
    await expect(
      app.addNote(staff, {
        ...base,
        commandId: "overflow",
        messageId: "overflow",
      }),
    ).rejects.toThrow();
    const id = created.messages[0]!.attachments![0]!.id;
    await app.recordAttachmentScanResult(staff, {
      ...f.state(id),
      sha256: f.input.sha256,
      verdict: "clean",
    });
    const key = [...f.data.keys()][0]!;
    f.data.set(key, new TextEncoder().encode("corrupted"));
    await expect(
      app.downloadAttachment(customer, f.state(id)),
    ).rejects.toThrow();
    await app.deleteAttachment(staff, f.state(id, "delete"));
    expect(f.data.size).toBe(0);
    expect(
      await f.store.collection(supportRecords).list(base.ticketId),
    ).toHaveLength(14);
  });

  it("reconciles a transaction that committed before its response was lost", async () => {
    const backing = createMemoryStore();
    let loseResponse = true;
    const store: Store = {
      collection(definition) {
        const collection = backing.collection(definition);
        return new Proxy(collection, {
          get(target, property, receiver) {
            if (
              property !== "transact" ||
              definition.name !== supportRecords.name
            )
              return Reflect.get(target, property, receiver);
            return async (...args: Parameters<typeof target.transact>) => {
              const result = await target.transact(...args);
              if (result.committed && loseResponse) {
                loseResponse = false;
                throw new Error("response lost");
              }
              return result;
            };
          },
        });
      },
    };
    const f = await fixture({}, store);
    await expect(
      f.app.createCustomerTicket(customer, f.create),
    ).rejects.toThrow("response lost");
    expect(f.data.size).toBe(1);
    await f.app.createCustomerTicket(customer, f.create);
    expect(f.blobs.put).toHaveBeenCalledTimes(1);
    const key = [...f.data.keys()][0]!;
    expect(
      await cleanupUnreferencedAttachmentBlobs({
        store,
        blobs: f.blobs,
        candidates: [
          { key, ticketId: base.ticketId, messageId: base.messageId },
        ],
        withUploadsPaused: (work) => work(),
      }),
    ).toEqual({ deleted: 0 });
  });

  it("atomically commits safe metadata and replays without uploading again", async () => {
    const f = await fixture();
    const view = await f.app.createCustomerTicket(customer, f.create);
    const attachment = view.messages[0]!.attachments![0]!;
    expect(attachment.scanStatus).toBe("pending_scan");
    expect(JSON.stringify(view)).not.toContain("blobKey");
    expect(f.data.size).toBe(1);
    expect([...f.data.keys()][0]).toMatch(
      /^support-attachments\/[a-f0-9-]{36}$/,
    );
    expect(await f.app.createCustomerTicket(customer, f.create)).toEqual(view);
    expect(f.blobs.put).toHaveBeenCalledTimes(1);
    await expect(
      f.app.createCustomerTicket(customer, { ...f.create, attachments: [] }),
    ).rejects.toThrow();
    await expect(
      f.app.createCustomerTicket(customer, {
        ...f.create,
        attachments: [{ ...f.input, filename: "different.txt" }],
      }),
    ).rejects.toThrow();
    const rows = await f.store.collection(supportRecords).list(base.ticketId);
    expect(rows.filter((row) => row.kind === "audit")).toHaveLength(1);
    expect(rows.find((row) => row.kind === "message")).toMatchObject({
      message: { attachments: [{ sha256: f.input.sha256 }] },
    });
    await expect(
      f.app.downloadAttachment(customer, f.state(attachment.id)),
    ).rejects.toThrow();
    await f.app.recordAttachmentScanResult(staff, {
      ...f.state(attachment.id),
      sha256: f.input.sha256,
      verdict: "clean",
    });
    const download = await f.app.downloadAttachment(
      customer,
      f.state(attachment.id),
    );
    expect(download.bytes).toEqual(f.input.bytes);
    expect(download.contentDisposition).toMatch(/^attachment;/);
    expect(download.xContentTypeOptions).toBe("nosniff");
    await expect(
      f.app.downloadAttachment(
        { ...customer, principalId: "other" },
        f.state(attachment.id),
      ),
    ).rejects.toThrow();
    await expect(
      f.app.downloadAttachment(
        { ...customer, permissions: [] },
        f.state(attachment.id),
      ),
    ).rejects.toThrow();
    await expect(
      f.app.recordAttachmentScanResult(staff, {
        ...f.state(attachment.id, "changed"),
        sha256: f.input.sha256,
        verdict: "quarantined",
      }),
    ).rejects.toThrow();
    await f.app.recordAttachmentScanResult(staff, {
      ...f.state(attachment.id),
      sha256: f.input.sha256,
      verdict: "clean",
    });
    await f.app.deleteAttachment(staff, f.state(attachment.id, "delete"));
    await f.app.deleteAttachment(staff, f.state(attachment.id, "delete"));
    expect(f.data.size).toBe(0);
    await expect(
      f.app.downloadAttachment(staff, f.state(attachment.id)),
    ).rejects.toThrow();
    await expect(
      f.app.createCustomerTicket(customer, f.create),
    ).resolves.toBeDefined();
    expect(f.blobs.put).toHaveBeenCalledTimes(1);
  });

  it("supports every message path and keeps clean internal-note bytes private", async () => {
    const f = await fixture();
    await f.app.createCustomerTicket(customer, base);
    await f.app.replyToCustomerTicket(customer, {
      ...f.create,
      commandId: "reply",
      messageId: "reply",
    });
    await f.app.replyAsStaff(staff, {
      ...f.create,
      commandId: "staff",
      messageId: "staff",
    });
    const note = { ...f.create, commandId: "note", messageId: "note" };
    await f.app.addNote(staff, note);
    await f.app.addNote(staff, note);
    expect(f.data.size).toBe(3);
    const detail = await f.app.readStaffTicket(staff, base.ticketId);
    const attachment = detail.messages.find((item) => item.id === "note")!
      .attachments![0]!;
    const state = { ...f.state(attachment.id), messageId: "note" };
    await f.app.recordAttachmentScanResult(staff, {
      ...state,
      sha256: f.input.sha256,
      verdict: "clean",
    });
    expect(
      (await f.app.readCustomerTicket(customer, base.ticketId)).messages.map(
        (item) => item.id,
      ),
    ).not.toContain("note");
    await expect(f.app.downloadAttachment(customer, state)).rejects.toThrow();
    await expect(f.app.downloadAttachment(staff, state)).resolves.toBeDefined();
  });

  it("refuses quarantine, bad scan digests, corrupt bytes, and expiry", async () => {
    const f = await fixture();
    const view = await f.app.createCustomerTicket(customer, f.create);
    const attachment = view.messages[0]!.attachments![0]!;
    await expect(
      f.app.recordAttachmentScanResult(staff, {
        ...f.state(attachment.id),
        sha256: "0".repeat(64),
        verdict: "clean",
      }),
    ).rejects.toThrow();
    await f.app.recordAttachmentScanResult(staff, {
      ...f.state(attachment.id),
      sha256: f.input.sha256,
      verdict: "quarantined",
    });
    for (const caller of [customer, staff])
      await expect(
        f.app.downloadAttachment(caller, f.state(attachment.id)),
      ).rejects.toThrow();
    f.advance();
    let cursor: string | undefined;
    do {
      const page = await sweepExpiredAttachments({
        store: f.store,
        clock: f.clock,
        application: f.app,
        access: staff,
        ...(cursor ? { cursor } : {}),
        limit: 2,
      });
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(f.data.size).toBe(0);
  });

  it("retains the deletion fence if the host fails, then resumes", async () => {
    const f = await fixture();
    const view = await f.app.createCustomerTicket(customer, f.create);
    const id = view.messages[0]!.attachments![0]!.id;
    f.blobs.delete.mockRejectedValueOnce(new Error("unavailable"));
    await expect(
      f.app.deleteAttachment(staff, f.state(id, "delete")),
    ).rejects.toThrow("unavailable");
    expect(
      (await f.app.readCustomerTicket(customer, base.ticketId)).messages[0]!
        .attachments![0]!.scanStatus,
    ).toBe("deleting");
    await f.app.deleteAttachment(staff, f.state(id, "delete"));
    expect(f.data.size).toBe(0);
  });

  it("enforces MIME, SHA, physical count, byte, and ticket limits before writes", async () => {
    const f = await fixture({
      maxPerMessage: 1,
      maxPerTicket: 1,
      maxBytes: 10,
      maxMessageBytes: 10,
    });
    for (const attachments of [
      [{ ...f.input, contentType: "text/html" }],
      [{ ...f.input, sha256: "0".repeat(64) }],
      [f.input, f.input],
      [{ ...f.input, bytes: new Uint8Array(11) }],
    ])
      await expect(
        f.app.createCustomerTicket(customer, { ...base, attachments }),
      ).rejects.toThrow();
    expect(f.blobs.put).not.toHaveBeenCalled();
    await f.app.createCustomerTicket(customer, f.create);
    await expect(
      f.app.replyToCustomerTicket(customer, {
        ...f.create,
        commandId: "reply",
        messageId: "reply",
      }),
    ).rejects.toThrow("Ticket attachment limit");
    expect(f.blobs.put).toHaveBeenCalledTimes(1);
  });

  it("cleans uploads on refusal and upload failure; reconciles unknown outcomes under a host fence", async () => {
    const backing = createMemoryStore();
    let refuse = false;
    const store: Store = {
      collection(definition) {
        const collection = backing.collection(definition);
        return new Proxy(collection, {
          get(target, property, receiver) {
            if (
              property !== "transact" ||
              definition.name !== supportRecords.name
            )
              return Reflect.get(target, property, receiver);
            return async (...args: Parameters<typeof target.transact>) =>
              refuse
                ? { committed: false, reason: "conflict" }
                : target.transact(...args);
          },
        });
      },
    };
    const f = await fixture({}, store);
    await f.app.createCustomerTicket(customer, base);
    refuse = true;
    await expect(
      f.app.replyToCustomerTicket(customer, {
        ...f.create,
        commandId: "reply",
        messageId: "reply",
      }),
    ).rejects.toThrow();
    expect(f.data.size).toBe(0);
    refuse = false;
    f.blobs.put.mockImplementationOnce(async (key, bytes) => {
      f.data.set(key, bytes);
      throw new Error("upload failed");
    });
    await expect(
      f.app.replyToCustomerTicket(customer, {
        ...f.create,
        commandId: "reply",
        messageId: "reply",
      }),
    ).rejects.toThrow("upload failed");
    expect(f.data.size).toBe(0);
    const key = `support-attachments/${crypto.randomUUID()}`;
    f.data.set(key, f.input.bytes);
    let fenced = false;
    expect(
      await cleanupUnreferencedAttachmentBlobs({
        store,
        blobs: f.blobs,
        candidates: [{ key, ticketId: base.ticketId, messageId: "missing" }],
        async withUploadsPaused(work) {
          fenced = true;
          return work();
        },
      }),
    ).toEqual({ deleted: 1 });
    expect(fenced).toBe(true);
    expect(f.data.size).toBe(0);
  });
});
