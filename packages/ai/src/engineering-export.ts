import {
  engineeringExportChecksBinding,
  engineeringRoutingBinding,
  engineeringRoutingBindingHash,
  engineeringStaffSelectionHash,
  type EngineeringClaim,
  type EngineeringExportRequest,
  type EngineeringIssueAcknowledgement,
  type EngineeringPolicySnapshot,
  type EngineeringReviewObservation,
  type EngineeringWorkerObservation,
  type EngineeringPreparedProposal,
  type EngineeringRepositoryDescriptor,
  type EngineeringRepositoryObservation,
  type EngineeringStepResult,
  type EngineeringWorkRecord,
  type FinishEngineeringWorkCommand,
  type PrepareEngineeringProposalCommand,
  type RecordEngineeringDispatchResultCommand,
} from "@pegma/support-desk-application";
import type {
  EngineeringExternalContext,
  EngineeringGitHubMetadata,
  EngineeringProcessResult,
  EngineeringProposalContent,
  EngineeringServiceAuthority,
  SupportDeskEngineeringOptions,
} from "./engineering-ports.js";
import {
  AssistantBoundaryError,
  canonical,
  count,
  exactKeys,
  fingerprint,
  scalar,
  snapshot,
  text,
  timestamp,
} from "./boundary.js";
import {
  engineeringAuthority,
  engineeringCalibration,
  engineeringCheckPolicy,
  engineeringConfiguration,
  engineeringCurrentFacts,
  engineeringFailureCategory,
  engineeringPolicy,
  engineeringProcessingAuthority,
  engineeringSource,
  validateEngineeringSource,
} from "./engineering-request.js";
import type { LearningRuntime } from "./learning-runtime.js";

class EngineeringWorkerGuardFailure extends AssistantBoundaryError {
  constructor(
    category: string,
    readonly phase: EngineeringWorkerObservation["phase"],
  ) {
    super(category);
  }
}
const context = (
  runtime: LearningRuntime,
  deadline: number,
): EngineeringExternalContext => ({
  purpose: "support_bug_assessment",
  deadline: new Date(deadline).toISOString(),
  signal: runtime.signal,
});

function sourceFence(work: EngineeringWorkRecord) {
  return {
    ticketId: work.ticketId,
    sourceGeneration: work.sourceGeneration,
    sourceBindingHash: work.sourceBindingHash,
  };
}

function descriptor(
  policy: EngineeringPolicySnapshot,
  repositoryId: string,
): EngineeringRepositoryDescriptor {
  const value = policy.policy.repositories.find(
    (repository) => repository.repositoryId === repositoryId,
  );
  if (
    !policy.policy.enabled ||
    value === undefined ||
    !value.enabled ||
    value.publicationMode !== "approval_required"
  )
    throw new AssistantBoundaryError("repository_not_allowed");
  return value;
}

export async function engineeringRepository(
  options: SupportDeskEngineeringOptions,
  repositoryId: string,
  runtime: LearningRuntime,
  deadline = runtime.deadline,
): Promise<EngineeringGitHubMetadata> {
  const observed = snapshot(
    await runtime.within(
      () =>
        options.github.getMetadata(repositoryId, context(runtime, deadline)),
      deadline,
    ),
  );
  if (observed === null)
    throw new AssistantBoundaryError("repository_unavailable");
  exactKeys(observed, ["repository", "authority"]);
  exactKeys(observed.authority, ["active", "binding", "validUntil"]);
  const repository = observed.repository;
  exactKeys(repository, [
    "repositoryId",
    "owner",
    "name",
    "visibility",
    "installationBinding",
    "metadataVersion",
  ]);
  for (const value of [
    repository.repositoryId,
    repository.owner,
    repository.name,
    repository.installationBinding,
    repository.metadataVersion,
  ])
    scalar(value);
  if (
    repository.repositoryId !== repositoryId ||
    !["public", "private"].includes(repository.visibility) ||
    observed.authority.active !== true
  )
    throw new AssistantBoundaryError("repository_authority_unavailable");
  scalar(observed.authority.binding);
  runtime.ensure(Math.min(deadline, timestamp(observed.authority.validUntil)));
  return observed;
}

function matchesDescriptor(
  repository: EngineeringRepositoryObservation,
  allowed: EngineeringRepositoryDescriptor,
): void {
  if (
    repository.repositoryId !== allowed.repositoryId ||
    repository.owner !== allowed.owner ||
    repository.name !== allowed.name ||
    repository.visibility !== allowed.visibility
  )
    throw new AssistantBoundaryError("repository_metadata_changed");
}

function exactRequest(
  raw: EngineeringExportRequest,
  metadata: EngineeringRepositoryObservation,
  allowed: EngineeringRepositoryDescriptor,
  marker: string,
): EngineeringExportRequest {
  const request = snapshot(raw);
  if (!["create_issue", "link_existing_issue"].includes(request.operation))
    throw new AssistantBoundaryError("request_invalid");
  exactKeys(request, [
    "operation",
    "repository",
    "bundle",
    ...(request.operation === "link_existing_issue"
      ? ["issueId", "issueNumber"]
      : []),
  ]);
  if (canonical(request.repository) !== canonical(metadata))
    throw new AssistantBoundaryError("repository_metadata_changed");
  const bundle = request.bundle;
  exactKeys(bundle, [
    "title",
    "body",
    "labels",
    "evidenceReferences",
    "exportMarker",
    ...(bundle.templateId === undefined ? [] : ["templateId"]),
  ]);
  scalar(bundle.title, 200);
  text(bundle.body, 12_000);
  if (
    scalar(bundle.exportMarker) !== marker ||
    !bundle.body.includes(marker) ||
    !Array.isArray(bundle.labels) ||
    bundle.labels.length > 32 ||
    new Set(bundle.labels).size !== bundle.labels.length ||
    !Array.isArray(bundle.evidenceReferences) ||
    bundle.evidenceReferences.length > 16
  )
    throw new AssistantBoundaryError("request_invalid");
  for (const label of bundle.labels)
    if (!allowed.allowedLabels.includes(scalar(label, 100)))
      throw new AssistantBoundaryError("label_not_allowed");
  if (
    bundle.templateId !== undefined &&
    !allowed.allowedTemplates.includes(scalar(bundle.templateId))
  )
    throw new AssistantBoundaryError("template_not_allowed");
  for (const reference of bundle.evidenceReferences) scalar(reference);
  if (request.operation === "link_existing_issue") {
    scalar(request.issueId);
    count(request.issueNumber, Number.MAX_SAFE_INTEGER, 1);
  }
  if (canonical(request).length * 2 > 24_000)
    throw new AssistantBoundaryError("request_limit");
  return request;
}

function acknowledgement(
  raw: EngineeringIssueAcknowledgement,
  repositoryId: string,
): EngineeringIssueAcknowledgement {
  const value = snapshot(raw);
  exactKeys(value, [
    "repositoryId",
    "issueId",
    "issueNumber",
    ...(value.url === undefined ? [] : ["url"]),
  ]);
  if (scalar(value.repositoryId) !== repositoryId)
    throw new AssistantBoundaryError("issue_repository_mismatch");
  scalar(value.issueId);
  count(value.issueNumber, Number.MAX_SAFE_INTEGER, 1);
  if (value.url !== undefined) scalar(value.url);
  return value;
}

/** Current source, policy, real installation and independently verified exact receipts. */
export async function engineeringProposalGuard(
  options: SupportDeskEngineeringOptions,
  work: EngineeringWorkRecord,
  proposal: EngineeringPreparedProposal,
  runtime: LearningRuntime,
  phase = runtime.deadline,
  expectedAuthority?: EngineeringServiceAuthority,
  observation?: EngineeringReviewObservation | EngineeringWorkerObservation,
  observeAuthority?: (authority: EngineeringServiceAuthority) => void,
  confirmBeforeRead = false,
  beforeFinalFacts?: () => Promise<void>,
): Promise<number> {
  let source;
  let authority: EngineeringServiceAuthority;
  let policy;
  if (observation === undefined) {
    authority = await engineeringProcessingAuthority(
      options.serviceAccess,
      runtime,
      expectedAuthority,
      phase,
    );
    source = await engineeringSource(
      options,
      sourceFence(work),
      runtime,
      authority,
      phase,
    );
    policy = await engineeringPolicy(options, authority, runtime, phase);
  } else {
    authority = await engineeringProcessingAuthority(
      options.serviceAccess,
      runtime,
      expectedAuthority,
      phase,
    );
    // These are this application's own reviewed records, protected by its
    // original CAS. Confirm their opaque versions again after all AI proof I/O.
    if (confirmBeforeRead)
      await runtime.within(() => observation.confirm(authority.access), phase);
    if ("verifyApplication" in observation) {
      const context = observation.read(authority.access);
      source = validateEngineeringSource(context.source, sourceFence(work));
      policy = await engineeringPolicy(options, authority, runtime, phase);
    } else {
      const context = observation.read(authority.access);
      source = validateEngineeringSource(context.source, sourceFence(work));
      policy = context.policy;
    }
  }
  observeAuthority?.(authority);
  if (
    policy.generation !== proposal.policyGeneration ||
    policy.policyHash !== proposal.policyHash ||
    source.evidenceFingerprint !== proposal.checksBinding.evidenceFingerprint ||
    work.candidateHash !== proposal.candidateHash ||
    (await fingerprint(proposal.request)) !== proposal.requestHash ||
    (await fingerprint(proposal.request.repository)) !==
      proposal.repositoryMetadataHash
  )
    throw new AssistantBoundaryError("proposal_changed");
  const allowed = descriptor(policy, proposal.request.repository.repositoryId);
  matchesDescriptor(proposal.request.repository, allowed);
  exactRequest(
    proposal.request,
    proposal.request.repository,
    allowed,
    proposal.request.bundle.exportMarker,
  );
  const expectedChecks = await engineeringExportChecksBinding({
    sourceBindingHash: work.sourceBindingHash,
    evidenceFingerprint: source.evidenceFingerprint!,
    candidateHash: proposal.candidateHash,
    routingBindingHash: proposal.routingBindingHash,
    exactRequest: proposal.request,
    policyGeneration: policy.generation,
    policyHash: policy.policyHash,
  });
  if (canonical(expectedChecks) !== canonical(proposal.checksBinding))
    throw new AssistantBoundaryError("proposal_changed");
  const checkPolicy = await engineeringCheckPolicy(
    options,
    runtime,
    undefined,
    phase,
  );
  let deadline = Math.min(phase, timestamp(checkPolicy.validUntil));
  if (work.staffSelection !== undefined) {
    if (
      work.staffSelection.repositoryId !== allowed.repositoryId ||
      work.staffSelection.policyGeneration !== policy.generation ||
      work.staffSelection.policyHash !== policy.policyHash ||
      (await engineeringStaffSelectionHash(work.staffSelection)) !==
        proposal.routingBindingHash
    )
      throw new AssistantBoundaryError("staff_selection_changed");
  } else {
    if (
      proposal.routingBinding === undefined ||
      proposal.routingReceipt === undefined ||
      (await engineeringRoutingBindingHash(proposal.routingBinding)) !==
        proposal.routingBindingHash
    )
      throw new AssistantBoundaryError("routing_human_required");
    const calibration = await engineeringCalibration(
      options,
      {
        modelVersion: proposal.routingBinding.modelVersion,
        promptVersion: proposal.routingBinding.promptVersion,
        parserVersion: proposal.routingBinding.parserVersion,
        policyHash: policy.policyHash,
      },
      runtime,
      deadline,
    );
    deadline = Math.min(deadline, timestamp(calibration.validUntil));
    const routed = snapshot(
      await runtime.within(
        () =>
          options.routing.verify(
            proposal.routingReceipt!,
            proposal.routingBinding!,
          ),
        deadline,
      ),
    );
    if (
      routed === null ||
      canonical(routed.binding) !== canonical(proposal.routingBinding) ||
      routed.outcome !== "accepted" ||
      timestamp(routed.verifiedAt) > timestamp(options.clock.now())
    )
      throw new AssistantBoundaryError(
        routed?.outcome === "restricted"
          ? "security_restricted"
          : "routing_human_required",
      );
    scalar(routed.verifierReceiptId);
    scalar(routed.verifierVersion);
    deadline = Math.min(deadline, timestamp(routed.validUntil));
    runtime.ensure(deadline);
  }
  const checked = snapshot(
    await runtime.within(
      () =>
        options.checks.verify(proposal.checksReceipt, proposal.checksBinding),
      deadline,
    ),
  );
  if (
    checked === null ||
    canonical(checked.binding) !== canonical(proposal.checksBinding) ||
    checked.security !== "clear"
  )
    throw new AssistantBoundaryError("security_restricted");
  if (
    checked.privacy !== "passed" ||
    checked.factual !== "passed" ||
    (proposal.request.repository.visibility === "public"
      ? checked.publicReproduction !== "passed"
      : !["passed", "not_applicable"].includes(checked.publicReproduction)) ||
    timestamp(checked.verifiedAt) > timestamp(options.clock.now())
  )
    throw new AssistantBoundaryError("independent_checks_held");
  scalar(checked.verifierReceiptId);
  scalar(checked.verifierVersion);
  deadline = Math.min(deadline, timestamp(checked.validUntil));
  runtime.ensure(deadline);
  const metadata = await engineeringRepository(
    options,
    allowed.repositoryId,
    runtime,
    deadline,
  );
  if (canonical(metadata.repository) !== canonical(proposal.request.repository))
    throw new AssistantBoundaryError("repository_metadata_changed");
  deadline = Math.min(deadline, timestamp(metadata.authority.validUntil));
  if (beforeFinalFacts !== undefined)
    await runtime.within(beforeFinalFacts, deadline);
  const finalAuthority =
    observation === undefined
      ? await engineeringProcessingAuthority(
          options.serviceAccess,
          runtime,
          authority,
          deadline,
        )
      : authority;
  const facts = await engineeringCurrentFacts(
    options,
    sourceFence(work),
    finalAuthority,
    runtime,
    deadline,
    observation,
  );
  if (
    facts.source.evidenceFingerprint !==
      proposal.checksBinding.evidenceFingerprint ||
    facts.policy.generation !== proposal.policyGeneration ||
    facts.policy.policyHash !== proposal.policyHash ||
    facts.work.candidateHash !== proposal.candidateHash
  )
    throw new AssistantBoundaryError("proposal_changed");
  if (
    work.claim !== undefined &&
    (facts.work.claim === undefined ||
      canonical(facts.work.claim) !== canonical(work.claim))
  )
    throw new AssistantBoundaryError("current_fence_changed");
  if (
    proposal.proposalHash !== "uncommitted" &&
    (facts.work.proposalNeedsRebuild === true ||
      facts.work.proposal?.proposalHash !== proposal.proposalHash ||
      facts.work.proposal?.requestHash !== proposal.requestHash)
  )
    throw new AssistantBoundaryError("proposal_changed");
  runtime.ensure(deadline);
  return deadline;
}

/** A dispatch-started record authorizes at most this one physical creation call. */
export async function dispatchEngineeringExport(
  options: SupportDeskEngineeringOptions,
  claim: EngineeringClaim,
  runtime: LearningRuntime,
): Promise<EngineeringProcessResult> {
  const proposal = claim.work.proposal;
  if (proposal === undefined || claim.work.approval?.decision !== "approve")
    return finish(options, claim, runtime, "staff_approval_required", proposal);
  if (claim.reconciliationOnly || claim.work.dispatch !== undefined)
    return { outcome: "pending", stage: "reconciliation" };
  const attempts = count(options.storageCommandAttempts ?? 2, 3, 1);
  const deadline = Math.min(
    runtime.deadline,
    timestamp(claim.leaseUntil),
    timestamp(claim.work.deadline),
  );
  const phase =
    deadline - count(options.commitReserveMilliseconds ?? 1_000, 5_000, 1);
  const dispatchId = "engineering-dispatch:" + crypto.randomUUID();
  const begin = snapshot({
    ...claim.fence,
    stepId: proposal.stepId,
    requestHash: proposal.requestHash,
    proposalHash: proposal.proposalHash,
    dispatchId,
  });
  let permit:
    | Awaited<
        ReturnType<
          SupportDeskEngineeringOptions["application"]["beginEngineeringDispatch"]
        >
      >
    | undefined;
  let started = false;
  const record = async (
    result: RecordEngineeringDispatchResultCommand["result"],
  ): Promise<EngineeringProcessResult> => {
    let failureCategory: string | undefined;
    const command: RecordEngineeringDispatchResultCommand = snapshot({
      ticketId: claim.fence.ticketId,
      sourceGeneration: claim.fence.sourceGeneration,
      dispatchId,
      requestHash: proposal.requestHash,
      result,
    });
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const current = await engineeringAuthority(
          options.reconciliationAccess,
          runtime,
        );
        const recorded = await runtime.within(() =>
          options.application.recordEngineeringDispatchResult(
            current.access,
            command,
          ),
        );
        return recorded.status === "accepted"
          ? { outcome: "dispatched", result: recorded }
          : result.outcome === "unknown"
            ? { outcome: "pending", stage: "dispatch" }
            : { outcome: "held", result: recorded };
      } catch (error) {
        const category = engineeringFailureCategory(
          error,
          "acknowledgement_unknown",
        );
        if (category !== "acknowledgement_unknown") failureCategory = category;
        /* A conclusive result keeps its exact immutable acknowledgement. */
      }
    }
    return {
      outcome: "pending",
      stage: "complete",
      ...(failureCategory === undefined ? {} : { reason: failureCategory }),
    };
  };
  try {
    const processingAuthority = await engineeringProcessingAuthority(
      options.serviceAccess,
      runtime,
      undefined,
      phase,
    );
    let applicationProof: (() => true) | undefined;
    let verifiedDeadline = phase;
    const guard = async (
      observation?: EngineeringReviewObservation | EngineeringWorkerObservation,
    ) => {
      try {
        verifiedDeadline = Math.min(
          verifiedDeadline,
          await engineeringProposalGuard(
            options,
            claim.work,
            proposal,
            runtime,
            phase,
            processingAuthority,
            observation,
            undefined,
            observation !== undefined,
            observation !== undefined && "verifyApplication" in observation
              ? async () => {
                  applicationProof = await observation.verifyApplication();
                }
              : undefined,
          ),
        );
        return (): true => {
          runtime.ensure(verifiedDeadline);
          applicationProof?.();
          return true;
        };
      } catch (error) {
        if (observation !== undefined && "phase" in observation)
          throw new EngineeringWorkerGuardFailure(
            engineeringFailureCategory(error, "verification_unavailable"),
            observation.phase,
          );
        throw error;
      }
    };
    if (options.application.beginEngineeringDispatchObserved === undefined)
      await guard();
    let beginFailure: string | undefined;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const current = await engineeringProcessingAuthority(
          options.serviceAccess,
          runtime,
          processingAuthority,
          phase,
        );
        const value = await runtime.within(
          () =>
            options.application.beginEngineeringDispatchObserved === undefined
              ? options.application.beginEngineeringDispatch(
                  current.access,
                  begin,
                  async () => {
                    await guard();
                  },
                )
              : options.application.beginEngineeringDispatchObserved(
                  current.access,
                  begin,
                  guard,
                ),
          phase,
        );
        if (value === null)
          return { outcome: "pending", stage: "reconciliation" };
        if (
          value.ticketId !== claim.fence.ticketId ||
          value.sourceGeneration !== claim.fence.sourceGeneration ||
          value.dispatchId !== dispatchId ||
          value.requestHash !== proposal.requestHash ||
          value.exportMarker !== proposal.request.bundle.exportMarker ||
          canonical(value.request) !== canonical(proposal.request)
        )
          throw new AssistantBoundaryError("dispatch_permit_mismatch");
        permit = snapshot(value);
        started = true;
        break;
      } catch (error) {
        if (
          error instanceof EngineeringWorkerGuardFailure &&
          error.phase === "before_dispatch"
        )
          throw error;
        const category = engineeringFailureCategory(
          error,
          "acknowledgement_unknown",
        );
        if (category !== "acknowledgement_unknown") beginFailure = category;
        /* Unknown begin ACK: repeat exactly, with no POST before a permit. */
      }
    }
    if (permit === undefined || permit === null)
      return {
        outcome: "pending",
        stage: "dispatch",
        ...(beginFailure === undefined ? {} : { reason: beginFailure }),
      };
    const guardedDeadline =
      options.application.beginEngineeringDispatchObserved === undefined
        ? await engineeringProposalGuard(
            options,
            claim.work,
            proposal,
            runtime,
            phase,
            processingAuthority,
          )
        : verifiedDeadline;
    runtime.ensure(guardedDeadline);
    const request = permit.request;
    if (request.operation === "create_issue") {
      // This is deliberately the only createIssue invocation in this executor.
      // A thrown response may follow acceptance and never causes a second POST.
      let accepted: EngineeringIssueAcknowledgement;
      try {
        accepted = acknowledgement(
          await runtime.within(
            () =>
              options.github.createIssue(request, {
                ...context(runtime, guardedDeadline),
                sourceFence: claim.sourceFence,
                dispatchId,
                requestHash: proposal.requestHash,
              }),
            guardedDeadline,
          ),
          request.repository.repositoryId,
        );
      } catch {
        return await record({
          outcome: "unknown",
          reason: "remote_acceptance_unknown",
        });
      }
      return await record({ outcome: "accepted", acknowledgement: accepted });
    }
    // Linking an existing issue is a private Support association, with current
    // remote identity proof. No comment, edit or other GitHub mutation occurs.
    const observed = await runtime.within(
      () =>
        options.github.reconcile(
          {
            repositoryId: request.repository.repositoryId,
            exportMarker: request.bundle.exportMarker,
            dispatchId,
            requestHash: proposal.requestHash,
            operation: request.operation,
            issueId: request.issueId,
            issueNumber: request.issueNumber,
            sourceFence: claim.sourceFence,
            repositoryMetadataHash: proposal.repositoryMetadataHash,
          },
          context(runtime, guardedDeadline),
        ),
      guardedDeadline,
    );
    if (observed.outcome === "accepted") {
      const accepted = acknowledgement(
        observed.acknowledgement,
        request.repository.repositoryId,
      );
      if (
        accepted.issueId !== request.issueId ||
        accepted.issueNumber !== request.issueNumber
      )
        return await record({
          outcome: "unknown",
          reason: "issue_identity_changed",
        });
      scalar(observed.proof);
      return await record({ outcome: "accepted", acknowledgement: accepted });
    }
    return await record(
      observed.outcome === "confirmed_rejected"
        ? { outcome: "confirmed_rejected", proof: scalar(observed.proof) }
        : { outcome: "unknown", reason: "issue_identity_unavailable" },
    );
  } catch (error) {
    const reason = engineeringFailureCategory(error, "dispatch_unavailable");
    return started
      ? record({ outcome: "unknown", reason })
      : finish(options, claim, runtime, reason, proposal);
  }
}

/** Read-only remote reconciliation remains available after withdrawal or body deletion. */
export async function reconcileEngineeringSource(
  options: SupportDeskEngineeringOptions,
  ticketId: string,
  runtime: LearningRuntime,
): Promise<{
  readonly outcome: "reconciled" | "pending";
  readonly processed: number;
}> {
  scalar(ticketId);
  let processed = 0;
  const current = await engineeringAuthority(
    options.reconciliationAccess,
    runtime,
  );
  let view = snapshot(
    await runtime.within(() =>
      options.application.readEngineeringReconciliation(
        current.access,
        ticketId,
      ),
    ),
  );
  count(view.destinations.length, 4);
  for (const destination of view.destinations) {
    if (
      destination.reconciliation === "confirmed" ||
      destination.dispatchId === undefined
    )
      continue;
    const identity = destination.requestIdentity;
    if (identity === null || destination.requestIdentityStatus !== "available")
      return { outcome: "pending", processed };
    const observed = snapshot(
      await runtime.within(() =>
        options.github.reconcile(
          {
            repositoryId: destination.repositoryId,
            exportMarker: destination.exportMarker,
            dispatchId: destination.dispatchId!,
            requestHash: destination.requestHash,
            operation: identity.operation,
            ...(identity.issueId === undefined
              ? {}
              : { issueId: identity.issueId }),
            ...(identity.issueNumber === undefined
              ? {}
              : { issueNumber: identity.issueNumber }),
            sourceFence: {
              ticketId,
              sourceGeneration: destination.sourceGeneration,
              sourceBindingHash: identity.sourceBindingHash,
            },
            repositoryMetadataHash: identity.repositoryMetadataHash,
          },
          context(runtime, runtime.deadline),
        ),
      ),
    );
    const result =
      observed.outcome === "accepted"
        ? {
            outcome: "accepted" as const,
            acknowledgement: acknowledgement(
              observed.acknowledgement,
              destination.repositoryId,
            ),
            proof: scalar(observed.proof),
          }
        : observed.outcome === "confirmed_rejected"
          ? {
              outcome: "confirmed_rejected" as const,
              proof: scalar(observed.proof),
            }
          : {
              outcome: "unknown" as const,
              reason: "remote_acceptance_unknown",
            };
    if (
      result.outcome === "accepted" &&
      identity.operation === "link_existing_issue" &&
      (result.acknowledgement.issueId !== identity.issueId ||
        result.acknowledgement.issueNumber !== identity.issueNumber)
    )
      return { outcome: "pending", processed };
    const command = snapshot({
      ticketId,
      sourceGeneration: destination.sourceGeneration,
      expectedSourceWorkGeneration: view.sourceWorkGeneration,
      repositoryId: destination.repositoryId,
      dispatchId: destination.dispatchId,
      requestHash: destination.requestHash,
      result,
    });
    const guard = async (): Promise<void> => {
      const latestAuthority = await engineeringAuthority(
        options.reconciliationAccess,
        runtime,
      );
      if (canonical(latestAuthority) !== canonical(current))
        throw new AssistantBoundaryError("authority_changed");
      const latest = await runtime.within(() =>
        options.application.readEngineeringReconciliation(
          latestAuthority.access,
          ticketId,
        ),
      );
      if (
        latest.sourceWorkGeneration !== command.expectedSourceWorkGeneration ||
        !latest.destinations.some(
          (entry) =>
            entry.dispatchId === destination.dispatchId &&
            entry.requestHash === destination.requestHash &&
            entry.exportMarker === destination.exportMarker,
        )
      )
        throw new AssistantBoundaryError("reconciliation_changed");
      runtime.ensure();
    };
    let saved = false;
    for (
      let attempt = 0;
      attempt < count(options.storageCommandAttempts ?? 2, 3, 1);
      attempt += 1
    ) {
      try {
        const access = await engineeringAuthority(
          options.reconciliationAccess,
          runtime,
        );
        view = snapshot(
          await runtime.within(() =>
            options.application.recordEngineeringReconciliation(
              access.access,
              command,
              guard,
            ),
          ),
        );
        saved = true;
        processed += 1;
        break;
      } catch {
        /* Repeat only this observed result and original source-work fence. */
      }
    }
    if (!saved || result.outcome === "unknown")
      return { outcome: "pending", processed };
  }
  return {
    outcome: view.destinations.every(
      (entry) => entry.reconciliation === "confirmed",
    )
      ? "reconciled"
      : "pending",
    processed,
  };
}

async function finish(
  options: SupportDeskEngineeringOptions,
  claim: EngineeringClaim,
  runtime: LearningRuntime,
  reason: string,
  proposal?: EngineeringPreparedProposal,
): Promise<EngineeringProcessResult> {
  const disposition = reason === "security_restricted" ? "restricted" : "held";
  const classificationCandidateHash =
    disposition === "restricted" ? claim.work.candidateHash : undefined;
  const boundStep =
    proposal ??
    (classificationCandidateHash !== undefined &&
    claim.work.stepId !== undefined &&
    claim.work.requestHash !== undefined
      ? { stepId: claim.work.stepId, requestHash: claim.work.requestHash }
      : undefined);
  if (classificationCandidateHash !== undefined && boundStep === undefined)
    throw new AssistantBoundaryError("preparation_mismatch");
  const command: FinishEngineeringWorkCommand = snapshot({
    ...claim.fence,
    ...(boundStep === undefined
      ? {}
      : { stepId: boundStep.stepId, requestHash: boundStep.requestHash }),
    ...(classificationCandidateHash === undefined
      ? {}
      : { classificationCandidateHash }),
    disposition,
    reason,
  });
  for (
    let attempt = 0;
    attempt < count(options.storageCommandAttempts ?? 2, 3, 1);
    attempt += 1
  ) {
    try {
      const current = await engineeringAuthority(
        options.serviceAccess,
        runtime,
      );
      const result = await runtime.within(() =>
        options.application.finishEngineeringWork(current.access, command),
      );
      return {
        outcome: result.status === "restricted" ? "restricted" : "held",
        result,
      };
    } catch {
      /* A changed claim or accepted operation cannot be overwritten. */
    }
  }
  return { outcome: "pending", stage: "finish" };
}

/** Sanitize locally, independently check exact bytes, then persist a staff-reviewable proposal. */
export async function prepareEngineeringExport(
  options: SupportDeskEngineeringOptions,
  claim: EngineeringClaim,
  runtime: LearningRuntime,
): Promise<EngineeringProcessResult> {
  try {
    if (
      claim.work.proposal !== undefined &&
      claim.work.proposalNeedsRebuild !== true
    ) {
      const held = await finish(
        options,
        claim,
        runtime,
        "awaiting_staff_approval",
        claim.work.proposal,
      );
      return held.outcome === "held"
        ? { outcome: "prepared", result: held.result }
        : held;
    }
    const candidate = claim.work.candidate;
    const previousRequest =
      claim.work.proposalNeedsRebuild === true
        ? claim.work.proposal?.request
        : undefined;
    if (
      claim.work.candidateHash === undefined ||
      (candidate === undefined && previousRequest === undefined) ||
      (candidate !== undefined &&
        claim.work.candidateHash !== (await fingerprint(candidate)))
    )
      throw new AssistantBoundaryError("candidate_changed");
    if (candidate !== undefined && candidate.security !== "ordinary")
      throw new AssistantBoundaryError("security_restricted");
    const content: EngineeringProposalContent =
      candidate === undefined
        ? { previousRequest: previousRequest! }
        : { candidate };
    const authority = await engineeringProcessingAuthority(
      options.serviceAccess,
      runtime,
    );
    const source = await engineeringSource(
      options,
      claim.sourceFence,
      runtime,
      authority,
    );
    const policy = await engineeringPolicy(options, authority, runtime);
    const config = await engineeringConfiguration(
      options.configuration,
      runtime,
      () => timestamp(options.clock.now()),
    );
    const checkPolicy = await engineeringCheckPolicy(options, runtime);
    const deadline = Math.min(
      runtime.deadline,
      timestamp(claim.leaseUntil),
      timestamp(claim.work.deadline),
      timestamp(config.dataControls.validUntil),
      timestamp(checkPolicy.validUntil),
    );
    const phase =
      deadline - count(options.commitReserveMilliseconds ?? 1_000, 5_000, 1);
    runtime.ensure(phase);
    const lastModel = claim.work.modelAttempts.at(-1);
    if (lastModel === undefined)
      throw new AssistantBoundaryError("model_binding_missing");
    const selectedId =
      claim.work.staffSelection?.repositoryId ??
      (candidate?.routing.outcome === "selected"
        ? candidate.routing.repositoryId
        : undefined);
    if (selectedId === undefined)
      throw new AssistantBoundaryError("routing_human_required");
    const allowed = descriptor(policy, selectedId);
    let routingBinding: EngineeringPreparedProposal["routingBinding"];
    let routingReceipt: string | undefined;
    let routingHash: string;
    if (claim.work.staffSelection !== undefined) {
      if (
        claim.work.staffSelection.policyGeneration !== policy.generation ||
        claim.work.staffSelection.policyHash !== policy.policyHash
      )
        throw new AssistantBoundaryError("staff_selection_changed");
      routingHash = await engineeringStaffSelectionHash(
        claim.work.staffSelection,
      );
    } else {
      if (candidate === undefined)
        throw new AssistantBoundaryError("routing_human_required");
      if (
        lastModel.binding.inputManifest.policyGeneration !==
          policy.generation ||
        lastModel.binding.inputManifest.policyHash !== policy.policyHash
      )
        throw new AssistantBoundaryError("routing_human_required");
      await engineeringCalibration(
        options,
        {
          modelVersion: lastModel.binding.modelVersion,
          promptVersion: lastModel.binding.promptVersion,
          parserVersion: lastModel.binding.parserVersion,
          policyHash: policy.policyHash,
        },
        runtime,
        phase,
      );
      routingBinding = await engineeringRoutingBinding({
        sourceBindingHash: claim.sourceFence.sourceBindingHash,
        evidenceFingerprint: source.evidenceFingerprint!,
        candidateHash: claim.work.candidateHash!,
        inputFingerprint: lastModel.binding.inputFingerprint,
        routing: candidate.routing,
        policyGeneration: policy.generation,
        policyHash: policy.policyHash,
        modelVersion: lastModel.binding.modelVersion,
        promptVersion: lastModel.binding.promptVersion,
        parserVersion: lastModel.binding.parserVersion,
        repositoryId: selectedId,
      });
      const routed = await runtime.within(
        () =>
          options.routing.check(
            { candidate, binding: routingBinding! },
            context(runtime, phase),
          ),
        phase,
      );
      if (routed.outcome !== "checked")
        throw new AssistantBoundaryError(
          routed.outcome === "restricted"
            ? "security_restricted"
            : "routing_human_required",
        );
      routingReceipt = scalar(routed.receipt);
      routingHash = await engineeringRoutingBindingHash(routingBinding);
    }
    const metadata = await engineeringRepository(
      options,
      selectedId,
      runtime,
      phase,
    );
    matchesDescriptor(metadata.repository, allowed);
    const marker =
      "pegma-engineering:" +
      (
        await fingerprint({
          sourceFence: claim.sourceFence,
          candidateHash: claim.work.candidateHash,
          repositoryId: selectedId,
        })
      ).slice(0, 48);
    const query = await runtime.within(
      () => options.proposals.duplicateQuery(allowed, context(runtime, phase)),
      phase,
    );
    if (query === null)
      throw new AssistantBoundaryError("duplicate_query_unavailable");
    const duplicates = snapshot(
      await runtime.within(
        () =>
          options.github.searchDuplicates(
            {
              repositoryId: selectedId,
              query: scalar(query, 256),
              limit: 5,
            },
            context(runtime, phase),
          ),
        phase,
      ),
    );
    count(duplicates.physicalResults, 5);
    if (
      !Array.isArray(duplicates.issues) ||
      duplicates.issues.length > duplicates.physicalResults
    )
      throw new AssistantBoundaryError("duplicate_budget_exceeded");
    const duplicateIds = new Set<string>();
    for (const issue of duplicates.issues) {
      if (
        issue.repositoryId !== selectedId ||
        duplicateIds.has(scalar(issue.issueId))
      )
        throw new AssistantBoundaryError("duplicate_invalid");
      duplicateIds.add(issue.issueId);
      count(issue.issueNumber, Number.MAX_SAFE_INTEGER, 1);
      scalar(issue.title, 200);
      text(issue.body, 12_000);
    }
    const prepared = await runtime.within(
      () =>
        options.proposals.prepare(
          {
            ...content,
            repository: metadata.repository,
            descriptor: allowed,
            exportMarker: marker,
            duplicates: duplicates.issues,
          },
          context(runtime, phase),
        ),
      phase,
    );
    if (prepared.outcome !== "prepared")
      throw new AssistantBoundaryError(
        prepared.outcome === "restricted"
          ? "security_restricted"
          : "proposal_held",
      );
    const request = exactRequest(
      prepared.request,
      metadata.repository,
      allowed,
      marker,
    );
    if (
      request.operation === "link_existing_issue" &&
      !duplicates.issues.some(
        (issue) =>
          issue.issueId === request.issueId &&
          issue.issueNumber === request.issueNumber,
      )
    )
      throw new AssistantBoundaryError("duplicate_not_observed");
    const binding = await engineeringExportChecksBinding({
      sourceBindingHash: claim.sourceFence.sourceBindingHash,
      evidenceFingerprint: source.evidenceFingerprint!,
      candidateHash: claim.work.candidateHash!,
      routingBindingHash: routingHash,
      exactRequest: request,
      policyGeneration: policy.generation,
      policyHash: policy.policyHash,
    });
    const checked = await runtime.within(
      () =>
        options.checks.check(
          {
            ...content,
            exactRequest: request,
            binding,
            checkPolicyVersion: checkPolicy.version,
          },
          context(runtime, phase),
        ),
      phase,
    );
    if (checked.outcome !== "checked")
      throw new AssistantBoundaryError(
        checked.outcome === "restricted" || checked.outcome === "unavailable"
          ? "security_restricted"
          : "independent_checks_held",
      );
    const checksReceipt = scalar(checked.receipt);
    const proposed: EngineeringPreparedProposal = snapshot({
      stepId: "uncommitted",
      requestHash: binding.requestHash,
      proposalHash: "uncommitted",
      candidateHash: claim.work.candidateHash!,
      preparedClaimGeneration: claim.fence.claimGeneration,
      policyGeneration: policy.generation,
      policyHash: policy.policyHash,
      repositoryMetadataHash: binding.repositoryMetadataHash,
      routingBindingHash: routingHash,
      ...(routingBinding === undefined ? {} : { routingBinding }),
      ...(routingReceipt === undefined ? {} : { routingReceipt }),
      checksBinding: binding,
      checksReceipt,
      request,
    });
    let applicationProof: (() => true) | undefined;
    let verifiedDeadline = deadline;
    const guard = async (
      observation?: EngineeringReviewObservation | EngineeringWorkerObservation,
    ) => {
      try {
        verifiedDeadline = Math.min(
          verifiedDeadline,
          await engineeringProposalGuard(
            options,
            claim.work,
            proposed,
            runtime,
            deadline,
            authority,
            observation,
            undefined,
            observation !== undefined,
          ),
        );
        const route = await engineeringConfiguration(
          options.configuration,
          runtime,
          () => timestamp(options.clock.now()),
          config.version,
          deadline,
        );
        if (canonical(route) !== canonical(config))
          throw new AssistantBoundaryError("configuration_changed");
        const currentCheckPolicy = await engineeringCheckPolicy(
          options,
          runtime,
          checkPolicy.version,
          deadline,
        );
        if (canonical(currentCheckPolicy) !== canonical(checkPolicy))
          throw new AssistantBoundaryError("check_policy_changed");
        // Reverify exact receipt expiry after the last awaited route/policy reads.
        verifiedDeadline = Math.min(
          verifiedDeadline,
          await engineeringProposalGuard(
            options,
            claim.work,
            proposed,
            runtime,
            deadline,
            authority,
            observation,
            undefined,
            observation !== undefined,
            observation !== undefined && "verifyApplication" in observation
              ? async () => {
                  applicationProof = await observation.verifyApplication();
                }
              : undefined,
          ),
        );
        return (): true => {
          runtime.ensure(verifiedDeadline);
          applicationProof?.();
          return true;
        };
      } catch (error) {
        if (observation !== undefined && "phase" in observation)
          throw new EngineeringWorkerGuardFailure(
            engineeringFailureCategory(error, "verification_unavailable"),
            observation.phase,
          );
        throw error;
      }
    };
    if (options.application.prepareEngineeringProposalObserved === undefined)
      await guard();
    const command: PrepareEngineeringProposalCommand = snapshot({
      ...claim.fence,
      candidateHash: claim.work.candidateHash!,
      ...(routingReceipt === undefined ? {} : { routingReceipt }),
      checksReceipt,
      exactRequest: request,
      policyGeneration: policy.generation,
      policyHash: policy.policyHash,
    });
    for (
      let attempt = 0;
      attempt < count(options.storageCommandAttempts ?? 2, 3, 1);
      attempt += 1
    ) {
      try {
        const current = await engineeringAuthority(
          options.serviceAccess,
          runtime,
          deadline,
        );
        const result = await runtime.within(
          () =>
            options.application.prepareEngineeringProposalObserved === undefined
              ? options.application.prepareEngineeringProposal(
                  current.access,
                  command,
                  async () => {
                    await guard();
                  },
                )
              : options.application.prepareEngineeringProposalObserved(
                  current.access,
                  command,
                  guard,
                ),
          deadline,
        );
        return { outcome: "prepared", result };
      } catch (error) {
        if (error instanceof EngineeringWorkerGuardFailure) throw error;
        /* Repeat exact checked proposal; never rebuild after lost acknowledgement. */
      }
    }
    return { outcome: "pending", stage: "prepare" };
  } catch (error) {
    return finish(
      options,
      claim,
      runtime,
      engineeringFailureCategory(error, "proposal_unavailable"),
      claim.work.proposal,
    );
  }
}
