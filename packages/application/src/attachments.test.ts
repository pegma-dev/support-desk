import { createMemoryStore, type Store } from "@pegma/storage-core";
import type { AccessContext } from "@pegma/authorization-core";
import { describe, expect, it, vi } from "vitest";
import {
  createSupportDeskApplication,
  supportPermissions,
  supportRecords,
  customerTicketIndex,
  ticketNumbers,
  ticketNumberPartition,
  ticketNumberRecordId,
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
  it.each(
    [
      "MIME",
      "file-bytes",
      "message-bytes",
      "message-count",
      "ticket-count",
      "cleanup-reserve",
    ].flatMap((scenario) => [
      { scenario, admitted: false },
      { scenario, admitted: true },
    ]),
  )(
    "refuses fresh $scenario intake before any ticket reservation (admitted=$admitted)",
    async ({ scenario, admitted }) => {
      const options = {
        allowedContentTypes:
          scenario === "MIME" ? ["image/png"] : ["text/plain"],
        maxBytes: scenario === "file-bytes" ? 1 : 1024,
        maxMessageBytes: scenario === "message-bytes" ? 1 : 1024,
        maxPerMessage: scenario === "message-count" ? 1 : 3,
        maxPerTicket: scenario === "ticket-count" ? 1 : 20,
      };
      const f = await fixture(options);
      const app = createSupportDeskApplication({
        store: f.store,
        clock: f.clock,
        attachments: { blobs: f.blobs, ...options },
        limits: {
          maxTicketsPerPrincipal: 1,
          maxRecordsPerTicket: scenario === "cleanup-reserve" ? 11 : 512,
        },
      });
      const failed = {
        ...f.create,
        attachments: scenario.endsWith("count")
          ? [f.input, f.input]
          : [f.input],
      };
      const verifyBeforeCommit = vi.fn(() => () => true as const);
      await expect(
        admitted
          ? app.createAdmittedCustomerTicket(
              customer,
              { ...failed, preference: "human" },
              { verifyBeforeCommit },
            )
          : app.createCustomerTicket(customer, failed),
      ).rejects.toThrow();
      expect(f.blobs.put).not.toHaveBeenCalled();
      expect(verifyBeforeCommit).not.toHaveBeenCalled();
      expect(
        await f.store
          .collection(customerTicketIndex)
          .get({ partition: customer.principalId, id: "tickets" }),
      ).toBeNull();
      expect(
        await f.store
          .collection(ticketNumbers)
          .get({ partition: ticketNumberPartition, id: ticketNumberRecordId }),
      ).toBeNull();
      expect(
        await f.store.collection(supportRecords).list(base.ticketId),
      ).toEqual([]);
      const valid = {
        ...base,
        ticketId: "valid-ticket",
        commandId: "valid-create",
      };
      const accepted = admitted
        ? (
            await app.createAdmittedCustomerTicket(
              customer,
              { ...valid, preference: "human" },
              { verifyBeforeCommit },
            )
          ).view
        : await app.createCustomerTicket(customer, valid);
      expect(accepted.ticket.number).toBe(1);
      expect(
        await f.store
          .collection(customerTicketIndex)
          .get({ partition: customer.principalId, id: "tickets" }),
      ).toMatchObject({
        entries: [{ ticketId: "valid-ticket", state: "confirmed" }],
      });
    },
  );

  it("holds optional learning evidence without blocking confirmation or attachment cleanup at capacity", async () => {
    const f = await fixture();
    const configuration = {
      enabled: true,
      productContext: {
        async resolve(context: { readonly acceptedAt: string }) {
          return {
            productId: "synthetic-product",
            version: "1",
            buildId: "build-1",
            binding: "synthetic-product:1",
            contextVersion: "policy-1",
            receiptId: "synthetic-product-receipt",
            verifiedAt: context.acceptedAt,
            validUntil: new Date(
              Date.parse(context.acceptedAt) + 60_000,
            ).toISOString(),
          };
        },
      },
    };
    const app = createSupportDeskApplication({
      store: f.store,
      clock: f.clock,
      attachments: { blobs: f.blobs },
      resolutionLearning: configuration,
    });
    const created = await app.createCustomerTicket(customer, f.create);
    await app.resolveTicket(staff, {
      ticketId: base.ticketId,
      commandId: "resolve",
      correlationId: "resolve",
    });
    const records = f.store.collection(supportRecords);
    const before = await records.list(base.ticketId);
    expect(
      before.some((row) => row.kind === "resolution_learning_source"),
    ).toBe(true);
    // Six reserved attachment lifecycle rows, three confirmation rows, and two
    // source-withdrawal rows fit; an optional learning-work row does not.
    const maximum = before.length + 6 + 3 + 2;
    const limited = createSupportDeskApplication({
      store: f.store,
      clock: f.clock,
      attachments: { blobs: f.blobs },
      resolutionLearning: configuration,
      limits: { maxRecordsPerTicket: maximum },
    });
    const command = {
      ticketId: base.ticketId,
      commandId: "confirm",
      correlationId: "confirm",
      lastSeenVisibleMessageId: base.messageId,
    };
    const actor = {
      ...customer,
      permissions: [...customer.permissions, supportPermissions.confirmSuccess],
    };
    const result = await limited.confirmCustomerSuccess(actor, command);
    expect(result.ticket.status).toBe("resolved");
    const after = await records.list(base.ticketId);
    expect(after).toHaveLength(before.length + 3);
    expect(
      after.find((row) => row.kind === "resolution_learning_source"),
    ).toMatchObject({ state: "held", heldReason: "learning_capacity" });
    expect(after.some((row) => row.kind === "resolution_learning_work")).toBe(
      false,
    );
    expect(await limited.confirmCustomerSuccess(actor, command)).toEqual(
      result,
    );
    expect(await records.list(base.ticketId)).toEqual(after);
    await limited.deleteAttachment(
      staff,
      f.state(created.messages[0]!.attachments![0]!.id, "delete"),
    );
    expect(f.data.size).toBe(0);
    expect((await records.list(base.ticketId)).length).toBeLessThanOrEqual(
      maximum,
    );
  });

  it("rechecks admitted human intake after the host blob await", async () => {
    const f = await fixture();
    let current = true;
    f.blobs.put.mockImplementationOnce(async (key, bytes) => {
      f.data.set(key, new Uint8Array(bytes));
      current = false;
    });
    const verifyBeforeCommit = vi.fn(() => {
      if (!current) throw new Error("intake authority revoked");
      return () => {
        if (!current) throw new Error("intake authority revoked");
        return true as const;
      };
    });
    await expect(
      f.app.createAdmittedCustomerTicket(
        customer,
        { ...f.create, preference: "human" },
        { verifyBeforeCommit },
      ),
    ).rejects.toThrow("intake authority revoked");
    expect(verifyBeforeCommit).toHaveBeenCalledTimes(1);
    expect(f.blobs.put).toHaveBeenCalledTimes(1);
    expect(f.blobs.delete).toHaveBeenCalledTimes(1);
    expect(f.data.size).toBe(0);
    const rows = await f.store.collection(supportRecords).list(base.ticketId);
    expect(
      rows.filter((row) =>
        ["ticket", "message", "command", "audit", "mail"].includes(row.kind),
      ),
    ).toEqual([]);
  });

  it("keeps attachment metadata out of actual assistant reads and turn claims", async () => {
    const f = await fixture();
    const app = createSupportDeskApplication({
      store: f.store,
      clock: f.clock,
      attachments: { blobs: f.blobs },
      assistantHandlingEnabled: true,
      assistantTurns: { maxAttempts: 2 },
    });
    const created = await app.createCustomerTicket(
      {
        ...customer,
        permissions: [
          ...customer.permissions,
          supportPermissions.assistantStart,
        ],
      },
      { ...f.create, initialHandling: "assistant" },
    );
    expect(created.messages[0]!.attachments).toHaveLength(1);
    const service: AccessContext = {
      ...customer,
      principalId: "assistant-service",
      permissions: [
        supportPermissions.assistantRead,
        supportPermissions.assistantReply,
        supportPermissions.assistantEscalate,
      ],
    };
    // Physical rows are readable even if current cleanup admission reserves exceed
    // the lowered limit. The claim below uses the original mutation capacity.
    const limited = createSupportDeskApplication({
      store: f.store,
      clock: f.clock,
      limits: { maxRecordsPerTicket: 10 },
      assistantHandlingEnabled: true,
    });
    const conversation = await limited.readAssistantConversation(
      service,
      base.ticketId,
    );
    expect(conversation.messages[0]!.body).toBe(base.body);
    expect(conversation.messages[0]).not.toHaveProperty("attachments");
    await expect(
      limited.readHandoffWork(staff, base.ticketId),
    ).resolves.toEqual([]);
    await expect(
      limited.readCustomerSuccessConfirmations(staff, base.ticketId),
    ).resolves.toEqual([]);
    const page = await app.scanAssistantTurnCandidates(service, { limit: 100 });
    expect(page.candidates).toHaveLength(1);
    const claimed = await app.claimAssistantTurn(service, {
      ...page.candidates[0]!,
      workerId: "worker",
      claimId: "claim",
      leaseMilliseconds: 30_000,
    });
    expect(claimed).not.toBeNull();
    expect(claimed!.conversation.messages[0]!.body).toBe(base.body);
    expect(claimed!.conversation.messages[0]).not.toHaveProperty("attachments");
    for (const value of [conversation, claimed!.conversation]) {
      const encoded = JSON.stringify(value);
      expect(encoded).not.toContain("blobKey");
      expect(encoded).not.toContain(f.input.sha256);
      expect(encoded).not.toContain(
        created.messages[0]!.attachments![0]!.filename,
      );
    }
  });

  it.each(["ticket", "message"] as const)(
    "withholds downloaded bytes after the actual %s resource disappears",
    async (resource) => {
      const f = await fixture();
      const created = await f.app.createCustomerTicket(customer, f.create);
      const id = created.messages[0]!.attachments![0]!.id;
      await f.app.recordAttachmentScanResult(staff, {
        ...f.state(id),
        sha256: f.input.sha256,
        verdict: "clean",
      });
      const records = f.store.collection(supportRecords);
      const key = {
        partition: base.ticketId,
        id: resource === "ticket" ? "ticket" : `message:${base.messageId}`,
      };
      const before = await records.getVersioned(key);
      expect(before).not.toBeNull();
      f.blobs.get.mockImplementationOnce(async (blobKey) => {
        expect(await records.deleteIfUnchanged(key, before!.version)).toBe(
          true,
        );
        return new Uint8Array(f.data.get(blobKey)!);
      });
      await expect(
        f.app.downloadAttachment(customer, f.state(id)),
      ).rejects.toThrow("Attachment changed during download");
      expect(f.blobs.get).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["customer", "staff"] as const)(
    "withholds bytes when the original %s read permission changes during blob I/O",
    async (kind) => {
      const f = await fixture();
      const created = await f.app.createCustomerTicket(customer, f.create);
      const id = created.messages[0]!.attachments![0]!.id;
      await f.app.recordAttachmentScanResult(staff, {
        ...f.state(id),
        sha256: f.input.sha256,
        verdict: "clean",
      });
      const permissions = [
        ...(kind === "customer" ? customer.permissions : staff.permissions),
      ];
      const access: AccessContext = {
        ...(kind === "customer" ? customer : staff),
        permissions,
      };
      f.blobs.get.mockImplementationOnce(async (key) => {
        permissions.length = 0;
        return new Uint8Array(f.data.get(key)!);
      });
      await expect(
        f.app.downloadAttachment(access, f.state(id)),
      ).rejects.toThrow("Permission required:");
      expect(f.blobs.get).toHaveBeenCalledTimes(1);
    },
  );

  it("keeps filename and byte replay identity stable after host limits change", async () => {
    const f = await fixture({ maxBytes: 16, maxFilenameCharacters: 120 });
    const command = {
      ...f.create,
      attachments: [{ ...f.input, filename: "a".repeat(200) }],
    };
    const result = await f.app.createCustomerTicket(customer, command);
    expect(result.messages[0]!.attachments![0]!.filename).toHaveLength(120);
    const reconfigured = createSupportDeskApplication({
      store: f.store,
      clock: f.clock,
      attachments: {
        blobs: f.blobs,
        maxBytes: 1,
        maxMessageBytes: 1,
        maxFilenameCharacters: 40,
      },
    });
    expect(await reconfigured.createCustomerTicket(customer, command)).toEqual(
      result,
    );
    expect(f.blobs.put).toHaveBeenCalledTimes(1);
    await expect(
      reconfigured.replyToCustomerTicket(customer, {
        ...command,
        commandId: "new",
        messageId: "new",
      }),
    ).rejects.toThrow();
    expect(f.blobs.put).toHaveBeenCalledTimes(1);
  });

  it("preserves reads and allows deletion when the reservation budget is lowered", async () => {
    const f = await fixture();
    const created = await f.app.createCustomerTicket(customer, f.create);
    const app = createSupportDeskApplication({
      store: f.store,
      clock: f.clock,
      limits: { maxRecordsPerTicket: 10 },
      attachments: { blobs: f.blobs },
    });
    await expect(
      app.readCustomerTicket(customer, base.ticketId),
    ).resolves.toEqual(created);
    await expect(
      app.readStaffTicket(staff, base.ticketId),
    ).resolves.toBeDefined();
    await expect(
      app.readTicketAuditHistory(staff, base.ticketId),
    ).resolves.toHaveLength(1);
    await expect(
      app.readTicketAuditHistory({ ...staff, permissions: [] }, base.ticketId),
    ).rejects.toThrow("Permission required:");
    await expect(
      app.readTicketAuditHistory(staff, "missing-ticket"),
    ).rejects.toThrow("Ticket not found");
    await app.deleteAttachment(
      staff,
      f.state(created.messages[0]!.attachments![0]!.id, "d".repeat(200)),
    );
    expect(f.data.size).toBe(0);
    expect(
      await f.store.collection(supportRecords).list(base.ticketId),
    ).toHaveLength(9);
  });

  it("refuses a competing deletion identity while the original command completes", async () => {
    const f = await fixture();
    const created = await f.app.createCustomerTicket(customer, f.create);
    const id = created.messages[0]!.attachments![0]!.id;
    f.blobs.delete.mockImplementationOnce(async (key) => {
      await expect(
        f.app.deleteAttachment(staff, f.state(id, "second")),
      ).rejects.toThrow("another identity");
      await expect(
        f.app.deleteAttachment(
          { ...staff, principalId: "other-staff" },
          f.state(id, "first"),
        ),
      ).rejects.toThrow("another identity");
      f.data.delete(key);
    });
    await f.app.deleteAttachment(staff, f.state(id, "first"));
    await f.app.deleteAttachment(staff, f.state(id, "first"));
    expect(f.data.size).toBe(0);
    const history = await f.app.readTicketAuditHistory(staff, base.ticketId);
    expect(history.map((event) => event.action)).toEqual([
      "support.ticket.created",
      "support.ticket.attachment_deleting",
      "support.ticket.attachment_deleted",
    ]);
    expect(history.at(-1)!.id).toBe("first");
  });

  it("continues an expiry page after a failed attachment and reports its identity", async () => {
    const f = await fixture();
    const created = await f.app.createCustomerTicket(customer, {
      ...f.create,
      attachments: [f.input, { ...f.input, filename: "second.txt" }],
    });
    f.advance();
    f.blobs.delete.mockRejectedValueOnce(new Error("unavailable"));
    const first = await sweepExpiredAttachments({
      store: f.store,
      clock: f.clock,
      application: f.app,
      access: staff,
      limit: 100,
    });
    expect(first.deleted).toBe(1);
    expect(first.failures).toEqual([
      {
        ticketId: base.ticketId,
        messageId: base.messageId,
        attachmentId: created.messages[0]!.attachments![0]!.id,
      },
    ]);
    expect(first.physicalRows).toBe(6);
    const next = await sweepExpiredAttachments({
      store: f.store,
      clock: f.clock,
      application: f.app,
      access: staff,
      limit: 100,
    });
    expect(next.deleted).toBe(1);
    expect(next.failures).toEqual([]);
    expect(f.data.size).toBe(0);
  });

  it("rejects invalid orphan inventory before entering maintenance or touching blobs", async () => {
    const f = await fixture();
    const enteredMaintenance = vi.fn();
    const withUploadsPaused = async <T>(work: () => Promise<T>) => {
      enteredMaintenance();
      return work();
    };
    for (const candidate of [
      {
        key: `support-attachments/${crypto.randomUUID()}`,
        ticketId: "a\u0000b",
        messageId: "message",
      },
      {
        key: `support-attachments/${crypto.randomUUID()}`,
        ticketId: "ticket",
        messageId: "m".repeat(201),
      },
    ])
      await expect(
        cleanupUnreferencedAttachmentBlobs({
          store: f.store,
          blobs: f.blobs,
          candidates: [candidate],
          withUploadsPaused,
        }),
      ).rejects.toThrow(TypeError);
    expect(enteredMaintenance).not.toHaveBeenCalled();
    expect(f.blobs.delete).not.toHaveBeenCalled();
  });

  it("encodes extended filename parameters and diagnoses a missing blob port after authorization", async () => {
    const f = await fixture();
    const created = await f.app.createCustomerTicket(customer, {
      ...f.create,
      attachments: [{ ...f.input, filename: "report(1)*'.txt" }],
    });
    const state = f.state(created.messages[0]!.attachments![0]!.id);
    await f.app.recordAttachmentScanResult(staff, {
      ...state,
      verdict: "clean",
      sha256: f.input.sha256,
    });
    expect(
      (await f.app.downloadAttachment(customer, state)).contentDisposition,
    ).toContain("report%281%29%2A%27.txt");
    const missingPort = createSupportDeskApplication({
      store: f.store,
      clock: f.clock,
    });
    await expect(
      missingPort.downloadAttachment(customer, state),
    ).rejects.toThrow("Host blob port required");
    await expect(
      missingPort.downloadAttachment(
        { ...customer, principalId: "other" },
        state,
      ),
    ).rejects.toThrow("Ticket not found");
  });

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
    ).toHaveLength(13);
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
