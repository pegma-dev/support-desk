import type { IsoTimestamp } from "@pegma/spine";
import type { EntityKey } from "@pegma/storage-core";
import type {
  ResolutionEvidence,
  ResolutionLearningCandidate,
  ResolutionLearningClaimFence,
  ResolutionLearningDeliveryRequest,
  ResolutionLearningModelBinding,
  ResolutionLearningOptions,
  ResolutionLearningProcessing,
  ResolutionLearningSourceReference,
  ResolutionLearningTarget,
  ResolutionProductContext,
} from "./resolution-learning-types.js";
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

export interface ResolutionLearningDestination {
  readonly articleId: string;
  readonly sourceGeneration: number;
  readonly stepId: string;
  readonly requestHash: string;
  readonly acceptance: "unknown" | "accepted";
  readonly reconciliation: "pending" | "blocked" | "confirmed";
  readonly lastReconciliation?: {
    readonly fingerprint: string;
    readonly disposition:
      "blocked" | "retired" | "unaffected_publication" | "write_rejected";
    readonly observedAt: string;
    readonly proof?: {
      readonly kind:
        "terminal_receipt" | "revision_fence" | "trusted_cancellation";
      readonly binding: string;
    };
  };
}
export interface ResolutionLearningReview {
  readonly sourceGeneration: number;
  readonly sourceBindingHash: string;
  readonly target: ResolutionLearningTarget;
  readonly decision: "approve" | "reject";
  readonly policyVersion: string;
  readonly reviewerId: string;
  readonly reviewedAt: IsoTimestamp;
  readonly reason?: string;
}
export interface ResolutionLearningReviewRecord extends ResolutionLearningReview {
  readonly kind: "resolution_learning_review";
  readonly partition: string;
  readonly id: string;
  readonly ticketId: string;
}
export interface ResolutionLearningSourceRecord {
  readonly kind: "resolution_learning_source";
  readonly partition: string;
  readonly id: "learning-source";
  readonly ticketId: string;
  readonly sourceId: string;
  readonly resolutionCycle: number;
  readonly sourceGeneration: number;
  readonly workGeneration: number;
  readonly generationCount: number;
  readonly reviewBindingCount: number;
  readonly state: "unverified" | "eligible" | "held" | "withdrawn";
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
  readonly heldReason?: string;
  readonly resolvedAt?: IsoTimestamp;
  readonly acceptedTicketRevision?: number;
  readonly proofIdentity?: string;
  readonly sourceBindingHash?: string;
  readonly evidenceFingerprint?: string;
  readonly productContextFingerprint?: string;
  readonly evidence?: ResolutionEvidence;
  readonly product?: ResolutionProductContext;
  readonly pendingProofReference?: string;
  readonly destinations: readonly ResolutionLearningDestination[];
  readonly reconciliationPending: boolean;
}
export interface ResolutionLearningAttempt {
  readonly preparedClaimGeneration: number;
  readonly stepId: string;
  readonly requestHash: string;
  readonly binding: ResolutionLearningModelBinding;
  readonly accounting: "not_called" | "accounted" | "unknown";
  readonly processing?: ResolutionLearningProcessing;
}
export interface ResolutionLearningWorkRecord {
  readonly kind: "resolution_learning_work";
  readonly partition: string;
  readonly id: string;
  readonly ticketId: string;
  readonly sourceGeneration: number;
  readonly resolutionCycle: number;
  readonly sourceBindingHash: string;
  readonly workGeneration: number;
  readonly acceptedTicketRevision: number;
  readonly workingSolutionMessageIds: readonly string[];
  readonly createdAt: IsoTimestamp;
  readonly deadline: IsoTimestamp;
  readonly evidence?: ResolutionEvidence;
  readonly product?: ResolutionProductContext;
  readonly status:
    | "pending"
    | "claimed"
    | "retry"
    | "candidate"
    | "prepared"
    | "completed"
    | "held"
    | "unknown"
    | "superseded";
  readonly stage: "model" | "kb_delivery";
  readonly modelAttempts: readonly ResolutionLearningAttempt[];
  readonly claimGeneration: number;
  readonly claim?: ResolutionLearningClaimFence;
  readonly leaseUntil?: IsoTimestamp;
  readonly retryAt?: IsoTimestamp;
  readonly stepId?: string;
  readonly requestHash?: string;
  readonly candidate?: ResolutionLearningCandidate;
  readonly candidateHash?: string;
  readonly exactRequest?: ResolutionLearningDeliveryRequest;
  readonly withdrawnRequest?: Omit<
    ResolutionLearningDeliveryRequest,
    "draftPayload"
  >;
  readonly usageTombstones?: readonly {
    readonly stepId: string;
    readonly requestHash: string;
    readonly usageReservationId: string;
    readonly accounting: "not_called" | "accounted" | "unknown";
  }[];
  readonly verifiedCheckReceipt?: string;
  readonly checkPolicyVersion?: string;
  readonly targetDecisionHash?: string;
  readonly acknowledgement?: {
    readonly id: string;
    readonly generation: number;
    readonly articleRevision: number;
    readonly contentHash: string;
    readonly state: string;
  };
  readonly target?: ResolutionLearningTarget;
  readonly heldReason?: string;
  readonly lastCompletion?: { readonly fingerprint: string };
  readonly lastFinish?: { readonly fingerprint: string };
}
export interface ResolvedResolutionLearningOptions {
  readonly stagedReviews: boolean;
  readonly maxStagedReviewAttempts: number;
  readonly enabled: boolean;
  readonly productContext?: ResolutionLearningOptions["productContext"];
  readonly testReceipts?: ResolutionLearningOptions["testReceipts"];
  readonly checks?: ResolutionLearningOptions["checks"];
  readonly trustTimeoutMilliseconds: number;
  readonly maxGenerations: number;
  readonly maxTargets: number;
  readonly maxReviewBindings: number;
  readonly maxModelAttempts: number;
  readonly maxLeaseMilliseconds: number;
  readonly maxWorkMilliseconds: number;
}
export const resolutionLearningRecordBytes = 60_000;
export const resolutionLearningCandidateBytes = 16_000;
export function maximumResolutionLearningSourceBytes(
  source: ResolutionLearningSourceRecord,
): number {
  const escaped = "\ud800".repeat(200);
  const destinations = source.destinations.map((entry) => ({
    ...entry,
    acceptance: "accepted",
    reconciliation: "confirmed",
    lastReconciliation: {
      fingerprint: "f".repeat(64),
      disposition: "unaffected_publication",
      observedAt: "9999-12-31T23:59:59.999Z",
      proof: { kind: "trusted_cancellation", binding: escaped },
    },
  }));
  return Math.max(
    encodedBytes(source),
    encodedBytes({
      ...source,
      destinations,
      sourceGeneration: Number.MAX_SAFE_INTEGER,
      resolutionCycle: Number.MAX_SAFE_INTEGER,
      workGeneration: Number.MAX_SAFE_INTEGER,
      updatedAt: "9999-12-31T23:59:59.999Z",
      state: "withdrawn",
      heldReason: escaped,
      reconciliationPending: false,
    }),
  );
}
export function safeLearningSnapshot<T>(value: T): T {
  function inspect(item: unknown, depth: number): void {
    if (depth > 20) throw new TypeError("Learning data nesting exceeds limit");
    if (item === null || typeof item === "string" || typeof item === "boolean")
      return;
    if (typeof item === "number") {
      if (!Number.isSafeInteger(item))
        throw new TypeError("Learning data numbers must be safe integers");
      return;
    }
    if (typeof item !== "object")
      throw new TypeError("Learning data must be JSON data");
    if (Array.isArray(item)) {
      for (const element of dataArray(item, "learning array", 100))
        inspect(element, depth + 1);
    } else
      for (const element of Object.values(dataObject(item, "learning data")))
        if (element !== undefined) inspect(element, depth + 1);
  }
  inspect(value, 0);
  return JSON.parse(JSON.stringify(value)) as T;
}
export const resolutionLearningSourceKey = (ticketId: string): EntityKey => ({
  partition: ticketId,
  id: "learning-source",
});
export const resolutionLearningWorkKey = (
  ticketId: string,
  generation: number,
): EntityKey => ({
  partition: ticketId,
  id: `resolution-learning:${generation}`,
});
export async function resolutionLearningReviewKey(
  source: ResolutionLearningSourceRecord,
  target: ResolutionLearningTarget,
  policyVersion: string,
): Promise<EntityKey> {
  return {
    partition: source.ticketId,
    id: `learning-review:${await fingerprint({ sourceGeneration: source.sourceGeneration, sourceBindingHash: source.sourceBindingHash, target, policyVersion })}`,
  };
}

export function resolveResolutionLearningOptions(
  input: ResolutionLearningOptions | undefined,
): ResolvedResolutionLearningOptions {
  const value =
    input === undefined
      ? {}
      : fields(
          input,
          "resolutionLearning",
          [],
          [
            "enabled",
            "stagedReviews",
            "maxStagedReviewAttempts",
            "productContext",
            "testReceipts",
            "checks",
            "trustTimeoutMilliseconds",
            "maxGenerations",
            "maxTargets",
            "maxReviewBindings",
            "maxModelAttempts",
            "maxLeaseMilliseconds",
            "maxWorkMilliseconds",
          ],
        );
  if (value.enabled !== undefined && typeof value.enabled !== "boolean")
    throw new TypeError("resolutionLearning.enabled must be boolean");
  if (
    value.stagedReviews !== undefined &&
    typeof value.stagedReviews !== "boolean"
  )
    throw new TypeError("resolutionLearning.stagedReviews must be boolean");
  for (const [name, method] of [
    ["productContext", "resolve"],
    ["testReceipts", "verify"],
    ["checks", "verify"],
  ] as const) {
    if (
      value[name] !== undefined &&
      (value[name] === null ||
        typeof (value[name] as Record<string, unknown>)[method] !== "function")
    )
      throw new TypeError(`resolutionLearning.${name}.${method} is required`);
  }
  return {
    enabled: value.enabled === true,
    stagedReviews: value.enabled === true && value.stagedReviews === true,
    maxStagedReviewAttempts: integer(
      value.maxStagedReviewAttempts ?? 8,
      "maxStagedReviewAttempts",
      1,
      24,
    ),
    ...(value.productContext === undefined
      ? {}
      : {
          productContext: value.productContext as NonNullable<
            ResolutionLearningOptions["productContext"]
          >,
        }),
    ...(value.testReceipts === undefined
      ? {}
      : {
          testReceipts: value.testReceipts as NonNullable<
            ResolutionLearningOptions["testReceipts"]
          >,
        }),
    ...(value.checks === undefined
      ? {}
      : {
          checks: value.checks as NonNullable<
            ResolutionLearningOptions["checks"]
          >,
        }),
    trustTimeoutMilliseconds: integer(
      value.trustTimeoutMilliseconds ?? 250,
      "trustTimeoutMilliseconds",
      1,
      1_000,
    ),
    maxGenerations: integer(value.maxGenerations ?? 4, "maxGenerations", 1, 8),
    maxTargets: integer(value.maxTargets ?? 2, "maxTargets", 1, 4),
    maxReviewBindings: integer(
      value.maxReviewBindings ?? 16,
      "maxReviewBindings",
      1,
      64,
    ),
    maxModelAttempts: integer(
      value.maxModelAttempts ?? 2,
      "maxModelAttempts",
      1,
      4,
    ),
    maxLeaseMilliseconds: integer(
      value.maxLeaseMilliseconds ?? 60_000,
      "maxLeaseMilliseconds",
      1,
      300_000,
    ),
    maxWorkMilliseconds: integer(
      value.maxWorkMilliseconds ?? 300_000,
      "maxWorkMilliseconds",
      1,
      3_600_000,
    ),
  };
}

export function validateResolutionProduct(
  value: unknown,
): asserts value is ResolutionProductContext {
  const product = fields(value, "product context", [
    "productId",
    "version",
    "buildId",
    "binding",
    "contextVersion",
    "receiptId",
    "verifiedAt",
    "validUntil",
  ]);
  for (const key of [
    "productId",
    "version",
    "buildId",
    "binding",
    "contextVersion",
    "receiptId",
  ])
    text(product[key], `product.${key}`);
  if (
    timestamp(product.validUntil, "product.validUntil") <
    timestamp(product.verifiedAt, "product.verifiedAt")
  )
    throw new TypeError("product context validity is inverted");
}
export function validateResolutionEvidence(
  value: unknown,
): asserts value is ResolutionEvidence {
  const proof = dataObject(value, "resolution evidence");
  const extra =
    proof.kind === "customer_confirmation"
      ? ["lastVisibleMessageId"]
      : proof.kind === "staff_verified_fix"
        ? ["solutionMessageId", "verificationReference"]
        : proof.kind === "successful_test"
          ? ["solutionMessageId", "test"]
          : null;
  if (extra === null) throw new TypeError("unsupported resolution evidence");
  fields(value, "resolution evidence", ["kind", "actorId", ...extra]);
  text(proof.actorId, "evidence.actorId");
  for (const key of extra.filter((key) => key !== "test"))
    text(proof[key], `evidence.${key}`);
  if (proof.kind === "successful_test") {
    const test = fields(proof.test, "verified test", [
      "executionId",
      "runnerId",
      "testId",
      "productBinding",
      "executedAt",
      "receiptId",
      "verifiedAt",
      "validUntil",
    ]);
    for (const key of [
      "executionId",
      "runnerId",
      "testId",
      "productBinding",
      "receiptId",
    ])
      text(test[key], `test.${key}`);
    timestamp(test.executedAt, "test.executedAt");
    if (
      timestamp(test.validUntil, "test.validUntil") <
      timestamp(test.verifiedAt, "test.verifiedAt")
    )
      throw new TypeError("test validity is inverted");
  }
}
export function validateResolutionCandidate(
  value: unknown,
): asserts value is ResolutionLearningCandidate {
  const candidate = fields(value, "candidate", [
    "problem",
    "applicability",
    "steps",
    "solution",
    "validationRequirements",
  ]);
  const contentText = (entry: unknown, name: string, maximum: number): void => {
    if (
      typeof entry !== "string" ||
      entry.trim().length === 0 ||
      entry.length > maximum ||
      /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(entry)
    )
      throw new TypeError(`${name} must be bounded nonempty content text`);
  };
  contentText(candidate.problem, "candidate.problem", 4_000);
  contentText(candidate.solution, "candidate.solution", 8_000);
  const applicability = fields(
    candidate.applicability,
    "candidate applicability",
    ["productId", "version", "buildId"],
  );
  for (const key of ["productId", "version", "buildId"])
    text(applicability[key], `candidate.${key}`);
  for (const key of ["steps", "validationRequirements"])
    for (const item of dataArray(candidate[key], `candidate.${key}`, 16))
      contentText(item, `candidate.${key} item`, 2_000);
  if (encodedBytes(value) > resolutionLearningCandidateBytes)
    throw new TypeError("candidate exceeds 16000 serialized bytes");
}
export function validateResolutionReferences(
  value: unknown,
): asserts value is readonly ResolutionLearningSourceReference[] {
  const ids = new Set<string>();
  for (const item of dataArray(value, "sourceReferences", 32)) {
    const reference = fields(item, "source reference", [
      "id",
      "system",
      "resourceId",
      "version",
    ]);
    for (const key of ["id", "system", "resourceId", "version"])
      text(reference[key], `sourceReference.${key}`);
    if (ids.has(reference.id as string))
      throw new TypeError("duplicate source reference ID");
    ids.add(reference.id as string);
  }
}
export function validateResolutionRequest(
  value: unknown,
): asserts value is ResolutionLearningDeliveryRequest {
  const request = fields(value, "KB request", [
    "operation",
    "articleId",
    "collectionId",
    "draftPayload",
    "sourceReferences",
    "originalExpectedGeneration",
    "commandId",
    "correlationId",
  ]);
  if (request.operation !== "create" && request.operation !== "update")
    throw new TypeError("unsupported KB operation");
  for (const key of ["articleId", "collectionId", "commandId", "correlationId"])
    text(request[key], `request.${key}`);
  text(request.draftPayload, "draftPayload", 24_000);
  let draft: unknown;
  try {
    draft = JSON.parse(request.draftPayload as string) as unknown;
  } catch {
    throw new TypeError("draftPayload must contain valid JSON");
  }
  dataObject(draft, "draft payload");
  integer(request.originalExpectedGeneration, "originalExpectedGeneration", 0);
  if (
    request.operation === "create" &&
    request.originalExpectedGeneration !== 0
  )
    throw new TypeError("create requires generation zero");
  validateResolutionReferences(request.sourceReferences);
}
export function validateResolutionTarget(
  value: unknown,
): asserts value is ResolutionLearningTarget {
  const target = fields(value, "KB target", [
    "articleId",
    "collectionId",
    "articleRevision",
    "contentHash",
    "sourceSnapshotGeneration",
    "sourceSnapshotHash",
    "orderedReferencesHash",
  ]);
  for (const key of [
    "articleId",
    "collectionId",
    "contentHash",
    "sourceSnapshotHash",
    "orderedReferencesHash",
  ])
    text(target[key], `target.${key}`);
  integer(target.articleRevision, "target.articleRevision", 1);
  integer(
    target.sourceSnapshotGeneration,
    "target.sourceSnapshotGeneration",
    0,
  );
}

/** Decoding checks the physical envelope as strictly as writes. */
export function assertResolutionLearningRecord(
  value: unknown,
  key: EntityKey,
): asserts value is
  | ResolutionLearningSourceRecord
  | ResolutionLearningWorkRecord
  | ResolutionLearningReviewRecord {
  const row = dataObject(value, "resolution learning record");
  for (const name of ["partition", "ticketId", "id"])
    text(row[name], `record.${name}`);
  if (
    row.partition !== key.partition ||
    row.id !== key.id ||
    row.ticketId !== key.partition
  )
    throw new TypeError("learning record envelope mismatch");
  if (row.kind === "resolution_learning_review") {
    fields(
      row,
      "review record",
      [
        "kind",
        "partition",
        "id",
        "ticketId",
        "sourceGeneration",
        "sourceBindingHash",
        "target",
        "decision",
        "policyVersion",
        "reviewerId",
        "reviewedAt",
      ],
      ["reason"],
    );
    if (!/^learning-review:[0-9a-f]{64}$/.test(row.id as string))
      throw new TypeError("Invalid learning review key");
    integer(row.sourceGeneration, "sourceGeneration", 1);
    text(row.sourceBindingHash, "sourceBindingHash");
    validateResolutionTarget(row.target);
    text(row.policyVersion, "policyVersion");
    text(row.reviewerId, "reviewerId");
    timestamp(row.reviewedAt, "reviewedAt");
    if (row.decision !== "approve" && row.decision !== "reject")
      throw new TypeError("Invalid review decision");
    if (row.reason !== undefined) text(row.reason, "reason");
    if (encodedBytes(row) > 60_000)
      throw new TypeError("Review record exceeds limit");
    return;
  }
  integer(row.sourceGeneration, "sourceGeneration", 0);
  integer(row.resolutionCycle, "resolutionCycle", 1);
  integer(row.workGeneration, "workGeneration", 1);
  timestamp(row.createdAt, "createdAt");
  if (row.kind === "resolution_learning_source") {
    fields(
      row,
      "learning source",
      [
        "kind",
        "partition",
        "id",
        "ticketId",
        "sourceId",
        "resolutionCycle",
        "sourceGeneration",
        "workGeneration",
        "generationCount",
        "reviewBindingCount",
        "state",
        "createdAt",
        "updatedAt",
        "destinations",
        "reconciliationPending",
      ],
      [
        "heldReason",
        "resolvedAt",
        "acceptedTicketRevision",
        "proofIdentity",
        "sourceBindingHash",
        "evidenceFingerprint",
        "productContextFingerprint",
        "evidence",
        "product",
        "pendingProofReference",
      ],
    );
    if (
      row.id !== "learning-source" ||
      !["unverified", "eligible", "held", "withdrawn"].includes(
        row.state as string,
      )
    )
      throw new TypeError("invalid learning source");
    text(row.sourceId, "sourceId");
    for (const name of [
      "heldReason",
      "proofIdentity",
      "sourceBindingHash",
      "evidenceFingerprint",
      "productContextFingerprint",
    ])
      if (row[name] !== undefined) text(row[name], name);
    if (row.pendingProofReference !== undefined)
      text(row.pendingProofReference, "pendingProofReference", 208);
    if (row.acceptedTicketRevision !== undefined)
      integer(row.acceptedTicketRevision, "acceptedTicketRevision", 1);
    if (row.resolvedAt !== undefined) timestamp(row.resolvedAt, "resolvedAt");
    integer(row.generationCount, "generationCount", 0, 8);
    timestamp(row.updatedAt, "updatedAt");
    integer(row.reviewBindingCount, "reviewBindingCount", 0, 64);
    if (typeof row.reconciliationPending !== "boolean")
      throw new TypeError("invalid reconciliation marker");
    if (
      row.reconciliationPending !==
      (row.destinations as readonly ResolutionLearningDestination[]).some(
        (entry) => entry.reconciliation !== "confirmed",
      )
    )
      throw new TypeError("reconciliation marker disagrees with destinations");
    for (const target of dataArray(row.destinations, "destinations", 4)) {
      const destination = fields(
        target,
        "destination",
        [
          "articleId",
          "sourceGeneration",
          "stepId",
          "requestHash",
          "acceptance",
          "reconciliation",
        ],
        ["lastReconciliation"],
      );
      for (const name of ["articleId", "stepId", "requestHash"])
        text(destination[name], `destination.${name}`);
      integer(destination.sourceGeneration, "destination.sourceGeneration", 1);
      if (
        !["unknown", "accepted"].includes(destination.acceptance as string) ||
        !["pending", "blocked", "confirmed"].includes(
          destination.reconciliation as string,
        )
      )
        throw new TypeError("invalid destination state");
      if (destination.lastReconciliation !== undefined) {
        const last = fields(
          destination.lastReconciliation,
          "reconciliation",
          ["fingerprint", "disposition", "observedAt"],
          ["proof"],
        );
        text(last.fingerprint, "reconciliation.fingerprint");
        timestamp(last.observedAt, "reconciliation.observedAt");
        if (
          ![
            "blocked",
            "retired",
            "unaffected_publication",
            "write_rejected",
          ].includes(last.disposition as string)
        )
          throw new TypeError("Invalid reconciliation disposition");
        if (last.proof !== undefined) {
          const proof = fields(last.proof, "reconciliation proof", [
            "kind",
            "binding",
          ]);
          text(proof.binding, "proof.binding");
          if (
            ![
              "terminal_receipt",
              "revision_fence",
              "trusted_cancellation",
            ].includes(proof.kind as string)
          )
            throw new TypeError("Invalid reconciliation proof");
        }
      }
    }
  } else if (row.kind === "resolution_learning_work") {
    fields(
      row,
      "learning work",
      [
        "kind",
        "partition",
        "id",
        "ticketId",
        "sourceGeneration",
        "resolutionCycle",
        "sourceBindingHash",
        "workGeneration",
        "acceptedTicketRevision",
        "workingSolutionMessageIds",
        "createdAt",
        "deadline",
        "status",
        "stage",
        "modelAttempts",
        "claimGeneration",
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
        "exactRequest",
        "withdrawnRequest",
        "usageTombstones",
        "verifiedCheckReceipt",
        "checkPolicyVersion",
        "targetDecisionHash",
        "acknowledgement",
        "target",
        "heldReason",
        "lastCompletion",
        "lastFinish",
      ],
    );
    if (
      row.id !== `resolution-learning:${row.sourceGeneration}` ||
      ![
        "pending",
        "claimed",
        "retry",
        "candidate",
        "prepared",
        "completed",
        "held",
        "unknown",
        "superseded",
      ].includes(row.status as string) ||
      (row.stage !== "model" && row.stage !== "kb_delivery")
    )
      throw new TypeError("invalid learning work");
    text(row.sourceBindingHash, "sourceBindingHash");
    for (const name of [
      "heldReason",
      "stepId",
      "requestHash",
      "candidateHash",
      "verifiedCheckReceipt",
      "checkPolicyVersion",
      "targetDecisionHash",
    ])
      if (row[name] !== undefined) text(row[name], name);
    for (const name of ["lastCompletion", "lastFinish"])
      if (row[name] !== undefined) {
        const receipt = fields(row[name], name, ["fingerprint"]);
        text(receipt.fingerprint, `${name}.fingerprint`);
      }
    if (row.acknowledgement !== undefined) {
      const acknowledgement = fields(row.acknowledgement, "acknowledgement", [
        "id",
        "generation",
        "articleRevision",
        "contentHash",
        "state",
      ]);
      for (const name of ["id", "contentHash", "state"])
        text(acknowledgement[name], `acknowledgement.${name}`);
      integer(acknowledgement.generation, "acknowledgement.generation", 1);
      integer(
        acknowledgement.articleRevision,
        "acknowledgement.articleRevision",
        1,
      );
    }
    integer(row.acceptedTicketRevision, "acceptedTicketRevision", 1);
    integer(row.claimGeneration, "claimGeneration", 0);
    timestamp(row.deadline, "deadline");
    for (const messageId of dataArray(
      row.workingSolutionMessageIds,
      "workingSolutionMessageIds",
      16,
    ))
      text(messageId, "solution message ID");
    for (const item of dataArray(row.modelAttempts, "modelAttempts", 4)) {
      const attempt = fields(
        item,
        "attempt",
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
      text(attempt.stepId, "attempt.stepId");
      text(attempt.requestHash, "attempt.requestHash");
      const binding = fields(attempt.binding, "attempt.binding", [
        "inputManifest",
        "inputFingerprint",
        "inputManifestHash",
        "configVersion",
        "promptVersion",
        "modelVersion",
        "checkPolicyVersion",
        "budgetsHash",
        "usageReservationId",
        "deadline",
      ]);
      timestamp(binding.deadline, "binding.deadline");
      for (const name of Object.keys(binding).filter(
        (name) => name !== "inputManifest" && name !== "deadline",
      ))
        text(binding[name], `binding.${name}`);
      const manifest = fields(binding.inputManifest, "inputManifest", [
        "messages",
        "workingSolutionMessageIds",
        "product",
      ]);
      for (const message of dataArray(
        manifest.messages,
        "manifest.messages",
        100,
      )) {
        const reference = fields(message, "manifest message", [
          "messageId",
          "ordinal",
        ]);
        text(reference.messageId, "messageId");
        integer(reference.ordinal, "ordinal", 1);
      }
      for (const id of dataArray(
        manifest.workingSolutionMessageIds,
        "manifest solutions",
        16,
      ))
        text(id, "manifest solution");
      const product = fields(manifest.product, "manifest product", [
        "productId",
        "version",
        "buildId",
        "binding",
        "contextVersion",
      ]);
      for (const name of Object.keys(product))
        text(product[name], `manifest.product.${name}`);
      if (
        !["not_called", "accounted", "unknown"].includes(
          attempt.accounting as string,
        )
      )
        throw new TypeError("invalid attempt accounting");
      if (attempt.processing !== undefined) {
        const processing = fields(
          attempt.processing,
          "processing",
          [],
          [
            "provider",
            "model",
            "requestId",
            "failureCategory",
            "currency",
            "inputTokens",
            "outputTokens",
            "costMicros",
          ],
        );
        for (const [name, entry] of Object.entries(processing))
          if (["inputTokens", "outputTokens", "costMicros"].includes(name))
            integer(entry, `processing.${name}`, 0);
          else text(entry, `processing.${name}`);
      }
    }
    if (row.claim !== undefined) {
      const claim = fields(row.claim, "claim", [
        "ticketId",
        "sourceGeneration",
        "workerId",
        "claimId",
        "claimGeneration",
      ]);
      for (const name of ["ticketId", "workerId", "claimId"])
        text(claim[name], `claim.${name}`);
      integer(claim.sourceGeneration, "claim.sourceGeneration", 1);
      integer(claim.claimGeneration, "claim.claimGeneration", 1);
      if (
        claim.ticketId !== row.ticketId ||
        claim.sourceGeneration !== row.sourceGeneration ||
        claim.claimGeneration !== row.claimGeneration ||
        row.leaseUntil === undefined
      )
        throw new TypeError("claim envelope mismatch");
    }
    for (const name of ["leaseUntil", "retryAt"])
      if (row[name] !== undefined) timestamp(row[name], name);
    if (row.withdrawnRequest !== undefined) {
      const request = fields(row.withdrawnRequest, "withdrawn request", [
        "operation",
        "articleId",
        "collectionId",
        "sourceReferences",
        "originalExpectedGeneration",
        "commandId",
        "correlationId",
      ]);
      for (const name of [
        "articleId",
        "collectionId",
        "commandId",
        "correlationId",
      ])
        text(request[name], `withdrawn.${name}`);
      if (request.operation !== "create" && request.operation !== "update")
        throw new TypeError("invalid withdrawn operation");
      integer(
        request.originalExpectedGeneration,
        "originalExpectedGeneration",
        0,
      );
      validateResolutionReferences(request.sourceReferences);
    }
    if (row.usageTombstones !== undefined)
      for (const item of dataArray(row.usageTombstones, "usageTombstones", 4)) {
        const usage = fields(item, "usage tombstone", [
          "stepId",
          "requestHash",
          "usageReservationId",
          "accounting",
        ]);
        for (const name of ["stepId", "requestHash", "usageReservationId"])
          text(usage[name], `usage.${name}`);
        if (
          !["not_called", "accounted", "unknown"].includes(
            usage.accounting as string,
          )
        )
          throw new TypeError("invalid usage accounting");
      }
    if (row.candidate !== undefined) validateResolutionCandidate(row.candidate);
    if (row.exactRequest !== undefined) {
      validateResolutionRequest(row.exactRequest);
      if (row.candidate !== undefined)
        throw new TypeError("candidate body duplicated in delivery state");
    }
    if (row.target !== undefined) validateResolutionTarget(row.target);
  } else throw new TypeError("invalid learning record kind");
  if (row.evidence !== undefined) validateResolutionEvidence(row.evidence);
  if (row.product !== undefined) validateResolutionProduct(row.product);
  if (encodedBytes(value) > resolutionLearningRecordBytes)
    throw new TypeError("learning record exceeds serialized limit");
  if (
    row.kind === "resolution_learning_source" &&
    maximumResolutionLearningSourceBytes(
      value as ResolutionLearningSourceRecord,
    ) > resolutionLearningRecordBytes
  )
    throw new TypeError("source lacks in-place invalidation capacity");
}
