import {
  createMemoryStore,
  type Store,
  type EntityKey,
} from "@pegma/storage-core";
import type { AccessContext } from "@pegma/authorization-core";
import { describe, expect, it, vi } from "vitest";
import {
  createSupportDeskApplication,
  SupportDeskStaleRevisionError,
  supportPermissions,
  supportRecords,
  type ResponseTargetPolicy,
} from "./index.js";

const customer: AccessContext = Object.freeze({
  principalId: "customer-lifecycle",
  policyVersion: "test-1",
  roles: [],
  entitlements: [],
  permissions: Object.freeze([
    supportPermissions.create,
    supportPermissions.readOwn,
    supportPermissions.replyOwn,
  ]),
});

const staff: AccessContext = Object.freeze({
  principalId: "staff-lifecycle",
  policyVersion: "test-1",
  roles: [],
  entitlements: [],
  permissions: Object.freeze([
    supportPermissions.queueRead,
    supportPermissions.replyAny,
    supportPermissions.note,
    supportPermissions.assign,
    supportPermissions.manage,
    supportPermissions.auditRead,
  ]),
});

const now = "2026-11-01T10:00:00.000Z";
const base = { ticketId: "ticket", correlationId: "correlation" };
const create = {
  ...base,
  commandId: "create",
  messageId: "initial",
  subject: "Question",
  body: "Hello",
};

describe("lifecycle boundary validation and conflicts", () => {
  it("recognizes a commit racing receipt detection and revision loading", async () => {
    const backing = createMemoryStore();
    const clock = { now: () => now };
    const plain = createSupportDeskApplication({ store: backing, clock });
    await plain.createCustomerTicket(customer, create);
    const command = {
      ...base,
      commandId: "raced-note",
      messageId: "raced-note",
      body: "Committed elsewhere",
      expectedRevision: 1,
    };
    let original: Awaited<ReturnType<typeof plain.addNote>> | undefined;
    let raced = false;
    const store: Store = {
      collection(definition) {
        const records = backing.collection(definition);
        return new Proxy(records, {
          get(target, property, receiver) {
            if (
              property !== "getVersioned" ||
              definition.name !== supportRecords.name
            )
              return Reflect.get(target, property, receiver);
            return async (key: EntityKey) => {
              if (!raced && key.id === "ticket") {
                raced = true;
                original = await plain.addNote(staff, command);
                await plain.addNote(staff, {
                  ...base,
                  commandId: "later",
                  messageId: "later",
                  body: "Newer edit",
                });
              }
              return target.getVersioned(key);
            };
          },
        });
      },
    };
    const app = createSupportDeskApplication({ store, clock });
    expect(await app.addNote(staff, command)).toEqual(original);
    expect((await plain.readStaffTicket(staff, "ticket")).ticket.revision).toBe(
      3,
    );
  });
  it("bounds tag configuration and input, rejecting accessors without execution", async () => {
    const store = createMemoryStore();
    const options = { store, clock: { now: () => now } };
    for (const allowedTags of [
      ["bad-tag"],
      ["a\u0000"],
      Array(33).fill("review"),
      ["a".repeat(33)],
    ]) {
      expect(() =>
        createSupportDeskApplication({ ...options, allowedTags }),
      ).toThrow(TypeError);
    }
    for (const maxTagsPerTicket of [0, 33, 1.5, NaN])
      expect(() =>
        createSupportDeskApplication({ ...options, maxTagsPerTicket }),
      ).toThrow(TypeError);
    const app = createSupportDeskApplication({
      ...options,
      allowedTags: ["review", "follow_up"],
      maxTagsPerTicket: 1,
    });
    await app.createCustomerTicket(customer, create);
    await expect(
      app.setTags(staff, {
        ...base,
        commandId: "too-many",
        tags: ["review", "follow_up"],
      }),
    ).rejects.toThrow(TypeError);
    const accessor = vi.fn(() => "review");
    const tags = ["review"];
    Object.defineProperty(tags, 0, { get: accessor });
    await expect(
      app.setTags(staff, { ...base, commandId: "accessor", tags }),
    ).rejects.toThrow(TypeError);
    expect(accessor).not.toHaveBeenCalled();
    for (const expectedRevision of [0, -1, 1.5, NaN])
      await expect(
        app.resolveTicket(staff, {
          ...base,
          commandId: "invalid-revision",
          expectedRevision,
        }),
      ).rejects.toThrow(TypeError);
    const revisionAccessor = vi.fn(() => 1);
    const command = { ...base, commandId: "accessor-revision" };
    Object.defineProperty(command, "expectedRevision", {
      get: revisionAccessor,
    });
    await expect(app.resolveTicket(staff, command)).rejects.toThrow(TypeError);
    expect(revisionAccessor).not.toHaveBeenCalled();
    expect((await app.readStaffTicket(staff, "ticket")).ticket.revision).toBe(
      1,
    );
  });

  it("validates host timestamps before commit, preserves targets without a hook, and clears omitted targets", async () => {
    const store = createMemoryStore();
    const options = { store, clock: { now: () => now } };
    const invalid = createSupportDeskApplication({
      ...options,
      responseTargetPolicy: {
        computeTargets: () => ({ firstResponseDueAt: "tomorrow" }),
      },
    });
    await expect(
      invalid.createCustomerTicket(customer, create),
    ).rejects.toThrow(TypeError);
    expect(
      (await store.collection(supportRecords).list("ticket")).some(
        (row) => row.kind === "ticket",
      ),
    ).toBe(false);
    const computeTargets = vi.fn<ResponseTargetPolicy["computeTargets"]>(
      () => ({ firstResponseDueAt: now, resolutionDueAt: now }),
    );
    const app = createSupportDeskApplication({
      ...options,
      responseTargetPolicy: { computeTargets },
    });
    await app.createCustomerTicket(customer, create);
    const plain = createSupportDeskApplication(options);
    const preserved = await plain.changePriority(staff, {
      ...base,
      commandId: "plain-priority",
      priority: "high",
    });
    expect(preserved.ticket.firstResponseDueAt).toBe(now);
    computeTargets.mockReturnValue({});
    const changed = await app.changePriority(staff, {
      ...base,
      commandId: "clear-targets",
      priority: "low",
    });
    expect(changed.ticket.firstResponseDueAt).toBeUndefined();
    expect(changed.ticket.resolutionDueAt).toBeUndefined();
    expect(changed.ticket.customerUpdatedAt).toBe(now);
    expect(computeTargets.mock.calls[0]?.[0]).not.toHaveProperty("subject");
    expect(Object.isFrozen(computeTargets.mock.calls[0]?.[0])).toBe(true);
  });

  it.each([1, 4])(
    "returns stale metadata after a real transaction conflict with %i attempts",
    async (maxConflictAttempts) => {
      const store = createMemoryStore();
      const options = { store, clock: { now: () => now } };
      const plain = createSupportDeskApplication(options);
      await plain.createCustomerTicket(customer, create);
      const computeTargets = vi.fn<ResponseTargetPolicy["computeTargets"]>(
        async () => {
          await plain.addNote(staff, {
            ...base,
            commandId: "concurrent-note",
            messageId: "note",
            body: "Concurrent edit",
          });
          return { resolutionDueAt: now };
        },
      );
      const app = createSupportDeskApplication({
        ...options,
        maxConflictAttempts,
        responseTargetPolicy: { computeTargets },
      });
      await expect(
        app.changePriority(staff, {
          ...base,
          commandId: "priority",
          priority: "high",
          expectedRevision: 1,
        }),
      ).rejects.toBeInstanceOf(SupportDeskStaleRevisionError);
      expect(computeTargets).toHaveBeenCalledTimes(1);
      expect(
        (await plain.readStaffTicket(staff, "ticket")).ticket,
      ).toMatchObject({ revision: 2, priority: "normal" });
      expect(
        await store
          .collection(supportRecords)
          .get({ partition: "ticket", id: "command:priority" }),
      ).toBeNull();
    },
  );

  it("returns the original result for every staff mutation after later messages", async () => {
    const store = createMemoryStore();
    const app = createSupportDeskApplication({
      store,
      clock: { now: () => now },
      allowedTags: ["review"],
    });
    await app.createCustomerTicket(customer, create);
    const commands = [
      () =>
        app.replyAsStaff(staff, {
          ...base,
          commandId: "reply",
          messageId: "reply",
          body: "Reply",
          expectedRevision: 1,
        }),
      () =>
        app.assignTicket(staff, {
          ...base,
          commandId: "assign",
          assigneeId: "staff",
          expectedRevision: 2,
        }),
      () =>
        app.changePriority(staff, {
          ...base,
          commandId: "priority",
          priority: "high",
          expectedRevision: 3,
        }),
      () =>
        app.setTags(staff, {
          ...base,
          commandId: "tags",
          tags: ["review"],
          expectedRevision: 4,
        }),
      () =>
        app.resolveTicket(staff, {
          ...base,
          commandId: "resolve",
          expectedRevision: 5,
        }),
      () =>
        app.closeTicket(staff, {
          ...base,
          commandId: "close",
          expectedRevision: 6,
        }),
      () =>
        app.reopenTicket(staff, {
          ...base,
          commandId: "reopen",
          expectedRevision: 7,
        }),
    ];
    const results = [];
    for (const command of commands) results.push(await command());
    await app.addNote(staff, {
      ...base,
      commandId: "later-note",
      messageId: "later-note",
      body: "Later",
    });
    for (let index = 0; index < commands.length; index += 1)
      expect(await commands[index]!()).toEqual(results[index]);
    // A host removing an allowlist after commit cannot invalidate replay.
    const reconfigured = createSupportDeskApplication({
      store,
      clock: { now: () => now },
    });
    expect(
      await reconfigured.setTags(staff, {
        ...base,
        commandId: "tags",
        tags: ["review"],
        expectedRevision: 4,
      }),
    ).toEqual(results[3]);
  });
});
