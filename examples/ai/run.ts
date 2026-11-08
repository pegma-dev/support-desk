import { runSyntheticAiExample } from "./composition.js";

const result = await runSyntheticAiExample();
// Only opaque fictional outcomes are printed; provider inputs and draft bodies stay out of CLI logs.
process.stdout.write(
  [
    "Synthetic optional AI composition completed.",
    `assistantReplies=${result.answer.assistantMessageCount}`,
    `humanTakeover=${result.answer.humanTakeover}`,
    `learningDraft=${result.learning.draftState}`,
    `privateDraftExcluded=${result.learning.excludedFromRetrieval}`,
    `engineering=${result.engineering.operation}/${result.engineering.accepted}`,
    `followupDelivered=${result.followup.delivered}`,
    `customerNotices=${result.followup.customerNoticeCount}`,
    `providerNetworkCalls=${result.calls.providerNetwork}`,
    `githubCreates=${result.calls.githubCreate}`,
    `mailSends=${result.calls.mailSend}`,
    `agentPublications=${result.calls.agentPublications}`,
    "",
  ].join("\n"),
);
