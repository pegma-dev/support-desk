import {
  supportPermissions,
  type ResolutionSourceFence,
  type ResolutionTrustContext,
  type SubmitResolutionEvidenceCommand,
  type SupportRecord,
} from "@pegma/support-desk-application";
import { describe, expect, it } from "vitest";
import { handlingBarrier } from "../test/handling-fixtures.js";
import {
  learningCustomer as customer,
  learningService as service,
  learningStaff as staff,
  learningStores,
  resolutionLearningFixture,
} from "../test/resolution-learning-fixtures.js";

for (const [name, createStore] of learningStores) {
  describe(`resolution evidence through real Storage Core (${name})`, () => {
    it("preallocates one private source but never treats resolved status as proof", async () => {
      const f = resolutionLearningFixture(createStore());
      const terminal = await f.terminal();
      expect(terminal.source).toMatchObject({
        state: "unverified",
        sourceGeneration: 0,
        resolutionCycle: 1,
        generationCount: 0,
      });
      expect(
        (await f.rows()).filter(
          (row) => row.kind === "resolution_learning_source",
        ),
      ).toHaveLength(1);
      expect(
        (await f.rows()).filter(
          (row) => row.kind === "resolution_learning_work",
        ),
      ).toEqual([]);
      expect(f.trust.productCalls).toEqual([]);
      expect(
        await f.app.scanResolutionLearningCandidates(service, { limit: 100 }),
      ).toMatchObject({ candidates: [] });
    });

    it("accepts authenticated owner confirmation with proof, work, Audit and receipt in one transaction", async () => {
      const f = resolutionLearningFixture(createStore());
      const terminal = await f.terminal();
      const before = await f.rows();
      f.observed.transactions.length = 0;
      const accepted = await f.confirm();
      const acceptedTicket = (await f.app.readStaffTicket(staff, "ticket"))
        .ticket;
      expect(accepted.result.ticket.status).toBe("resolved");
      expect(accepted.source).toMatchObject({
        state: "eligible",
        sourceGeneration: 1,
        resolutionCycle: 1,
        generationCount: 1,
        acceptedTicketRevision: acceptedTicket.revision,
        evidence: {
          kind: "customer_confirmation",
          actorId: customer.principalId,
          lastVisibleMessageId: terminal.solutionMessageId,
        },
        product: { buildId: "build-verified-230" },
      });
      const work = await f.work();
      expect(work).toMatchObject({
        sourceGeneration: accepted.source.sourceGeneration,
        resolutionCycle: accepted.source.resolutionCycle,
        sourceBindingHash: accepted.source.sourceBindingHash,
        acceptedTicketRevision: accepted.source.acceptedTicketRevision,
        status: "pending",
        evidence: accepted.source.evidence,
        product: accepted.source.product,
      });
      const transactions = f.observed.transactions.filter(
        (trace) => trace.collection === "support-desk.records.v1",
      );
      expect(transactions).toHaveLength(1);
      const writes = transactions[0]!.actions.filter(
        (action) => action.action !== "delete",
      );
      expect(
        writes.map((action) => (action.value as SupportRecord).kind),
      ).toEqual(
        expect.arrayContaining([
          "ticket",
          "resolution_learning_source",
          "resolution_learning_work",
          "customer_success",
          "audit",
          "command",
        ]),
      );
      expect(
        new Set(writes.map((action) => (action.value as SupportRecord).id))
          .size,
      ).toBe(writes.length);
      expect((await f.rows()).length - before.length).toBe(4);
      const rows = await f.rows();
      await f.app.confirmCustomerSuccess(customer, accepted.command);
      await f.confirm();
      expect(await f.rows()).toEqual(rows);
      expect(f.trust.productCalls).toHaveLength(1);
      await expect(
        f.app.confirmCustomerSuccess(
          { ...customer, principalId: "customer/other" },
          accepted.command,
        ),
      ).rejects.toThrow();
      await expect(
        f.app.confirmCustomerSuccess(
          {
            ...customer,
            permissions: customer.permissions.filter(
              (permission) => permission !== supportPermissions.confirmSuccess,
            ),
          },
          accepted.command,
        ),
      ).rejects.toMatchObject({
        permission: supportPermissions.confirmSuccess,
      });
      expect(await f.rows()).toEqual(rows);
    });

    it("accepts a staff fix only against immutable visible solution and current resolution fence", async () => {
      const f = resolutionLearningFixture(createStore());
      const terminal = await f.terminal();
      await f.app.addNote(staff, {
        ...f.command("private-note"),
        messageId: "private-solution-note",
        body: "PRIVATE_RESOLUTION_NOTE_CANARY",
      });
      const current = (await f.app.readStaffTicket(staff, "ticket")).ticket;
      const command: SubmitResolutionEvidenceCommand = {
        ...f.command("staff-verified"),
        expectedRevision: current.revision,
        resolutionCycle: terminal.source.resolutionCycle,
        evidence: {
          kind: "staff_verified_fix",
          solutionMessageId: terminal.solutionMessageId,
          verificationReference: "PRIVATE_STAFF_VERIFICATION_REFERENCE",
        },
      };
      const before = await f.rows();
      for (const stale of [
        { ...command, expectedRevision: current.revision - 1 },
        { ...command, resolutionCycle: terminal.source.resolutionCycle + 1 },
        {
          ...command,
          evidence: {
            ...command.evidence,
            solutionMessageId: "private-solution-note",
          },
        },
      ])
        await expect(
          f.app.submitResolutionEvidence(staff, stale),
        ).rejects.toThrow();
      expect(await f.rows()).toEqual(before);
      const accepted = await f.app.submitResolutionEvidence(staff, command);
      expect(accepted.state).toBe("eligible");
      expect((await f.source()).evidence).toEqual({
        ...command.evidence,
        actorId: staff.principalId,
      });
      const rows = await f.rows();
      expect(await f.app.submitResolutionEvidence(staff, command)).toEqual(
        accepted,
      );
      expect(await f.rows()).toEqual(rows);
      await expect(
        f.app.submitResolutionEvidence(
          {
            ...staff,
            permissions: staff.permissions.filter(
              (permission) =>
                permission !== supportPermissions.learningEvidenceSubmit,
            ),
          },
          command,
        ),
      ).rejects.toMatchObject({
        permission: supportPermissions.learningEvidenceSubmit,
      });
      const customerView = JSON.stringify(
        await f.app.readCustomerTicket(customer, "ticket"),
      );
      for (const secret of [
        "PRIVATE_RESOLUTION_NOTE_CANARY",
        "PRIVATE_STAFF_VERIFICATION_REFERENCE",
        staff.principalId,
        customer.principalId,
        "customer@fixtures.invalid",
        "sourceGeneration",
        "evidence",
        "verificationReference",
        "receiptId",
        "productContextFingerprint",
      ])
        expect(customerView).not.toContain(secret);
      await expect(
        f.app.readResolutionLearningSource(customer, "ticket"),
      ).rejects.toThrow();
      await expect(
        f.app.readResolutionLearningWork(customer, {
          ticketId: "ticket",
          sourceGeneration: 1,
        }),
      ).rejects.toThrow();
      const claim = await f.claim();
      for (const secret of [
        "PRIVATE_RESOLUTION_NOTE_CANARY",
        "PRIVATE_STAFF_VERIFICATION_REFERENCE",
        "customer@fixtures.invalid",
        customer.principalId,
        staff.principalId,
      ])
        expect(JSON.stringify(claim.messages)).not.toContain(secret);
    });

    it("coalesces semantic staff proof across refreshed attestations and command identities", async () => {
      const f = resolutionLearningFixture(createStore());
      const terminal = await f.terminal();
      const command = {
        ...f.command("first-proof"),
        expectedRevision: terminal.ticket.revision,
        resolutionCycle: terminal.source.resolutionCycle,
        evidence: {
          kind: "staff_verified_fix" as const,
          solutionMessageId: terminal.solutionMessageId,
          verificationReference: "staging-check/export-230",
        },
      };
      await f.app.submitResolutionEvidence(staff, command);
      const first = await f.source();
      f.advance();
      await f.app.submitResolutionEvidence(staff, {
        ...command,
        ...f.command("equivalent-proof"),
      });
      const second = await f.source();
      expect(second).toEqual(first);
      expect(f.trust.productCalls).toHaveLength(2);
      expect(
        (await f.rows()).filter(
          (row) => row.kind === "resolution_learning_work",
        ),
      ).toHaveLength(1);
      expect(
        (await f.app.readStaffTicket(staff, "ticket")).ticket.revision,
      ).toBe(terminal.ticket.revision);
    });

    it("treats a different stable staff verification reference as new proof and invalidates the prior exact review", async () => {
      const f = resolutionLearningFixture(createStore());
      const terminal = await f.terminal();
      const command: SubmitResolutionEvidenceCommand = {
        ...f.command("first-stable-staff-proof"),
        expectedRevision: terminal.ticket.revision,
        resolutionCycle: terminal.source.resolutionCycle,
        evidence: {
          kind: "staff_verified_fix",
          solutionMessageId: terminal.solutionMessageId,
          verificationReference: "staging/export-verification-1",
        },
      };
      await f.app.submitResolutionEvidence(staff, command);
      const reviewed = await f.prepareReviewedTarget();
      const approved = await f.source();
      const reviewBinding = {
        ticketId: "ticket",
        target: reviewed.target,
        policyVersion: reviewed.policyVersion,
      };
      expect(
        await f.app.confirmResolutionLearningTargetReview(
          service,
          reviewBinding,
        ),
      ).toBe(true);
      f.advance();
      await f.app.submitResolutionEvidence(staff, {
        ...command,
        ...f.command("same-stable-staff-proof"),
      });
      expect(await f.source()).toEqual(approved);
      expect(
        await f.app.confirmResolutionLearningTargetReview(
          service,
          reviewBinding,
        ),
      ).toBe(true);
      const changed: SubmitResolutionEvidenceCommand = {
        ...command,
        ...f.command("different-stable-staff-proof"),
        evidence: {
          kind: "staff_verified_fix",
          solutionMessageId: terminal.solutionMessageId,
          verificationReference: "staging/export-verification-2",
        },
      };
      await f.app.submitResolutionEvidence(staff, changed);
      const current = await f.source();
      expect(current).toMatchObject({
        state: "eligible",
        resolutionCycle: approved.resolutionCycle,
        sourceGeneration: approved.sourceGeneration + 1,
        generationCount: approved.generationCount + 1,
        productContextFingerprint: approved.productContextFingerprint,
      });
      expect(current.evidenceFingerprint).not.toBe(
        approved.evidenceFingerprint,
      );
      expect(current.sourceBindingHash).not.toBe(approved.sourceBindingHash);
      expect(current.evidence).toMatchObject({
        verificationReference: "staging/export-verification-2",
      });
      expect(
        (await f.rows()).filter(
          (row) => row.kind === "resolution_learning_work",
        ),
      ).toHaveLength(2);
      expect(await f.work()).toMatchObject({
        status: "pending",
        evidence: { verificationReference: "staging/export-verification-2" },
      });
      expect(await f.work("ticket", approved.sourceGeneration)).toMatchObject({
        evidence: { verificationReference: "staging/export-verification-1" },
      });
      expect(
        await f.app.confirmResolutionLearningSource(
          service,
          reviewed.sourceFence,
        ),
      ).toBe(false);
      expect(
        await f.app.confirmResolutionLearningTargetReview(
          service,
          reviewBinding,
        ),
      ).toBe(false);
      expect(
        (await f.rows()).filter(
          (row) => row.kind === "resolution_learning_review",
        ),
      ).toHaveLength(1);
      expect(
        (await f.app.readStaffTicket(staff, "ticket")).ticket.revision,
      ).toBe(terminal.ticket.revision);
      const rows = await f.rows();
      await f.app.submitResolutionEvidence(staff, changed);
      expect(await f.rows()).toEqual(rows);
    });

    it("accepts only a host-verified relevant execution bound to actor, revision, cycle and exact build", async () => {
      const f = resolutionLearningFixture(createStore());
      const terminal = await f.terminal();
      const trust: ResolutionTrustContext = {
        ticketId: "ticket",
        ticketRevision: terminal.ticket.revision,
        resolutionCycle: terminal.source.resolutionCycle,
        resolvedAt: terminal.ticket.resolvedAt!,
        actorId: staff.principalId,
        acceptedAt: f.clock.now(),
      };
      const testContext = { ...trust, product: f.trust.productFor(trust) };
      f.trust.issueTest("trusted-execution-1", testContext);
      const command = {
        ...f.command("verified-test"),
        expectedRevision: terminal.ticket.revision,
        resolutionCycle: terminal.source.resolutionCycle,
        evidence: {
          kind: "successful_test" as const,
          solutionMessageId: terminal.solutionMessageId,
          receipt: "trusted-execution-1",
        },
      };
      expect((await f.app.submitResolutionEvidence(staff, command)).state).toBe(
        "eligible",
      );
      expect((await f.work()).evidence).toMatchObject({
        kind: "successful_test",
        actorId: staff.principalId,
        test: {
          executionId: "synthetic-export-execution-1",
          runnerId: "trusted-staging-runner",
          testId: "workspace-export-download",
          productBinding: testContext.product.binding,
        },
      });
      expect(f.trust.testCalls[0]!.context).toMatchObject({
        ...trust,
        product: {
          productId: "workspace",
          version: "2.3.0",
          buildId: "build-verified-230",
          binding: testContext.product.binding,
        },
      });
      f.advance();
      const refreshed = {
        ...testContext,
        acceptedAt: f.clock.now(),
        product: f.trust.productFor({ ...trust, acceptedAt: f.clock.now() }),
      };
      f.trust.issueTest("trusted-execution-refreshed", refreshed);
      const generation = (await f.source()).sourceGeneration;
      await f.app.submitResolutionEvidence(staff, {
        ...command,
        ...f.command("same-execution-refreshed"),
        evidence: {
          ...command.evidence,
          receipt: "trusted-execution-refreshed",
        },
      });
      expect((await f.source()).sourceGeneration).toBe(generation);
      expect(
        (await f.rows()).filter(
          (row) => row.kind === "resolution_learning_work",
        ),
      ).toHaveLength(1);
    });

    it.each([
      "unknown receipt",
      "revision",
      "cycle",
      "actor",
      "product build",
      "wrong binding",
      "verifier outage",
    ] as const)(
      "holds a test with %s without creating eligible work",
      async (mismatch) => {
        const f = resolutionLearningFixture(createStore());
        const terminal = await f.terminal();
        const context: ResolutionTrustContext = {
          ticketId: "ticket",
          ticketRevision:
            terminal.ticket.revision + (mismatch === "revision" ? 1 : 0),
          resolutionCycle:
            terminal.source.resolutionCycle + (mismatch === "cycle" ? 1 : 0),
          resolvedAt: terminal.ticket.resolvedAt!,
          actorId: mismatch === "actor" ? "staff/unrelated" : staff.principalId,
          acceptedAt: f.clock.now(),
        };
        const product = f.trust.productFor(context);
        if (mismatch !== "unknown receipt")
          f.trust.issueTest(
            "unqualified-execution",
            {
              ...context,
              product:
                mismatch === "product build"
                  ? { ...product, buildId: "client-claimed-build" }
                  : product,
            },
            mismatch === "wrong binding"
              ? { productBinding: "other-build" }
              : {},
          );
        if (mismatch === "verifier outage") f.trust.setTestOutage(true);
        const held = await f.app.submitResolutionEvidence(staff, {
          ...f.command("unqualified-test"),
          expectedRevision: terminal.ticket.revision,
          resolutionCycle: terminal.source.resolutionCycle,
          evidence: {
            kind: "successful_test",
            solutionMessageId: terminal.solutionMessageId,
            receipt: "unqualified-execution",
          },
        });
        expect(held).toMatchObject({ state: "held", sourceGeneration: 0 });
        expect(
          (await f.rows()).filter(
            (row) => row.kind === "resolution_learning_work",
          ),
        ).toEqual([]);
        expect(
          (await f.app.readStaffTicket(staff, "ticket")).ticket.status,
        ).toBe("resolved");
      },
    );

    it.each(["llm_claim", "status_resolved", "successful_test"] as const)(
      "rejects caller-controlled %s success or build flags",
      async (kind) => {
        const f = resolutionLearningFixture(createStore());
        const terminal = await f.terminal();
        const command = {
          ...f.command("untrusted-proof"),
          expectedRevision: terminal.ticket.revision,
          resolutionCycle: terminal.source.resolutionCycle,
          evidence: {
            kind,
            solutionMessageId: terminal.solutionMessageId,
            passed: true,
            buildId: "client-claimed-build",
            receipt: "client-passed",
          },
        } as unknown as SubmitResolutionEvidenceCommand;
        const before = await f.rows();
        await expect(
          f.app.submitResolutionEvidence(staff, command),
        ).rejects.toBeInstanceOf(TypeError);
        expect(await f.rows()).toEqual(before);
        expect(f.trust.testCalls).toEqual([]);
      },
    );

    it("holds test eligibility when no trusted test-receipt port is configured", async () => {
      const f = resolutionLearningFixture(createStore(), {
        resolutionLearning: { testReceipts: undefined },
      });
      const terminal = await f.terminal();
      const held = await f.app.submitResolutionEvidence(staff, {
        ...f.command("no-test-verifier"),
        expectedRevision: terminal.ticket.revision,
        resolutionCycle: terminal.source.resolutionCycle,
        evidence: {
          kind: "successful_test",
          solutionMessageId: terminal.solutionMessageId,
          receipt: "unverified-pass-claim",
        },
      });
      expect(held).toMatchObject({ state: "held", sourceGeneration: 0 });
      expect(f.trust.testCalls).toEqual([]);
      expect(
        (await f.rows()).filter(
          (row) => row.kind === "resolution_learning_work",
        ),
      ).toEqual([]);
      expect(
        (await f.app.readCustomerTicket(customer, "ticket")).ticket.status,
      ).toBe("resolved");
    });

    it.each(["missing", "outage", "expired"] as const)(
      "preserves customer confirmation when trusted product context is %s",
      async (outcome) => {
        const f = resolutionLearningFixture(createStore());
        await f.terminal();
        f.trust.setProductOutcome(outcome);
        const accepted = await f.confirm();
        expect(accepted.result.ticket.status).toBe("resolved");
        expect(accepted.source).toMatchObject({
          state: "held",
          sourceGeneration: 0,
          pendingProofReference: `success:${accepted.command.commandId}`,
        });
        expect(accepted.source.evidence).toBeUndefined();
        expect(
          (await f.rows()).filter((row) => row.kind === "customer_success"),
        ).toHaveLength(1);
        expect(
          (await f.rows()).filter(
            (row) => row.kind === "resolution_learning_work",
          ),
        ).toEqual([]);
        expect(
          (await f.app.readCustomerSuccessConfirmations(staff, "ticket"))[0],
        ).toMatchObject({ confirmedBy: customer.principalId });
      },
    );

    it("keeps enrolled human support available without any trust or learning configuration", async () => {
      const f = resolutionLearningFixture(createStore());
      await f.terminal();
      const plain = f.freshApplication({ resolutionLearning: undefined });
      const detail = await plain.readCustomerTicket(customer, "ticket");
      await plain.confirmCustomerSuccess(customer, {
        ...f.command("plain-confirm"),
        lastSeenVisibleMessageId: detail.messages.at(-1)!.id,
      });
      expect((await f.source()).state).toBe("held");
      expect(
        (await f.rows()).filter((row) => row.kind === "customer_success"),
      ).toHaveLength(1);
      expect(
        (await f.rows()).filter(
          (row) => row.kind === "resolution_learning_work",
        ),
      ).toEqual([]);
      await plain.requestPerson(customer, f.command("plain-human"));
      expect(
        (await plain.readStaffTicket(staff, "ticket")).ticket.handling?.state,
      ).toBe("human-pending");
    });

    it("does not reinterpret historical success when explicitly enrolling a legacy ticket", async () => {
      const f = resolutionLearningFixture(createStore());
      const legacy = f.freshApplication({ resolutionLearning: undefined });
      await legacy.createCustomerTicket(customer, f.createInput(false));
      await legacy.confirmCustomerSuccess(customer, {
        ...f.command("old-success"),
        lastSeenVisibleMessageId: "initial-ticket",
      });
      const ticket = (await legacy.readStaffTicket(staff, "ticket")).ticket;
      await f.app.enrollResolutionLearning(staff, {
        ...f.command("explicit-enroll"),
        expectedRevision: ticket.revision,
      });
      expect(await f.source()).toMatchObject({
        state: "unverified",
        sourceGeneration: 0,
        resolutionCycle: 1,
      });
      expect(
        (await f.rows()).filter(
          (row) => row.kind === "resolution_learning_work",
        ),
      ).toEqual([]);
      expect(f.trust.productCalls).toEqual([]);
    });

    it("accepts a fresh scoped customer confirmation after enrollment without reinterpreting an old unscoped receipt", async () => {
      const f = resolutionLearningFixture(createStore());
      const legacy = f.freshApplication({ resolutionLearning: undefined });
      await legacy.createCustomerTicket(customer, f.createInput(false));
      const historicalCommand = {
        ...f.command("pre-enrollment-confirmation"),
        lastSeenVisibleMessageId: "initial-ticket",
      };
      await legacy.confirmCustomerSuccess(customer, historicalCommand);
      const historicalRows = await f.rows();
      const historicalProof = historicalRows.find(
        (row) => row.kind === "customer_success",
      );
      expect(historicalProof).not.toHaveProperty("resolutionCycle");
      const ticket = (await f.app.readStaffTicket(staff, "ticket")).ticket;
      await f.app.enrollResolutionLearning(staff, {
        ...f.command("enroll-after-confirmation"),
        expectedRevision: ticket.revision,
      });
      const enrolledRows = await f.rows();
      await f.app.confirmCustomerSuccess(customer, historicalCommand);
      expect(await f.rows()).toEqual(enrolledRows);
      expect(await f.source()).toMatchObject({
        state: "unverified",
        sourceGeneration: 0,
        resolutionCycle: 1,
      });
      expect(f.trust.productCalls).toEqual([]);
      const freshCommand = {
        ...f.command("fresh-scoped-confirmation"),
        lastSeenVisibleMessageId: "initial-ticket",
      };
      await f.app.confirmCustomerSuccess(customer, freshCommand);
      const accepted = await f.source();
      expect(accepted).toMatchObject({
        state: "eligible",
        sourceGeneration: 1,
        resolutionCycle: 1,
        generationCount: 1,
        product: { buildId: "build-verified-230" },
        evidence: {
          kind: "customer_confirmation",
          actorId: customer.principalId,
          lastVisibleMessageId: "initial-ticket",
        },
      });
      expect(f.trust.productCalls).toHaveLength(1);
      expect(f.trust.productCalls[0]).toMatchObject({
        ticketRevision: accepted.acceptedTicketRevision,
        resolutionCycle: 1,
        actorId: customer.principalId,
      });
      const proofs = (await f.rows()).filter(
        (row) => row.kind === "customer_success",
      );
      expect(proofs).toHaveLength(2);
      expect(proofs).toEqual(
        expect.arrayContaining([
          historicalProof,
          expect.objectContaining({
            commandId: freshCommand.commandId,
            resolutionCycle: 1,
          }),
        ]),
      );
      expect(
        (await f.rows()).filter(
          (row) => row.kind === "resolution_learning_work",
        ),
      ).toHaveLength(1);
      const rows = await f.rows();
      await f.app.confirmCustomerSuccess(customer, freshCommand);
      await f.app.confirmCustomerSuccess(customer, {
        ...freshCommand,
        ...f.command("same-scoped-proof-new-command"),
      });
      expect(await f.rows()).toEqual(rows);
      expect(await f.source()).toEqual(accepted);
      expect(f.trust.productCalls).toHaveLength(1);
    });

    it("records new verified facts while processing is disabled and retains existing facts without trust ports", async () => {
      const f = resolutionLearningFixture(createStore());
      await f.terminal();
      const paused = f.freshApplication({
        resolutionLearning: { ...f.learningOptions, enabled: false },
      });
      const current = await paused.readCustomerTicket(customer, "ticket");
      await paused.confirmCustomerSuccess(customer, {
        ...f.command("paused-confirm"),
        lastSeenVisibleMessageId: current.messages.at(-1)!.id,
      });
      const source = await f.source();
      expect(source.state).toBe("eligible");
      const fence: ResolutionSourceFence = {
        ticketId: "ticket",
        sourceGeneration: source.sourceGeneration,
        resolutionCycle: source.resolutionCycle,
        sourceBindingHash: source.sourceBindingHash!,
      };
      expect(await paused.confirmResolutionLearningSource(service, fence)).toBe(
        true,
      );
      expect(
        await paused.claimResolutionLearningWork(service, {
          ticketId: "ticket",
          sourceGeneration: source.sourceGeneration,
          workerId: "paused-worker",
          claimId: "paused-claim",
          leaseMilliseconds: 1_000,
        }),
      ).toBeNull();
      f.advance(120_000);
      const unconfigured = f.freshApplication({
        resolutionLearning: undefined,
      });
      expect(
        await unconfigured.confirmResolutionLearningSource(service, fence),
      ).toBe(true);
      expect(await f.source()).toEqual(source);
    });

    it.each(["changed", "failure"] as const)(
      "keeps evidence, source, job, Audit and receipt atomic on %s transaction",
      async (failure) => {
        const f = resolutionLearningFixture(createStore(), {
          maxConflictAttempts: 1,
        });
        await f.terminal();
        const detail = await f.app.readCustomerTicket(customer, "ticket");
        const command = {
          ...f.command("atomic-confirm"),
          lastSeenVisibleMessageId: detail.messages.at(-1)!.id,
        };
        const before = await f.rows();
        f.observed.intercept(async (trace, commit) => {
          if (trace.collection !== "support-desk.records.v1") return commit();
          if (failure === "failure")
            throw new Error("Synthetic transaction failure");
          return { committed: false, reason: "changed" };
        });
        await expect(
          f.app.confirmCustomerSuccess(customer, command),
        ).rejects.toThrow();
        f.observed.intercept(undefined);
        expect(await f.rows()).toEqual(before);
        await f.app.confirmCustomerSuccess(customer, command);
        expect((await f.source()).state).toBe("eligible");
        expect(
          (await f.rows()).filter(
            (row) => row.kind === "resolution_learning_work",
          ),
        ).toHaveLength(1);
      },
    );

    it("rechecks the exact source and ticket fence after a real concurrent reopen", async () => {
      const f = resolutionLearningFixture(createStore());
      const terminal = await f.terminal();
      const gate = handlingBarrier();
      let paused = false;
      f.observed.intercept(async (trace, commit) => {
        if (
          !paused &&
          trace.collection === "support-desk.records.v1" &&
          trace.actions.some(
            (action) =>
              action.action !== "delete" &&
              (action.value as SupportRecord).kind ===
                "resolution_learning_work",
          )
        ) {
          paused = true;
          await gate.wait();
        }
        return commit();
      });
      const pending = f.app
        .submitResolutionEvidence(staff, {
          ...f.command("racing-proof"),
          expectedRevision: terminal.ticket.revision,
          resolutionCycle: terminal.source.resolutionCycle,
          evidence: {
            kind: "staff_verified_fix",
            solutionMessageId: terminal.solutionMessageId,
            verificationReference: "staging/export-race",
          },
        })
        .then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
      let concurrentRows;
      try {
        await Promise.race([
          gate.reached,
          pending.then(() => {
            throw new Error(
              "Evidence did not reach its real transaction barrier",
            );
          }),
        ]);
        await f
          .freshApplication()
          .reopenTicket(staff, f.command("concurrent-reopen"));
        concurrentRows = await f.rows();
      } finally {
        gate.release();
      }
      expect(await pending).toHaveProperty("error");
      f.observed.intercept(undefined);
      expect(await f.rows()).toEqual(concurrentRows);
      expect(await f.source()).toMatchObject({
        state: "held",
        resolutionCycle: 2,
        sourceGeneration: 1,
      });
      expect(
        (await f.rows()).filter(
          (row) => row.kind === "resolution_learning_work",
        ),
      ).toEqual([]);
    });
  });
}
