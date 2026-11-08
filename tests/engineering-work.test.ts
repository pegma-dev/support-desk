import { createSupportDeskEngineering } from "@pegma/support-desk-ai";
import {
  engineeringExportChecksBinding,
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

    it.each(["ambiguous routing", "prepared reselection"] as const)(
      "takes %s through exact staff selection, a fresh checked proposal, review and one dispatch without another model call",
      async (mode) => {
        const f = await engineeringAiFixture(createStore());
        const source = await f.source();
        let previousRequest:
          Awaited<ReturnType<typeof f.prepareProposal>>["request"] | undefined;
        if (mode === "ambiguous routing") {
          f.setModel(async () =>
            f.answer({
              outputJson: JSON.stringify(
                f.assessment({
                  routing: {
                    outcome: "ambiguous",
                    alternativeRepositoryIds: [
                      "repository-101",
                      "repository-202",
                    ],
                    rationale:
                      "Both allowed repositories plausibly own this verified failure.",
                  },
                }),
              ),
            }),
          );
          await f.engineering.processWork(f.nextCommand());
          await f.engineering.processWork(f.nextCommand());
          expect((await f.work()).candidate).toBeDefined();
          expect((await f.work()).proposal).toBeUndefined();
        } else {
          const first = await f.prepareProposal();
          previousRequest = first.request;
          expect(first.work.candidate).toBeUndefined();
        }
        const work = await f.work();
        const policy = await f.policy();
        const selection = {
          ...f.command("human-select-repository"),
          sourceGeneration: f.key.sourceGeneration,
          expectedWorkGeneration: work.workGeneration,
          repositoryId: "repository-202",
          policyGeneration: policy.generation,
          policyHash: policy.policyHash,
          reason:
            "Staff verified that the API repository owns this failing path.",
        };
        const denied = {
          ...staff,
          permissions: staff.permissions.filter(
            (permission) => permission !== supportPermissions.engineeringReview,
          ),
        };
        const before = await f.rows();
        await expect(
          f.app.selectEngineeringRepository(denied, selection),
        ).rejects.toThrow();
        expect(await f.rows()).toEqual(before);
        const selected = await f.app.selectEngineeringRepository(
          staff,
          selection,
        );
        const accepted = await f.rows();
        await expect(
          f.app.selectEngineeringRepository(staff, selection),
        ).resolves.toEqual(selected);
        expect(await f.rows()).toEqual(accepted);
        await expect(
          f.app.selectEngineeringRepository(denied, selection),
        ).rejects.toThrow();
        if (previousRequest !== undefined) {
          expect((await f.work()).proposal!.request).toEqual(previousRequest);
          expect((await f.work()).proposalNeedsRebuild).toBe(true);
          expect((await f.work()).candidate).toBeUndefined();
        }
        const rebuilt = await f.prepareProposal();
        expect(rebuilt.request.repository.repositoryId).toBe("repository-202");
        expect(rebuilt.request.bundle.body).toContain(f.assessment().summary);
        expect(rebuilt.request.bundle.body).toContain(
          rebuilt.request.bundle.exportMarker,
        );
        expect(rebuilt.work.proposalNeedsRebuild).not.toBe(true);
        expect(rebuilt.work.proposal!.routingReceipt).toBeUndefined();
        expect(f.checksCheck.mock.calls.at(-1)![0].exactRequest).toEqual(
          rebuilt.request,
        );
        if (previousRequest !== undefined) {
          const input = f.prepareExport.mock.calls.at(-1)![0];
          expect("previousRequest" in input && input.previousRequest).toEqual(
            previousRequest,
          );
        }
        await f.approve();
        await f.engineering.processWork(f.nextCommand());
        expect(f.generate).toHaveBeenCalledTimes(1);
        expect(f.createIssue).toHaveBeenCalledTimes(1);
        expect(f.createIssue.mock.calls[0]![0]).toEqual(rebuilt.request);
        expect((await f.source()).sourceBindingHash).toBe(
          source.sourceBindingHash,
        );
        expect((await f.work()).acknowledgement!.repositoryId).toBe(
          "repository-202",
        );
      },
    );

    it("invalidates a human-selected repository after current policy revokes it", async () => {
      const f = await engineeringAiFixture(createStore());
      await f.prepareProposal();
      const work = await f.work();
      const policy = await f.policy();
      await f.app.selectEngineeringRepository(staff, {
        ...f.command("select-before-policy-removal"),
        sourceGeneration: f.key.sourceGeneration,
        expectedWorkGeneration: work.workGeneration,
        repositoryId: "repository-202",
        policyGeneration: policy.generation,
        policyHash: policy.policyHash,
        reason: "Verified staff destination.",
      });
      await f.putPolicy({ repositories: engineeringRepositories.slice(0, 1) });
      await f.engineering.processWork(f.nextCommand());
      expect((await f.work()).approval).toBeUndefined();
      expect(f.createIssue).not.toHaveBeenCalled();
      expect(f.generate).toHaveBeenCalledTimes(1);
    });

    it("recovers an accepted application proposal after its real storage acknowledgement is lost", async () => {
      const f = engineeringFixture(createStore());
      await f.eligible();
      let lost = false;
      f.observed.intercept(async (trace, commit) => {
        const outcome = await commit();
        if (
          !lost &&
          outcome.committed &&
          trace.actions.some((action) => {
            if (
              !("value" in action) ||
              action.value === null ||
              typeof action.value !== "object"
            )
              return false;
            const row = action.value as Partial<EngineeringWorkRecord>;
            return (
              row.kind === "engineering_work" &&
              row.stage === "proposal" &&
              row.status === "prepared" &&
              row.proposal !== undefined &&
              row.lastProposalPreparation !== undefined
            );
          })
        ) {
          lost = true;
          throw new Error("Synthetic accepted proposal acknowledgement lost");
        }
        return outcome;
      });
      await expect(f.prepareProposal()).rejects.toThrow("acknowledgement lost");
      f.observed.intercept(undefined);
      expect(lost).toBe(true);
      expect(f.proposalCommands).toHaveLength(1);
      const command = f.proposalCommands.at(-1)!;
      const committed = await f.work();
      expect(committed.claim).toBeUndefined();
      expect(committed.leaseUntil).toBeUndefined();
      expect(committed.stage).toBe("proposal");
      expect(committed.proposal!.candidateHash).toBe(command.candidateHash);
      expect(committed.lastProposalPreparation).toBeDefined();
      const before = await f.rows();
      await expect(
        f.app.prepareEngineeringProposal(service, command, async () => {}),
      ).resolves.toEqual(committed.lastProposalPreparation!.result);
      expect(await f.rows()).toEqual(before);
      expect((await f.work()).proposalCount).toBe(1);
      f.advance(10_001);
      const disabled = f.freshApplication({ engineering: { enabled: false } });
      await expect(
        disabled.prepareEngineeringProposal(service, command, async () => {
          throw new Error(
            "Historical accepted proposal must not rerun export checks",
          );
        }),
      ).resolves.toEqual(committed.lastProposalPreparation!.result);
      expect(await f.rows()).toEqual(before);
      const replacement = await f.claim(
        "different-proposal-invocation",
        "different-proposal-worker",
      );
      const replaced = await f.rows();
      await expect(
        disabled.prepareEngineeringProposal(service, command, async () => {}),
      ).resolves.toEqual(committed.lastProposalPreparation!.result);
      expect(await f.rows()).toEqual(replaced);
      expect((await f.work()).claim).toEqual(replacement.fence);
    });

    it("replays a distinct identical-content preparation after a later proposal replaces the inline acknowledgement", async () => {
      const f = engineeringFixture(createStore());
      await f.eligible();
      const first = await f.prepareProposal();
      const secondOwner = await f.claim(
        "identical-content-C2",
        "identical-content-worker",
        "ticket",
        60_000,
      );
      const secondCommand = { ...first.command, ...secondOwner.fence };
      const beforeSecond = await f.rows();
      let lost = false;
      f.observed.intercept(async (trace, commit) => {
        const outcome = await commit();
        if (
          !lost &&
          outcome.committed &&
          trace.actions.some((action) => {
            if (
              !("value" in action) ||
              action.value === null ||
              typeof action.value !== "object"
            )
              return false;
            const row = action.value as Partial<EngineeringWorkRecord>;
            return (
              row.kind === "engineering_work" &&
              row.stage === "proposal" &&
              row.proposal?.proposalHash === first.proposal.proposalHash &&
              row.lastProposalPreparation !== undefined &&
              row.lastProposalPreparation.fingerprint !==
                first.work.lastProposalPreparation!.fingerprint
            );
          })
        ) {
          lost = true;
          throw new Error(
            "Synthetic distinct identical-content preparation acknowledgement lost",
          );
        }
        return outcome;
      });
      await expect(
        f.app.prepareEngineeringProposal(
          service,
          secondCommand,
          async () => {},
        ),
      ).rejects.toThrow("acknowledgement lost");
      f.observed.intercept(undefined);
      expect(lost).toBe(true);
      const second = await f.work();
      const originalResult = second.lastProposalPreparation!.result;
      const afterSecond = await f.rows();
      expect(afterSecond).toHaveLength(beforeSecond.length + 2);
      expect(
        afterSecond
          .filter((row) => !beforeSecond.some((prior) => prior.id === row.id))
          .map((row) => row.kind)
          .sort(),
      ).toEqual(["audit", "engineering_receipt"]);
      expect(second.proposal).toEqual(first.proposal);
      expect(second.proposalCount).toBe(1);
      expect(second.claim).toEqual(secondOwner.fence);
      await expect(
        f.app.prepareEngineeringProposal(
          service,
          secondCommand,
          async () => {},
        ),
      ).resolves.toEqual(originalResult);
      expect(await f.rows()).toEqual(afterSecond);

      const thirdRequest = {
        ...first.request,
        bundle: {
          ...first.request.bundle,
          body: `${first.request.bundle.body}\n\nStaff verified a second synthetic export format.`,
        },
      };
      const thirdChecks = await engineeringExportChecksBinding({
        sourceBindingHash: first.checksBinding.sourceBindingHash,
        evidenceFingerprint: first.checksBinding.evidenceFingerprint,
        candidateHash: first.candidateHash,
        routingBindingHash: first.proposal.routingBindingHash,
        exactRequest: thirdRequest,
        policyGeneration: first.proposal.policyGeneration,
        policyHash: first.proposal.policyHash,
      });
      f.trust.issueChecks("independent-P3-full-request-checks", thirdChecks);
      await f.app.prepareEngineeringProposal(
        service,
        {
          ...secondCommand,
          exactRequest: thirdRequest,
          checksReceipt: "independent-P3-full-request-checks",
        },
        async () => {},
      );
      const third = await f.work();
      expect(third.proposal!.request).toEqual(thirdRequest);
      expect(third.proposal!.proposalHash).not.toBe(
        first.proposal.proposalHash,
      );
      expect(third.proposalCount).toBe(2);
      expect(third.lastProposalPreparation!.fingerprint).not.toBe(
        second.lastProposalPreparation!.fingerprint,
      );
      const current = await f.claim(
        "current-P3-invocation",
        "current-P3-worker",
      );
      const beforeReplay = await f.rows();
      const disabled = f.freshApplication({ engineering: { enabled: false } });
      await expect(
        disabled.prepareEngineeringProposal(
          service,
          secondCommand,
          async () => {
            throw new Error(
              "Historical F2 replay must not rerun current export guards",
            );
          },
        ),
      ).resolves.toEqual(originalResult);
      expect(await f.rows()).toEqual(beforeReplay);
      expect((await f.work()).claim).toEqual(current.fence);
      expect((await f.work()).proposal!.request).toEqual(thirdRequest);
      expect((await f.work()).lastProposalPreparation).toEqual(
        third.lastProposalPreparation,
      );
      const denied = {
        ...service,
        permissions: service.permissions.filter(
          (permission) => permission !== supportPermissions.engineeringProcess,
        ),
      };
      await expect(
        disabled.prepareEngineeringProposal(
          denied,
          secondCommand,
          async () => {},
        ),
      ).rejects.toMatchObject({ name: "SupportDeskAuthorizationError" });
      expect(await f.rows()).toEqual(beforeReplay);
      expect((await f.work()).modelAttempts).toHaveLength(1);
    });

    it("recovers a coordinator proposal acknowledgement without rerendering or charging the model again", async () => {
      const f = await engineeringAiFixture(createStore());
      await f.engineering.processWork(f.nextCommand());
      let lost = false;
      f.observed.intercept(async (trace, commit) => {
        const outcome = await commit();
        if (
          !lost &&
          outcome.committed &&
          trace.actions.some((action) => {
            if (
              !("value" in action) ||
              action.value === null ||
              typeof action.value !== "object"
            )
              return false;
            const row = action.value as Partial<EngineeringWorkRecord>;
            return (
              row.kind === "engineering_work" &&
              row.stage === "proposal" &&
              row.status === "prepared" &&
              row.proposal !== undefined &&
              row.lastProposalPreparation !== undefined
            );
          })
        ) {
          lost = true;
          throw new Error(
            "Synthetic accepted coordinator proposal acknowledgement lost",
          );
        }
        return outcome;
      });
      await expect(
        f.engineering.processWork(f.nextCommand()),
      ).resolves.toMatchObject({ outcome: "prepared" });
      f.observed.intercept(undefined);
      expect(lost).toBe(true);
      expect(f.prepareExport).toHaveBeenCalledTimes(1);
      expect(f.generate).toHaveBeenCalledTimes(1);
      expect((await f.work()).proposalCount).toBe(1);
      expect(f.createIssue).not.toHaveBeenCalled();
    });

    it("replays a lost review acknowledgement across a new coordinator with the original command and old generation", async () => {
      const f = await engineeringAiFixture(createStore());
      await f.prepareProposal();
      const work = await f.work();
      const command = {
        ...f.command("historical-review-after-lost-ack"),
        sourceGeneration: f.key.sourceGeneration,
        expectedWorkGeneration: work.workGeneration,
        proposalHash: work.proposal!.proposalHash,
        decision: "approve" as const,
      };
      let lost = false;
      f.observed.intercept(async (trace, commit) => {
        const outcome = await commit();
        if (
          !lost &&
          outcome.committed &&
          trace.actions.some(
            (action) =>
              "value" in action &&
              action.value !== null &&
              typeof action.value === "object" &&
              (action.value as Partial<EngineeringWorkRecord>).kind ===
                "engineering_work" &&
              (action.value as Partial<EngineeringWorkRecord>).approval
                ?.decision === "approve",
          )
        ) {
          lost = true;
          throw new Error(
            "Synthetic accepted staff review acknowledgement lost",
          );
        }
        return outcome;
      });
      const first = createSupportDeskEngineering({
        ...f.baseOptions,
        storageCommandAttempts: 1,
      });
      await expect(first.reviewProposal(staff, command)).rejects.toThrow();
      f.observed.intercept(undefined);
      expect(lost).toBe(true);
      const before = await f.rows();
      const receipt = before.find(
        (row) =>
          row.kind === "engineering_receipt" &&
          "status" in row.result &&
          row.result.status === "approved",
      );
      if (
        receipt?.kind !== "engineering_receipt" ||
        !("status" in receipt.result)
      )
        throw new Error("Expected the actual committed review receipt");
      f.state.authorityOutcome = "unavailable";
      f.state.metadataOutcome = "unavailable";
      f.state.configurationOutcome = "disabled";
      const restarted = createSupportDeskEngineering(f.baseOptions);
      await expect(restarted.reviewProposal(staff, command)).resolves.toEqual(
        receipt.result,
      );
      expect(await f.rows()).toEqual(before);
      const denied = {
        ...staff,
        permissions: staff.permissions.filter(
          (permission) => permission !== supportPermissions.engineeringReview,
        ),
      };
      await expect(restarted.reviewProposal(denied, command)).rejects.toThrow();
      expect(await f.rows()).toEqual(before);
      expect(f.createIssue).not.toHaveBeenCalled();
    });

    it.each([
      "repository",
      "policy",
      "checks",
      "processing service",
      "generation configuration",
    ] as const)(
      "records an exact staff rejection during a %s outage without consulting export gates",
      async (outage) => {
        const f = await engineeringAiFixture(createStore());
        await f.prepareProposal();
        const work = await f.work();
        if (outage === "repository") f.state.installationActive = false;
        else if (outage === "policy") await f.putPolicy({ enabled: false });
        else if (outage === "checks")
          f.trust.revokeChecks(work.proposal!.checksReceipt);
        else if (outage === "processing service")
          f.state.authorityOutcome = "unavailable";
        else f.state.configurationOutcome = "unavailable";
        const calls = [
          f.getMetadata.mock.calls.length,
          f.checksVerify.mock.calls.length,
          f.resolveAuthority.mock.calls.length,
        ];
        await expect(
          f.engineering.reviewProposal(staff, {
            ...f.command("reject-during-outage"),
            sourceGeneration: f.key.sourceGeneration,
            expectedWorkGeneration: work.workGeneration,
            proposalHash: work.proposal!.proposalHash,
            decision: "reject",
            reason: "Staff rejected this exact private proposal.",
          }),
        ).resolves.toMatchObject({ status: "held" });
        expect((await f.work()).approval!.decision).toBe("reject");
        expect([
          f.getMetadata.mock.calls.length,
          f.checksVerify.mock.calls.length,
          f.resolveAuthority.mock.calls.length,
        ]).toEqual(calls);
        expect(f.createIssue).not.toHaveBeenCalled();
      },
    );

    it("discovers a pending staff proposal after restart and renews a bounded dispatch window at minute seven", async () => {
      const f = await engineeringAiFixture(createStore());
      await f.prepareProposal();
      const original = await f.work();
      const source = await f.source();
      const productCalls = f.trust.productCalls.length;
      f.advance(7 * 60_000);
      expect(Date.parse(original.deadline)).toBeLessThan(
        Date.parse(f.clock.now()),
      );
      const reviewOnly = {
        ...staff,
        permissions: [
          supportPermissions.engineeringReview,
          supportPermissions.queueRead,
        ],
      };
      const restarted = f.freshApplication();
      const page = await restarted.scanEngineeringCandidates(reviewOnly, {
        limit: 1_000,
      });
      expect(page.reviewCandidates).toContainEqual(f.key);
      expect(page.candidates).toEqual([]);
      expect(page.reconciliationSources).toEqual([]);
      const proposal = original.proposal!;
      f.trust.issueRouting(proposal.routingReceipt!, proposal.routingBinding!);
      f.trust.issueChecks(proposal.checksReceipt, proposal.checksBinding);
      await f.approve();
      const approved = await f.work();
      expect(Date.parse(approved.deadline)).toBeGreaterThan(
        Date.parse(f.clock.now()),
      );
      expect(
        Date.parse(approved.deadline) - Date.parse(f.clock.now()),
      ).toBeLessThanOrEqual(
        Date.parse(original.deadline) - Date.parse(original.createdAt) + 5_000,
      );
      expect(approved.modelAttempts).toEqual(original.modelAttempts);
      expect((await f.source()).sourceBindingHash).toBe(
        source.sourceBindingHash,
      );
      expect(f.trust.productCalls).toHaveLength(productCalls);
      await f.engineering.processWork(f.nextCommand());
      expect((await f.work()).status).toBe("accepted");
      expect(f.generate).toHaveBeenCalledTimes(1);
      expect(f.createIssue).toHaveBeenCalledTimes(1);
    });

    it("holds before durable begin and never POSTs when the dispatch proof verifier is missing", async () => {
      const f = await engineeringAiFixture(createStore(), {
        engineering: { dispatchResults: undefined },
      });
      await f.prepareProposal();
      await f.approve();
      const before = (await f.rows()).filter((row) => row.kind === "audit");
      await f.engineering.processWork(f.nextCommand());
      expect(f.createIssue).not.toHaveBeenCalled();
      expect((await f.work()).dispatch).toBeUndefined();
      expect((await f.work()).terminalReserveRows).toBe(0);
      expect((await f.rows()).filter((row) => row.kind === "audit")).toEqual(
        before,
      );
    });

    it.each([
      "accepted before withdrawal",
      "accepted after withdrawal",
    ] as const)(
      "scrubs URL, private body and late reasons from every retained engineering record (%s)",
      async (timing) => {
        const f = await engineeringAiFixture(createStore());
        const prepared = await f.prepareProposal();
        await f.approve();
        const privateUrl =
          "https://github.com/private-destination/private-issue?private-customer=synthetic";
        f.setGitHubCreate(async (request, context) => {
          const acknowledgement = await f.acceptIssue(
            request,
            {
              repositoryId: request.repository.repositoryId,
              issueId: "opaque-private-issue",
              issueNumber: 44,
              url: privateUrl,
            },
            context,
          );
          if (timing === "accepted after withdrawal")
            throw new Error("Synthetic accepted GitHub response lost");
          return acknowledgement;
        });
        await f.engineering.processWork(f.nextCommand());
        await f.app.withdrawEngineeringSource(staff, {
          ...f.command("permanent-withdrawal-with-url-receipts"),
          reason: "privacy_withdrawal",
        });
        if (timing === "accepted after withdrawal") {
          f.githubReconcile.mockResolvedValueOnce({
            outcome: "unknown",
            reason: "PRIVATE_LATE_RECONCILIATION_REASON",
          });
          await f.engineering.reconcileSource("ticket");
          await f.engineering.reconcileSource("ticket");
        }
        const retained = (await f.rows()).filter((row) =>
          [
            "engineering_source",
            "engineering_work",
            "engineering_receipt",
          ].includes(row.kind),
        );
        const encoded = JSON.stringify(retained);
        expect(encoded).not.toContain(privateUrl);
        expect(encoded).not.toContain(prepared.request.bundle.body);
        expect(encoded).not.toContain("PRIVATE_LATE_RECONCILIATION_REASON");
        expect(encoded).not.toContain(
          "PRIVATE_ENGINEERING_VERIFICATION_REFERENCE",
        );
        expect(
          (await f.work("ticket", f.key.sourceGeneration)).heldReason,
        ).toBe("privacy_withdrawal");
        expect(f.createIssue).toHaveBeenCalledTimes(1);
      },
    );

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
