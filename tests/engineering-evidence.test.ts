import {
  createInboundMailProcessor,
  supportPermissions,
  type EngineeringEvidenceInput,
  type EngineeringTrustContext,
  type SubmitEngineeringEvidenceCommand,
  type SupportRecord,
} from "@pegma/support-desk-application";
import { describe, expect, it } from "vitest";
import {
  engineeringBarrier,
  engineeringCustomer as customer,
  engineeringFixture,
  engineeringService as service,
  engineeringStaff as staff,
  engineeringStores,
} from "../test/engineering-fixtures.js";

type Fixture = ReturnType<typeof engineeringFixture>;
async function staffCommand(
  f: Fixture,
  label = "verified-failure",
): Promise<SubmitEngineeringEvidenceCommand> {
  const ticket = (await f.app.readStaffTicket(staff, "ticket")).ticket;
  return {
    ...f.command(label),
    expectedRevision: ticket.revision,
    security: "ordinary",
    evidence: await f.reportInput(),
  };
}

for (const [name, createStore] of engineeringStores) {
  describe(`engineering failure evidence (${name})`, () => {
    it("preallocates unverified source authority without turning resolved status or customer success into bug evidence", async () => {
      const f = engineeringFixture(createStore());
      await f.create();
      expect(await f.source()).toMatchObject({
        state: "unverified",
        sourceGeneration: 0,
        generationCount: 0,
      });
      await f.app.resolveTicket(staff, f.command("ordinary-resolution"));
      await f.app.confirmCustomerSuccess(customer, {
        ...f.command("customer-success"),
        lastSeenVisibleMessageId: "initial-ticket",
      });
      expect((await f.source()).state).not.toBe("eligible");
      expect(
        (await f.rows()).filter((row) => row.kind === "engineering_work"),
      ).toEqual([]);
      expect(f.trust.productCalls).toEqual([]);
    });

    it("explicitly enrolls a historical ticket without reinterpreting old success receipts", async () => {
      const f = engineeringFixture(createStore(), { engineering: undefined });
      await f.create();
      await f.app.confirmCustomerSuccess(customer, {
        ...f.command("old-success"),
        lastSeenVisibleMessageId: "initial-ticket",
      });
      await expect(f.source()).rejects.toThrow();
      const enabled = f.freshApplication({ engineering: f.engineeringOptions });
      const ticket = (await enabled.readStaffTicket(staff, "ticket")).ticket;
      await enabled.enrollEngineeringSource(staff, {
        ...f.command("explicit-engineering-enrollment"),
        expectedRevision: ticket.revision,
      });
      expect(await f.source()).toMatchObject({
        state: "unverified",
        generationCount: 0,
      });
      expect(
        (await f.rows()).filter((row) => row.kind === "engineering_work"),
      ).toEqual([]);
      expect(f.trust.productCalls).toEqual([]);
    });

    it("accepts a staff-verified failure on an active ticket in one ticket/source/work/Audit/receipt transaction", async () => {
      const f = engineeringFixture(createStore());
      await f.create();
      const command = await staffCommand(f);
      const before = await f.rows();
      f.observed.transactions.length = 0;
      const result = await f.app.submitEngineeringEvidence(staff, command);
      const accepted = await f.source();
      expect(result).toMatchObject({
        state: "eligible",
        security: "ordinary",
        sourceGeneration: 1,
      });
      expect(accepted).toMatchObject({
        acceptedTicketRevision: command.expectedRevision,
        evidence: { ...command.evidence, actorId: staff.principalId },
        product: { productId: "workspace", buildId: "build-verified-230" },
      });
      expect(await f.work()).toMatchObject({
        status: "pending",
        stage: "model",
        sourceGeneration: accepted.sourceGeneration,
        sourceBindingHash: accepted.sourceBindingHash,
        terminalReserveRows: 0,
      });
      expect(
        (await f.app.readStaffTicket(staff, "ticket")).ticket,
      ).toMatchObject({ status: "open", revision: command.expectedRevision });
      expect((await f.rows()).length - before.length).toBe(3);
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
          "engineering_source",
          "engineering_work",
          "audit",
          "engineering_receipt",
        ]),
      );
      expect(
        new Set(writes.map((action) => (action.value as SupportRecord).id))
          .size,
      ).toBe(writes.length);
      const rows = await f.rows();
      expect(await f.app.submitEngineeringEvidence(staff, command)).toEqual(
        result,
      );
      expect(await f.rows()).toEqual(rows);
    });

    it("keeps notes, profiles, private proof, and repository configuration out of customer DTOs", async () => {
      const f = engineeringFixture(createStore());
      await f.eligible();
      const visible = JSON.stringify(
        await f.app.readCustomerTicket(customer, "ticket"),
      );
      for (const secret of [
        "PRIVATE_ENGINEERING_INTERNAL_NOTE",
        "PRIVATE_ENGINEERING_VERIFICATION_REFERENCE",
        staff.principalId,
        customer.principalId,
        "engineering-customer@fixtures.invalid",
        "engineering_source",
        "engineering_work",
        "sourceBindingHash",
        "repository-101",
      ])
        expect(visible).not.toContain(secret);
      await expect(
        f.app.readEngineeringSource(customer, "ticket"),
      ).rejects.toThrow();
      await expect(
        f.app.readEngineeringWork(customer, {
          ticketId: "ticket",
          sourceGeneration: (await f.source()).sourceGeneration,
        }),
      ).rejects.toThrow();
      const claim = await f.claim();
      expect(JSON.stringify(claim.messages)).not.toContain(
        "PRIVATE_ENGINEERING_INTERNAL_NOTE",
      );
      expect(JSON.stringify(claim.messages)).not.toContain(
        "PRIVATE_ENGINEERING_VERIFICATION_REFERENCE",
      );
    });

    it.each([
      "customer_confirmation",
      "successful_test",
      "llm_assertion",
    ] as const)(
      "does not accept %s or caller-supplied passed/build flags as a verified bug",
      async (kind) => {
        const f = engineeringFixture(createStore());
        await f.create();
        const command = await staffCommand(f);
        const before = await f.rows();
        await expect(
          f.app.submitEngineeringEvidence(staff, {
            ...command,
            evidence: {
              ...command.evidence,
              kind,
              passed: true,
              buildId: "client-claimed-build",
            } as unknown as EngineeringEvidenceInput,
          }),
        ).rejects.toThrow();
        expect(await f.rows()).toEqual(before);
        expect(f.trust.testCalls).toEqual([]);
      },
    );

    it("coalesces the same explicit staff proof across fresh attestations while a genuinely different proof creates a new generation", async () => {
      const f = engineeringFixture(createStore());
      await f.create();
      const first = await staffCommand(f);
      await f.app.submitEngineeringEvidence(staff, first);
      const accepted = await f.source();
      f.advance();
      await f.app.submitEngineeringEvidence(staff, {
        ...first,
        ...f.command("same-proof-new-command"),
      });
      expect(await f.source()).toEqual(accepted);
      expect(
        (await f.rows()).filter((row) => row.kind === "engineering_work"),
      ).toHaveLength(1);
      const changed: SubmitEngineeringEvidenceCommand = {
        ...first,
        ...f.command("different-staff-proof"),
        evidence: {
          ...(await f.reportInput()),
          verificationReference: "different-stable-engineering-verification",
        },
      };
      await f.app.submitEngineeringEvidence(staff, changed);
      const current = await f.source();
      expect(current.sourceGeneration).toBe(accepted.sourceGeneration + 1);
      expect(current.evidenceFingerprint).not.toBe(
        accepted.evidenceFingerprint,
      );
      expect(current.sourceBindingHash).not.toBe(accepted.sourceBindingHash);
      expect(
        (await f.rows()).filter((row) => row.kind === "engineering_work"),
      ).toHaveLength(2);
      expect(
        await f.app.claimEngineeringWork(service, {
          ticketId: "ticket",
          sourceGeneration: accepted.sourceGeneration,
          workerId: "old-proof-worker",
          claimId: "old-proof-claim",
          leaseMilliseconds: 1_000,
        }),
      ).toBeNull();
    });

    it("accepts only the exact host-verified failing execution including expected/actual behavior and reproduction", async () => {
      const f = engineeringFixture(createStore());
      await f.eligible("failed_test");
      expect((await f.source()).evidence).toMatchObject({
        kind: "failed_test",
        actorId: staff.principalId,
        test: {
          result: "failed",
          runnerId: "trusted-failing-test-runner",
          testId: "workspace-export-rows",
        },
      });
      expect(f.trust.testCalls).toHaveLength(1);
      expect(f.trust.testCalls[0]!.context.evidence).toMatchObject({
        expectedBehavior: "Export contains the workspace rows.",
        actualBehavior: "Export contains no rows.",
        visibleMessageIds: ["initial-ticket"],
      });
    });

    it.each([
      "actor",
      "revision",
      "source generation",
      "build",
      "reproduction",
      "runner",
      "expired",
      "unknown receipt",
    ] as const)(
      "holds a failing-test receipt with %s mismatch without eligible work",
      async (mismatch) => {
        const f = engineeringFixture(createStore());
        await f.create();
        const command = await staffCommand(f);
        const {
          kind: _kind,
          verificationReference: _reference,
          ...evidence
        } = await f.reportInput();
        const context: EngineeringTrustContext = {
          ticketId: "ticket",
          ticketRevision:
            command.expectedRevision + (mismatch === "revision" ? 1 : 0),
          sourceGeneration:
            (await f.source()).sourceGeneration +
            (mismatch === "source generation" ? 1 : 0),
          actorId:
            mismatch === "actor" ? "wrong-submitting-actor" : staff.principalId,
          acceptedAt: f.clock.now(),
        };
        const product = f.trust.productFor(context);
        if (mismatch !== "unknown receipt")
          f.trust.issueTest(
            "host-test-receipt",
            {
              ...context,
              product:
                mismatch === "build"
                  ? { ...product, buildId: "different-build" }
                  : product,
              evidence:
                mismatch === "reproduction"
                  ? { ...evidence, actualBehavior: "A different test failed." }
                  : evidence,
            },
            mismatch === "runner"
              ? { runnerId: "untrusted-runner" }
              : mismatch === "expired"
                ? {
                    verifiedAt: new Date(
                      Date.parse(f.clock.now()) - 2_000,
                    ).toISOString(),
                    validUntil: new Date(
                      Date.parse(f.clock.now()) - 1_000,
                    ).toISOString(),
                  }
                : {},
          );
        await f.app.submitEngineeringEvidence(staff, {
          ...command,
          evidence: {
            ...evidence,
            kind: "failed_test",
            receipt: "host-test-receipt",
          },
        });
        expect((await f.source()).state).toBe("held");
        expect(
          (await f.rows()).filter((row) => row.kind === "engineering_work"),
        ).toEqual([]);
        expect(
          (await f.app.readStaffTicket(staff, "ticket")).ticket.status,
        ).toBe("open");
      },
    );

    it.each(["missing", "outage"] as const)(
      "preserves human support when trusted product context is %s",
      async (outcome) => {
        const f = engineeringFixture(createStore());
        await f.create();
        f.trust.state.productOutcome = outcome;
        await f.app.submitEngineeringEvidence(staff, await staffCommand(f));
        expect((await f.source()).state).toBe("held");
        expect(
          (await f.rows()).filter((row) => row.kind === "engineering_work"),
        ).toEqual([]);
        await f.app.replyToCustomerTicket(customer, {
          ...f.command("human-followup"),
          messageId: "human-followup",
          body: "A person can still help with this export.",
        });
        await f.app.replyAsStaff(staff, {
          ...f.command("human-answer"),
          messageId: "human-answer",
          body: "We are investigating the failure.",
        });
        expect(
          (await f.app.readCustomerTicket(customer, "ticket")).messages,
        ).toHaveLength(3);
      },
    );

    it.each(["restricted", "uncertain"] as const)(
      "keeps %s security cases out of ordinary work and behind dedicated read authority",
      async (security) => {
        const f = engineeringFixture(createStore());
        await f.eligible("staff_verified_failure", "ticket", security);
        expect(await f.source()).toMatchObject({
          state: "restricted",
          security,
        });
        expect(
          (await f.rows()).filter((row) => row.kind === "engineering_work"),
        ).toEqual([]);
        await expect(
          f.app.readEngineeringSource(
            {
              ...staff,
              permissions: staff.permissions.filter(
                (permission) =>
                  permission !== supportPermissions.engineeringRestrictedRead,
              ),
            },
            "ticket",
          ),
        ).rejects.toThrow();
        expect(
          (await f.app.scanEngineeringCandidates(service, { limit: 100 }))
            .candidates,
        ).toEqual([]);
      },
    );

    it("requires dedicated security review before an existing restricted source can become ordinary", async () => {
      const f = engineeringFixture(createStore());
      await f.eligible("staff_verified_failure", "ticket", "restricted");
      const command = await staffCommand(f, "attempt-ordinary-clearance");
      const before = await f.rows();
      await expect(
        f.app.submitEngineeringEvidence(
          {
            ...staff,
            permissions: staff.permissions.filter(
              (permission) =>
                permission !== supportPermissions.engineeringSecurityReview,
            ),
          },
          command,
        ),
      ).rejects.toMatchObject({
        permission: supportPermissions.engineeringSecurityReview,
      });
      expect(await f.rows()).toEqual(before);
      expect((await f.source()).state).toBe("restricted");
    });

    it("retains accepted bug facts after proof attestation age and when generation configuration is omitted", async () => {
      const f = engineeringFixture(createStore());
      await f.eligible();
      const accepted = await f.source();
      f.advance(60_001);
      const plain = f.freshApplication({ engineering: undefined });
      expect(await plain.readEngineeringSource(staff, "ticket")).toEqual(
        accepted,
      );
      expect(await f.claim()).toBeDefined();
      expect(await f.source()).toEqual(accepted);
    });

    it("requires current evidence authority and exact revision even when replaying accepted input", async () => {
      const f = engineeringFixture(createStore());
      await f.create();
      const command = await staffCommand(f);
      await expect(
        f.app.submitEngineeringEvidence(staff, {
          ...command,
          expectedRevision: command.expectedRevision + 1,
        }),
      ).rejects.toThrow();
      await f.app.submitEngineeringEvidence(staff, command);
      const rows = await f.rows();
      await expect(
        f.app.submitEngineeringEvidence(
          {
            ...staff,
            permissions: staff.permissions.filter(
              (permission) =>
                permission !== supportPermissions.engineeringEvidenceSubmit,
            ),
          },
          command,
        ),
      ).rejects.toThrow();
      await expect(
        f.app.submitEngineeringEvidence(
          { ...staff, principalId: "another-staff-actor" },
          command,
        ),
      ).rejects.toThrow();
      expect(await f.rows()).toEqual(rows);
    });

    it("rejects permission revocation while an actual proof transaction waits for trusted product facts", async () => {
      const gate = engineeringBarrier();
      let f!: Fixture;
      f = engineeringFixture(createStore(), {
        engineering: {
          productContext: {
            async resolve(context) {
              const product = f.trust.productFor(context);
              await gate.wait();
              return product;
            },
          },
        },
      });
      await f.create();
      const command = await staffCommand(f);
      const permissions = [...staff.permissions];
      const actor = { ...staff, permissions };
      const before = await f.rows();
      const pending = f.app.submitEngineeringEvidence(actor, command).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      try {
        await Promise.race([
          gate.reached,
          pending.then(() => {
            throw new Error(
              "Engineering proof did not reach its product-verification barrier",
            );
          }),
        ]);
        permissions.splice(
          permissions.indexOf(supportPermissions.engineeringEvidenceSubmit),
          1,
        );
      } finally {
        gate.release();
      }
      expect(await pending).toHaveProperty("error");
      expect(await f.rows()).toEqual(before);
    });

    it.each([
      "request person",
      "customer reply",
      "staff reply",
      "reopen",
      "inbound append",
    ] as const)(
      "invalidates persisted evidence through %s with engineering configuration omitted",
      async (change) => {
        const f = engineeringFixture(createStore());
        const key = await f.eligible();
        const plain = f.freshApplication({ engineering: undefined });
        if (change === "request person" || change === "reopen")
          await plain.resolveTicket(staff, f.command("terminal-before-reopen"));
        const before = await f.source();
        f.observed.transactions.length = 0;
        if (change === "request person")
          await plain.requestPerson(
            customer,
            f.command("plain-request-person"),
          );
        else if (change === "customer reply")
          await plain.replyToCustomerTicket(customer, {
            ...f.command("plain-customer-reply"),
            messageId: "changed-visible-report",
            body: "The failure has changed.",
          });
        else if (change === "staff reply")
          await plain.replyAsStaff(staff, {
            ...f.command("plain-staff-reply"),
            messageId: "changed-visible-staff-report",
            body: "We found another reproduction detail.",
          });
        else if (change === "reopen")
          await plain.reopenTicket(staff, f.command("plain-explicit-reopen"));
        else {
          const ticket = (await plain.readStaffTicket(staff, "ticket")).ticket;
          const processor = createInboundMailProcessor({
            store: f.store,
            clock: f.clock,
            subjectMarkerPrefix: "SD",
            accountMatcher: {
              matchSenderEmail: async () => ({
                matches: "one",
                principalId: customer.principalId,
              }),
            },
            routingPolicy: {
              routeNewConversation: () => ({ priority: "normal" }),
            },
          });
          const result = await processor.processInboundEmail({
            channelId: "engineering-mail",
            providerEventId: "engineering-reproduction-change",
            ticketId: "unused-inbound-ticket",
            messageId: "changed-inbound-report",
            correlationId: "engineering-inbound-change",
            from: "engineering-customer@fixtures.invalid",
            senderAuthentication: {
              method: "host_identity",
              result: "pass",
              email: "engineering-customer@fixtures.invalid",
            },
            subject: `Re: [SD-${ticket.number}] Export failure`,
            body: "The reproduction has changed by email.",
          });
          expect(result).toMatchObject({
            outcome: "replied",
            ticketId: "ticket",
          });
        }
        expect(await f.source()).toMatchObject({
          state: "held",
          sourceGeneration: before.sourceGeneration + 1,
        });
        expect(
          await f.app.claimEngineeringWork(service, {
            ...key,
            workerId: "stale-evidence-worker",
            claimId: "stale-evidence-claim",
            leaseMilliseconds: 1_000,
          }),
        ).toBeNull();
        const transactions = f.observed.transactions.filter(
          (trace) =>
            trace.collection === "support-desk.records.v1" &&
            trace.partition === "ticket",
        );
        expect(transactions).toHaveLength(1);
        const writes = transactions[0]!.actions.filter(
          (action) => action.action !== "delete",
        );
        expect(
          writes.filter(
            (action) => (action.value as SupportRecord).kind === "ticket",
          ),
        ).toHaveLength(1);
        expect(
          writes.filter(
            (action) =>
              (action.value as SupportRecord).kind === "engineering_source",
          ),
        ).toHaveLength(1);
        expect(
          new Set(writes.map((action) => (action.value as SupportRecord).id))
            .size,
        ).toBe(writes.length);
      },
    );

    it("preserves accepted source facts through assignment, priority, tags, and private notes", async () => {
      const f = engineeringFixture(createStore(), { allowedTags: ["triage"] });
      await f.eligible();
      const before = await f.source();
      await f.app.assignTicket(staff, {
        ...f.command("metadata-assignment"),
        assigneeId: "assigned-engineer",
      });
      await f.app.changePriority(staff, {
        ...f.command("metadata-priority"),
        priority: "high",
      });
      await f.app.setTags(staff, {
        ...f.command("metadata-tags"),
        tags: ["triage"],
      });
      await f.app.addNote(staff, {
        ...f.command("metadata-note"),
        messageId: "private-metadata-note",
        body: "PRIVATE_LATER_ENGINEERING_NOTE",
      });
      expect(await f.source()).toEqual(before);
      expect(await f.claim()).toBeDefined();
    });

    it.each([
      "privacy_withdrawal",
      "source_access_revoked",
      "source_deleted",
    ] as const)(
      "permanently withdraws %s without retaining candidate or proof bodies",
      async (reason) => {
        const f = engineeringFixture(createStore());
        const key = await f.eligible();
        const candidate = await f.prepareCandidate();
        const before = await f.source();
        const command = { ...f.command("withdraw-engineering-source"), reason };
        const withdrawn = await f.app.withdrawEngineeringSource(staff, command);
        expect(await f.source()).toMatchObject({
          state: "withdrawn",
          heldReason: reason,
          sourceGeneration: before.sourceGeneration + 1,
        });
        const work = await f.work("ticket", key.sourceGeneration);
        expect(work.candidate).toBeUndefined();
        expect(work.evidence).toBeUndefined();
        expect(work.product).toBeUndefined();
        expect(
          JSON.stringify({ source: await f.source(), work }),
        ).not.toContain(candidate.candidate.summary);
        const rows = await f.rows();
        expect(await f.app.withdrawEngineeringSource(staff, command)).toEqual(
          withdrawn,
        );
        expect(await f.rows()).toEqual(rows);
        await f.app.replyToCustomerTicket(customer, {
          ...f.command("human-after-withdrawal"),
          messageId: "post-withdrawal-reply",
          body: "A person can continue helping.",
        });
        await f.app.submitEngineeringEvidence(
          staff,
          await staffCommand(f, "fresh-proof-after-withdrawal"),
        );
        expect(await f.source()).toMatchObject({
          state: "withdrawn",
          heldReason: reason,
        });
        expect((await f.source()).evidence).toBeUndefined();
        expect(
          (await f.rows()).filter((row) => row.kind === "engineering_work"),
        ).toHaveLength(1);
      },
    );

    it.each(["changed", "failure"] as const)(
      "keeps proof, source, job, Audit, and receipt atomic on %s",
      async (failure) => {
        const f = engineeringFixture(createStore(), { maxConflictAttempts: 1 });
        await f.create();
        const command = await staffCommand(f);
        const before = await f.rows();
        f.observed.intercept(async (trace, commit) => {
          if (
            trace.collection !== "support-desk.records.v1" ||
            trace.partition !== "ticket"
          )
            return commit();
          if (failure === "failure")
            throw new Error("Synthetic evidence commit failure");
          return { committed: false, reason: "changed" };
        });
        await expect(
          f.app.submitEngineeringEvidence(staff, command),
        ).rejects.toThrow();
        f.observed.intercept(undefined);
        expect(await f.rows()).toEqual(before);
        await f.app.submitEngineeringEvidence(staff, command);
        expect((await f.source()).state).toBe("eligible");
        expect(
          (await f.rows()).filter((row) => row.kind === "engineering_work"),
        ).toHaveLength(1);
      },
    );
  });
}
