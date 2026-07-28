import type { AccessContext } from "@pegma/authorization-core";
import { fixedClock } from "@pegma/spine";
import {
  createMemoryStore,
  type CollectionDefinition,
  type CollectionStore,
  type Store,
} from "@pegma/storage-core";
import {
  createSupportDeskApplication,
  recordDeliveryCallback,
  supportRecords,
  supportPermissions,
  sweepTerminalDeliveryJobs,
} from "@pegma/support-desk-application";
import { defineTemplate } from "@pegma/support-desk-templates";
import { describe, expect, it, vi } from "vitest";
import {
  type CommittedDeliveryJobCandidate,
  createDeliveryWorker,
  type DeliveryWorkStore,
  outboundMessageId,
  ticketSubject,
} from "./index.js";

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
const unknownReconciliation = {
  reconcile: async () => ({ status: "unknown" as const }),
};

function deliveryWorkStore(
  store: Store,
  peek: () => Promise<CommittedDeliveryJobCandidate | null> = async () => null,
  consistency:
    "authoritative_rows" | "transactional_change_feed" = "authoritative_rows",
): DeliveryWorkStore {
  return {
    collection<T>(definition: CollectionDefinition<T>): CollectionStore<T> {
      return store.collection<T>(definition);
    },
    committedDeliveryJobs: {
      consistency,
      peek,
    },
  };
}

function sequenceClock(...timestamps: readonly string[]) {
  let index = 0;
  return {
    now() {
      const timestamp = timestamps[Math.min(index, timestamps.length - 1)];
      index += 1;
      if (timestamp === undefined) {
        throw new Error("test clock has no timestamp");
      }
      return timestamp;
    },
  };
}

async function pendingJob(maxAttempts = 3) {
  const store = deliveryWorkStore(createMemoryStore());
  const application = createSupportDeskApplication({
    store,
    clock: fixedClock("2026-07-27T12:00:00.000Z"),
  });
  await application.createCustomerTicket(caller, {
    commandId: "create",
    correlationId: "correlation",
    ticketId: "ticket",
    ticketNumber: 7,
    messageId: "message",
    subject: "Question",
    body: "Help.",
    notification: {
      id: "notify",
      recipientRef: "support",
      templateId: template.id,
      templateVersion: template.version,
      variables: { ticket_number: "7" },
      subject: ticketSubject(7, "Question"),
      outboundMessageId: outboundMessageId("notify", "example.test"),
      maxAttempts,
    },
  });
  return store;
}

describe("outbound delivery", () => {
  it("validates the final generated Message-ID boundary", () => {
    expect(outboundMessageId("notify", "EXAMPLE.TEST")).toBe(
      "<support.notify@example.test>",
    );
    expect(outboundMessageId("a".repeat(231), "example.test")).toHaveLength(
      254,
    );
    expect(() => outboundMessageId("a".repeat(232), "example.test")).toThrow(
      /generated Message-ID exceeds the safe header format/,
    );
    for (const notificationId of ["a..b", "a.", ".a"]) {
      expect(() => outboundMessageId(notificationId, "example.test")).toThrow(
        /generated Message-ID exceeds the safe header format/,
      );
    }
  });

  it("snapshots worker options and delivery inputs without executing accessors", async () => {
    const store = await pendingJob();
    let storeGetterReads = 0;
    expect(() =>
      createDeliveryWorker({
        get store() {
          storeGetterReads += 1;
          return store;
        },
        clock: fixedClock("2026-07-27T12:00:01.000Z"),
        workerId: "worker",
        reconciliation: unknownReconciliation,
        delivery: {
          send: async () => ({ providerMessageRef: "provider" }),
        },
        templates: { get: () => template },
      }),
    ).toThrow(/delivery worker options.store must be an own data property/);
    expect(storeGetterReads).toBe(0);

    expect(() =>
      createDeliveryWorker({
        store: createMemoryStore() as DeliveryWorkStore,
        clock: fixedClock("2026-07-27T12:00:01.000Z"),
        workerId: "worker",
        reconciliation: unknownReconciliation,
        delivery: {
          send: async () => ({ providerMessageRef: "provider" }),
        },
        templates: { get: () => template },
      }),
    ).toThrow(/store\.committedDeliveryJobs must be an own data property/);

    const postCommitHint = {
      ...store,
      committedDeliveryJobs: {
        consistency: "post_commit_hint",
        peek: async () => null,
      },
    } as unknown as DeliveryWorkStore;
    expect(() =>
      createDeliveryWorker({
        store: postCommitHint,
        clock: fixedClock("2026-07-27T12:00:01.000Z"),
        workerId: "worker",
        reconciliation: unknownReconciliation,
        delivery: {
          send: async () => ({ providerMessageRef: "provider" }),
        },
        templates: { get: () => template },
      }),
    ).toThrow(/authoritative_rows or transactional_change_feed/);

    const worker = createDeliveryWorker({
      store,
      clock: fixedClock("2026-07-27T12:00:01.000Z"),
      workerId: "worker",
      reconciliation: unknownReconciliation,
      delivery: {
        send: async () => ({ providerMessageRef: "provider" }),
      },
      templates: { get: () => template },
    });
    let ticketGetterReads = 0;
    await expect(
      worker.deliver({
        get ticketId() {
          ticketGetterReads += 1;
          return "ticket";
        },
        deliveryJobId: "notify",
        now: "2026-07-27T12:00:01.000Z",
      }),
    ).rejects.toThrow(/delivery input.ticketId must be an own data property/);
    expect(ticketGetterReads).toBe(0);
  });

  it("leases once and passes stable idempotency and threading metadata", async () => {
    const store = await pendingJob();
    const send = vi.fn(async (_request: unknown) => ({
      providerMessageRef: "provider-1",
    }));
    const worker = createDeliveryWorker({
      store,
      clock: sequenceClock(
        "2026-07-27T12:00:01.000Z",
        "2026-07-27T12:00:02.000Z",
      ),
      workerId: "worker",
      reconciliation: unknownReconciliation,
      delivery: { send },
      templates: {
        get: (id, version) =>
          id === template.id && version === template.version ? template : null,
      },
    });

    const accepted = await worker.deliver({
      ticketId: "ticket",
      deliveryJobId: "notify",
      now: "2026-07-27T12:00:01.000Z",
    });
    const repeated = await worker.deliver({
      ticketId: "ticket",
      deliveryJobId: "notify",
      now: "2026-07-27T12:00:02.000Z",
    });

    expect(accepted.status).toBe("accepted");
    expect(repeated.status).toBe("not_claimed");
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      idempotencyKey: "support-mail:v1:ticket:delivery%3Anotify",
      mail: {
        subject: "[Ticket #7] Question",
        messageId: "<support.notify@example.test>",
      },
    });
  });

  it("uses bounded exponential retry and dead-letters exhausted work", async () => {
    const store = await pendingJob(2);
    const send = vi.fn(async (_request: unknown) => {
      throw new Error("provider down");
    });
    const worker = createDeliveryWorker({
      store,
      clock: sequenceClock(
        "2026-07-27T12:00:01.000Z",
        "2026-07-27T12:00:02.000Z",
      ),
      workerId: "worker",
      reconciliation: unknownReconciliation,
      baseRetryMilliseconds: 1_000,
      delivery: { send },
      templates: { get: () => template },
      classifyFailure: () => "provider_unavailable",
    });

    const first = await worker.deliver({
      ticketId: "ticket",
      deliveryJobId: "notify",
      now: "2026-07-27T12:00:01.000Z",
    });
    const tooEarly = await worker.deliver({
      ticketId: "ticket",
      deliveryJobId: "notify",
      now: "2026-07-27T12:00:01.500Z",
    });
    const second = await worker.deliver({
      ticketId: "ticket",
      deliveryJobId: "notify",
      now: "2026-07-27T12:00:02.000Z",
    });

    expect(first.status).toBe("retrying");
    expect(tooEarly.status).toBe("not_claimed");
    expect(second.status).toBe("dead_letter");
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("counts a failed callback racing an in-flight send and fences its stale completion", async () => {
    const store = await pendingJob(2);
    let signalSendStarted!: () => void;
    let releaseSend!: () => void;
    const sendStarted = new Promise<void>((resolve) => {
      signalSendStarted = resolve;
    });
    const sendReleased = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    const send = vi.fn(async () => {
      signalSendStarted();
      await sendReleased;
      return { providerMessageRef: "provider-after-callback" };
    });
    const worker = createDeliveryWorker({
      store,
      clock: fixedClock("2026-07-27T12:00:10.000Z"),
      workerId: "worker",
      reconciliation: unknownReconciliation,
      delivery: { send },
      templates: { get: () => template },
    });

    const inFlight = worker.deliver({
      ticketId: "ticket",
      deliveryJobId: "notify",
      now: "2026-07-27T12:00:01.000Z",
    });
    await sendStarted;
    const callback = await recordDeliveryCallback(
      store,
      {
        provider: "mail",
        providerEventId: "failed-during-send",
        ticketId: "ticket",
        deliveryJobId: "notify",
        status: "failed",
        occurredAt: "2026-07-27T12:00:02.000Z",
      },
      fixedClock("2026-07-27T12:00:02.000Z"),
    );

    expect(callback.job).toMatchObject({
      status: "retrying",
      attemptCount: 1,
      failureCategory: "provider_callback_failure",
    });
    expect(callback.job).not.toHaveProperty("claimToken");
    releaseSend();
    expect((await inFlight).status).toBe("not_claimed");

    const stored = await store.collection(supportRecords).get({
      partition: "ticket",
      id: "delivery:notify",
    });
    expect(stored).toMatchObject({
      status: "retrying",
      attemptCount: 1,
      failureCategory: "provider_callback_failure",
    });
    expect(stored).not.toHaveProperty("claimToken");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("never sends beyond maxAttempts under repeated fast failed callbacks", async () => {
    const maxAttempts = 2;
    const store = await pendingJob(maxAttempts);
    let callbackNumber = 0;
    const send = vi.fn(async () => {
      callbackNumber += 1;
      const second = callbackNumber.toString().padStart(2, "0");
      await recordDeliveryCallback(
        store,
        {
          provider: "mail",
          providerEventId: `fast-failure-${callbackNumber}`,
          ticketId: "ticket",
          deliveryJobId: "notify",
          status: "failed",
          occurredAt: `2026-07-27T12:00:${second}.000Z`,
        },
        fixedClock(`2026-07-27T12:00:${second}.000Z`),
      );
      return { providerMessageRef: `provider-${callbackNumber}` };
    });
    const worker = createDeliveryWorker({
      store,
      clock: fixedClock("2026-07-27T12:10:00.000Z"),
      workerId: "worker",
      reconciliation: unknownReconciliation,
      delivery: { send },
      templates: { get: () => template },
    });

    for (const now of [
      "2026-07-27T12:00:01.000Z",
      "2026-07-27T12:00:03.000Z",
      "2026-07-27T12:00:05.000Z",
    ]) {
      expect(
        (
          await worker.deliver({
            ticketId: "ticket",
            deliveryJobId: "notify",
            now,
          })
        ).status,
      ).toBe("not_claimed");
    }

    const stored = await store.collection(supportRecords).get({
      partition: "ticket",
      id: "delivery:notify",
    });
    expect(stored).toMatchObject({
      status: "dead_letter",
      attemptCount: maxAttempts,
      failureCategory: "provider_callback_failure",
    });
    expect(send.mock.calls.length).toBeLessThanOrEqual(maxAttempts);
  });

  it("claims repeated committed store discovery authoritatively", async () => {
    const store = await pendingJob();
    const peek = vi.fn(async () => ({
      ticketId: "ticket",
      deliveryJobId: "notify",
    }));
    const discoverable = deliveryWorkStore(
      store,
      peek,
      "transactional_change_feed",
    );
    const worker = createDeliveryWorker({
      store: discoverable,
      clock: sequenceClock("2026-07-27T12:00:01.000Z"),
      workerId: "worker",
      reconciliation: unknownReconciliation,
      delivery: {
        send: async () => ({ providerMessageRef: "provider" }),
      },
      templates: { get: () => template },
    });

    expect((await worker.runOnce("2026-07-27T12:00:01.000Z"))?.status).toBe(
      "accepted",
    );
    expect((await worker.runOnce("2026-07-27T12:00:02.000Z"))?.status).toBe(
      "not_claimed",
    );
    expect(peek).toHaveBeenCalledTimes(2);
  });

  it("defensively refuses a precommit change-feed entry", async () => {
    const backing = createMemoryStore();
    const store = deliveryWorkStore(
      backing,
      async () => ({ ticketId: "ticket", deliveryJobId: "notify" }),
      "transactional_change_feed",
    );
    const send = vi.fn(async () => ({ providerMessageRef: "provider" }));
    const worker = createDeliveryWorker({
      store,
      clock: fixedClock("2026-07-27T12:00:01.000Z"),
      workerId: "worker",
      reconciliation: unknownReconciliation,
      delivery: { send },
      templates: { get: () => template },
    });

    expect((await worker.runOnce("2026-07-27T12:00:00.000Z"))?.status).toBe(
      "not_claimed",
    );
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
        subject: ticketSubject(1, "Question"),
        outboundMessageId: outboundMessageId("notify", "example.test"),
      },
    });

    expect((await worker.runOnce("2026-07-27T12:00:01.000Z"))?.status).toBe(
      "accepted",
    );
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("uses distinct provider idempotency keys for the same job id on different tickets", async () => {
    const store = deliveryWorkStore(createMemoryStore());
    const application = createSupportDeskApplication({
      store,
      clock: fixedClock("2026-07-27T12:00:00.000Z"),
    });
    for (const [ticketId, ticketNumber] of [
      ["ticket-a", 1],
      ["ticket-b", 2],
    ] as const) {
      await application.createCustomerTicket(caller, {
        commandId: `create-${ticketId}`,
        correlationId: `correlation-${ticketId}`,
        ticketId,
        ticketNumber,
        messageId: `message-${ticketId}`,
        subject: "Question",
        body: "Help.",
        notification: {
          id: "same-notification",
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
    const keys: string[] = [];
    const worker = createDeliveryWorker({
      store,
      clock: sequenceClock(
        "2026-07-27T12:00:01.000Z",
        "2026-07-27T12:00:01.000Z",
      ),
      workerId: "worker",
      reconciliation: unknownReconciliation,
      delivery: {
        send: async (request) => {
          keys.push(request.idempotencyKey);
          return { providerMessageRef: "provider" };
        },
      },
      templates: { get: () => template },
    });

    await worker.deliver({
      ticketId: "ticket-a",
      deliveryJobId: "same-notification",
      now: "2026-07-27T12:00:01.000Z",
    });
    await worker.deliver({
      ticketId: "ticket-b",
      deliveryJobId: "same-notification",
      now: "2026-07-27T12:00:01.000Z",
    });

    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
    expect(keys.every((key) => key.length <= 255)).toBe(true);
  });

  it("validates worker timing options and redacts unsafe classifier output", async () => {
    const store = await pendingJob();
    await expect(pendingJob(21)).rejects.toThrow(/between 1 and 20/);
    const base = {
      store,
      clock: sequenceClock("2026-07-27T12:00:01.000Z"),
      workerId: "worker",
      reconciliation: unknownReconciliation,
      delivery: {
        send: async () => {
          throw new Error("secret provider response");
        },
      },
      templates: { get: () => template },
    };
    expect(() =>
      createDeliveryWorker({ ...base, leaseMilliseconds: 0 }),
    ).toThrow(/positive safe integer/);
    expect(() =>
      createDeliveryWorker({
        ...base,
        baseRetryMilliseconds: Number.MAX_SAFE_INTEGER,
      }),
    ).toThrow(/positive safe integer/);

    const worker = createDeliveryWorker({
      ...base,
      classifyFailure: (error) => String(error),
    });
    await expect(
      worker.deliver({
        ticketId: "ticket",
        deliveryJobId: "notify",
        now: "+275760-09-13T00:00:00.000Z",
      }),
    ).rejects.toThrow(/too late/);
    const result = await worker.deliver({
      ticketId: "ticket",
      deliveryJobId: "notify",
      now: "2026-07-27T12:00:01.000Z",
    });
    expect(result.status).toBe("retrying");
    expect(result.status === "retrying" && result.job.failureCategory).toBe(
      "provider_unavailable",
    );
  });

  it("releases the lease through bounded failure handling when catalog or rendering fails", async () => {
    const catalogStore = await pendingJob(1);
    const catalogWorker = createDeliveryWorker({
      store: catalogStore,
      clock: sequenceClock("2026-07-27T12:00:01.000Z"),
      workerId: "worker",
      reconciliation: unknownReconciliation,
      delivery: {
        send: async () => ({ providerMessageRef: "unused" }),
      },
      templates: {
        get: () => {
          throw new Error("catalog unavailable");
        },
      },
    });
    const catalogFailure = await catalogWorker.deliver({
      ticketId: "ticket",
      deliveryJobId: "notify",
      now: "2026-07-27T12:00:01.000Z",
    });
    expect(catalogFailure.status).toBe("dead_letter");
    expect(
      catalogFailure.status === "dead_letter" &&
        catalogFailure.job.failureCategory,
    ).toBe("template_catalog_failure");

    const renderStore = await pendingJob(1);
    const sendUnsafe = vi.fn(async () => ({
      providerMessageRef: "must-not-send",
    }));
    let unsafeHtmlReads = 0;
    const renderWorker = createDeliveryWorker({
      store: renderStore,
      clock: sequenceClock("2026-07-27T12:00:01.000Z"),
      workerId: "worker",
      reconciliation: unknownReconciliation,
      delivery: { send: sendUnsafe },
      templates: {
        get: () => ({
          id: template.id,
          version: template.version,
          variables: ["ticket_number"],
          plainText: "{{ticket_number}}",
          get html() {
            unsafeHtmlReads += 1;
            return unsafeHtmlReads < 4
              ? "<p>{{ticket_number}}</p>"
              : "<script>alert(1)</script>";
          },
        }),
      },
    });
    const renderFailure = await renderWorker.deliver({
      ticketId: "ticket",
      deliveryJobId: "notify",
      now: "2026-07-27T12:00:01.000Z",
    });
    expect(renderFailure.status).toBe("dead_letter");
    expect(
      renderFailure.status === "dead_letter" &&
        renderFailure.job.failureCategory,
    ).toBe("template_render_failure");
    expect(sendUnsafe).not.toHaveBeenCalled();
    expect(unsafeHtmlReads).toBe(0);
  });

  it("rejects catalog template identity drift before provider send", async () => {
    for (const fallback of [
      defineTemplate({ ...template, id: "staff.fallback-ticket" }),
      defineTemplate({ ...template, version: template.version + 1 }),
    ]) {
      const store = await pendingJob(1);
      const send = vi.fn(async () => ({
        providerMessageRef: "must-not-send",
      }));
      const worker = createDeliveryWorker({
        store,
        clock: sequenceClock("2026-07-27T12:00:01.000Z"),
        workerId: "worker",
        reconciliation: unknownReconciliation,
        delivery: { send },
        templates: { get: () => fallback },
      });
      const result = await worker.deliver({
        ticketId: "ticket",
        deliveryJobId: "notify",
        now: "2026-07-27T12:00:01.000Z",
      });
      expect(result.status).toBe("dead_letter");
      expect(
        result.status === "dead_letter" && result.job.failureCategory,
      ).toBe("template_identity_mismatch");
      expect(send).not.toHaveBeenCalled();
    }

    const store = await pendingJob(1);
    let templateIdReads = 0;
    const send = vi.fn(async () => ({
      providerMessageRef: "must-not-send",
    }));
    const worker = createDeliveryWorker({
      store,
      clock: sequenceClock("2026-07-27T12:00:01.000Z"),
      workerId: "worker",
      reconciliation: unknownReconciliation,
      delivery: { send },
      templates: {
        get: () => ({
          ...template,
          get id() {
            templateIdReads += 1;
            return templateIdReads === 1
              ? template.id
              : "staff.fallback-ticket";
          },
        }),
      },
    });
    const result = await worker.deliver({
      ticketId: "ticket",
      deliveryJobId: "notify",
      now: "2026-07-27T12:00:01.000Z",
    });
    expect(result.status).toBe("dead_letter");
    expect(result.status === "dead_letter" && result.job.failureCategory).toBe(
      "template_render_failure",
    );
    expect(templateIdReads).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects accessor, unbounded, and control-bearing provider references without re-reading them", async () => {
    let providerReferenceReads = 0;
    const invalidResults: readonly unknown[] = [
      {
        get providerMessageRef() {
          providerReferenceReads += 1;
          return providerReferenceReads === 1
            ? "provider-safe"
            : "provider-changed";
        },
      },
      { providerMessageRef: "x".repeat(513) },
      { providerMessageRef: "provider\u0000control" },
    ];

    for (const invalidResult of invalidResults) {
      const store = await pendingJob(1);
      const worker = createDeliveryWorker({
        store,
        clock: sequenceClock("2026-07-27T12:00:01.000Z"),
        workerId: "worker",
        reconciliation: unknownReconciliation,
        delivery: {
          send: async () => invalidResult as never,
        },
        templates: { get: () => template },
      });
      const result = await worker.deliver({
        ticketId: "ticket",
        deliveryJobId: "notify",
        now: "2026-07-27T12:00:01.000Z",
      });
      expect(result.status).toBe("dead_letter");
      expect(
        result.status === "dead_letter" && result.job.failureCategory,
      ).toBe("provider_response_invalid");
    }
    expect(providerReferenceReads).toBe(0);
  });

  it("starts the callback deadline from trusted completion time after a slow provider", async () => {
    const store = await pendingJob();
    let completionTime = "2026-07-27T12:00:01.000Z";
    const worker = createDeliveryWorker({
      store,
      clock: { now: () => completionTime },
      workerId: "worker",
      acceptedCallbackMilliseconds: 1_000,
      reconciliation: unknownReconciliation,
      delivery: {
        send: async () => {
          completionTime = "2026-07-27T12:05:00.000Z";
          return { providerMessageRef: "provider-slow" };
        },
      },
      templates: { get: () => template },
    });

    const accepted = await worker.deliver({
      ticketId: "ticket",
      deliveryJobId: "notify",
      now: "2026-07-27T12:00:01.000Z",
    });
    expect(accepted.status).toBe("accepted");
    expect(accepted.status === "accepted" && accepted.job.acceptedAt).toBe(
      "2026-07-27T12:05:00.000Z",
    );
    expect(
      accepted.status === "accepted" && accepted.job.acceptedDeadlineAt,
    ).toBe("2026-07-27T12:05:01.000Z");
    expect(
      (
        await worker.reconcile({
          ticketId: "ticket",
          deliveryJobId: "notify",
          now: "2026-07-27T12:05:00.500Z",
        })
      ).status,
    ).toBe("not_claimed");
  });

  it("reconciles expired acceptance without an unsafe blind resend", async () => {
    const store = await pendingJob();
    const send = vi.fn(async () => ({ providerMessageRef: "provider-ref" }));
    const reconcile = vi.fn(async () => ({ status: "unknown" as const }));
    const worker = createDeliveryWorker({
      store,
      clock: sequenceClock(
        "2026-07-27T12:00:01.000Z",
        "2026-07-27T12:00:02.000Z",
      ),
      workerId: "worker",
      acceptedCallbackMilliseconds: 1_000,
      reconciliation: { reconcile },
      delivery: { send },
      templates: { get: () => template },
    });
    expect(
      (
        await worker.deliver({
          ticketId: "ticket",
          deliveryJobId: "notify",
          now: "2026-07-27T12:00:01.000Z",
        })
      ).status,
    ).toBe("accepted");
    expect(
      (
        await worker.reconcile({
          ticketId: "ticket",
          deliveryJobId: "notify",
          now: "2026-07-27T12:00:01.500Z",
        })
      ).status,
    ).toBe("not_claimed");
    const unknown = await worker.reconcile({
      ticketId: "ticket",
      deliveryJobId: "notify",
      now: "2026-07-27T12:00:02.000Z",
    });
    expect(unknown.status).toBe("terminal_unknown");
    expect(
      (
        await worker.deliver({
          ticketId: "ticket",
          deliveryJobId: "notify",
          now: "2026-07-27T12:00:03.000Z",
        })
      ).status,
    ).toBe("not_claimed");
    expect(send).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledWith({
      idempotencyKey: "support-mail:v1:ticket:delivery%3Anotify",
      providerMessageRef: "provider-ref",
    });
  });

  it("retries reconciliation transport failures and dead-letters at the bound", async () => {
    const maxAttempts = 2;
    const store = await pendingJob(maxAttempts);
    const send = vi.fn(async () => ({ providerMessageRef: "provider-ref" }));
    const reconcile = vi.fn(async () => {
      throw new Error("provider status endpoint unavailable");
    });
    const worker = createDeliveryWorker({
      store,
      clock: sequenceClock(
        "2026-07-27T12:00:01.000Z",
        "2026-07-27T12:00:02.000Z",
        "2026-07-27T12:00:03.000Z",
      ),
      workerId: "worker",
      baseRetryMilliseconds: 1_000,
      acceptedCallbackMilliseconds: 1_000,
      reconciliation: { reconcile },
      delivery: { send },
      templates: { get: () => template },
      classifyFailure: () => "reconciliation_transport",
    });
    expect(
      (
        await worker.deliver({
          ticketId: "ticket",
          deliveryJobId: "notify",
          now: "2026-07-27T12:00:01.000Z",
        })
      ).status,
    ).toBe("accepted");

    const first = await worker.reconcile({
      ticketId: "ticket",
      deliveryJobId: "notify",
      now: "2026-07-27T12:00:02.000Z",
    });
    expect(first).toMatchObject({
      status: "retrying",
      job: {
        status: "accepted",
        attemptCount: 1,
        reconciliationAttemptCount: 1,
        acceptedDeadlineAt: "2026-07-27T12:00:03.000Z",
        failureCategory: "reconciliation_transport",
      },
    });
    expect(
      (
        await worker.reconcile({
          ticketId: "ticket",
          deliveryJobId: "notify",
          now: "2026-07-27T12:00:02.999Z",
        })
      ).status,
    ).toBe("not_claimed");

    const exhausted = await worker.reconcile({
      ticketId: "ticket",
      deliveryJobId: "notify",
      now: "2026-07-27T12:00:03.000Z",
    });
    expect(exhausted).toMatchObject({
      status: "dead_letter",
      job: {
        status: "dead_letter",
        attemptCount: 1,
        reconciliationAttemptCount: maxAttempts,
        failureCategory: "reconciliation_transport",
        terminalAt: "2026-07-27T12:00:03.000Z",
      },
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledTimes(maxAttempts);
  });

  it("fences a stale reconciliation transport failure after lease recovery", async () => {
    const store = await pendingJob(3);
    let signalReconciliationStarted!: () => void;
    let releaseReconciliation!: () => void;
    const reconciliationStarted = new Promise<void>((resolve) => {
      signalReconciliationStarted = resolve;
    });
    const reconciliationReleased = new Promise<void>((resolve) => {
      releaseReconciliation = resolve;
    });
    const firstReconcile = vi.fn(async () => {
      signalReconciliationStarted();
      await reconciliationReleased;
      throw new Error("stale transport failure");
    });
    const firstWorker = createDeliveryWorker({
      store,
      clock: sequenceClock(
        "2026-07-27T12:00:01.000Z",
        "2026-07-27T12:00:34.000Z",
      ),
      workerId: "worker",
      leaseMilliseconds: 30_000,
      acceptedCallbackMilliseconds: 1_000,
      reconciliation: { reconcile: firstReconcile },
      delivery: {
        send: async () => ({ providerMessageRef: "provider-ref" }),
      },
      templates: { get: () => template },
    });
    expect(
      (
        await firstWorker.deliver({
          ticketId: "ticket",
          deliveryJobId: "notify",
          now: "2026-07-27T12:00:01.000Z",
        })
      ).status,
    ).toBe("accepted");

    const stale = firstWorker.reconcile({
      ticketId: "ticket",
      deliveryJobId: "notify",
      now: "2026-07-27T12:00:02.000Z",
    });
    await reconciliationStarted;
    const recoveredReconcile = vi.fn(async () => ({
      status: "delivered" as const,
    }));
    const recoveredWorker = createDeliveryWorker({
      store,
      clock: fixedClock("2026-07-27T12:00:33.000Z"),
      workerId: "worker",
      leaseMilliseconds: 30_000,
      acceptedCallbackMilliseconds: 1_000,
      reconciliation: { reconcile: recoveredReconcile },
      delivery: {
        send: async () => ({ providerMessageRef: "unused" }),
      },
      templates: { get: () => template },
    });
    expect(
      (
        await recoveredWorker.reconcile({
          ticketId: "ticket",
          deliveryJobId: "notify",
          now: "2026-07-27T12:00:32.001Z",
        })
      ).status,
    ).toBe("delivered");

    releaseReconciliation();
    expect((await stale).status).toBe("not_claimed");
    expect(
      await store.collection(supportRecords).get({
        partition: "ticket",
        id: "delivery:notify",
      }),
    ).toMatchObject({
      status: "delivered",
      deliveredAt: "2026-07-27T12:00:33.000Z",
      reconciliationAttemptCount: 0,
    });
    expect(firstReconcile).toHaveBeenCalledTimes(1);
    expect(recoveredReconcile).toHaveBeenCalledTimes(1);
  });

  it("dead-letters corrupt accepted work without claiming a provider response", async () => {
    const store = await pendingJob();
    const records = store.collection(supportRecords);
    await records.update(
      { partition: "ticket", id: "delivery:notify" },
      (current) =>
        current?.kind !== "delivery_job"
          ? { action: "keep" }
          : {
              action: "write",
              value: {
                ...current,
                status: "accepted",
                acceptedAt: "2026-07-27T12:00:00.000Z",
                acceptedDeadlineAt: "2026-07-27T12:00:01.000Z",
              },
            },
    );
    const reconcile = vi.fn(async () => ({ status: "delivered" as const }));
    const worker = createDeliveryWorker({
      store,
      clock: fixedClock("2026-07-27T12:00:02.000Z"),
      workerId: "worker",
      reconciliation: { reconcile },
      delivery: {
        send: async () => ({ providerMessageRef: "unused" }),
      },
      templates: { get: () => template },
    });
    const result = await worker.reconcile({
      ticketId: "ticket",
      deliveryJobId: "notify",
      now: "2026-07-27T12:00:02.000Z",
    });
    expect(result).toMatchObject({
      status: "dead_letter",
      job: {
        status: "dead_letter",
        failureCategory: "provider_reference_invalid",
        terminalAt: "2026-07-27T12:00:02.000Z",
      },
    });
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("timestamps slow reconciliation outcomes from trusted provider completion", async () => {
    const cases = [
      {
        outcome: { status: "delivered" as const },
        expected: "delivered" as const,
      },
      {
        outcome: {
          status: "failed" as const,
          failureCategory: "provider_rejected",
        },
        expected: "retrying" as const,
      },
      {
        outcome: { status: "unknown" as const },
        expected: "terminal_unknown" as const,
      },
    ];

    for (const testCase of cases) {
      const store = await pendingJob();
      let completionTime = "2026-07-27T12:00:01.000Z";
      const worker = createDeliveryWorker({
        store,
        clock: { now: () => completionTime },
        workerId: "worker",
        acceptedCallbackMilliseconds: 1_000,
        reconciliation: {
          reconcile: async () => {
            completionTime = "2026-07-27T13:00:00.000Z";
            return testCase.outcome;
          },
        },
        delivery: {
          send: async () => ({ providerMessageRef: "provider-ref" }),
        },
        templates: { get: () => template },
      });
      expect(
        (
          await worker.deliver({
            ticketId: "ticket",
            deliveryJobId: "notify",
            now: "2026-07-27T12:00:01.000Z",
          })
        ).status,
      ).toBe("accepted");

      const reconciled = await worker.reconcile({
        ticketId: "ticket",
        deliveryJobId: "notify",
        now: "2026-07-27T12:00:02.000Z",
      });
      expect(reconciled.status).toBe(testCase.expected);
      if (reconciled.status === "not_claimed") {
        throw new Error("reconciliation should have completed");
      }
      if (reconciled.status === "retrying") {
        expect(reconciled.job.availableAt).toBe("2026-07-27T13:00:00.000Z");
        continue;
      }
      expect(reconciled.job.terminalAt).toBe("2026-07-27T13:00:00.000Z");
      if (reconciled.status === "delivered") {
        expect(reconciled.job.deliveredAt).toBe("2026-07-27T13:00:00.000Z");
      }
      expect(
        await sweepTerminalDeliveryJobs(store, {
          ticketId: "ticket",
          terminalBefore: "2026-07-27T12:59:59.999Z",
        }),
      ).toBe(0);
      expect(
        await sweepTerminalDeliveryJobs(store, {
          ticketId: "ticket",
          terminalBefore: "2026-07-27T13:00:00.001Z",
        }),
      ).toBe(1);
    }
  });

  it("maps malformed reconciliation results to terminal unknown without invoking accessors", async () => {
    let statusReads = 0;
    let failureReads = 0;
    const malformedResults: readonly unknown[] = [
      null,
      { status: "not-a-provider-state" },
      {
        get status() {
          statusReads += 1;
          throw new Error("must not execute");
        },
      },
      {
        status: "failed",
        get failureCategory() {
          failureReads += 1;
          return "provider_unavailable";
        },
      },
    ];

    for (const malformed of malformedResults) {
      const store = await pendingJob();
      const worker = createDeliveryWorker({
        store,
        clock: sequenceClock(
          "2026-07-27T12:00:01.000Z",
          "2026-07-27T12:00:02.000Z",
        ),
        workerId: "worker",
        acceptedCallbackMilliseconds: 1_000,
        reconciliation: {
          reconcile: async () => malformed as never,
        },
        delivery: {
          send: async () => ({ providerMessageRef: "provider-ref" }),
        },
        templates: { get: () => template },
      });
      expect(
        (
          await worker.deliver({
            ticketId: "ticket",
            deliveryJobId: "notify",
            now: "2026-07-27T12:00:01.000Z",
          })
        ).status,
      ).toBe("accepted");
      expect(
        (
          await worker.reconcile({
            ticketId: "ticket",
            deliveryJobId: "notify",
            now: "2026-07-27T12:00:02.000Z",
          })
        ).status,
      ).toBe("terminal_unknown");
    }
    expect(statusReads).toBe(0);
    expect(failureReads).toBe(0);
  });
});
