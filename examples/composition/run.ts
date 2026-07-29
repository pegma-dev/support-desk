/**
 * Runnable host-neutral composition. From the repository root:
 *
 *   npm run example
 *
 * Exits after proving customer create/list/read/reply, staff detail/queue/
 * mutations, internal-note isolation, and one mail-send page.
 */
import {
  createExampleComposition,
  runCompleteExampleFlow,
} from "./composition.ts";

const result = await runCompleteExampleFlow(createExampleComposition());

process.stdout.write(
  [
    "Support Desk example composition completed.",
    `ticketId=${result.ticketId}`,
    `subject=${result.customerViewSubject}`,
    `staffQueueSize=${String(result.staffQueueSize)}`,
    `noteCount=${String(result.noteCount)}`,
    `customerMessages=${String(result.customerMessageBodies.length)}`,
    `mailSent=${String(result.mailSent)}`,
    "",
  ].join("\n"),
);
