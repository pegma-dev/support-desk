import { hasPermission, type AccessContext } from "@pegma/authorization-core";
import {
  SupportDeskAuthorizationError,
  supportPermissions,
  type ReviewResolutionLearningProposalCommand,
} from "@pegma/support-desk-application";
import type { LearningReviewCommand } from "./learning-integration-types.js";
import {
  AssistantBoundaryError,
  exactKeys,
  fingerprint,
  scalar,
  snapshot,
  timestamp,
} from "./boundary.js";
import { learningAuthoritySnapshot } from "./learning-request.js";

export function learningReviewAuthority(access: AccessContext): AccessContext {
  const staff = learningAuthoritySnapshot({
    access,
    authorityVersion: "staff-review",
    usageScopeRef: "staff-review",
  }).access;
  for (const name of [
    supportPermissions.learningReview,
    supportPermissions.queueRead,
  ])
    if (!hasPermission(staff, name))
      throw new SupportDeskAuthorizationError(name);
  return staff;
}
export async function learningReviewCommand(
  access: AccessContext,
  input: LearningReviewCommand,
) {
  const packet = snapshot(input);
  exactKeys(packet, [
    "intent",
    "commandId",
    "correlationId",
    "decision",
    ...(packet.reason === undefined ? [] : ["reason"]),
  ]);
  const intent = packet.intent;
  exactKeys(intent, [
    "reviewerId",
    "ticketId",
    "sourceGeneration",
    "expectedWorkGeneration",
    "target",
    "policy",
  ]);
  scalar(intent.reviewerId);
  if (intent.reviewerId !== access.principalId)
    throw new AssistantBoundaryError("authority_changed");
  exactKeys(intent.policy, ["version", "binding", "verifiedAt", "validUntil"]);
  scalar(intent.policy.version);
  scalar(intent.policy.binding);
  timestamp(intent.policy.verifiedAt);
  timestamp(intent.policy.validUntil);
  // Expired historical proofs may still recover a receipt or be cancelled.
  // Only a new submission must satisfy current policy and KB/source checks.
  const command: ReviewResolutionLearningProposalCommand = {
    ticketId: intent.ticketId,
    sourceGeneration: intent.sourceGeneration,
    expectedWorkGeneration: intent.expectedWorkGeneration,
    target: intent.target,
    policyVersion: intent.policy.version,
    intentBinding: await fingerprint(intent),
    commandId: packet.commandId,
    correlationId: packet.correlationId,
    decision: packet.decision,
    ...(packet.reason === undefined ? {} : { reason: packet.reason }),
  };
  return { command, policy: intent.policy };
}
