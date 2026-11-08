import { fixedClock } from "@pegma/spine";
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import {
  runSyntheticAiExample,
  type SyntheticAiExampleResult,
} from "../examples/ai/composition.js";
import { syntheticPrivateNote } from "../examples/ai/synthetic-ports.js";
import { aiCompositionStores } from "../test/ai-composition-fixtures.js";

for (const [name, createStore] of aiCompositionStores) {
  describe(`optional AI public composition (${name})`, () => {
    let result: SyntheticAiExampleResult;

    beforeAll(async () => {
      result = await runSyntheticAiExample({
        store: createStore(),
        clock: fixedClock("2026-11-08T12:00:00.000Z"),
        idPrefix: `composition-${randomUUID()}`,
      });
    }, 60_000);

    it("answers from approved knowledge and hands the ticket to a person", () => {
      expect(result.answer.ticketId).toBeTruthy();
      expect(result.answer.assistantMessageCount).toBe(1);
      expect(result.answer.customerVisibleBodies.length).toBeGreaterThan(0);
      expect(result.answer.humanTakeover).toBe(true);
      expect(result.answer.citationArticleIds.length).toBeGreaterThan(0);
      expect(result.calls.answer).toBe(1);
    });

    it("creates a verified private learning draft that approved retrieval excludes", () => {
      expect(result.learning.articleId).toBeTruthy();
      expect(result.learning.sourceGeneration).toBeGreaterThan(0);
      expect(result.learning.sourceReferenceCount).toBe(1);
      expect(result.learning.draftState).toBe("draft");
      expect(result.learning.excludedFromRetrieval).toBe(true);
      expect(result.learning.retrievedArticleIds).not.toContain(
        result.learning.articleId,
      );
      expect(result.answer.citationArticleIds).not.toContain(
        result.learning.articleId,
      );
      expect(result.calls.learning).toBe(1);
    });

    it("links the verified bug to an existing issue through exact staff review", () => {
      expect(result.engineering.ticketId).toBeTruthy();
      expect(result.engineering.ticketId).not.toBe(result.answer.ticketId);
      expect(result.engineering.operation).toBe("link_existing_issue");
      expect(result.engineering.issueId).toBeTruthy();
      expect(result.engineering.accepted).toBe(true);
      expect(result.calls.engineering).toBe(1);
      expect(result.calls.githubCreate).toBe(0);
    });

    it("posts one staff-approved deployed-fix notice without resolving the ticket", () => {
      expect(result.followup.workId).toBeTruthy();
      expect(result.followup.messageId).toBeTruthy();
      expect(result.followup.delivered).toBe(true);
      expect(result.followup.kbProposalPrepared).toBe(true);
      expect(result.followup.retestRequestCount).toBeGreaterThan(0);
      expect(result.followup.ticketStatusAfter).toBe(
        result.followup.ticketStatusBefore,
      );
      expect(result.followup.ticketStatusAfter).not.toBe("resolved");
      expect(result.followup.ticketStatusAfter).not.toBe("closed");
      expect(result.followup.customerNoticeCount).toBe(1);
      expect(result.followup.postReplaySameMessage).toBe(true);
      expect(result.safety.noWorkerNotice).toBe(true);
      expect(result.calls.followup).toBe(1);
    });

    it("keeps private notes out of every actual provider input and customer message", () => {
      expect(
        result.safety.providerInputs.map((input) => input.purpose).sort(),
      ).toEqual([
        "support_answer",
        "support_bug_assessment",
        "support_learning",
        "support_release_followup",
      ]);
      for (const input of result.safety.providerInputs) {
        expect(input.serializedInput.length).toBeGreaterThan(0);
        expect(() => JSON.parse(input.serializedInput)).not.toThrow();
        expect(input.serializedInput).not.toContain(syntheticPrivateNote);
      }
      expect(JSON.stringify(result.answer.customerVisibleBodies)).not.toContain(
        syntheticPrivateNote,
      );
      expect(result.safety.privateNotesExcluded).toBe(true);
    });

    it("uses scripted ports without live provider, issue creation, mail, or agent publication", () => {
      expect(result.calls.providerNetwork).toBe(0);
      expect(result.calls.githubCreate).toBe(0);
      expect(result.calls.mailSend).toBe(0);
      expect(result.calls.agentPublications).toBe(0);
      expect(result.calls.setupPublications).toBeGreaterThan(0);
    });
  });
}
