import type { IsoTimestamp } from "@pegma/spine";
import type { EntityKey } from "@pegma/storage-core";
import type { Ticket } from "@pegma/support-desk-contracts";
import type {
  EngineeringCandidate,
  EngineeringClaimFence,
  EngineeringEvidence,
  EngineeringExportChecksBinding,
  EngineeringExportRequest,
  EngineeringIssueAcknowledgement,
  EngineeringModelBinding,
  EngineeringOptions,
  EngineeringProcessing,
  EngineeringProductContext,
  EngineeringRoutingBinding,
  EngineeringSecurity,
  EngineeringSourceResult,
  EngineeringStepResult,
} from "./engineering-types.js";
import {
  dataArray,
  dataObject,
  encodedBytes,
  fields,
  fingerprint,
  integer,
  text,
  timestamp,
} from "./assistant-turn-records.js";
import {
  safeLearningSnapshot,
  validateResolutionProduct,
} from "./resolution-learning-records.js";
import type {
  EngineeringEvidenceInput,
  EngineeringMismatch,
  EngineeringRepositoryDescriptor,
  EngineeringRepositoryObservation,
  EngineeringRepositoryPolicy,
  EngineeringPolicySnapshot,
  EngineeringRoutingDecision,
} from "./engineering-types.js";
import { SupportDeskLimitError } from "./index.js";

export interface EngineeringDestination {
  readonly repositoryId: string;
  readonly sourceGeneration: number;
  readonly stepId: string;
  readonly requestHash: string;
  readonly exportMarker: string;
  readonly dispatchId?: string;
  readonly outcome:
    | "prepared"
    | "dispatch_started"
    | "accepted"
    | "confirmed_rejected"
    | "unknown";
  readonly reconciliation: "pending" | "blocked" | "confirmed";
  readonly acknowledgement?: EngineeringIssueAcknowledgement;
  readonly lastReconciliation?: {
    readonly fingerprint: string;
    readonly proof?: string;
    readonly outcome: "accepted" | "confirmed_rejected" | "unknown";
    readonly observedAt: IsoTimestamp;
  };
}
export interface EngineeringSourceRecord {
  readonly kind: "engineering_source";
  readonly partition: string;
  readonly id: "engineering-source";
  readonly ticketId: string;
  readonly sourceId: string;
  readonly sourceGeneration: number;
  readonly workGeneration: number;
  readonly generationCount: number;
  readonly state:
    "unverified" | "eligible" | "restricted" | "held" | "withdrawn";
  readonly security: EngineeringSecurity;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
  readonly heldReason?: string;
  readonly acceptedTicketRevision?: number;
  readonly lastVisibleMessageId?: string;
  readonly proofIdentity?: string;
  readonly evidenceFingerprint?: string;
  readonly productContextFingerprint?: string;
  readonly sourceBindingHash?: string;
  readonly evidence?: EngineeringEvidence;
  readonly product?: EngineeringProductContext;
  readonly pendingEvidenceReference?: string;
  readonly destinations: readonly EngineeringDestination[];
  readonly reconciliationPending: boolean;
}
export interface EngineeringModelAttempt {
  readonly preparedClaimGeneration: number;
  readonly stepId: string;
  readonly requestHash: string;
  readonly binding: EngineeringModelBinding;
  readonly accounting: "not_called" | "accounted" | "unknown";
  readonly processing?: EngineeringProcessing;
}
export interface EngineeringStaffSelection {
  readonly repositoryId: string;
  readonly policyGeneration: number;
  readonly policyHash: string;
  readonly selectedBy: string;
  readonly selectedAt: IsoTimestamp;
  readonly reason: string;
  readonly commandId: string;
}
export interface EngineeringPreparedProposal {
  readonly stepId: string;
  readonly requestHash: string;
  readonly proposalHash: string;
  readonly candidateHash: string;
  readonly preparedClaimGeneration: number;
  readonly policyGeneration: number;
  readonly policyHash: string;
  readonly repositoryMetadataHash: string;
  readonly routingBindingHash: string;
  readonly routingBinding?: EngineeringRoutingBinding;
  readonly routingReceipt?: string;
  readonly checksBinding: EngineeringExportChecksBinding;
  readonly checksReceipt: string;
  readonly request: EngineeringExportRequest;
}
export interface EngineeringApproval {
  readonly proposalHash: string;
  readonly requestHash: string;
  readonly sourceBindingHash: string;
  readonly policyGeneration: number;
  readonly policyHash: string;
  readonly repositoryMetadataHash: string;
  readonly routingBindingHash: string;
  readonly checksBindingHash: string;
  readonly decision: "approve" | "reject";
  readonly reviewedBy: string;
  readonly reviewedAt: IsoTimestamp;
  readonly reason?: string;
}
export interface EngineeringDispatch {
  readonly dispatchId: string;
  readonly startedAt: IsoTimestamp;
  readonly workerId: string;
  readonly claimId: string;
  readonly claimGeneration: number;
  readonly repositoryId: string;
  readonly requestHash: string;
  readonly exportMarker: string;
}
export interface EngineeringWorkRecord {
  readonly kind: "engineering_work";
  readonly partition: string;
  readonly id: string;
  readonly ticketId: string;
  readonly sourceGeneration: number;
  readonly sourceBindingHash: string;
  readonly workGeneration: number;
  readonly acceptedTicketRevision: number;
  readonly createdAt: IsoTimestamp;
  readonly deadline: IsoTimestamp;
  readonly security: EngineeringSecurity;
  readonly evidence?: EngineeringEvidence;
  readonly product?: EngineeringProductContext;
  readonly status:
    | "pending"
    | "claimed"
    | "retry"
    | "candidate"
    | "prepared"
    | "approved"
    | "dispatch_started"
    | "accepted"
    | "confirmed_rejected"
    | "unknown"
    | "held"
    | "restricted"
    | "superseded";
  readonly stage: "model" | "proposal" | "dispatch" | "reconcile";
  readonly modelAttempts: readonly EngineeringModelAttempt[];
  readonly claimGeneration: number;
  readonly claim?: EngineeringClaimFence;
  readonly leaseUntil?: IsoTimestamp;
  readonly retryAt?: IsoTimestamp;
  readonly stepId?: string;
  readonly requestHash?: string;
  readonly candidate?: EngineeringCandidate;
  readonly candidateHash?: string;
  readonly staffSelection?: EngineeringStaffSelection;
  readonly proposal?: EngineeringPreparedProposal;
  /** One prior exact body retained only to rebuild against a new staff target. */
  readonly proposalNeedsRebuild?: boolean;
  readonly approval?: EngineeringApproval;
  readonly dispatch?: EngineeringDispatch;
  readonly acknowledgement?: EngineeringIssueAcknowledgement;
  readonly resultProof?: string;
  readonly heldReason?: string;
  readonly terminalReserveRows: 0 | 2;
  readonly proposalCount: number;
  readonly withdrawnRequest?: {
    readonly operation: "create_issue" | "link_existing_issue";
    readonly repositoryId: string;
    readonly repositoryMetadataHash: string;
    readonly exportMarker: string;
    readonly issueId?: string;
    readonly issueNumber?: number;
  };
  readonly usageTombstones?: readonly {
    readonly stepId: string;
    readonly requestHash: string;
    readonly usageReservationId: string;
    readonly accounting: "not_called" | "accounted" | "unknown";
  }[];
  readonly lastCompletion?: { readonly fingerprint: string };
  readonly lastFinish?: { readonly fingerprint: string };
  readonly lastDispatchResult?: { readonly fingerprint: string };
  readonly lastProposalPreparation?: {
    readonly fingerprint: string;
    readonly result: EngineeringStepResult;
  };
}
export interface EngineeringReceiptRecord {
  readonly kind: "engineering_receipt";
  readonly partition: string;
  readonly id: string;
  readonly fingerprint: string;
  readonly result: EngineeringSourceResult | EngineeringStepResult;
}
export interface ResolvedEngineeringOptions {
  readonly enabled: boolean;
  readonly productContext?: EngineeringOptions["productContext"];
  readonly testReceipts?: EngineeringOptions["testReceipts"];
  readonly routing?: EngineeringOptions["routing"];
  readonly checks?: EngineeringOptions["checks"];
  readonly repositoryMetadata?: EngineeringOptions["repositoryMetadata"];
  readonly dispatchResults?: EngineeringOptions["dispatchResults"];
  readonly trustTimeoutMilliseconds: number;
  readonly maxGenerations: number;
  readonly maxTargets: number;
  readonly maxProposals: number;
  readonly maxModelAttempts: number;
  readonly maxLeaseMilliseconds: number;
  readonly maxWorkMilliseconds: number;
}
export const engineeringMaximumRecordBytes = 60_000;
export const engineeringMaximumCandidateBytes = 16_000;
export const engineeringSourceKey = (ticketId: string): EntityKey => ({
  partition: ticketId,
  id: "engineering-source",
});
export const engineeringWorkKey = (
  ticketId: string,
  generation: number,
): EntityKey => ({ partition: ticketId, id: `engineering-work:${generation}` });
export const engineeringCommandKey = (
  ticketId: string,
  commandId: string,
): EntityKey => ({
  partition: ticketId,
  id: `engineering-command:${commandId}`,
});

export const safeEngineeringSnapshot = safeLearningSnapshot;
export const engineeringEncodedBytes = encodedBytes;
function prose(value: unknown, name: string, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maximum ||
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(value)
  )
    throw new TypeError(`${name} must be bounded text without unsafe controls`);
  return value;
}
function strings(
  value: unknown,
  name: string,
  maximum: number,
  width = 200,
  multiline = false,
): void {
  const seen = new Set<string>();
  for (const item of dataArray(value, name, maximum)) {
    const entry = multiline
      ? prose(item, name, width)
      : text(item, name, width);
    if (!multiline && seen.has(entry))
      throw new TypeError(`${name} contains duplicates`);
    seen.add(entry);
  }
}
function literals(
  value: unknown,
  name: string,
  choices: readonly string[],
): void {
  if (typeof value !== "string" || !choices.includes(value))
    throw new TypeError(`${name} is invalid`);
}
function optionalText(
  value: Record<string, unknown>,
  keys: readonly string[],
): void {
  for (const key of keys) if (value[key] !== undefined) text(value[key], key);
}
function optionalTime(
  value: Record<string, unknown>,
  keys: readonly string[],
): void {
  for (const key of keys)
    if (value[key] !== undefined) timestamp(value[key], key);
}
export function validateEngineeringProduct(
  value: unknown,
): asserts value is EngineeringProductContext {
  validateResolutionProduct(value);
}
export function validateEngineeringMismatch(
  value: unknown,
): asserts value is EngineeringMismatch {
  const mismatch = dataObject(value, "engineering mismatch");
  prose(mismatch.expectedBehavior, "expectedBehavior", 2_000);
  prose(mismatch.actualBehavior, "actualBehavior", 2_000);
  strings(mismatch.reproductionSteps, "reproductionSteps", 16, 1_000, true);
  strings(mismatch.visibleMessageIds, "visibleMessageIds", 16);
  if (
    (mismatch.reproductionSteps as readonly unknown[]).length === 0 ||
    (mismatch.visibleMessageIds as readonly unknown[]).length === 0
  )
    throw new TypeError(
      "Mismatch needs reproduction and visible report references",
    );
}
export function validateEngineeringEvidenceInput(
  value: unknown,
): asserts value is EngineeringEvidenceInput {
  const raw = dataObject(value, "engineering evidence input");
  const extra =
    raw.kind === "staff_verified_failure"
      ? "verificationReference"
      : raw.kind === "failed_test"
        ? "receipt"
        : null;
  if (extra === null)
    throw new TypeError("Only verified failure evidence is accepted");
  fields(raw, "engineering evidence input", [
    "kind",
    "expectedBehavior",
    "actualBehavior",
    "reproductionSteps",
    "visibleMessageIds",
    extra,
  ]);
  validateEngineeringMismatch(raw);
  text(raw[extra], extra);
  if (encodedBytes(value) > 16_000)
    throw new TypeError("Engineering evidence exceeds serialized limit");
}
export function validateEngineeringEvidence(
  value: unknown,
): asserts value is EngineeringEvidence {
  const raw = dataObject(value, "engineering evidence");
  const extra =
    raw.kind === "staff_verified_failure"
      ? "verificationReference"
      : raw.kind === "failed_test"
        ? "test"
        : null;
  if (extra === null)
    throw new TypeError(
      "Successful or unverified evidence cannot establish a bug",
    );
  fields(raw, "engineering evidence", [
    "kind",
    "actorId",
    "expectedBehavior",
    "actualBehavior",
    "reproductionSteps",
    "visibleMessageIds",
    extra,
  ]);
  text(raw.actorId, "actorId");
  validateEngineeringMismatch(raw);
  if (extra === "verificationReference")
    text(raw.verificationReference, "verificationReference");
  else {
    const test = fields(raw.test, "failed test", [
      "result",
      "executionId",
      "runnerId",
      "testId",
      "productBinding",
      "executedAt",
      "receiptId",
      "verifiedAt",
      "validUntil",
    ]);
    literals(test.result, "test.result", ["failed"]);
    for (const key of [
      "executionId",
      "runnerId",
      "testId",
      "productBinding",
      "receiptId",
    ])
      text(test[key], key);
    timestamp(test.executedAt, "executedAt");
    if (
      timestamp(test.validUntil, "validUntil") <
      timestamp(test.verifiedAt, "verifiedAt")
    )
      throw new TypeError("Test validity is inverted");
  }
  if (encodedBytes(value) > 16_000)
    throw new TypeError("Engineering evidence exceeds serialized limit");
}
export function validateEngineeringRepository(
  value: unknown,
): asserts value is EngineeringRepositoryDescriptor {
  const repo = fields(value, "repository descriptor", [
    "repositoryId",
    "owner",
    "name",
    "visibility",
    "responsibilities",
    "product",
    "component",
    "version",
    "allowedLabels",
    "allowedTemplates",
    "publicationMode",
    "enabled",
  ]);
  for (const key of ["repositoryId", "owner", "name"]) text(repo[key], key);
  literals(repo.visibility, "visibility", ["public", "private"]);
  literals(repo.publicationMode, "publicationMode", ["approval_required"]);
  text(repo.responsibilities, "responsibilities", 2_000);
  for (const key of ["product", "component", "version"])
    text(repo[key], key, 1_000);
  strings(repo.allowedLabels, "allowedLabels", 32, 100);
  strings(repo.allowedTemplates, "allowedTemplates", 8);
  if (typeof repo.enabled !== "boolean")
    throw new TypeError("Repository enabled must be boolean");
}
export function validateEngineeringPolicy(
  value: unknown,
): asserts value is EngineeringRepositoryPolicy {
  const policy = fields(value, "engineering policy", [
    "enabled",
    "repositories",
  ]);
  if (typeof policy.enabled !== "boolean")
    throw new TypeError("Policy enabled must be boolean");
  const seen = new Set<string>();
  for (const item of dataArray(policy.repositories, "repositories", 20)) {
    validateEngineeringRepository(item);
    if (seen.has(item.repositoryId))
      throw new TypeError("Duplicate repository identity");
    seen.add(item.repositoryId);
  }
}
export function validateEngineeringPolicySnapshot(
  value: unknown,
): asserts value is EngineeringPolicySnapshot {
  const policy = fields(value, "policy snapshot", [
    "generation",
    "policyHash",
    "policy",
  ]);
  integer(policy.generation, "policyGeneration", 0);
  text(policy.policyHash, "policyHash");
  validateEngineeringPolicy(policy.policy);
}
export function validateEngineeringRepositoryObservation(
  value: unknown,
): asserts value is EngineeringRepositoryObservation {
  const repo = fields(value, "repository observation", [
    "repositoryId",
    "owner",
    "name",
    "visibility",
    "installationBinding",
    "metadataVersion",
  ]);
  for (const key of [
    "repositoryId",
    "owner",
    "name",
    "installationBinding",
    "metadataVersion",
  ])
    text(repo[key], key);
  literals(repo.visibility, "visibility", ["public", "private"]);
}
export function validateEngineeringRoutingDecision(
  value: unknown,
): asserts value is EngineeringRoutingDecision {
  const route = dataObject(value, "routing decision");
  literals(route.outcome, "routing.outcome", [
    "selected",
    "ambiguous",
    "out_of_scope",
  ]);
  fields(route, "routing decision", [
    "outcome",
    "alternativeRepositoryIds",
    "rationale",
    ...(route.outcome === "selected" ? ["repositoryId"] : []),
  ]);
  strings(route.alternativeRepositoryIds, "alternativeRepositoryIds", 4);
  prose(route.rationale, "routing.rationale", 2_000);
  if (route.outcome === "selected") text(route.repositoryId, "repositoryId");
}
export function validateEngineeringCandidate(
  value: unknown,
): asserts value is EngineeringCandidate {
  const candidate = fields(value, "engineering candidate", [
    "title",
    "summary",
    "expectedBehavior",
    "actualBehavior",
    "reproductionSteps",
    "applicability",
    "security",
    "routing",
  ]);
  prose(candidate.title, "title", 200);
  prose(candidate.summary, "summary", 4_000);
  prose(candidate.expectedBehavior, "expectedBehavior", 2_000);
  prose(candidate.actualBehavior, "actualBehavior", 2_000);
  strings(candidate.reproductionSteps, "reproductionSteps", 16, 1_000, true);
  const product = fields(candidate.applicability, "candidate applicability", [
    "productId",
    "version",
    "buildId",
  ]);
  for (const key of ["productId", "version", "buildId"])
    text(product[key], key);
  literals(candidate.security, "security", [
    "ordinary",
    "restricted",
    "uncertain",
  ]);
  validateEngineeringRoutingDecision(candidate.routing);
  if (encodedBytes(value) > engineeringMaximumCandidateBytes)
    throw new TypeError("Engineering candidate exceeds serialized limit");
}
export function validateEngineeringModelBinding(
  value: unknown,
): asserts value is EngineeringModelBinding {
  const binding = fields(value, "engineering model binding", [
    "inputManifest",
    "inputFingerprint",
    "inputManifestHash",
    "configVersion",
    "promptVersion",
    "modelVersion",
    "parserVersion",
    "checkPolicyVersion",
    "budgetsHash",
    "usageReservationId",
    "deadline",
  ]);
  for (const key of Object.keys(binding).filter(
    (key) => key !== "inputManifest" && key !== "deadline",
  ))
    text(binding[key], key);
  timestamp(binding.deadline, "deadline");
  const manifest = fields(binding.inputManifest, "engineering manifest", [
    "messages",
    "evidenceFingerprint",
    "product",
    "policyGeneration",
    "policyHash",
    "repositoryIds",
  ]);
  text(manifest.evidenceFingerprint, "evidenceFingerprint");
  text(manifest.policyHash, "policyHash");
  integer(manifest.policyGeneration, "policyGeneration", 0);
  strings(manifest.repositoryIds, "repositoryIds", 20);
  const product = fields(manifest.product, "manifest product", [
    "productId",
    "version",
    "buildId",
    "binding",
    "contextVersion",
  ]);
  for (const key of Object.keys(product)) text(product[key], key);
  const ids = new Set<string>();
  const ordinals = new Set<number>();
  for (const item of dataArray(manifest.messages, "manifest messages", 100)) {
    const message = fields(item, "manifest message", ["messageId", "ordinal"]);
    const id = text(message.messageId, "messageId");
    const ordinal = integer(message.ordinal, "ordinal", 1);
    if (ids.has(id) || ordinals.has(ordinal))
      throw new TypeError("Duplicate manifest message");
    ids.add(id);
    ordinals.add(ordinal);
  }
}
export function validateEngineeringRoutingBinding(
  value: unknown,
): asserts value is EngineeringRoutingBinding {
  const binding = fields(value, "routing binding", [
    "sourceBindingHash",
    "evidenceFingerprint",
    "candidateHash",
    "inputFingerprint",
    "routingHash",
    "policyGeneration",
    "policyHash",
    "modelVersion",
    "promptVersion",
    "parserVersion",
    "repositoryId",
  ]);
  integer(binding.policyGeneration, "policyGeneration", 0);
  for (const key of Object.keys(binding).filter(
    (key) => key !== "policyGeneration",
  ))
    text(binding[key], key);
}
export function validateEngineeringExportChecksBinding(
  value: unknown,
): asserts value is EngineeringExportChecksBinding {
  const binding = fields(value, "export checks binding", [
    "sourceBindingHash",
    "evidenceFingerprint",
    "candidateHash",
    "routingBindingHash",
    "requestHash",
    "policyGeneration",
    "policyHash",
    "repositoryMetadataHash",
  ]);
  integer(binding.policyGeneration, "policyGeneration", 0);
  for (const key of Object.keys(binding).filter(
    (key) => key !== "policyGeneration",
  ))
    text(binding[key], key);
}
export function validateEngineeringExportRequest(
  value: unknown,
): asserts value is EngineeringExportRequest {
  const request = dataObject(value, "engineering export request");
  literals(request.operation, "operation", [
    "create_issue",
    "link_existing_issue",
  ]);
  fields(request, "engineering export request", [
    "operation",
    "repository",
    "bundle",
    ...(request.operation === "link_existing_issue"
      ? ["issueId", "issueNumber"]
      : []),
  ]);
  validateEngineeringRepositoryObservation(request.repository);
  const bundle = fields(
    request.bundle,
    "sanitized bundle",
    ["title", "body", "labels", "evidenceReferences", "exportMarker"],
    ["templateId"],
  );
  prose(bundle.title, "bundle.title", 200);
  prose(bundle.body, "bundle.body", 12_000);
  strings(bundle.labels, "labels", 32, 100);
  strings(bundle.evidenceReferences, "evidenceReferences", 16);
  text(bundle.exportMarker, "exportMarker");
  if (bundle.templateId !== undefined) text(bundle.templateId, "templateId");
  if (request.operation === "link_existing_issue") {
    text(request.issueId, "issueId");
    integer(request.issueNumber, "issueNumber", 1);
  }
  if (encodedBytes(value) > 24_000)
    throw new TypeError("Exact engineering request exceeds serialized limit");
}
export function validateEngineeringProcessing(
  value: unknown,
): asserts value is EngineeringProcessing {
  const processing = fields(
    value,
    "engineering processing",
    [],
    [
      "provider",
      "model",
      "requestId",
      "failureCategory",
      "inputTokens",
      "outputTokens",
      "costMicros",
      "currency",
    ],
  );
  for (const [key, item] of Object.entries(processing))
    if (["inputTokens", "outputTokens", "costMicros"].includes(key))
      integer(item, key, 0);
    else text(item, key);
}
export function validateEngineeringAcknowledgement(
  value: unknown,
): asserts value is EngineeringIssueAcknowledgement {
  const ack = fields(
    value,
    "issue acknowledgement",
    ["repositoryId", "issueId", "issueNumber"],
    ["url"],
  );
  text(ack.repositoryId, "repositoryId");
  text(ack.issueId, "issueId");
  integer(ack.issueNumber, "issueNumber", 1);
  if (ack.url !== undefined) text(ack.url, "url");
}
export function validateEngineeringStepResult(
  value: unknown,
): asserts value is EngineeringStepResult {
  const result = fields(
    value,
    "engineering step result",
    ["ticketId", "sourceGeneration", "workGeneration", "status"],
    [
      "stepId",
      "requestHash",
      "candidateHash",
      "proposalHash",
      "dispatchId",
      "acknowledgement",
    ],
  );
  text(result.ticketId, "ticketId");
  integer(result.sourceGeneration, "sourceGeneration", 1);
  integer(result.workGeneration, "workGeneration", 1);
  literals(result.status, "status", [
    "pending",
    "claimed",
    "retry",
    "candidate",
    "prepared",
    "approved",
    "dispatch_started",
    "accepted",
    "confirmed_rejected",
    "unknown",
    "held",
    "restricted",
    "superseded",
  ]);
  optionalText(result, [
    "stepId",
    "requestHash",
    "candidateHash",
    "proposalHash",
    "dispatchId",
  ]);
  if ((result.stepId === undefined) !== (result.requestHash === undefined))
    throw new TypeError(
      "Engineering step result must retain its complete step fence",
    );
  if (result.acknowledgement !== undefined) {
    fields(result.acknowledgement, "opaque engineering acknowledgement", [
      "repositoryId",
      "issueId",
      "issueNumber",
    ]);
    validateEngineeringAcknowledgement(result.acknowledgement);
  }
}

export function resolveEngineeringOptions(
  input: EngineeringOptions | undefined,
): ResolvedEngineeringOptions {
  const raw =
    input === undefined
      ? {}
      : fields(
          input,
          "engineering options",
          [],
          [
            "enabled",
            "productContext",
            "testReceipts",
            "routing",
            "checks",
            "repositoryMetadata",
            "dispatchResults",
            "trustTimeoutMilliseconds",
            "maxGenerations",
            "maxTargets",
            "maxProposals",
            "maxModelAttempts",
            "maxLeaseMilliseconds",
            "maxWorkMilliseconds",
          ],
        );
  if (raw.enabled !== undefined && typeof raw.enabled !== "boolean")
    throw new TypeError("engineering.enabled must be boolean");
  for (const [name, method] of [
    ["productContext", "resolve"],
    ["testReceipts", "verify"],
    ["routing", "verify"],
    ["checks", "verify"],
    ["repositoryMetadata", "resolve"],
    ["dispatchResults", "verify"],
  ] as const)
    if (
      raw[name] !== undefined &&
      (raw[name] === null ||
        typeof (raw[name] as Record<string, unknown>)[method] !== "function")
    )
      throw new TypeError(`engineering.${name}.${method} is required`);
  return {
    enabled: raw.enabled === true,
    ...(raw.productContext === undefined
      ? {}
      : {
          productContext: raw.productContext as NonNullable<
            EngineeringOptions["productContext"]
          >,
        }),
    ...(raw.testReceipts === undefined
      ? {}
      : {
          testReceipts: raw.testReceipts as NonNullable<
            EngineeringOptions["testReceipts"]
          >,
        }),
    ...(raw.routing === undefined
      ? {}
      : { routing: raw.routing as NonNullable<EngineeringOptions["routing"]> }),
    ...(raw.checks === undefined
      ? {}
      : { checks: raw.checks as NonNullable<EngineeringOptions["checks"]> }),
    ...(raw.repositoryMetadata === undefined
      ? {}
      : {
          repositoryMetadata: raw.repositoryMetadata as NonNullable<
            EngineeringOptions["repositoryMetadata"]
          >,
        }),
    ...(raw.dispatchResults === undefined
      ? {}
      : {
          dispatchResults: raw.dispatchResults as NonNullable<
            EngineeringOptions["dispatchResults"]
          >,
        }),
    trustTimeoutMilliseconds: integer(
      raw.trustTimeoutMilliseconds ?? 250,
      "trustTimeoutMilliseconds",
      1,
      1_000,
    ),
    maxGenerations: integer(raw.maxGenerations ?? 4, "maxGenerations", 1, 8),
    maxTargets: integer(raw.maxTargets ?? 2, "maxTargets", 1, 4),
    maxProposals: integer(raw.maxProposals ?? 4, "maxProposals", 1, 8),
    maxModelAttempts: integer(
      raw.maxModelAttempts ?? 2,
      "maxModelAttempts",
      1,
      4,
    ),
    maxLeaseMilliseconds: integer(
      raw.maxLeaseMilliseconds ?? 60_000,
      "maxLeaseMilliseconds",
      1,
      300_000,
    ),
    maxWorkMilliseconds: integer(
      raw.maxWorkMilliseconds ?? 300_000,
      "maxWorkMilliseconds",
      1,
      3_600_000,
    ),
  };
}
export async function createEngineeringSource(
  ticket: Ticket,
): Promise<EngineeringSourceRecord> {
  text(ticket.id, "ticketId");
  timestamp(ticket.createdAt, "createdAt");
  timestamp(ticket.updatedAt, "updatedAt");
  const source: EngineeringSourceRecord = {
    kind: "engineering_source",
    partition: ticket.id,
    id: "engineering-source",
    ticketId: ticket.id,
    sourceId: await fingerprint({
      system: "pegma.support-desk.engineering",
      ticketId: ticket.id,
    }),
    sourceGeneration: 0,
    workGeneration: 1,
    generationCount: 0,
    state: "unverified",
    security: "uncertain",
    createdAt: ticket.createdAt,
    updatedAt: ticket.updatedAt,
    destinations: [],
    reconciliationPending: false,
  };
  checkEngineeringRecordCapacity(source);
  return source;
}
export function maximumEngineeringSourceBytes(
  source: EngineeringSourceRecord,
): number {
  const escaped = "\ud800".repeat(200);
  const future = {
    ...source,
    sourceGeneration: Number.MAX_SAFE_INTEGER,
    workGeneration: Number.MAX_SAFE_INTEGER,
    state: "restricted",
    security: "restricted",
    updatedAt: "+275760-09-13T00:00:00.000Z",
    heldReason: escaped,
    pendingEvidenceReference: escaped,
    reconciliationPending: false,
    destinations: source.destinations.map((entry) => ({
      ...entry,
      dispatchId: entry.dispatchId ?? escaped,
      outcome: "confirmed_rejected",
      reconciliation: "confirmed",
      acknowledgement: entry.acknowledgement ?? {
        repositoryId: entry.repositoryId,
        issueId: escaped,
        issueNumber: Number.MAX_SAFE_INTEGER,
        url: escaped,
      },
      lastReconciliation: {
        fingerprint: "f".repeat(64),
        proof: escaped,
        outcome: "confirmed_rejected",
        observedAt: "+275760-09-13T00:00:00.000Z",
      },
    })),
  };
  return Math.max(encodedBytes(source), encodedBytes(future));
}
export function checkEngineeringRecordCapacity(
  value:
    EngineeringSourceRecord | EngineeringWorkRecord | EngineeringReceiptRecord,
): void {
  if (
    encodedBytes(value) > engineeringMaximumRecordBytes ||
    (value.kind === "engineering_source" &&
      maximumEngineeringSourceBytes(value) > engineeringMaximumRecordBytes)
  )
    throw new SupportDeskLimitError(
      "serialized_record",
      engineeringMaximumRecordBytes,
    );
  assertEngineeringRecord(value, { partition: value.partition, id: value.id });
}
function validateSource(value: Record<string, unknown>): void {
  fields(
    value,
    "engineering source",
    [
      "kind",
      "partition",
      "id",
      "ticketId",
      "sourceId",
      "sourceGeneration",
      "workGeneration",
      "generationCount",
      "state",
      "security",
      "createdAt",
      "updatedAt",
      "destinations",
      "reconciliationPending",
    ],
    [
      "heldReason",
      "acceptedTicketRevision",
      "lastVisibleMessageId",
      "proofIdentity",
      "evidenceFingerprint",
      "productContextFingerprint",
      "sourceBindingHash",
      "evidence",
      "product",
      "pendingEvidenceReference",
    ],
  );
  if (value.id !== "engineering-source")
    throw new TypeError("Invalid engineering source key");
  text(value.sourceId, "sourceId");
  integer(value.generationCount, "generationCount", 0, 8);
  timestamp(value.updatedAt, "updatedAt");
  literals(value.state, "source.state", [
    "unverified",
    "eligible",
    "restricted",
    "held",
    "withdrawn",
  ]);
  literals(value.security, "source.security", [
    "ordinary",
    "restricted",
    "uncertain",
  ]);
  optionalText(value, [
    "heldReason",
    "lastVisibleMessageId",
    "proofIdentity",
    "evidenceFingerprint",
    "productContextFingerprint",
    "sourceBindingHash",
    "pendingEvidenceReference",
  ]);
  if (value.acceptedTicketRevision !== undefined)
    integer(value.acceptedTicketRevision, "acceptedTicketRevision", 1);
  const destinations = dataArray(value.destinations, "destinations", 4);
  if (
    typeof value.reconciliationPending !== "boolean" ||
    value.reconciliationPending !==
      destinations.some(
        (entry) =>
          dataObject(entry, "destination").reconciliation !== "confirmed",
      )
  )
    throw new TypeError("Engineering reconciliation marker mismatch");
  const identities = new Set<string>();
  for (const item of destinations) {
    const destination = fields(
      item,
      "engineering destination",
      [
        "repositoryId",
        "sourceGeneration",
        "stepId",
        "requestHash",
        "exportMarker",
        "outcome",
        "reconciliation",
      ],
      ["dispatchId", "acknowledgement", "lastReconciliation"],
    );
    for (const key of ["repositoryId", "stepId", "requestHash", "exportMarker"])
      text(destination[key], key);
    integer(destination.sourceGeneration, "destination.sourceGeneration", 1);
    optionalText(destination, ["dispatchId"]);
    literals(destination.outcome, "destination.outcome", [
      "prepared",
      "dispatch_started",
      "accepted",
      "confirmed_rejected",
      "unknown",
    ]);
    literals(destination.reconciliation, "destination.reconciliation", [
      "pending",
      "blocked",
      "confirmed",
    ]);
    const identity = `${destination.sourceGeneration}:${destination.stepId}`;
    if (identities.has(identity))
      throw new TypeError("Duplicate engineering destination");
    identities.add(identity);
    if (destination.acknowledgement !== undefined) {
      validateEngineeringAcknowledgement(destination.acknowledgement);
      if (destination.acknowledgement.repositoryId !== destination.repositoryId)
        throw new TypeError("Destination repository mismatch");
    }
    if (destination.lastReconciliation !== undefined) {
      const last = fields(
        destination.lastReconciliation,
        "engineering reconciliation receipt",
        ["fingerprint", "outcome", "observedAt"],
        ["proof"],
      );
      text(last.fingerprint, "fingerprint");
      timestamp(last.observedAt, "observedAt");
      optionalText(last, ["proof"]);
      literals(last.outcome, "reconciliation.outcome", [
        "accepted",
        "confirmed_rejected",
        "unknown",
      ]);
    }
  }
  if (value.state === "eligible") {
    if (
      value.security !== "ordinary" ||
      value.sourceGeneration === 0 ||
      value.generationCount === 0
    )
      throw new TypeError(
        "Eligible source lacks an ordinary evidence generation",
      );
    for (const key of [
      "evidence",
      "product",
      "proofIdentity",
      "evidenceFingerprint",
      "productContextFingerprint",
      "sourceBindingHash",
      "acceptedTicketRevision",
      "lastVisibleMessageId",
    ])
      if (value[key] === undefined)
        throw new TypeError(`Eligible source lacks ${key}`);
    if (
      value.heldReason !== undefined ||
      value.pendingEvidenceReference !== undefined
    )
      throw new TypeError("Eligible source retains a pending evidence hold");
  }
  if (value.state === "withdrawn") {
    for (const key of [
      "evidence",
      "product",
      "proofIdentity",
      "evidenceFingerprint",
      "productContextFingerprint",
      "sourceBindingHash",
      "acceptedTicketRevision",
      "lastVisibleMessageId",
      "pendingEvidenceReference",
    ])
      if (value[key] !== undefined)
        throw new TypeError(
          "Withdrawn source retains private evidence bindings",
        );
    for (const item of destinations)
      if (
        dataObject(item, "destination").acknowledgement !== undefined &&
        dataObject(
          dataObject(item, "destination").acknowledgement,
          "acknowledgement",
        ).url !== undefined
      )
        throw new TypeError("Withdrawn source retains a destination URL");
  }
}
function validateWork(value: Record<string, unknown>): void {
  fields(
    value,
    "engineering work",
    [
      "kind",
      "partition",
      "id",
      "ticketId",
      "sourceGeneration",
      "sourceBindingHash",
      "workGeneration",
      "acceptedTicketRevision",
      "createdAt",
      "deadline",
      "security",
      "status",
      "stage",
      "modelAttempts",
      "claimGeneration",
      "terminalReserveRows",
      "proposalCount",
    ],
    [
      "evidence",
      "product",
      "claim",
      "leaseUntil",
      "retryAt",
      "stepId",
      "requestHash",
      "candidate",
      "candidateHash",
      "staffSelection",
      "proposal",
      "proposalNeedsRebuild",
      "approval",
      "dispatch",
      "acknowledgement",
      "resultProof",
      "heldReason",
      "withdrawnRequest",
      "usageTombstones",
      "lastCompletion",
      "lastFinish",
      "lastDispatchResult",
      "lastProposalPreparation",
    ],
  );
  if (
    value.id !==
    engineeringWorkKey(
      value.ticketId as string,
      value.sourceGeneration as number,
    ).id
  )
    throw new TypeError("Engineering work key mismatch");
  integer(value.sourceGeneration, "sourceGeneration", 1);
  text(value.sourceBindingHash, "sourceBindingHash");
  integer(value.acceptedTicketRevision, "acceptedTicketRevision", 1);
  timestamp(value.deadline, "deadline");
  integer(value.claimGeneration, "claimGeneration", 0);
  integer(value.proposalCount, "proposalCount", 0, 8);
  if (value.terminalReserveRows !== 0 && value.terminalReserveRows !== 2)
    throw new TypeError("Invalid engineering terminal reserve");
  literals(value.security, "work.security", [
    "ordinary",
    "restricted",
    "uncertain",
  ]);
  literals(value.stage, "work.stage", [
    "model",
    "proposal",
    "dispatch",
    "reconcile",
  ]);
  literals(value.status, "work.status", [
    "pending",
    "claimed",
    "retry",
    "candidate",
    "prepared",
    "approved",
    "dispatch_started",
    "accepted",
    "confirmed_rejected",
    "unknown",
    "held",
    "restricted",
    "superseded",
  ]);
  optionalText(value, [
    "stepId",
    "requestHash",
    "candidateHash",
    "resultProof",
    "heldReason",
  ]);
  optionalTime(value, ["leaseUntil", "retryAt"]);
  if (value.claim !== undefined) {
    const claim = fields(value.claim, "engineering claim", [
      "ticketId",
      "sourceGeneration",
      "workerId",
      "claimId",
      "claimGeneration",
    ]);
    for (const key of ["ticketId", "workerId", "claimId"])
      text(claim[key], key);
    integer(claim.sourceGeneration, "claim.sourceGeneration", 1);
    integer(claim.claimGeneration, "claim.claimGeneration", 1);
    if (
      claim.ticketId !== value.ticketId ||
      claim.sourceGeneration !== value.sourceGeneration ||
      claim.claimGeneration !== value.claimGeneration ||
      value.leaseUntil === undefined
    )
      throw new TypeError("Engineering claim envelope mismatch");
  }
  for (const item of dataArray(value.modelAttempts, "modelAttempts", 4)) {
    const attempt = fields(
      item,
      "engineering model attempt",
      [
        "preparedClaimGeneration",
        "stepId",
        "requestHash",
        "binding",
        "accounting",
      ],
      ["processing"],
    );
    integer(attempt.preparedClaimGeneration, "preparedClaimGeneration", 1);
    text(attempt.stepId, "stepId");
    text(attempt.requestHash, "requestHash");
    validateEngineeringModelBinding(attempt.binding);
    literals(attempt.accounting, "accounting", [
      "not_called",
      "accounted",
      "unknown",
    ]);
    if (attempt.processing !== undefined)
      validateEngineeringProcessing(attempt.processing);
  }
  if (value.candidate !== undefined)
    validateEngineeringCandidate(value.candidate);
  if (value.staffSelection !== undefined) {
    const selection = fields(
      value.staffSelection,
      "staff repository selection",
      [
        "repositoryId",
        "policyGeneration",
        "policyHash",
        "selectedBy",
        "selectedAt",
        "reason",
        "commandId",
      ],
    );
    for (const key of [
      "repositoryId",
      "policyHash",
      "selectedBy",
      "reason",
      "commandId",
    ])
      text(selection[key], key);
    integer(selection.policyGeneration, "policyGeneration", 0);
    timestamp(selection.selectedAt, "selectedAt");
  }
  if (value.proposal !== undefined) {
    const proposal = fields(
      value.proposal,
      "engineering proposal",
      [
        "stepId",
        "requestHash",
        "proposalHash",
        "candidateHash",
        "preparedClaimGeneration",
        "policyGeneration",
        "policyHash",
        "repositoryMetadataHash",
        "routingBindingHash",
        "checksBinding",
        "checksReceipt",
        "request",
      ],
      ["routingBinding", "routingReceipt"],
    );
    for (const key of [
      "stepId",
      "requestHash",
      "proposalHash",
      "candidateHash",
      "policyHash",
      "repositoryMetadataHash",
      "routingBindingHash",
      "checksReceipt",
    ])
      text(proposal[key], key);
    integer(proposal.preparedClaimGeneration, "preparedClaimGeneration", 1);
    integer(proposal.policyGeneration, "policyGeneration", 0);
    optionalText(proposal, ["routingReceipt"]);
    if (proposal.routingBinding !== undefined)
      validateEngineeringRoutingBinding(proposal.routingBinding);
    validateEngineeringExportChecksBinding(proposal.checksBinding);
    validateEngineeringExportRequest(proposal.request);
    if (value.candidate !== undefined)
      throw new TypeError("Candidate body duplicated beside exact proposal");
  }
  if (value.approval !== undefined) {
    const approval = fields(
      value.approval,
      "engineering approval",
      [
        "proposalHash",
        "requestHash",
        "sourceBindingHash",
        "policyGeneration",
        "policyHash",
        "repositoryMetadataHash",
        "routingBindingHash",
        "checksBindingHash",
        "decision",
        "reviewedBy",
        "reviewedAt",
      ],
      ["reason"],
    );
    for (const key of [
      "proposalHash",
      "requestHash",
      "sourceBindingHash",
      "policyHash",
      "repositoryMetadataHash",
      "routingBindingHash",
      "checksBindingHash",
      "reviewedBy",
    ])
      text(approval[key], key);
    integer(approval.policyGeneration, "policyGeneration", 0);
    timestamp(approval.reviewedAt, "reviewedAt");
    optionalText(approval, ["reason"]);
    literals(approval.decision, "review decision", ["approve", "reject"]);
  }
  if (value.dispatch !== undefined) {
    const dispatch = fields(value.dispatch, "engineering dispatch", [
      "dispatchId",
      "startedAt",
      "workerId",
      "claimId",
      "claimGeneration",
      "repositoryId",
      "requestHash",
      "exportMarker",
    ]);
    for (const key of [
      "dispatchId",
      "workerId",
      "claimId",
      "repositoryId",
      "requestHash",
      "exportMarker",
    ])
      text(dispatch[key], key);
    integer(dispatch.claimGeneration, "claimGeneration", 1);
    timestamp(dispatch.startedAt, "startedAt");
    if (value.requestHash !== dispatch.requestHash)
      throw new TypeError("Dispatch request mismatch");
  }
  if (value.acknowledgement !== undefined)
    validateEngineeringAcknowledgement(value.acknowledgement);
  if (value.withdrawnRequest !== undefined) {
    const request = fields(
      value.withdrawnRequest,
      "withdrawn engineering request",
      ["operation", "repositoryId", "repositoryMetadataHash", "exportMarker"],
      ["issueId", "issueNumber"],
    );
    literals(request.operation, "withdrawn.operation", [
      "create_issue",
      "link_existing_issue",
    ]);
    for (const key of [
      "repositoryId",
      "repositoryMetadataHash",
      "exportMarker",
    ])
      text(request[key], key);
    optionalText(request, ["issueId"]);
    if (request.issueNumber !== undefined)
      integer(request.issueNumber, "issueNumber", 1);
    if (
      request.operation === "link_existing_issue" &&
      (request.issueId === undefined || request.issueNumber === undefined)
    )
      throw new TypeError("Withdrawn issue link lacks identity");
  }
  if (value.usageTombstones !== undefined)
    for (const item of dataArray(value.usageTombstones, "usageTombstones", 4)) {
      const usage = fields(item, "engineering usage tombstone", [
        "stepId",
        "requestHash",
        "usageReservationId",
        "accounting",
      ]);
      for (const key of ["stepId", "requestHash", "usageReservationId"])
        text(usage[key], key);
      literals(usage.accounting, "accounting", [
        "not_called",
        "accounted",
        "unknown",
      ]);
    }
  for (const key of ["lastCompletion", "lastFinish", "lastDispatchResult"])
    if (value[key] !== undefined) {
      const receipt = fields(value[key], key, ["fingerprint"]);
      text(receipt.fingerprint, "fingerprint");
    }
  if (
    value.proposalNeedsRebuild !== undefined &&
    typeof value.proposalNeedsRebuild !== "boolean"
  )
    throw new TypeError("Engineering proposal rebuild marker must be boolean");
  if (value.lastProposalPreparation !== undefined) {
    const prepared = fields(
      value.lastProposalPreparation,
      "engineering proposal preparation receipt",
      ["fingerprint", "result"],
    );
    text(prepared.fingerprint, "fingerprint");
    validateEngineeringStepResult(prepared.result);
    if (
      prepared.result.ticketId !== value.ticketId ||
      prepared.result.sourceGeneration !== value.sourceGeneration ||
      prepared.result.workGeneration > (value.workGeneration as number)
    )
      throw new TypeError(
        "Engineering proposal preparation receipt differs from its work",
      );
  }
  validateWorkRelationships(value);
}
function validateWorkRelationships(value: Record<string, unknown>): void {
  const work = value as unknown as EngineeringWorkRecord;
  const scrubbed =
    work.usageTombstones !== undefined || work.withdrawnRequest !== undefined;
  if ((work.claim === undefined) !== (work.leaseUntil === undefined))
    throw new TypeError("Engineering claim and lease must be paired");
  if ((work.stepId === undefined) !== (work.requestHash === undefined))
    throw new TypeError("Engineering step and request hash must be paired");
  if (work.status === "claimed" && work.claim === undefined)
    throw new TypeError("Claimed engineering work lacks its claim");
  const attemptIds = new Set<string>();
  const owners = new Set<number>();
  for (const attempt of work.modelAttempts) {
    if (
      attempt.preparedClaimGeneration > work.claimGeneration ||
      attemptIds.has(attempt.stepId) ||
      owners.has(attempt.preparedClaimGeneration)
    )
      throw new TypeError(
        "Engineering model attempt ownership is inconsistent",
      );
    attemptIds.add(attempt.stepId);
    owners.add(attempt.preparedClaimGeneration);
  }
  if (scrubbed) {
    if (
      ![
        "privacy_withdrawal",
        "source_access_revoked",
        "source_deleted",
      ].includes(work.heldReason ?? "")
    )
      throw new TypeError(
        "Scrubbed engineering work lacks its permanent withdrawal reason",
      );
    for (const key of [
      "evidence",
      "product",
      "candidate",
      "candidateHash",
      "staffSelection",
      "proposal",
      "proposalNeedsRebuild",
      "approval",
      "lastProposalPreparation",
    ])
      if (value[key] !== undefined)
        throw new TypeError(
          "Withdrawn engineering work retains private derivation data",
        );
    if (
      work.modelAttempts.length !== 0 ||
      work.claim !== undefined ||
      work.acknowledgement?.url !== undefined
    )
      throw new TypeError(
        "Withdrawn engineering work retains private model or URL data",
      );
  } else {
    if (work.evidence === undefined || work.product === undefined)
      throw new TypeError(
        "Engineering work lacks its accepted evidence and product",
      );
    if (work.candidate !== undefined && work.candidateHash === undefined)
      throw new TypeError("Engineering candidate lacks its hash");
    if (
      work.status === "candidate" &&
      (work.candidateHash === undefined ||
        (work.candidate === undefined && work.staffSelection === undefined))
    )
      throw new TypeError(
        "Engineering candidate state lacks candidate or staff selection",
      );
    if (
      work.stage === "model" &&
      work.stepId !== undefined &&
      !work.modelAttempts.some(
        (attempt) =>
          attempt.stepId === work.stepId &&
          attempt.requestHash === work.requestHash,
      )
    )
      throw new TypeError("Engineering model step lacks its prepared attempt");
    if (
      work.status === "prepared" &&
      work.stage === "model" &&
      (work.claim === undefined || work.stepId === undefined)
    )
      throw new TypeError(
        "Prepared engineering model lacks its live preparation envelope",
      );
  }
  const proposal = work.proposal;
  if (
    work.proposalNeedsRebuild === true &&
    (proposal === undefined ||
      work.staffSelection === undefined ||
      work.approval !== undefined ||
      work.dispatch !== undefined ||
      work.candidate !== undefined ||
      work.stage !== "proposal")
  )
    throw new TypeError(
      "Engineering proposal rebuild lacks its retained prior body or staff target",
    );
  if (proposal !== undefined) {
    if (
      proposal.stepId !== work.stepId ||
      proposal.requestHash !== work.requestHash ||
      proposal.candidateHash !== work.candidateHash ||
      work.proposalCount === 0 ||
      proposal.preparedClaimGeneration > work.claimGeneration
    )
      throw new TypeError(
        "Engineering proposal differs from its work envelope",
      );
    const checks = proposal.checksBinding;
    if (
      checks.sourceBindingHash !== work.sourceBindingHash ||
      checks.candidateHash !== proposal.candidateHash ||
      checks.requestHash !== proposal.requestHash ||
      checks.policyGeneration !== proposal.policyGeneration ||
      checks.policyHash !== proposal.policyHash ||
      checks.repositoryMetadataHash !== proposal.repositoryMetadataHash ||
      checks.routingBindingHash !== proposal.routingBindingHash
    )
      throw new TypeError(
        "Engineering proposal check binding differs from its exact request",
      );
    if (
      (proposal.routingBinding === undefined) !==
      (proposal.routingReceipt === undefined)
    )
      throw new TypeError(
        "Engineering calibrated routing binding and receipt must be paired",
      );
    if (
      proposal.routingBinding === undefined &&
      work.staffSelection === undefined
    )
      throw new TypeError(
        "Engineering proposal lacks calibrated routing or staff selection",
      );
  }
  const approval = work.approval;
  if (
    approval !== undefined &&
    (work.proposalNeedsRebuild === true ||
      proposal === undefined ||
      approval.proposalHash !== proposal.proposalHash ||
      approval.requestHash !== proposal.requestHash ||
      approval.sourceBindingHash !== work.sourceBindingHash ||
      approval.policyGeneration !== proposal.policyGeneration ||
      approval.policyHash !== proposal.policyHash ||
      approval.repositoryMetadataHash !== proposal.repositoryMetadataHash ||
      approval.routingBindingHash !== proposal.routingBindingHash)
  )
    throw new TypeError(
      "Engineering approval differs from the exact prepared proposal",
    );
  if (
    work.status === "approved" &&
    (proposal === undefined ||
      approval?.decision !== "approve" ||
      work.stage !== "dispatch")
  )
    throw new TypeError("Approved engineering work lacks exact staff approval");
  if (
    !scrubbed &&
    work.status === "prepared" &&
    work.stage !== "model" &&
    proposal === undefined
  )
    throw new TypeError("Prepared engineering export lacks its exact proposal");
  if (work.dispatch === undefined) {
    if (
      work.terminalReserveRows !== 0 ||
      work.stage === "reconcile" ||
      ["dispatch_started", "accepted", "confirmed_rejected"].includes(
        work.status,
      ) ||
      work.acknowledgement !== undefined
    )
      throw new TypeError(
        "Engineering dispatch state lacks immutable dispatch identity",
      );
    return;
  }
  const dispatch = work.dispatch;
  if (
    work.stage !== "reconcile" ||
    !["dispatch_started", "unknown", "accepted", "confirmed_rejected"].includes(
      work.status,
    ) ||
    work.stepId === undefined ||
    dispatch.claimGeneration > work.claimGeneration
  )
    throw new TypeError(
      "Engineering dispatch recovery envelope is inconsistent",
    );
  const request =
    proposal === undefined
      ? work.withdrawnRequest
      : {
          operation: proposal.request.operation,
          repositoryId: proposal.request.repository.repositoryId,
          exportMarker: proposal.request.bundle.exportMarker,
          ...(proposal.request.operation === "link_existing_issue"
            ? {
                issueId: proposal.request.issueId,
                issueNumber: proposal.request.issueNumber,
              }
            : {}),
        };
  if (
    request === undefined ||
    request.repositoryId !== dispatch.repositoryId ||
    request.exportMarker !== dispatch.exportMarker
  )
    throw new TypeError(
      "Engineering dispatch lacks its original exact request identity",
    );
  const terminal =
    work.status === "accepted" || work.status === "confirmed_rejected";
  if (work.terminalReserveRows !== (terminal ? 0 : 2))
    throw new TypeError(
      "Engineering dispatch terminal reserve does not match its outcome",
    );
  if (terminal && !scrubbed && work.resultProof === undefined)
    throw new TypeError("Engineering terminal outcome lacks verified proof");
  if (work.status === "accepted") {
    const acknowledgement = work.acknowledgement;
    if (
      acknowledgement === undefined ||
      acknowledgement.repositoryId !== dispatch.repositoryId ||
      (request.operation === "link_existing_issue" &&
        (acknowledgement.issueId !== request.issueId ||
          acknowledgement.issueNumber !== request.issueNumber))
    )
      throw new TypeError(
        "Accepted engineering dispatch lacks its exact acknowledgement",
      );
  } else if (work.acknowledgement !== undefined)
    throw new TypeError(
      "Nonaccepted engineering dispatch retains an acknowledgement",
    );
}
export function assertEngineeringRecord(
  value: unknown,
  key: EntityKey,
): asserts value is
  EngineeringSourceRecord | EngineeringWorkRecord | EngineeringReceiptRecord {
  const row = dataObject(value, "engineering record");
  text(row.partition, "partition");
  text(row.ticketId ?? row.partition, "ticketId");
  text(row.id, "record.id", 400);
  if (
    row.partition !== key.partition ||
    row.id !== key.id ||
    (row.ticketId !== undefined && row.ticketId !== key.partition)
  )
    throw new TypeError("Engineering record physical envelope mismatch");
  if (row.kind === "engineering_receipt") {
    fields(row, "engineering receipt", [
      "kind",
      "partition",
      "id",
      "fingerprint",
      "result",
    ]);
    if (!(row.id as string).startsWith("engineering-command:"))
      throw new TypeError("Invalid engineering receipt key");
    text(row.fingerprint, "fingerprint");
    const outcome = dataObject(row.result, "engineering receipt result");
    text(outcome.ticketId, "ticketId");
    integer(outcome.sourceGeneration, "sourceGeneration", 0);
    if (outcome.ticketId !== row.partition)
      throw new TypeError("Receipt ticket mismatch");
    if (outcome.state !== undefined) {
      fields(
        outcome,
        "engineering source result",
        ["ticketId", "sourceGeneration", "state", "security"],
        ["heldReason"],
      );
      literals(outcome.state, "state", [
        "unverified",
        "eligible",
        "restricted",
        "held",
        "withdrawn",
      ]);
      literals(outcome.security, "security", [
        "ordinary",
        "restricted",
        "uncertain",
      ]);
      optionalText(outcome, ["heldReason"]);
    } else validateEngineeringStepResult(outcome);
  } else {
    integer(row.sourceGeneration, "sourceGeneration", 0);
    integer(row.workGeneration, "workGeneration", 1);
    timestamp(row.createdAt, "createdAt");
    if (row.kind === "engineering_source") validateSource(row);
    else if (row.kind === "engineering_work") validateWork(row);
    else throw new TypeError("Invalid engineering record kind");
    if (row.evidence !== undefined) validateEngineeringEvidence(row.evidence);
    if (row.product !== undefined) validateEngineeringProduct(row.product);
  }
  if (encodedBytes(value) > engineeringMaximumRecordBytes)
    throw new TypeError("Engineering record exceeds serialized limit");
  if (
    row.kind === "engineering_source" &&
    maximumEngineeringSourceBytes(value as EngineeringSourceRecord) >
      engineeringMaximumRecordBytes
  )
    throw new TypeError(
      "Engineering source lacks future reconciliation capacity",
    );
}
