/**
 * Runnable host-neutral composition. From the repository root:
 *
 *   pnpm run example
 *
 * Exits after proving customer create/list/read/reply, staff detail/queue/
 * mutations, internal-note isolation, one mail-send page, and verified
 * inbound mail (new unverified ticket, retry dedupe, threaded follow-up, and
 * auto-reply suppression).
 */
import {
  createExampleComposition,
  runCompleteExampleFlow,
  runInboundExampleFlow,
  runLifecycleExampleFlow,
  runAttachmentExampleFlow,
} from "./composition.ts";

const composition = createExampleComposition();
const result = await runCompleteExampleFlow(composition);
const inbound = await runInboundExampleFlow(composition);
const lifecycle = await runLifecycleExampleFlow(composition);
const attachments = await runAttachmentExampleFlow();

process.stdout.write(
  [
    "Support Desk example composition completed.",
    `attachmentsDeleted=${String(attachments.deleted)}`,
    `ticketId=${result.ticketId}`,
    `subject=${result.customerViewSubject}`,
    `staffQueueSize=${String(result.staffQueueSize)}`,
    `noteCount=${String(result.noteCount)}`,
    `customerMessages=${String(result.customerMessageBodies.length)}`,
    `mailSent=${String(result.mailSent)}`,
    `inboundCreated=${inbound.created.outcome}/${String(inbound.created.association)}`,
    `inboundRetryDuplicate=${String(inbound.retry.duplicateDelivery)}`,
    `inboundFollowUp=${inbound.followUp.outcome}/${String(inbound.followUp.matchMethod)}`,
    `inboundAutoReply=${inbound.autoReply.outcome}/${String(inbound.autoReply.reason)}`,
    `lifecycleTags=${lifecycle.tags?.join(",")}`,
    `lifecycleStaleRevision=${String(lifecycle.staleRevision)}`,
    `lifecycleFirstResponse=${lifecycle.firstStaffRespondedAt}`,
    `lifecycleResolved=${lifecycle.resolvedAt}`,
    "",
  ].join("\n"),
);
