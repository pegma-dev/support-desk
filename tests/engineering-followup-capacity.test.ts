import {
  engineeringFollowupModelAttemptCount,
  supportPermissions,
  supportRecords,
  type EngineeringFollowupCandidate,
  type EngineeringFollowupKey,
  type EngineeringProcessing,
  type SupportRecord,
} from "@pegma/support-desk-application";
import { describe, expect, it } from "vitest";
import {
  engineeringFollowupCustomer as customer,
  engineeringFollowupFixture,
  engineeringFollowupService as service,
  engineeringFollowupStaff as staff,
  engineeringFollowupStores,
} from "../test/engineering-followup-fixtures.js";

type Fixture = Awaited<ReturnType<typeof engineeringFollowupFixture>>;
const managed = {
  managed: true,
  assistantTurns: {},
  resolutionLearning: { enabled: true },
};

function maximumCandidate(f: Fixture): EngineeringFollowupCandidate {
  const candidate = f.candidate({
    customerDraft: { body: "c".repeat(4_000) },
    kbProposal: {
      summary: "s".repeat(2_000),
      changes: ["d".repeat(1_000), "x"],
      advisoryValidationRequirements: [],
    },
    retestRequests: [],
  });
  const kb = candidate.kbProposal;
  if (kb === null) throw new Error("Expected the bounded private KB proposal");
  const extra = (16_000 - JSON.stringify(candidate).length * 2) / 2;
  if (!Number.isInteger(extra) || extra < 0 || extra >= 1_000)
    throw new Error(
      "Maximum candidate padding must remain a legal advisory change",
    );
  const maximum = {
    ...candidate,
    kbProposal: { ...kb, changes: [kb.changes[0]!, "x".repeat(extra + 1)] },
  };
  expect(JSON.stringify(maximum).length * 2).toBe(16_000);
  return maximum;
}

function assertPhysicalRecords(rows: readonly SupportRecord[]): void {
  for (const row of rows) {
    if (
      row.kind !== "engineering_followup_head" &&
      row.kind !== "engineering_followup_work" &&
      row.kind !== "engineering_followup_receipt"
    )
      continue;
    const encoded = supportRecords.codec.encode(row);
    expect(supportRecords.codec.decode(encoded)).toEqual(row);
    expect(JSON.stringify(encoded).length * 2).toBeLessThanOrEqual(60_000);
  }
}

function maximumProcessing(): EngineeringProcessing {
  const escaped = "\ud800".repeat(200);
  return {
    provider: escaped,
    model: escaped,
    requestId: escaped,
    failureCategory: escaped,
    currency: escaped,
    inputTokens: Number.MAX_SAFE_INTEGER,
    outputTokens: Number.MAX_SAFE_INTEGER,
    costMicros: Number.MAX_SAFE_INTEGER,
  };
}

async function nextRelease(
  f: Fixture,
  generation: number,
): Promise<EngineeringFollowupKey> {
  const context = f.state.context;
  if (context === undefined || context.mapping === undefined)
    throw new Error("Expected the verified deployed context and mapping");
  f.state.context = {
    ...context,
    deploymentHead: {
      ...context.deploymentHead,
      generation,
      hash: `deployed-build-hash-${generation}`,
      deploymentEpoch: `deployment-epoch-${generation}`,
    },
    mapping: {
      ...context.mapping,
      deploymentHeadHash: `deployed-build-hash-${generation}`,
    },
  };
  const observed = await f.observe();
  if (observed.workId === undefined)
    throw new Error(`Expected an actual work ID: ${JSON.stringify(observed)}`);
  return { ticketId: observed.ticketId, workId: observed.workId };
}

async function retainUnknownParentDispatch(f: Fixture) {
  const { key } = await f.refreshEvidence();
  const command = {
    ...key,
    workerId: "independent-unknown-parent-worker",
    leaseMilliseconds: 30_000,
  };
  await f.support.engineering.processWork(command);
  await f.support.engineering.processWork(command);
  const proposal = await f.support.app.readEngineeringWork(staff, key);
  if (proposal.proposal === undefined)
    throw new Error("Expected the real second engineering proposal");
  await f.support.engineering.reviewProposal(staff, {
    ...f.command("approve-independent-parent-dispatch"),
    ...key,
    expectedWorkGeneration: proposal.workGeneration,
    proposalHash: proposal.proposal.proposalHash,
    decision: "approve",
  });
  f.support.setGitHubCreate(async () => {
    throw new Error(
      "Independent parent dispatch acknowledgement remains unknown",
    );
  });
  await f.support.engineering.processWork(command);
  expect(await f.support.app.readEngineeringWork(staff, key)).toMatchObject({
    status: "unknown",
    terminalReserveRows: 2,
  });
  return key;
}

async function twoAssociatedChildren(f: Fixture) {
  const firstAssociation = await f.association();
  await f.refreshEvidence();
  await f.linkExisting({
    repositoryId: firstAssociation.repositoryId,
    issueId: "independent-followup-issue-2",
    issueNumber: 2,
  });
  const secondAssociation = await f.association();
  const firstProof = f.proof();
  f.trust.setCurrent(firstProof);
  const first = await f.observe({
    association: {
      repositoryId: firstAssociation.repositoryId,
      issueId: firstAssociation.issueId,
    },
    inputReference: await f.issueInput(
      "first-independent-associated-release",
      firstProof,
      { association: firstAssociation },
    ),
  });
  const context = f.state.context;
  if (context === undefined || context.mapping === undefined)
    throw new Error("Expected the first verified issue mapping");
  f.state.context = {
    ...context,
    issueHead: {
      ...context.issueHead,
      repositoryId: secondAssociation.repositoryId,
      issueId: secondAssociation.issueId,
      issueNumber: secondAssociation.issueNumber,
      hash: "independent-issue-2-head",
    },
    mapping: {
      ...context.mapping,
      issueHeadHash: "independent-issue-2-head",
    },
  };
  const secondProof = f.proof();
  f.trust.setCurrent(secondProof);
  const second = await f.observe();
  if (first.workId === undefined || second.workId === undefined)
    throw new Error("Expected both actual associated follow-up worksets");
  const keys = [
    { ticketId: first.ticketId, workId: first.workId },
    { ticketId: second.ticketId, workId: second.workId },
  ] as const;
  expect(await f.work(keys[0])).toMatchObject({
    completionRows: 5,
    messageSlots: 1,
  });
  expect(await f.work(keys[1])).toMatchObject({
    completionRows: 5,
    messageSlots: 1,
  });
  return {
    keys,
    associations: [firstAssociation, secondAssociation] as const,
    proofs: [firstProof, secondProof] as const,
  };
}

for (const [name, createStore] of engineeringFollowupStores) {
  describe(`release follow-up physical capacity (${name})`, () => {
    it.each(["rows", "message slot"] as const)(
      "readmits all five reserved rows and one message slot on staff retry (%s)",
      async (bound) => {
        const probe = await engineeringFollowupFixture(createStore(), {
          support: managed,
        });
        await probe.eligible();
        const count = (await probe.rows()).length;
        const messages = (await probe.rows()).filter(
          (row) => row.kind === "message",
        ).length;
        const maximumRows = bound === "rows" ? count + 13 + 2 + 2 + 5 : 512;
        const maximumMessages =
          bound === "message slot" ? messages + 1 + 1 : 100;
        const f = await engineeringFollowupFixture(createStore(), {
          support: {
            ...managed,
            limits: {
              maxRecordsPerTicket: maximumRows,
              maxMessagesPerTicket: maximumMessages,
            },
          },
        });
        await f.eligible();
        const owner = await f.claim();
        await f.app.finishEngineeringFollowupModel(service, {
          ...owner.fence,
          disposition: "held",
          reason: "temporary_provider_failure",
        });
        if (bound === "message slot")
          await f.app.addNote(staff, {
            ...f.command("consume-released-local-message-slot"),
            messageId: "private-note-before-explicit-retry",
            body: "Ordinary private support consumed the released slot.",
          });
        const held = await f.work();
        expect(held).toMatchObject({
          status: "held",
          completionRows: 0,
          messageSlots: 0,
        });
        const command = {
          ...f.command(`retry-with-complete-readmission-${bound}`),
          ...f.key,
          expectedWorkGeneration: held.workGeneration,
        };
        const before = await f.rows();
        await expect(
          f.app.retryEngineeringFollowupWork(staff, command),
        ).rejects.toMatchObject({
          name: "SupportDeskLimitError",
          field: bound === "rows" ? "ticket_partition" : "ticket_messages",
        });
        expect(await f.rows()).toEqual(before);
        const admitted = f.support.freshApplication({
          limits: {
            maxRecordsPerTicket: maximumRows + (bound === "rows" ? 2 : 0),
            maxMessagesPerTicket:
              maximumMessages + (bound === "message slot" ? 1 : 0),
          },
        });
        await admitted.retryEngineeringFollowupWork(staff, command);
        expect(await f.rows()).toHaveLength(before.length + 2);
        expect(await f.work()).toMatchObject({
          workId: held.workId,
          status: "pending",
          completionRows: 5,
          messageSlots: 1,
        });
        expect(engineeringFollowupModelAttemptCount(await f.work())).toBe(0);
        expect((await f.head()).workCount).toBe(1);
        assertPhysicalRecords(await f.rows());
      },
    );

    it("abandons expired draftless work from its own prepaid pair at full capacity without spending another child or privacy reserve", async () => {
      const probe = await engineeringFollowupFixture(createStore(), {
        support: managed,
      });
      await twoAssociatedChildren(probe);
      const count = (await probe.rows()).length;
      const messages = (await probe.rows()).filter(
        (row) => row.kind === "message",
      ).length;
      const f = await engineeringFollowupFixture(createStore(), {
        support: {
          ...managed,
          limits: {
            maxRecordsPerTicket: count + 13 + 2 + 2 + 5 + 5,
            maxMessagesPerTicket: messages + 1 + 1 + 1,
          },
        },
      });
      const { keys } = await twoAssociatedChildren(f);
      const own = await f.work(keys[0]);
      const other = await f.work(keys[1]);
      f.advance(Date.parse(own.deadline) - Date.parse(f.clock.now()) + 1);
      expect(Date.parse(f.clock.now())).toBeGreaterThan(
        Date.parse(own.deadline),
      );
      f.state.inputOutcome = "unavailable";
      f.state.currentOutcome = "unavailable";
      f.state.checksOutcome = "unavailable";
      f.state.retestOutcome = "unavailable";
      const offline = f.support.freshApplication({
        engineeringFollowup: { enabled: false },
      });
      const access = {
        ...staff,
        permissions: [
          supportPermissions.engineeringFollowupReview,
          supportPermissions.queueRead,
        ],
      };
      const before = await f.rows();
      const source = await f.support.source();
      const confirmations = f.confirm.mock.calls.length;
      await offline.abandonEngineeringFollowupWork(access, {
        ...f.command("abandon-expired-prepaid-draftless-work"),
        ...keys[0],
        expectedWorkGeneration: own.workGeneration,
        reason: "Staff abandoned an expired draftless operation locally.",
      });
      expect(await f.rows()).toHaveLength(before.length + 2);
      expect(f.confirm.mock.calls.length).toBe(confirmations);
      expect(await f.work(keys[0])).toMatchObject({
        status: "held",
        completionRows: 0,
        messageSlots: 0,
      });
      expect((await f.work(keys[0])).withdrawn).toBeUndefined();
      expect(await f.work(keys[1])).toEqual(other);
      expect(await f.support.source()).toEqual(source);
      await f.app.addNote(staff, {
        ...f.command("ordinary-uses-only-abandoned-unused-three-rows"),
        messageId: "private-note-after-local-abandonment",
        body: "The abandoned work released only its own unused tail.",
      });
      const afterOwnCredit = await f.rows();
      await expect(
        f.app.addNote(staff, {
          ...f.command("ordinary-cannot-spend-unrelated-reserves"),
          messageId: "forbidden-second-note-after-local-abandonment",
          body: "Other prepaid work and human privacy remain protected.",
        }),
      ).rejects.toThrow();
      expect(await f.rows()).toEqual(afterOwnCredit);
      await f.app.withdrawResolutionLearningSource(staff, {
        ...f.command("independent-learning-privacy-after-local-abandonment"),
        reason: "privacy_withdrawal",
      });
      expect(await f.work(keys[1])).toEqual(other);
      await f.app.withdrawEngineeringSource(staff, {
        ...f.command("parent-privacy-after-local-abandonment"),
        reason: "privacy_withdrawal",
      });
      expect((await f.work(keys[1])).withdrawn).toBe(true);
      expect(await f.rows()).toHaveLength(before.length + 9);
      assertPhysicalRecords(await f.rows());
    });

    it.each(["rows", "message slots"] as const)(
      "requires five future rows and one message slot before any paid request (%s)",
      async (bound) => {
        const probe = await engineeringFollowupFixture(createStore(), {
          support: managed,
        });
        await probe.eligible();
        const queuedRows = (await probe.rows()).length;
        const messages = (await probe.rows()).filter(
          (row) => row.kind === "message",
        ).length;
        for (const deficit of [1, 0]) {
          const f = await engineeringFollowupFixture(createStore(), {
            support: {
              ...managed,
              limits: {
                maxRecordsPerTicket:
                  queuedRows +
                  13 +
                  2 +
                  2 +
                  5 -
                  (bound === "rows" ? deficit : 0),
                maxMessagesPerTicket:
                  messages + 1 + 1 - (bound === "message slots" ? deficit : 0),
              },
            },
          });
          const before = await f.rows();
          if (deficit === 1) {
            await expect(f.eligible()).rejects.toMatchObject({
              name: "SupportDeskLimitError",
              field: bound === "rows" ? "ticket_partition" : "ticket_messages",
            });
            expect(await f.rows()).toEqual(before);
            expect(
              (await f.rows()).some(
                (row) => row.kind === "engineering_followup_work",
              ),
            ).toBe(false);
          } else {
            await f.eligible();
            expect(await f.rows()).toHaveLength(queuedRows);
            expect(await f.work()).toMatchObject({
              completionRows: 5,
              messageSlots: 1,
              modelAttempts: [],
            });
            await expect(
              f.app.addNote(staff, {
                ...f.command("ordinary-cannot-spend-followup-tail"),
                messageId: "ordinary-at-followup-boundary",
                body: "An ordinary note cannot consume prepaid follow-up or human privacy capacity.",
              }),
            ).rejects.toThrow();
          }
          expect(f.modelCommands).toEqual([]);
          assertPhysicalRecords(await f.rows());
        }
      },
    );

    it("projects the remaining three rows after preparation and spends only those rows for the atomic notice", async () => {
      const probe = await engineeringFollowupFixture(createStore(), {
        support: managed,
      });
      await probe.eligible();
      const queuedRows = (await probe.rows()).length;
      const f = await engineeringFollowupFixture(createStore(), {
        support: {
          ...managed,
          limits: { maxRecordsPerTicket: queuedRows + 13 + 2 + 2 + 5 },
        },
      });
      await f.eligible();
      const before = await f.rows();
      const prepared = await f.prepareBundle();
      expect(await f.rows()).toHaveLength(before.length + 2);
      expect(prepared.work).toMatchObject({
        completionRows: 3,
        messageSlots: 1,
      });
      await expect(
        f.app.addNote(staff, {
          ...f.command("ordinary-cannot-spend-three-row-post-tail"),
          messageId: "ordinary-before-atomic-notice",
          body: "The checked notice still owns its exact three future rows.",
        }),
      ).rejects.toMatchObject({
        name: "SupportDeskLimitError",
        field: "ticket_partition",
      });
      await f.post();
      const posted = await f.rows();
      expect(posted).toHaveLength(before.length + 5);
      expect(await f.work()).toMatchObject({
        status: "delivered",
        completionRows: 0,
        messageSlots: 0,
      });
      const beforeWithdrawals = posted.length;
      await f.app.withdrawEngineeringSource(staff, {
        ...f.command("engineering-privacy-after-notice"),
        reason: "privacy_withdrawal",
      });
      await f.app.withdrawResolutionLearningSource(staff, {
        ...f.command("learning-privacy-after-notice"),
        reason: "privacy_withdrawal",
      });
      expect(await f.rows()).toHaveLength(beforeWithdrawals + 4);
      expect(
        (await f.rows()).filter(
          (row) =>
            row.kind === "message" &&
            row.message.authorKind === "staff" &&
            row.message.visibility === "customer",
        ),
      ).toHaveLength(1);
      assertPhysicalRecords(await f.rows());
    });

    it("preserves another engineering operation's prepaid terminal pair through preparation, posting and parent withdrawal", async () => {
      const probe = await engineeringFollowupFixture(createStore(), {
        support: managed,
      });
      await retainUnknownParentDispatch(probe);
      await probe.eligible();
      const count = (await probe.rows()).length;
      const f = await engineeringFollowupFixture(createStore(), {
        support: {
          ...managed,
          limits: { maxRecordsPerTicket: count + 13 + 2 + 2 + 2 + 5 },
        },
      });
      const parentKey = await retainUnknownParentDispatch(f);
      await f.eligible();
      expect(await f.rows()).toHaveLength(count);
      const before = await f.rows();
      await f.prepareBundle();
      expect(await f.rows()).toHaveLength(before.length + 2);
      expect(
        await f.support.app.readEngineeringWork(staff, parentKey),
      ).toMatchObject({ status: "unknown", terminalReserveRows: 2 });
      await expect(
        f.app.addNote(staff, {
          ...f.command("ordinary-cannot-spend-other-parent-tail"),
          messageId: "ordinary-between-bundle-and-post",
          body: "Another physical dispatch still owns its separate terminal pair.",
        }),
      ).rejects.toMatchObject({
        name: "SupportDeskLimitError",
        field: "ticket_partition",
      });
      await f.post();
      expect(await f.rows()).toHaveLength(before.length + 5);
      expect(await f.work()).toMatchObject({
        status: "delivered",
        completionRows: 0,
        messageSlots: 0,
      });
      expect(
        await f.support.app.readEngineeringWork(staff, parentKey),
      ).toMatchObject({ status: "unknown", terminalReserveRows: 2 });
      await f.app.withdrawEngineeringSource(staff, {
        ...f.command("privacy-does-not-free-unknown-parent"),
        reason: "privacy_withdrawal",
      });
      const parent = await f.support.app.readEngineeringWork(staff, parentKey);
      expect(parent.terminalReserveRows).toBe(2);
      expect(parent.dispatch).toBeDefined();
      await f.app.withdrawResolutionLearningSource(staff, {
        ...f.command("independent-learning-after-unknown-parent"),
        reason: "privacy_withdrawal",
      });
      expect(await f.rows()).toHaveLength(before.length + 9);
      assertPhysicalRecords(await f.rows());
    });

    it("releases the invalidated child slot before admitting a relevant human conversation message", async () => {
      const probe = await engineeringFollowupFixture(createStore(), {
        support: managed,
      });
      await probe.eligible();
      const rows = await probe.rows();
      const messageCount = rows.filter((row) => row.kind === "message").length;
      const f = await engineeringFollowupFixture(createStore(), {
        support: {
          ...managed,
          limits: {
            maxRecordsPerTicket: rows.length + 13 + 2 + 2 + 5,
            maxMessagesPerTicket: messageCount + 1 + 1,
          },
        },
      });
      await f.eligible();
      const before = await f.rows();
      await f.app.replyToCustomerTicket(customer, {
        ...f.command("human-invalidates-followup-before-admission"),
        messageId: "customer-at-followup-slot-boundary",
        body: "My current workspace now needs a different investigation.",
      });
      expect(await f.work()).toMatchObject({
        completionRows: 0,
        messageSlots: 0,
      });
      expect((await f.work()).delivered).toBeUndefined();
      expect(
        (await f.rows()).filter((row) => row.kind === "message"),
      ).toHaveLength(messageCount + 1);
      expect((await f.rows()).length).toBeGreaterThan(before.length);
      const ticket = (await f.app.readStaffTicket(staff, "ticket")).ticket;
      expect(ticket.firstStaffRespondedAt).toBeUndefined();
      await f.app.withdrawEngineeringSource(staff, {
        ...f.command("engineering-withdraw-after-reply"),
        reason: "privacy_withdrawal",
      });
      await f.app.withdrawResolutionLearningSource(staff, {
        ...f.command("learning-withdraw-after-reply"),
        reason: "privacy_withdrawal",
      });
      assertPhysicalRecords(await f.rows());
    });

    it("funds a negative observation with exactly two prepaid donor rows at the full partition boundary", async () => {
      const probe = await engineeringFollowupFixture(createStore());
      await probe.eligible();
      const count = (await probe.rows()).length;
      const f = await engineeringFollowupFixture(createStore(), {
        support: { limits: { maxRecordsPerTicket: count + 2 + 5 } },
      });
      await f.eligible();
      const before = await f.rows();
      const old = f.state.context;
      if (old === undefined)
        throw new Error("Expected the current deployed issue context");
      f.state.context = {
        issueHead: {
          ...old.issueHead,
          generation: old.issueHead.generation + 1,
          hash: "reopened-current-issue-head",
          state: "open",
        },
        deploymentHead: old.deploymentHead,
      };
      const result = await f.observe();
      expect(result.outcome).toBe("held");
      expect(await f.rows()).toHaveLength(before.length + 2);
      expect(await f.work()).toMatchObject({
        status: "held",
        completionRows: 0,
        messageSlots: 0,
      });
      const added = (await f.rows()).filter(
        (row) => !before.some((prior) => prior.id === row.id),
      );
      expect(added.map((row) => row.kind).sort()).toEqual([
        "audit",
        "engineering_followup_receipt",
      ]);
      expect(f.modelCommands).toEqual([]);
      assertPhysicalRecords(await f.rows());
    });

    it("does not invent a donor when a negative observation has no remaining prepaid tail", async () => {
      const probe = await engineeringFollowupFixture(createStore());
      await probe.eligible();
      const count = (await probe.rows()).length;
      const f = await engineeringFollowupFixture(createStore(), {
        support: { limits: { maxRecordsPerTicket: count + 2 + 5 } },
      });
      await f.eligible();
      const prepared = await f.prepareBundle();
      await f.app.rejectEngineeringFollowupBundle(staff, {
        ...f.command("spend-and-release-own-tail"),
        ...f.key,
        expectedWorkGeneration: prepared.work.workGeneration,
        bundleHash: prepared.work.preparedBundle!.bundleHash,
        reason: "The exact bundle was rejected privately.",
      });
      const before = await f.rows();
      expect(before).toHaveLength(count + 4);
      const old = f.state.context;
      if (old === undefined)
        throw new Error("Expected the current deployed issue context");
      f.state.context = {
        issueHead: {
          ...old.issueHead,
          generation: old.issueHead.generation + 1,
          hash: "reopened-with-no-payable-tail",
          state: "open",
        },
        deploymentHead: old.deploymentHead,
      };
      await expect(f.observe()).rejects.toMatchObject({
        name: "SupportDeskLimitError",
        field: "ticket_partition",
      });
      expect(await f.rows()).toEqual(before);
      expect(await f.work()).toMatchObject({
        status: "held",
        completionRows: 0,
        messageSlots: 0,
      });
      await expect(
        f.prepareBundle({ mode: "staff_reassessment" }),
      ).rejects.toThrow();
      expect(await f.rows()).toEqual(before);
      assertPhysicalRecords(before);
    });

    it("keeps an unrelated child's tail while spending exactly one affected donor for a negative observation", async () => {
      const probe = await engineeringFollowupFixture(createStore());
      await twoAssociatedChildren(probe);
      const count = (await probe.rows()).length;
      const f = await engineeringFollowupFixture(createStore(), {
        support: { limits: { maxRecordsPerTicket: count + 2 + 5 + 5 } },
      });
      const { keys, associations, proofs } = await twoAssociatedChildren(f);
      const unrelated = await f.work(keys[1]);
      const before = await f.rows();
      const negative = {
        ...proofs[0],
        context: {
          issueHead: {
            ...proofs[0].context.issueHead,
            generation: 2,
            hash: "first-issue-reopened",
            state: "open" as const,
          },
          deploymentHead: proofs[0].context.deploymentHead,
        },
      };
      f.trust.setCurrent(negative);
      const inputReference = await f.issueInput(
        "negative-one-associated-issue",
        negative,
        { association: associations[0] },
      );
      await f.observe({
        association: {
          repositoryId: associations[0].repositoryId,
          issueId: associations[0].issueId,
        },
        inputReference,
      });
      expect(await f.rows()).toHaveLength(before.length + 2);
      expect(await f.work(keys[0])).toMatchObject({
        status: "held",
        completionRows: 0,
        messageSlots: 0,
      });
      expect(await f.work(keys[1])).toEqual(unrelated);
      const prepared = await f.prepareBundle({ key: keys[1] });
      expect(prepared.work).toMatchObject({
        completionRows: 3,
        messageSlots: 1,
      });
      assertPhysicalRecords(await f.rows());
    });

    it("does not borrow an unaffected bundle's tail and still blocks stale sending after an unfunded negative observation", async () => {
      const probe = await engineeringFollowupFixture(createStore());
      await twoAssociatedChildren(probe);
      const count = (await probe.rows()).length;
      const f = await engineeringFollowupFixture(createStore(), {
        support: { limits: { maxRecordsPerTicket: count + 2 + 5 + 5 } },
      });
      const { keys, associations, proofs } = await twoAssociatedChildren(f);
      const first = await f.prepareBundle({ key: keys[0] });
      await f.app.rejectEngineeringFollowupBundle(staff, {
        ...f.command("release-first-association-tail"),
        ...keys[0],
        expectedWorkGeneration: first.work.workGeneration,
        bundleHash: first.work.preparedBundle!.bundleHash,
        reason: "This first private bundle will not be sent.",
      });
      await f.prepareBundle({ key: keys[1] });
      const before = await f.rows();
      expect(before).toHaveLength(count + 6);
      const second = await f.work(keys[1]);
      expect(second).toMatchObject({
        status: "bundle_prepared",
        completionRows: 3,
        messageSlots: 1,
      });
      const negatives = proofs.map((proof) => ({
        ...proof,
        context: {
          issueHead: proof.context.issueHead,
          deploymentHead: {
            ...proof.context.deploymentHead,
            generation: 2,
            hash: "newer-rolled-back-deployment",
            state: "rolled_back" as const,
          },
        },
      }));
      for (const proof of negatives) f.trust.setCurrent(proof);
      const inputReference = await f.issueInput(
        "negative-without-own-donor",
        negatives[0]!,
        { association: associations[0] },
      );
      await expect(
        f.observe({
          association: {
            repositoryId: associations[0].repositoryId,
            issueId: associations[0].issueId,
          },
          inputReference,
        }),
      ).rejects.toMatchObject({
        name: "SupportDeskLimitError",
        field: "ticket_partition",
      });
      expect(await f.rows()).toEqual(before);
      expect(await f.work(keys[1])).toEqual(second);
      const messages = before.filter((row) => row.kind === "message");
      await expect(
        f.post({
          key: keys[1],
          messageId: "must-not-send-from-stale-stored-head",
        }),
      ).rejects.toThrow();
      expect(await f.rows()).toEqual(before);
      expect((await f.rows()).filter((row) => row.kind === "message")).toEqual(
        messages,
      );
      expect((await f.work(keys[1])).delivered).toBeUndefined();
      assertPhysicalRecords(before);
    });

    it.each([2, 4])(
      "bounds %i real paid attempts without adding attempt rows or allowing another preparation",
      async (maximum) => {
        const f = await engineeringFollowupFixture(createStore(), {
          followup: { maxModelAttempts: maximum },
        });
        await f.eligible();
        const count = (await f.rows()).length;
        for (let attempt = 0; attempt < maximum; attempt += 1) {
          const owner = await f.claim();
          const prepared = await f.app.prepareEngineeringFollowupModel(
            service,
            {
              ...owner.fence,
              binding: await f.modelBinding(owner),
            },
          );
          await f.app.finishEngineeringFollowupModel(service, {
            ...owner.fence,
            stepId: prepared.stepId,
            requestHash: prepared.requestHash,
            disposition: "retry",
            retryAt: f.clock.now(),
            accounting: "unknown",
            reason: `Uncertain bounded provider attempt ${attempt + 1}`,
            processing: { requestId: `possibly-paid-request-${attempt + 1}` },
          });
          expect(await f.rows()).toHaveLength(count);
          expect(engineeringFollowupModelAttemptCount(await f.work())).toBe(
            attempt + 1,
          );
          expect((await f.work()).modelAttempts).toHaveLength(1);
          assertPhysicalRecords(await f.rows());
        }
        const replacement = await f.claim();
        const before = await f.rows();
        await expect(
          f.app.prepareEngineeringFollowupModel(service, {
            ...replacement.fence,
            binding: await f.modelBinding(replacement),
          }),
        ).rejects.toThrow(/bound|capacity|record/i);
        expect(await f.rows()).toEqual(before);
        expect(engineeringFollowupModelAttemptCount(await f.work())).toBe(
          maximum,
        );
      },
    );

    it("preflights escaped metadata before paying and preserves every admitted finish and replacement envelope", async () => {
      const f = await engineeringFollowupFixture(createStore(), {
        followup: { maxModelAttempts: 4 },
      });
      await f.eligible();
      const escaped = "\ud800".repeat(200);
      let admitted = 0;
      for (let index = 0; index < 4; index += 1) {
        const owner = await f.app.claimEngineeringFollowupWork(service, {
          ...f.nextCommand(),
          claimId: `${index}${escaped.slice(1)}`,
          workerId: escaped,
        });
        if (owner === null)
          throw new Error(
            "Expected a real replacement claim before model admission",
          );
        const before = await f.rows();
        const admission = await f.app
          .prepareEngineeringFollowupModel(service, {
            ...owner.fence,
            binding: await f.modelBinding(owner, { configVersion: escaped }),
          })
          .then(
            (prepared) => ({ prepared }),
            (error: unknown) => ({ error }),
          );
        if ("error" in admission) {
          expect(admission.error).toMatchObject({
            name: "SupportDeskLimitError",
            field: "serialized_record",
            maximum: 60_000,
          });
          expect(await f.rows()).toEqual(before);
          break;
        }
        admitted += 1;
        const command = {
          ...owner.fence,
          stepId: admission.prepared.stepId,
          requestHash: admission.prepared.requestHash,
          disposition: "retry" as const,
          retryAt: f.clock.now(),
          accounting: "unknown" as const,
          reason: escaped,
          processing: maximumProcessing(),
        };
        const outcome = await f.app.finishEngineeringFollowupModel(
          service,
          command,
        );
        const finished = await f.rows();
        await expect(
          f.app.finishEngineeringFollowupModel(service, command),
        ).resolves.toEqual(outcome);
        expect(await f.rows()).toEqual(finished);
        expect(engineeringFollowupModelAttemptCount(await f.work())).toBe(
          admitted,
        );
        expect((await f.work()).modelAttempts).toHaveLength(1);
        assertPhysicalRecords(finished);
      }
      expect(admitted).toBeGreaterThan(0);
      expect(admitted).toBeLessThanOrEqual(4);
      assertPhysicalRecords(await f.rows());
    });

    it("rejects an oversized combined candidate without changing the paid preparation, then accepts a bounded escaped result", async () => {
      const f = await engineeringFollowupFixture(createStore());
      await f.eligible();
      const owner = await f.claim();
      const prepared = await f.app.prepareEngineeringFollowupModel(service, {
        ...owner.fence,
        binding: await f.modelBinding(owner),
      });
      const before = await f.rows();
      const oversized = f.candidate({
        customerDraft: { body: "\ud800".repeat(4_000) },
      });
      expect(JSON.stringify(oversized).length * 2).toBeGreaterThan(16_000);
      await expect(
        f.app.completeEngineeringFollowupModel(
          service,
          {
            ...owner.fence,
            stepId: prepared.stepId,
            requestHash: prepared.requestHash,
            candidate: oversized,
            accounting: "accounted",
            processing: maximumProcessing(),
          },
          async () => {},
        ),
      ).rejects.toThrow();
      expect(await f.rows()).toEqual(before);
      expect((await f.work()).candidate).toBeUndefined();
      const bounded = f.candidate({
        customerDraft: { body: "\ud800".repeat(800) },
      });
      expect(JSON.stringify(bounded).length * 2).toBeLessThanOrEqual(16_000);
      await f.app.completeEngineeringFollowupModel(
        service,
        {
          ...owner.fence,
          stepId: prepared.stepId,
          requestHash: prepared.requestHash,
          candidate: bounded,
          accounting: "accounted",
          processing: maximumProcessing(),
        },
        async () => {},
      );
      expect((await f.work()).candidate).toEqual(bounded);
      expect((await f.work()).modelAttempts).toEqual([]);
      expect((await f.work()).usageTombstones).toMatchObject([
        {
          stepId: prepared.stepId,
          requestHash: prepared.requestHash,
          accounting: "accounted",
        },
      ]);
      expect(engineeringFollowupModelAttemptCount(await f.work())).toBe(1);
      assertPhysicalRecords(await f.rows());
    });

    it("refuses an oversized manifest of actual visible messages before creating any paid model preparation", async () => {
      const f = await engineeringFollowupFixture(createStore());
      const escaped = '"'.repeat(197);
      for (let index = 0; index < 75; index += 1) {
        await f.app.replyToCustomerTicket(customer, {
          ...f.command(`real-visible-manifest-message-${index}`),
          messageId: `${String(index).padStart(3, "0")}${escaped}`,
          body: `Customer-visible context ${index + 1}.`,
        });
      }
      await f.eligible();
      const owner = await f.claim();
      expect(owner.messages).toHaveLength(76);
      const binding = await f.modelBinding(owner);
      expect(binding.inputManifest.messages).toHaveLength(76);
      expect(JSON.stringify(binding).length * 2).toBeGreaterThan(60_000);
      const before = await f.rows();
      await expect(
        f.app.prepareEngineeringFollowupModel(service, {
          ...owner.fence,
          binding,
        }),
      ).rejects.toMatchObject({
        name: "SupportDeskLimitError",
        field: "serialized_record",
        maximum: 60_000,
      });
      expect(await f.rows()).toEqual(before);
      expect(await f.work()).toMatchObject({
        status: "claimed",
        modelAttempts: [],
        completionRows: 5,
        messageSlots: 1,
      });
      expect((await f.work()).stepId).toBeUndefined();
      expect(engineeringFollowupModelAttemptCount(await f.work())).toBe(0);
      assertPhysicalRecords(before);
    });

    it("completes an admitted 16000-byte candidate with maximum accounting and permits its next real claim", async () => {
      const f = await engineeringFollowupFixture(createStore());
      await f.eligible();
      const owner = await f.claim();
      const prepared = await f.app.prepareEngineeringFollowupModel(service, {
        ...owner.fence,
        binding: await f.modelBinding(owner),
      });
      const candidate = maximumCandidate(f);
      const command = {
        ...owner.fence,
        stepId: prepared.stepId,
        requestHash: prepared.requestHash,
        candidate,
        accounting: "accounted" as const,
        processing: maximumProcessing(),
      };
      const accepted = await f.app.completeEngineeringFollowupModel(
        service,
        command,
        async () => {},
      );
      const current = await f.work();
      expect(current.candidate).toEqual(candidate);
      expect(current.modelAttempts).toEqual([]);
      expect(current.usageTombstones).toMatchObject([
        {
          stepId: prepared.stepId,
          requestHash: prepared.requestHash,
          accounting: "accounted",
        },
      ]);
      const reclaimed = await f.claim();
      expect(reclaimed.work.candidate).toEqual(candidate);
      expect(reclaimed.fence.claimGeneration).toBeGreaterThan(
        owner.fence.claimGeneration,
      );
      expect(engineeringFollowupModelAttemptCount(reclaimed.work)).toBe(1);
      const beforeReplay = await f.rows();
      await expect(
        f.app.completeEngineeringFollowupModel(service, command, async () => {
          throw new Error(
            "The compacted model receipt must replay without current guards",
          );
        }),
      ).resolves.toEqual(accepted);
      expect(await f.rows()).toEqual(beforeReplay);
      expect((await f.work()).claim).toEqual(reclaimed.fence);
      assertPhysicalRecords(await f.rows());
    });

    it("admits observation and paid completion before rejecting an exact later bundle whose four future proof summaries exceed capacity", async () => {
      const f = await engineeringFollowupFixture(createStore());
      const context = f.state.context;
      if (context === undefined || context.mapping === undefined)
        throw new Error("Expected a verified release mapping");
      const wide = "\ud800".repeat(200);
      f.state.context = {
        ...context,
        mapping: {
          ...context.mapping,
          mappingId: wide,
        },
      };
      const key = await f.eligible();
      const candidate = f.candidate({
        retestRequests: Array.from({ length: 4 }, (_, index) => ({
          steps: [`Verify independent fixed-product behavior ${index + 1}.`],
          expectedBehavior: `Expected fixed behavior ${index + 1}.`,
        })),
      });
      await f.prepareCandidate({ candidate });
      const reclaimed = await f.claim();
      expect(reclaimed.work.modelAttempts).toEqual([]);
      expect(engineeringFollowupModelAttemptCount(reclaimed.work)).toBe(1);
      const ordinary = await f.exactBundle(candidate, key);
      const first = {
        ...ordinary,
        customerDraft: { body: "c" },
        kbProposal: {
          target: { kind: "none" as const },
          summary: "s".repeat(2_000),
          changes: ["d".repeat(1_000), "e".repeat(1_000)],
          advisoryValidationRequirements: [],
        },
      };
      const extra = (16_000 - JSON.stringify(first).length * 2) / 2;
      if (!Number.isInteger(extra) || extra < 0 || extra >= 4_000)
        throw new Error(
          "Exact bundle padding exceeds its legal customer draft field",
        );
      const bundle = {
        ...first,
        customerDraft: { body: "c".repeat(extra + 1) },
      };
      expect(JSON.stringify(bundle).length * 2).toBe(16_000);
      expect(bundle.retestRequests).toHaveLength(4);
      const before = await f.rows();
      await expect(
        f.prepareBundle({ key, exactBundle: bundle }),
      ).rejects.toMatchObject({
        name: "SupportDeskLimitError",
        field: "serialized_record",
        maximum: 60_000,
      });
      expect(await f.rows()).toEqual(before);
      expect((await f.work()).preparedBundle).toBeUndefined();
      expect((await f.work()).candidate).toEqual(candidate);
      expect(engineeringFollowupModelAttemptCount(await f.work())).toBe(1);
      assertPhysicalRecords(before);
    });

    it("stores four legal maximum private retest receipts for an admitted exact bundle and still posts atomically", async () => {
      const f = await engineeringFollowupFixture(createStore());
      await f.eligible();
      const candidate = f.candidate({
        retestRequests: Array.from({ length: 4 }, (_, index) => ({
          steps: [`Check synthetic fixed-product case ${index + 1}.`],
          expectedBehavior: `Case ${index + 1} matches the independently deployed fix.`,
        })),
      });
      await f.prepareCandidate({ candidate });
      const prepared = await f.prepareBundle();
      expect(prepared.bundle.retestRequests).toHaveLength(4);
      const wide = "\ud800".repeat(200);
      f.state.allowedRunners = [wide];
      const before = await f.rows();
      for (let index = 0; index < 4; index += 1) {
        const binding = await f.retestBinding(f.key, index);
        const receiptReference = `${index}${wide.slice(1)}`;
        f.trust.issueRetest(receiptReference, binding, "passed", {
          executionId: wide,
          runnerId: wide,
          verifierReceiptId: wide,
          verifierVersion: wide,
        });
        await f.app.submitEngineeringFollowupRetestResult(service, {
          ...f.command(`maximum-private-retest-${index}`),
          ...f.key,
          retestRequestId: binding.requestId,
          receiptReference,
        });
        const work = await f.work();
        expect(work.retestResults).toHaveLength(index + 1);
        expect(work.retestResults[index]).toMatchObject({
          receiptReference,
          verifierReceiptId: wide,
          result: "passed",
        });
        expect(work.modelAttempts).toEqual([]);
        expect(engineeringFollowupModelAttemptCount(work)).toBe(1);
        expect(work).toMatchObject({
          status: "bundle_prepared",
          completionRows: 3,
          messageSlots: 1,
        });
        assertPhysicalRecords(await f.rows());
      }
      expect(await f.rows()).toHaveLength(before.length + 8);
      await f.post({ messageId: "notice-after-four-maximal-private-retests" });
      expect(await f.rows()).toHaveLength(before.length + 11);
      expect(await f.work()).toMatchObject({
        status: "delivered",
        completionRows: 0,
        messageSlots: 0,
      });
      expect((await f.work()).retestResults).toHaveLength(4);
      expect((await f.work()).usageTombstones).toHaveLength(1);
      assertPhysicalRecords(await f.rows());
    });

    it.each([4, 8])(
      "keeps the lifetime workset counter bounded at %i after real superseding release observations",
      async (maximum) => {
        const f = await engineeringFollowupFixture(createStore(), {
          followup: { maxWorksets: maximum },
        });
        const first = await f.eligible();
        const keys = [first];
        for (let generation = 2; generation <= maximum; generation += 1)
          keys.push(await nextRelease(f, generation));
        expect(new Set(keys.map((key) => key.workId)).size).toBe(maximum);
        expect((await f.head()).workCount).toBe(maximum);
        expect(
          (await f.rows()).filter(
            (row) => row.kind === "engineering_followup_work",
          ),
        ).toHaveLength(maximum);
        const result = await nextRelease(f, maximum + 1);
        expect((await f.head()).workCount).toBe(maximum);
        expect(
          (await f.rows()).filter(
            (row) => row.kind === "engineering_followup_work",
          ),
        ).toHaveLength(maximum);
        await expect(f.work(result)).rejects.toThrow();
        expect((await f.work(first)).completionRows).toBe(0);
        assertPhysicalRecords(await f.rows());
      },
    );

    it.each([4, 8])(
      "limits checked bundle revisions to %i while preserving attempts across explicit staff reassessments",
      async (maximum) => {
        const f = await engineeringFollowupFixture(createStore(), {
          followup: { maxBundleRevisions: maximum },
        });
        await f.eligible();
        let prepared = await f.prepareBundle();
        const attempts = prepared.work.modelAttempts;
        for (let revision = 1; revision < maximum; revision += 1) {
          await f.app.rejectEngineeringFollowupBundle(staff, {
            ...f.command(`reject-revision-${revision}`),
            ...f.key,
            expectedWorkGeneration: prepared.work.workGeneration,
            bundleHash: prepared.work.preparedBundle!.bundleHash,
            reason: `Require explicit fresh checks for bundle revision ${revision + 1}`,
          });
          prepared = await f.prepareBundle({ mode: "staff_reassessment" });
          expect(prepared.work.bundleRevision).toBe(revision + 1);
          expect(prepared.work.modelAttempts).toEqual(attempts);
          assertPhysicalRecords(await f.rows());
        }
        const before = await f.rows();
        await expect(
          f.prepareBundle({ mode: "staff_reassessment" }),
        ).rejects.toThrow(/bound/i);
        expect(await f.rows()).toEqual(before);
        expect(f.modelCommands).toHaveLength(1);
      },
    );

    it.each(["configured", "omitted"] as const)(
      "scrubs eight actual child worksets using only the parent's privacy reserve when follow-up configuration is %s",
      async (configuration) => {
        const f = await engineeringFollowupFixture(createStore(), {
          support: managed,
          followup: { maxWorksets: 8 },
        });
        const keys = [await f.eligible()];
        const secrets: string[] = [];
        for (let index = 0; index < 8; index += 1) {
          if (index > 0) keys.push(await nextRelease(f, index + 1));
          const secret = `PRIVATE_CUSTOMER_PROPOSAL_FOR_CHILD_${index}`;
          secrets.push(secret);
          await f.prepareCandidate({
            key: keys[index]!,
            candidate: f.candidate({
              customerDraft: { body: secret },
              kbProposal: {
                summary: `PRIVATE_KB_${index}`,
                changes: [`PRIVATE_CHANGE_${index}`],
                advisoryValidationRequirements: [],
              },
              retestRequests: [
                {
                  steps: [`PRIVATE_RETEST_${index}`],
                  expectedBehavior: `PRIVATE_EXPECTED_${index}`,
                },
              ],
            }),
          });
        }
        const before = await f.rows();
        const app =
          configuration === "omitted"
            ? f.support.freshApplicationWithoutEngineeringFollowup()
            : f.app;
        await app.withdrawEngineeringSource(staff, {
          ...f.command("withdraw-parent-eight-followups"),
          reason: "privacy_withdrawal",
        });
        const after = await f.rows();
        expect(after).toHaveLength(before.length + 2);
        const children = after.filter(
          (row) => row.kind === "engineering_followup_work",
        );
        expect(children).toHaveLength(8);
        for (const child of children) {
          expect(child).toMatchObject({
            withdrawn: true,
            completionRows: 0,
            messageSlots: 0,
            modelAttempts: [],
            retestResults: [],
          });
          expect(child).not.toHaveProperty("context");
          expect(child).not.toHaveProperty("candidate");
          expect(child).not.toHaveProperty("preparedBundle");
          expect(child).not.toHaveProperty("handoff");
        }
        const retained = JSON.stringify(
          after.filter((row) => row.kind.startsWith("engineering_followup")),
        );
        for (const secret of secrets) expect(retained).not.toContain(secret);
        for (const secret of [
          "PRIVATE_KB_",
          "PRIVATE_CHANGE_",
          "PRIVATE_RETEST_",
          "PRIVATE_EXPECTED_",
          "PRIVATE_MAPPING_ID",
        ])
          expect(retained).not.toContain(secret);
        expect((await f.support.source()).state).toBe("withdrawn");
        await f.app.withdrawResolutionLearningSource(staff, {
          ...f.command("independent-learning-privacy-after-eight-child-scrub"),
          reason: "privacy_withdrawal",
        });
        expect(await f.rows()).toHaveLength(before.length + 4);
        assertPhysicalRecords(await f.rows());
      },
    );
  });
}
