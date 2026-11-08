import type {
  CollectionDefinition,
  CollectionStore,
  Store,
} from "@pegma/storage-core";
import {
  createSupportDeskApplication,
  type AssistantAttemptBinding,
  type AssistantTurnClaim,
  type AssistantTurnKey,
  type SupportRecord,
} from "@pegma/support-desk-application";
import { handlingAgent, handlingFixture } from "./handling-fixtures.js";

type ApplicationOptions = Parameters<typeof createSupportDeskApplication>[0];
export type AssistantScanPage = Awaited<
  ReturnType<CollectionStore<SupportRecord>["scan"]>
>;
type ScanOptions = Parameters<CollectionStore<SupportRecord>["scan"]>[0];

/** Intercept real adapter pages; the backing Storage Core store owns all data. */
export function observeAssistantScans(backing: Store) {
  const calls: ScanOptions[] = [];
  let transform: ((page: AssistantScanPage) => AssistantScanPage) | undefined;
  const store: Store = {
    collection<T>(definition: CollectionDefinition<T>) {
      const target = backing.collection(definition);
      return new Proxy(target, {
        get(object, property) {
          if (
            definition.name === "support-desk.records.v1" &&
            property === "scan"
          )
            return async (options: ScanOptions) => {
              calls.push(structuredClone(options));
              const page = await object.scan(options);
              return transform === undefined
                ? page
                : transform(page as unknown as AssistantScanPage);
            };
          const value: unknown = Reflect.get(object, property, object);
          return typeof value === "function" ? value.bind(object) : value;
        },
      });
    },
  };
  return {
    store,
    calls,
    transformPage(handler: typeof transform) {
      transform = handler;
    },
  };
}

export function assistantTurnFixture(
  backing: Store,
  options: Omit<Partial<ApplicationOptions>, "store" | "clock"> = {},
) {
  const configuration = {
    assistantTurns: {
      maxAttempts: 3,
      maxTurnMilliseconds: 60_000,
      maxLeaseMilliseconds: 30_000,
    },
    ...options,
  };
  const f = handlingFixture(backing, configuration);
  return {
    ...f,
    freshApplication() {
      return createSupportDeskApplication({
        store: backing,
        clock: f.clock,
        assistantHandlingEnabled: true,
        ...configuration,
      });
    },
    async candidate(ticketId = "ticket"): Promise<AssistantTurnKey> {
      let cursor: string | undefined;
      for (let pageNumber = 0; pageNumber < 32; pageNumber += 1) {
        const page = await f.app.scanAssistantTurnCandidates(handlingAgent, {
          limit: 100,
          ...(cursor === undefined ? {} : { cursor }),
        });
        const candidate = page.candidates.find(
          (item) => item.ticketId === ticketId,
        );
        if (candidate !== undefined) return candidate;
        if (page.nextCursor === null) break;
        cursor = page.nextCursor;
      }
      throw new Error(`No assistant turn candidate for ${ticketId}`);
    },
    async claim(
      claimId = "claim-1",
      workerId = "worker-1",
      ticketId = "ticket",
      leaseMilliseconds = 10_000,
    ): Promise<AssistantTurnClaim> {
      const key = await this.candidate(ticketId);
      const claim = await f.app.claimAssistantTurn(handlingAgent, {
        ...key,
        workerId,
        claimId,
        leaseMilliseconds,
      });
      if (claim === null) throw new Error("Assistant turn was not claimed");
      return claim;
    },
    binding(
      claim: AssistantTurnClaim,
      overrides: Partial<AssistantAttemptBinding> = {},
    ): AssistantAttemptBinding {
      return {
        inputFingerprint: "a".repeat(64),
        versions: {
          prompt: "synthetic-prompt-v1",
          model: "synthetic-model-v1",
          configuration: "synthetic-configuration-v1",
          audience: "synthetic-audience-v1",
        },
        references: [
          {
            namespace: "knowledge",
            resourceId: "workspace-export",
            revision: "1",
            binding: "b".repeat(64),
          },
        ],
        contextBinding: "c".repeat(64),
        deadline: claim.leaseUntil,
        usageReservationId: "synthetic-usage-reservation",
        ...overrides,
      };
    },
    async prepare(claim: AssistantTurnClaim) {
      const binding = this.binding(claim);
      return f.app.prepareAssistantTurnAttempt(handlingAgent, {
        ...claim.fence,
        binding,
      });
    },
  };
}

export function assistantAnswer(
  claim: AssistantTurnClaim,
  inputFingerprint: string,
) {
  return {
    ...claim.fence,
    inputFingerprint,
    outcome: {
      kind: "answer" as const,
      messageId: "assistant-answer",
      body: "Open Workspace and choose Export.",
    },
  };
}
