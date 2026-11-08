import type { IsoTimestamp } from "@pegma/spine";
import type { EntityKey } from "@pegma/storage-core";
import type {
  EngineeringProcessing,
  EngineeringSecurity,
} from "./engineering-types.js";
import type {
  EngineeringFollowupAssociation,
  EngineeringFollowupBundle,
  EngineeringFollowupCandidate,
  EngineeringFollowupChecksBinding,
  EngineeringFollowupClaimFence,
  EngineeringFollowupContext,
  EngineeringFollowupDeploymentHead,
  EngineeringFollowupIssueHead,
  EngineeringFollowupModelBinding,
  EngineeringFollowupObservationResult,
  EngineeringFollowupOptions,
  EngineeringFollowupPostResult,
  EngineeringFollowupResult,
  EngineeringFollowupRetestRequest,
  EngineeringFollowupRetestResult,
  VerifiedEngineeringFollowupRetest,
  VerifiedEngineeringFollowupContext,
  EngineeringFollowupAttestation,
  EngineeringFollowupKbTarget,
  EngineeringFollowupPublicFact,
} from "./engineering-followup-types.js";
import {
  dataArray,
  dataObject,
  fields,
  text,
  integer,
  timestamp,
  encodedBytes,
  fingerprint,
} from "./assistant-turn-records.js";
import { safeLearningSnapshot } from "./resolution-learning-records.js";
import { validateEngineeringProcessing } from "./engineering-records.js";
import { SupportDeskLimitError } from "./index.js";

export interface EngineeringFollowupHeadRecord {
  readonly kind: "engineering_followup_head";
  readonly partition: string;
  readonly id: "engineering-followup-head";
  readonly ticketId: string;
  readonly headGeneration: number;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
  readonly workCount: number;
  readonly associationHeads: readonly {
    readonly associationKey: string;
    readonly issueHead: EngineeringFollowupIssueHead;
  }[];
  readonly deploymentContexts: readonly {
    readonly associationKey: string;
    readonly deploymentHead: EngineeringFollowupDeploymentHead;
    readonly mappingHash?: string;
    readonly heldReason?: string;
  }[];
  readonly heldReason?: string;
  readonly withdrawn?: boolean;
  readonly lastObservation?: {
    readonly fingerprint: string;
    readonly result: EngineeringFollowupObservationResult;
  };
}
export interface EngineeringFollowupModelAttempt {
  readonly preparedClaimGeneration: number;
  readonly stepId: string;
  readonly requestHash: string;
  readonly binding: EngineeringFollowupModelBinding;
  readonly accounting: "not_called" | "accounted" | "unknown";
  readonly processing?: EngineeringProcessing;
}
export interface EngineeringFollowupPreparedBundle {
  readonly bundle: EngineeringFollowupBundle;
  readonly bundleHash: string;
  readonly candidateHash: string;
  readonly binding: EngineeringFollowupChecksBinding;
  readonly checksReceipt: string;
}
export interface EngineeringFollowupRetestSummary {
  readonly requestId: string;
  readonly requestHash: string;
  readonly workBindingHash: string;
  readonly bundleHash: string;
  readonly productBinding: string;
  readonly result: "passed" | "failed";
  readonly executionHash: string;
  readonly verificationHash: string;
  readonly verifiedAt: IsoTimestamp;
  readonly receiptReference: string;
  readonly verifierReceiptId: string;
}
export interface EngineeringFollowupWorkRecord {
  readonly kind: "engineering_followup_work";
  readonly partition: string;
  readonly id: string;
  readonly ticketId: string;
  readonly workId: string;
  readonly semanticIdentity: {
    readonly repositoryId: string;
    readonly issueId: string;
    readonly semanticMappingId: string;
    readonly deploymentEpoch: string;
  };
  readonly association: EngineeringFollowupAssociation;
  readonly parentSourceGeneration: number;
  readonly acceptedTicketRevision: number;
  readonly lastVisibleMessageId: string;
  readonly context?: EngineeringFollowupContext;
  readonly workBindingHash: string;
  readonly workGeneration: number;
  readonly security: EngineeringSecurity;
  readonly createdAt: IsoTimestamp;
  readonly deadline: IsoTimestamp;
  readonly status:
    | "pending"
    | "claimed"
    | "model_prepared"
    | "retry"
    | "candidate"
    | "bundle_prepared"
    | "held"
    | "restricted"
    | "superseded"
    | "delivered";
  readonly stage: "model" | "bundle" | "delivered";
  readonly modelAttempts: readonly EngineeringFollowupModelAttempt[];
  readonly claimGeneration: number;
  readonly claim?: EngineeringFollowupClaimFence;
  readonly leaseUntil?: IsoTimestamp;
  readonly retryAt?: IsoTimestamp;
  readonly stepId?: string;
  readonly requestHash?: string;
  readonly candidate?: EngineeringFollowupCandidate;
  readonly candidateHash?: string;
  readonly preparedBundle?: EngineeringFollowupPreparedBundle;
  readonly bundleRevision: number;
  readonly completionRows: 0 | 3 | 5;
  readonly messageSlots: 0 | 1;
  readonly heldReason?: string;
  readonly withdrawn?: boolean;
  readonly delivered?: {
    readonly messageId: string;
    readonly ticketRevision: number;
    readonly bodyHash: string;
    readonly bundleHash: string;
    readonly commandId: string;
    readonly postedBy: string;
    readonly postedAt: IsoTimestamp;
  };
  readonly handoff?: {
    readonly kbProposal: EngineeringFollowupBundle["kbProposal"];
    readonly retestRequests: readonly EngineeringFollowupRetestRequest[];
  };
  readonly retestResults: readonly EngineeringFollowupRetestSummary[];
  readonly usageTombstones?: readonly {
    readonly stepId: string;
    readonly requestHash: string;
    readonly usageReservationId: string;
    readonly accounting: "not_called" | "accounted" | "unknown";
  }[];
  readonly lastCompletion?: {
    readonly fingerprint: string;
    readonly result: EngineeringFollowupResult;
  };
  readonly lastFinish?: {
    readonly fingerprint: string;
    readonly result: EngineeringFollowupResult;
  };
}
export interface EngineeringFollowupReceiptRecord {
  readonly kind: "engineering_followup_receipt";
  readonly partition: string;
  readonly id: string;
  readonly fingerprint: string;
  readonly recoveryFingerprint?: string;
  readonly result:
    | EngineeringFollowupResult
    | EngineeringFollowupObservationResult
    | EngineeringFollowupPostResult
    | EngineeringFollowupRetestResult;
}
export type EngineeringFollowupRecord =
  | EngineeringFollowupHeadRecord
  | EngineeringFollowupWorkRecord
  | EngineeringFollowupReceiptRecord;
export interface ResolvedEngineeringFollowupOptions {
  readonly enabled: boolean;
  readonly releaseEvidence?: EngineeringFollowupOptions["releaseEvidence"];
  readonly checks?: EngineeringFollowupOptions["checks"];
  readonly retestReceipts?: EngineeringFollowupOptions["retestReceipts"];
  readonly maxWorksets: number;
  readonly maxModelAttempts: number;
  readonly maxBundleRevisions: number;
  readonly trustTimeoutMilliseconds: number;
  readonly maxLeaseMilliseconds: number;
  readonly maxWorkMilliseconds: number;
}
export const engineeringFollowupMaximumRecordBytes = 60_000;
export const engineeringFollowupMaximumCandidateBytes = 16_000;
export const engineeringFollowupHeadKey = (ticketId: string): EntityKey => ({
  partition: ticketId,
  id: "engineering-followup-head",
});
export const engineeringFollowupWorkKey = (
  ticketId: string,
  workId: string,
): EntityKey => ({ partition: ticketId, id: `engineering-followup:${workId}` });
export const engineeringFollowupCommandKey = (
  ticketId: string,
  commandId: string,
): EntityKey => ({
  partition: ticketId,
  id: `engineering-followup-command:${commandId}`,
});
export const safeEngineeringFollowupSnapshot = safeLearningSnapshot;
export function engineeringFollowupRecoveryHash(
  value: unknown,
  name = "recoveryIntentHash",
): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
    throw new TypeError(`${name} must be a lowercase SHA-256 fingerprint`);
  return value;
}
/** The actual Support codec stores a JSON string inside this physical envelope. */
export function engineeringFollowupEncodedBytes(value: {
  readonly partition: string;
  readonly id: string;
}): number {
  return encodedBytes({
    partition: value.partition,
    id: value.id,
    payload: JSON.stringify(value),
  });
}
function choice(
  value: unknown,
  name: string,
  choices: readonly string[],
): void {
  if (typeof value !== "string" || !choices.includes(value))
    throw new TypeError(`${name} is invalid`);
}
function prose(value: unknown, name: string, maximum: number): void {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maximum ||
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(value)
  )
    throw new TypeError(`${name} must be bounded text without unsafe controls`);
}
function texts(
  value: unknown,
  name: string,
  maximum: number,
  width = 200,
  multiline = false,
): void {
  const seen = new Set<string>();
  for (const item of dataArray(value, name, maximum)) {
    if (multiline) prose(item, name, width);
    else text(item, name, width);
    if (!multiline && seen.has(item as string))
      throw new TypeError(`${name} contains duplicates`);
    seen.add(item as string);
  }
}
function optionalTexts(
  row: Record<string, unknown>,
  names: readonly string[],
): void {
  for (const name of names) if (row[name] !== undefined) text(row[name], name);
}
function optionalTimes(
  row: Record<string, unknown>,
  names: readonly string[],
): void {
  for (const name of names)
    if (row[name] !== undefined) timestamp(row[name], name);
}
function bodyLimit(value: unknown, name: string): void {
  if (encodedBytes(value) > engineeringFollowupMaximumCandidateBytes)
    throw new SupportDeskLimitError(
      "serialized_record",
      engineeringFollowupMaximumCandidateBytes,
    );
}
export function validateEngineeringFollowupAssociation(
  value: unknown,
): asserts value is EngineeringFollowupAssociation {
  const row = fields(value, "follow-up association", [
    "ticketId",
    "repositoryId",
    "issueId",
    "issueNumber",
    "dispatchId",
    "requestHash",
    "engineeringSourceGeneration",
    "followupRevocationEpoch",
  ]);
  for (const key of [
    "ticketId",
    "repositoryId",
    "issueId",
    "dispatchId",
    "requestHash",
  ])
    text(row[key], key);
  integer(row.issueNumber, "issueNumber", 1);
  integer(row.engineeringSourceGeneration, "engineeringSourceGeneration", 1);
  integer(row.followupRevocationEpoch, "followupRevocationEpoch", 0);
}
export function validateEngineeringFollowupIssueHead(
  value: unknown,
): asserts value is EngineeringFollowupIssueHead {
  const row = fields(value, "follow-up issue head", [
    "repositoryId",
    "issueId",
    "issueNumber",
    "generation",
    "hash",
    "state",
  ]);
  for (const key of ["repositoryId", "issueId", "hash"]) text(row[key], key);
  integer(row.issueNumber, "issueNumber", 1);
  integer(row.generation, "issue generation", 0);
  choice(row.state, "issue state", ["open", "closed"]);
}
export function validateEngineeringFollowupDeploymentHead(
  value: unknown,
): asserts value is EngineeringFollowupDeploymentHead {
  const row = fields(value, "follow-up deployment head", [
    "contextRef",
    "generation",
    "hash",
    "state",
    "deploymentEpoch",
  ]);
  for (const key of ["contextRef", "hash", "deploymentEpoch"])
    text(row[key], key);
  integer(row.generation, "deployment generation", 0);
  choice(row.state, "deployment state", ["unknown", "deployed", "rolled_back"]);
}
export function validateEngineeringFollowupContext(
  value: unknown,
): asserts value is EngineeringFollowupContext {
  const row = fields(
    value,
    "follow-up context",
    ["issueHead", "deploymentHead"],
    ["mapping"],
  );
  validateEngineeringFollowupIssueHead(row.issueHead);
  validateEngineeringFollowupDeploymentHead(row.deploymentHead);
  if (row.mapping !== undefined) {
    const mapping = fields(row.mapping, "confirmed follow-up mapping", [
      "semanticMappingId",
      "mappingId",
      "mappingVersion",
      "affectedProductBinding",
      "fixedProduct",
      "releaseRef",
      "deploymentId",
      "scopeRef",
      "issueHeadHash",
      "deploymentHeadHash",
      "verification",
    ]);
    for (const key of [
      "semanticMappingId",
      "mappingId",
      "mappingVersion",
      "affectedProductBinding",
      "releaseRef",
      "deploymentId",
      "scopeRef",
      "issueHeadHash",
      "deploymentHeadHash",
    ])
      text(mapping[key], key);
    const product = fields(mapping.fixedProduct, "fixed product", [
      "productId",
      "version",
      "buildId",
    ]);
    for (const key of Object.keys(product)) text(product[key], key);
    const proof = dataObject(mapping.verification, "mapping verification");
    choice(proof.kind, "mapping verifier", ["host_release", "staff_verified"]);
    fields(proof, "mapping verification", [
      "kind",
      "reference",
      ...(proof.kind === "staff_verified" ? ["actorId"] : []),
    ]);
    text(proof.reference, "verification.reference");
    if (proof.kind === "staff_verified")
      text(proof.actorId, "verification.actorId");
    if (
      mapping.issueHeadHash !== row.issueHead.hash ||
      mapping.deploymentHeadHash !== row.deploymentHead.hash
    )
      throw new TypeError(
        "Follow-up mapping is not bound to its issue and deployment heads",
      );
  }
}
export function validateEngineeringFollowupAttestation(
  value: unknown,
): asserts value is EngineeringFollowupAttestation {
  const row = dataObject(value, "follow-up attestation");
  text(row.verifierReceiptId, "verifierReceiptId");
  text(row.verifierVersion, "verifierVersion");
  if (
    timestamp(row.validUntil, "validUntil") <=
    timestamp(row.verifiedAt, "verifiedAt")
  )
    throw new TypeError("Follow-up attestation validity is inverted");
}
export function validateEngineeringFollowupPublicFacts(
  value: unknown,
): asserts value is readonly EngineeringFollowupPublicFact[] {
  const seen = new Set<string>();
  for (const item of dataArray(value, "public release facts", 8)) {
    const fact = fields(item, "public release fact", ["reference", "text"]);
    const id = text(fact.reference, "fact.reference");
    prose(fact.text, "fact.text", 1_000);
    if (seen.has(id))
      throw new TypeError("Duplicate public release fact reference");
    seen.add(id);
  }
}
export function validateVerifiedEngineeringFollowupContext(
  value: unknown,
): asserts value is VerifiedEngineeringFollowupContext {
  const row = fields(value, "verified follow-up context", [
    "context",
    "publicFacts",
    "attestation",
  ]);
  validateEngineeringFollowupContext(row.context);
  validateEngineeringFollowupPublicFacts(row.publicFacts);
  fields(row.attestation, "follow-up attestation", [
    "verifierReceiptId",
    "verifierVersion",
    "verifiedAt",
    "validUntil",
  ]);
  validateEngineeringFollowupAttestation(row.attestation);
}
function validateAdvisory(value: unknown, name: string): void {
  const row = dataObject(value, name);
  texts(row.steps, `${name}.steps`, 16, 1_000, true);
  if ((row.steps as readonly unknown[]).length === 0)
    throw new TypeError("Retest requests need advisory steps");
  prose(row.expectedBehavior, `${name}.expectedBehavior`, 2_000);
}
function validateKbAdvice(value: Record<string, unknown>): void {
  prose(value.summary, "KB proposal summary", 2_000);
  texts(value.changes, "KB proposed changes", 16, 1_000, true);
  if ((value.changes as readonly unknown[]).length === 0)
    throw new TypeError("A KB proposal needs a proposed change");
  texts(
    value.advisoryValidationRequirements,
    "advisory validation requirements",
    16,
    1_000,
    true,
  );
}
export function validateEngineeringFollowupCandidate(
  value: unknown,
): asserts value is EngineeringFollowupCandidate {
  const row = fields(value, "follow-up candidate", [
    "customerDraft",
    "kbProposal",
    "retestRequests",
  ]);
  const customer = fields(row.customerDraft, "customer draft", ["body"]);
  prose(customer.body, "customerDraft.body", 4_000);
  if (row.kbProposal !== null) {
    const kb = fields(row.kbProposal, "KB change proposal", [
      "summary",
      "changes",
      "advisoryValidationRequirements",
    ]);
    validateKbAdvice(kb);
  }
  for (const item of dataArray(
    row.retestRequests,
    "advisory retest requests",
    4,
  )) {
    fields(item, "advisory retest request", ["steps", "expectedBehavior"]);
    validateAdvisory(item, "retest request");
  }
  bodyLimit(value, "candidate");
}
export function validateEngineeringFollowupKbTarget(
  value: unknown,
): asserts value is EngineeringFollowupKbTarget {
  const row = dataObject(value, "follow-up KB target");
  choice(row.kind, "KB target kind", ["none", "article"]);
  fields(
    row,
    "follow-up KB target",
    row.kind === "none"
      ? ["kind"]
      : [
          "kind",
          "articleId",
          "collectionId",
          "articleRevision",
          "contentHash",
          "validationRequirementsHash",
          "validationRequirementIds",
        ],
  );
  if (row.kind === "article") {
    for (const key of [
      "articleId",
      "collectionId",
      "contentHash",
      "validationRequirementsHash",
    ])
      text(row[key], key);
    integer(row.articleRevision, "articleRevision", 1);
    texts(row.validationRequirementIds, "validationRequirementIds", 32);
  }
}
export function validateEngineeringFollowupRetestRequest(
  value: unknown,
): asserts value is EngineeringFollowupRetestRequest {
  const row = fields(value, "bound retest request", [
    "requestId",
    "steps",
    "expectedBehavior",
    "productBinding",
    "validationRequirementIds",
  ]);
  text(row.requestId, "requestId");
  text(row.productBinding, "productBinding");
  texts(row.validationRequirementIds, "validationRequirementIds", 32);
  validateAdvisory(row, "retest request");
}
export function validateEngineeringFollowupBundle(
  value: unknown,
): asserts value is EngineeringFollowupBundle {
  const row = fields(value, "follow-up exact bundle", [
    "customerDraft",
    "kbProposal",
    "retestRequests",
  ]);
  const customer = fields(row.customerDraft, "customer draft", ["body"]);
  prose(customer.body, "customerDraft.body", 4_000);
  if (row.kbProposal !== null) {
    const kb = fields(row.kbProposal, "bound KB change proposal", [
      "target",
      "summary",
      "changes",
      "advisoryValidationRequirements",
    ]);
    validateEngineeringFollowupKbTarget(kb.target);
    validateKbAdvice(kb);
  }
  const ids = new Set<string>();
  for (const item of dataArray(
    row.retestRequests,
    "bound retest requests",
    4,
  )) {
    validateEngineeringFollowupRetestRequest(item);
    if (ids.has(item.requestId))
      throw new TypeError("Duplicate retest request ID");
    ids.add(item.requestId);
  }
  bodyLimit(value, "bundle");
}
export function validateEngineeringFollowupChecksBinding(
  value: unknown,
): asserts value is EngineeringFollowupChecksBinding {
  const row = fields(value, "follow-up checks binding", [
    "workBindingHash",
    "candidateHash",
    "bundleHash",
    "checkPolicyVersion",
    "followupRevocationEpoch",
    "issueHeadHash",
    "deploymentHeadHash",
  ]);
  for (const key of Object.keys(row).filter(
    (key) => key !== "followupRevocationEpoch",
  ))
    text(row[key], key);
  integer(row.followupRevocationEpoch, "followupRevocationEpoch", 0);
}
export function validateEngineeringFollowupModelBinding(
  value: unknown,
): asserts value is EngineeringFollowupModelBinding {
  const row = fields(value, "follow-up model binding", [
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
  for (const key of Object.keys(row).filter(
    (key) => !["inputManifest", "deadline"].includes(key),
  ))
    text(row[key], key);
  timestamp(row.deadline, "deadline");
  const manifest = fields(row.inputManifest, "follow-up input manifest", [
    "messages",
    "workBindingHash",
    "contextHash",
    "publicFactsHash",
  ]);
  for (const key of ["workBindingHash", "contextHash", "publicFactsHash"])
    text(manifest[key], key);
  const ids = new Set<string>();
  const ordinals = new Set<number>();
  for (const item of dataArray(manifest.messages, "manifest messages", 100)) {
    const ref = fields(item, "manifest message", ["messageId", "ordinal"]);
    const id = text(ref.messageId, "messageId");
    const ordinal = integer(ref.ordinal, "ordinal", 1);
    if (ids.has(id) || ordinals.has(ordinal))
      throw new TypeError("Duplicate follow-up manifest reference");
    ids.add(id);
    ordinals.add(ordinal);
  }
}
export function validateEngineeringFollowupResult(
  value: unknown,
): asserts value is EngineeringFollowupResult {
  const row = fields(
    value,
    "follow-up result",
    ["ticketId", "workId", "workGeneration", "status"],
    [
      "stepId",
      "requestHash",
      "candidateHash",
      "bundleHash",
      "messageId",
      "ticketRevision",
    ],
  );
  text(row.ticketId, "ticketId");
  text(row.workId, "workId");
  integer(row.workGeneration, "workGeneration", 1);
  choice(row.status, "status", [
    "pending",
    "claimed",
    "model_prepared",
    "retry",
    "candidate",
    "bundle_prepared",
    "held",
    "restricted",
    "superseded",
    "delivered",
  ]);
  optionalTexts(row, [
    "stepId",
    "requestHash",
    "candidateHash",
    "bundleHash",
    "messageId",
  ]);
  if (row.ticketRevision !== undefined)
    integer(row.ticketRevision, "ticketRevision", 1);
  if ((row.stepId === undefined) !== (row.requestHash === undefined))
    throw new TypeError("Follow-up result needs its complete step fence");
}
export function validateEngineeringFollowupRetestResult(
  value: unknown,
): asserts value is VerifiedEngineeringFollowupRetest {
  const row = fields(value, "verified follow-up retest", [
    "binding",
    "result",
    "executionId",
    "runnerId",
    "verifierReceiptId",
    "verifierVersion",
    "verifiedAt",
    "validUntil",
  ]);
  validateEngineeringFollowupAttestation(row);
  choice(row.result, "retest result", ["passed", "failed"]);
  text(row.executionId, "executionId");
  text(row.runnerId, "runnerId");
  const binding = fields(row.binding, "follow-up retest binding", [
    "ticketId",
    "workId",
    "workBindingHash",
    "requestId",
    "requestHash",
    "bundleHash",
    "productBinding",
  ]);
  for (const key of Object.keys(binding)) text(binding[key], key);
}
export function validateEngineeringFollowupRetestSummary(
  value: unknown,
): asserts value is EngineeringFollowupRetestSummary {
  const row = fields(value, "follow-up retest summary", [
    "requestId",
    "requestHash",
    "workBindingHash",
    "bundleHash",
    "productBinding",
    "result",
    "executionHash",
    "verificationHash",
    "verifiedAt",
    "receiptReference",
    "verifierReceiptId",
  ]);
  for (const key of ["requestId", "receiptReference", "verifierReceiptId"])
    text(row[key], key);
  for (const key of [
    "requestHash",
    "workBindingHash",
    "bundleHash",
    "productBinding",
    "executionHash",
    "verificationHash",
  ])
    engineeringFollowupRecoveryHash(row[key], key);
  choice(row.result, "retest result", ["passed", "failed"]);
  timestamp(row.verifiedAt, "verifiedAt");
}
export async function engineeringFollowupRetestSummary(
  proof: VerifiedEngineeringFollowupRetest,
  receiptReference: string,
): Promise<EngineeringFollowupRetestSummary> {
  validateEngineeringFollowupRetestResult(proof);
  text(receiptReference, "receiptReference");
  const summary = {
    requestId: proof.binding.requestId,
    requestHash: proof.binding.requestHash,
    workBindingHash: proof.binding.workBindingHash,
    bundleHash: proof.binding.bundleHash,
    productBinding: proof.binding.productBinding,
    result: proof.result,
    executionHash: await fingerprint({
      executionId: proof.executionId,
      runnerId: proof.runnerId,
    }),
    verificationHash: await fingerprint(proof),
    verifiedAt: proof.verifiedAt,
    receiptReference,
    verifierReceiptId: proof.verifierReceiptId,
  };
  validateEngineeringFollowupRetestSummary(summary);
  return summary;
}
export function engineeringFollowupModelAttemptCount(
  work: Pick<
    EngineeringFollowupWorkRecord,
    "modelAttempts" | "usageTombstones"
  >,
): number {
  const identities = new Set<string>();
  const requests = new Map<string, string>();
  for (const entry of [
    ...work.modelAttempts,
    ...(work.usageTombstones ?? []),
  ]) {
    const previous = requests.get(entry.stepId);
    if (previous !== undefined && previous !== entry.requestHash)
      throw new TypeError(
        "Follow-up attempt step has contradictory request hashes",
      );
    requests.set(entry.stepId, entry.requestHash);
    identities.add(JSON.stringify([entry.stepId, entry.requestHash]));
  }
  return identities.size;
}
export function resolveEngineeringFollowupOptions(
  value: EngineeringFollowupOptions | undefined,
): ResolvedEngineeringFollowupOptions {
  const raw =
    value === undefined
      ? {}
      : fields(
          value,
          "follow-up options",
          [],
          [
            "enabled",
            "releaseEvidence",
            "checks",
            "retestReceipts",
            "maxWorksets",
            "maxModelAttempts",
            "maxBundleRevisions",
            "trustTimeoutMilliseconds",
            "maxLeaseMilliseconds",
            "maxWorkMilliseconds",
          ],
        );
  if (raw.enabled !== undefined && typeof raw.enabled !== "boolean")
    throw new TypeError("follow-up enabled must be boolean");
  for (const [name, methods] of [
    ["releaseEvidence", ["verifyInput", "confirm"]],
    ["checks", ["verify"]],
    ["retestReceipts", ["verify"]],
  ] as const) {
    const port = raw[name];
    if (raw.enabled === true && port === undefined)
      throw new TypeError(`Enabled follow-up requires ${name}`);
    if (port !== undefined)
      for (const method of methods)
        if (
          port === null ||
          typeof (port as Record<string, unknown>)[method] !== "function"
        )
          throw new TypeError(`follow-up ${name}.${method} is required`);
  }
  return {
    enabled: raw.enabled === true,
    ...(raw.releaseEvidence === undefined
      ? {}
      : {
          releaseEvidence: raw.releaseEvidence as NonNullable<
            EngineeringFollowupOptions["releaseEvidence"]
          >,
        }),
    ...(raw.checks === undefined
      ? {}
      : {
          checks: raw.checks as NonNullable<
            EngineeringFollowupOptions["checks"]
          >,
        }),
    ...(raw.retestReceipts === undefined
      ? {}
      : {
          retestReceipts: raw.retestReceipts as NonNullable<
            EngineeringFollowupOptions["retestReceipts"]
          >,
        }),
    maxWorksets: integer(raw.maxWorksets ?? 4, "maxWorksets", 1, 8),
    maxModelAttempts: integer(
      raw.maxModelAttempts ?? 2,
      "maxModelAttempts",
      1,
      4,
    ),
    maxBundleRevisions: integer(
      raw.maxBundleRevisions ?? 4,
      "maxBundleRevisions",
      1,
      8,
    ),
    trustTimeoutMilliseconds: integer(
      raw.trustTimeoutMilliseconds ?? 1_000,
      "trustTimeoutMilliseconds",
      1,
      5_000,
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
export async function engineeringFollowupModelManifestHash(
  manifest: EngineeringFollowupModelBinding["inputManifest"],
): Promise<string> {
  validateEngineeringFollowupModelBinding({
    inputManifest: manifest,
    inputFingerprint: "manifest",
    inputManifestHash: "manifest",
    configVersion: "manifest",
    promptVersion: "manifest",
    modelVersion: "manifest",
    parserVersion: "manifest",
    checkPolicyVersion: "manifest",
    budgetsHash: "manifest",
    usageReservationId: "manifest",
    deadline: "2000-01-01T00:00:00.000Z",
  });
  return fingerprint(manifest);
}
export async function engineeringFollowupContextHash(
  context: EngineeringFollowupContext,
): Promise<string> {
  validateEngineeringFollowupContext(context);
  return fingerprint(context);
}
export async function engineeringFollowupPublicFactsHash(
  facts: readonly EngineeringFollowupPublicFact[],
): Promise<string> {
  validateEngineeringFollowupPublicFacts(facts);
  return fingerprint(facts);
}
export async function engineeringFollowupChecksBinding(input: {
  readonly workBindingHash: string;
  readonly candidateHash: string;
  readonly exactBundle: EngineeringFollowupBundle;
  readonly checkPolicyVersion: string;
  readonly followupRevocationEpoch: number;
  readonly context: EngineeringFollowupContext;
}): Promise<EngineeringFollowupChecksBinding> {
  validateEngineeringFollowupBundle(input.exactBundle);
  validateEngineeringFollowupContext(input.context);
  const binding = {
    workBindingHash: input.workBindingHash,
    candidateHash: input.candidateHash,
    bundleHash: await fingerprint(input.exactBundle),
    checkPolicyVersion: input.checkPolicyVersion,
    followupRevocationEpoch: input.followupRevocationEpoch,
    issueHeadHash: input.context.issueHead.hash,
    deploymentHeadHash: input.context.deploymentHead.hash,
  };
  validateEngineeringFollowupChecksBinding(binding);
  return binding;
}
export async function engineeringFollowupRetestRequestId(input: {
  readonly workId: string;
  readonly index: number;
  readonly steps: readonly string[];
  readonly expectedBehavior: string;
  readonly productBinding: string;
  readonly validationRequirementIds: readonly string[];
}): Promise<string> {
  text(input.workId, "workId");
  integer(input.index, "retest index", 0, 3);
  text(input.productBinding, "productBinding");
  texts(input.validationRequirementIds, "validationRequirementIds", 32);
  validateAdvisory(input, "retest request");
  return fingerprint(input);
}
export async function engineeringFollowupRetestProductBinding(
  context: EngineeringFollowupContext,
): Promise<string> {
  validateEngineeringFollowupContext(context);
  const mapping = context.mapping;
  if (mapping === undefined)
    throw new TypeError(
      "Retest product binding requires confirmed deployment mapping",
    );
  return fingerprint({
    fixedProduct: mapping.fixedProduct,
    deploymentId: mapping.deploymentId,
    scopeRef: mapping.scopeRef,
    deploymentEpoch: context.deploymentHead.deploymentEpoch,
  });
}
export async function engineeringFollowupRetestRequestHash(
  request: EngineeringFollowupRetestRequest,
): Promise<string> {
  validateEngineeringFollowupRetestRequest(request);
  return fingerprint(request);
}
function validateObservationResult(
  value: unknown,
): asserts value is EngineeringFollowupObservationResult {
  const row = fields(
    value,
    "follow-up observation result",
    ["ticketId", "headGeneration", "outcome"],
    ["workId", "reason"],
  );
  text(row.ticketId, "ticketId");
  integer(row.headGeneration, "headGeneration", 1);
  choice(row.outcome, "observation outcome", [
    "queued",
    "unchanged",
    "held",
    "stale",
  ]);
  optionalTexts(row, ["workId", "reason"]);
}
function validateCompactResult(value: unknown): void {
  const row = dataObject(value, "follow-up command result");
  if (row.status !== undefined) validateEngineeringFollowupResult(row);
  else if (row.headGeneration !== undefined) validateObservationResult(row);
  else if (row.messageId !== undefined) {
    fields(row, "follow-up post result", [
      "ticketId",
      "workId",
      "messageId",
      "ticketRevision",
      "bundleHash",
    ]);
    for (const key of ["ticketId", "workId", "messageId", "bundleHash"])
      text(row[key], key);
    integer(row.ticketRevision, "ticketRevision", 1);
  } else {
    fields(row, "follow-up retest result", [
      "ticketId",
      "workId",
      "outcome",
      "result",
    ]);
    text(row.ticketId, "ticketId");
    text(row.workId, "workId");
    choice(row.outcome, "retest recording outcome", [
      "recorded",
      "unchanged",
      "held",
    ]);
    choice(row.result, "retest result", ["passed", "failed"]);
  }
}
function validateHead(row: Record<string, unknown>): void {
  fields(
    row,
    "follow-up head",
    [
      "kind",
      "partition",
      "id",
      "ticketId",
      "headGeneration",
      "createdAt",
      "updatedAt",
      "workCount",
      "associationHeads",
      "deploymentContexts",
    ],
    ["heldReason", "withdrawn", "lastObservation"],
  );
  if (row.id !== "engineering-followup-head")
    throw new TypeError("Follow-up head key mismatch");
  integer(row.headGeneration, "headGeneration", 1);
  integer(row.workCount, "workCount", 0, 8);
  timestamp(row.updatedAt, "updatedAt");
  optionalTexts(row, ["heldReason"]);
  if (row.withdrawn !== undefined && typeof row.withdrawn !== "boolean")
    throw new TypeError("Follow-up withdrawal marker must be boolean");
  const associations = dataArray(row.associationHeads, "association heads", 4);
  const associationKeys = new Set<string>();
  for (const item of associations) {
    const entry = fields(item, "association head", [
      "associationKey",
      "issueHead",
    ]);
    const id = text(entry.associationKey, "associationKey");
    if (associationKeys.has(id))
      throw new TypeError("Duplicate follow-up association head");
    associationKeys.add(id);
    validateEngineeringFollowupIssueHead(entry.issueHead);
  }
  const contexts = dataArray(row.deploymentContexts, "deployment contexts", 8);
  const contextKeys = new Set<string>();
  for (const item of contexts) {
    const entry = fields(
      item,
      "deployment context head",
      ["associationKey", "deploymentHead"],
      ["mappingHash", "heldReason"],
    );
    const id = text(entry.associationKey, "associationKey");
    validateEngineeringFollowupDeploymentHead(entry.deploymentHead);
    optionalTexts(entry, ["mappingHash", "heldReason"]);
    const contextKey = JSON.stringify([id, entry.deploymentHead.contextRef]);
    if (!associationKeys.has(id) || contextKeys.has(contextKey))
      throw new TypeError(
        "Follow-up deployment context is unregistered or duplicated",
      );
    contextKeys.add(contextKey);
  }
  if (row.lastObservation !== undefined) {
    const last = fields(row.lastObservation, "last follow-up observation", [
      "fingerprint",
      "result",
    ]);
    text(last.fingerprint, "fingerprint");
    validateObservationResult(last.result);
    if (
      last.result.ticketId !== row.ticketId ||
      last.result.headGeneration > (row.headGeneration as number)
    )
      throw new TypeError(
        "Follow-up observation receipt differs from its head",
      );
  }
  if (
    row.withdrawn === true &&
    (associations.length !== 0 ||
      contexts.length !== 0 ||
      row.lastObservation !== undefined)
  )
    throw new TypeError("Withdrawn follow-up head retains private context");
}
function validateWork(row: Record<string, unknown>): void {
  fields(
    row,
    "follow-up work",
    [
      "kind",
      "partition",
      "id",
      "ticketId",
      "workId",
      "semanticIdentity",
      "association",
      "parentSourceGeneration",
      "acceptedTicketRevision",
      "lastVisibleMessageId",
      "workBindingHash",
      "workGeneration",
      "security",
      "createdAt",
      "deadline",
      "status",
      "stage",
      "modelAttempts",
      "claimGeneration",
      "bundleRevision",
      "completionRows",
      "messageSlots",
      "retestResults",
    ],
    [
      "context",
      "claim",
      "leaseUntil",
      "retryAt",
      "stepId",
      "requestHash",
      "candidate",
      "candidateHash",
      "preparedBundle",
      "heldReason",
      "withdrawn",
      "delivered",
      "handoff",
      "usageTombstones",
      "lastCompletion",
      "lastFinish",
    ],
  );
  text(row.workId, "workId");
  if (
    row.id !==
    engineeringFollowupWorkKey(row.ticketId as string, row.workId as string).id
  )
    throw new TypeError("Follow-up work physical key mismatch");
  const semantic = fields(row.semanticIdentity, "follow-up semantic identity", [
    "repositoryId",
    "issueId",
    "semanticMappingId",
    "deploymentEpoch",
  ]);
  for (const key of Object.keys(semantic)) text(semantic[key], key);
  validateEngineeringFollowupAssociation(row.association);
  if (
    row.association.ticketId !== row.ticketId ||
    row.association.repositoryId !== semantic.repositoryId ||
    row.association.issueId !== semantic.issueId
  )
    throw new TypeError(
      "Follow-up association differs from its semantic identity",
    );
  integer(row.parentSourceGeneration, "parentSourceGeneration", 1);
  integer(row.acceptedTicketRevision, "acceptedTicketRevision", 1);
  text(row.lastVisibleMessageId, "lastVisibleMessageId");
  text(row.workBindingHash, "workBindingHash");
  integer(row.workGeneration, "workGeneration", 1);
  choice(row.security, "security", ["ordinary", "restricted", "uncertain"]);
  timestamp(row.deadline, "deadline");
  choice(row.status, "work status", [
    "pending",
    "claimed",
    "model_prepared",
    "retry",
    "candidate",
    "bundle_prepared",
    "held",
    "restricted",
    "superseded",
    "delivered",
  ]);
  choice(row.stage, "work stage", ["model", "bundle", "delivered"]);
  integer(row.claimGeneration, "claimGeneration", 0);
  integer(row.bundleRevision, "bundleRevision", 0, 8);
  optionalTexts(row, ["stepId", "requestHash", "candidateHash", "heldReason"]);
  optionalTimes(row, ["leaseUntil", "retryAt"]);
  if (
    ![0, 3, 5].includes(row.completionRows as number) ||
    ![0, 1].includes(row.messageSlots as number) ||
    (row.completionRows === 0) !== (row.messageSlots === 0)
  )
    throw new TypeError(
      "Follow-up completion and message reservations disagree",
    );
  if (row.withdrawn !== undefined && typeof row.withdrawn !== "boolean")
    throw new TypeError("Follow-up withdrawal marker must be boolean");
  if (row.context !== undefined) {
    validateEngineeringFollowupContext(row.context);
    const mapping = row.context.mapping;
    if (
      row.context.issueHead.repositoryId !== semantic.repositoryId ||
      row.context.issueHead.issueId !== semantic.issueId ||
      row.context.deploymentHead.deploymentEpoch !== semantic.deploymentEpoch ||
      (mapping !== undefined &&
        mapping.semanticMappingId !== semantic.semanticMappingId)
    )
      throw new TypeError(
        "Follow-up context differs from its semantic work identity",
      );
  }
  if (
    (row.claim === undefined) !== (row.leaseUntil === undefined) ||
    (row.stepId === undefined) !== (row.requestHash === undefined)
  )
    throw new TypeError("Follow-up claim and step envelopes must be complete");
  if (row.claim !== undefined) {
    const claim = fields(row.claim, "follow-up claim", [
      "ticketId",
      "workId",
      "workerId",
      "claimId",
      "claimGeneration",
    ]);
    for (const key of ["ticketId", "workId", "workerId", "claimId"])
      text(claim[key], key);
    integer(claim.claimGeneration, "claimGeneration", 1);
    if (
      claim.ticketId !== row.ticketId ||
      claim.workId !== row.workId ||
      claim.claimGeneration !== row.claimGeneration
    )
      throw new TypeError("Follow-up claim differs from its work envelope");
  }
  const steps = new Set<string>();
  const owners = new Set<number>();
  const attempts = dataArray(row.modelAttempts, "follow-up model attempts", 4);
  for (const item of attempts) {
    const attempt = fields(
      item,
      "follow-up model attempt",
      [
        "preparedClaimGeneration",
        "stepId",
        "requestHash",
        "binding",
        "accounting",
      ],
      ["processing"],
    );
    const owner = integer(
      attempt.preparedClaimGeneration,
      "preparedClaimGeneration",
      1,
    );
    const step = text(attempt.stepId, "stepId");
    text(attempt.requestHash, "requestHash");
    validateEngineeringFollowupModelBinding(attempt.binding);
    choice(attempt.accounting, "accounting", [
      "not_called",
      "accounted",
      "unknown",
    ]);
    if (attempt.processing !== undefined)
      validateEngineeringProcessing(attempt.processing);
    if (
      owner > (row.claimGeneration as number) ||
      owners.has(owner) ||
      steps.has(step)
    )
      throw new TypeError("Follow-up model attempt ownership is inconsistent");
    owners.add(owner);
    steps.add(step);
  }
  if (row.candidate !== undefined) {
    validateEngineeringFollowupCandidate(row.candidate);
    if (row.candidateHash === undefined)
      throw new TypeError("Follow-up candidate lacks its hash");
  }
  if (row.preparedBundle !== undefined) {
    const prepared = fields(row.preparedBundle, "prepared follow-up bundle", [
      "bundle",
      "bundleHash",
      "candidateHash",
      "binding",
      "checksReceipt",
    ]);
    validateEngineeringFollowupBundle(prepared.bundle);
    for (const key of ["bundleHash", "candidateHash", "checksReceipt"])
      text(prepared[key], key);
    validateEngineeringFollowupChecksBinding(prepared.binding);
    if (
      row.candidate !== undefined ||
      prepared.candidateHash !== row.candidateHash ||
      prepared.binding.candidateHash !== prepared.candidateHash ||
      prepared.binding.bundleHash !== prepared.bundleHash ||
      prepared.binding.workBindingHash !== row.workBindingHash ||
      prepared.binding.followupRevocationEpoch !==
        row.association.followupRevocationEpoch ||
      row.bundleRevision === 0
    )
      throw new TypeError(
        "Prepared follow-up bundle differs from its work/check envelope",
      );
  }
  if (row.delivered !== undefined) {
    const delivered = fields(row.delivered, "follow-up delivered summary", [
      "messageId",
      "ticketRevision",
      "bodyHash",
      "bundleHash",
      "commandId",
      "postedBy",
      "postedAt",
    ]);
    for (const key of [
      "messageId",
      "bodyHash",
      "bundleHash",
      "commandId",
      "postedBy",
    ])
      text(delivered[key], key);
    integer(delivered.ticketRevision, "ticketRevision", 1);
    timestamp(delivered.postedAt, "postedAt");
  }
  if (row.handoff !== undefined) {
    const handoff = fields(row.handoff, "private follow-up handoff", [
      "kbProposal",
      "retestRequests",
    ]);
    if (handoff.kbProposal !== null) {
      const kb = fields(handoff.kbProposal, "private KB handoff", [
        "target",
        "summary",
        "changes",
        "advisoryValidationRequirements",
      ]);
      validateEngineeringFollowupKbTarget(kb.target);
      validateKbAdvice(kb);
    }
    for (const item of dataArray(
      handoff.retestRequests,
      "private retest handoffs",
      4,
    ))
      validateEngineeringFollowupRetestRequest(item);
    bodyLimit(handoff, "handoff");
  }
  const retests = dataArray(row.retestResults, "follow-up retest results", 4);
  const requests = new Set<string>();
  for (const item of retests) {
    validateEngineeringFollowupRetestSummary(item);
    if (requests.has(item.requestId))
      throw new TypeError("Follow-up retest result duplicates a request");
    requests.add(item.requestId);
  }
  if (row.usageTombstones !== undefined)
    for (const item of dataArray(
      row.usageTombstones,
      "follow-up usage tombstones",
      4,
    )) {
      const usage = fields(item, "follow-up usage tombstone", [
        "stepId",
        "requestHash",
        "usageReservationId",
        "accounting",
      ]);
      for (const key of ["stepId", "requestHash", "usageReservationId"])
        text(usage[key], key);
      choice(usage.accounting, "accounting", [
        "not_called",
        "accounted",
        "unknown",
      ]);
    }
  if (
    engineeringFollowupModelAttemptCount(
      row as unknown as EngineeringFollowupWorkRecord,
    ) > 4
  )
    throw new TypeError(
      "Follow-up model history exceeds its lifetime attempt bound",
    );
  for (const key of ["lastCompletion", "lastFinish"])
    if (row[key] !== undefined) {
      const receipt = fields(row[key], key, ["fingerprint", "result"]);
      text(receipt.fingerprint, "fingerprint");
      validateEngineeringFollowupResult(receipt.result);
      if (
        receipt.result.ticketId !== row.ticketId ||
        receipt.result.workId !== row.workId ||
        receipt.result.workGeneration > (row.workGeneration as number)
      )
        throw new TypeError("Follow-up inline receipt differs from its work");
    }
  if (row.withdrawn === true) {
    for (const key of [
      "context",
      "claim",
      "leaseUntil",
      "retryAt",
      "candidate",
      "candidateHash",
      "preparedBundle",
      "handoff",
    ])
      if (row[key] !== undefined)
        throw new TypeError(
          "Withdrawn follow-up retains private derivation data",
        );
    if (
      attempts.length !== 0 ||
      retests.length !== 0 ||
      row.completionRows !== 0
    )
      throw new TypeError(
        "Withdrawn follow-up retains private model/test data or reservations",
      );
  } else if (row.context === undefined)
    throw new TypeError("Live follow-up work lacks its current proof context");
  if (row.status === "claimed" && row.claim === undefined)
    throw new TypeError("Claimed follow-up work lacks its claim");
  if (
    row.status === "model_prepared" &&
    (row.stage !== "model" ||
      row.claim === undefined ||
      row.stepId === undefined)
  )
    throw new TypeError("Prepared follow-up model lacks its live envelope");
  if (
    row.stage === "model" &&
    row.stepId !== undefined &&
    row.withdrawn !== true &&
    !attempts.some((item) => {
      const attempt = item as EngineeringFollowupModelAttempt;
      return (
        attempt.stepId === row.stepId && attempt.requestHash === row.requestHash
      );
    })
  )
    throw new TypeError("Follow-up model step has no prepared attempt");
  if (
    row.status === "candidate" &&
    row.candidate === undefined &&
    row.preparedBundle === undefined
  )
    throw new TypeError(
      "Follow-up candidate state has no retained candidate or bundle",
    );
  if (
    row.status === "bundle_prepared" &&
    (row.stage !== "bundle" ||
      row.preparedBundle === undefined ||
      row.completionRows !== 3)
  )
    throw new TypeError(
      "Prepared follow-up bundle lacks its checked content and posting reserve",
    );
  if (row.status === "delivered" || row.stage === "delivered") {
    if (
      row.status !== "delivered" ||
      row.stage !== "delivered" ||
      row.delivered === undefined ||
      row.candidate !== undefined ||
      row.preparedBundle !== undefined ||
      row.completionRows !== 0 ||
      row.claim !== undefined
    )
      throw new TypeError(
        "Delivered follow-up state lacks its exact committed summary",
      );
  } else if (row.delivered !== undefined || row.handoff !== undefined)
    throw new TypeError(
      "Undelivered follow-up contains a delivered summary or handoff",
    );
}
export function assertEngineeringFollowupRecord(
  value: unknown,
  key: EntityKey,
): asserts value is EngineeringFollowupRecord {
  const row = dataObject(value, "follow-up record");
  text(row.partition, "partition");
  text(row.ticketId ?? row.partition, "ticketId");
  text(row.id, "record.id", 400);
  if (
    row.partition !== key.partition ||
    row.id !== key.id ||
    (row.ticketId !== undefined && row.ticketId !== key.partition)
  )
    throw new TypeError("Follow-up physical record envelope mismatch");
  if (row.kind === "engineering_followup_head") {
    timestamp(row.createdAt, "createdAt");
    validateHead(row);
  } else if (row.kind === "engineering_followup_work") {
    timestamp(row.createdAt, "createdAt");
    validateWork(row);
  } else if (row.kind === "engineering_followup_receipt") {
    fields(
      row,
      "follow-up command receipt",
      ["kind", "partition", "id", "fingerprint", "result"],
      ["recoveryFingerprint"],
    );
    if (!(row.id as string).startsWith("engineering-followup-command:"))
      throw new TypeError("Follow-up receipt physical prefix mismatch");
    text(
      (row.id as string).slice("engineering-followup-command:".length),
      "commandId",
    );
    text(row.fingerprint, "fingerprint");
    validateCompactResult(row.result);
    if ((row.result as { ticketId: string }).ticketId !== row.partition)
      throw new TypeError("Follow-up command receipt ticket mismatch");
    if (row.recoveryFingerprint !== undefined) {
      engineeringFollowupRecoveryHash(
        row.recoveryFingerprint,
        "recoveryFingerprint",
      );
      const result = dataObject(row.result, "recoverable preparation result");
      if (
        result.status !== "bundle_prepared" ||
        result.candidateHash === undefined ||
        result.bundleHash === undefined
      )
        throw new TypeError(
          "Only an exact checked preparation acknowledgement may retain recovery metadata",
        );
    }
  } else throw new TypeError("Unknown follow-up record kind");
  if (
    engineeringFollowupEncodedBytes(
      row as unknown as EngineeringFollowupRecord,
    ) > engineeringFollowupMaximumRecordBytes
  )
    throw new TypeError("Follow-up physical record exceeds 60000 bytes");
}
export function maximumEngineeringFollowupHeadBytes(
  head: EngineeringFollowupHeadRecord,
): number {
  const wide = "\ud800".repeat(200);
  const at = "+275760-09-13T00:00:00.000Z";
  // New proof identities and generations pass admission again through
  // observation or reassessment. Retained work can grow only control metadata.
  const future = {
    ...head,
    headGeneration: Number.MAX_SAFE_INTEGER,
    workCount: 8,
    updatedAt: at,
    heldReason: wide,
    deploymentContexts: head.deploymentContexts.map((entry) => ({
      ...entry,
      heldReason: wide,
    })),
    lastObservation: {
      fingerprint: "f".repeat(64),
      result: {
        ticketId: head.ticketId,
        headGeneration: Number.MAX_SAFE_INTEGER,
        workId: "f".repeat(64),
        outcome: "unchanged",
        reason: wide,
      },
    },
  };
  const { lastObservation: _observation, ...retained } = future;
  const scrubbed = {
    ...retained,
    withdrawn: true,
    associationHeads: [],
    deploymentContexts: [],
  };
  return Math.max(
    engineeringFollowupEncodedBytes(head),
    engineeringFollowupEncodedBytes(future),
    engineeringFollowupEncodedBytes(scrubbed),
  );
}
export function checkEngineeringFollowupRecordCapacity(
  row: EngineeringFollowupRecord,
): void {
  if (
    engineeringFollowupEncodedBytes(row) >
      engineeringFollowupMaximumRecordBytes ||
    (row.kind === "engineering_followup_head" &&
      maximumEngineeringFollowupHeadBytes(row) >
        engineeringFollowupMaximumRecordBytes)
  )
    throw new SupportDeskLimitError(
      "serialized_record",
      engineeringFollowupMaximumRecordBytes,
    );
  assertEngineeringFollowupRecord(row, {
    partition: row.partition,
    id: row.id,
  });
}
/**
 * Each newly admitted stage reserves its own continuations. A future exact
 * bundle has a separate admission boundary; it is not an unknown paid result.
 */
export function reserveEngineeringFollowupReachable(
  work: EngineeringFollowupWorkRecord,
): void {
  checkEngineeringFollowupRecordCapacity(work);
  const wide = "\ud800".repeat(200);
  const at = "+275760-09-13T00:00:00.000Z";
  const hash = "f".repeat(64);
  const maximum = Number.MAX_SAFE_INTEGER;
  const {
    claim: _claim,
    leaseUntil: _lease,
    retryAt: _retry,
    ...unclaimed
  } = work;
  const step =
    work.stepId === undefined
      ? {}
      : {
          stepId: work.stepId,
          requestHash: work.requestHash!,
        };
  const result = (
    status: EngineeringFollowupWorkRecord["status"],
    candidateHash = work.candidateHash,
    bundleHash = work.preparedBundle?.bundleHash,
  ): EngineeringFollowupResult => ({
    ticketId: work.ticketId,
    workId: work.workId,
    workGeneration: maximum,
    status,
    ...step,
    ...(candidateHash === undefined ? {} : { candidateHash }),
    ...(bundleHash === undefined ? {} : { bundleHash }),
  });
  const finish = {
    fingerprint: hash,
    result: result("superseded"),
  };
  const base = {
    ...unclaimed,
    workGeneration: maximum,
    claimGeneration: maximum,
  };
  const claim = {
    ticketId: work.ticketId,
    workId: work.workId,
    workerId: wide,
    claimId: wide,
    claimGeneration: maximum,
  };
  const histories = new Map<
    string,
    {
      stepId: string;
      requestHash: string;
      usageReservationId: string;
      accounting: "not_called" | "accounted" | "unknown";
    }
  >();
  for (const entry of work.usageTombstones ?? [])
    histories.set(JSON.stringify([entry.stepId, entry.requestHash]), entry);
  for (const [index, entry] of work.modelAttempts.entries())
    histories.set(JSON.stringify([entry.stepId, entry.requestHash]), {
      stepId: entry.stepId,
      requestHash: entry.requestHash,
      usageReservationId: entry.binding.usageReservationId,
      accounting:
        work.stage === "model" && index === work.modelAttempts.length - 1
          ? "accounted"
          : entry.accounting,
    });
  const successUsage = [...histories.values()];
  const currentModelStep =
    work.stage === "model" ? work.modelAttempts.at(-1)?.stepId : undefined;
  const unresolvedUsage = successUsage.map((entry) =>
    entry.stepId === currentModelStep
      ? { ...entry, accounting: "not_called" as const }
      : entry,
  );
  const {
    context: _context,
    candidate: _candidate,
    candidateHash: _candidateHash,
    preparedBundle: _prepared,
    handoff: _handoff,
    modelAttempts: _attempts,
    retestResults: _results,
    ...minimal
  } = base;
  const scrubbed = {
    ...minimal,
    withdrawn: true,
    heldReason: wide,
    status: work.status === "delivered" ? "delivered" : "held",
    modelAttempts: [],
    retestResults: [],
    completionRows: 0,
    messageSlots: 0,
    usageTombstones: unresolvedUsage,
  };
  const held = {
    ...base,
    status: "restricted",
    security: "restricted",
    heldReason: wide,
    completionRows: 0,
    messageSlots: 0,
    lastFinish: finish,
  };
  const futures: object[] = [
    work,
    scrubbed,
    { ...scrubbed, lastFinish: finish },
  ];
  const measure = (): void => {
    for (const future of futures)
      if (
        engineeringFollowupEncodedBytes(
          future as { partition: string; id: string },
        ) > engineeringFollowupMaximumRecordBytes
      )
        throw new SupportDeskLimitError(
          "serialized_record",
          engineeringFollowupMaximumRecordBytes,
        );
  };
  if (work.withdrawn === true) return;

  // Observation is unpaid. The exact manifest is admitted by model preparation.
  if (work.stage === "model" && work.modelAttempts.length === 0) {
    futures.push(held, {
      ...base,
      status: "claimed",
      claim,
      leaseUntil: at,
      retryAt: at,
    });
    measure();
    return;
  }

  if (work.stage === "model") {
    const processing = {
      provider: wide,
      model: wide,
      requestId: wide,
      failureCategory: wide,
      currency: wide,
      inputTokens: maximum,
      outputTokens: maximum,
      costMicros: maximum,
    };
    const finishingAttempts = work.modelAttempts.map((entry, index) =>
      index === work.modelAttempts.length - 1
        ? { ...entry, accounting: "not_called", processing }
        : entry,
    );
    // While a provider outcome is unresolved its one exact manifest survives.
    const prepared = {
      ...base,
      modelAttempts: finishingAttempts,
      heldReason: wide,
      lastFinish: finish,
    };
    futures.push(
      { ...prepared, status: "superseded", retryAt: at },
      { ...prepared, status: "claimed", claim, leaseUntil: at, retryAt: at },
    );
    // Successful completion compacts that manifest/processing into usage
    // tombstones before storing the candidate and the next bundle claim.
    const candidateHash = hash;
    const completion = {
      fingerprint: hash,
      result: result("candidate", candidateHash),
    };
    const candidate = {
      ...base,
      stage: "bundle",
      status: "candidate",
      modelAttempts: [],
      usageTombstones: successUsage,
      candidate: "\\".repeat(
        Math.ceil(engineeringFollowupMaximumCandidateBytes / 4),
      ),
      candidateHash,
      lastCompletion: completion,
    };
    futures.push(
      candidate,
      {
        ...candidate,
        status: "claimed",
        claim,
        leaseUntil: at,
        retryAt: at,
        heldReason: wide,
        lastFinish: {
          fingerprint: hash,
          result: result("retry", candidateHash),
        },
      },
      {
        ...candidate,
        status: "restricted",
        security: "restricted",
        heldReason: wide,
        completionRows: 0,
        messageSlots: 0,
        lastFinish: {
          fingerprint: hash,
          result: result("restricted", candidateHash),
        },
      },
    );
    const {
      candidate: _futureCandidate,
      candidateHash: _futureHash,
      ...completedMinimal
    } = candidate;
    futures.push({
      ...completedMinimal,
      context: undefined,
      withdrawn: true,
      heldReason: wide,
      status: "held",
      completionRows: 0,
      messageSlots: 0,
      retestResults: [],
    });
    measure();
    return;
  }

  if (work.preparedBundle === undefined && work.status !== "delivered") {
    // Retained candidates cannot call a model again. Preparing an actual
    // checked bundle is a new admission using its immutable rendered content.
    futures.push(held, {
      ...base,
      status: "claimed",
      claim,
      leaseUntil: at,
      retryAt: at,
      heldReason: wide,
      lastFinish: { fingerprint: hash, result: result("retry") },
    });
    measure();
    return;
  }

  const requests =
    work.preparedBundle?.bundle.retestRequests ??
    work.handoff?.retestRequests ??
    [];
  const summaries = new Map(
    work.retestResults.map((entry) => [entry.requestId, entry]),
  );
  for (const request of requests)
    summaries.set(request.requestId, {
      requestId: request.requestId,
      requestHash: hash,
      workBindingHash: work.workBindingHash,
      bundleHash: work.preparedBundle?.bundleHash ?? work.delivered!.bundleHash,
      productBinding: request.productBinding,
      result: "failed",
      executionHash: hash,
      verificationHash: hash,
      verifiedAt: at,
      receiptReference: wide,
      verifierReceiptId: wide,
    });
  if (summaries.size > 4)
    throw new TypeError(
      "Follow-up retest history cannot admit this request scope",
    );
  const retestResults = [...summaries.values()];
  const compact = {
    ...base,
    modelAttempts: [],
    usageTombstones: successUsage,
    retestResults,
  };
  if (work.status === "delivered") {
    // Delivered identities and handoff bodies are immutable. Only bounded
    // verified retest results and eventual private-data scrubbing can grow.
    const lateFinish = {
      fingerprint: hash,
      result: {
        ticketId: work.ticketId,
        workId: work.workId,
        workGeneration: maximum,
        status: "delivered",
        ...step,
        messageId: work.delivered!.messageId,
        ticketRevision: work.delivered!.ticketRevision,
      },
    };
    futures.push(
      compact,
      {
        ...compact,
        security: "restricted",
        heldReason: wide,
        lastFinish: lateFinish,
      },
      { ...scrubbed, lastFinish: lateFinish },
    );
    measure();
    return;
  }

  const prepared = work.preparedBundle!;
  const {
    candidate: _postedCandidate,
    candidateHash: _postedHash,
    preparedBundle: _postedBundle,
    handoff: _oldHandoff,
    ...postedBase
  } = base;
  const delivered = {
    ...postedBase,
    stage: "delivered",
    status: "delivered",
    modelAttempts: [],
    usageTombstones: successUsage,
    completionRows: 0,
    messageSlots: 0,
    delivered: {
      messageId: wide,
      ticketRevision: maximum,
      bodyHash: hash,
      bundleHash: prepared.bundleHash,
      commandId: wide,
      postedBy: wide,
      postedAt: at,
    },
    handoff: {
      kbProposal: prepared.bundle.kbProposal,
      retestRequests: prepared.bundle.retestRequests,
    },
  };
  const lateFinish = {
    fingerprint: hash,
    result: {
      ticketId: work.ticketId,
      workId: work.workId,
      workGeneration: maximum,
      status: "delivered",
      ...step,
      messageId: wide,
      ticketRevision: maximum,
    },
  };
  futures.push(
    held,
    compact,
    {
      ...compact,
      status: "restricted",
      security: "restricted",
      heldReason: wide,
      completionRows: 0,
      messageSlots: 0,
      lastFinish: finish,
    },
    delivered,
    { ...delivered, retestResults },
    {
      ...delivered,
      retestResults,
      security: "restricted",
      heldReason: wide,
      lastFinish: lateFinish,
    },
    {
      ...scrubbed,
      stage: "delivered",
      status: "delivered",
      delivered: delivered.delivered,
      lastFinish: lateFinish,
    },
    {
      kind: "engineering_followup_receipt",
      partition: work.ticketId,
      id: engineeringFollowupCommandKey(work.ticketId, wide).id,
      fingerprint: hash,
      recoveryFingerprint: hash,
      result: result(
        "bundle_prepared",
        prepared.candidateHash,
        prepared.bundleHash,
      ),
    },
    {
      kind: "engineering_followup_receipt",
      partition: work.ticketId,
      id: engineeringFollowupCommandKey(work.ticketId, wide).id,
      fingerprint: hash,
      result: {
        ticketId: work.ticketId,
        workId: work.workId,
        messageId: wide,
        ticketRevision: maximum,
        bundleHash: prepared.bundleHash,
      },
    },
  );
  measure();
}
