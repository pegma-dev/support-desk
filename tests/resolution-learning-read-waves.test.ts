import { createSupportDeskLearningSourceVerifier } from "@pegma/support-desk-ai";
import type { PrivateSourcesVerifier } from "@pegma/knowledge-base-application";
import { describe, expect, it } from "vitest";
import {
  confirmLearningKBReadability,
  readLearningKBTarget,
} from "../packages/ai/src/learning-kb.js";
import { createLearningRuntime } from "../packages/ai/src/learning-runtime.js";
import {
  learningKbBarrier,
  learningKbFixture,
  learningKbStores,
} from "../test/resolution-learning-kb-fixtures.js";

type Fixture = Awaited<ReturnType<typeof learningKbFixture>>;
async function completeHistory(f: Fixture) {
  const first = await f.eligible("staff_verified_fix", "contributor-A");
  const delivered = await f.processToDraft(first);
  await f.reviewAndPublish(delivered.articleId, first.ticketId);
  const second = await f.eligible("staff_verified_fix", "contributor-B");
  f.updateTarget(delivered.articleId);
  await f.processToDraft(second);
  const runtime = createLearningRuntime({ clock: f.support.clock });
  try {
    return await readLearningKBTarget(
      { knowledge: f.ports.knowledge },
      f.access.staff,
      delivered.articleId,
      runtime,
    );
  } finally {
    runtime.close();
  }
}
async function reached(
  gate: ReturnType<typeof learningKbBarrier>,
  pending: Promise<unknown>,
) {
  await Promise.race([
    gate.reached,
    pending.then(() => {
      throw new Error("Read wave ended before reaching its bounded barrier");
    }),
  ]);
}

for (const [name, store] of learningKbStores)
  describe(`learning settled read waves (${name})`, () => {
    it("launches complete current readability together but preserves the distinct published boundary and repeated references", async () => {
      const f = await learningKbFixture(store());
      const target = await completeHistory(f);
      expect(target.provenance.snapshot.references).toHaveLength(2);
      expect(target.provenance.publishedSnapshot?.references).toHaveLength(1);
      const first = learningKbBarrier();
      const second = learningKbBarrier();
      const observed: string[] = [];
      const sources: PrivateSourcesVerifier = {
        ...f.sources,
        async canRead(request) {
          observed.push(request.reference.resourceId);
          if (observed.length === 1) await first.wait();
          else if (observed.length === 2) await second.wait();
          return f.sources.canRead(request);
        },
      };
      const runtime = createLearningRuntime({ clock: f.support.clock });
      const pending = confirmLearningKBReadability(
        { sources, readScheduling: "sdk" },
        f.access.staff,
        target,
        runtime,
      );
      try {
        await reached(second, pending);
        expect(observed).toEqual(
          target.provenance.snapshot.references.map(
            (reference) => reference.resourceId,
          ),
        );
        first.release();
        second.release();
        await pending;
        expect(observed).toEqual(
          [
            ...target.provenance.snapshot.references,
            ...target.provenance.publishedSnapshot!.references,
          ].map((reference) => reference.resourceId),
        );
      } finally {
        first.release();
        second.release();
        runtime.close();
      }
    });

    it("preserves serial structural custom callbacks by default", async () => {
      const f = await learningKbFixture(store());
      const target = await completeHistory(f);
      const gate = learningKbBarrier();
      const observed: string[] = [];
      const sources: PrivateSourcesVerifier = {
        ...f.sources,
        async canRead(request) {
          observed.push(request.reference.resourceId);
          if (observed.length === 1) await gate.wait();
          return f.sources.canRead(request);
        },
      };
      const runtime = createLearningRuntime({ clock: f.support.clock });
      const pending = confirmLearningKBReadability(
        { sources },
        f.access.staff,
        target,
        runtime,
      );
      try {
        await reached(gate, pending);
        await Promise.resolve();
        expect(observed).toHaveLength(1);
        gate.release();
        await pending;
        expect(observed).toHaveLength(3);
      } finally {
        gate.release();
        runtime.close();
      }
    });

    it("consumes every launched readability settlement before failing and never crosses into published proof", async () => {
      const f = await learningKbFixture(store());
      const target = await completeHistory(f);
      const gate = learningKbBarrier();
      const observed: string[] = [];
      let settled = false;
      let returned = false;
      const sources: PrivateSourcesVerifier = {
        ...f.sources,
        async canRead(request) {
          observed.push(request.reference.resourceId);
          if (observed.length === 1)
            throw new Error("First read dependency failed");
          await gate.wait();
          return f.sources.canRead(request);
        },
      };
      const runtime = createLearningRuntime({ clock: f.support.clock });
      const pending = confirmLearningKBReadability(
        { sources, readScheduling: "sdk" },
        f.access.staff,
        target,
        runtime,
      ).then(
        () => {
          settled = true;
          returned = true;
        },
        () => {
          settled = true;
        },
      );
      try {
        await reached(gate, pending);
        await Promise.resolve();
        expect(settled).toBe(false);
        expect(observed).toHaveLength(2);
        gate.release();
        await pending;
        expect(settled).toBe(true);
        expect(returned).toBe(false);
        expect(observed).toHaveLength(2);
      } finally {
        gate.release();
        runtime.close();
      }
    });

    it("keeps the whole foreign callback between initial contributor proof and refreshed-authority confirmations", async () => {
      const f = await learningKbFixture(store());
      await f.eligible("staff_verified_fix", "foreign-contributor-A");
      await f.eligible("staff_verified_fix", "foreign-contributor-B");
      const references = [
        await f.reference("foreign-contributor-A"),
        await f.reference("foreign-contributor-B"),
        {
          id: "external-proof",
          system: "synthetic.external",
          resourceId: "external-resource",
          version: "external-version",
        },
      ];
      const draft = await f.createGuide(
        "foreign-wave-guide",
        "A privately checked guide",
        references,
      );
      const context = await f.currentSourceContext(draft.articleId);
      const events: string[] = [];
      const verifier = createSupportDeskLearningSourceVerifier({
        application: {
          ...f.support.app,
          async readResolutionLearningSource(access, ticketId) {
            events.push(`read:${ticketId}`);
            return f.support.app.readResolutionLearningSource(access, ticketId);
          },
          async confirmResolutionLearningSource(access, fence) {
            events.push(`confirm:${fence.ticketId}`);
            return f.support.app.confirmResolutionLearningSource(access, fence);
          },
        },
        serviceAccess: {
          async resolve(signal) {
            events.push("authority");
            return f.ports.resolveService(signal);
          },
        },
        reviewPolicy: f.checks,
        otherSources: {
          ...f.otherSources,
          async isCurrent(request) {
            events.push("foreign");
            expect(request).toEqual(context);
            return f.otherSources.isCurrent(request);
          },
        },
        clock: f.support.clock,
        readScheduling: "sdk",
      });
      expect(await verifier.isCurrent(context)).toBe(true);
      const foreign = events.indexOf("foreign");
      expect(foreign).toBeGreaterThan(0);
      expect(
        events
          .slice(0, foreign)
          .filter((value) => value.startsWith("confirm:")),
      ).toHaveLength(2);
      expect(events[foreign + 1]).toBe("authority");
      expect(
        events
          .slice(foreign + 2, -1)
          .filter((value) => value.startsWith("confirm:")),
      ).toHaveLength(2);
      expect(events.at(-1)).toBe("authority");
      expect(f.otherSources.isCurrent).toHaveBeenLastCalledWith(context);
      expect(f.otherSources.canPublish).not.toHaveBeenCalled();
    });

    it("bounds independent real contributor chains within the authority/foreign/final-confirm phases", async () => {
      const f = await learningKbFixture(store());
      const target = await completeHistory(f);
      const events: string[] = [];
      const gate = learningKbBarrier();
      let readCount = 0;
      const verifier = createSupportDeskLearningSourceVerifier({
        application: {
          ...f.support.app,
          async readResolutionLearningSource(access, ticketId) {
            events.push(`read:${ticketId}`);
            readCount += 1;
            if (readCount === 1) await gate.wait();
            else if (readCount === 2) gate.release();
            return f.support.app.readResolutionLearningSource(access, ticketId);
          },
          async confirmResolutionLearningSource(access, fence) {
            events.push(`confirm:${fence.ticketId}`);
            return f.support.app.confirmResolutionLearningSource(access, fence);
          },
        },
        serviceAccess: {
          async resolve(signal) {
            events.push("authority");
            return f.ports.resolveService(signal);
          },
        },
        reviewPolicy: f.checks,
        otherSources: f.otherSources,
        clock: f.support.clock,
        readScheduling: "sdk",
      });
      try {
        expect(
          await verifier.isCurrent({
            article: target.draft.revision,
            snapshot: target.provenance.snapshot,
          }),
        ).toBe(true);
        expect(events[0]).toBe("authority");
        expect(events.slice(1, 3)).toEqual(
          target.provenance.snapshot.references.map(
            (reference) => `read:${reference.resourceId}`,
          ),
        );
        const authorityPositions = events.flatMap((value, index) =>
          value === "authority" ? [index] : [],
        );
        expect(authorityPositions).toHaveLength(3);
        expect(
          events
            .slice(1, authorityPositions[1])
            .filter((value) => value.startsWith("confirm:")),
        ).toHaveLength(2);
        expect(
          events
            .slice(authorityPositions[1]! + 1, authorityPositions[2])
            .filter((value) => value.startsWith("confirm:")),
        ).toHaveLength(2);
        expect(events.at(-1)).toBe("authority");
      } finally {
        gate.release();
      }
    });
  });
