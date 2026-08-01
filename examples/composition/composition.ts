/**
 * Host-neutral Support Desk composition example.
 *
 * NON-PRODUCTION: uses an in-memory Store, synthetic AccessContext values, a
 * fixed Clock, a fake mail provider, and @pegma/scheduler for the five direct
 * host loops. There is no HTTP framework, no session cookie, and no real
 * provider SDK.
 *
 * Hosts replace the Store, AccessContext resolution, Clock, mail provider,
 * and host wakeup (Cron, Timer, queue) with production wiring. Scheduler
 * checkpoints replace process-local cursors for the five registered loops.
 * Receipt and principal sweeps stay host-selected and outside the static
 * task registry.
 */
import type { AccessContext } from "@pegma/authorization-core";
import type {
  MailProvider,
  MailReconciliationPort,
  MailWorker,
} from "@pegma/mail";
import {
  createScheduler,
  defineScheduledTasks,
  type Scheduler,
  type SchedulerRunResult,
} from "@pegma/scheduler";
import {
  fixedClock,
  noopLogger,
  type Clock,
  type IsoTimestamp,
} from "@pegma/spine";
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

/** Static task ids for the five direct host loops (not receipt/principal sweeps). */
export type SupportDeskScheduledTasks = {
  "mail.send": (
    context: import("@pegma/scheduler").ScheduledTaskContext,
  ) => Promise<import("@pegma/scheduler").ScheduledTaskResult>;
  "mail.reconcile": (
    context: import("@pegma/scheduler").ScheduledTaskContext,
  ) => Promise<import("@pegma/scheduler").ScheduledTaskResult>;
  "mail.terminal-sweep": (
    context: import("@pegma/scheduler").ScheduledTaskContext,
  ) => Promise<import("@pegma/scheduler").ScheduledTaskResult>;
  "queue.repair": (
    context: import("@pegma/scheduler").ScheduledTaskContext,
  ) => Promise<import("@pegma/scheduler").ScheduledTaskResult>;
  "queue.inactive-sweep": (
    context: import("@pegma/scheduler").ScheduledTaskContext,
  ) => Promise<import("@pegma/scheduler").ScheduledTaskResult>;
};

export interface ExampleCompositionOptions {
  readonly store?: Store;
  readonly clock?: Clock;
  readonly terminalRetentionMilliseconds?: number;
  readonly mailProvider?: MailProvider;
  readonly reconciliation?: MailReconciliationPort;
  readonly instanceId?: string;
  readonly workerId?: string;
}

export interface ExampleComposition {
  readonly store: Store;
  readonly clock: Clock;
  readonly application: SupportDeskApplication;
  readonly scheduler: Scheduler<SupportDeskScheduledTasks>;
  readonly terminalRetentionMilliseconds: number;
  readonly sent: ReadonlyArray<Readonly<Record<string, unknown>>>;
  createMailWorker(workerId?: string): MailWorker;
  runMailSendPage(limit?: number): Promise<{
    readonly examined: number;
    readonly accepted: number;
    readonly nextCursor: string | null;
    readonly run: SchedulerRunResult;
  }>;
  runMailReconciliationPage(limit?: number): Promise<{
    readonly examined: number;
    readonly nextCursor: string | null;
    readonly run: SchedulerRunResult;
  }>;
  runMailTerminalSweep(
    terminalBefore: IsoTimestamp,
    limit?: number,
  ): Promise<{
    readonly deleted: number;
    readonly nextCursor: string | null;
    readonly run: SchedulerRunResult;
  }>;
  runQueueRepairPage(limit?: number): Promise<{
    readonly projected: number;
    readonly physicalRows: number;
    readonly nextCursor: string | null;
    readonly run: SchedulerRunResult;
  }>;
  runQueueInactiveSweep(limit?: number): Promise<{
    readonly deleted: number;
    readonly physicalRows: number;
    readonly nextCursor: string | null;
    readonly run: SchedulerRunResult;
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

function requireSucceeded(
  taskId: string,
  run: SchedulerRunResult,
): Extract<SchedulerRunResult, { outcome: "succeeded" }> {
  if (run.outcome !== "succeeded") {
    const detail =
      run.outcome === "failed"
        ? run.failureCategory
        : run.outcome === "skipped"
          ? run.reason
          : run.outcome;
    throw new Error(`${taskId} did not succeed: ${detail}`);
  }
  return run;
}

export function createExampleComposition(
  options: ExampleCompositionOptions = {},
): ExampleComposition {
  const store = options.store ?? createMemoryStore();
  const clock = options.clock ?? fixedClock("2026-07-29T12:00:01.000Z");
  const terminalRetentionMilliseconds =
    options.terminalRetentionMilliseconds ??
    defaultQueueTerminalRetentionMilliseconds;
  const sent: Record<string, unknown>[] = [];

  // Host-selected page parameters for the next manual run. Handlers close over
  // this bag so static task registration stays parameter-free at the registry.
  const pageOptions: {
    limit: number;
    terminalBefore: IsoTimestamp;
  } = {
    limit: 50,
    terminalBefore: "1970-01-01T00:00:00.000Z",
  };
  let manualSeq = 0;

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

  const tasks = defineScheduledTasks({
    "mail.send": async ({ checkpoint }) => {
      const worker = createMailWorker();
      const page = await worker.runSendPage({
        limit: pageOptions.limit,
        ...(checkpoint === undefined ? {} : { cursor: checkpoint }),
      });
      return {
        nextCheckpoint: page.nextCursor,
        summary: {
          examined: page.examined,
          accepted: page.results.filter(
            (result) => result.status === "accepted",
          ).length,
        },
        more: page.nextCursor !== null,
      };
    },
    "mail.reconcile": async ({ checkpoint }) => {
      const worker = createMailWorker();
      const page = await worker.runReconciliationPage({
        limit: pageOptions.limit,
        ...(checkpoint === undefined ? {} : { cursor: checkpoint }),
      });
      return {
        nextCheckpoint: page.nextCursor,
        summary: { examined: page.examined },
        more: page.nextCursor !== null,
      };
    },
    "mail.terminal-sweep": async ({ checkpoint }) => {
      const page = await supportMail.sweep(store.collection(supportRecords), {
        terminalBefore: pageOptions.terminalBefore,
        limit: pageOptions.limit,
        ...(checkpoint === undefined ? {} : { cursor: checkpoint }),
      });
      return {
        nextCheckpoint: page.nextCursor,
        summary: { deleted: page.deleted },
        more: page.nextCursor !== null,
      };
    },
    "queue.repair": async ({ checkpoint }) => {
      const page = await repairQueueProjectionPage({
        store,
        clock,
        terminalRetentionMilliseconds,
        limit: pageOptions.limit,
        ...(checkpoint === undefined ? {} : { cursor: checkpoint }),
      });
      return {
        nextCheckpoint: page.nextCursor,
        summary: {
          projected: page.projected,
          physical_rows: page.physicalRows,
        },
        more: page.nextCursor !== null,
      };
    },
    "queue.inactive-sweep": async ({ checkpoint }) => {
      const page = await sweepInactiveQueueProjections({
        store,
        clock,
        terminalRetentionMilliseconds,
        limit: pageOptions.limit,
        ...(checkpoint === undefined ? {} : { cursor: checkpoint }),
      });
      return {
        nextCheckpoint: page.nextCursor,
        summary: {
          deleted: page.deleted,
          physical_rows: page.physicalRows,
        },
        more: page.nextCursor !== null,
      };
    },
  });

  const scheduler = createScheduler({
    store,
    clock,
    logger: noopLogger,
    instanceId: options.instanceId ?? "support-desk-example",
    workerId: options.workerId ?? "example-worker",
    tasks,
    leaseMilliseconds: 30_000,
    handlerTimeoutMilliseconds: 25_000,
  });

  const runManualPage = async (
    taskId: keyof SupportDeskScheduledTasks & string,
    limit: number,
    terminalBefore?: IsoTimestamp,
  ) => {
    pageOptions.limit = limit;
    if (terminalBefore !== undefined) {
      pageOptions.terminalBefore = terminalBefore;
    }
    manualSeq += 1;
    return scheduler.runManual(taskId, {
      invocationId: `manual:${taskId}:${String(manualSeq)}`,
    });
  };

  return {
    store,
    clock,
    application,
    scheduler,
    terminalRetentionMilliseconds,
    get sent() {
      return sent;
    },
    createMailWorker,
    async runMailSendPage(limit = 50) {
      const run = requireSucceeded(
        "mail.send",
        await runManualPage("mail.send", limit),
      );
      return {
        examined: run.result.summary?.examined ?? 0,
        accepted: run.result.summary?.accepted ?? 0,
        nextCursor: run.state.checkpoint ?? null,
        run,
      };
    },
    async runMailReconciliationPage(limit = 50) {
      const run = requireSucceeded(
        "mail.reconcile",
        await runManualPage("mail.reconcile", limit),
      );
      return {
        examined: run.result.summary?.examined ?? 0,
        nextCursor: run.state.checkpoint ?? null,
        run,
      };
    },
    async runMailTerminalSweep(terminalBefore, limit = 50) {
      const run = requireSucceeded(
        "mail.terminal-sweep",
        await runManualPage("mail.terminal-sweep", limit, terminalBefore),
      );
      return {
        deleted: run.result.summary?.deleted ?? 0,
        nextCursor: run.state.checkpoint ?? null,
        run,
      };
    },
    async runQueueRepairPage(limit = 50) {
      const run = requireSucceeded(
        "queue.repair",
        await runManualPage("queue.repair", limit),
      );
      return {
        projected: run.result.summary?.projected ?? 0,
        physicalRows: run.result.summary?.physical_rows ?? 0,
        nextCursor: run.state.checkpoint ?? null,
        run,
      };
    },
    async runQueueInactiveSweep(limit = 50) {
      const run = requireSucceeded(
        "queue.inactive-sweep",
        await runManualPage("queue.inactive-sweep", limit),
      );
      return {
        deleted: run.result.summary?.deleted ?? 0,
        physicalRows: run.result.summary?.physical_rows ?? 0,
        nextCursor: run.state.checkpoint ?? null,
        run,
      };
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

  // Host-owned scheduler: one bounded mail-send page at a time until the cycle
  // closes (null checkpoint). The host owns wakeups; this example drives
  // runManual for the demonstration.
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
