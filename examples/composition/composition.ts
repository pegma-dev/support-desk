/**
 * Host-neutral Support Desk composition example.
 *
 * NON-PRODUCTION: uses an in-memory Store, synthetic AccessContext values, a
 * fixed Clock, a fake mail provider, and process-local worker cursor stubs.
 * There is no HTTP framework, no session cookie, and no real provider SDK.
 *
 * Hosts replace the Store, AccessContext resolution, Clock, mail provider,
 * and durable cursor persistence with production wiring.
 */
import type { AccessContext } from "@pegma/authorization-core";
import type {
  MailProvider,
  MailReconciliationPort,
  MailWorker,
} from "@pegma/mail";
import { fixedClock, type Clock, type IsoTimestamp } from "@pegma/spine";
import { createMemoryStore, type Store } from "@pegma/storage-core";
import {
  createSupportDeskApplication,
  defaultQueueTerminalRetentionMilliseconds,
  pruneCustomerTicketIndex,
  recordDeliveryCallback,
  repairQueueProjectionPage,
  supportMail,
  supportPermissions,
  supportRecords,
  sweepDeliveryCallbackReceipts,
  sweepInactiveQueueProjections,
  sweepInboundReceipts,
  type DeliveryCallbackInput,
  type SupportDeskApplication,
} from "@pegma/support-desk-application";
import { defineTemplate, renderTemplate } from "@pegma/support-desk-templates";

/** Synthetic customer principal with the three customer permissions. */
export const EXAMPLE_CUSTOMER: AccessContext = Object.freeze({
  principalId: "customer-example-001",
  policyVersion: "example-1",
  roles: [],
  entitlements: [],
  permissions: Object.freeze([
    supportPermissions.create,
    supportPermissions.readOwn,
    supportPermissions.replyOwn,
  ]),
});

/** Synthetic staff principal with full staff permission set. */
export const EXAMPLE_STAFF: AccessContext = Object.freeze({
  principalId: "staff-example-001",
  policyVersion: "example-1",
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

/** Host-configured category allowlist (pegma.dev-shaped sample). */
export const EXAMPLE_CATEGORIES = Object.freeze([
  "feedback",
  "bug",
  "feature_request",
  "documentation",
  "question",
] as const);

export const staffNewTicketTemplate = defineTemplate({
  id: "example.staff-new-ticket",
  version: 1,
  variables: ["ticket_number"],
  plainText: "New support ticket #{{ticket_number}}",
  html: "<p>New support ticket #{{ticket_number}}</p>",
});

export const customerReplyTemplate = defineTemplate({
  id: "example.customer-reply",
  version: 1,
  variables: ["ticket_number", "message_body", "ticket_url"],
  httpsUrlVariables: ["ticket_url"],
  plainText:
    "Support replied to ticket #{{ticket_number}}.\n\n{{message_body}}\n\n{{ticket_url}}",
  html: '<p>Support replied to ticket #{{ticket_number}}.</p><p>{{message_body}}</p><p><a href="{{ticket_url}}">Open ticket</a></p>',
});

/**
 * Process-local cursor store that models host-owned worker cursor persistence.
 * A production host must keep one durable key per loop and never share cursors
 * across loops or Support Desk instances.
 */
export class MemoryCursorStore {
  readonly #cursors = new Map<string, string | null>();

  get(loop: string): string | null | undefined {
    return this.#cursors.get(loop);
  }

  /**
   * Persist only after a complete page succeeds. Passing `null` ends a cycle;
   * the next invocation should start without a cursor.
   */
  set(loop: string, cursor: string | null): void {
    this.#cursors.set(loop, cursor);
  }
}

export interface ExampleCompositionOptions {
  readonly store?: Store;
  readonly clock?: Clock;
  readonly terminalRetentionMilliseconds?: number;
  readonly mailProvider?: MailProvider;
  readonly reconciliation?: MailReconciliationPort;
}

export interface ExampleComposition {
  readonly store: Store;
  readonly clock: Clock;
  readonly application: SupportDeskApplication;
  readonly cursors: MemoryCursorStore;
  readonly terminalRetentionMilliseconds: number;
  readonly sent: ReadonlyArray<Readonly<Record<string, unknown>>>;
  createMailWorker(workerId?: string): MailWorker;
  runMailSendPage(limit?: number): Promise<{
    readonly examined: number;
    readonly accepted: number;
    readonly nextCursor: string | null;
  }>;
  runMailReconciliationPage(limit?: number): Promise<{
    readonly examined: number;
    readonly nextCursor: string | null;
  }>;
  runMailTerminalSweep(
    terminalBefore: IsoTimestamp,
    limit?: number,
  ): Promise<{
    readonly deleted: number;
    readonly nextCursor: string | null;
  }>;
  runQueueRepairPage(limit?: number): Promise<{
    readonly projected: number;
    readonly physicalRows: number;
    readonly nextCursor: string | null;
  }>;
  runQueueInactiveSweep(limit?: number): Promise<{
    readonly deleted: number;
    readonly physicalRows: number;
    readonly nextCursor: string | null;
  }>;
  runCustomerIndexPrune(
    reservedBefore: IsoTimestamp,
  ): Promise<readonly string[]>;
  runInboundReceiptSweep(input: {
    readonly bucket: string;
    readonly processedBefore: IsoTimestamp;
  }): Promise<number>;
  runDeliveryCallbackReceiptSweep(input: {
    readonly bucket: string;
    readonly processedBefore: IsoTimestamp;
  }): Promise<number>;
  recordCallback(
    input: DeliveryCallbackInput,
  ): Promise<{ readonly duplicate: boolean }>;
}

function resolveTemplate(templateId: string, templateVersion: number) {
  if (
    templateId === staffNewTicketTemplate.id &&
    templateVersion === staffNewTicketTemplate.version
  ) {
    return staffNewTicketTemplate;
  }
  if (
    templateId === customerReplyTemplate.id &&
    templateVersion === customerReplyTemplate.version
  ) {
    return customerReplyTemplate;
  }
  return null;
}

export function createExampleComposition(
  options: ExampleCompositionOptions = {},
): ExampleComposition {
  const store = options.store ?? createMemoryStore();
  const clock = options.clock ?? fixedClock("2026-07-29T12:00:01.000Z");
  const terminalRetentionMilliseconds =
    options.terminalRetentionMilliseconds ??
    defaultQueueTerminalRetentionMilliseconds;
  const cursors = new MemoryCursorStore();
  const sent: Record<string, unknown>[] = [];

  const application = createSupportDeskApplication({
    store,
    clock,
    allowedCategories: EXAMPLE_CATEGORIES,
    queueTerminalRetentionMilliseconds: terminalRetentionMilliseconds,
  });

  const defaultProvider: MailProvider = {
    async send(request) {
      sent.push({
        idempotencyKey: request.idempotencyKey,
        recipient: request.mail.recipient,
        subject: request.mail.subject,
        text: request.mail.text,
        html: request.mail.html,
      });
      return {
        providerMessageRef: `provider-${request.idempotencyKey}`,
      };
    },
  };

  const provider = options.mailProvider ?? defaultProvider;
  const reconciliation: MailReconciliationPort = options.reconciliation ?? {
    reconcile: async () => ({ status: "unknown" }),
  };

  const createMailWorker = (workerId = "example-mail-worker"): MailWorker => {
    const records = store.collection(supportRecords);
    return supportMail.worker({
      records,
      clock,
      workerId,
      provider,
      reconciliation,
      preparation: {
        async prepare(request) {
          const message = await records.get({
            partition: request.partition,
            id: `message:${request.contentRef}`,
          });
          if (
            message?.kind !== "message" ||
            message.deliveryContent === undefined
          ) {
            throw new Error("example preparation could not resolve content");
          }
          const content = message.deliveryContent;
          const template = resolveTemplate(
            content.templateId,
            content.templateVersion,
          );
          if (template === null) {
            throw new Error("example preparation saw an unknown template");
          }
          const rendered = renderTemplate(template, content.variables);
          return {
            recipient: request.recipientRef,
            subject: content.subject,
            text: rendered.plainText,
            html: rendered.html,
            headers: {
              "Message-ID": content.outboundMessageId,
            },
          };
        },
      },
    });
  };

  const withCursor = async <T extends { nextCursor: string | null }>(
    loop: string,
    run: (cursor: string | undefined) => Promise<T>,
  ): Promise<T> => {
    const stored = cursors.get(loop);
    const cursor = stored === undefined || stored === null ? undefined : stored;
    const page = await run(cursor);
    cursors.set(loop, page.nextCursor);
    return page;
  };

  return {
    store,
    clock,
    application,
    cursors,
    terminalRetentionMilliseconds,
    get sent() {
      return sent;
    },
    createMailWorker,
    async runMailSendPage(limit = 50) {
      const worker = createMailWorker();
      const page = await withCursor("mail.send", (cursor) =>
        worker.runSendPage({
          limit,
          ...(cursor === undefined ? {} : { cursor }),
        }),
      );
      return {
        examined: page.examined,
        accepted: page.results.filter((result) => result.status === "accepted")
          .length,
        nextCursor: page.nextCursor,
      };
    },
    async runMailReconciliationPage(limit = 50) {
      const worker = createMailWorker();
      const page = await withCursor("mail.reconcile", (cursor) =>
        worker.runReconciliationPage({
          limit,
          ...(cursor === undefined ? {} : { cursor }),
        }),
      );
      return { examined: page.examined, nextCursor: page.nextCursor };
    },
    async runMailTerminalSweep(terminalBefore, limit = 50) {
      const page = await withCursor("mail.terminal-sweep", (cursor) =>
        supportMail.sweep(store.collection(supportRecords), {
          terminalBefore,
          limit,
          ...(cursor === undefined ? {} : { cursor }),
        }),
      );
      return { deleted: page.deleted, nextCursor: page.nextCursor };
    },
    async runQueueRepairPage(limit = 50) {
      return withCursor("queue.repair", (cursor) =>
        repairQueueProjectionPage({
          store,
          clock,
          terminalRetentionMilliseconds,
          limit,
          ...(cursor === undefined ? {} : { cursor }),
        }),
      );
    },
    async runQueueInactiveSweep(limit = 50) {
      return withCursor("queue.inactive-sweep", (cursor) =>
        sweepInactiveQueueProjections({
          store,
          clock,
          terminalRetentionMilliseconds,
          limit,
          ...(cursor === undefined ? {} : { cursor }),
        }),
      );
    },
    async runCustomerIndexPrune(reservedBefore) {
      return pruneCustomerTicketIndex(store, EXAMPLE_CUSTOMER.principalId, {
        reservedBefore,
      });
    },
    async runInboundReceiptSweep(input) {
      return sweepInboundReceipts(store, clock, input);
    },
    async runDeliveryCallbackReceiptSweep(input) {
      return sweepDeliveryCallbackReceipts(store, clock, input);
    },
    async recordCallback(input) {
      const result = await recordDeliveryCallback(store, input, clock);
      return { duplicate: result.duplicate };
    },
  };
}

/** End-to-end public-entry-point scenario used by the runnable example and tests. */
export async function runCompleteExampleFlow(
  composition: ExampleComposition = createExampleComposition(),
): Promise<{
  readonly ticketId: string;
  readonly customerViewSubject: string;
  readonly staffQueueSize: number;
  readonly noteCount: number;
  readonly customerMessageBodies: readonly string[];
  readonly mailSent: number;
}> {
  const { application } = composition;
  const ticketId = "ticket-example-001";

  const created = await application.createCustomerTicket(EXAMPLE_CUSTOMER, {
    commandId: "cmd-create-1",
    correlationId: "corr-create-1",
    ticketId,
    messageId: "msg-customer-1",
    subject: "Cannot export my data",
    body: "The export button stays disabled.",
    category: "bug",
    notification: {
      id: "notify-create-1",
      recipientRef: "staff-inbox@example.test",
      templateId: staffNewTicketTemplate.id,
      templateVersion: staffNewTicketTemplate.version,
      variables: { ticket_number: "placeholder" },
      subject: "[Example #{{ticket_number}}] Cannot export my data",
      outboundMessageId: "<support.notify-create-1@example.test>",
    },
  });

  await application.replyToCustomerTicket(EXAMPLE_CUSTOMER, {
    commandId: "cmd-customer-reply-1",
    correlationId: "corr-customer-reply-1",
    ticketId,
    messageId: "msg-customer-2",
    body: "I tried again after a refresh.",
  });

  const listed = await application.listCustomerTickets(EXAMPLE_CUSTOMER);
  const read = await application.readCustomerTicket(EXAMPLE_CUSTOMER, ticketId);

  await application.readStaffTicket(EXAMPLE_STAFF, ticketId);
  await application.addNote(EXAMPLE_STAFF, {
    commandId: "cmd-note-1",
    correlationId: "corr-note-1",
    ticketId,
    messageId: "msg-note-1",
    body: "Internal: check export entitlement flags.",
  });
  await application.assignTicket(EXAMPLE_STAFF, {
    commandId: "cmd-assign-1",
    correlationId: "corr-assign-1",
    ticketId,
    assigneeId: EXAMPLE_STAFF.principalId,
  });
  await application.changePriority(EXAMPLE_STAFF, {
    commandId: "cmd-priority-1",
    correlationId: "corr-priority-1",
    ticketId,
    priority: "high",
  });
  await application.replyAsStaff(EXAMPLE_STAFF, {
    commandId: "cmd-staff-reply-1",
    correlationId: "corr-staff-reply-1",
    ticketId,
    messageId: "msg-staff-1",
    body: "Thanks — we are investigating the export control.",
    notification: {
      id: "notify-staff-1",
      recipientRef: "customer@example.test",
      templateId: customerReplyTemplate.id,
      templateVersion: customerReplyTemplate.version,
      variables: {
        ticket_number: String(created.ticket.number),
        message_body: "Thanks — we are investigating the export control.",
        ticket_url: "https://example.test/support/ticket-example-001",
      },
      subject: `[Example #${String(created.ticket.number)}] Re: Cannot export my data`,
      outboundMessageId: "<support.notify-staff-1@example.test>",
    },
  });

  const queue = await application.listStaffQueue(EXAMPLE_STAFF, {
    status: "waiting_on_customer",
    sort: "updated_newest",
  });
  const afterStaff = await application.readStaffTicket(EXAMPLE_STAFF, ticketId);
  const customerAfterStaff = await application.readCustomerTicket(
    EXAMPLE_CUSTOMER,
    ticketId,
  );
  const audit = await application.readTicketAuditHistory(
    EXAMPLE_STAFF,
    ticketId,
  );

  // Host-owned schedulers: mail send and queue repair (cursor stubs persist).
  let mailAccepted = 0;
  let sendCursor: string | null | undefined;
  do {
    const page = await composition.runMailSendPage(10);
    mailAccepted += page.accepted;
    sendCursor = page.nextCursor;
  } while (sendCursor !== null);

  await composition.runQueueRepairPage(50);

  if (listed.length !== 1 || listed[0]?.id !== ticketId) {
    throw new Error("customer list did not return the created ticket");
  }
  if (read.ticket.subject !== created.ticket.subject) {
    throw new Error("customer read subject mismatch");
  }
  if (
    customerAfterStaff.messages.some((message) =>
      message.body.includes("Internal:"),
    )
  ) {
    throw new Error("internal note leaked into customer view");
  }
  if (afterStaff.messages.length < 4) {
    throw new Error("staff detail is missing messages");
  }
  if (queue.items.length !== 1 || queue.items[0]?.ticketId !== ticketId) {
    throw new Error("staff queue did not list the active ticket");
  }
  if (audit.length < 5) {
    throw new Error("audit history is incomplete");
  }
  if (mailAccepted < 1 || composition.sent.length < 1) {
    throw new Error("mail send page did not deliver any job");
  }

  return {
    ticketId,
    customerViewSubject: customerAfterStaff.ticket.subject,
    staffQueueSize: queue.items.length,
    noteCount: afterStaff.messages.filter(
      (message) => message.visibility === "internal",
    ).length,
    customerMessageBodies: customerAfterStaff.messages.map(
      (message) => message.body,
    ),
    mailSent: composition.sent.length,
  };
}
