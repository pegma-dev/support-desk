import { describe, expect, it } from "vitest";
import type {
  EngineeringFollowupContext,
  EngineeringFollowupKey,
} from "../packages/application/src/engineering-followup-types.js";
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

async function independentDeploymentContexts(f: Fixture, prepareFirst = false) {
  const contextA = structuredClone(f.state.context!);
  f.trust.setCurrent(f.proof());
  const keyA = await f.eligible();
  if (prepareFirst) await f.prepareCandidate({ key: keyA });
  const beforeB = await f.work(keyA);
  const contextB: EngineeringFollowupContext = {
    issueHead: contextA.issueHead,
    deploymentHead: {
      ...contextA.deploymentHead,
      contextRef: "independent-deployment-context-B",
      hash: "independent-context-B-head-1",
      deploymentEpoch: "independent-context-B-epoch-1",
    },
    mapping: {
      ...contextA.mapping!,
      semanticMappingId: "independent-context-B-semantic-fix",
      mappingId: "independent-context-B-mapping",
      deploymentId: "independent-context-B-deployment",
      scopeRef: "independent-context-B-scope",
      deploymentHeadHash: "independent-context-B-head-1",
    },
  };
  f.state.context = contextB;
  f.trust.setCurrent(f.proof());
  const keyB = await f.eligible();
  return { keyA, keyB, contextA, contextB, beforeB };
}

async function expectCurrent(f: Fixture, key: EngineeringFollowupKey) {
  const work = await f.work(key);
  expect(
    await f.app.confirmEngineeringFollowupCurrent(service, {
      ...key,
      workBindingHash: work.workBindingHash,
      expectedWorkGeneration: work.workGeneration,
    }),
  ).toBe(true);
}

function numberedDeploymentContext(
  original: EngineeringFollowupContext,
  number: number,
): EngineeringFollowupContext {
  const hash = `independent-context-${number}-deployment-head`;
  return {
    issueHead: original.issueHead,
    deploymentHead: {
      ...original.deploymentHead,
      contextRef: `independent-deployment-context-${number}`,
      hash,
      deploymentEpoch: `independent-deployment-epoch-${number}`,
    },
    mapping: {
      ...original.mapping!,
      semanticMappingId: `independent-semantic-mapping-${number}`,
      mappingId: `independent-mapping-${number}`,
      deploymentId: `independent-deployment-${number}`,
      scopeRef: `independent-deployment-scope-${number}`,
      deploymentHeadHash: hash,
    },
  };
}

async function eightCurrentContexts(f: Fixture) {
  const original = structuredClone(f.state.context!);
  const keys: EngineeringFollowupKey[] = [];
  for (let number = 1; number <= 8; number += 1) {
    f.state.context = numberedDeploymentContext(original, number);
    f.trust.setCurrent(f.proof());
    keys.push(await f.eligible());
  }
  return { keys, original };
}

for (const [name, createStore] of engineeringFollowupStores) {
  describe(`engineering follow-up observation ordering (${name})`, () => {
    it.each(["ordinary capacity", "full partition"] as const)(
      "coalesces repeated ninth-context hints without spending existing reservations at %s, while retaining genuine issue invalidation",
      async (capacity) => {
        const probe = await engineeringFollowupFixture(createStore(), {
          followup: { maxWorksets: 8 },
        });
        const probed = await eightCurrentContexts(probe);
        const count = (await probe.rows()).length;
        const f =
          capacity === "ordinary capacity"
            ? probe
            : await engineeringFollowupFixture(createStore(), {
                followup: { maxWorksets: 8 },
                support: { limits: { maxRecordsPerTicket: count + 2 + 8 * 5 } },
              });
        const { keys, original } =
          capacity === "ordinary capacity"
            ? probed
            : await eightCurrentContexts(f);
        const before = await Promise.all(keys.map((key) => f.work(key)));
        for (const work of before)
          expect(work).toMatchObject({
            status: "pending",
            completionRows: 5,
            messageSlots: 1,
          });
        expect(before.reduce((sum, work) => sum + work.completionRows, 0)).toBe(
          40,
        );
        expect(before.reduce((sum, work) => sum + work.messageSlots, 0)).toBe(
          8,
        );
        const head = await f.head();
        expect(head.associationHeads).toHaveLength(1);
        expect(head.deploymentContexts).toHaveLength(8);
        expect(head.workCount).toBe(8);
        const beforeRows = await f.rows();
        f.state.context = numberedDeploymentContext(original, 9);
        f.trust.setCurrent(f.proof());
        const observation = await f.observe().then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
        if ("error" in observation)
          expect(observation.error).toMatchObject({
            name: "SupportDeskLimitError",
          });
        else expect(observation.value.outcome).toBe("held");
        if (capacity === "full partition")
          expect(await f.rows()).toEqual(beforeRows);
        const afterFirstOverflow = await f.rows();
        expect([0, 2]).toContain(afterFirstOverflow.length - beforeRows.length);
        const headAfterFirstOverflow = await f.head();
        for (let delivery = 0; delivery < 3; delivery += 1) {
          f.state.context = numberedDeploymentContext(original, 1);
          f.advance(1);
          const trackedRefresh = f.proof();
          f.trust.setCurrent(trackedRefresh);
          const trackedInputReference = await f.issueInput(
            `tracked-context-A-refresh-between-overflows-${delivery}`,
            trackedRefresh,
          );
          expect(
            (await f.observe({ inputReference: trackedInputReference }))
              .outcome,
          ).toBe("unchanged");
          const afterTrackedRefresh = await f.rows();
          expect(afterTrackedRefresh).toHaveLength(afterFirstOverflow.length);
          expect(
            afterTrackedRefresh.filter(
              (row) => !afterFirstOverflow.some((old) => old.id === row.id),
            ),
          ).toEqual([]);
          if (capacity === "full partition")
            expect(afterTrackedRefresh).toEqual(beforeRows);
          const trackedHead = await f.head();
          expect(trackedHead.heldReason).toBe(
            headAfterFirstOverflow.heldReason,
          );
          expect(trackedHead.associationHeads).toEqual(
            headAfterFirstOverflow.associationHeads,
          );
          expect(trackedHead.deploymentContexts).toEqual(
            headAfterFirstOverflow.deploymentContexts,
          );
          expect(await Promise.all(keys.map((key) => f.work(key)))).toEqual(
            before,
          );
          for (const key of keys) await expectCurrent(f, key);

          f.state.context = numberedDeploymentContext(original, 9);
          f.advance(1);
          const refreshed = f.proof();
          f.trust.setCurrent(refreshed);
          const inputReference = await f.issueInput(
            `repeated-ninth-context-delivery-${delivery}`,
            refreshed,
          );
          const repeated = await f.observe({ inputReference }).then(
            (value) => ({ value }),
            (error: unknown) => ({ error }),
          );
          if ("error" in repeated)
            expect(repeated.error).toMatchObject({
              name: "SupportDeskLimitError",
            });
          else expect(["held", "unchanged"]).toContain(repeated.value.outcome);
          const rows = await f.rows();
          expect(rows).toHaveLength(afterFirstOverflow.length);
          expect(
            rows.filter(
              (row) => !afterFirstOverflow.some((old) => old.id === row.id),
            ),
          ).toEqual([]);
          if (capacity === "full partition") expect(rows).toEqual(beforeRows);
          const semanticHead = await f.head();
          expect(semanticHead.heldReason).toBe(
            headAfterFirstOverflow.heldReason,
          );
          expect(semanticHead.associationHeads).toEqual(
            headAfterFirstOverflow.associationHeads,
          );
          expect(semanticHead.deploymentContexts).toEqual(
            headAfterFirstOverflow.deploymentContexts,
          );
          expect(semanticHead.workCount).toBe(8);
        }
        expect(await Promise.all(keys.map((key) => f.work(key)))).toEqual(
          before,
        );
        expect(await works(f)).toHaveLength(8);
        const retainedHead = await f.head();
        expect(retainedHead.associationHeads).toEqual(head.associationHeads);
        expect(retainedHead.deploymentContexts).toEqual(
          head.deploymentContexts,
        );
        expect(retainedHead.workCount).toBe(8);
        for (const key of keys) await expectCurrent(f, key);

        const changedIssue = {
          ...original.issueHead,
          generation: original.issueHead.generation + 1,
          hash: "shared-issue-reopened-during-overflow",
          state: "open" as const,
        };
        updateContext(f, { issue: changedIssue });
        f.trust.setCurrent(f.proof());
        for (let number = 1; number <= 8; number += 1) {
          const context = numberedDeploymentContext(original, number);
          f.trust.setCurrent(
            f.proof({
              context: {
                ...context,
                issueHead: changedIssue,
                mapping: {
                  ...context.mapping!,
                  issueHeadHash: changedIssue.hash,
                },
              },
            }),
          );
        }
        expect((await f.observe()).outcome).toBe("held");
        const held = await Promise.all(keys.map((key) => f.work(key)));
        for (const work of held)
          expect(work).toMatchObject({
            status: "held",
            completionRows: 0,
            messageSlots: 0,
          });
        const afterIssueChange = await f.rows();
        const headAfterIssueChange = await f.head();
        for (let delivery = 0; delivery < 3; delivery += 1) {
          f.advance(1);
          const refreshed = f.proof();
          f.trust.setCurrent(refreshed);
          const inputReference = await f.issueInput(
            `repeated-reopened-issue-at-overflow-${delivery}`,
            refreshed,
          );
          expect(["held", "unchanged"]).toContain(
            (await f.observe({ inputReference })).outcome,
          );
          const rows = await f.rows();
          expect(rows).toHaveLength(afterIssueChange.length);
          expect(
            rows.filter(
              (row) => !afterIssueChange.some((old) => old.id === row.id),
            ),
          ).toEqual([]);
          expect(await Promise.all(keys.map((key) => f.work(key)))).toEqual(
            held,
          );
          const semanticHead = await f.head();
          expect(semanticHead.associationHeads).toEqual(
            headAfterIssueChange.associationHeads,
          );
          expect(semanticHead.deploymentContexts).toEqual(
            headAfterIssueChange.deploymentContexts,
          );
          expect(semanticHead.workCount).toBe(8);
        }
        expect(f.support.generate).toHaveBeenCalledOnce();
        expect(f.support.createIssue).toHaveBeenCalledOnce();
      },
    );

    it("keeps a private candidate and its reservation current when another deployment context for the same issue is observed", async () => {
      const f = await engineeringFollowupFixture(createStore());
      const { keyA, keyB, contextA, contextB, beforeB } =
        await independentDeploymentContexts(f, true);
      expect(keyA.workId).not.toBe(keyB.workId);
      expect(beforeB).toMatchObject({
        status: "candidate",
        completionRows: 5,
        messageSlots: 1,
      });
      expect((await f.work(keyB)).association).toEqual(beforeB.association);
      expect(await f.work(keyA)).toEqual(beforeB);
      await expectCurrent(f, keyA);
      await expectCurrent(f, keyB);
      const current = await f.app.readEngineeringFollowupReassessment(
        staff,
        keyA,
      );
      expect(current.proof.context).toEqual(contextA);
      expect(current.work).toEqual(beforeB);
      const head = await f.head();
      expect(head.associationHeads).toHaveLength(1);
      expect(
        head.deploymentContexts.map((entry) => entry.deploymentHead.contextRef),
      ).toEqual(
        expect.arrayContaining([
          contextA.deploymentHead.contextRef,
          contextB.deploymentHead.contextRef,
        ]),
      );
      expect(head.workCount).toBe(2);
    });

    it.each(["rollback", "deployment change", "mapping change"] as const)(
      "holds only context B after its %s while context A remains independently current",
      async (change) => {
        const f = await engineeringFollowupFixture(createStore());
        const { keyA, keyB, contextA, beforeB } =
          await independentDeploymentContexts(f, true);
        expect(await f.work(keyA)).toEqual(beforeB);
        if (change === "mapping change")
          updateContext(f, {
            mapping: {
              semanticMappingId: "context-B-new-semantic-mapping",
              mappingId: "context-B-new-mapping-attestation",
              mappingVersion: "mapping-v2",
            },
          });
        else
          updateContext(f, {
            deployment: {
              generation: 2,
              hash: "context-B-new-deployment-head",
              deploymentEpoch: "context-B-new-deployment-epoch",
              state: change === "rollback" ? "rolled_back" : "deployed",
            },
          });
        f.trust.setCurrent(f.proof());
        const observed = await f.observe();
        expect(observed.outcome).toBe(
          change === "rollback" ? "held" : "queued",
        );
        expect(await f.work(keyB)).toMatchObject({
          status: "held",
          completionRows: 0,
          messageSlots: 0,
        });
        expect(await f.work(keyA)).toEqual(beforeB);
        await expectCurrent(f, keyA);
        expect(
          (await f.app.readEngineeringFollowupReassessment(staff, keyA)).proof
            .context,
        ).toEqual(contextA);
      },
    );

    it("confines a trusted failed retest to its deployment context on the same issue", async () => {
      const f = await engineeringFollowupFixture(createStore());
      const { keyA, keyB, beforeB } = await independentDeploymentContexts(
        f,
        true,
      );
      expect(await f.work(keyA)).toEqual(beforeB);
      const prepared = await f.prepareBundle({ key: keyB });
      const binding = await f.retestBinding(keyB);
      const receiptReference = f.trust.issueRetest(
        "context-B-failed-retest",
        binding,
        "failed",
      );
      expect(
        await f.app.submitEngineeringFollowupRetestResult(service, {
          ...f.command("record-context-B-failed-retest"),
          ...keyB,
          retestRequestId: prepared.bundle.retestRequests[0]!.requestId,
          receiptReference,
        }),
      ).toMatchObject({ outcome: "held", result: "failed" });
      expect(await f.work(keyB)).toMatchObject({
        status: "held",
        completionRows: 0,
        messageSlots: 0,
      });
      expect(await f.work(keyA)).toEqual(beforeB);
      await expectCurrent(f, keyA);
    });

    it.each(["reopened", "new closed issue head"] as const)(
      "holds both deployment contexts when their shared issue has a %s observation",
      async (change) => {
        const f = await engineeringFollowupFixture(createStore());
        const { keyA, keyB, contextA, beforeB } =
          await independentDeploymentContexts(f);
        expect(await f.work(keyA)).toEqual(beforeB);
        const issueHead = {
          ...contextA.issueHead,
          generation: 2,
          hash: "shared-issue-head-2",
          state:
            change === "reopened" ? ("open" as const) : ("closed" as const),
        };
        updateContext(f, { issue: issueHead });
        f.trust.setCurrent(f.proof());
        f.trust.setCurrent(
          f.proof({
            context: {
              ...contextA,
              issueHead,
              mapping: { ...contextA.mapping!, issueHeadHash: issueHead.hash },
            },
          }),
        );
        expect((await f.observe()).outcome).toBe("held");
        for (const key of [keyA, keyB])
          expect(await f.work(key)).toMatchObject({
            status: "held",
            completionRows: 0,
            messageSlots: 0,
          });
      },
    );

    it("spends only context B's prepaid donor at capacity while preserving context A's funded tail", async () => {
      const probe = await engineeringFollowupFixture(createStore());
      await independentDeploymentContexts(probe);
      const count = (await probe.rows()).length;
      const f = await engineeringFollowupFixture(createStore(), {
        support: { limits: { maxRecordsPerTicket: count + 2 + 5 + 5 } },
      });
      const { keyA, keyB, beforeB } = await independentDeploymentContexts(f);
      expect(await f.work(keyA)).toEqual(beforeB);
      expect(beforeB).toMatchObject({
        status: "pending",
        completionRows: 5,
        messageSlots: 1,
      });
      const before = await f.rows();
      updateContext(f, {
        deployment: {
          generation: 2,
          hash: "context-B-rollback-at-capacity",
          state: "rolled_back",
        },
      });
      f.trust.setCurrent(f.proof());
      expect((await f.observe()).outcome).toBe("held");
      const after = await f.rows();
      expect(after).toHaveLength(before.length + 2);
      expect(
        after
          .filter((row) => !before.some((old) => old.id === row.id))
          .map((row) => row.kind)
          .sort(),
      ).toEqual(["audit", "engineering_followup_receipt"]);
      expect(await f.work(keyB)).toMatchObject({
        status: "held",
        completionRows: 0,
        messageSlots: 0,
      });
      expect(await f.work(keyA)).toEqual(beforeB);
      await expectCurrent(f, keyA);
    });

    it("cannot borrow context A's reservation for an unfunded negative observation of context B", async () => {
      const probe = await engineeringFollowupFixture(createStore());
      await independentDeploymentContexts(probe);
      const count = (await probe.rows()).length;
      const f = await engineeringFollowupFixture(createStore(), {
        support: { limits: { maxRecordsPerTicket: count + 2 + 5 + 5 } },
      });
      const { keyA, keyB, beforeB } = await independentDeploymentContexts(f);
      expect(await f.work(keyA)).toEqual(beforeB);
      const prepared = await f.prepareBundle({ key: keyB });
      await f.app.rejectEngineeringFollowupBundle(staff, {
        ...f.command("release-only-context-B-tail"),
        ...keyB,
        expectedWorkGeneration: prepared.work.workGeneration,
        bundleHash: prepared.work.preparedBundle!.bundleHash,
        reason: "Context B's private bundle was rejected.",
      });
      const before = await f.rows();
      expect(before).toHaveLength(count + 4);
      expect(await f.work(keyB)).toMatchObject({
        status: "held",
        completionRows: 0,
        messageSlots: 0,
      });
      updateContext(f, {
        deployment: {
          generation: 2,
          hash: "context-B-unfunded-rollback",
          state: "rolled_back",
        },
      });
      f.trust.setCurrent(f.proof());
      await expect(f.observe()).rejects.toMatchObject({
        name: "SupportDeskLimitError",
        field: "ticket_partition",
      });
      expect(await f.rows()).toEqual(before);
      expect(await f.work(keyA)).toEqual(beforeB);
      await expectCurrent(f, keyA);
    });

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
