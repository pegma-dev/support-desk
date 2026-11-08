import { createSupportDeskEngineering } from "@pegma/support-desk-ai";
import {
  supportPermissions,
  supportRecords,
  type EngineeringWorkRecord,
} from "@pegma/support-desk-application";
import { describe, expect, it } from "vitest";
import {
  engineeringBarrier,
  engineeringAiFixture,
  engineeringCustomer as customer,
  engineeringFixture,
  engineeringRepositories,
  engineeringService as service,
  engineeringStaff as staff,
  engineeringStores,
} from "../test/engineering-fixtures.js";

for (const [name, createStore] of engineeringStores) {
  describe(`engineering durable work (${name})`, () => {
    it("claims only the current eligible source and excludes private staff notes", async () => {
      const f = engineeringFixture(createStore());
      const key = await f.eligible();
      const before = (await f.app.readStaffTicket(staff, "ticket")).ticket;
      const owner = await f.claim();

      expect(owner.sourceFence).toMatchObject(key);
      expect(owner.messages).toHaveLength(1);
      expect(JSON.stringify(owner.messages)).not.toContain(
        "PRIVATE_ENGINEERING_INTERNAL_NOTE",
      );
      expect(JSON.stringify(owner.messages)).not.toContain(
        "PRIVATE_ENGINEERING_VERIFICATION_REFERENCE",
      );
      expect((await f.app.readStaffTicket(staff, "ticket")).ticket).toEqual(
        before,
      );
      await f.app.invalidateEngineeringSource(staff, {
        ...f.command("invalidate-claimed-source"),
        reason: "evidence_revoked",
      });
      await expect(
        f.app.claimEngineeringWork(service, {
          ...key,
          workerId: "wrong-generation-worker",
          claimId: "wrong-generation-claim",
          leaseMilliseconds: 10_000,
        }),
      ).resolves.toBeNull();
    });

    it("keeps distinct physical invocations out of an unexpired claim", async () => {
      const f = engineeringFixture(createStore());
      const key = await f.eligible();
      const owner = await f.claim("physical-one", "worker-one");
      const before = await f.rows();

      await expect(
        f.app.claimEngineeringWork(service, {
          ...key,
          workerId: "worker-two",
          claimId: "physical-two",
          leaseMilliseconds: 10_000,
        }),
      ).resolves.toBeNull();
      expect(await f.rows()).toEqual(before);
      expect((await f.work()).claim).toEqual(owner.fence);
    });

    it("recovers an exact prepared model request without adding a second attempt", async () => {
      const f = engineeringFixture(createStore());
      await f.eligible();
      const owner = await f.claim();
      const command = {
        ...owner.fence,
        binding: await f.modelBinding(owner),
      };
      const prepared = await f.app.prepareEngineeringModel(service, command);
      const before = await f.rows();

      await expect(
        f.app.prepareEngineeringModel(service, command),
      ).resolves.toEqual(prepared);
      expect(await f.rows()).toEqual(before);
      expect((await f.work()).modelAttempts).toHaveLength(1);
      await expect(
        f.app.prepareEngineeringModel(service, {
          ...command,
          binding: {
            ...command.binding,
            inputFingerprint: "c".repeat(64),
          },
        }),
      ).rejects.toThrow();
      expect(await f.rows()).toEqual(before);
    });

    it("does not let an expired preparation owner complete after replacement", async () => {
      const f = engineeringFixture(createStore());
      await f.eligible();
      const owner = await f.claim("old-physical", "old-worker");
      const prepared = await f.app.prepareEngineeringModel(service, {
        ...owner.fence,
        binding: await f.modelBinding(owner),
      });
      f.advance(10_001);
      const replacement = await f.claim("new-physical", "new-worker");
      const before = await f.rows();

      await expect(
        f.app.completeEngineeringModel(
          service,
          {
            ...owner.fence,
            stepId: prepared.stepId,
            requestHash: prepared.requestHash,
            candidate: f.candidate(),
            accounting: "accounted",
          },
          async () => {},
        ),
      ).rejects.toThrow();
      expect(await f.rows()).toEqual(before);
      expect((await f.work()).claim).toEqual(replacement.fence);
      expect((await f.work()).candidate).toBeUndefined();
    });

    it("rechecks source eligibility after an awaited completion guard", async () => {
      const f = engineeringFixture(createStore());
      await f.eligible();
      const owner = await f.claim();
      const prepared = await f.app.prepareEngineeringModel(service, {
        ...owner.fence,
        binding: await f.modelBinding(owner),
      });
      const barrier = engineeringBarrier();
      const completing = f.app.completeEngineeringModel(
        service,
        {
          ...owner.fence,
          stepId: prepared.stepId,
          requestHash: prepared.requestHash,
          candidate: f.candidate(),
          accounting: "accounted",
        },
        () => barrier.wait(),
      );
      const settled = completing.then(
        () => ({ accepted: true }),
        () => ({ accepted: false }),
      );
      await barrier.reached;
      await f.app.replyToCustomerTicket(customer, {
        ...f.command("changed-before-completion"),
        messageId: "new-reproduction-context",
        body: "A different build is now affected.",
      });
      const source = await f.source();
      barrier.release();

      expect(await settled).toEqual({ accepted: false });
      expect((await f.source()).sourceGeneration).toBe(source.sourceGeneration);
      expect(
        (await f.work("ticket", owner.fence.sourceGeneration)).candidate,
      ).toBeUndefined();
    });

    it("rejects model work without the current processing permission", async () => {
      const f = engineeringFixture(createStore());
      const key = await f.eligible();
      const denied = {
        ...service,
        permissions: service.permissions.filter(
          (permission) => permission !== supportPermissions.engineeringProcess,
        ),
      };
      const before = await f.rows();
      await expect(
        f.app.claimEngineeringWork(denied, {
          ...key,
          workerId: "unauthorized-worker",
          claimId: "unauthorized-claim",
          leaseMilliseconds: 10_000,
        }),
      ).rejects.toThrow();
      expect(await f.rows()).toEqual(before);
    });
  });

  describe(`engineering approved dispatch (${name})`, () => {
    it("sends the exact staff-approved sanitized request only after durable dispatch-started", async () => {
      const f = await engineeringAiFixture(createStore());
      const prepared = await f.prepareProposal();
      const source = await f.source();
      await f.approve();
      const approved = await f.work();
      expect(approved.approval).toMatchObject({
        decision: "approve",
        sourceBindingHash: source.sourceBindingHash,
        proposalHash: prepared.work.proposal!.proposalHash,
        requestHash: prepared.work.proposal!.requestHash,
        repositoryMetadataHash: prepared.work.proposal!.repositoryMetadataHash,
        policyGeneration: prepared.work.proposal!.policyGeneration,
        policyHash: prepared.work.proposal!.policyHash,
      });
      expect(prepared.work.proposal!.checksBinding).toMatchObject({
        sourceBindingHash: source.sourceBindingHash,
        evidenceFingerprint: source.evidenceFingerprint,
      });
      f.setGitHubCreate(async (request) => {
        const durable = await f.work();
        expect(durable.status).toBe("dispatch_started");
        expect(durable.terminalReserveRows).toBe(2);
        expect(durable.dispatch).toMatchObject({
          repositoryId: request.repository.repositoryId,
          exportMarker: request.bundle.exportMarker,
          requestHash: prepared.work.proposal!.requestHash,
        });
        expect(request).toEqual(prepared.request);
        return f.acceptIssue(request);
      });
      // Already approved exports do not require another paid model invocation.
      f.state.configurationOutcome = "disabled";
      await f.engineering.processWork(f.nextCommand());

      expect(f.createIssue).toHaveBeenCalledTimes(1);
      expect(f.generate).toHaveBeenCalledTimes(1);
      expect((await f.work()).status).toBe("accepted");
      expect((await f.work()).terminalReserveRows).toBe(0);
    });

    it.each([
      "engineering review permission",
      "queue read permission",
      "reviewing principal",
    ] as const)(
      "rejects staff review when the caller's live %s changes during an awaited guard",
      async (change) => {
        const f = await engineeringAiFixture(createStore());
        await f.prepareProposal();
        const work = await f.work();
        const providedAccess = {
          ...staff,
          permissions: [...staff.permissions],
        };
        const before = await f.rows();
        const metadata = f.getMetadata.getMockImplementation()!;
        const barrier = engineeringBarrier();
        f.getMetadata.mockImplementationOnce(async (...args) => {
          await barrier.wait();
          return metadata(...args);
        });
        const reviewing = f.engineering.reviewProposal(providedAccess, {
          ...f.command("staff-review-live-authority"),
          sourceGeneration: f.key.sourceGeneration,
          expectedWorkGeneration: work.workGeneration,
          proposalHash: work.proposal!.proposalHash,
          decision: "approve",
        });
        const settled = reviewing.then(
          () => ({ approved: true }),
          () => ({ approved: false }),
        );
        await barrier.reached;
        try {
          if (change === "reviewing principal")
            providedAccess.principalId = "different-synthetic-reviewer";
          else {
            const revoked =
              change === "engineering review permission"
                ? supportPermissions.engineeringReview
                : supportPermissions.queueRead;
            providedAccess.permissions = providedAccess.permissions.filter(
              (permission) => permission !== revoked,
            );
          }
        } finally {
          barrier.release();
        }

        expect(await settled).toEqual({ approved: false });
        expect((await f.work()).approval).toBeUndefined();
        expect(await f.rows()).toEqual(before);
        expect(f.createIssue).not.toHaveBeenCalled();
      },
    );

    it.each([
      "visible source edit",
      "evidence revocation",
      "repository removal",
      "repository transfer",
      "private to public",
      "processing permission revocation",
      "installation revocation",
      "independent check revocation",
    ] as const)(
      "blocks POST when %s happens during an awaited final metadata check",
      async (change) => {
        const f = await engineeringAiFixture(createStore());
        await f.prepareProposal();
        await f.approve();
        const metadata = f.getMetadata.getMockImplementation()!;
        const barrier = engineeringBarrier();
        f.getMetadata.mockImplementationOnce(async (...args) => {
          await barrier.wait();
          return metadata(...args);
        });
        const dispatching = f.engineering.processWork(f.nextCommand());
        const settled = dispatching.then(
          (result) => result,
          () => undefined,
        );
        await barrier.reached;
        try {
          if (change === "visible source edit")
            await f.app.replyToCustomerTicket(customer, {
              ...f.command("source-edited-during-dispatch"),
              messageId: "changed-reproduction",
              body: "The behavior now differs on the current build.",
            });
          else if (change === "evidence revocation")
            await f.app.invalidateEngineeringSource(staff, {
              ...f.command("proof-revoked-during-dispatch"),
              reason: "evidence_revoked",
            });
          else if (change === "repository removal")
            await f.putPolicy({
              repositories: engineeringRepositories.slice(1),
            });
          else if (
            change === "repository transfer" ||
            change === "private to public"
          ) {
            const current = f.trust.metadata.get("repository-101")!;
            f.trust.metadata.set("repository-101", {
              ...current,
              ...(change === "repository transfer"
                ? { owner: "new-synthetic-owner" }
                : { visibility: "public" as const }),
              metadataVersion: "changed-after-approval",
            });
          } else if (change === "processing permission revocation")
            f.state.authority = {
              ...f.state.authority,
              access: {
                ...service,
                permissions: service.permissions.filter(
                  (permission) =>
                    permission !== supportPermissions.engineeringProcess,
                ),
              },
            };
          else if (change === "installation revocation")
            f.state.installationActive = false;
          else f.trust.revokeChecks((await f.work()).proposal!.checksReceipt);
        } finally {
          barrier.release();
        }
        await settled;
        expect(f.createIssue).not.toHaveBeenCalled();
        expect(
          (await f.work("ticket", f.key.sourceGeneration)).dispatch,
        ).toBeUndefined();
      },
    );

    it("never POSTs when durable dispatch-started committed but its acknowledgement remains uncertain", async () => {
      const f = await engineeringAiFixture(createStore());
      await f.prepareProposal();
      await f.approve();
      f.observed.intercept(async (trace, commit) => {
        const outcome = await commit();
        const started = trace.actions.some((action) => {
          if (
            !("value" in action) ||
            action.value === null ||
            typeof action.value !== "object"
          )
            return false;
          const row = action.value as Partial<EngineeringWorkRecord>;
          return row.kind === "engineering_work" && row.dispatch !== undefined;
        });
        if (outcome.committed && started)
          throw new Error("Synthetic durable dispatch acknowledgement lost");
        return outcome;
      });
      const oneAttempt = createSupportDeskEngineering({
        ...f.baseOptions,
        storageCommandAttempts: 1,
      });
      await oneAttempt.processWork(f.nextCommand());
      expect(f.createIssue).not.toHaveBeenCalled();
      expect((await f.work()).dispatch).toBeDefined();
      f.observed.intercept(undefined);
      f.advance(30_001);
      await f.engineering.processWork({
        ...f.nextCommand(),
        workerId: "replacement-after-lost-ack",
      });
      expect(f.createIssue).not.toHaveBeenCalled();
      expect((await f.work()).dispatch).toBeDefined();
    });

    it("allows one physical issue creation while a duplicate worker is active", async () => {
      const f = await engineeringAiFixture(createStore());
      await f.prepareProposal();
      await f.approve();
      const barrier = engineeringBarrier();
      f.setGitHubCreate(async (request) => {
        await barrier.wait();
        return f.acceptIssue(request);
      });
      const first = f.engineering.processWork(f.nextCommand());
      await barrier.reached;
      try {
        await f.engineering.processWork({
          ...f.nextCommand(),
          workerId: "concurrent-physical-worker",
        });
        expect(f.createIssue).toHaveBeenCalledTimes(1);
      } finally {
        barrier.release();
      }
      await first;
      await f.engineering.processWork(f.nextCommand());
      expect(f.createIssue).toHaveBeenCalledTimes(1);
    });

    it("reconciles unique remote acceptance after a lost response without creating again", async () => {
      const f = await engineeringAiFixture(createStore());
      const prepared = await f.prepareProposal();
      await f.approve();
      f.setGitHubCreate(async (request) => {
        await f.acceptIssue(request);
        throw new Error("Synthetic timeout after GitHub accepted the issue");
      });
      await f.engineering.processWork(f.nextCommand());
      expect((await f.work()).status).toBe("unknown");
      expect((await f.work()).terminalReserveRows).toBe(2);
      f.advance(30_001);
      await f.engineering.processWork({
        ...f.nextCommand(),
        workerId: "replacement-reconciler",
      });
      await f.engineering.reconcileSource("ticket");

      expect(f.createIssue).toHaveBeenCalledTimes(1);
      expect(f.githubReconcile).toHaveBeenCalledWith(
        expect.objectContaining({
          repositoryId: prepared.request.repository.repositoryId,
          exportMarker: prepared.request.bundle.exportMarker,
        }),
        expect.anything(),
      );
      expect((await f.work()).status).toBe("accepted");
      expect((await f.source()).destinations[0]).toMatchObject({
        outcome: "accepted",
        reconciliation: "confirmed",
        acknowledgement: {
          repositoryId: prepared.request.repository.repositoryId,
          issueId: "synthetic-issue-1",
          issueNumber: 1,
        },
      });
    });

    it.each(["empty marker search", "multiple marker matches"] as const)(
      "holds %s even after time passes and never authorizes another create",
      async (reason) => {
        const f = await engineeringAiFixture(createStore());
        await f.prepareProposal();
        await f.approve();
        f.setGitHubCreate(async () => {
          throw new Error("Synthetic outbound acceptance is unknown");
        });
        await f.engineering.processWork(f.nextCommand());
        f.githubReconcile.mockResolvedValue({ outcome: "unknown", reason });
        for (const age of [30_001, 3_600_001]) {
          f.advance(age);
          await f.engineering.reconcileSource("ticket");
          const work = await f.work();
          expect(work.dispatch).toBeDefined();
          expect(work.status).toBe("unknown");
          expect(work.terminalReserveRows).toBe(2);
          expect((await f.source()).destinations[0]!.outcome).toBe("unknown");
        }
        expect(f.createIssue).toHaveBeenCalledTimes(1);
      },
    );

    it("rejects caller-made remote identity until an independently authenticated exact-marker acknowledgement exists", async () => {
      const f = await engineeringAiFixture(createStore());
      const prepared = await f.prepareProposal();
      await f.approve();
      f.setGitHubCreate(async () => {
        throw new Error("Synthetic ambiguous outbound response");
      });
      await f.engineering.processWork(f.nextCommand());
      const reconcile = f.githubReconcile.getMockImplementation()!;
      f.githubReconcile.mockResolvedValue({
        outcome: "accepted",
        acknowledgement: {
          repositoryId: prepared.request.repository.repositoryId,
          issueId: "unverified-remote-issue",
          issueNumber: 99,
        },
        proof: "caller-made-marker-proof",
      });
      await f.engineering.reconcileSource("ticket");
      expect((await f.work()).status).toBe("unknown");
      expect((await f.work()).acknowledgement).toBeUndefined();
      if (prepared.request.operation !== "create_issue")
        throw new Error("Expected a create proposal");
      await f.acceptIssue(prepared.request);
      f.githubReconcile.mockImplementation(reconcile);
      await f.engineering.reconcileSource("ticket");
      expect((await f.work()).status).toBe("accepted");
      expect(f.createIssue).toHaveBeenCalledTimes(1);
    });

    it("associates an approved existing issue privately without creating or commenting", async () => {
      const f = await engineeringAiFixture(createStore());
      f.state.linkExisting = true;
      f.state.duplicateIssues = [
        {
          repositoryId: "repository-101",
          issueId: "existing-issue-77",
          issueNumber: 77,
          title: "Synthetic export failure",
          body: "Synthetic reproduction only.",
        },
      ];
      f.state.physicalDuplicateResults = 1;
      const prepared = await f.prepareProposal();
      expect(prepared.request).toMatchObject({
        operation: "link_existing_issue",
        issueId: "existing-issue-77",
        issueNumber: 77,
      });
      await f.approve();
      await f.engineering.processWork(f.nextCommand());
      expect(f.createIssue).not.toHaveBeenCalled();
      expect((await f.work()).acknowledgement).toMatchObject({
        repositoryId: "repository-101",
        issueId: "existing-issue-77",
        issueNumber: 77,
      });
      expect(Object.keys(f.baseOptions.github).sort()).toEqual([
        "createIssue",
        "getMetadata",
        "reconcile",
        "searchDuplicates",
      ]);
    });

    it("checks the complete public request including template content, evidence and opaque marker before approval", async () => {
      const f = await engineeringAiFixture(createStore(), {
        repositoryPolicy: {
          repositories: engineeringRepositories.map((repository) => ({
            ...repository,
            visibility: "public",
          })),
        },
      });
      const metadata = f.trust.metadata.get("repository-101")!;
      f.trust.metadata.set("repository-101", {
        ...metadata,
        visibility: "public",
      });
      const prepare = f.prepareExport.getMockImplementation()!;
      f.prepareExport.mockImplementationOnce(async (...args) => {
        const result = await prepare(...args);
        if (result.outcome !== "prepared") return result;
        return {
          ...result,
          request: {
            ...result.request,
            bundle: {
              ...result.request.bundle,
              body: `${result.request.bundle.body}\n\nSynthetic template footer.`,
            },
          },
        };
      });
      const prepared = await f.prepareProposal();
      const checked = f.checksCheck.mock.calls.at(-1)![0].exactRequest;
      expect(checked).toEqual(prepared.request);
      expect(checked.repository.visibility).toBe("public");
      expect(checked.bundle.body).toContain("Synthetic template footer.");
      expect(checked.bundle.templateId).toBe("bug-report");
      expect(checked.bundle.exportMarker.length).toBeGreaterThan(0);
      expect(checked.bundle.body).toContain(checked.bundle.exportMarker);
      expect(checked.bundle.evidenceReferences).toEqual([
        "synthetic-verified-reproduction",
      ]);
      for (const privateText of [
        "PRIVATE_ENGINEERING_INTERNAL_NOTE",
        "PRIVATE_ENGINEERING_VERIFICATION_REFERENCE",
        "engineering-customer@fixtures.invalid",
      ])
        expect(JSON.stringify(checked)).not.toContain(privateText);
      await f.approve();
      await f.engineering.processWork(f.nextCommand());
      expect(f.createIssue).toHaveBeenCalledTimes(1);
      expect(f.createIssue.mock.calls[0]![0]).toEqual(checked);
    });

    it("requires independently approved public reproduction evidence for a public repository", async () => {
      const f = await engineeringAiFixture(createStore(), {
        repositoryPolicy: {
          repositories: engineeringRepositories.map((repository) => ({
            ...repository,
            visibility: "public",
          })),
        },
      });
      const metadata = f.trust.metadata.get("repository-101")!;
      f.trust.metadata.set("repository-101", {
        ...metadata,
        visibility: "public",
      });
      f.state.checkReceiptOverrides = { publicReproduction: "not_applicable" };
      await f.prepareProposal().catch(() => undefined);
      expect((await f.work()).approval).toBeUndefined();
      expect(f.createIssue).not.toHaveBeenCalled();
      expect(f.checksCheck).toHaveBeenCalled();
    });

    it.each(["restricted", "uncertain"] as const)(
      "keeps independently classified %s source evidence out of ordinary export",
      async (security) => {
        const f = await engineeringAiFixture(createStore(), { security });
        await f.engineering.processWork(f.nextCommand()).catch(() => undefined);
        expect((await f.source()).state).toBe("restricted");
        expect(f.generate).not.toHaveBeenCalled();
        expect(f.createIssue).not.toHaveBeenCalled();
      },
    );

    it("holds a candidate when the independent whole-request security check requires restricted review", async () => {
      const f = await engineeringAiFixture(createStore());
      f.state.checkOutcome = "restricted";
      await f.prepareProposal().catch(() => undefined);
      expect(f.checksCheck).toHaveBeenCalled();
      expect((await f.work()).approval).toBeUndefined();
      expect(f.createIssue).not.toHaveBeenCalled();
    });

    it.each(["coordinator", "terminal receipt"] as const)(
      "reconciles retained opaque identity with only reconciliation permission after disable, withdrawal and actual body deletion (%s)",
      async (path) => {
        const f = await engineeringAiFixture(createStore());
        const prepared = await f.prepareProposal();
        await f.approve();
        f.setGitHubCreate(async (request) => {
          await f.acceptIssue(request);
          throw new Error(
            "Synthetic accepted issue with lost outbound response",
          );
        });
        await f.engineering.processWork(f.nextCommand());
        const unknown = await f.work();
        const reconciliationAccess = {
          ...service,
          principalId: "engineering/reconciliation-only",
          permissions: [supportPermissions.engineeringReconcile],
        };
        const dispatchFence = {
          ...f.key,
          workerId: unknown.dispatch!.workerId,
          claimId: unknown.dispatch!.claimId,
          claimGeneration: unknown.dispatch!.claimGeneration,
        };
        await expect(
          f.app.claimEngineeringWork(reconciliationAccess, {
            ...f.key,
            workerId: "unauthorized-model-worker",
            claimId: "unauthorized-model-claim",
            leaseMilliseconds: 10_000,
          }),
        ).rejects.toMatchObject({ name: "SupportDeskAuthorizationError" });
        await expect(
          f.app.prepareEngineeringModel(reconciliationAccess, {
            ...dispatchFence,
            binding: unknown.modelAttempts[0]!.binding,
          }),
        ).rejects.toMatchObject({ name: "SupportDeskAuthorizationError" });
        await expect(
          f.app.beginEngineeringDispatch(
            reconciliationAccess,
            {
              ...dispatchFence,
              stepId: unknown.proposal!.stepId,
              requestHash: unknown.dispatch!.requestHash,
              proposalHash: unknown.proposal!.proposalHash,
              dispatchId: "unauthorized-new-dispatch",
            },
            async () => {},
          ),
        ).rejects.toMatchObject({ name: "SupportDeskAuthorizationError" });
        f.state.reconciliationAuthority = {
          ...f.state.reconciliationAuthority,
          access: reconciliationAccess,
        };
        f.state.authorityOutcome = "inactive";
        f.state.configurationOutcome = "disabled";
        await f.putPolicy({ enabled: false });
        await f.app.withdrawEngineeringSource(staff, {
          ...f.command("withdraw-unknown-export"),
          reason: "source_deleted",
        });
        const withdrawn = await f.work("ticket", f.key.sourceGeneration);
        expect(withdrawn.evidence).toBeUndefined();
        expect(withdrawn.product).toBeUndefined();
        expect(withdrawn.candidate).toBeUndefined();
        expect(withdrawn.proposal).toBeUndefined();
        expect(withdrawn.modelAttempts).toEqual([]);
        expect(withdrawn.terminalReserveRows).toBe(2);
        expect(withdrawn.withdrawnRequest).toMatchObject({
          repositoryId: prepared.request.repository.repositoryId,
          exportMarker: prepared.request.bundle.exportMarker,
        });
        expect(withdrawn.dispatch).toMatchObject({
          dispatchId: unknown.dispatch!.dispatchId,
          repositoryId: unknown.dispatch!.repositoryId,
          requestHash: unknown.dispatch!.requestHash,
          exportMarker: unknown.dispatch!.exportMarker,
        });
        expect(JSON.stringify(withdrawn)).not.toContain(
          prepared.request.bundle.body,
        );

        const records = f.backing.collection(supportRecords);
        for (const row of await f.rows()) {
          if (row.kind !== "ticket" && row.kind !== "message") continue;
          const key = { partition: row.partition, id: row.id };
          const stored = await records.getVersioned(key);
          if (stored === null)
            throw new Error("Expected the real retained row");
          await records.deleteIfUnchanged(key, stored.version);
        }
        expect((await f.rows()).some((row) => row.kind === "ticket")).toBe(
          false,
        );
        if (path === "coordinator") {
          const result = await f.engineering.reconcileSource("ticket");
          expect(result.outcome).toBe("reconciled");
        } else {
          await f.app.recordEngineeringDispatchResult(reconciliationAccess, {
            ...f.key,
            dispatchId: unknown.dispatch!.dispatchId,
            requestHash: unknown.dispatch!.requestHash,
            result: {
              outcome: "accepted",
              acknowledgement: f.acceptedIssues.get(
                prepared.request.bundle.exportMarker,
              )!,
            },
          });
        }
        const current = await f.app.readEngineeringReconciliation(
          reconciliationAccess,
          "ticket",
        );
        expect(current.state).toBe("withdrawn");
        expect(current.destinations[0]).toMatchObject({
          outcome: "accepted",
          acknowledgement: { issueId: "synthetic-issue-1", issueNumber: 1 },
        });
        expect(f.createIssue).toHaveBeenCalledTimes(1);
      },
    );
  });
}
