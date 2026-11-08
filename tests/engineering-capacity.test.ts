import {
  engineeringExportChecksBinding,
  supportRecords,
  type EngineeringProcessing,
  type NotificationInput,
  type SupportRecord,
} from "@pegma/support-desk-application";
import { describe, expect, it } from "vitest";
import {
  engineeringAiFixture,
  engineeringBarrier,
  engineeringCustomer as customer,
  engineeringFixture,
  engineeringService as service,
  engineeringStaff as staff,
  engineeringStores,
} from "../test/engineering-fixtures.js";

const humanNotification: NotificationInput = {
  id: "engineering-first-human-notification",
  recipientRef: "synthetic-support-queue",
  templateId: "synthetic.ticket",
  templateVersion: 1,
  variables: {},
  subject: "Synthetic support update",
  outboundMessageId: "<engineering-capacity@fixtures.invalid>",
};

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

function assertEncodedRecords(rows: readonly SupportRecord[]): void {
  for (const row of rows) {
    if (row.kind !== "engineering_source" && row.kind !== "engineering_work")
      continue;
    const encoded = supportRecords.codec.encode(row);
    expect(supportRecords.codec.decode(encoded)).toEqual(row);
    expect(typeof encoded.payload).toBe("string");
    expect((encoded.payload as string).length * 2).toBeLessThanOrEqual(60_000);
  }
}

for (const [name, createStore] of engineeringStores) {
  describe(`engineering physical capacity (${name})`, () => {
    it("bounds replacement proposals and review history while exact command replay adds no rows", async () => {
      const f = engineeringFixture(createStore(), {
        engineering: { maxProposals: 1 },
      });
      await f.eligible();
      const prepared = await f.prepareProposal();
      const owner = await f.claim("replacement-proposal", "proposal-worker");
      const source = await f.source();
      const request = {
        ...prepared.request,
        bundle: {
          ...prepared.request.bundle,
          title: "Revised independently checked synthetic export report",
        },
      };
      const checks = await engineeringExportChecksBinding({
        sourceBindingHash: source.sourceBindingHash!,
        evidenceFingerprint: source.evidenceFingerprint!,
        candidateHash: prepared.candidateHash,
        routingBindingHash: prepared.proposal.routingBindingHash,
        exactRequest: request,
        policyGeneration: prepared.proposal.policyGeneration,
        policyHash: prepared.proposal.policyHash,
      });
      f.trust.issueChecks("independent-replacement-proposal-checks", checks);
      const before = await f.rows();
      await expect(
        f.app.prepareEngineeringProposal(
          service,
          {
            ...owner.fence,
            candidateHash: prepared.candidateHash,
            routingReceipt: prepared.routingReceipt,
            checksReceipt: "independent-replacement-proposal-checks",
            exactRequest: request,
            policyGeneration: prepared.proposal.policyGeneration,
            policyHash: prepared.proposal.policyHash,
          },
          async () => {},
        ),
      ).rejects.toThrow("proposal limit");
      expect(await f.rows()).toEqual(before);
      expect((await f.work()).proposalCount).toBe(1);
      const work = await f.work();
      const review = {
        ...f.command("exact-once-proposal-review"),
        sourceGeneration: work.sourceGeneration,
        expectedWorkGeneration: work.workGeneration,
        proposalHash: work.proposal!.proposalHash,
        decision: "approve" as const,
      };
      const approved = await f.app.reviewEngineeringProposal(
        staff,
        review,
        async () => {},
      );
      const reviewed = await f.rows();
      await expect(
        f.app.reviewEngineeringProposal(staff, review, async () => {}),
      ).resolves.toEqual(approved);
      expect(await f.rows()).toEqual(reviewed);
      await expect(
        f.app.reviewEngineeringProposal(
          staff,
          {
            ...review,
            ...f.command("contradictory-second-review"),
            expectedWorkGeneration: (await f.work()).workGeneration,
            decision: "reject",
          },
          async () => {},
        ),
      ).rejects.toThrow();
      expect(await f.rows()).toEqual(reviewed);
      assertEncodedRecords(reviewed);
    });

    it("retains unknown destination and work identities when the configured target limit is full", async () => {
      const f = await engineeringAiFixture(createStore(), {
        engineering: { maxTargets: 1, maxGenerations: 2 },
      });
      await f.prepareProposal();
      await f.approve();
      f.setGitHubCreate(async () => {
        throw new Error("Synthetic issue acceptance is unknown");
      });
      await f.engineering.processWork(f.nextCommand());
      const unknown = await f.work();
      const destinations = (await f.source()).destinations;
      expect(destinations).toHaveLength(1);
      await f.app.invalidateEngineeringSource(staff, {
        ...f.command("new-evidence-at-target-capacity"),
        reason: "evidence_revoked",
      });
      const ticket = (await f.app.readStaffTicket(staff, "ticket")).ticket;
      const next = await f.app.submitEngineeringEvidence(staff, {
        ...f.command("verify-next-target-generation"),
        expectedRevision: ticket.revision,
        evidence: {
          ...(await f.reportInput()),
          verificationReference: "fresh-reproduction-at-target-capacity",
        },
        security: "ordinary",
      });
      const nextCommand = {
        ...f.nextCommand(),
        sourceGeneration: next.sourceGeneration,
      };
      for (let stage = 0; stage < 3; stage += 1) {
        const result = await f.engineering
          .processWork(nextCommand)
          .catch(() => undefined);
        if (result?.outcome === "candidate") continue;
        if (result?.outcome === "prepared") {
          const work = await f.work();
          await f.engineering.reviewProposal(staff, {
            ...f.command("approve-at-target-capacity"),
            sourceGeneration: next.sourceGeneration,
            expectedWorkGeneration: work.workGeneration,
            proposalHash: work.proposal!.proposalHash,
            decision: "approve",
          });
          await f.engineering.processWork(nextCommand).catch(() => undefined);
        }
        break;
      }
      expect(f.createIssue).toHaveBeenCalledTimes(1);
      const retained = await f.work("ticket", f.key.sourceGeneration);
      expect(retained.dispatch).toEqual(unknown.dispatch);
      expect(retained.terminalReserveRows).toBe(2);
      expect((await f.source()).destinations).toHaveLength(1);
      expect((await f.source()).destinations[0]).toMatchObject({
        dispatchId: destinations[0]!.dispatchId,
        requestHash: destinations[0]!.requestHash,
        exportMarker: destinations[0]!.exportMarker,
        outcome: "unknown",
      });
      assertEncodedRecords(await f.rows());
    });

    it("updates unknown reconciliation observations inline without consuming the prepaid terminal Audit and receipt", async () => {
      const f = await engineeringAiFixture(createStore());
      await f.prepareProposal();
      await f.approve();
      f.setGitHubCreate(async () => {
        throw new Error("Synthetic outbound acceptance is unknown");
      });
      await f.engineering.processWork(f.nextCommand());
      const count = (await f.rows()).length;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        f.githubReconcile.mockResolvedValue({
          outcome: "unknown",
          reason: `Bounded unresolved observation ${attempt}`,
        });
        await f.engineering.reconcileSource("ticket");
        expect(await f.rows()).toHaveLength(count);
        expect((await f.work()).terminalReserveRows).toBe(2);
        expect((await f.work()).dispatch).toBeDefined();
        assertEncodedRecords(await f.rows());
      }
      expect(f.createIssue).toHaveBeenCalledTimes(1);
    });

    it("spends the prepaid terminal tail after handoff and takeover while preserving the first human reply", async () => {
      const shared = {
        managed: true,
        assistantTurns: {},
        resolutionLearning: { enabled: true },
      };
      const probe = await engineeringAiFixture(createStore(), shared);
      await probe.prepareProposal();
      await probe.approve();
      let dispatchRows = 0;
      probe.setGitHubCreate(async (request) => {
        dispatchRows = (await probe.rows()).length;
        return probe.acceptIssue(request);
      });
      await probe.engineering.processWork(probe.nextCommand());
      expect(dispatchRows).toBeGreaterThan(0);
      const maximum = dispatchRows + 13 + 2 + 2 + 2;
      const f = await engineeringAiFixture(createStore(), {
        ...shared,
        limits: { maxRecordsPerTicket: maximum },
      });
      await f.prepareProposal();
      await f.approve();
      const barrier = engineeringBarrier();
      f.setGitHubCreate(async (request) => {
        await barrier.wait();
        return f.acceptIssue(request);
      });
      const dispatching = f.engineering.processWork(f.nextCommand());
      await barrier.reached;
      try {
        expect(await f.rows()).toHaveLength(dispatchRows);
        expect((await f.work()).terminalReserveRows).toBe(2);
        await expect(
          f.app.addNote(staff, {
            ...f.command("ordinary-cannot-spend-terminal-or-human-tail"),
            messageId: "ordinary-at-prepaid-boundary",
            body: "Reserved rows remain available for their causal work.",
          }),
        ).rejects.toMatchObject({
          name: "SupportDeskLimitError",
          field: "ticket_partition",
        });
        const source = await f.source();
        await f.app.requestPerson(
          customer,
          f.command("person-during-dispatch"),
        );
        const current = (await f.app.readStaffTicket(staff, "ticket")).ticket;
        await f.app.takeOverTicket(staff, {
          ...f.command("takeover-during-dispatch"),
          expectedRevision: current.revision,
          expectedHandlingGeneration: current.handling!.generation,
        });
        expect(await f.rows()).toHaveLength(dispatchRows + 5);
        expect((await f.source()).sourceBindingHash).toBe(
          source.sourceBindingHash,
        );
        expect((await f.work()).terminalReserveRows).toBe(2);
      } finally {
        barrier.release();
      }
      await dispatching;
      expect((await f.work()).status).toBe("accepted");
      expect((await f.work()).terminalReserveRows).toBe(0);
      expect(await f.rows()).toHaveLength(dispatchRows + 7);
      await f.app.replyAsStaff(staff, {
        ...f.command("first-human-after-terminal-ack"),
        messageId: "first-human-after-terminal-ack",
        body: "A human is investigating the verified export failure.",
        notification: humanNotification,
      });
      expect(await f.rows()).toHaveLength(dispatchRows + 11);
      expect(f.createIssue).toHaveBeenCalledTimes(1);
      assertEncodedRecords(await f.rows());
    });

    it("holds new evidence at the finite generation limit without dropping prior work", async () => {
      const f = engineeringFixture(createStore(), {
        engineering: { maxGenerations: 1 },
      });
      const first = await f.eligible();
      const prior = await f.work();
      await f.app.invalidateEngineeringSource(staff, {
        ...f.command("invalidate-first-generation"),
        reason: "evidence_revoked",
      });
      const ticket = (await f.app.readStaffTicket(staff, "ticket")).ticket;
      const command = {
        ...f.command("verified-second-generation"),
        expectedRevision: ticket.revision,
        evidence: {
          ...(await f.reportInput()),
          verificationReference: "independent-second-reproduction",
        },
        security: "ordinary" as const,
      };
      const held = await f.app.submitEngineeringEvidence(staff, command);
      expect(held).toMatchObject({
        state: "held",
        heldReason: "engineering_capacity",
      });
      expect((await f.source()).generationCount).toBe(1);
      expect(
        (await f.rows()).filter((row) => row.kind === "engineering_work"),
      ).toHaveLength(1);
      expect(await f.work("ticket", first.sourceGeneration)).toMatchObject({
        id: prior.id,
        sourceGeneration: first.sourceGeneration,
      });
      const beforeReplay = await f.rows();
      await expect(
        f.app.submitEngineeringEvidence(staff, command),
      ).resolves.toEqual(held);
      expect(await f.rows()).toEqual(beforeReplay);
      await f.app.addNote(staff, {
        ...f.command("human-after-generation-limit"),
        messageId: "human-at-generation-limit",
        body: "Human support remains available.",
      });
      assertEncodedRecords(await f.rows());
    });

    it.each(["engineering", "learning"] as const)(
      "preserves thirteen human rows and independent privacy reserves when %s withdraws first",
      async (first) => {
        const shared = {
          assistantTurns: {},
          resolutionLearning: { enabled: true },
        };
        const probe = engineeringFixture(createStore(), shared);
        await probe.create(true);
        await probe.eligible();
        const admittedRows = (await probe.rows()).length;
        const maximum = admittedRows + 13 + 2 + 2;
        const f = engineeringFixture(createStore(), {
          ...shared,
          limits: { maxRecordsPerTicket: maximum },
        });
        await f.create(true);
        await f.eligible();
        const before = await f.rows();
        expect(before).toHaveLength(admittedRows);
        expect(
          before.filter((row) => row.kind === "resolution_learning_source"),
        ).toHaveLength(1);
        expect(
          before.filter((row) => row.kind === "engineering_source"),
        ).toHaveLength(1);
        await expect(
          f.app.addNote(staff, {
            ...f.command("ordinary-cannot-spend-derivation-reserves"),
            messageId: "ordinary-at-combined-reserve",
            body: "A normal note cannot spend reserved privacy capacity.",
          }),
        ).rejects.toMatchObject({
          name: "SupportDeskLimitError",
          field: "ticket_partition",
        });
        expect(await f.rows()).toEqual(before);

        for (const workflow of [
          first,
          first === "engineering" ? "learning" : "engineering",
        ]) {
          const command = {
            ...f.command(`withdraw-${workflow}`),
            reason: "privacy_withdrawal" as const,
          };
          if (workflow === "engineering")
            await f.app.withdrawEngineeringSource(staff, command);
          else await f.app.withdrawResolutionLearningSource(staff, command);
          const rows = await f.rows();
          expect(rows).toHaveLength(
            before.length + (workflow === first ? 2 : 4),
          );
          const added = rows.filter(
            (row) => !before.some((prior) => prior.id === row.id),
          );
          expect(added.filter((row) => row.kind === "audit")).toHaveLength(
            workflow === first ? 1 : 2,
          );
        }
        expect((await f.source()).state).toBe("withdrawn");
        expect(
          (await f.app.readResolutionLearningSource(staff, "ticket")).state,
        ).toBe("withdrawn");
        expect(maximum - (await f.rows()).length).toBe(13);
        assertEncodedRecords(await f.rows());
      },
    );

    it("bounds paid model preparations and retains unknown accounting without new attempt rows", async () => {
      const f = engineeringFixture(createStore(), {
        engineering: { maxModelAttempts: 1 },
      });
      await f.eligible();
      const owner = await f.claim();
      const prepared = await f.app.prepareEngineeringModel(service, {
        ...owner.fence,
        binding: await f.modelBinding(owner),
      });
      const rowCount = (await f.rows()).length;
      await f.app.finishEngineeringWork(service, {
        ...owner.fence,
        stepId: prepared.stepId,
        requestHash: prepared.requestHash,
        disposition: "retry",
        accounting: "unknown",
        retryAt: f.clock.now(),
        processing: { requestId: "possibly-paid-request" },
      });
      const replacement = await f.claim("replacement", "replacement-worker");
      const before = await f.rows();

      await expect(
        f.app.prepareEngineeringModel(service, {
          ...replacement.fence,
          binding: await f.modelBinding(replacement),
        }),
      ).rejects.toThrow();
      expect(await f.rows()).toEqual(before);
      expect(await f.rows()).toHaveLength(rowCount);
      expect((await f.work()).modelAttempts).toMatchObject([
        {
          stepId: prepared.stepId,
          requestHash: prepared.requestHash,
          accounting: "unknown",
          processing: { requestId: "possibly-paid-request" },
        },
      ]);
      assertEncodedRecords(await f.rows());
    });

    it("rejects an oversized model candidate without changing its durable preparation", async () => {
      const f = engineeringFixture(createStore());
      await f.eligible();
      const owner = await f.claim();
      const prepared = await f.app.prepareEngineeringModel(service, {
        ...owner.fence,
        binding: await f.modelBinding(owner),
      });
      const before = await f.rows();
      const candidate = f.candidate({ summary: "\ud800".repeat(4_000) });
      expect(JSON.stringify(candidate).length * 2).toBeGreaterThan(16_000);

      await expect(
        f.app.completeEngineeringModel(
          service,
          {
            ...owner.fence,
            stepId: prepared.stepId,
            requestHash: prepared.requestHash,
            candidate,
            accounting: "accounted",
            processing: maximumProcessing(),
          },
          async () => {},
        ),
      ).rejects.toThrow();
      expect(await f.rows()).toEqual(before);
      expect((await f.work()).candidate).toBeUndefined();
      assertEncodedRecords(await f.rows());
    });

    it("preflights escaped metadata and every later finish and replacement-claim envelope", async () => {
      const f = engineeringFixture(createStore(), {
        engineering: { maxModelAttempts: 4 },
      });
      await f.eligible();
      const escaped = "\ud800".repeat(200);
      let admitted = 0;
      for (let attempt = 1; attempt <= 4; attempt += 1) {
        const owner = await f.claim(`${attempt}${escaped.slice(1)}`, escaped);
        const before = await f.rows();
        const admission = await f.app
          .prepareEngineeringModel(service, {
            ...owner.fence,
            binding: await f.modelBinding(owner, {
              configVersion: escaped,
              promptVersion: escaped,
              modelVersion: escaped,
              parserVersion: escaped,
              checkPolicyVersion: escaped,
              usageReservationId: escaped,
              inputFingerprint: String(attempt).repeat(64),
            }),
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
        const finish = {
          ...owner.fence,
          stepId: admission.prepared.stepId,
          requestHash: admission.prepared.requestHash,
          disposition: "retry" as const,
          accounting: "unknown" as const,
          retryAt: f.clock.now(),
          reason: escaped,
          processing: maximumProcessing(),
        };
        await f.app.finishEngineeringWork(service, finish);
        const rows = await f.rows();
        await expect(
          f.app.finishEngineeringWork(service, finish),
        ).resolves.toMatchObject({ status: "retry" });
        expect(await f.rows()).toEqual(rows);
        expect((await f.work()).modelAttempts).toHaveLength(admitted);
        assertEncodedRecords(rows);
      }
      expect(admitted).toBeGreaterThan(0);
      expect(admitted).toBeLessThan(4);
      assertEncodedRecords(await f.rows());
    });

    it("completes an admitted large candidate and maximum accounting before a maximum replacement claim", async () => {
      const f = engineeringFixture(createStore());
      await f.eligible();
      const owner = await f.claim();
      const escaped = "\ud800".repeat(200);
      const prepared = await f.app.prepareEngineeringModel(service, {
        ...owner.fence,
        binding: await f.modelBinding(owner, {
          configVersion: escaped,
          promptVersion: escaped,
          modelVersion: escaped,
          parserVersion: escaped,
          checkPolicyVersion: escaped,
          usageReservationId: escaped,
        }),
      });
      const candidate = f.candidate({ summary: "\ud800".repeat(1_000) });
      expect(JSON.stringify(candidate).length * 2).toBeLessThanOrEqual(16_000);
      await f.app.completeEngineeringModel(
        service,
        {
          ...owner.fence,
          stepId: prepared.stepId,
          requestHash: prepared.requestHash,
          candidate,
          accounting: "accounted",
          processing: maximumProcessing(),
        },
        async () => {},
      );
      expect((await f.work()).candidateHash).toMatch(/^[a-f0-9]{64}$/u);
      expect((await f.work()).modelAttempts).toMatchObject([
        { accounting: "accounted", processing: maximumProcessing() },
      ]);
      assertEncodedRecords(await f.rows());

      f.advance(10_001);
      const replacement = await f.claim(escaped, escaped);
      expect(replacement.work.candidate).toEqual(candidate);
      assertEncodedRecords(await f.rows());
    });
  });
}
