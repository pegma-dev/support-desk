import type { AccessContext } from "@pegma/authorization-core";
import { createMemoryStore, type Store } from "@pegma/storage-core";
import { describe, expect, it } from "vitest";

import {
  createInboundMailProcessor,
  createSupportDeskApplication,
  inboundEmailSystemActorId,
  inboundReceiptLocation,
  inboundReceipts,
  queueIndex,
  repairThreadIndexPage,
  supportAudit,
  supportPermissions,
  supportRecords,
  supportTicketAuditActions,
  SupportDeskConflictError,
  SupportDeskLimitError,
  SupportDeskNotFoundError,
  sweepInboundReceipts,
  sweepThreadIndexPage,
  threadIndex,
  type InboundEmailInput,
  type InboundMailProcessorOptions,
  type InboundNotificationContext,
  type InboundRoutingInput,
  type InboundSenderMatch,
  type NotificationInput,
  type SupportRecord,
} from "./index.js";

const T0 = "2026-09-01T12:00:00.000Z";
const DAY = 86_400_000;
const TOKEN = "rt_abcdefghijklmnopqrstuvwxyz0123";
const OTHER_TOKEN = "rt_zyxwvutsrqponmlkjihgfedcba9876";

function access(
  principalId: string,
  permissions: readonly string[],
): AccessContext {
  return {
    principalId,
    policyVersion: "test",
    roles: [],
    entitlements: [],
    permissions,
  };
}

const customer = access("customer-1", [
  supportPermissions.create,
  supportPermissions.readOwn,
  supportPermissions.replyOwn,
]);
const staff = access("staff-1", [
  supportPermissions.queueRead,
  supportPermissions.replyAny,
  supportPermissions.note,
  supportPermissions.assign,
  supportPermissions.manage,
  supportPermissions.auditRead,
]);

function mutableClock(start: string) {
  let current = start;
  return {
    now: () => current,
    set(value: string) {
      current = value;
    },
    advance(milliseconds: number) {
      current = new Date(Date.parse(current) + milliseconds).toISOString();
    },
  };
}

let sequence = 0;
function inbound(
  overrides: Partial<InboundEmailInput> = {},
): InboundEmailInput {
  sequence += 1;
  return {
    channelId: "support-mailbox",
    providerEventId: `provider-event-${sequence}`,
    ticketId: `inbound-ticket-${sequence}`,
    messageId: `inbound-message-${sequence}`,
    correlationId: `inbound-correlation-${sequence}`,
    from: "visitor@example.org",
    subject: "Question about pricing",
    body: "Hello, I have a question about the team plan.",
    ...overrides,
  };
}

function fixture(
  options: {
    readonly store?: Store;
    readonly matches?: Readonly<Record<string, InboundSenderMatch>>;
    readonly processor?: Partial<InboundMailProcessorOptions>;
    readonly notify?: (
      context: InboundNotificationContext,
    ) => NotificationInput | undefined;
  } = {},
) {
  const store = options.store ?? createMemoryStore();
  const clock = mutableClock(T0);
  const matcherCalls: string[] = [];
  const routingCalls: InboundRoutingInput[] = [];
  const notificationCalls: InboundNotificationContext[] = [];
  const processor = createInboundMailProcessor({
    store,
    clock,
    accountMatcher: {
      async matchSenderEmail({ email }) {
        matcherCalls.push(email);
        return options.matches?.[email.toLowerCase()] ?? { matches: "none" };
      },
    },
    routingPolicy: {
      routeNewConversation(input) {
        routingCalls.push(input);
        return {
          priority: input.association === "matched_email" ? "normal" : "low",
        };
      },
    },
    notificationPolicy: {
      notificationFor(context) {
        notificationCalls.push(context);
        return options.notify?.(context);
      },
    },
    subjectMarkerPrefix: "SD",
    supportAddresses: ["support@example.test"],
    ...options.processor,
  });
  const application = createSupportDeskApplication({ store, clock });
  return {
    store,
    clock,
    processor,
    application,
    matcherCalls,
    routingCalls,
    notificationCalls,
  };
}

async function allSupportRecords(store: Store): Promise<SupportRecord[]> {
  const records = store.collection(supportRecords);
  const found: SupportRecord[] = [];
  let cursor: string | undefined;
  do {
    const page = await records.scan({
      limit: 100,
      ...(cursor === undefined ? {} : { cursor }),
    });
    found.push(...page.records.map((entry) => entry.value));
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return found;
}

async function ticketCount(store: Store): Promise<number> {
  return (await allSupportRecords(store)).filter(
    (record) => record.kind === "ticket",
  ).length;
}

async function storedTicket(store: Store, ticketId: string) {
  const record = await store
    .collection(supportRecords)
    .get({ partition: ticketId, id: "ticket" });
  if (record?.kind !== "ticket") {
    throw new Error(`ticket ${ticketId} missing`);
  }
  return record.ticket;
}

async function receiptFor(store: Store, input: InboundEmailInput) {
  const location = await inboundReceiptLocation(
    input.channelId,
    input.providerEventId,
  );
  return store
    .collection(inboundReceipts)
    .get({ partition: location.bucket, id: `slot:${location.slot}` });
}

/** Authenticated web ticket whose confirmation mail carries a reply token. */
async function webTicket(
  f: ReturnType<typeof fixture>,
  options: {
    readonly ticketId?: string;
    readonly requesterEmail?: string | null;
    readonly token?: string;
  } = {},
) {
  const ticketId = options.ticketId ?? "web-ticket";
  return f.application.createCustomerTicket(customer, {
    commandId: `${ticketId}-create`,
    correlationId: `${ticketId}-correlation`,
    ticketId,
    messageId: `${ticketId}-message`,
    subject: "Export fails",
    body: "The export button is disabled.",
    ...(options.requesterEmail === null
      ? {}
      : { requesterEmail: options.requesterEmail ?? "customer@example.org" }),
    notification: {
      id: `${ticketId}-notification`,
      recipientRef: "customer-recipient",
      templateId: "customer.created",
      templateVersion: 1,
      variables: {},
      subject: "[SD-{{ticket_number}}] Export fails",
      outboundMessageId: `<created.${ticketId}@support.example.test>`,
      replyRoutingToken: options.token ?? TOKEN,
    },
  });
}

describe("inbound mail: new conversations", () => {
  it("routes an unknown sender to a low-priority unverified email ticket", async () => {
    const f = fixture();
    const input = inbound({
      externalMessageId: "<first.visitor@mail.example.org>",
      fromName: "Pat Visitor",
    });

    const result = await f.processor.processInboundEmail(input);

    expect(result).toMatchObject({
      duplicateDelivery: false,
      outcome: "created",
      ticketId: input.ticketId,
      messageId: input.messageId,
      matchMethod: "none",
      association: "unverified",
    });
    const ticket = await storedTicket(f.store, input.ticketId);
    expect(ticket).toMatchObject({
      channel: "email",
      status: "open",
      priority: "low",
      number: 1,
      requester: {
        association: "unverified",
        email: "visitor@example.org",
        displayName: "Pat Visitor",
      },
    });
    expect(ticket.requester.principalId).toBeUndefined();
    expect(f.routingCalls).toEqual([
      { channelId: "support-mailbox", association: "unverified" },
    ]);

    const view = await f.application.readStaffTicket(staff, input.ticketId);
    expect(view.messages).toEqual([
      expect.objectContaining({
        id: input.messageId,
        authorKind: "customer",
        channel: "email",
        visibility: "customer",
        format: "plain_text",
        externalMessageId: "<first.visitor@mail.example.org>",
      }),
    ]);
    expect(view.messages[0]?.authorPrincipalId).toBeUndefined();

    const history = await supportAudit.history(
      f.store.collection(supportRecords),
      input.ticketId,
    );
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      action: supportTicketAuditActions.created,
      actor: { kind: "system", systemId: inboundEmailSystemActorId },
      sequence: 1,
      details: { matchMethod: "none", association: "unverified" },
    });
    expect(JSON.stringify(history)).not.toContain("visitor@example.org");

    const queue = await f.application.listStaffQueue(staff, {
      association: "unverified",
    });
    expect(queue.items.map((item) => item.ticketId)).toEqual([input.ticketId]);
    expect(queue.items[0]).toMatchObject({ channel: "email", priority: "low" });

    expect(await receiptFor(f.store, input)).toMatchObject({
      status: "processed",
      outcome: "created",
      ticketId: input.ticketId,
      messageId: input.messageId,
    });
  });

  it("associates a unique account match as matched_email without granting web access", async () => {
    const f = fixture({
      matches: {
        "customer@example.org": { matches: "one", principalId: "customer-1" },
      },
    });
    const input = inbound({ from: "Customer@Example.ORG" });

    const result = await f.processor.processInboundEmail(input);

    expect(result).toMatchObject({
      outcome: "created",
      association: "matched_email",
    });
    expect(f.matcherCalls).toEqual(["Customer@example.org"]);
    expect(f.routingCalls).toEqual([
      {
        channelId: "support-mailbox",
        association: "matched_email",
        principalId: "customer-1",
      },
    ]);
    const ticket = await storedTicket(f.store, input.ticketId);
    expect(ticket.priority).toBe("normal");
    expect(ticket.requester).toEqual({
      association: "matched_email",
      principalId: "customer-1",
      email: "Customer@example.org",
    });

    // Matching assists routing only: the account cannot read or list it.
    await expect(
      f.application.readCustomerTicket(customer, input.ticketId),
    ).rejects.toBeInstanceOf(SupportDeskNotFoundError);
    expect(await f.application.listCustomerTickets(customer)).toEqual([]);
    await expect(
      f.application.replyToCustomerTicket(customer, {
        commandId: "web-reply",
        correlationId: "web-reply",
        ticketId: input.ticketId,
        messageId: "web-reply",
        body: "Trying to reply from the web.",
      }),
    ).rejects.toBeInstanceOf(SupportDeskNotFoundError);
  });

  it("treats multiple account matches as unverified instead of guessing", async () => {
    const f = fixture({
      matches: { "shared@example.org": { matches: "many" } },
    });
    const input = inbound({ from: "shared@example.org" });

    const result = await f.processor.processInboundEmail(input);

    expect(result.association).toBe("unverified");
    const ticket = await storedTicket(f.store, input.ticketId);
    expect(ticket.requester.association).toBe("unverified");
    expect(ticket.requester.principalId).toBeUndefined();
    expect(ticket.priority).toBe("low");
  });

  it("ignores browser-shaped identity or priority fields on the input", async () => {
    const f = fixture();
    const input = {
      ...inbound(),
      principalId: "attacker",
      priority: "urgent",
      association: "authenticated",
    } as unknown as InboundEmailInput;

    await f.processor.processInboundEmail(input);

    const ticket = await storedTicket(f.store, input.ticketId);
    expect(ticket.requester.association).toBe("unverified");
    expect(ticket.requester.principalId).toBeUndefined();
    expect(ticket.priority).toBe("low");
  });

  it("refuses an automatic urgent priority or an unconfigured category from host policy", async () => {
    const urgent = fixture({
      processor: {
        routingPolicy: {
          routeNewConversation: () =>
            ({ priority: "urgent" }) as unknown as { priority: "high" },
        },
      },
    });
    await expect(
      urgent.processor.processInboundEmail(inbound()),
    ).rejects.toThrow(/never automatically urgent/);
    expect(await ticketCount(urgent.store)).toBe(0);

    const category = fixture({
      processor: {
        allowedCategories: ["billing"],
        routingPolicy: {
          routeNewConversation: () => ({
            priority: "normal",
            category: "unknown",
          }),
        },
      },
    });
    await expect(
      category.processor.processInboundEmail(inbound()),
    ).rejects.toThrow(/not configured/);

    const allowed = fixture({
      processor: {
        allowedCategories: ["billing"],
        routingPolicy: {
          routeNewConversation: () => ({
            priority: "high",
            category: "billing",
          }),
        },
      },
    });
    const input = inbound();
    await allowed.processor.processInboundEmail(input);
    expect(await storedTicket(allowed.store, input.ticketId)).toMatchObject({
      priority: "high",
      category: "billing",
    });
  });

  it("rejects malformed account-matcher results", async () => {
    const f = fixture({
      processor: {
        accountMatcher: {
          matchSenderEmail: async () =>
            ({ matches: "one" }) as unknown as InboundSenderMatch,
        },
      },
    });
    await expect(f.processor.processInboundEmail(inbound())).rejects.toThrow(
      TypeError,
    );
    expect(await ticketCount(f.store)).toBe(0);
  });

  it("normalizes hostile content and bounds the subject before persistence", async () => {
    const f = fixture({ processor: { limits: { maxSubjectCharacters: 20 } } });
    const input = inbound({
      subject: "Help\u0000\u001b[31m now\r\n please, this is long",
      body: "<script>alert(1)</script>\r\nline two\u0000\u0007\r\nend",
      fromName: "  Name\u0000With\nControls  ",
    });

    await f.processor.processInboundEmail(input);

    const ticket = await storedTicket(f.store, input.ticketId);
    expect(ticket.subject).toBe("Help [31m now please");
    expect(ticket.requester.displayName).toBe("Name With Controls");
    const view = await f.application.readStaffTicket(staff, input.ticketId);
    // Stored as inert plain text; rendering escapes it by output context.
    expect(view.messages[0]?.body).toBe(
      "<script>alert(1)</script>\nline two\nend",
    );
    expect(view.messages[0]?.format).toBe("plain_text");
  });

  it("enforces the body limit before reserving a receipt", async () => {
    const f = fixture({ processor: { limits: { maxMessageCharacters: 10 } } });
    const input = inbound({ body: "x".repeat(11) });

    await expect(f.processor.processInboundEmail(input)).rejects.toBeInstanceOf(
      SupportDeskLimitError,
    );
    expect(await receiptFor(f.store, input)).toBeNull();
    await expect(
      f.processor.processInboundEmail(inbound({ body: "   " })),
    ).rejects.toThrow(TypeError);
  });

  it("drops malformed threading identifiers instead of storing them", async () => {
    const f = fixture();
    const input = inbound({
      externalMessageId: "not-a-message-id",
      inReplyTo: "<bad\u0000id@example.org>",
      references: ["<ok@example.org>", 42 as unknown as string],
      replyRoutingToken: "short",
    });
    await f.processor.processInboundEmail(input);
    const view = await f.application.readStaffTicket(staff, input.ticketId);
    expect(view.messages[0]?.externalMessageId).toBeUndefined();
    expect(view.messages[0]?.inReplyToExternalMessageId).toBeUndefined();
  });
});

describe("inbound mail: deduplication and idempotency", () => {
  it("returns the first result for duplicate provider deliveries", async () => {
    const f = fixture();
    const first = inbound();
    const firstResult = await f.processor.processInboundEmail(first);

    const retry = {
      ...first,
      ticketId: "retry-ticket",
      messageId: "retry-message",
      correlationId: "retry-correlation",
    };
    const retryResult = await f.processor.processInboundEmail(retry);

    expect(retryResult).toEqual({ ...firstResult, duplicateDelivery: true });
    expect(await ticketCount(f.store)).toBe(1);
    const records = await f.store
      .collection(supportRecords)
      .list(first.ticketId);
    expect(records.filter((record) => record.kind === "message")).toHaveLength(
      1,
    );
    expect(records.filter((record) => record.kind === "audit")).toHaveLength(1);
    expect(f.routingCalls).toHaveLength(1);
  });

  it("rejects a provider event ID reused for different content", async () => {
    const f = fixture();
    const first = inbound();
    await f.processor.processInboundEmail(first);
    await expect(
      f.processor.processInboundEmail({
        ...first,
        body: "A different message entirely.",
      }),
    ).rejects.toThrow(
      "An inbound provider event ID was reused for different content",
    );
    expect(await ticketCount(f.store)).toBe(1);
  });

  it("stores canonical receipt timestamps and rejects noncanonical clocks before insertion", async () => {
    const f = fixture();
    const first = inbound();
    await f.processor.processInboundEmail(first);
    expect(await receiptFor(f.store, first)).toMatchObject({
      receivedAt: T0,
      processedAt: T0,
    });

    f.clock.set("2026-09-01T12:00:00+00:00");
    const invalid = inbound();
    await expect(f.processor.processInboundEmail(invalid)).rejects.toThrow(
      "clock.now() must be a canonical ISO timestamp",
    );
    expect(await receiptFor(f.store, invalid)).toBeNull();
  });

  for (const operation of ["create", "reply"] as const) {
    it(`resumes ${operation} after ticket contention without dropping or duplicating mail`, async () => {
      const backing = createMemoryStore();
      let rejectTransactions = false;
      let rejectedAttempts = 0;
      const store: Store = {
        collection(definition) {
          const collection = backing.collection(definition);
          if (definition.name !== supportRecords.name) {
            return collection;
          }
          return {
            ...collection,
            async transact(partition, actions) {
              if (rejectTransactions) {
                rejectedAttempts += 1;
                return {
                  committed: false,
                  reason: operation === "create" ? "exists" : "changed",
                };
              }
              return collection.transact(partition, actions);
            },
          };
        },
      };
      const f = fixture({ store, processor: { maxConflictAttempts: 2 } });
      if (operation === "reply") {
        await webTicket(f);
      }
      const input = inbound({
        from: "customer@example.org",
        ...(operation === "reply" ? { replyRoutingToken: TOKEN } : {}),
      });
      rejectTransactions = true;
      await expect(
        f.processor.processInboundEmail(input),
      ).rejects.toMatchObject({
        name: "SupportDeskConflictError",
        message:
          "Concurrent ticket updates exhausted retries; the provider may retry the same event. The inbound receipt remains processing and is safe to resume.",
      });
      expect(rejectedAttempts).toBe(operation === "reply" ? 2 : 1);
      expect(await receiptFor(backing, input)).toMatchObject({
        status: "processing",
      });

      rejectTransactions = false;
      const ticketId = operation === "reply" ? "web-ticket" : input.ticketId;
      const result = await f.processor.processInboundEmail(input);
      expect(result).toMatchObject({
        outcome: operation === "reply" ? "replied" : "created",
        duplicateDelivery: true,
        ticketId,
        messageId: input.messageId,
      });
      expect(await f.processor.processInboundEmail(input)).toEqual(result);
      expect(await receiptFor(backing, input)).toMatchObject({
        status: "processed",
      });
      const view = await f.application.readStaffTicket(staff, ticketId);
      expect(view.messages).toHaveLength(operation === "reply" ? 2 : 1);
      expect(await ticketCount(backing)).toBe(1);
    });
  }

  it("resumes the reserved identifiers after a crash before the ticket commit", async () => {
    const backing = createMemoryStore();
    let failTransactions = 1;
    const store: Store = {
      collection(definition) {
        const collection = backing.collection(definition);
        if (definition.name !== supportRecords.name) {
          return collection;
        }
        return {
          ...collection,
          async transact(partition, actions) {
            if (failTransactions > 0) {
              failTransactions -= 1;
              throw new Error("injected store outage");
            }
            return collection.transact(partition, actions);
          },
        };
      },
    };
    const f = fixture({ store });
    const first = inbound();
    await expect(f.processor.processInboundEmail(first)).rejects.toThrow(
      "injected store outage",
    );
    expect(await receiptFor(backing, first)).toMatchObject({
      status: "processing",
      reservedTicketId: first.ticketId,
      route: { kind: "new_conversation" },
    });

    const result = await f.processor.processInboundEmail({
      ...first,
      ticketId: "retry-ticket",
      messageId: "retry-message",
      correlationId: "retry-correlation",
    });

    expect(result).toMatchObject({
      duplicateDelivery: true,
      outcome: "created",
      ticketId: first.ticketId,
      messageId: first.messageId,
    });
    expect(await ticketCount(backing)).toBe(1);
    // The routing decision was persisted once and not re-asked.
    expect(f.routingCalls).toHaveLength(1);
  });

  it("finalizes the receipt after a crash between the ticket commit and receipt update", async () => {
    const backing = createMemoryStore();
    let failFinalize = true;
    const store: Store = {
      collection(definition) {
        const collection = backing.collection(definition);
        if (definition.name !== inboundReceipts.name) {
          return collection;
        }
        return {
          ...collection,
          async update(key, decide, options) {
            const current = await collection.get(key);
            const route = (current as { readonly route?: unknown } | null)
              ?.route;
            if (failFinalize && route !== undefined) {
              failFinalize = false;
              throw new Error("injected crash after commit");
            }
            return collection.update(key, decide, options);
          },
        };
      },
    };
    const f = fixture({ store });
    const first = inbound();
    await expect(f.processor.processInboundEmail(first)).rejects.toThrow(
      "injected crash after commit",
    );
    expect(await ticketCount(backing)).toBe(1);

    const result = await f.processor.processInboundEmail(first);
    expect(result).toMatchObject({
      outcome: "created",
      ticketId: first.ticketId,
    });
    expect(await ticketCount(backing)).toBe(1);
    const records = await backing
      .collection(supportRecords)
      .list(first.ticketId);
    expect(records.filter((record) => record.kind === "message")).toHaveLength(
      1,
    );
  });

  it("creates one ticket when the same provider event is processed concurrently", async () => {
    const f = fixture();
    const input = inbound();
    const results = await Promise.all([
      f.processor.processInboundEmail(input),
      f.processor.processInboundEmail({
        ...input,
        ticketId: "parallel-ticket",
        messageId: "parallel-message",
      }),
      f.processor.processInboundEmail({
        ...input,
        ticketId: "parallel-ticket-2",
        messageId: "parallel-message-2",
      }),
    ]);
    expect(new Set(results.map((result) => result.ticketId))).toEqual(
      new Set([input.ticketId]),
    );
    expect(await ticketCount(f.store)).toBe(1);
  });

  it("treats the same Message-ID under a new provider event as one message", async () => {
    const f = fixture();
    const first = inbound({ externalMessageId: "<same@mail.example.org>" });
    await f.processor.processInboundEmail(first);

    const second = await f.processor.processInboundEmail(
      inbound({
        externalMessageId: "<same@mail.example.org>",
        body: first.body,
      }),
    );

    expect(second).toMatchObject({
      duplicateDelivery: false,
      outcome: "duplicate_message",
      ticketId: first.ticketId,
      messageId: first.messageId,
    });
    expect(await ticketCount(f.store)).toBe(1);
  });

  it("does not collapse a reused Message-ID into a ticket without a requester email", async () => {
    const f = fixture();
    await webTicket(f, { requesterEmail: null });
    const externalMessageId = "<anonymous@mail.example.org>";
    const first = inbound({
      from: "first@example.org",
      replyRoutingToken: TOKEN,
      externalMessageId,
    });
    expect(await f.processor.processInboundEmail(first)).toMatchObject({
      outcome: "replied",
      ticketId: "web-ticket",
    });
    expect(
      (await storedTicket(f.store, "web-ticket")).requester.email,
    ).toBeUndefined();

    const reused = inbound({
      from: "different@example.net",
      externalMessageId,
      inReplyTo: "<created.web-ticket@support.example.test>",
    });
    expect(await f.processor.processInboundEmail(reused)).toMatchObject({
      outcome: "created",
      ticketId: reused.ticketId,
      association: "unverified",
      relatedTicketId: "web-ticket",
    });
    const original = await f.application.readStaffTicket(staff, "web-ticket");
    expect(original.messages).toHaveLength(2);
    expect(await ticketCount(f.store)).toBe(2);
  });

  it("keeps receipt sweeping away from processing receipts", async () => {
    const backing = createMemoryStore();
    const store: Store = {
      collection(definition) {
        const collection = backing.collection(definition);
        if (definition.name !== supportRecords.name) {
          return collection;
        }
        return {
          ...collection,
          async transact() {
            throw new Error("process stopped");
          },
        };
      },
    };
    const f = fixture({ store });
    const stuck = inbound();
    await expect(f.processor.processInboundEmail(stuck)).rejects.toThrow();
    const healthy = fixture({ store: backing });
    const done = inbound({ channelId: stuck.channelId });
    await healthy.processor.processInboundEmail(done);

    const later = {
      now: () => new Date(Date.parse(T0) + 90 * DAY).toISOString(),
    };
    for (const input of [stuck, done]) {
      const location = await inboundReceiptLocation(
        input.channelId,
        input.providerEventId,
      );
      await sweepInboundReceipts(backing, later, {
        bucket: location.bucket,
        processedBefore: later.now(),
      });
    }
    expect((await receiptFor(backing, stuck))?.status).toBe("processing");
    expect(await receiptFor(backing, done)).toBeNull();
  });
});

describe("inbound mail: replies and threading", () => {
  it("joins the original ticket by opaque routing token and reopens a resolved ticket", async () => {
    const f = fixture();
    await webTicket(f);
    f.clock.advance(60_000);
    await f.application.resolveTicket(staff, {
      commandId: "resolve",
      correlationId: "resolve",
      ticketId: "web-ticket",
    });
    f.clock.advance(60_000);

    const result = await f.processor.processInboundEmail(
      inbound({
        from: "customer@example.org",
        subject: "Re: Export fails",
        body: "It broke again.",
        replyRoutingToken: TOKEN,
      }),
    );

    expect(result).toMatchObject({
      outcome: "replied",
      ticketId: "web-ticket",
      matchMethod: "routing_token",
    });
    const ticket = await storedTicket(f.store, "web-ticket");
    expect(ticket.status).toBe("waiting_on_support");
    expect(ticket.resolvedAt).toBeUndefined();
    expect(ticket.revision).toBe(3);
    const view = await f.application.readCustomerTicket(customer, "web-ticket");
    // One conversation across web and email.
    expect(
      view.messages.map((message) => [message.channel, message.body]),
    ).toEqual([
      ["web", "The export button is disabled."],
      ["email", "It broke again."],
    ]);
    const history = await supportAudit.history(
      f.store.collection(supportRecords),
      "web-ticket",
    );
    expect(history.at(-1)).toMatchObject({
      action: supportTicketAuditActions.customerReplied,
      actor: { kind: "system", systemId: inboundEmailSystemActorId },
      details: { matchMethod: "routing_token" },
    });
    expect(f.matcherCalls).toEqual([]);
  });

  it("joins by In-Reply-To through the outbound Message-ID index", async () => {
    const f = fixture();
    await webTicket(f);
    await f.application.replyAsStaff(staff, {
      commandId: "staff-reply",
      correlationId: "staff-reply",
      ticketId: "web-ticket",
      messageId: "staff-message",
      body: "Could you share a screenshot?",
      notification: {
        id: "staff-notification",
        recipientRef: "customer-recipient",
        templateId: "customer.staff-reply",
        templateVersion: 1,
        variables: {},
        subject: "[SD-1] Export fails",
        outboundMessageId: "<staff-reply.web-ticket@support.example.test>",
      },
    });

    const result = await f.processor.processInboundEmail(
      inbound({
        from: "customer@example.org",
        subject: "Re: your reply",
        inReplyTo: "<staff-reply.web-ticket@support.example.test>",
      }),
    );
    expect(result).toMatchObject({
      outcome: "replied",
      ticketId: "web-ticket",
      matchMethod: "message_id",
    });
    expect((await storedTicket(f.store, "web-ticket")).status).toBe(
      "waiting_on_support",
    );
  });

  it("joins by References when In-Reply-To is unknown", async () => {
    const f = fixture();
    await webTicket(f);
    const result = await f.processor.processInboundEmail(
      inbound({
        from: "customer@example.org",
        inReplyTo: "<unknown@elsewhere.example.org>",
        references: [
          "<created.web-ticket@support.example.test>",
          "<unknown@elsewhere.example.org>",
        ],
      }),
    );
    expect(result).toMatchObject({
      outcome: "replied",
      ticketId: "web-ticket",
      matchMethod: "message_id",
    });
  });

  it("threads a follow-up that references the sender's own earlier message", async () => {
    const f = fixture();
    const first = inbound({ externalMessageId: "<one@mail.example.org>" });
    await f.processor.processInboundEmail(first);
    const followUp = await f.processor.processInboundEmail(
      inbound({
        externalMessageId: "<two@mail.example.org>",
        inReplyTo: "<one@mail.example.org>",
        body: "Adding more detail.",
      }),
    );
    expect(followUp).toMatchObject({
      outcome: "replied",
      ticketId: first.ticketId,
      matchMethod: "message_id",
    });
    expect(await ticketCount(f.store)).toBe(1);
  });

  it("uses a well-formed subject marker only as a fallback from the requester address", async () => {
    const f = fixture();
    await webTicket(f);

    const fallback = await f.processor.processInboundEmail(
      inbound({
        from: "customer@example.org",
        subject: "Re: [SD-1] Export fails",
      }),
    );
    expect(fallback).toMatchObject({
      outcome: "replied",
      ticketId: "web-ticket",
      matchMethod: "subject_marker",
    });

    // A ticket number is not a capability: another sender gets a new
    // unverified ticket that only links the possible relationship.
    const stranger = inbound({
      from: "stranger@example.net",
      subject: "Re: [SD-1] Export fails",
      body: "Let me into this ticket.",
    });
    const strangerResult = await f.processor.processInboundEmail(stranger);
    expect(strangerResult).toMatchObject({
      outcome: "created",
      ticketId: stranger.ticketId,
      association: "unverified",
      matchMethod: "subject_marker",
      relatedTicketId: "web-ticket",
    });
    const strangerTicket = await storedTicket(f.store, stranger.ticketId);
    expect(strangerTicket.relatedTicketId).toBe("web-ticket");
    expect(strangerTicket.priority).toBe("low");
    const original = await f.application.readStaffTicket(staff, "web-ticket");
    expect(original.messages.map((message) => message.body)).not.toContain(
      "Let me into this ticket.",
    );
  });

  it("keeps relatedTicketId in staff views and out of customer DTOs", async () => {
    const f = fixture();
    await webTicket(f);
    const input = inbound({ subject: "Re: [SD-1] Export fails" });
    await f.processor.processInboundEmail(input);
    const staffView = await f.application.readStaffTicket(
      staff,
      input.ticketId,
    );
    expect(staffView.ticket).toMatchObject({
      requester: { association: "unverified" },
      relatedTicketId: "web-ticket",
    });
    await expect(
      f.application.readCustomerTicket(customer, input.ticketId),
    ).rejects.toBeInstanceOf(SupportDeskNotFoundError);

    // Test-only ownership fixture exercises the customer whitelist on the
    // same record carrying the hint. Inbound mail never authenticates anyone.
    await f.store
      .collection(supportRecords)
      .update({ partition: input.ticketId, id: "ticket" }, (current) => {
        if (current?.kind !== "ticket") {
          throw new Error("inbound ticket missing");
        }
        return {
          action: "write",
          value: {
            ...current,
            ticket: {
              ...current.ticket,
              requester: {
                ...current.ticket.requester,
                association: "authenticated",
                principalId: customer.principalId,
              },
            },
          },
        };
      });
    const customerView = await f.application.readCustomerTicket(
      customer,
      input.ticketId,
    );
    expect(customerView.ticket.id).toBe(input.ticketId);
    expect(customerView.ticket).not.toHaveProperty("relatedTicketId");
    expect(JSON.stringify(customerView)).not.toContain("relatedTicketId");
    expect(
      (await f.application.readStaffTicket(staff, input.ticketId)).ticket
        .relatedTicketId,
    ).toBe("web-ticket");
  });

  it("ignores subject markers that are malformed, ambiguous, or unconfigured", async () => {
    const f = fixture();
    await webTicket(f);
    await webTicket(f, { ticketId: "web-ticket-2", token: OTHER_TOKEN });
    for (const subject of [
      "Re: [SD-01] leading zero",
      "Re: [SD-1] and [SD-2] both",
      "Re: [OTHER-1] another instance",
      "Re: SD-1 without brackets",
    ]) {
      const input = inbound({ from: "customer@example.org", subject });
      expect(await f.processor.processInboundEmail(input)).toMatchObject({
        outcome: "created",
        ticketId: input.ticketId,
      });
    }

    const unconfigured = fixture({
      processor: {
        subjectMarkerPrefix: undefined,
      } as unknown as Partial<InboundMailProcessorOptions>,
    });
    await webTicket(unconfigured);
    expect(
      await unconfigured.processor.processInboundEmail(
        inbound({ from: "customer@example.org", subject: "Re: [SD-1]" }),
      ),
    ).toMatchObject({ outcome: "created", matchMethod: "none" });
  });

  it("does not join on a routing token when the sender differs from the requester", async () => {
    const f = fixture();
    await webTicket(f);
    const forwarded = inbound({
      from: "colleague@example.org",
      replyRoutingToken: TOKEN,
    });
    const result = await f.processor.processInboundEmail(forwarded);
    expect(result).toMatchObject({
      outcome: "created",
      association: "unverified",
      matchMethod: "routing_token",
      relatedTicketId: "web-ticket",
    });
  });

  it("joins without a recorded requester address only through a routing token", async () => {
    const f = fixture();
    await webTicket(f, { requesterEmail: null });

    const byHeader = await f.processor.processInboundEmail(
      inbound({
        from: "someone@example.org",
        inReplyTo: "<created.web-ticket@support.example.test>",
      }),
    );
    expect(byHeader).toMatchObject({
      outcome: "created",
      relatedTicketId: "web-ticket",
    });

    const byToken = await f.processor.processInboundEmail(
      inbound({ from: "someone@example.org", replyRoutingToken: TOKEN }),
    );
    expect(byToken).toMatchObject({
      outcome: "replied",
      ticketId: "web-ticket",
    });
  });

  it("opens a new linked ticket when threading headers name different tickets", async () => {
    const f = fixture();
    await webTicket(f);
    await webTicket(f, { ticketId: "web-ticket-2", token: OTHER_TOKEN });
    const input = inbound({
      from: "customer@example.org",
      inReplyTo: "<created.web-ticket@support.example.test>",
      references: ["<created.web-ticket-2@support.example.test>"],
    });
    expect(await f.processor.processInboundEmail(input)).toMatchObject({
      outcome: "created",
      ticketId: input.ticketId,
      relatedTicketId: "web-ticket",
    });
  });

  it("stops honoring routing tokens and Message-IDs after the retention window", async () => {
    const f = fixture({
      processor: { threadIndexRetentionMilliseconds: 10 * DAY },
    });
    await webTicket(f);
    f.clock.advance(11 * DAY);
    const result = await f.processor.processInboundEmail(
      inbound({
        from: "customer@example.org",
        replyRoutingToken: TOKEN,
        inReplyTo: "<created.web-ticket@support.example.test>",
      }),
    );
    expect(result).toMatchObject({ outcome: "created", matchMethod: "none" });
  });

  it("rejects a reply once the ticket message cap is reached without writing", async () => {
    const f = fixture({ processor: { limits: { maxMessagesPerTicket: 2 } } });
    await webTicket(f);
    const accepted = await f.processor.processInboundEmail(
      inbound({ from: "customer@example.org", replyRoutingToken: TOKEN }),
    );
    expect(accepted.outcome).toBe("replied");
    const capped = inbound({
      from: "customer@example.org",
      replyRoutingToken: TOKEN,
      body: "One too many.",
    });
    const refused = await f.processor.processInboundEmail(capped);
    expect(refused).toMatchObject({
      outcome: "rejected",
      reason: "ticket_messages_limit",
    });
    expect(refused.messageId).toBeUndefined();
    expect(await f.processor.processInboundEmail(capped)).toEqual({
      ...refused,
      duplicateDelivery: true,
    });
    const view = await f.application.readStaffTicket(staff, "web-ticket");
    expect(view.messages).toHaveLength(2);
  });

  it("keeps concurrent replies to one ticket conflict-safe", async () => {
    const f = fixture({ processor: { maxConflictAttempts: 10 } });
    await webTicket(f);
    const replies = Array.from({ length: 4 }, (_, position) =>
      inbound({
        from: "customer@example.org",
        replyRoutingToken: TOKEN,
        body: `Concurrent reply ${position}`,
      }),
    );
    const results = await Promise.all(
      replies.map((input) => f.processor.processInboundEmail(input)),
    );
    expect(results.every((result) => result.outcome === "replied")).toBe(true);
    const view = await f.application.readStaffTicket(staff, "web-ticket");
    expect(view.messages).toHaveLength(5);
    expect(view.ticket.revision).toBe(5);
  });
});

describe("inbound mail: loop and bounce controls", () => {
  const cases: readonly [string, Partial<InboundEmailInput>, string][] = [
    [
      "Auto-Submitted",
      { loopSignals: { autoSubmitted: "auto-replied" } },
      "auto_submitted",
    ],
    ["Precedence", { loopSignals: { precedence: "Bulk" } }, "precedence"],
    [
      "X-Autoreply",
      { loopSignals: { autoReplyHeaderPresent: true } },
      "auto_reply_header",
    ],
    [
      "null envelope sender",
      { loopSignals: { envelopeSender: "<>" } },
      "bounce",
    ],
    [
      "mailer-daemon sender",
      { from: "MAILER-DAEMON@mx.example.org" },
      "bounce",
    ],
    [
      "delivery status report",
      {
        loopSignals: {
          contentType: "multipart/report; report-type=delivery-status",
        },
      },
      "delivery_report",
    ],
    [
      "own support address",
      { from: "Support@example.test" },
      "support_address_loop",
    ],
  ];

  for (const [name, overrides, reason] of cases) {
    it(`suppresses ${name} without creating a customer-visible message`, async () => {
      const f = fixture({
        notify: () => {
          throw new Error("must not notify");
        },
      });
      await webTicket(f);
      const input = inbound({
        from: "customer@example.org",
        replyRoutingToken: TOKEN,
        ...overrides,
      });
      const result = await f.processor.processInboundEmail(input);
      expect(result).toMatchObject({ outcome: "suppressed", reason });
      expect(result.ticketId).toBeUndefined();
      expect(await ticketCount(f.store)).toBe(1);
      const view = await f.application.readStaffTicket(staff, "web-ticket");
      expect(view.messages).toHaveLength(1);
      expect(f.notificationCalls).toHaveLength(0);
      expect(await receiptFor(f.store, input)).toMatchObject({
        status: "rejected",
        outcome: "suppressed",
        diagnostic: reason,
      });
      expect(await f.processor.processInboundEmail(input)).toMatchObject({
        duplicateDelivery: true,
        outcome: "suppressed",
      });
    });
  }

  it("keeps Auto-Submitted: no and forbids sender acknowledgements on suppress requests", async () => {
    const f = fixture();
    await f.processor.processInboundEmail(
      inbound({ loopSignals: { autoSubmitted: "no" } }),
    );
    await f.processor.processInboundEmail(
      inbound({ loopSignals: { autoResponseSuppress: "DR, OOF" } }),
    );
    await f.processor.processInboundEmail(
      inbound({ loopSignals: { listId: "<team.lists.example.org>" } }),
    );
    expect(await ticketCount(f.store)).toBe(3);
    expect(
      f.notificationCalls.map((call) => call.senderAcknowledgementAllowed),
    ).toEqual([true, false, false]);
  });
});

describe("inbound mail: notifications and threading index", () => {
  function staffAlert(context: InboundNotificationContext): NotificationInput {
    return {
      id: `alert-${context.messageId}`,
      recipientRef: "support-queue",
      templateId: "staff.inbound",
      templateVersion: 1,
      variables: {},
      subject: `[SD-{{ticket_number}}] New ${context.outcome} mail`,
      outboundMessageId: `<alert.${context.messageId}@support.example.test>`,
    };
  }

  it("commits an optional notification in the inbound ticket transaction", async () => {
    const f = fixture({ notify: staffAlert });
    const input = inbound();
    await f.processor.processInboundEmail(input);

    expect(f.notificationCalls).toEqual([
      expect.objectContaining({
        outcome: "created",
        ticketId: input.ticketId,
        ticketNumber: 1,
        association: "unverified",
        senderAcknowledgementAllowed: true,
      }),
    ]);
    const records = await f.store
      .collection(supportRecords)
      .list(input.ticketId);
    const job = records.find((record) => record.kind === "delivery_job");
    expect(job).toMatchObject({ messageId: input.messageId });
    const message = records.find((record) => record.kind === "message");
    expect(
      message?.kind === "message" && message.deliveryContent?.subject,
    ).toBe("[SD-1] New created mail");
  });

  it("indexes outbound and inbound identifiers by hash without storing the token", async () => {
    const f = fixture();
    await webTicket(f);
    const rows = await f.store.collection(threadIndex).scan({ limit: 100 });
    const kinds = rows.records.map((entry) => entry.value.kind).sort();
    expect(kinds).toEqual(["message_id", "reply_token", "ticket_number"]);
    expect(JSON.stringify(rows.records)).not.toContain(TOKEN);
    for (const entry of rows.records) {
      expect(entry.key.partition).toBe(entry.value.key);
      expect(entry.value.key).toMatch(
        /^(mid:[0-9a-f]{64}|rt:[0-9a-f]{64}|number:1)$/,
      );
    }
  });

  it("repairs missed threading writes and sweeps rows past retention", async () => {
    const f = fixture();
    await webTicket(f);
    const index = f.store.collection(threadIndex);
    const before = await index.scan({ limit: 100 });
    for (const entry of before.records) {
      await index.delete(entry.key);
    }
    expect(
      (
        await f.processor.processInboundEmail(
          inbound({ from: "customer@example.org", replyRoutingToken: TOKEN }),
        )
      ).outcome,
    ).toBe("created");

    let cursor: string | undefined;
    do {
      const page = await repairThreadIndexPage({
        store: f.store,
        clock: f.clock,
        threadIndexRetentionMilliseconds: 30 * DAY,
        limit: 2,
        ...(cursor === undefined ? {} : { cursor }),
      });
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);

    expect(
      await f.processor.processInboundEmail(
        inbound({ from: "customer@example.org", replyRoutingToken: TOKEN }),
      ),
    ).toMatchObject({ outcome: "replied", ticketId: "web-ticket" });

    f.clock.advance(31 * DAY);
    const swept = await sweepThreadIndexPage({
      store: f.store,
      clock: f.clock,
      threadIndexRetentionMilliseconds: 30 * DAY,
    });
    expect(swept.deleted).toBeGreaterThanOrEqual(2);
    const remaining = await index.scan({ limit: 100 });
    expect(
      remaining.records.every((entry) => entry.value.kind === "ticket_number"),
    ).toBe(true);

    // Repair never recreates a row that retention already removed.
    const repaired = await repairThreadIndexPage({
      store: f.store,
      clock: f.clock,
      threadIndexRetentionMilliseconds: 30 * DAY,
    });
    expect(repaired.indexed).toBe(0);
  });

  it("never fails a committed command when the threading index is unavailable", async () => {
    const backing = createMemoryStore();
    const store: Store = {
      collection(definition) {
        const collection = backing.collection(definition);
        if (definition.name !== threadIndex.name) {
          return collection;
        }
        return {
          ...collection,
          async insertIfAbsent() {
            throw new Error("index unavailable");
          },
        };
      },
    };
    const f = fixture({ store });
    const created = await webTicket(f);
    expect(created.ticket.id).toBe("web-ticket");
    const result = await f.processor.processInboundEmail(inbound());
    expect(result.outcome).toBe("created");
    expect(
      await backing.collection(queueIndex).get({
        partition: result.ticketId!,
        id: "queue",
      }),
    ).toMatchObject({ requesterAssociation: "unverified" });
  });

  it("rejects malformed reply-routing tokens on outbound notifications", async () => {
    const f = fixture();
    await expect(
      webTicket(f, { token: "has spaces in it 1234567890" }),
    ).rejects.toThrow(/replyRoutingToken/);
  });
});

describe("inbound mail: processor configuration", () => {
  it("requires host ports and validates options", () => {
    const store = createMemoryStore();
    const clock = mutableClock(T0);
    const routingPolicy = {
      routeNewConversation: () => ({ priority: "low" as const }),
    };
    const accountMatcher = {
      matchSenderEmail: async () => ({ matches: "none" as const }),
    };
    expect(() =>
      createInboundMailProcessor({
        store,
        clock,
        routingPolicy,
      } as unknown as InboundMailProcessorOptions),
    ).toThrow(TypeError);
    expect(() =>
      createInboundMailProcessor({
        store,
        clock,
        accountMatcher,
        routingPolicy,
        subjectMarkerPrefix: "sd-",
      }),
    ).toThrow(/subjectMarkerPrefix/);
    expect(() =>
      createInboundMailProcessor({
        store,
        clock,
        accountMatcher,
        routingPolicy,
        supportAddresses: ["not an address"],
      }),
    ).toThrow(TypeError);
    expect(() =>
      createInboundMailProcessor({
        store,
        clock,
        accountMatcher,
        routingPolicy,
        threadIndexRetentionMilliseconds: 0,
      }),
    ).toThrow(TypeError);
  });
});
