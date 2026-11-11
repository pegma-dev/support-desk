import type { EntityKey } from "@pegma/storage-core";
import type { IsoTimestamp, PrincipalId } from "@pegma/spine";
import {
  canonical,
  encodedBytes,
  fields,
  integer,
  text,
  timestamp,
} from "./assistant-turn-records.js";
import { validateResolutionTarget } from "./resolution-learning-records.js";
import type { ReviewResolutionLearningProposalCommand } from "./resolution-learning-types.js";
import type {
  ResolutionLearningStagedReviewFence,
  ResolutionLearningStagedReviewIntent,
  ResolutionLearningStagedReviewProof,
} from "./resolution-learning-staged-types.js";

export interface ResolutionLearningReviewAttemptRecord {
  readonly kind: "resolution_learning_review_attempt";
  readonly partition: string;
  readonly id: string;
  readonly ticketId: string;
  readonly reviewerId: PrincipalId;
  readonly command: ReviewResolutionLearningProposalCommand;
  readonly intent: ResolutionLearningStagedReviewIntent;
  readonly fingerprint: string;
  readonly state: "pending" | "held" | "accepted" | "cancelled";
  readonly phase: "proof" | "commit";
  readonly claimGeneration: number;
  readonly claim?: ResolutionLearningStagedReviewFence;
  readonly leaseUntil?: IsoTimestamp;
  readonly proof?: ResolutionLearningStagedReviewProof;
  readonly createdAt: IsoTimestamp;
  readonly expiresAt: IsoTimestamp;
  /** New exact-review and final Audit rows; the canonical slot is already reserved. */
  readonly completionRows: 0 | 2;
}
export function resolutionLearningReviewAttemptKey(
  ticketId: string,
  commandId: string,
): EntityKey {
  text(ticketId, "ticketId");
  text(commandId, "commandId");
  return { partition: ticketId, id: `learning-review-attempt:${commandId}` };
}
function hash(value: unknown, name: string): void {
  text(value, name, 64);
  if (!/^[0-9a-f]{64}$/.test(value as string))
    throw new TypeError(`Invalid ${name}`);
}
export function validateStagedReviewIntent(
  value: unknown,
): asserts value is ResolutionLearningStagedReviewIntent {
  const intent = fields(value, "review intent", [
    "reviewerId",
    "ticketId",
    "sourceGeneration",
    "expectedWorkGeneration",
    "target",
    "policy",
  ]);
  text(intent.reviewerId, "reviewerId");
  text(intent.ticketId, "ticketId");
  integer(intent.sourceGeneration, "sourceGeneration", 1);
  integer(intent.expectedWorkGeneration, "expectedWorkGeneration", 1);
  validateResolutionTarget(intent.target);
  const policy = fields(intent.policy, "review policy", [
    "version",
    "binding",
    "verifiedAt",
    "validUntil",
  ]);
  text(policy.version, "policy.version");
  text(policy.binding, "policy.binding");
  if (
    timestamp(policy.verifiedAt, "verifiedAt") >=
    timestamp(policy.validUntil, "validUntil")
  )
    throw new TypeError("Invalid review policy interval");
}
export function validateStagedReviewProof(
  value: unknown,
): asserts value is ResolutionLearningStagedReviewProof {
  const proof = fields(value, "review proof", ["binding", "validUntil"]);
  hash(proof.binding, "proof.binding");
  timestamp(proof.validUntil, "proof.validUntil");
}
export function validateStagedReviewFence(
  value: unknown,
): asserts value is ResolutionLearningStagedReviewFence {
  const fence = fields(value, "review claim", [
    "ticketId",
    "commandId",
    "workerId",
    "claimId",
    "claimGeneration",
  ]);
  for (const key of ["ticketId", "commandId", "workerId", "claimId"])
    text(fence[key], key);
  integer(fence.claimGeneration, "claimGeneration", 1);
}
/** Pending rows are durable outbox state. Expiry alone never deletes an unknown command. */
export function assertResolutionLearningReviewAttempt(
  value: unknown,
  key: EntityKey,
): asserts value is ResolutionLearningReviewAttemptRecord {
  const row = fields(
    value,
    "review attempt",
    [
      "kind",
      "partition",
      "id",
      "ticketId",
      "reviewerId",
      "command",
      "intent",
      "fingerprint",
      "state",
      "phase",
      "claimGeneration",
      "createdAt",
      "expiresAt",
      "completionRows",
    ],
    ["claim", "leaseUntil", "proof"],
  );
  if (
    row.kind !== "resolution_learning_review_attempt" ||
    row.partition !== key.partition ||
    row.id !== key.id ||
    row.ticketId !== key.partition
  )
    throw new TypeError("Invalid review attempt envelope");
  validateStagedReviewIntent(row.intent);
  const intent = row.intent;
  const command = fields(
    row.command,
    "staged review command",
    [
      "ticketId",
      "commandId",
      "correlationId",
      "sourceGeneration",
      "expectedWorkGeneration",
      "target",
      "policyVersion",
      "intentBinding",
      "decision",
    ],
    ["reason"],
  );
  for (const name of [
    "ticketId",
    "commandId",
    "correlationId",
    "policyVersion",
  ])
    text(command[name], name);
  if (command.reason !== undefined) text(command.reason, "reason");
  validateResolutionTarget(command.target);
  hash(command.intentBinding, "intentBinding");
  hash(row.fingerprint, "fingerprint");
  if (command.decision !== "approve" && command.decision !== "reject")
    throw new TypeError("Invalid review decision");
  const expected = resolutionLearningReviewAttemptKey(
    intent.ticketId,
    command.commandId as string,
  );
  if (
    key.partition !== expected.partition ||
    key.id !== expected.id ||
    command.ticketId !== intent.ticketId ||
    row.reviewerId !== intent.reviewerId ||
    command.sourceGeneration !== intent.sourceGeneration ||
    command.expectedWorkGeneration !== intent.expectedWorkGeneration ||
    command.policyVersion !== intent.policy.version ||
    canonical(command.target) !== canonical(intent.target) ||
    row.expiresAt !== intent.policy.validUntil
  )
    throw new TypeError("Review attempt bindings differ");
  integer(row.claimGeneration, "claimGeneration", 0);
  timestamp(row.createdAt, "createdAt");
  timestamp(row.expiresAt, "expiresAt");
  if (
    !["pending", "held", "accepted", "cancelled"].includes(
      row.state as string,
    ) ||
    !["proof", "commit"].includes(row.phase as string)
  )
    throw new TypeError("Invalid staged review state");
  if (
    row.completionRows !==
    (row.state === "accepted" || row.state === "cancelled" ? 0 : 2)
  )
    throw new TypeError("Invalid review completion reserve");
  if ((row.claim === undefined) !== (row.leaseUntil === undefined))
    throw new TypeError("Incomplete review lease");
  if (row.claim !== undefined) {
    validateStagedReviewFence(row.claim);
    if (
      row.state !== "pending" ||
      row.claim.ticketId !== row.ticketId ||
      row.claim.commandId !== command.commandId ||
      row.claim.claimGeneration !== row.claimGeneration ||
      timestamp(row.leaseUntil, "leaseUntil") >
        timestamp(row.expiresAt, "expiresAt")
    )
      throw new TypeError("Invalid review lease binding");
  }
  if (row.proof !== undefined) {
    validateStagedReviewProof(row.proof);
    if (
      row.phase !== "commit" ||
      timestamp(row.proof.validUntil, "proof.validUntil") >
        timestamp(row.expiresAt, "expiresAt")
    )
      throw new TypeError("Invalid prepared review proof");
  }
  if (
    row.state === "pending" &&
    row.phase === "commit" &&
    row.proof === undefined
  )
    throw new TypeError("Commit phase requires P1 proof");
  if (encodedBytes(value) > 60_000)
    throw new TypeError("Review attempt exceeds serialized limit");
}
/** Reserve legal future claim/proof envelopes before accepting the command. */
export function maximumResolutionLearningReviewAttemptBytes(
  row: ResolutionLearningReviewAttemptRecord,
): number {
  return encodedBytes({
    ...row,
    state: "pending",
    phase: "commit",
    completionRows: 2,
    claimGeneration: Number.MAX_SAFE_INTEGER,
    claim: {
      ticketId: row.ticketId,
      commandId: row.command.commandId,
      workerId: "\ud800".repeat(200),
      claimId: "\ud800".repeat(200),
      claimGeneration: Number.MAX_SAFE_INTEGER,
    },
    leaseUntil: "9999-12-31T23:59:59.999Z",
    proof: { binding: "f".repeat(64), validUntil: "9999-12-31T23:59:59.999Z" },
  });
}

/** Canonical command ownership, without staff reason, intent or source bodies. */
export interface ResolutionLearningReviewReservationRecord {
  readonly kind: "resolution_learning_review_reservation";
  readonly partition: string;
  readonly id: string;
  readonly ticketId: string;
  readonly commandId: string;
  readonly reviewerId: PrincipalId;
  readonly fingerprint: string;
  readonly expiresAt: IsoTimestamp;
}
export function assertResolutionLearningReviewReservation(
  value: unknown,
  key: EntityKey,
): asserts value is ResolutionLearningReviewReservationRecord {
  const row = fields(value, "review reservation", [
    "kind",
    "partition",
    "id",
    "ticketId",
    "commandId",
    "reviewerId",
    "fingerprint",
    "expiresAt",
  ]);
  for (const name of ["ticketId", "commandId", "reviewerId"])
    text(row[name], name);
  hash(row.fingerprint, "fingerprint");
  timestamp(row.expiresAt, "expiresAt");
  if (
    row.kind !== "resolution_learning_review_reservation" ||
    row.partition !== key.partition ||
    row.ticketId !== key.partition ||
    row.id !== key.id ||
    key.id !== `learning-command:${row.commandId as string}`
  )
    throw new TypeError("Review reservation envelope mismatch");
}
