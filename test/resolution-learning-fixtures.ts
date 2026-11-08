import type { AccessContext } from "@pegma/authorization-core";
import type { Store } from "@pegma/storage-core";
import { createHash } from "node:crypto";
import {
  createSupportDeskApplication,
  supportPermissions,
  type ResolutionLearningCandidate,
  type ResolutionLearningChecksBinding,
  type ResolutionLearningClaim,
  type ResolutionLearningModelBinding,
  type ResolutionLearningOptions,
  type ResolutionLearningTarget,
  type ResolutionProductContext,
  type ResolutionTrustContext,
  type ResolutionVerifiedTest,
  type VerifiedResolutionLearningChecks,
} from "@pegma/support-desk-application";
import {
  handlingCustomer,
  handlingFixture,
  handlingStaff,
  handlingStores,
} from "./handling-fixtures.js";

export const learningStores = handlingStores;
export const learningCustomer = handlingCustomer;
export const learningStaff = handlingStaff;
export const learningService: AccessContext = {
  ...handlingStaff,
  principalId: "learning/synthetic-service",
  permissions: Object.values(supportPermissions),
};

type ApplicationOptions = Parameters<typeof createSupportDeskApplication>[0];
type ApplicationConfiguration = Omit<
  Partial<ApplicationOptions>,
  "store" | "clock"
>;
type FixtureOptions = Omit<ApplicationConfiguration, "resolutionLearning"> & {
  readonly resolutionLearning?:
    | {
        readonly [Key in keyof ResolutionLearningOptions]?:
          ResolutionLearningOptions[Key] | undefined;
      }
    | undefined;
};
type ProductOutcome = "verified" | "missing" | "outage" | "expired";
type TestContext = ResolutionTrustContext & {
  readonly product: ResolutionProductContext;
};

function sameTestBinding(expected: TestContext, actual: TestContext): boolean {
  return (
    expected.ticketId === actual.ticketId &&
    expected.ticketRevision === actual.ticketRevision &&
    expected.resolutionCycle === actual.resolutionCycle &&
    expected.resolvedAt === actual.resolvedAt &&
    expected.actorId === actual.actorId &&
    expected.product.productId === actual.product.productId &&
    expected.product.version === actual.product.version &&
    expected.product.buildId === actual.product.buildId &&
    expected.product.binding === actual.product.binding
  );
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value)
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  const encoded = JSON.stringify(value);
  if (encoded === undefined)
    throw new TypeError("Synthetic attestation must contain JSON data");
  return encoded;
}

function applicationConfiguration(
  defaults: ApplicationConfiguration,
  overrides: FixtureOptions,
): ApplicationConfiguration {
  const { resolutionLearning: previous, ...base } = defaults;
  const { resolutionLearning: next, ...rest } = overrides;
  const effective = Object.hasOwn(overrides, "resolutionLearning")
    ? next === undefined
      ? undefined
      : (Object.fromEntries(
          Object.entries({ ...previous, ...next }).filter(
            ([, value]) => value !== undefined,
          ),
        ) as ResolutionLearningOptions)
    : previous;
  return {
    ...base,
    ...rest,
    ...(effective === undefined ? {} : { resolutionLearning: effective }),
  };
}

/** Only external host attestations are fake; real Storage Core owns every row. */
export function resolutionLearningFixture(
  backing: Store,
  options: FixtureOptions = {},
) {
  let productOutcome: ProductOutcome = "verified";
  let productOverrides: Partial<ResolutionProductContext> = {};
  let receiptOrdinal = 0;
  let testOutage = false;
  let checkOutage = false;
  let currentTarget: ResolutionLearningTarget | null = null;
  let currentPolicyVersion = "synthetic-check-policy-v1";
  const productCalls: ResolutionTrustContext[] = [];
  const testCalls: { receipt: string; context: TestContext }[] = [];
  const checkCalls: {
    receipt: string;
    binding: ResolutionLearningChecksBinding;
  }[] = [];
  const tests = new Map<
    string,
    { context: TestContext; result: ResolutionVerifiedTest }
  >();
  const checks = new Map<string, VerifiedResolutionLearningChecks>();
  const productFor = (
    context: ResolutionTrustContext,
  ): ResolutionProductContext => ({
    productId: "workspace",
    version: "2.3.0",
    buildId: "build-verified-230",
    binding: "workspace:2.3.0:build-verified-230",
    contextVersion: "synthetic-product-policy-v1",
    receiptId: `product-receipt-${++receiptOrdinal}:${context.ticketId}:${context.ticketRevision}:${context.resolutionCycle}`,
    verifiedAt: context.acceptedAt,
    validUntil: new Date(
      Date.parse(context.acceptedAt) +
        (productOutcome === "expired" ? -1 : 60_000),
    ).toISOString(),
    ...productOverrides,
  });
  const learningOptions: ResolutionLearningOptions = {
    enabled: true,
    productContext: {
      async resolve(context, signal) {
        productCalls.push(structuredClone(context));
        if (signal.aborted) return null;
        if (productOutcome === "outage")
          throw new Error("Synthetic host outage");
        if (productOutcome === "missing") return null;
        return productFor(context);
      },
    },
    testReceipts: {
      async verify(receipt, context, signal) {
        testCalls.push({ receipt, context: structuredClone(context) });
        if (testOutage) throw new Error("Synthetic test verifier outage");
        if (signal.aborted) return null;
        const issued = tests.get(receipt);
        return issued !== undefined && sameTestBinding(issued.context, context)
          ? structuredClone(issued.result)
          : null;
      },
    },
    checks: {
      async verify(receipt, binding) {
        checkCalls.push({ receipt, binding: structuredClone(binding) });
        if (checkOutage) throw new Error("Synthetic checks outage");
        const issued = checks.get(receipt);
        if (
          issued === undefined ||
          binding.policyVersion !== currentPolicyVersion ||
          canonicalJson(issued.binding) !== canonicalJson(binding)
        )
          return null;
        return structuredClone(issued);
      },
    },
  };
  const configuration = applicationConfiguration(
    { resolutionLearning: learningOptions },
    options,
  );
  const f = handlingFixture(backing, configuration);
  const source = (ticketId = "ticket") =>
    f.app.readResolutionLearningSource(learningStaff, ticketId);
  return {
    ...f,
    learningOptions,
    trust: {
      productCalls,
      testCalls,
      checkCalls,
      productFor,
      setProductOutcome(value: ProductOutcome) {
        productOutcome = value;
      },
      setProduct(overrides: Partial<ResolutionProductContext>) {
        productOverrides = overrides;
      },
      setTestOutage(value: boolean) {
        testOutage = value;
      },
      setCheckOutage(value: boolean) {
        checkOutage = value;
      },
      issueTest(
        receipt: string,
        context: TestContext,
        overrides: Partial<ResolutionVerifiedTest> = {},
      ): ResolutionVerifiedTest {
        const result: ResolutionVerifiedTest = {
          executionId: "synthetic-export-execution-1",
          runnerId: "trusted-staging-runner",
          testId: "workspace-export-download",
          productBinding: context.product.binding,
          executedAt: context.acceptedAt,
          receiptId: receipt,
          verifiedAt: context.acceptedAt,
          validUntil: new Date(
            Date.parse(context.acceptedAt) + 60_000,
          ).toISOString(),
          ...overrides,
        };
        tests.set(receipt, {
          context: structuredClone(context),
          result: structuredClone(result),
        });
        return result;
      },
      issueChecks(
        receipt: string,
        binding: ResolutionLearningChecksBinding,
      ): VerifiedResolutionLearningChecks {
        const result: VerifiedResolutionLearningChecks = {
          binding: structuredClone(binding),
          privacy: "passed",
          factual: "passed",
          applicability: "passed",
          duplication: "passed",
          verifierReceiptId: receipt,
          verifierVersion: "synthetic-independent-verifier-v1",
          verifiedAt: f.clock.now(),
          validUntil: new Date(
            Date.parse(f.clock.now()) + 60_000,
          ).toISOString(),
        };
        checks.set(receipt, result);
        return result;
      },
      setPolicyVersion(value: string) {
        currentPolicyVersion = value;
      },
      setTarget(value: ResolutionLearningTarget | null) {
        currentTarget = value === null ? null : structuredClone(value);
      },
      targetGuard(expected: ResolutionLearningTarget) {
        return async () => {
          if (canonicalJson(currentTarget) !== canonicalJson(expected))
            throw new Error("Current target binding changed");
        };
      },
    },
    source,
    async work(ticketId = "ticket", sourceGeneration?: number) {
      const generation =
        sourceGeneration ?? (await source(ticketId)).sourceGeneration;
      return f.app.readResolutionLearningWork(learningStaff, {
        ticketId,
        sourceGeneration: generation,
      });
    },
    freshApplication(overrides: FixtureOptions = {}) {
      return createSupportDeskApplication({
        store: f.store,
        clock: f.clock,
        assistantHandlingEnabled: true,
        ...applicationConfiguration(configuration, overrides),
      });
    },
    async terminal(ticketId = "ticket", closed = false, managed = true) {
      await f.app.createCustomerTicket(learningCustomer, {
        ...f.createInput(managed, ticketId),
        requesterEmail: "customer@fixtures.invalid",
      });
      let solutionMessageId: string;
      if (managed) {
        const answer = await f.assistantInput(ticketId);
        await f.app.replyAsAssistant(
          {
            ...learningService,
            principalId: "assistant/synthetic",
          },
          answer,
        );
        solutionMessageId = answer.messageId;
      } else {
        solutionMessageId = `solution-${ticketId}`;
        await f.app.replyAsStaff(learningStaff, {
          ...f.command("solution", ticketId),
          messageId: solutionMessageId,
          body: "Open Workspace and choose Export.",
        });
      }
      await f.app.resolveTicket(learningStaff, f.command("resolve", ticketId));
      if (closed)
        await f.app.closeTicket(learningStaff, f.command("close", ticketId));
      return {
        ticket: (await f.app.readStaffTicket(learningStaff, ticketId)).ticket,
        source: await source(ticketId),
        solutionMessageId,
      };
    },
    async confirm(ticketId = "ticket", lastSeenVisibleMessageId?: string) {
      const detail = await f.app.readCustomerTicket(learningCustomer, ticketId);
      const command = {
        ...f.command("confirm", ticketId),
        lastSeenVisibleMessageId:
          lastSeenVisibleMessageId ?? detail.messages.at(-1)!.id,
      };
      const result = await f.app.confirmCustomerSuccess(
        learningCustomer,
        command,
      );
      return { command, result, source: await source(ticketId) };
    },
    async candidate(ticketId = "ticket") {
      return {
        ticketId,
        sourceGeneration: (await source(ticketId)).sourceGeneration,
      };
    },
    async claim(
      claimId = "learning-claim-1",
      workerId = "learning-worker-1",
      ticketId = "ticket",
      leaseMilliseconds = 10_000,
    ): Promise<ResolutionLearningClaim> {
      const claim = await f.app.claimResolutionLearningWork(learningService, {
        ticketId,
        sourceGeneration: (await source(ticketId)).sourceGeneration,
        workerId,
        claimId,
        leaseMilliseconds,
      });
      if (claim === null)
        throw new Error("Resolution learning work was not claimed");
      return claim;
    },
    modelBinding(
      claim: ResolutionLearningClaim,
      overrides: Partial<ResolutionLearningModelBinding> = {},
    ): ResolutionLearningModelBinding {
      const product = claim.work.product!;
      const inputManifest: ResolutionLearningModelBinding["inputManifest"] = {
        messages: claim.messages.map(({ messageId, ordinal }) => ({
          messageId,
          ordinal,
        })),
        workingSolutionMessageIds: claim.workingSolutionMessageIds,
        product: {
          productId: product.productId,
          version: product.version,
          buildId: product.buildId,
          binding: product.binding,
          contextVersion: product.contextVersion,
        },
      };
      return {
        inputManifest,
        inputFingerprint: "a".repeat(64),
        inputManifestHash: createHash("sha256")
          .update(canonicalJson(inputManifest))
          .digest("hex"),
        configVersion: "synthetic-learning-config-v1",
        promptVersion: "synthetic-learning-prompt-v1",
        modelVersion: "synthetic-model-v1",
        checkPolicyVersion: currentPolicyVersion,
        budgetsHash: "c".repeat(64),
        usageReservationId: `usage-${claim.fence.claimId}`,
        deadline: claim.leaseUntil,
        ...overrides,
      };
    },
    async prepareCandidate(claim?: ResolutionLearningClaim) {
      const active = claim ?? (await this.claim());
      const prepared = await f.app.prepareResolutionLearningStep(
        learningService,
        {
          ...active.fence,
          step: "model",
          binding: this.modelBinding(active),
        },
      );
      const candidate: ResolutionLearningCandidate = {
        problem: "Export a workspace to a downloadable file.",
        applicability: {
          productId: "workspace",
          version: "2.3.0",
          buildId: "build-verified-230",
        },
        steps: ["Open Workspace.", "Choose Export."],
        solution: "Download the completed workspace export.",
        validationRequirements: ["Verify that the downloaded export opens."],
      };
      const acknowledgement = await f.app.completeResolutionLearningStep(
        learningService,
        {
          ...active.fence,
          stepId: prepared.stepId,
          requestHash: prepared.requestHash,
          step: "model",
          candidate,
          accounting: "accounted",
        },
        async () => {},
      );
      const work = await f.app.readResolutionLearningWork(
        learningStaff,
        active.fence,
      );
      return {
        claim: active,
        prepared,
        candidate,
        work,
        candidateHash: acknowledgement.candidateHash!,
      };
    },
  };
}
