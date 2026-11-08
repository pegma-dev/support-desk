import type { AccessContext } from "@pegma/authorization-core";
import type { Store } from "@pegma/storage-core";
import {
  createSupportDeskApplication,
  supportPermissions,
  type EngineeringCandidate,
  type EngineeringClaim,
  type EngineeringEvidenceInput,
  type EngineeringDispatchProofBinding,
  type EngineeringExportChecksBinding,
  type EngineeringExportRequest,
  type EngineeringFailedTest,
  type EngineeringModelBinding,
  type EngineeringOptions,
  type EngineeringProductContext,
  type EngineeringRepositoryDescriptor,
  type EngineeringRepositoryObservation,
  type EngineeringRepositoryPolicy,
  type EngineeringRoutingBinding,
  type EngineeringSecurity,
  type EngineeringTrustContext,
  type VerifiedEngineeringExportChecks,
  type VerifiedEngineeringRouting,
  type VerifiedEngineeringDispatchResult,
} from "@pegma/support-desk-application";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { vi } from "vitest";
import { createSupportDeskEngineering } from "../packages/ai/src/engineering-coordinator.js";
import type {
  EngineeringBudgets,
  EngineeringChecksPort,
  EngineeringConfigurationPort,
  EngineeringGitHubPort,
  EngineeringModelPort,
  EngineeringModelResult,
  EngineeringProposalPort,
  EngineeringRoutingPort,
  EngineeringServiceAuthority,
  EngineeringUsagePort,
  SupportDeskEngineeringOptions,
  VerifiedEngineeringCalibration,
  VerifiedEngineeringConfiguration,
} from "../packages/ai/src/engineering-ports.js";
import {
  handlingBarrier,
  handlingCustomer,
  handlingFixture,
  handlingStaff,
  handlingStores,
} from "./handling-fixtures.js";
import {
  engineeringExportChecksBinding,
  engineeringModelManifestHash,
  engineeringRoutingBinding,
  engineeringRoutingBindingHash,
} from "../packages/application/src/engineering-work.js";

export const engineeringStores = handlingStores;
export const engineeringBarrier = handlingBarrier;
export const engineeringCustomer = handlingCustomer;
export const engineeringStaff = handlingStaff;
export const engineeringAdmin: AccessContext = {
  ...handlingStaff,
  principalId: "engineering/synthetic-admin",
};
export const engineeringService: AccessContext = {
  ...handlingStaff,
  principalId: "engineering/synthetic-service",
  permissions: [
    supportPermissions.queueRead,
    supportPermissions.engineeringRead,
    supportPermissions.engineeringProcess,
    supportPermissions.engineeringReconcile,
    supportPermissions.engineeringPolicyRead,
  ],
};
export const engineeringRepositories: readonly EngineeringRepositoryDescriptor[] =
  [
    {
      repositoryId: "repository-101",
      owner: "synthetic-org",
      name: "workspace-core",
      visibility: "private",
      responsibilities: "Workspace export creation and file generation.",
      product: "workspace",
      component: "export",
      version: "2.x",
      allowedLabels: ["bug", "export"],
      allowedTemplates: ["bug-report"],
      publicationMode: "approval_required",
      enabled: true,
    },
    {
      repositoryId: "repository-202",
      owner: "synthetic-org",
      name: "workspace-api",
      visibility: "private",
      responsibilities: "Workspace export requests and file download API.",
      product: "workspace",
      component: "export",
      version: "2.x",
      allowedLabels: ["bug", "api"],
      allowedTemplates: ["bug-report"],
      publicationMode: "approval_required",
      enabled: true,
    },
  ];

type ApplicationOptions = Parameters<typeof createSupportDeskApplication>[0];
type Configuration = Omit<Partial<ApplicationOptions>, "store" | "clock">;
type FixtureOptions = Omit<Configuration, "engineering"> & {
  readonly engineering?:
    | {
        readonly [Key in keyof EngineeringOptions]?:
          EngineeringOptions[Key] | undefined;
      }
    | undefined;
  readonly initialBody?: string;
  readonly notificationBody?: string;
  readonly privateNote?: string;
};
type TestContext = Parameters<
  NonNullable<EngineeringOptions["testReceipts"]>["verify"]
>[1];
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value)
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  const encoded = JSON.stringify(value);
  if (encoded === undefined)
    throw new TypeError("Engineering fixture requires JSON data");
  return encoded;
}
const digest = (value: unknown) =>
  createHash("sha256").update(canonical(value)).digest("hex");
function configure(
  defaults: Configuration,
  options: FixtureOptions,
): Configuration {
  const { engineering: previous, ...base } = defaults;
  const {
    engineering: next,
    initialBody: _body,
    notificationBody: _notification,
    privateNote: _note,
    ...rest
  } = options;
  const effective = Object.hasOwn(options, "engineering")
    ? next === undefined
      ? undefined
      : (Object.fromEntries(
          Object.entries({ ...previous, ...next }).filter(
            ([, value]) => value !== undefined,
          ),
        ) as EngineeringOptions)
    : previous;
  return {
    ...base,
    ...rest,
    ...(effective === undefined ? {} : { engineering: effective }),
  };
}

/** Real Storage Core owns all state; only external host attestations are scripted. */
export function engineeringFixture(
  backing: Store,
  options: FixtureOptions = {},
) {
  let attestationOrdinal = 0;
  const productCalls: EngineeringTrustContext[] = [];
  const testCalls: {
    readonly receipt: string;
    readonly context: TestContext;
  }[] = [];
  const routingCalls: {
    readonly receipt: string;
    readonly binding: EngineeringRoutingBinding;
  }[] = [];
  const checkCalls: {
    readonly receipt: string;
    readonly binding: EngineeringExportChecksBinding;
  }[] = [];
  const trustState = {
    productOutcome: "verified" as "verified" | "missing" | "outage",
    productOverrides: {} as Partial<EngineeringProductContext>,
    testOutage: false,
    trustedRunnerIds: ["trusted-failing-test-runner"],
    routingOutage: false,
    checksOutage: false,
  };
  const tests = new Map<
    string,
    { readonly context: TestContext; readonly result: EngineeringFailedTest }
  >();
  const routing = new Map<string, VerifiedEngineeringRouting>();
  const checks = new Map<string, VerifiedEngineeringExportChecks>();
  const dispatchProofs = new Map<string, VerifiedEngineeringDispatchResult>();
  const metadata = new Map<string, EngineeringRepositoryObservation>(
    engineeringRepositories.map((repository) => [
      repository.repositoryId,
      {
        repositoryId: repository.repositoryId,
        owner: repository.owner,
        name: repository.name,
        visibility: repository.visibility,
        installationBinding: `synthetic-installation:${repository.repositoryId}`,
        metadataVersion: "repository-metadata-v1",
      },
    ]),
  );
  const productFor = (
    context: EngineeringTrustContext,
  ): EngineeringProductContext => ({
    productId: "workspace",
    version: "2.3.0",
    buildId: "build-verified-230",
    binding: "workspace:2.3.0:build-verified-230",
    contextVersion: "trusted-product-context-v1",
    receiptId: `engineering-product-${++attestationOrdinal}:${context.ticketId}:${context.ticketRevision}:${context.sourceGeneration}`,
    verifiedAt: context.acceptedAt,
    validUntil: new Date(Date.parse(context.acceptedAt) + 60_000).toISOString(),
    ...trustState.productOverrides,
  });
  const engineeringOptions: EngineeringOptions = {
    enabled: true,
    productContext: {
      async resolve(context, signal) {
        productCalls.push(structuredClone(context));
        if (signal.aborted || trustState.productOutcome === "missing")
          return null;
        if (trustState.productOutcome === "outage")
          throw new Error("Synthetic product verifier outage");
        return productFor(context);
      },
    },
    testReceipts: {
      async verify(receipt, context, signal) {
        testCalls.push({ receipt, context: structuredClone(context) });
        if (signal.aborted) return null;
        if (trustState.testOutage)
          throw new Error("Synthetic test verifier outage");
        const issued = tests.get(receipt);
        if (
          issued === undefined ||
          !trustState.trustedRunnerIds.includes(issued.result.runnerId)
        )
          return null;
        const selected = (value: TestContext) => ({
          ticketId: value.ticketId,
          ticketRevision: value.ticketRevision,
          sourceGeneration: value.sourceGeneration,
          actorId: value.actorId,
          productId: value.product.productId,
          version: value.product.version,
          buildId: value.product.buildId,
          binding: value.product.binding,
          evidence: value.evidence,
        });
        return isDeepStrictEqual(selected(issued.context), selected(context))
          ? structuredClone(issued.result)
          : null;
      },
    },
    routing: {
      async verify(receipt, binding) {
        routingCalls.push({ receipt, binding: structuredClone(binding) });
        if (trustState.routingOutage)
          throw new Error("Synthetic routing verifier outage");
        const issued = routing.get(receipt);
        return issued !== undefined &&
          isDeepStrictEqual(issued.binding, binding)
          ? structuredClone(issued)
          : null;
      },
    },
    checks: {
      async verify(receipt, binding) {
        checkCalls.push({ receipt, binding: structuredClone(binding) });
        if (trustState.checksOutage)
          throw new Error("Synthetic check verifier outage");
        const issued = checks.get(receipt);
        return issued !== undefined &&
          isDeepStrictEqual(issued.binding, binding)
          ? structuredClone(issued)
          : null;
      },
    },
    repositoryMetadata: {
      async resolve(repositoryId, signal) {
        const current = metadata.get(repositoryId);
        return signal.aborted || current === undefined
          ? null
          : structuredClone(current);
      },
    },
    dispatchResults: {
      async verify(binding, signal) {
        const issued = dispatchProofs.get(digest(binding));
        return signal.aborted || issued === undefined
          ? null
          : structuredClone(issued);
      },
    },
  };
  const configuration = configure({ engineering: engineeringOptions }, options);
  const f = handlingFixture(backing, configuration);
  const policyCommand = (label: string, expectedGeneration = 0) => {
    const { ticketId: _ticketId, ...command } = f.command(label);
    return { ...command, expectedGeneration };
  };
  const source = (ticketId = "ticket") =>
    f.app.readEngineeringSource(engineeringStaff, ticketId);
  const createInput = (managed = false, ticketId = "ticket") => ({
    ...f.createInput(managed, ticketId),
    body:
      options.initialBody ??
      "Export produces an empty file instead of the workspace rows.",
    requesterEmail: "engineering-customer@fixtures.invalid",
  });
  return {
    ...f,
    engineeringOptions,
    policyCommand,
    createInput,
    create(managed = false, ticketId = "ticket") {
      return f.app.createCustomerTicket(
        engineeringCustomer,
        createInput(managed, ticketId),
      );
    },
    freshApplication(overrides: FixtureOptions = {}) {
      return createSupportDeskApplication({
        store: f.store,
        clock: f.clock,
        assistantHandlingEnabled: true,
        ...configure(configuration, overrides),
      });
    },
    source,
    async work(ticketId = "ticket", sourceGeneration?: number) {
      return f.app.readEngineeringWork(engineeringStaff, {
        ticketId,
        sourceGeneration:
          sourceGeneration ?? (await source(ticketId)).sourceGeneration,
      });
    },
    policy() {
      return f.app.readRepositoryPolicy(engineeringAdmin);
    },
    async putPolicy(policy: Partial<EngineeringRepositoryPolicy> = {}) {
      const current = await f.app.readRepositoryPolicy(engineeringAdmin);
      return f.app.putRepositoryPolicy(engineeringAdmin, {
        ...policyCommand("repository-policy", current.generation),
        policy: {
          enabled: true,
          repositories: structuredClone(engineeringRepositories),
          ...policy,
        },
      });
    },
    async enroll(ticketId = "ticket") {
      const ticket = (await f.app.readStaffTicket(engineeringStaff, ticketId))
        .ticket;
      return f.app.enrollEngineeringSource(engineeringStaff, {
        ...f.command("engineering-enroll", ticketId),
        expectedRevision: ticket.revision,
      });
    },
    async reportInput(
      ticketId = "ticket",
    ): Promise<
      EngineeringEvidenceInput & { readonly kind: "staff_verified_failure" }
    > {
      const visible = await f.app.readCustomerTicket(
        engineeringCustomer,
        ticketId,
      );
      return {
        kind: "staff_verified_failure",
        expectedBehavior: "Export contains the workspace rows.",
        actualBehavior: "Export contains no rows.",
        reproductionSteps: [
          "Create a synthetic workspace with two rows.",
          "Choose Export and inspect the downloaded file.",
        ],
        visibleMessageIds: visible.messages.map((message) => message.id),
        verificationReference: "PRIVATE_ENGINEERING_VERIFICATION_REFERENCE",
      };
    },
    async eligible(
      kind: "staff_verified_failure" | "failed_test" = "staff_verified_failure",
      ticketId = "ticket",
      security: EngineeringSecurity = "ordinary",
    ) {
      if (!(await f.rows(ticketId)).some((row) => row.kind === "ticket"))
        await this.create(false, ticketId);
      await this.enroll(ticketId);
      if ((await this.policy()).generation === 0) await this.putPolicy();
      if (options.notificationBody !== undefined) {
        await f.app.resolveTicket(engineeringStaff, {
          ...f.command("visible-notification", ticketId),
          messageId: `notification:${ticketId}`,
          body: options.notificationBody,
        });
        await f.app.reopenTicket(
          engineeringStaff,
          f.command("active-after-visible-notification", ticketId),
        );
      }
      await f.app.addNote(engineeringStaff, {
        ...f.command("private-note", ticketId),
        messageId: `private-note:${ticketId}`,
        body: options.privateNote ?? "PRIVATE_ENGINEERING_INTERNAL_NOTE",
      });
      const ticket = (await f.app.readStaffTicket(engineeringStaff, ticketId))
        .ticket;
      const report = await this.reportInput(ticketId);
      const command = {
        ...f.command("engineering-proof", ticketId),
        expectedRevision: ticket.revision,
        security,
      };
      if (kind === "staff_verified_failure")
        await f.app.submitEngineeringEvidence(engineeringStaff, {
          ...command,
          evidence: report,
        });
      else {
        const context: EngineeringTrustContext = {
          ticketId,
          ticketRevision: ticket.revision,
          sourceGeneration: (await source(ticketId)).sourceGeneration,
          actorId: engineeringStaff.principalId,
          acceptedAt: f.clock.now(),
        };
        const receipt = `trusted-failing-test:${ticketId}`;
        const {
          verificationReference: _reference,
          kind: _kind,
          ...mismatch
        } = report;
        this.trust.issueTest(receipt, {
          ...context,
          product: productFor(context),
          evidence: mismatch,
        });
        await f.app.submitEngineeringEvidence(engineeringStaff, {
          ...command,
          evidence: { ...mismatch, kind, receipt },
        });
      }
      return {
        ticketId,
        sourceGeneration: (await source(ticketId)).sourceGeneration,
      };
    },
    async claim(
      claimId = "engineering-claim-1",
      workerId = "engineering-worker-1",
      ticketId = "ticket",
      leaseMilliseconds = 10_000,
    ): Promise<EngineeringClaim> {
      const claim = await f.app.claimEngineeringWork(engineeringService, {
        ticketId,
        sourceGeneration: (await source(ticketId)).sourceGeneration,
        claimId,
        workerId,
        leaseMilliseconds,
      });
      if (claim === null) throw new Error("Engineering work was not claimed");
      return claim;
    },
    trust: {
      state: trustState,
      productCalls,
      testCalls,
      routingCalls,
      checkCalls,
      productFor,
      metadata,
      issueTest(
        receipt: string,
        context: TestContext,
        overrides: Partial<EngineeringFailedTest> = {},
      ) {
        const result: EngineeringFailedTest = {
          result: "failed",
          executionId: "synthetic-failed-export-execution",
          runnerId: "trusted-failing-test-runner",
          testId: "workspace-export-rows",
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
      revokeTest(receipt: string) {
        tests.delete(receipt);
      },
      issueRouting(
        receipt: string,
        binding: EngineeringRoutingBinding,
        outcome: VerifiedEngineeringRouting["outcome"] = "accepted",
        overrides: Partial<VerifiedEngineeringRouting> = {},
      ) {
        const result: VerifiedEngineeringRouting = {
          binding: structuredClone(binding),
          outcome,
          verifierReceiptId: receipt,
          verifierVersion: "trusted-routing-calibration-v1",
          verifiedAt: f.clock.now(),
          validUntil: new Date(
            Date.parse(f.clock.now()) + 60_000,
          ).toISOString(),
          ...overrides,
        };
        routing.set(receipt, result);
        return result;
      },
      revokeRouting(receipt: string) {
        routing.delete(receipt);
      },
      issueChecks(
        receipt: string,
        binding: EngineeringExportChecksBinding,
        overrides: Partial<VerifiedEngineeringExportChecks> = {},
      ) {
        const result: VerifiedEngineeringExportChecks = {
          binding: structuredClone(binding),
          privacy: "passed",
          factual: "passed",
          security: "clear",
          publicReproduction: "not_applicable",
          verifierReceiptId: receipt,
          verifierVersion: "trusted-independent-export-checks-v1",
          verifiedAt: f.clock.now(),
          validUntil: new Date(
            Date.parse(f.clock.now()) + 60_000,
          ).toISOString(),
          ...overrides,
        };
        checks.set(receipt, result);
        return result;
      },
      revokeChecks(receipt: string) {
        checks.delete(receipt);
      },
      issueDispatch(binding: EngineeringDispatchProofBinding) {
        const result: VerifiedEngineeringDispatchResult = {
          binding: structuredClone(binding),
          verifierReceiptId: `trusted-dispatch-proof:${++attestationOrdinal}`,
          verifierVersion: "trusted-github-reconciliation-v1",
          verifiedAt: f.clock.now(),
          validUntil: new Date(
            Date.parse(f.clock.now()) + 60_000,
          ).toISOString(),
        };
        dispatchProofs.set(digest(binding), result);
        return result;
      },
      revokeDispatch(binding: EngineeringDispatchProofBinding) {
        dispatchProofs.delete(digest(binding));
      },
    },
    candidate(
      overrides: Partial<EngineeringCandidate> = {},
    ): EngineeringCandidate {
      return {
        title: "Workspace export produces an empty file",
        summary: "A synthetic workspace export omits its rows.",
        expectedBehavior: "The exported file includes the workspace rows.",
        actualBehavior: "The file contains no rows.",
        reproductionSteps: [
          "Create a synthetic workspace with two rows.",
          "Choose Export and inspect the downloaded file.",
        ],
        applicability: {
          productId: "workspace",
          version: "2.3.0",
          buildId: "build-verified-230",
        },
        security: "ordinary",
        routing: {
          outcome: "selected",
          repositoryId: engineeringRepositories[0]!.repositoryId,
          alternativeRepositoryIds: [],
          rationale: "The repository owns workspace export generation.",
        },
        ...overrides,
      };
    },
    async modelBinding(
      claim: EngineeringClaim,
      overrides: Partial<EngineeringModelBinding> = {},
    ): Promise<EngineeringModelBinding> {
      const product = claim.work.product!;
      const accepted = await source(claim.fence.ticketId);
      const inputManifest: EngineeringModelBinding["inputManifest"] = {
        messages: claim.messages.map(({ messageId, ordinal }) => ({
          messageId,
          ordinal,
        })),
        evidenceFingerprint: accepted.evidenceFingerprint!,
        product: {
          productId: product.productId,
          version: product.version,
          buildId: product.buildId,
          binding: product.binding,
          contextVersion: product.contextVersion,
        },
        policyGeneration: claim.policy.generation,
        policyHash: claim.policy.policyHash,
        repositoryIds: claim.policy.policy.repositories
          .filter((repository) => repository.enabled)
          .map((repository) => repository.repositoryId),
      };
      return {
        inputManifest,
        inputFingerprint: "a".repeat(64),
        inputManifestHash: await engineeringModelManifestHash(inputManifest),
        configVersion: "engineering-config-v1",
        promptVersion: "engineering-prompt-v1",
        modelVersion: "engineering-model-v1",
        parserVersion: "engineering-parser-v1",
        checkPolicyVersion: "engineering-check-policy-v1",
        budgetsHash: "b".repeat(64),
        usageReservationId: `engineering-usage:${claim.fence.claimId}`,
        deadline: claim.leaseUntil,
        ...overrides,
      };
    },
    async prepareCandidate(owner?: EngineeringClaim) {
      const claim = owner ?? (await this.claim());
      const prepared = await f.app.prepareEngineeringModel(engineeringService, {
        ...claim.fence,
        binding: await this.modelBinding(claim),
      });
      const candidate = this.candidate();
      const result = await f.app.completeEngineeringModel(
        engineeringService,
        {
          ...claim.fence,
          stepId: prepared.stepId,
          requestHash: prepared.requestHash,
          candidate,
          accounting: "accounted",
        },
        async () => {},
      );
      return {
        owner: claim,
        prepared,
        candidate,
        candidateHash: result.candidateHash!,
        result,
      };
    },
    exactRequest(
      overrides: Partial<EngineeringExportRequest> = {},
    ): EngineeringExportRequest {
      const repository = engineeringRepositories[0]!;
      const common = {
        repository: overrides.repository ?? {
          repositoryId: repository.repositoryId,
          owner: repository.owner,
          name: repository.name,
          visibility: repository.visibility,
          installationBinding: "synthetic-installation:repository-101",
          metadataVersion: "repository-metadata-v1",
        },
        bundle: overrides.bundle ?? {
          title: "Workspace export produces an empty file",
          body: "Synthetic reproduction: create two workspace rows, export, and observe an empty file instead of those rows.\nExport marker: opaque-engineering-export-marker",
          labels: ["bug"],
          templateId: "bug-report",
          evidenceReferences: ["synthetic-reproduction-evidence"],
          exportMarker: "opaque-engineering-export-marker",
        },
      };
      if (overrides.operation === "link_existing_issue") {
        if (
          overrides.issueId === undefined ||
          overrides.issueNumber === undefined
        )
          throw new TypeError(
            "An existing issue request requires its exact issue ID and number",
          );
        return {
          ...common,
          operation: "link_existing_issue",
          issueId: overrides.issueId,
          issueNumber: overrides.issueNumber,
        };
      }
      return { ...common, operation: "create_issue" };
    },
    async prepareProposal(
      options: {
        readonly owner?: EngineeringClaim;
        readonly request?: EngineeringExportRequest;
        readonly routingOverrides?: Partial<VerifiedEngineeringRouting>;
        readonly checksOverrides?: Partial<VerifiedEngineeringExportChecks>;
      } = {},
    ) {
      const model = await this.prepareCandidate(options.owner);
      const owner = await this.claim(
        "engineering-proposal-claim",
        model.owner.fence.workerId,
        model.owner.fence.ticketId,
      );
      const accepted = await source(owner.fence.ticketId);
      const work = await this.work(
        owner.fence.ticketId,
        owner.fence.sourceGeneration,
      );
      const modelBinding = work.modelAttempts.at(-1)!.binding;
      const request = options.request ?? this.exactRequest();
      const routingBinding = await engineeringRoutingBinding({
        sourceBindingHash: accepted.sourceBindingHash!,
        evidenceFingerprint: accepted.evidenceFingerprint!,
        candidateHash: model.candidateHash,
        inputFingerprint: modelBinding.inputFingerprint,
        routing: model.candidate.routing,
        policyGeneration: owner.policy.generation,
        policyHash: owner.policy.policyHash,
        modelVersion: modelBinding.modelVersion,
        promptVersion: modelBinding.promptVersion,
        parserVersion: modelBinding.parserVersion,
        repositoryId: request.repository.repositoryId,
      });
      const routingReceipt = `trusted-proposal-routing:${owner.fence.sourceGeneration}`;
      this.trust.issueRouting(
        routingReceipt,
        routingBinding,
        "accepted",
        options.routingOverrides,
      );
      const checksBinding = await engineeringExportChecksBinding({
        sourceBindingHash: accepted.sourceBindingHash!,
        evidenceFingerprint: accepted.evidenceFingerprint!,
        candidateHash: model.candidateHash,
        routingBindingHash: await engineeringRoutingBindingHash(routingBinding),
        exactRequest: request,
        policyGeneration: owner.policy.generation,
        policyHash: owner.policy.policyHash,
      });
      const checksReceipt = `trusted-proposal-checks:${owner.fence.sourceGeneration}`;
      this.trust.issueChecks(checksReceipt, checksBinding, {
        publicReproduction:
          request.repository.visibility === "public"
            ? "passed"
            : "not_applicable",
        ...options.checksOverrides,
      });
      const prepared = await f.app.prepareEngineeringProposal(
        engineeringService,
        {
          ...owner.fence,
          candidateHash: model.candidateHash,
          routingReceipt,
          checksReceipt,
          exactRequest: request,
          policyGeneration: owner.policy.generation,
          policyHash: owner.policy.policyHash,
        },
        async () => {},
      );
      const actual = await this.work(
        owner.fence.ticketId,
        owner.fence.sourceGeneration,
      );
      return {
        owner,
        preparedModel: model.prepared,
        candidate: model.candidate,
        candidateHash: model.candidateHash,
        request,
        prepared,
        proposal: actual.proposal!,
        work: actual,
        routingReceipt,
        checksReceipt,
        routingBinding,
        checksBinding,
      };
    },
    async approve(ticketId = "ticket") {
      const accepted = await source(ticketId);
      const work = await this.work(ticketId, accepted.sourceGeneration);
      if (work.proposal === undefined)
        throw new Error("Engineering proposal is not prepared");
      return f.app.reviewEngineeringProposal(
        engineeringStaff,
        {
          ...f.command("approve-engineering-proposal", ticketId),
          sourceGeneration: accepted.sourceGeneration,
          expectedWorkGeneration: work.workGeneration,
          proposalHash: work.proposal.proposalHash,
          decision: "approve",
        },
        async () => {},
      );
    },
  };
}

type AiFixtureOptions = FixtureOptions & {
  readonly eligible?: boolean;
  readonly evidenceKind?: "staff_verified_failure" | "failed_test";
  readonly security?: EngineeringSecurity;
  readonly repositoryPolicy?: Partial<EngineeringRepositoryPolicy>;
  readonly managed?: boolean;
};

/** The real optional coordinator over public services, with only external ports fake. */
export async function engineeringAiFixture(
  backing: Store,
  options: AiFixtureOptions = {},
) {
  const {
    eligible: acceptEvidence = true,
    evidenceKind = "staff_verified_failure",
    security = "ordinary",
    repositoryPolicy,
    managed = false,
    ...fixtureOptions
  } = options;
  let f: ReturnType<typeof engineeringFixture>;
  let receiptOrdinal = 0;
  const routingResolve = vi.fn<EngineeringRoutingPort["resolve"]>(async () =>
    state.calibrationOutcome === "ready"
      ? { outcome: "ready", calibration: structuredClone(state.calibration) }
      : { outcome: "unavailable" },
  );
  const routingCheck = vi.fn<EngineeringRoutingPort["check"]>(
    async ({ binding }) => {
      if (state.routingOutcome !== "checked")
        return { outcome: state.routingOutcome };
      const receipt = `engineering-routing-receipt:${++receiptOrdinal}`;
      f.trust.issueRouting(
        receipt,
        binding,
        state.routingVerifiedOutcome,
        state.routingReceiptOverrides,
      );
      return { outcome: "checked", receipt };
    },
  );
  const routingVerify = vi.fn<EngineeringRoutingPort["verify"]>(
    (receipt, binding) =>
      f.engineeringOptions.routing!.verify(receipt, binding),
  );
  const checksResolve = vi.fn<EngineeringChecksPort["resolvePolicy"]>(
    async () =>
      state.checkPolicyOutcome === "ready"
        ? { outcome: "ready", policy: structuredClone(state.checkPolicy) }
        : { outcome: state.checkPolicyOutcome },
  );
  const checksCheck = vi.fn<EngineeringChecksPort["check"]>(
    async ({ binding, exactRequest }) => {
      if (state.checkOutcome !== "checked")
        return { outcome: state.checkOutcome };
      const receipt = `engineering-independent-check:${++receiptOrdinal}`;
      f.trust.issueChecks(receipt, binding, {
        publicReproduction:
          exactRequest.repository.visibility === "public"
            ? "passed"
            : "not_applicable",
        ...state.checkReceiptOverrides,
      });
      return { outcome: "checked", receipt };
    },
  );
  const checksVerify = vi.fn<EngineeringChecksPort["verify"]>(
    (receipt, binding) => f.engineeringOptions.checks!.verify(receipt, binding),
  );
  const routing: EngineeringRoutingPort = {
    resolve: routingResolve,
    check: routingCheck,
    verify: routingVerify,
  };
  const checks: EngineeringChecksPort = {
    resolvePolicy: checksResolve,
    check: checksCheck,
    verify: checksVerify,
  };
  f = engineeringFixture(backing, {
    ...fixtureOptions,
    engineering: {
      ...fixtureOptions.engineering,
      routing,
      checks,
      repositoryMetadata: {
        async resolve(repositoryId, signal) {
          if (
            signal.aborted ||
            state.metadataOutcome !== "ready" ||
            !state.installationActive ||
            Date.parse(state.metadataValidUntil) <= Date.parse(f.clock.now())
          )
            return null;
          const observation = f.trust.metadata.get(repositoryId);
          return observation === undefined
            ? null
            : structuredClone(observation);
        },
      },
    },
  });
  await f.create(managed);
  await f.enroll();
  await f.putPolicy(repositoryPolicy);
  const now = f.clock.now();
  const expires = new Date(Date.parse(now) + 3_600_000).toISOString();
  const initialPolicy = await f.policy();
  for (const repository of initialPolicy.policy.repositories)
    if (!f.trust.metadata.has(repository.repositoryId))
      f.trust.metadata.set(repository.repositoryId, {
        repositoryId: repository.repositoryId,
        owner: repository.owner,
        name: repository.name,
        visibility: repository.visibility,
        installationBinding: `synthetic-installation:${repository.repositoryId}`,
        metadataVersion: "repository-metadata-v1",
      });
  const state = {
    configurationOutcome: "ready" as "ready" | "disabled" | "unavailable",
    configuration: {
      purpose: "support_bug_assessment",
      version: "engineering-config-v1",
      promptVersion: "engineering-prompt-v1",
      modelVersion: "engineering-model-v1",
      parserVersion: "engineering-parser-v1",
      provider: "synthetic-engineering-provider",
      model: "synthetic-engineering-model",
      pricingRef: "synthetic-engineering-pricing",
      trustedInstructions:
        "Assess only the verified synthetic failure and route within the supplied repository policy.",
      framingTokens: 20,
      budgets: {
        maxMessages: 20,
        maxInputBytes: 32_768,
        maxInputTokens: 32_768,
        maxContextTokens: 65_536,
        maxOutputBytes: 16_000,
        maxOutputTokens: 8_192,
        maxCandidateBytes: 16_000,
        maxDurationMilliseconds: 5_000,
        maxCostMicros: 10_000,
        currency: "USD",
        maxAttempts: 2,
        maxRepositories: 16,
        maxRepositoryBytes: 65_536,
      },
      dataControls: {
        status: "verified",
        purpose: "support_bug_assessment",
        configurationBinding: "engineering-config-v1",
        accountRef: "PRIVATE_ENGINEERING_ACCOUNT",
        projectRef: "PRIVATE_ENGINEERING_PROJECT",
        endpointRef: "PRIVATE_ENGINEERING_ENDPOINT",
        modelRef: "PRIVATE_ENGINEERING_MODEL_ROUTE",
        featuresRef: "PRIVATE_ENGINEERING_FEATURES",
        exceptionsRef: "PRIVATE_ENGINEERING_EXCEPTIONS",
        intermediaryRefs: ["PRIVATE_ENGINEERING_INTERMEDIARY"],
        verifiedAt: now,
        validUntil: expires,
      },
    } as VerifiedEngineeringConfiguration,
    authorityOutcome: "ready" as "ready" | "inactive" | "unavailable",
    authority: {
      access: engineeringService,
      authorityVersion: "engineering-service-v1",
      usageScopeRef: "PRIVATE_ENGINEERING_USAGE_SCOPE",
    } as EngineeringServiceAuthority,
    reconciliationAuthorityOutcome: "ready" as
      "ready" | "inactive" | "unavailable",
    reconciliationAuthority: {
      access: engineeringService,
      authorityVersion: "engineering-reconciliation-service-v1",
      usageScopeRef: "PRIVATE_ENGINEERING_RECONCILIATION_SCOPE",
    } as EngineeringServiceAuthority,
    calibrationOutcome: "ready" as "ready" | "unavailable",
    calibration: {
      version: "engineering-calibration-v1",
      artifactRef: "PRIVATE_ENGINEERING_CALIBRATION_ARTIFACT",
      rubricVersion: "engineering-routing-rubric-v1",
      evaluationRef: "PRIVATE_ENGINEERING_LABELED_EVALUATION",
      modelVersion: "engineering-model-v1",
      promptVersion: "engineering-prompt-v1",
      parserVersion: "engineering-parser-v1",
      policyHash: initialPolicy.policyHash,
      verifiedAt: now,
      validUntil: expires,
    } as VerifiedEngineeringCalibration,
    routingOutcome: "checked" as
      "checked" | "human_required" | "restricted" | "unavailable",
    routingVerifiedOutcome: "accepted" as VerifiedEngineeringRouting["outcome"],
    routingReceiptOverrides: {} as Partial<VerifiedEngineeringRouting>,
    checkPolicyOutcome: "ready" as "ready" | "disabled" | "unavailable",
    checkPolicy: {
      version: "engineering-check-policy-v1",
      binding: "engineering-independent-check-policy-binding-v1",
      verifiedAt: now,
      validUntil: expires,
    },
    checkOutcome: "checked" as
      "checked" | "held" | "restricted" | "unavailable",
    checkReceiptOverrides: {} as Partial<VerifiedEngineeringExportChecks>,
    reserveOutcome: "reserved" as "reserved" | "denied" | "unavailable",
    usageReconciliationOutcome: "reconciled" as "reconciled" | "pending",
    metadataOutcome: "ready" as "ready" | "unavailable",
    installationActive: true,
    metadataValidUntil: expires,
    duplicateQuery: "workspace export empty file" as string | null,
    duplicateIssues: [] as Awaited<
      ReturnType<EngineeringGitHubPort["searchDuplicates"]>
    >["issues"],
    physicalDuplicateResults: 0,
    proposalOutcome: "prepared" as
      "prepared" | "held" | "restricted" | "unavailable",
    linkExisting: false,
    githubReconciliationOutcome: "automatic" as
      "automatic" | "unknown" | "confirmed_rejected",
  };
  const key = acceptEvidence
    ? await f.eligible(evidenceKind, "ticket", security)
    : {
        ticketId: "ticket",
        sourceGeneration: (await f.source()).sourceGeneration,
      };
  const resolveConfiguration = vi.fn<EngineeringConfigurationPort["resolve"]>(
    async () =>
      state.configurationOutcome === "ready"
        ? {
            outcome: "ready",
            configuration: structuredClone(state.configuration),
          }
        : { outcome: state.configurationOutcome },
  );
  const resolveAuthority = vi.fn<
    SupportDeskEngineeringOptions["serviceAccess"]["resolve"]
  >(async () =>
    state.authorityOutcome === "ready"
      ? { outcome: "ready", authority: structuredClone(state.authority) }
      : { outcome: state.authorityOutcome },
  );
  const resolveReconciliationAuthority = vi.fn<
    SupportDeskEngineeringOptions["reconciliationAccess"]["resolve"]
  >(async () =>
    state.reconciliationAuthorityOutcome === "ready"
      ? {
          outcome: "ready",
          authority: structuredClone(state.reconciliationAuthority),
        }
      : { outcome: state.reconciliationAuthorityOutcome },
  );
  const assessment = (overrides: Partial<EngineeringCandidate> = {}) =>
    f.candidate({
      routing: {
        outcome: "selected",
        repositoryId: initialPolicy.policy.repositories[0]!.repositoryId,
        alternativeRepositoryIds: [],
        rationale: "This allowed repository owns export generation.",
      },
      ...overrides,
    });
  const answer = (
    overrides: Partial<EngineeringModelResult> = {},
  ): EngineeringModelResult => ({
    outputJson: JSON.stringify(assessment()),
    provider: state.configuration.provider,
    model: state.configuration.model,
    requestId: "synthetic-engineering-model-request",
    usage: {
      inputTokens: 100,
      outputTokens: 50,
      costMicros: 10,
      currency: "USD",
    },
    ...overrides,
  });
  let modelScript: EngineeringModelPort["generate"] = async () => answer();
  const generate = vi.fn<EngineeringModelPort["generate"]>((...args) =>
    modelScript(...args),
  );
  const reserve = vi.fn<EngineeringUsagePort["reserve"]>(async (context) =>
    state.reserveOutcome === "reserved"
      ? { outcome: "reserved", usageReservationId: context.usageReservationId }
      : { outcome: state.reserveOutcome },
  );
  const reconcile = vi.fn<EngineeringUsagePort["reconcile"]>(
    async () => state.usageReconciliationOutcome,
  );
  const countTokens = vi.fn(
    (text: string) => new TextEncoder().encode(text).byteLength,
  );
  const getMetadata = vi.fn<EngineeringGitHubPort["getMetadata"]>(
    async (repositoryId) => {
      const repository = f.trust.metadata.get(repositoryId);
      return state.metadataOutcome === "ready" &&
        state.installationActive &&
        repository !== undefined
        ? {
            repository: structuredClone(repository),
            authority: {
              active: true,
              binding: repository.installationBinding,
              validUntil: state.metadataValidUntil,
            },
          }
        : null;
    },
  );
  const searchDuplicates = vi.fn<EngineeringGitHubPort["searchDuplicates"]>(
    async () => ({
      issues: structuredClone(state.duplicateIssues),
      physicalResults: state.physicalDuplicateResults,
    }),
  );
  const acceptedIssues = new Map<
    string,
    Awaited<ReturnType<EngineeringGitHubPort["createIssue"]>>
  >();
  const remoteProofs = new Map<string, EngineeringDispatchProofBinding>();
  const acceptIssue = async (
    request: Extract<EngineeringExportRequest, { operation: "create_issue" }>,
    acknowledgement = {
      repositoryId: request.repository.repositoryId,
      issueId: `synthetic-issue-${acceptedIssues.size + 1}`,
      issueNumber: acceptedIssues.size + 1,
    },
    context?: Parameters<EngineeringGitHubPort["createIssue"]>[1],
  ) => {
    const work =
      context === undefined
        ? await f.work(key.ticketId, key.sourceGeneration)
        : undefined;
    if (
      context === undefined &&
      (work?.dispatch === undefined || work.proposal === undefined)
    )
      throw new Error(
        "Physical GitHub creation must follow actual durable dispatch-started",
      );
    acceptedIssues.set(
      request.bundle.exportMarker,
      structuredClone(acknowledgement),
    );
    const binding: EngineeringDispatchProofBinding = {
      ...(context?.sourceFence ?? {
        ticketId: key.ticketId,
        sourceGeneration: key.sourceGeneration,
        sourceBindingHash: work!.sourceBindingHash,
      }),
      repositoryId: request.repository.repositoryId,
      repositoryMetadataHash:
        work?.proposal?.repositoryMetadataHash ?? digest(request.repository),
      dispatchId: context?.dispatchId ?? work!.dispatch!.dispatchId,
      requestHash: context?.requestHash ?? work!.dispatch!.requestHash,
      exportMarker: request.bundle.exportMarker,
      operation: "create_issue",
      result: { outcome: "accepted", acknowledgement },
    };
    remoteProofs.set(request.bundle.exportMarker, binding);
    f.trust.issueDispatch(binding);
    return acknowledgement;
  };
  let createScript: EngineeringGitHubPort["createIssue"] = async (
    request,
    context,
  ) => acceptIssue(request, undefined, context);
  const createIssue = vi.fn<EngineeringGitHubPort["createIssue"]>((...args) =>
    createScript(...args),
  );
  const githubReconcile = vi.fn<EngineeringGitHubPort["reconcile"]>(
    async (input) => {
      const { exportMarker } = input;
      if (state.githubReconciliationOutcome === "confirmed_rejected") {
        const proof = "trusted-github-no-acceptance-proof";
        if (
          input.sourceFence !== undefined &&
          input.repositoryMetadataHash !== undefined
        )
          f.trust.issueDispatch({
            ...input.sourceFence,
            repositoryId: input.repositoryId,
            repositoryMetadataHash: input.repositoryMetadataHash,
            dispatchId: input.dispatchId,
            requestHash: input.requestHash,
            exportMarker,
            operation: input.operation ?? "create_issue",
            result: { outcome: "confirmed_rejected", proof },
          });
        return { outcome: "confirmed_rejected", proof };
      }
      if (
        state.githubReconciliationOutcome === "automatic" &&
        input.operation === "link_existing_issue" &&
        input.sourceFence !== undefined &&
        input.repositoryMetadataHash !== undefined
      ) {
        const issue = state.duplicateIssues.find(
          (value) =>
            value.repositoryId === input.repositoryId &&
            value.issueId === input.issueId &&
            value.issueNumber === input.issueNumber,
        );
        if (issue !== undefined) {
          const acknowledgement = {
            repositoryId: issue.repositoryId,
            issueId: issue.issueId,
            issueNumber: issue.issueNumber,
          };
          f.trust.issueDispatch({
            ...input.sourceFence,
            repositoryId: input.repositoryId,
            repositoryMetadataHash: input.repositoryMetadataHash,
            dispatchId: input.dispatchId,
            requestHash: input.requestHash,
            exportMarker,
            operation: "link_existing_issue",
            result: { outcome: "accepted", acknowledgement },
          });
          return {
            outcome: "accepted",
            acknowledgement,
            proof: "trusted-github-existing-issue-identity",
          };
        }
      }
      const acknowledgement = acceptedIssues.get(exportMarker);
      if (
        state.githubReconciliationOutcome === "automatic" &&
        acknowledgement !== undefined
      ) {
        const binding = remoteProofs.get(exportMarker);
        if (binding !== undefined) f.trust.issueDispatch(binding);
        return {
          outcome: "accepted",
          acknowledgement: structuredClone(acknowledgement),
          proof: "trusted-github-unique-marker-acceptance",
        };
      }
      return {
        outcome: "unknown",
        reason: "No authoritative terminal acceptance proof",
      };
    },
  );
  const duplicateQuery = vi.fn<EngineeringProposalPort["duplicateQuery"]>(
    async () => state.duplicateQuery,
  );
  const prepareExport = vi.fn<EngineeringProposalPort["prepare"]>(
    async (input) => {
      if (state.proposalOutcome !== "prepared")
        return { outcome: state.proposalOutcome };
      const bundle = {
        title: input.candidate.title,
        body: [
          input.candidate.summary,
          `Expected: ${input.candidate.expectedBehavior}`,
          `Actual: ${input.candidate.actualBehavior}`,
          ...input.candidate.reproductionSteps,
          `Export marker: ${input.exportMarker}`,
        ].join("\n\n"),
        labels: input.descriptor.allowedLabels.includes("bug") ? ["bug"] : [],
        ...(input.descriptor.allowedTemplates[0] === undefined
          ? {}
          : { templateId: input.descriptor.allowedTemplates[0] }),
        evidenceReferences: ["synthetic-verified-reproduction"],
        exportMarker: input.exportMarker,
      };
      const duplicate = state.linkExisting ? input.duplicates[0] : undefined;
      return {
        outcome: "prepared",
        request:
          duplicate === undefined
            ? {
                operation: "create_issue",
                repository: input.repository,
                bundle,
              }
            : {
                operation: "link_existing_issue",
                repository: input.repository,
                bundle,
                issueId: duplicate.issueId,
                issueNumber: duplicate.issueNumber,
              },
      };
    },
  );
  const baseOptions: SupportDeskEngineeringOptions = {
    application: f.app,
    policy: { resolve: (access) => f.app.readRepositoryPolicy(access) },
    serviceAccess: { resolve: resolveAuthority },
    reconciliationAccess: { resolve: resolveReconciliationAuthority },
    configuration: { resolve: resolveConfiguration },
    routing,
    checks,
    model: { generate },
    usage: { reserve, reconcile },
    tokenCounter: { count: countTokens },
    github: {
      getMetadata,
      searchDuplicates,
      createIssue,
      reconcile: githubReconcile,
    },
    proposals: { duplicateQuery, prepare: prepareExport },
    clock: f.clock,
  };
  const engineering = createSupportDeskEngineering(baseOptions);
  const nextCommand = () => ({
    ...key,
    workerId: "engineering-ai-worker",
    leaseMilliseconds: 30_000,
  });
  return {
    ...f,
    engineering,
    baseOptions,
    state,
    key,
    nextCommand,
    assessment,
    answer,
    generate,
    reserve,
    reconcile,
    resolveConfiguration,
    resolveAuthority,
    resolveReconciliationAuthority,
    countTokens,
    routingResolve,
    routingCheck,
    routingVerify,
    checksResolve,
    checksCheck,
    checksVerify,
    getMetadata,
    searchDuplicates,
    createIssue,
    githubReconcile,
    duplicateQuery,
    prepareExport,
    acceptedIssues,
    acceptIssue,
    setModel(script: EngineeringModelPort["generate"]) {
      modelScript = script;
    },
    setGitHubCreate(script: EngineeringGitHubPort["createIssue"]) {
      createScript = script;
    },
    setBudgets(overrides: Partial<EngineeringBudgets>) {
      state.configuration = {
        ...state.configuration,
        budgets: { ...state.configuration.budgets, ...overrides },
      };
    },
    async prepareProposal() {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const result = await engineering.processWork(nextCommand());
        if (result.outcome === "prepared")
          return {
            result,
            work: await f.work(),
            request: (await f.work()).proposal!.request,
          };
        if (result.outcome !== "candidate")
          throw new Error(
            `Engineering proposal did not progress: ${JSON.stringify(result)}`,
          );
      }
      throw new Error("Engineering proposal exceeded three bounded stages");
    },
    async approve() {
      const work = await f.work();
      if (work.proposal === undefined)
        throw new Error("Engineering proposal is not prepared");
      return engineering.reviewProposal(engineeringStaff, {
        ...f.command("approve-engineering-proposal"),
        sourceGeneration: key.sourceGeneration,
        expectedWorkGeneration: work.workGeneration,
        proposalHash: work.proposal.proposalHash,
        decision: "approve",
      });
    },
  };
}
