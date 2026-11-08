import type { AccessContext } from "@pegma/authorization-core";
import type { CollectionDefinition, Store } from "@pegma/storage-core";
import {
  supportPermissions,
  supportRecords,
} from "@pegma/support-desk-application";
import { isDeepStrictEqual } from "node:util";
import { vi } from "vitest";
import type {
  EngineeringFollowupAssociation,
  EngineeringFollowupCandidate,
  EngineeringFollowupBundle,
  EngineeringFollowupClaim,
  EngineeringFollowupChecksBinding,
  EngineeringFollowupContext,
  EngineeringFollowupKey,
  EngineeringFollowupOptions,
  EngineeringFollowupModelBinding,
  EngineeringFollowupProofContext,
  EngineeringFollowupRetestBinding,
  ObserveEngineeringFollowupCommand,
  PrepareEngineeringFollowupModelCommand,
  PrepareEngineeringFollowupBundleCommand,
  ApproveAndPostEngineeringFollowupWebUpdateCommand,
  VerifiedEngineeringFollowupChecks,
  VerifiedEngineeringFollowupContext,
  VerifiedEngineeringFollowupRetest,
} from "../packages/application/src/engineering-followup-types.js";
import {
  engineeringFollowupContextHash,
  engineeringFollowupChecksBinding,
  engineeringFollowupModelManifestHash,
  engineeringFollowupPublicFactsHash,
  engineeringFollowupRetestProductBinding,
  engineeringFollowupRetestRequestId,
  engineeringFollowupRetestRequestHash,
} from "../packages/application/src/engineering-followup-records.js";
import {
  engineeringAiFixture,
  engineeringBarrier,
  engineeringCustomer,
  engineeringStaff,
  engineeringStores,
} from "./engineering-fixtures.js";

export const engineeringFollowupStores = engineeringStores;
export const engineeringFollowupBarrier = engineeringBarrier;
export const engineeringFollowupCustomer = engineeringCustomer;
export const engineeringFollowupStaff = engineeringStaff;
export const engineeringFollowupService: AccessContext = {
  ...engineeringStaff,
  principalId: "engineering-followup/synthetic-service",
  permissions: [
    supportPermissions.queueRead,
    supportPermissions.engineeringFollowupRead,
    supportPermissions.engineeringFollowupProcess,
    supportPermissions.engineeringFollowupEvidenceSubmit,
  ],
};

export interface EngineeringFollowupReadTrace {
  readonly collection: string;
  readonly method: "get" | "getVersioned" | "list" | "listVersioned";
  readonly key: unknown;
}

/** Awaited-call observation only; every read and write uses the real adapter. */
export function engineeringFollowupObservedStore(backing: Store) {
  const reads: EngineeringFollowupReadTrace[] = [];
  const scans: { collection: string; limit: number; physicalRows: number }[] =
    [];
  let afterRead:
    ((trace: EngineeringFollowupReadTrace) => Promise<void>) | undefined;
  let overreturnScan = false;
  const store: Store = {
    collection<T>(definition: CollectionDefinition<T>) {
      const target = backing.collection(definition);
      return new Proxy(target, {
        get(object, property) {
          if (
            property === "get" ||
            property === "getVersioned" ||
            property === "list" ||
            property === "listVersioned"
          )
            return async (key: Parameters<typeof object.get>[0] | string) => {
              const result =
                property === "get" || property === "getVersioned"
                  ? await object[property](
                      key as Parameters<typeof object.get>[0],
                    )
                  : await object[property](key as string);
              const trace: EngineeringFollowupReadTrace = {
                collection: definition.name,
                method: property,
                key,
              };
              reads.push(trace);
              await afterRead?.(trace);
              return result;
            };
          if (property === "scan")
            return async (bounds: Parameters<typeof object.scan>[0]) => {
              const page = await object.scan(
                overreturnScan
                  ? { ...bounds, limit: bounds.limit + 1 }
                  : bounds,
              );
              scans.push({
                collection: definition.name,
                limit: bounds.limit,
                physicalRows: page.records.length,
              });
              return page;
            };
          const value: unknown = Reflect.get(object, property, object);
          return typeof value === "function" ? value.bind(object) : value;
        },
      });
    },
  };
  return {
    store,
    reads,
    scans,
    afterRead(callback: typeof afterRead) {
      afterRead = callback;
    },
    overreturnScans(enabled = true) {
      overreturnScan = enabled;
    },
  };
}

/** Establish the association through the real checked, reviewed SD-04 export. */
export async function engineeringFollowupAssociationFixture(
  backing: Store,
  options: Parameters<typeof engineeringAiFixture>[1] = {},
) {
  const support = await engineeringAiFixture(backing, options);
  await support.prepareProposal();
  await support.approve();
  await support.engineering.processWork(support.nextCommand());
  const work = await support.work();
  if (work.status !== "accepted" || work.acknowledgement === undefined)
    throw new Error(
      "Follow-up requires the actual trusted accepted issue export",
    );
  return support;
}

type FollowupFixtureOptions = {
  readonly support?: Parameters<typeof engineeringAiFixture>[1];
  readonly followup?: Partial<EngineeringFollowupOptions>;
  readonly associate?: boolean;
  readonly observe?: boolean;
};

/** Actual public SD-04 and SD-05 services; only independent host ports are fake. */
export async function engineeringFollowupFixture(
  backing: Store,
  options: FollowupFixtureOptions = {},
) {
  let support!: Awaited<ReturnType<typeof engineeringAiFixture>>;
  let receiptOrdinal = 0;
  let firstKey: EngineeringFollowupKey | undefined;
  const readObserver = engineeringFollowupObservedStore(backing);
  const inputs = new Map<
    string,
    {
      proof: VerifiedEngineeringFollowupContext;
      context: EngineeringFollowupProofContext;
    }
  >();
  const checks = new Map<string, VerifiedEngineeringFollowupChecks>();
  const retests = new Map<string, VerifiedEngineeringFollowupRetest>();
  const currentProofs = new Map<string, VerifiedEngineeringFollowupContext>();
  const contextKey = (context: EngineeringFollowupContext) =>
    JSON.stringify([
      context.issueHead.repositoryId,
      context.issueHead.issueId,
      context.deploymentHead.contextRef,
    ]);
  const state = {
    inputOutcome: "ready" as "ready" | "refused" | "unavailable",
    currentOutcome: "ready" as "ready" | "unavailable",
    checksOutcome: "ready" as "ready" | "unavailable",
    retestOutcome: "ready" as "ready" | "unavailable",
    allowedRepositories: [] as string[],
    allowedRunners: ["trusted-followup-retest-runner"],
    context: undefined as EngineeringFollowupContext | undefined,
    publicFacts: [
      {
        reference: "public-release-231",
        text: "Workspace export now includes all rows.",
      },
    ],
    validForMilliseconds: 60_000,
  };
  const attestation = () => ({
    verifierReceiptId: `PRIVATE_FOLLOWUP_ATTESTATION:${++receiptOrdinal}`,
    verifierVersion: "followup-verifier-v1",
    verifiedAt: support.clock.now(),
    validUntil: new Date(
      Date.parse(support.clock.now()) + state.validForMilliseconds,
    ).toISOString(),
  });
  const proof = (
    overrides: Partial<VerifiedEngineeringFollowupContext> = {},
  ): VerifiedEngineeringFollowupContext => {
    if (state.context === undefined)
      throw new Error("Follow-up remote context is not initialized");
    return structuredClone({
      context: state.context,
      publicFacts: state.publicFacts,
      attestation: attestation(),
      ...overrides,
    });
  };
  const verifyInput = vi.fn<
    NonNullable<EngineeringFollowupOptions["releaseEvidence"]>["verifyInput"]
  >(async (inputReference, context, signal) => {
    const input = inputs.get(inputReference);
    if (
      signal.aborted ||
      state.inputOutcome !== "ready" ||
      input === undefined ||
      !state.allowedRepositories.includes(context.association.repositoryId) ||
      !isDeepStrictEqual(input.context, context)
    )
      return null;
    return structuredClone(input.proof);
  });
  const confirm = vi.fn<
    NonNullable<EngineeringFollowupOptions["releaseEvidence"]>["confirm"]
  >(async (_binding, context, signal) =>
    signal.aborted ||
    state.currentOutcome !== "ready" ||
    !state.allowedRepositories.includes(context.association.repositoryId)
      ? null
      : structuredClone(currentProofs.get(contextKey(_binding)) ?? proof()),
  );
  const checksVerify = vi.fn<
    NonNullable<EngineeringFollowupOptions["checks"]>["verify"]
  >(async (receipt, binding, signal) => {
    const issued = checks.get(receipt);
    return signal.aborted ||
      state.checksOutcome !== "ready" ||
      issued === undefined ||
      !isDeepStrictEqual(issued.binding, binding)
      ? null
      : structuredClone(issued);
  });
  const retestVerify = vi.fn<
    NonNullable<EngineeringFollowupOptions["retestReceipts"]>["verify"]
  >(async (receipt, binding, signal) => {
    const issued = retests.get(receipt);
    return signal.aborted ||
      state.retestOutcome !== "ready" ||
      issued === undefined ||
      !state.allowedRunners.includes(issued.runnerId) ||
      !isDeepStrictEqual(issued.binding, binding)
      ? null
      : structuredClone(issued);
  });
  const followupOptions: EngineeringFollowupOptions = {
    enabled: true,
    releaseEvidence: { verifyInput, confirm },
    checks: { verify: checksVerify },
    retestReceipts: { verify: retestVerify },
    ...options.followup,
  };
  const supportOptions = {
    ...options.support,
    engineeringFollowup: followupOptions,
  };
  support =
    options.associate === false
      ? await engineeringAiFixture(readObserver.store, supportOptions)
      : await engineeringFollowupAssociationFixture(
          readObserver.store,
          supportOptions,
        );
  async function association(): Promise<EngineeringFollowupAssociation> {
    const source = await support.source();
    const destination = [...source.destinations]
      .reverse()
      .find(
        (entry) =>
          entry.outcome === "accepted" &&
          entry.acknowledgement !== undefined &&
          entry.dispatchId !== undefined,
      );
    if (
      destination?.acknowledgement === undefined ||
      destination.dispatchId === undefined ||
      destination.followupRevocationEpoch === undefined
    )
      throw new Error(
        "No current epoch-bearing accepted engineering association",
      );
    return {
      ticketId: "ticket",
      repositoryId: destination.repositoryId,
      issueId: destination.acknowledgement.issueId,
      issueNumber: destination.acknowledgement.issueNumber,
      dispatchId: destination.dispatchId,
      requestHash: destination.requestHash,
      engineeringSourceGeneration: destination.sourceGeneration,
      followupRevocationEpoch: destination.followupRevocationEpoch,
    };
  }
  const acceptedWork = await support.work();
  const accepted = acceptedWork.acknowledgement ?? {
    repositoryId: "repository-101",
    issueId: "synthetic-unassociated-issue",
    issueNumber: 1,
  };
  const acceptedProduct = (await support.source()).product;
  if (acceptedProduct === undefined)
    throw new Error(
      "Follow-up fixture requires real verified product evidence",
    );
  state.allowedRepositories = [accepted.repositoryId];
  state.context = {
    issueHead: {
      repositoryId: accepted.repositoryId,
      issueId: accepted.issueId,
      issueNumber: accepted.issueNumber,
      generation: 1,
      hash: "issue-head-1",
      state: "closed",
    },
    deploymentHead: {
      contextRef: "PRIVATE_DEPLOYMENT_CONTEXT",
      generation: 1,
      hash: "deployment-head-1",
      state: "deployed",
      deploymentEpoch: "deployment-epoch-1",
    },
    mapping: {
      semanticMappingId: "semantic-export-fix",
      mappingId: "PRIVATE_MAPPING_ID",
      mappingVersion: "mapping-v1",
      affectedProductBinding: acceptedProduct.binding,
      fixedProduct: {
        productId: acceptedProduct.productId,
        version: "2.3.1",
        buildId: "build-fixed-231",
      },
      releaseRef: "PRIVATE_RELEASE_REF",
      deploymentId: "PRIVATE_DEPLOYMENT_ID",
      scopeRef: "PRIVATE_SCOPE_REF",
      issueHeadHash: "issue-head-1",
      deploymentHeadHash: "deployment-head-1",
      verification: {
        kind: "host_release",
        reference: "PRIVATE_RELEASE_MAPPING_PROOF",
      },
    },
  };
  async function proofContext(): Promise<EngineeringFollowupProofContext> {
    const ticket = (
      await support.app.readStaffTicket(engineeringStaff, "ticket")
    ).ticket;
    const visible = await support.app.readCustomerTicket(
      engineeringCustomer,
      "ticket",
    );
    const source = await support.source();
    if (source.followupRevocationEpoch === undefined)
      throw new Error("Legacy source has no follow-up epoch");
    return {
      ticketId: "ticket",
      ticketRevision: ticket.revision,
      lastVisibleMessageId: visible.messages.at(-1)!.id,
      parentSourceGeneration: source.sourceGeneration,
      followupRevocationEpoch: source.followupRevocationEpoch,
      association: await association(),
    };
  }
  async function issueInput(
    reference = `signed-followup-input:${++receiptOrdinal}`,
    verified = proof(),
    contextOverrides: Partial<EngineeringFollowupProofContext> = {},
  ) {
    inputs.set(reference, {
      proof: structuredClone(verified),
      context: {
        ...(await proofContext()),
        ...structuredClone(contextOverrides),
      },
    });
    return reference;
  }
  async function observe(
    overrides: Partial<ObserveEngineeringFollowupCommand> = {},
  ) {
    const currentAssociation = await association();
    const inputReference = overrides.inputReference ?? (await issueInput());
    const result = await support.app.observeEngineeringFollowup(
      engineeringFollowupService,
      {
        ...support.command("followup-observe"),
        association: {
          repositoryId: currentAssociation.repositoryId,
          issueId: currentAssociation.issueId,
        },
        inputReference,
        ...overrides,
      },
    );
    if (firstKey === undefined && result.workId !== undefined)
      firstKey = { ticketId: result.ticketId, workId: result.workId };
    return result;
  }
  function currentKey(): EngineeringFollowupKey {
    if (firstKey === undefined)
      throw new Error(
        "Observe an eligible release before reading its work key",
      );
    return { ...firstKey };
  }
  const modelCommands: PrepareEngineeringFollowupModelCommand[] = [];
  const nextCommand = (key: EngineeringFollowupKey = currentKey()) => ({
    ...key,
    workerId: "followup-worker",
    leaseMilliseconds: 30_000,
  });
  async function claim(key: EngineeringFollowupKey = currentKey()) {
    const claimed = await support.app.claimEngineeringFollowupWork(
      engineeringFollowupService,
      {
        ...nextCommand(key),
        claimId: `followup-claim:${++receiptOrdinal}`,
      },
    );
    if (claimed === null) throw new Error("Follow-up work was not claimed");
    return claimed;
  }
  const candidate = (
    overrides: Partial<EngineeringFollowupCandidate> = {},
  ): EngineeringFollowupCandidate => ({
    customerDraft: {
      body: "The export fix is available in your deployed workspace build. Please retry the export.",
    },
    kbProposal: {
      summary: "Document the deployed export fix.",
      changes: ["The deployed build includes all workspace rows in an export."],
      advisoryValidationRequirements: [
        "Check that a two-row workspace exports both rows.",
      ],
    },
    retestRequests: [
      {
        steps: [
          "Create a two-row workspace.",
          "Export the workspace and inspect both rows.",
        ],
        expectedBehavior: "The export includes both workspace rows.",
      },
    ],
    ...structuredClone(overrides),
  });
  async function modelBinding(
    owner: EngineeringFollowupClaim,
    overrides: Partial<EngineeringFollowupModelBinding> = {},
  ): Promise<EngineeringFollowupModelBinding> {
    const inputManifest = {
      messages: owner.messages.map(({ messageId, ordinal }) => ({
        messageId,
        ordinal,
      })),
      workBindingHash: owner.sourceFence.workBindingHash,
      contextHash: await engineeringFollowupContextHash(owner.proof.context),
      publicFactsHash: await engineeringFollowupPublicFactsHash(
        owner.proof.publicFacts,
      ),
    };
    return {
      inputManifest,
      inputFingerprint: "followup-test-input-fingerprint",
      inputManifestHash:
        await engineeringFollowupModelManifestHash(inputManifest),
      configVersion: "followup-test-config-v1",
      promptVersion: "followup-test-prompt-v1",
      modelVersion: "followup-test-model-v1",
      parserVersion: "followup-test-parser-v1",
      checkPolicyVersion: "followup-test-check-policy-v1",
      budgetsHash: "followup-test-budgets",
      usageReservationId: `PRIVATE_FOLLOWUP_USAGE:${++receiptOrdinal}`,
      deadline: owner.leaseUntil,
      ...structuredClone(overrides),
    };
  }
  async function prepareCandidate(
    input: {
      readonly key?: EngineeringFollowupKey;
      readonly owner?: EngineeringFollowupClaim;
      readonly candidate?: EngineeringFollowupCandidate;
    } = {},
  ) {
    const owner = input.owner ?? (await claim(input.key));
    const command = { ...owner.fence, binding: await modelBinding(owner) };
    modelCommands.push(structuredClone(command));
    const prepared = await support.app.prepareEngineeringFollowupModel(
      engineeringFollowupService,
      command,
    );
    const value = input.candidate ?? candidate();
    const completeCommand = {
      ...owner.fence,
      stepId: prepared.stepId,
      requestHash: prepared.requestHash,
      candidate: value,
      accounting: "accounted" as const,
    };
    const result = await support.app.completeEngineeringFollowupModel(
      engineeringFollowupService,
      completeCommand,
      async () => {},
    );
    return {
      owner,
      prepared,
      candidate: value,
      candidateHash: result.candidateHash!,
      command,
      completeCommand,
      result,
    };
  }
  const bundleCommands: PrepareEngineeringFollowupBundleCommand[] = [];
  const postCommands: ApproveAndPostEngineeringFollowupWebUpdateCommand[] = [];
  async function exactBundle(
    value: EngineeringFollowupCandidate,
    key: EngineeringFollowupKey = currentKey(),
    context = state.context!,
  ): Promise<EngineeringFollowupBundle> {
    const productBinding =
      await engineeringFollowupRetestProductBinding(context);
    return {
      customerDraft: structuredClone(value.customerDraft),
      kbProposal:
        value.kbProposal === null
          ? null
          : { ...structuredClone(value.kbProposal), target: { kind: "none" } },
      retestRequests: await Promise.all(
        value.retestRequests.map(async (request, index) => ({
          ...structuredClone(request),
          productBinding,
          validationRequirementIds: [],
          requestId: await engineeringFollowupRetestRequestId({
            ...request,
            workId: key.workId,
            index,
            productBinding,
            validationRequirementIds: [],
          }),
        })),
      ),
    };
  }
  async function prepareBundle(
    input: {
      readonly key?: EngineeringFollowupKey;
      readonly mode?: PrepareEngineeringFollowupBundleCommand["mode"];
      readonly candidate?: EngineeringFollowupCandidate;
      readonly exactBundle?: EngineeringFollowupBundle;
      readonly checkPolicyVersion?: string;
      readonly checksReceipt?: string;
      readonly beforePrepare?: (
        command: PrepareEngineeringFollowupBundleCommand,
      ) => void;
    } = {},
  ) {
    const key = input.key ?? currentKey();
    let work = await support.app.readEngineeringFollowupWork(
      engineeringFollowupStaff,
      key,
    );
    const mode = input.mode ?? "prepare";
    if (work.candidateHash === undefined) {
      await prepareCandidate({
        key,
        ...(input.candidate === undefined
          ? {}
          : { candidate: input.candidate }),
      });
      work = await support.app.readEngineeringFollowupWork(
        engineeringFollowupStaff,
        key,
      );
    }
    const reassessment =
      mode === "staff_reassessment"
        ? await support.app.readEngineeringFollowupReassessment(
            engineeringFollowupStaff,
            key,
          )
        : undefined;
    const context = reassessment?.proof.context ?? work.context!;
    const bundle =
      input.exactBundle ??
      (work.candidate === undefined
        ? work.preparedBundle?.bundle
        : await exactBundle(work.candidate, key, context));
    if (bundle === undefined || work.candidateHash === undefined)
      throw new Error(
        "Follow-up bundle requires a real stored candidate or retained exact bundle",
      );
    const checkPolicyVersion =
      input.checkPolicyVersion ?? "followup-test-check-policy-v1";
    const binding = await engineeringFollowupChecksBinding({
      workBindingHash:
        reassessment?.prospectiveWorkBindingHash ?? work.workBindingHash,
      candidateHash: work.candidateHash,
      exactBundle: bundle,
      checkPolicyVersion,
      followupRevocationEpoch:
        reassessment?.proofContext.followupRevocationEpoch ??
        work.association.followupRevocationEpoch,
      context,
    });
    const checksReceipt =
      input.checksReceipt ?? `independent-followup-check:${++receiptOrdinal}`;
    if (input.checksReceipt === undefined)
      checks.set(checksReceipt, {
        binding,
        privacy: "passed",
        factual: "passed",
        applicability: "passed",
        security: "clear",
        ...attestation(),
      });
    const command: PrepareEngineeringFollowupBundleCommand = {
      ...support.command("prepare-followup-bundle"),
      ...key,
      mode,
      expectedWorkGeneration: work.workGeneration,
      candidateHash: work.candidateHash,
      exactBundle: bundle,
      checksReceipt,
      checkPolicyVersion,
    };
    bundleCommands.push(structuredClone(command));
    input.beforePrepare?.(command);
    const result = await support.app.prepareEngineeringFollowupBundle(
      mode === "staff_reassessment"
        ? engineeringFollowupStaff
        : engineeringFollowupService,
      command,
      async () => {},
    );
    return {
      key,
      command,
      result,
      binding,
      checksReceipt,
      bundle,
      work: await support.app.readEngineeringFollowupWork(
        engineeringFollowupStaff,
        key,
      ),
    };
  }
  async function post(
    input: {
      readonly key?: EngineeringFollowupKey;
      readonly messageId?: string;
      readonly access?: AccessContext;
      readonly beforePost?: (
        command: ApproveAndPostEngineeringFollowupWebUpdateCommand,
      ) => void;
    } = {},
  ) {
    const key = input.key ?? currentKey();
    const work = await support.app.readEngineeringFollowupWork(
      engineeringFollowupStaff,
      key,
    );
    if (work.preparedBundle === undefined)
      throw new Error(
        "Staff posting requires an exact independently checked bundle",
      );
    const ticket = (
      await support.app.readStaffTicket(engineeringFollowupStaff, key.ticketId)
    ).ticket;
    const command: ApproveAndPostEngineeringFollowupWebUpdateCommand = {
      ...support.command("approve-post-followup"),
      ...key,
      expectedWorkGeneration: work.workGeneration,
      expectedTicketRevision: ticket.revision,
      bundleHash: work.preparedBundle.bundleHash,
      messageId: input.messageId ?? `followup-notice:${++receiptOrdinal}`,
    };
    postCommands.push(structuredClone(command));
    input.beforePost?.(command);
    const result = await support.app.approveAndPostEngineeringFollowupWebUpdate(
      input.access ?? engineeringFollowupStaff,
      command,
      async () => {},
    );
    return {
      command,
      result,
      work: await support.app.readEngineeringFollowupWork(
        engineeringFollowupStaff,
        key,
      ),
    };
  }
  async function retestBinding(
    key: EngineeringFollowupKey = currentKey(),
    index = 0,
  ): Promise<EngineeringFollowupRetestBinding> {
    const work = await support.app.readEngineeringFollowupWork(
      engineeringFollowupStaff,
      key,
    );
    const bundle = work.preparedBundle;
    const request = (bundle?.bundle.retestRequests ??
      work.handoff?.retestRequests)?.[index];
    if (request === undefined)
      throw new Error("Follow-up has no exact bound retest request");
    return {
      ...key,
      workBindingHash: work.workBindingHash,
      requestId: request.requestId,
      requestHash: await engineeringFollowupRetestRequestHash(request),
      bundleHash: bundle?.bundleHash ?? work.delivered!.bundleHash,
      productBinding: request.productBinding,
    };
  }
  async function linkExisting(previous = accepted) {
    support.state.linkExisting = true;
    support.state.duplicateIssues = [
      {
        ...previous,
        title: "Existing verified export bug",
        body: "Synthetic issue observed by trusted GitHub metadata.",
      },
    ];
    support.state.physicalDuplicateResults =
      support.state.duplicateIssues.length;
    const source = await support.source();
    const key = {
      ticketId: "ticket",
      sourceGeneration: source.sourceGeneration,
    };
    const command = {
      ...key,
      workerId: "followup-reassociation-worker",
      leaseMilliseconds: 30_000,
    };
    for (let step = 0; step < 2; step += 1) {
      const result = await support.engineering.processWork(command);
      if (result.outcome !== (step === 0 ? "candidate" : "prepared")) {
        const observed = await support.app.readEngineeringWork(
          engineeringFollowupStaff,
          key,
        );
        throw new Error(
          `Existing issue association did not prepare: ${JSON.stringify({
            result,
            heldReason: observed.heldReason,
          })}`,
        );
      }
    }
    const work = await support.app.readEngineeringWork(
      engineeringFollowupStaff,
      key,
    );
    if (work.proposal?.request.operation !== "link_existing_issue")
      throw new Error(
        "Existing issue association requires an exact checked link request",
      );
    await support.engineering.reviewProposal(engineeringFollowupStaff, {
      ...support.command("approve-new-existing-issue-association"),
      ...key,
      expectedWorkGeneration: work.workGeneration,
      proposalHash: work.proposal.proposalHash,
      decision: "approve",
    });
    await support.engineering.processWork(command);
    const linked = await support.app.readEngineeringWork(
      engineeringFollowupStaff,
      key,
    );
    if (linked.status !== "accepted")
      throw new Error(
        "Existing issue link was not accepted by the trusted identity port",
      );
    return { key, work: linked, association: await association() };
  }
  async function refreshEvidence(
    reference = `fresh-followup-engineering-proof:${++receiptOrdinal}`,
  ) {
    const ticket = (
      await support.app.readStaffTicket(engineeringFollowupStaff, "ticket")
    ).ticket;
    await support.app.submitEngineeringEvidence(engineeringFollowupStaff, {
      ...support.command("refresh-followup-parent-evidence"),
      expectedRevision: ticket.revision,
      security: "ordinary",
      evidence: {
        ...(await support.reportInput()),
        verificationReference: reference,
      },
    });
    const source = await support.source();
    return {
      source,
      key: { ticketId: "ticket", sourceGeneration: source.sourceGeneration },
    };
  }
  const fixture = {
    ...support,
    support,
    backing,
    readObserver,
    followupOptions,
    releaseEvidence: followupOptions.releaseEvidence!,
    state,
    proof,
    proofContext,
    association,
    issueInput,
    observe,
    verifyInput,
    confirm,
    checksVerify,
    retestVerify,
    modelCommands,
    bundleCommands,
    postCommands,
    nextCommand,
    candidate,
    modelBinding,
    prepareCandidate,
    exactBundle,
    prepareBundle,
    post,
    retestBinding,
    linkExisting,
    refreshEvidence,
    get key(): EngineeringFollowupKey {
      return currentKey();
    },
    async eligible() {
      const result = await observe();
      if (result.workId === undefined)
        throw new Error(`Follow-up did not queue: ${JSON.stringify(result)}`);
      return { ticketId: result.ticketId, workId: result.workId };
    },
    async head() {
      const row = await backing
        .collection(supportRecords)
        .get({ partition: "ticket", id: "engineering-followup-head" });
      if (row?.kind !== "engineering_followup_head")
        throw new Error("Follow-up head does not exist");
      return row;
    },
    work(key: EngineeringFollowupKey = currentKey()) {
      return support.app.readEngineeringFollowupWork(
        engineeringFollowupStaff,
        key,
      );
    },
    scan(
      access: AccessContext = engineeringFollowupService,
      limit = 64,
      cursor?: string,
    ) {
      return support.app.scanEngineeringFollowups(access, {
        limit,
        ...(cursor === undefined ? {} : { cursor }),
      });
    },
    claim,
    trust: {
      issueInput,
      inputs,
      currentProofs,
      setCurrent(verified: VerifiedEngineeringFollowupContext) {
        currentProofs.set(
          contextKey(verified.context),
          structuredClone(verified),
        );
      },
      clearCurrent() {
        currentProofs.clear();
      },
      issueChecks(
        receipt: string,
        binding: EngineeringFollowupChecksBinding,
        overrides: Partial<VerifiedEngineeringFollowupChecks> = {},
      ) {
        checks.set(
          receipt,
          structuredClone({
            binding,
            privacy: "passed",
            factual: "passed",
            applicability: "passed",
            security: "clear",
            ...attestation(),
            ...overrides,
          }),
        );
        return receipt;
      },
      revokeChecks(receipt: string) {
        checks.delete(receipt);
      },
      issueRetest(
        receipt: string,
        binding: EngineeringFollowupRetestBinding,
        result: "passed" | "failed" = "passed",
        overrides: Partial<VerifiedEngineeringFollowupRetest> = {},
      ) {
        retests.set(
          receipt,
          structuredClone({
            binding,
            result,
            executionId: `followup-execution:${++receiptOrdinal}`,
            runnerId: "trusted-followup-retest-runner",
            ...attestation(),
            ...overrides,
          }),
        );
        return receipt;
      },
      revokeRetest(receipt: string) {
        retests.delete(receipt);
      },
    },
  };
  if (options.observe === true) await fixture.eligible();
  return fixture;
}
