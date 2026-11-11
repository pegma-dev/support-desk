import {
  assertResolutionLearningReviewReservation,
  type ResolutionLearningReviewReservationRecord,
} from "./resolution-learning-staged-records.js";
import type {
  CollectionStore,
  VersionedRecord,
  TransactionAction,
} from "@pegma/storage-core";
import {
  SupportDeskConflictError,
  SupportDeskNotFoundError,
  type SupportRecord,
} from "./index.js";
import {
  fields,
  fingerprint,
  integer,
  text,
} from "./assistant-turn-records.js";
import {
  safeLearningSnapshot as snapshot,
  validateResolutionTarget,
} from "./resolution-learning-records.js";
import type {
  ReviewResolutionLearningProposalCommand,
  ResolutionLearningReviewReceipt,
} from "./resolution-learning-types.js";
export async function resolutionLearningReviewIdentity(
  input: ReviewResolutionLearningProposalCommand,
  actorId: string,
) {
  const command = snapshot(
    fields(
      input,
      "review learning",
      [
        "ticketId",
        "sourceGeneration",
        "commandId",
        "correlationId",
        "expectedWorkGeneration",
        "target",
        "decision",
        "policyVersion",
      ],
      ["reason", "intentBinding"],
    ),
  ) as unknown as typeof input;
  validateResolutionTarget(command.target);
  integer(command.expectedWorkGeneration, "expectedWorkGeneration", 1);
  text(command.commandId, "commandId");
  text(command.correlationId, "correlationId");
  text(command.policyVersion, "policyVersion");
  if (command.intentBinding !== undefined) {
    text(command.intentBinding, "intentBinding", 64);
    if (!/^[0-9a-f]{64}$/.test(command.intentBinding))
      throw new TypeError("invalid review intent binding");
  }
  if (command.reason !== undefined) text(command.reason, "reason");
  if (command.decision !== "approve" && command.decision !== "reject")
    throw new TypeError("invalid review decision");
  text(command.ticketId, "ticketId");
  integer(command.sourceGeneration, "sourceGeneration", 1);
  const hash = await fingerprint({ command, actorId });
  // Preserve every existing accepted fingerprint and generic receipt shape.
  // Older readers see the cancellation fingerprint as a conflicting command.
  const cancellationHash = await fingerprint({
    operation: "cancel_resolution_learning_review",
    reviewFingerprint: hash,
  });
  return {
    command,
    actorId,
    hash,
    cancellationHash,
    key: {
      partition: command.ticketId,
      id: `learning-command:${command.commandId}`,
    },
  };
}
export type ResolutionLearningReviewIdentity = Awaited<
  ReturnType<typeof resolutionLearningReviewIdentity>
>;
export async function requireResolutionLearningReviewTicket(
  records: CollectionStore<SupportRecord>,
  identity: ResolutionLearningReviewIdentity,
): Promise<void> {
  const ticket = await records.get({
    partition: identity.command.ticketId,
    id: "ticket",
  });
  if (ticket?.kind !== "ticket") throw new SupportDeskNotFoundError();
}
export function resolutionLearningReviewReceiptValue(
  identity: ResolutionLearningReviewIdentity,
  prior: SupportRecord | null,
): ResolutionLearningReviewReceipt | null {
  if (prior === null) return null;
  if (prior.kind === "resolution_learning_review_reservation") {
    assertResolutionLearningReviewReservation(prior, identity.key);
    if (
      prior.fingerprint !== identity.hash ||
      prior.reviewerId !== identity.actorId
    )
      throw new SupportDeskConflictError("Review command reused");
    return null;
  }
  if (prior.kind !== "resolution_learning_receipt")
    throw new SupportDeskConflictError("Review command reused");
  if (
    prior.partition !== identity.key.partition ||
    prior.id !== identity.key.id
  )
    throw new SupportDeskConflictError("Review receipt identity differs");
  fields(
    prior.result,
    "review receipt result",
    ["ticketId", "sourceGeneration", "resolutionCycle", "state"],
    ["heldReason"],
  );
  if (
    prior.result.ticketId !== identity.command.ticketId ||
    !["unverified", "eligible", "held", "withdrawn"].includes(
      prior.result.state,
    )
  )
    throw new TypeError("Invalid review receipt result");
  integer(prior.result.sourceGeneration, "sourceGeneration", 0);
  integer(prior.result.resolutionCycle, "resolutionCycle", 1);
  if (prior.result.heldReason !== undefined)
    text(prior.result.heldReason, "heldReason");
  if (prior.fingerprint === identity.hash)
    return { outcome: "accepted", result: snapshot(prior.result) };
  if (prior.fingerprint === identity.cancellationHash)
    return {
      outcome: "cancelled",
      ticketId: identity.command.ticketId,
      commandId: identity.command.commandId,
    };
  throw new SupportDeskConflictError("Review command reused");
}

export interface ResolutionLearningReviewSlot {
  readonly receipt: ResolutionLearningReviewReceipt | null;
  readonly reservation: VersionedRecord<ResolutionLearningReviewReservationRecord> | null;
}
/** One physical observation supplies both terminal receipt and opaque reservation version. */
export async function readResolutionLearningReviewSlot(
  records: CollectionStore<SupportRecord>,
  identity: ResolutionLearningReviewIdentity,
): Promise<ResolutionLearningReviewSlot> {
  const stored = await records.getVersioned(identity.key);
  const receipt = resolutionLearningReviewReceiptValue(
    identity,
    stored?.value ?? null,
  );
  return {
    receipt,
    reservation:
      stored?.value.kind === "resolution_learning_review_reservation"
        ? { value: stored.value, version: stored.version }
        : null,
  };
}
export async function observeResolutionLearningReview(
  records: CollectionStore<SupportRecord>,
  identity: ResolutionLearningReviewIdentity,
): Promise<ResolutionLearningReviewReceipt | null> {
  return (await readResolutionLearningReviewSlot(records, identity)).receipt;
}

export function resolutionLearningReviewReceiptAction(
  slot: ResolutionLearningReviewSlot,
  value: Extract<SupportRecord, { kind: "resolution_learning_receipt" }>,
): TransactionAction<SupportRecord> {
  return slot.reservation === null
    ? { action: "insert", value }
    : { action: "putIfUnchanged", version: slot.reservation.version, value };
}
