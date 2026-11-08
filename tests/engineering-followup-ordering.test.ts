import { describe, expect, it } from "vitest";
import type { EngineeringFollowupContext } from "../packages/application/src/engineering-followup-types.js";
import {
  engineeringFollowupCustomer as customer,
  engineeringFollowupFixture,
  engineeringFollowupService as service,
  engineeringFollowupStaff as staff,
  engineeringFollowupStores,
} from "../test/engineering-followup-fixtures.js";
import {
  acceptanceCases,
  fixtureInstances,
} from "../test/knowledge-ai/corpus.js";

type Fixture = Awaited<ReturnType<typeof engineeringFollowupFixture>>;
function updateContext(
  f: Fixture,
  changes: {
    readonly issue?: Partial<EngineeringFollowupContext["issueHead"]>;
    readonly deployment?: Partial<EngineeringFollowupContext["deploymentHead"]>;
    readonly mapping?: Partial<
      NonNullable<EngineeringFollowupContext["mapping"]>
    >;
  },
) {
  const current = f.state.context!;
  const issueHead = { ...current.issueHead, ...changes.issue };
  const deploymentHead = { ...current.deploymentHead, ...changes.deployment };
  f.state.context = {
    issueHead,
    deploymentHead,
    ...(current.mapping === undefined
      ? {}
      : {
          mapping: {
            ...current.mapping,
            issueHeadHash: issueHead.hash,
            deploymentHeadHash: deploymentHead.hash,
            ...changes.mapping,
          },
        }),
  };
}
const works = async (f: Fixture) =>
  (await f.rows()).filter((row) => row.kind === "engineering_followup_work");

for (const [name, createStore] of engineeringFollowupStores) {
  describe(`engineering follow-up observation ordering (${name})`, () => {
    it.each(["issue", "deployment"] as const)(
      "ignores a lower %s generation without moving the other observed head or reviving work",
      async (dimension) => {
        const f = await engineeringFollowupFixture(createStore());
        updateContext(f, {
          issue: { generation: 5, hash: "issue-head-5" },
          deployment: {
            generation: 7,
            hash: "deployment-head-7",
            deploymentEpoch: "epoch-7",
          },
        });
        const key = await f.eligible();
        const head = await f.head();
        const work = await f.work(key);
        updateContext(
          f,
          dimension === "issue"
            ? { issue: { generation: 4, hash: "stale-issue-head-4" } }
            : {
                deployment: { generation: 6, hash: "stale-deployment-head-6" },
              },
        );
        expect((await f.observe()).outcome).toBe("stale");
        expect(await f.head()).toEqual(head);
        expect(await f.work(key)).toEqual(work);
        expect(await works(f)).toHaveLength(1);
      },
    );

    it.each(["issue", "deployment"] as const)(
      "rejects a different %s hash at the same generation without a partial head update",
      async (dimension) => {
        const f = await engineeringFollowupFixture(createStore());
        const key = await f.eligible();
        const before = await f.rows();
        updateContext(
          f,
          dimension === "issue"
            ? { issue: { hash: "conflicting-same-generation-issue" } }
            : {
                deployment: { hash: "conflicting-same-generation-deployment" },
              },
        );
        await expect(f.observe()).rejects.toThrow();
        expect(await f.rows()).toEqual(before);
        expect((await f.work(key)).status).toBe("pending");
      },
    );

    it("treats issue and deployment generations independently instead of comparing their numbers", async () => {
      const f = await engineeringFollowupFixture(createStore());
      updateContext(f, {
        issue: { generation: 70, hash: "issue-head-70" },
        deployment: { generation: 2, hash: "deployment-head-2" },
      });
      const first = await f.eligible();
      updateContext(f, {
        deployment: {
          generation: 3,
          hash: "deployment-head-3",
          deploymentEpoch: "deployment-epoch-3",
        },
      });
      const second = await f.eligible();
      expect(second.workId).not.toBe(first.workId);
      const head = await f.head();
      expect(head.associationHeads[0]!.issueHead.generation).toBe(70);
      expect(head.deploymentContexts[0]!.deploymentHead.generation).toBe(3);
      expect(head.workCount).toBe(2);
    });

    it("coalesces duplicate semantic deployment proof across delivery IDs, refreshed attestations and ticket metadata revisions", async () => {
      const f = await engineeringFollowupFixture(createStore());
      const key = await f.eligible();
      const first = await f.work(key);
      for (let delivery = 0; delivery < 3; delivery += 1) {
        f.advance(1);
        await f.app.addNote(staff, {
          ...f.command("metadata-between-release-deliveries"),
          messageId: `release-metadata-note-${delivery}`,
          body: "PRIVATE_FOLLOWUP_METADATA_ONLY_NOTE",
        });
        const result = await f.observe();
        if (result.workId !== undefined) expect(result.workId).toBe(key.workId);
        expect(result.outcome).toBe("unchanged");
      }
      expect((await f.head()).workCount).toBe(1);
      expect(await works(f)).toHaveLength(1);
      expect((await f.work(key)).semanticIdentity).toEqual(
        first.semanticIdentity,
      );
      expect(f.support.generate).toHaveBeenCalledTimes(1);
      expect(f.support.createIssue).toHaveBeenCalledOnce();
    });

    it("holds unsent work when the issue reopens and ignores a later stale closed observation", async () => {
      const f = await engineeringFollowupFixture(createStore());
      const key = await f.eligible();
      await f.prepareCandidate({ key });
      const closed = structuredClone(f.state.context!);
      updateContext(f, {
        issue: { generation: 2, hash: "issue-reopened-2", state: "open" },
      });
      expect((await f.observe()).outcome).toBe("held");
      const held = await f.work(key);
      expect(held).toMatchObject({
        status: "held",
        completionRows: 0,
        messageSlots: 0,
      });
      f.state.context = closed;
      expect((await f.observe()).outcome).toBe("stale");
      expect(await f.work(key)).toEqual(held);
      expect(
        await f.app.claimEngineeringFollowupWork(service, {
          ...key,
          workerId: "stale-observation-worker",
          claimId: "stale-observation-claim",
          leaseMilliseconds: 1_000,
        }),
      ).toBeNull();
    });

    for (const instance of Object.values(fixtureInstances)) {
      const policy = {
        enabled: true,
        repositories: Object.values(instance.repositories).map(
          (repository) => ({
            repositoryId: repository.id,
            owner: `synthetic-${instance.id}`,
            name: repository.id.endsWith("guides") ? "guides" : "product",
            visibility: repository.visibility,
            responsibilities: repository.description,
            product: "workspace",
            component: "export",
            version: "2.x",
            allowedLabels: ["bug"],
            allowedTemplates: ["bug-report"],
            publicationMode: "approval_required" as const,
            enabled: true,
          }),
        ),
      };
      it(`runs the ${instance.id}/issue-closed-only corpus case through real observations without producing a draft or retest`, async () => {
        const example = acceptanceCases.find(
          (entry) => entry.id === `${instance.id}/issue-closed-only`,
        )!;
        const f = await engineeringFollowupFixture(createStore(), {
          support: {
            repositoryPolicy: policy,
            privateNote: instance.staffSentinel,
          },
        });
        f.support.generate.mockClear();
        const { mapping: _mapping, ...unmapped } = f.state.context!;
        f.state.context = {
          ...unmapped,
          deploymentHead: { ...unmapped.deploymentHead, state: "unknown" },
        };
        const result = await f.observe();
        expect(example.input.issueState).toBe("closed");
        expect(result.outcome).toBe("held");
        expect(await works(f)).toHaveLength(example.expected.counts.draft!);
        expect(
          (await works(f)).flatMap((work) => work.retestResults),
        ).toHaveLength(example.expected.counts.retest!);
        expect(f.support.generate).toHaveBeenCalledTimes(
          example.expected.modelCalls,
        );
      });

      it(`runs the ${instance.id}/release-rollback corpus case with a newer rollback epoch for the older build`, async () => {
        const example = acceptanceCases.find(
          (entry) => entry.id === `${instance.id}/release-rollback`,
        )!;
        const f = await engineeringFollowupFixture(createStore(), {
          support: {
            repositoryPolicy: policy,
            privateNote: instance.staffSentinel,
          },
        });
        f.support.generate.mockClear();
        updateContext(f, {
          deployment: {
            generation: 8,
            hash: "deployment-build-8",
            deploymentEpoch: "epoch-build-8",
          },
          mapping: {
            fixedProduct: {
              productId: "workspace",
              version: "2.3.8",
              buildId: "build-8",
            },
          },
        });
        const key = await f.eligible();
        await f.prepareCandidate({ key });
        const newer = structuredClone(f.state.context!);
        updateContext(f, {
          deployment: {
            generation: 9,
            hash: "rollback-to-build-7",
            state: "rolled_back",
            deploymentEpoch: "epoch-rollback-9",
          },
          mapping: {
            fixedProduct: {
              productId: "workspace",
              version: "2.3.7",
              buildId: "build-7",
            },
          },
        });
        expect(example.input.rollbackConfirmed).toBe(true);
        expect((await f.observe()).outcome).toBe("held");
        const held = await f.work(key);
        expect(held).toMatchObject({
          status: "held",
          completionRows: 0,
          messageSlots: 0,
        });
        expect(
          Number(held.candidate?.customerDraft !== undefined) +
            Number(
              held.candidate?.kbProposal !== null &&
                held.candidate?.kbProposal !== undefined,
            ),
        ).toBe(example.expected.counts.held_draft);
        expect(
          (await f.head()).deploymentContexts[0]!.deploymentHead,
        ).toMatchObject({ generation: 9, state: "rolled_back" });
        f.state.context = newer;
        expect((await f.observe()).outcome).toBe("stale");
        expect(await f.work(key)).toEqual(held);
        expect(await works(f)).toHaveLength(1);
        expect(
          (await f.app.readCustomerTicket(customer, "ticket")).messages,
        ).toHaveLength(1);
        expect(f.support.generate).toHaveBeenCalledTimes(
          example.expected.modelCalls,
        );
      });
    }
  });
}
