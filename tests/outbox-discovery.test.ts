import { TableClient } from "@azure/data-tables";
import type { AccessContext } from "@pegma/authorization-core";
import type {
  MailProvider,
  MailReconciliationPort,
  MailWorker,
} from "@pegma/mail";
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
  type SupportRecord,
  supportMail,
  supportPermissions,
  supportRecords,
} from "@pegma/support-desk-application";
import { defineTemplate, renderTemplate } from "@pegma/support-desk-templates";
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

interface StoreFixture {
  readonly store: Store;
  /** A new adapter facade over the same durable rows. */
  freshStore(): Store;
}

let azureTableOrdinal = 0;

function memoryFixture(): StoreFixture {
  const store = createMemoryStore();
  return {
    store,
    freshStore() {
      return {
        collection<T>(definition: CollectionDefinition<T>): CollectionStore<T> {
          return store.collection(definition);
        },
      };
    },
  };
}

function azureFixture(): StoreFixture {
  azureTableOrdinal += 1;
  const table = `pegmamail${process.pid}${azureTableOrdinal}`;
  const freshStore = () =>
    createAzureTablesStore({
      client: TableClient.fromConnectionString(CONNECTION_STRING, table, {
        allowInsecureConnection: true,
      }),
    });
  return { store: freshStore(), freshStore };
}

async function createTicket(
  store: Store,
  ticketId: string,
  ticketNumber: number,
  maxAttempts?: number,
): Promise<void> {
  await createSupportDeskApplication({
    store,
    clock: fixedClock("2026-07-27T12:00:00.000Z"),
  }).createCustomerTicket(caller, {
    commandId: `create-${ticketId}`,
    correlationId: `correlation-${ticketId}`,
    ticketId,
    ticketNumber,
    messageId: `message-${ticketId}`,
    subject: "Question",
    body: "Help.",
    notification: {
      id: `notify-${ticketId}`,
      recipientRef: "support@example.test",
      templateId: template.id,
      templateVersion: template.version,
      variables: { ticket_number: String(ticketNumber) },
      subject: `[Ticket #${ticketNumber}] Question`,
      outboundMessageId: `<support.notify-${ticketNumber}@example.test>`,
      ...(maxAttempts === undefined ? {} : { maxAttempts }),
    },
  });
}

function worker(
  store: Store,
  provider: MailProvider,
  options: {
    readonly now?: string;
    readonly reconciliation?: MailReconciliationPort;
    readonly acceptedCallbackMilliseconds?: number;
  } = {},
): MailWorker {
  const records = store.collection(supportRecords);
  return supportMail.worker({
    records,
    clock: fixedClock(options.now ?? "2026-07-27T12:00:01.000Z"),
    workerId: "support-worker",
    provider,
    reconciliation: options.reconciliation ?? {
      reconcile: async () => ({ status: "unknown" }),
    },
    preparation: {
      async prepare(request) {
        const content = await records.get({
          partition: request.partition,
          id: `message:${request.contentRef}`,
        });
        if (
          content?.kind !== "message" ||
          content.deliveryContent === undefined ||
          content.deliveryContent.templateId !== template.id ||
          content.deliveryContent.templateVersion !== template.version
        ) {
          throw new Error("Support mail content is unavailable");
        }
        const rendered = renderTemplate(
          template,
          content.deliveryContent.variables,
        );
        return {
          recipient: request.recipientRef,
          subject: content.deliveryContent.subject,
          text: rendered.plainText,
          html: rendered.html,
          headers: {
            "Message-ID": content.deliveryContent.outboundMessageId,
          },
        };
      },
    },
    ...(options.acceptedCallbackMilliseconds === undefined
      ? {}
      : {
          acceptedCallbackMilliseconds: options.acceptedCallbackMilliseconds,
        }),
  });
}

async function completeSendCycle(
  mailWorker: MailWorker,
  limit: number,
): Promise<readonly string[]> {
  let cursor: string | undefined;
  const statuses: string[] = [];
  do {
    const page = await mailWorker.runSendPage({
      limit,
      ...(cursor === undefined ? {} : { cursor }),
    });
    statuses.push(...page.results.map((result) => result.status));
    cursor = page.nextCursor ?? undefined;
    if (page.nextCursor === null) return statuses;
  } while (true);
}

async function completeReconciliationCycle(
  mailWorker: MailWorker,
  limit: number,
): Promise<readonly string[]> {
  let cursor: string | undefined;
  const statuses: string[] = [];
  do {
    const page = await mailWorker.runReconciliationPage({
      limit,
      ...(cursor === undefined ? {} : { cursor }),
    });
    statuses.push(...page.results.map((result) => result.status));
    cursor = page.nextCursor ?? undefined;
    if (page.nextCursor === null) return statuses;
  } while (true);
}

async function exerciseAtomicProjection(fixture: StoreFixture): Promise<void> {
  const records = fixture.store.collection(supportRecords);
  await createTicket(fixture.store, "ticket", 42);

  const message = await records.get({
    partition: "ticket",
    id: "message:message-ticket",
  });
  const delivery = await records.get({
    partition: "ticket",
    id: "delivery:notify-ticket",
  });
  expect(message).toMatchObject({
    kind: "message",
    deliveryContent: {
      templateId: "staff.new-ticket",
      templateVersion: 1,
      variables: { ticket_number: "42" },
      subject: "[Ticket #42] Question",
      outboundMessageId: "<support.notify-42@example.test>",
    },
  });
  expect(delivery).toMatchObject({
    kind: "delivery_job",
    ticketId: "ticket",
    messageId: "message-ticket",
    job: {
      partition: "ticket",
      id: "notify-ticket",
      contentRef: "message-ticket",
      recipientRef: "support@example.test",
      submissionGeneration: 1,
      status: "pending",
    },
  });

  const send = vi.fn(async () => ({ providerMessageRef: "provider-ref" }));
  expect(
    await completeSendCycle(worker(fixture.freshStore(), { send }), 1),
  ).toContain("accepted");
  expect(send).toHaveBeenCalledWith({
    idempotencyKey: expect.stringMatching(
      /^pegma-mail:v1:ticket:notify-ticket:1$/,
    ),
    mail: {
      recipient: "support@example.test",
      subject: "[Ticket #42] Question",
      text: "New ticket 42",
      html: "<p>New ticket 42</p>",
      headers: { "message-id": "<support.notify-42@example.test>" },
    },
  });
}

async function exerciseCrashAndCursorRecovery(
  fixture: StoreFixture,
): Promise<void> {
  await createTicket(fixture.store, "alpha", 1);
  await createTicket(fixture.store, "zulu", 2);
  const send = vi.fn(async () => ({ providerMessageRef: "provider-ref" }));
  const firstWorker = worker(fixture.freshStore(), { send });
  const first = await firstWorker.runSendPage({ limit: 1 });
  expect(first.nextCursor).not.toBeNull();

  // A process may crash before persisting the continuation. Repeating the
  // page is harmless because the durable claim is authoritative.
  const repeated = await worker(fixture.freshStore(), { send }).runSendPage({
    limit: 1,
  });
  expect(repeated.nextCursor).toBe(first.nextCursor);

  await completeSendCycle(firstWorker, 1);
  await completeSendCycle(firstWorker, 1);
  expect(send).toHaveBeenCalledTimes(2);
}

async function exerciseSeparateCursorCycles(
  fixture: StoreFixture,
): Promise<void> {
  await createTicket(fixture.store, "ticket", 1);
  const send = vi.fn(async () => ({ providerMessageRef: "provider-ref" }));
  await completeSendCycle(
    worker(fixture.store, { send }, { acceptedCallbackMilliseconds: 1_000 }),
    2,
  );

  const reconcile = vi.fn(async () => ({ status: "delivered" as const }));
  const recovered = worker(
    fixture.freshStore(),
    { send },
    {
      now: "2026-07-27T12:00:02.000Z",
      reconciliation: { reconcile },
    },
  );
  expect(await completeReconciliationCycle(recovered, 1)).toContain(
    "delivered",
  );
  expect(await completeSendCycle(recovered, 1)).not.toContain("accepted");
  expect(send).toHaveBeenCalledTimes(1);
  expect(reconcile).toHaveBeenCalledTimes(1);

  const swept = await supportMail.sweep(
    fixture.freshStore().collection(supportRecords),
    {
      terminalBefore: "2026-07-28T00:00:00.000Z",
      limit: 100,
    },
  );
  expect(swept.deleted).toBe(1);
  expect(
    await fixture.store.collection(supportRecords).get({
      partition: "ticket",
      id: "delivery:notify-ticket",
    }),
  ).toBeNull();
}

function physicalKeyMismatchStore(store: Store): Store {
  return {
    collection<T>(definition: CollectionDefinition<T>): CollectionStore<T> {
      if (definition.name !== supportRecords.name) {
        return store.collection(definition);
      }
      const authoritative = store.collection(
        supportRecords,
      ) as CollectionStore<SupportRecord>;
      return {
        ...authoritative,
        async scan(
          options: Parameters<CollectionStore<SupportRecord>["scan"]>[0],
        ) {
          const page = await authoritative.scan(options);
          return {
            ...page,
            records: page.records.map((record) =>
              record.value.kind === "delivery_job"
                ? {
                    ...record,
                    key: {
                      partition: record.key.partition,
                      id: `wrong-${record.key.id}`,
                    },
                  }
                : record,
            ),
          };
        },
      } as unknown as CollectionStore<T>;
    },
  };
}

describe.each([
  ["memory", memoryFixture],
  ["Azure Tables", azureFixture],
] as const)("@pegma/mail Support projection on %s", (_name, fixture) => {
  it("commits Support content and generic mail state atomically", async () => {
    await exerciseAtomicProjection(fixture());
  });

  it("rediscovers work after process and cursor loss", async () => {
    await exerciseCrashAndCursorRecovery(fixture());
  });

  it("uses independent complete send and reconciliation cursor cycles", async () => {
    await exerciseSeparateCursorCycles(fixture());
  });
});

describe("authoritative Support mail scan boundary", () => {
  it("rejects a decoded mail row whose physical scan key disagrees", async () => {
    const store = createMemoryStore();
    await createTicket(store, "ticket", 1);
    const mismatched = worker(physicalKeyMismatchStore(store), {
      send: async () => ({ providerMessageRef: "provider-ref" }),
    });
    await expect(mismatched.runSendPage({ limit: 100 })).rejects.toThrow(
      /authoritative scan key does not match/,
    );
  });

  it("preserves Support-owned wrapper metadata through generic transitions", async () => {
    const store = createMemoryStore();
    await createTicket(store, "ticket", 1);
    const records = store.collection(supportRecords);
    const before = await records.get({
      partition: "ticket",
      id: "delivery:notify-ticket",
    });
    expect(before?.kind).toBe("delivery_job");
    await worker(store, {
      send: async () => ({ providerMessageRef: "provider-ref" }),
    }).send({ partition: "ticket", jobId: "notify-ticket" });
    const after = await records.get({
      partition: "ticket",
      id: "delivery:notify-ticket",
    });
    expect(
      after?.kind === "delivery_job" && before?.kind === "delivery_job"
        ? {
            ticketId: after.ticketId,
            messageId: after.messageId,
            physicalId: after.id,
          }
        : null,
    ).toEqual({
      ticketId: "ticket",
      messageId: "message-ticket",
      physicalId: "delivery:notify-ticket",
    });
  });
});
