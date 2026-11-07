import { TableClient } from "@azure/data-tables";
import { createAzureTablesStore } from "@pegma/storage-azure-tables";
import {
  createMemoryStore,
  type CollectionDefinition,
  type Store,
  type TransactionAction,
  type TransactionOutcome,
} from "@pegma/storage-core";
import {
  createSupportDeskApplication,
  supportPermissions,
  supportRecords,
} from "@pegma/support-desk-application";
import { randomUUID } from "node:crypto";
import {
  EXAMPLE_CUSTOMER,
  EXAMPLE_STAFF,
} from "../examples/composition/composition.js";
import { TABLE_PORT } from "./azurite.js";

function azureStore(): Store {
  const connection = `DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;TableEndpoint=http://127.0.0.1:${TABLE_PORT}/devstoreaccount1;`;
  return createAzureTablesStore({
    client: TableClient.fromConnectionString(
      connection,
      `handling${randomUUID().replaceAll("-", "")}`,
      { allowInsecureConnection: true },
    ),
  });
}

export const handlingStores = [
  ["memory", createMemoryStore],
  ["Azurite", azureStore],
] as const;
export const handlingCustomer = {
  ...EXAMPLE_CUSTOMER,
  permissions: [
    ...EXAMPLE_CUSTOMER.permissions,
    supportPermissions.assistantStart,
    supportPermissions.requestPerson,
    supportPermissions.confirmSuccess,
  ],
};
export const handlingStaff = {
  ...EXAMPLE_STAFF,
  permissions: Object.values(supportPermissions),
};
export const handlingAgent = {
  ...EXAMPLE_STAFF,
  principalId: "assistant/synthetic",
  permissions: [
    supportPermissions.assistantRead,
    supportPermissions.assistantReply,
    supportPermissions.assistantEscalate,
  ],
};

export interface HandlingTransaction {
  readonly collection: string;
  readonly partition: string;
  readonly actions: readonly TransactionAction<unknown>[];
}

/** Observe/pause real Storage Core calls, without any parallel data storage. */
function observe(backing: Store) {
  const transactions: HandlingTransaction[] = [];
  let interceptor:
    | ((
        trace: HandlingTransaction,
        commit: () => Promise<TransactionOutcome>,
      ) => Promise<TransactionOutcome>)
    | undefined;
  const store: Store = {
    collection<T>(definition: CollectionDefinition<T>) {
      const target = backing.collection(definition);
      return new Proxy(target, {
        get(object, property) {
          if (property === "transact")
            return async (
              partition: string,
              actions: readonly TransactionAction<T>[],
            ) => {
              const trace = {
                collection: definition.name,
                partition,
                actions: structuredClone(actions),
              };
              transactions.push(trace);
              const commit = () => object.transact(partition, actions);
              return interceptor === undefined
                ? commit()
                : interceptor(trace, commit);
            };
          const value: unknown = Reflect.get(object, property, object);
          return typeof value === "function" ? value.bind(object) : value;
        },
      });
    },
  };
  return {
    store,
    transactions,
    intercept(handler: typeof interceptor) {
      interceptor = handler;
    },
  };
}

type ApplicationOptions = Parameters<typeof createSupportDeskApplication>[0];
export function handlingFixture(
  backing: Store,
  options: Omit<Partial<ApplicationOptions>, "store" | "clock"> = {},
) {
  const observed = observe(backing);
  let tick = 0;
  let commandOrdinal = 0;
  const clock = {
    now: () =>
      new Date(Date.parse("2026-11-07T15:00:00.000Z") + tick).toISOString(),
  };
  const app = createSupportDeskApplication({
    store: observed.store,
    clock,
    assistantHandlingEnabled: true,
    ...options,
  });
  const command = (prefix: string, ticketId = "ticket") => ({
    commandId: `${prefix}-${++commandOrdinal}`,
    correlationId: "synthetic-handling",
    ticketId,
  });
  const createInput = (managed = true, ticketId = "ticket") => ({
    ...command("create", ticketId),
    messageId: `initial-${ticketId}`,
    subject: "Synthetic workspace export",
    body: "How do I export my workspace?",
    ...(managed ? { initialHandling: "assistant" as const } : {}),
  });
  return {
    app,
    backing,
    store: observed.store,
    observed,
    clock,
    command,
    createInput,
    advance(milliseconds = 1_000) {
      tick += milliseconds;
    },
    rows(ticketId = "ticket") {
      return backing.collection(supportRecords).list(ticketId);
    },
    create(managed = true, ticketId = "ticket") {
      return app.createCustomerTicket(
        handlingCustomer,
        createInput(managed, ticketId),
      );
    },
    async assistantInput(ticketId = "ticket") {
      const current = await app.readAssistantConversation(
        handlingAgent,
        ticketId,
      );
      return {
        ...command("assistant", ticketId),
        messageId: `answer-${commandOrdinal}`,
        body: "Open Workspace and choose Export.",
        expectedRevision: current.revision,
        expectedHandlingGeneration: current.handling.generation,
        triggerMessageId: current.triggerMessageId!,
      };
    },
  };
}

export function handlingBarrier() {
  let announce!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((resolve) => {
    announce = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    reached,
    wait() {
      announce();
      return waiting;
    },
    release() {
      release();
    },
  };
}
