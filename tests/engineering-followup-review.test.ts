import { createSupportDeskReleaseFollowup } from "@pegma/support-desk-ai";
import {
  supportPermissions,
  supportRecords,
} from "@pegma/support-desk-application";
import { describe, expect, it, vi } from "vitest";
import {
  engineeringFollowupAiFixture,
  waitForFollowupHook,
} from "../test/engineering-followup-ai-fixtures.js";
import {
  engineeringFollowupBarrier,
  engineeringFollowupCustomer,
  engineeringFollowupStaff,
  engineeringFollowupStores,
} from "../test/engineering-followup-fixtures.js";

for (const [name, createStore] of engineeringFollowupStores) {
  describe(`staff-reviewed release follow-up (${name})`, () => {
    it("discovers review hints with review and queue grants without processing or private-read authority", async () => {
      const f = await engineeringFollowupAiFixture(createStore());
      const prepared = await f.prepareBundle();
      const access = {
        ...f.state.authority.access,
        permissions: [
          supportPermissions.engineeringFollowupReview,
          supportPermissions.queueRead,
        ],
        roles: [],
        entitlements: [],
      };
      f.state.authority = { ...f.state.authority, access };
      await expect(
        f.app.readEngineeringFollowupWork(access, f.key),
      ).rejects.toThrow();
      const page = await f.followup.scanCandidates({ limit: 64 });
      expect(page.reviewCandidates).toContainEqual(f.key);
      expect(page.candidates).toEqual([]);
      expect(page.associations).toEqual([]);
      expect(JSON.stringify(page)).not.toContain(
        prepared.preparedBundle!.bundle.customerDraft.body,
      );
      expect(JSON.stringify(page)).not.toContain("preparedBundle");
      for (const key of page.reviewCandidates)
        expect(Object.keys(key).sort()).toEqual(["ticketId", "workId"]);
      expect(f.generate).toHaveBeenCalledOnce();
      expect(f.reserve).toHaveBeenCalledOnce();
    });

    it("allows a process-only body-free scanner without admitting paid processing", async () => {
      const f = await engineeringFollowupAiFixture(createStore());
      const access = {
        ...f.state.authority.access,
        permissions: [supportPermissions.engineeringFollowupProcess],
        roles: [],
        entitlements: [],
      };
      f.state.authority = { ...f.state.authority, access };
      await expect(
        f.app.readEngineeringFollowupWork(access, f.key),
      ).rejects.toThrow();
      const page = await f.followup.scanCandidates({ limit: 64 });
      expect(page.candidates).toContainEqual(f.key);
      expect(page.reviewCandidates).toEqual([]);
      for (const key of page.candidates)
        expect(Object.keys(key).sort()).toEqual(["ticketId", "workId"]);
      expect(JSON.stringify(page)).not.toContain("customerDraft");
      expect(JSON.stringify(page)).not.toContain(
        "PRIVATE_ENGINEERING_INTERNAL_NOTE",
      );
      expect(f.generate).not.toHaveBeenCalled();
      expect(f.reserve).not.toHaveBeenCalled();
    });

    it("does not turn unrelated roles or a review grant without queue access into scan authority", async () => {
      const f = await engineeringFollowupAiFixture(createStore());
      for (const permissions of [
        [],
        [supportPermissions.engineeringFollowupRead],
        [supportPermissions.engineeringFollowupReview],
      ]) {
        f.state.authority = {
          ...f.state.authority,
          access: {
            ...f.state.authority.access,
            permissions,
            roles: ["followup-reviewer", "followup-worker"],
            entitlements: [],
          },
        };
        await expect(
          f.followup.scanCandidates({ limit: 64 }),
        ).rejects.toThrow();
      }
      expect(f.generate).not.toHaveBeenCalled();
      expect(f.reserve).not.toHaveBeenCalled();
    });

    it.each(["principal-swap", "permission-revoke"] as const)(
      "does not return review hints after %s during an actual scan source read",
      async (change) => {
        const f = await engineeringFollowupAiFixture(createStore());
        await f.prepareBundle();
        const access = {
          ...f.state.authority.access,
          permissions: [
            supportPermissions.engineeringFollowupReview,
            supportPermissions.queueRead,
          ],
          roles: [],
          entitlements: [],
        };
        f.state.authority = { ...f.state.authority, access };
        expect(
          (await f.app.scanEngineeringFollowups(access, { limit: 64 }))
            .reviewCandidates,
        ).toContainEqual(f.key);
        const beforeRows = await f.rows();
        const beforeWork = await f.work();
        const barrier = engineeringFollowupBarrier();
        let captured = false;
        f.readObserver.afterRead(async (trace) => {
          const key = trace.key;
          if (
            !captured &&
            trace.collection === supportRecords.name &&
            trace.method === "get" &&
            key !== null &&
            typeof key === "object" &&
            "id" in key &&
            key.id === "engineering-source"
          ) {
            captured = true;
            await barrier.wait();
          }
        });
        const followup = createSupportDeskReleaseFollowup({
          ...f.baseOptions,
          maxOperationMilliseconds: 10_000,
        });
        const pending = followup.scanCandidates({ limit: 64 });
        try {
          await waitForFollowupHook(barrier, pending);
          f.state.authority = {
            ...f.state.authority,
            access:
              change === "principal-swap"
                ? {
                    ...access,
                    principalId: "followup/replacement-review-scanner",
                  }
                : {
                    ...access,
                    permissions: access.permissions.filter(
                      (permission) =>
                        permission !==
                        supportPermissions.engineeringFollowupReview,
                    ),
                  },
          };
        } finally {
          barrier.release();
          f.readObserver.afterRead(undefined);
        }
        await expect(pending).rejects.toThrow();
        expect(captured).toBe(true);
        expect(await f.rows()).toEqual(beforeRows);
        expect(await f.work()).toEqual(beforeWork);
        expect(f.generate).toHaveBeenCalledOnce();
        expect(f.reserve).toHaveBeenCalledOnce();
      },
    );

    it("posts with exactly the documented staff grants and replays its opaque receipt without private-read authority", async () => {
      const f = await engineeringFollowupAiFixture(createStore());
      await f.prepareBundle();
      const access = {
        ...engineeringFollowupStaff,
        permissions: [
          supportPermissions.engineeringFollowupRead,
          supportPermissions.engineeringFollowupReview,
          supportPermissions.queueRead,
          supportPermissions.replyAny,
        ],
        roles: [],
        entitlements: [],
      };
      const command = await f.postCommand("minimal-staff-followup-post");
      const posted = await f.followup.approveAndPostWebUpdate(access, command);
      expect((await f.work()).status).toBe("delivered");
      const rows = await f.rows();
      const proofReads = f.confirm.mock.calls.length;
      const replayAccess = {
        ...access,
        permissions: access.permissions.filter(
          (permission) =>
            permission !== supportPermissions.engineeringFollowupRead,
        ),
      };
      expect(
        await f.followup.approveAndPostWebUpdate(replayAccess, command),
      ).toEqual(posted);
      expect(await f.rows()).toEqual(rows);
      expect(f.confirm.mock.calls).toHaveLength(proofReads);
      expect(f.generate).toHaveBeenCalledOnce();
    });

    it("requires private read only for a fresh staff reassessment while permitting its narrower opaque replay", async () => {
      const f = await engineeringFollowupAiFixture(createStore());
      const prepared = await f.prepareBundle();
      await f.app.rejectEngineeringFollowupBundle(engineeringFollowupStaff, {
        ...f.command("hold-for-minimal-staff-reassessment"),
        ...f.key,
        expectedWorkGeneration: prepared.workGeneration,
        bundleHash: prepared.preparedBundle!.bundleHash,
        reason: "Recheck this release notice under current proof.",
      });
      const held = await f.work();
      const command = {
        ...f.command("minimal-staff-reassessment"),
        ...f.key,
        expectedWorkGeneration: held.workGeneration,
      };
      const narrow = {
        ...engineeringFollowupStaff,
        permissions: [
          supportPermissions.engineeringFollowupReview,
          supportPermissions.queueRead,
        ],
        roles: [],
        entitlements: [],
      };
      const checkedBefore = f.check.mock.calls.length;
      const proofReadsBefore = f.confirm.mock.calls.length;
      await expect(
        f.followup.prepareStaffReassessment(narrow, command),
      ).rejects.toThrow();
      expect(f.check.mock.calls).toHaveLength(checkedBefore);
      expect(f.confirm.mock.calls).toHaveLength(proofReadsBefore);
      expect(await f.work()).toEqual(held);
      const allowed = {
        ...narrow,
        permissions: [
          ...narrow.permissions,
          supportPermissions.engineeringFollowupRead,
        ],
      };
      const result = await f.followup.prepareStaffReassessment(
        allowed,
        command,
      );
      expect((await f.work()).status).toBe("bundle_prepared");
      expect(f.check.mock.calls.length).toBeGreaterThan(checkedBefore);
      const rows = await f.rows();
      const proofReads = f.confirm.mock.calls.length;
      expect(
        await f.followup.prepareStaffReassessment(narrow, command),
      ).toEqual(result);
      expect(await f.rows()).toEqual(rows);
      expect(f.confirm.mock.calls).toHaveLength(proofReads);
      expect(f.generate).toHaveBeenCalledOnce();
      expect(f.reserve).toHaveBeenCalledOnce();
    });

    it("keeps worker drafts private and atomically posts exactly one notice only after explicit current staff approval", async () => {
      const f = await engineeringFollowupAiFixture(createStore());
      const before = await f.app.readCustomerTicket(
        engineeringFollowupCustomer,
        "ticket",
      );
      const prepared = await f.prepareBundle();
      expect(prepared.status).toBe("bundle_prepared");
      expect(prepared.completionRows).toBe(3);
      expect(prepared.messageSlots).toBe(1);
      expect(
        await f.app.readCustomerTicket(engineeringFollowupCustomer, "ticket"),
      ).toEqual(before);
      await f.followup.processWork(f.nextCommand());
      expect(
        await f.app.readCustomerTicket(engineeringFollowupCustomer, "ticket"),
      ).toEqual(before);
      const beforeTicket = (
        await f.app.readStaffTicket(engineeringFollowupStaff, "ticket")
      ).ticket;
      const beforeRows = await f.rows();
      const command = await f.postCommand();
      const posted = await f.followup.approveAndPostWebUpdate(
        engineeringFollowupStaff,
        command,
      );
      const after = await f.app.readCustomerTicket(
        engineeringFollowupCustomer,
        "ticket",
      );
      expect(after.messages).toHaveLength(before.messages.length + 1);
      expect(after.messages.at(-1)).toMatchObject({
        id: posted.messageId,
        body: prepared.preparedBundle!.bundle.customerDraft.body,
      });
      expect(after.ticket.status).toBe(before.ticket.status);
      expect(after.ticket.handling).toEqual(before.ticket.handling);
      const afterTicket = (
        await f.app.readStaffTicket(engineeringFollowupStaff, "ticket")
      ).ticket;
      expect(afterTicket.resolvedAt).toBe(beforeTicket.resolvedAt);
      expect(afterTicket.closedAt).toBe(beforeTicket.closedAt);
      expect(afterTicket.firstStaffRespondedAt).toBe(
        beforeTicket.firstStaffRespondedAt,
      );
      const delivered = await f.work();
      expect(delivered.status).toBe("delivered");
      expect(delivered.completionRows).toBe(0);
      expect(delivered.messageSlots).toBe(0);
      const rows = await f.rows();
      expect(rows).toHaveLength(beforeRows.length + 3);
      expect(
        await f.followup.approveAndPostWebUpdate(
          engineeringFollowupStaff,
          command,
        ),
      ).toEqual(posted);
      expect(await f.rows()).toEqual(rows);
      expect(f.generate).toHaveBeenCalledOnce();
      expect(f.support.createIssue).toHaveBeenCalledOnce();
    });

    it.each([
      supportPermissions.engineeringFollowupRead,
      supportPermissions.engineeringFollowupReview,
      supportPermissions.replyAny,
      supportPermissions.queueRead,
    ])("requires current %s permission for web posting", async (permission) => {
      const f = await engineeringFollowupAiFixture(createStore());
      await f.prepareBundle();
      const before = await f.app.readCustomerTicket(
        engineeringFollowupCustomer,
        "ticket",
      );
      const denied = {
        ...engineeringFollowupStaff,
        permissions: engineeringFollowupStaff.permissions.filter(
          (value) => value !== permission,
        ),
      };
      await expect(
        f.followup.approveAndPostWebUpdate(denied, await f.postCommand()),
      ).rejects.toThrow();
      expect(
        await f.app.readCustomerTicket(engineeringFollowupCustomer, "ticket"),
      ).toEqual(before);
      expect((await f.work()).delivered).toBeUndefined();
    });

    it("allows fresh staff checks and posting while generation configuration and model are disabled", async () => {
      const f = await engineeringFollowupAiFixture(createStore());
      await f.prepareBundle();
      f.state.configurationOutcome = "disabled";
      f.setModel(async () => {
        throw new Error("Generation must stay disabled during staff posting");
      });
      const reads = f.resolveConfiguration.mock.calls.length;
      await f.followup.approveAndPostWebUpdate(
        engineeringFollowupStaff,
        await f.postCommand(),
      );
      expect((await f.work()).status).toBe("delivered");
      expect(f.resolveConfiguration.mock.calls).toHaveLength(reads);
      expect(f.generate).toHaveBeenCalledOnce();
    });

    it("rejects a prepared bundle locally during external outages", async () => {
      const f = await engineeringFollowupAiFixture(createStore());
      await f.prepareBundle();
      const current = await f.work();
      f.state.configurationOutcome = "disabled";
      f.releaseState.currentOutcome = "unavailable";
      f.releaseState.checksOutcome = "unavailable";
      const proofReads = f.confirm.mock.calls.length;
      const checkReads = f.checksVerify.mock.calls.length;
      const before = await f.app.readCustomerTicket(
        engineeringFollowupCustomer,
        "ticket",
      );
      await f.app.rejectEngineeringFollowupBundle(engineeringFollowupStaff, {
        ...f.command("reject-private-release-draft"),
        ...f.key,
        expectedWorkGeneration: current.workGeneration,
        bundleHash: current.preparedBundle!.bundleHash,
        reason: "The proposed wording needs a human revision.",
      });
      expect((await f.work()).status).toBe("held");
      expect(f.confirm.mock.calls).toHaveLength(proofReads);
      expect(f.checksVerify.mock.calls).toHaveLength(checkReads);
      expect(
        await f.app.readCustomerTicket(engineeringFollowupCustomer, "ticket"),
      ).toEqual(before);
    });

    it.each([
      "withdraw",
      "visible-reply",
      "reopen",
      "rollback",
      "revoke-evidence",
    ] as const)(
      "blocks posting after %s commits during a captured current release-proof await",
      async (change) => {
        const f = await engineeringFollowupAiFixture(createStore());
        await f.prepareBundle();
        const before = await f.app.readCustomerTicket(
          engineeringFollowupCustomer,
          "ticket",
        );
        const command = await f.postCommand();
        const barrier = engineeringFollowupBarrier();
        let captured = false;
        const followup = createSupportDeskReleaseFollowup({
          ...f.baseOptions,
          releaseEvidence: {
            ...f.baseOptions.releaseEvidence,
            async confirm(...args) {
              const proof = await f.baseOptions.releaseEvidence.confirm(
                ...args,
              );
              if (!captured) {
                captured = true;
                await barrier.wait();
              }
              return proof;
            },
          },
        });
        const pending = followup.approveAndPostWebUpdate(
          engineeringFollowupStaff,
          command,
          { signal: AbortSignal.timeout(10_000) },
        );
        try {
          await waitForFollowupHook(barrier, pending);
          if (change === "withdraw")
            await f.app.withdrawEngineeringSource(engineeringFollowupStaff, {
              ...f.command("withdraw-before-release-notice"),
              reason: "privacy_withdrawal",
            });
          else if (change === "visible-reply")
            await f.app.replyToCustomerTicket(engineeringFollowupCustomer, {
              ...f.command("customer-before-release-notice"),
              messageId: "new-context-before-notice",
              body: "Please reassess the fix against this newer information.",
            });
          else if (change === "reopen") {
            await f.app.resolveTicket(
              engineeringFollowupStaff,
              f.command("resolve-before-followup-reopen"),
            );
            await f.app.reopenTicket(
              engineeringFollowupStaff,
              f.command("reopen-before-release-notice"),
            );
          } else if (change === "revoke-evidence")
            await f.app.invalidateEngineeringSource(engineeringFollowupStaff, {
              ...f.command("revoke-before-release-notice"),
              reason: "product_binding_revoked",
            });
          else {
            const context = f.releaseState.context!;
            f.releaseState.context = {
              issueHead: context.issueHead,
              deploymentHead: {
                ...context.deploymentHead,
                generation: context.deploymentHead.generation + 1,
                hash: "rollback-before-release-notice",
                state: "rolled_back",
              },
            };
            await f.observe();
          }
        } finally {
          barrier.release();
        }
        await expect(pending).rejects.toThrow();
        expect(captured).toBe(true);
        const after = await f.app.readCustomerTicket(
          engineeringFollowupCustomer,
          "ticket",
        );
        expect(
          after.messages.some((message) => message.id === command.messageId),
        ).toBe(false);
        expect(after.messages.length - before.messages.length).toBe(
          change === "visible-reply" ? 1 : 0,
        );
        expect((await f.work()).delivered).toBeUndefined();
      },
    );

    it("checks live staff authority after the final awaited store read", async () => {
      const f = await engineeringFollowupAiFixture(createStore());
      await f.prepareBundle();
      const command = await f.postCommand("staff-authority-late-read");
      const beforeRows = await f.rows();
      const barrier = engineeringFollowupBarrier();
      let proofGuardFinished = false;
      let postQuotaRead = false;
      let captured = false;
      let staffCurrent = true;
      const verifyBeforeCommit = vi.fn(() => {
        if (!staffCurrent) throw new Error("Synthetic staff session revoked");
      });
      f.readObserver.afterRead(async (trace) => {
        const key = trace.key;
        if (
          !proofGuardFinished ||
          trace.collection !== supportRecords.name ||
          trace.method !== "getVersioned" ||
          key === null ||
          typeof key !== "object" ||
          !("id" in key)
        )
          return;
        if (key.id === "quota") postQuotaRead = true;
        if (postQuotaRead && !captured && key.id === "engineering-source") {
          captured = true;
          await barrier.wait();
        }
      });
      const followup = createSupportDeskReleaseFollowup({
        ...f.baseOptions,
        application: {
          ...f.app,
          approveAndPostEngineeringFollowupWebUpdate(
            access,
            input,
            proofGuard,
            run,
          ) {
            return f.app.approveAndPostEngineeringFollowupWebUpdate(
              access,
              input,
              async () => {
                const assertProofCurrent = await proofGuard();
                proofGuardFinished = true;
                return assertProofCurrent;
              },
              run,
            );
          },
        },
      });
      const pending = followup.approveAndPostWebUpdate(
        engineeringFollowupStaff,
        command,
        { verifyBeforeCommit },
      );
      try {
        await waitForFollowupHook(barrier, pending);
        expect(verifyBeforeCommit).not.toHaveBeenCalled();
        staffCurrent = false;
      } finally {
        barrier.release();
        f.readObserver.afterRead(undefined);
      }
      await expect(pending).rejects.toMatchObject({
        category: "verification_unavailable",
      });
      expect(captured).toBe(true);
      expect(verifyBeforeCommit).toHaveBeenCalledOnce();
      expect(await f.rows()).toEqual(beforeRows);
      expect((await f.work()).status).toBe("bundle_prepared");
      expect(f.generate).toHaveBeenCalledOnce();
    });

    it.each(["abort", "timeout"] as const)(
      "prevents a late authority read from writing after %s",
      async (failure) => {
        const f = await engineeringFollowupAiFixture(createStore());
        await f.prepareBundle();
        const command = await f.postCommand("staff-authority-boundary");
        const beforeRows = await f.rows();
        const barrier = engineeringFollowupBarrier();
        const controller = new AbortController();
        const verifyBeforeCommit = vi.fn(() => barrier.wait());
        const pending = f.app.approveAndPostEngineeringFollowupWebUpdate(
          engineeringFollowupStaff,
          command,
          () => {},
          { signal: controller.signal, verifyBeforeCommit },
        );
        try {
          await waitForFollowupHook(barrier, pending);
          if (failure === "abort") controller.abort();
          await expect(pending).rejects.toThrow(
            failure === "abort" ? "cancelled" : "timed out",
          );
        } finally {
          barrier.release();
        }
        expect(verifyBeforeCommit).toHaveBeenCalledOnce();
        await verifyBeforeCommit.mock.results[0]!.value;
        expect(await f.rows()).toEqual(beforeRows);
        expect((await f.work()).status).toBe("bundle_prepared");
      },
    );

    it("cannot post when the checked policy expires in the late authority read", async () => {
      const f = await engineeringFollowupAiFixture(createStore(), {
        followup: { trustTimeoutMilliseconds: 5_000 },
      });
      await f.prepareBundle();
      const command = await f.postCommand("staff-authority-proof-deadline");
      const beforeRows = await f.rows();
      f.state.checkPolicy = {
        ...f.state.checkPolicy,
        validUntil: new Date(Date.parse(f.clock.now()) + 2_000).toISOString(),
      };
      const verifyBeforeCommit = vi.fn(() => f.advance(2_500));
      await expect(
        f.followup.approveAndPostWebUpdate(engineeringFollowupStaff, command, {
          verifyBeforeCommit,
        }),
      ).rejects.toMatchObject({ category: "deadline" });
      expect(verifyBeforeCommit).toHaveBeenCalledOnce();
      expect(await f.rows()).toEqual(beforeRows);
      expect(f.generate).toHaveBeenCalledOnce();
    });

    it("cannot post when the checked policy expires after late authority returns", async () => {
      const f = await engineeringFollowupAiFixture(createStore(), {
        followup: { trustTimeoutMilliseconds: 5_000 },
      });
      await f.prepareBundle();
      const command = await f.postCommand("staff-authority-handoff-deadline");
      const beforeRows = await f.rows();
      f.state.checkPolicy = {
        ...f.state.checkPolicy,
        validUntil: new Date(Date.parse(f.clock.now()) + 3_000).toISOString(),
      };
      const verifyBeforeCommit = vi.fn(() => {});
      let authorityReturned = false;
      const followup = createSupportDeskReleaseFollowup({
        ...f.baseOptions,
        application: {
          ...f.app,
          approveAndPostEngineeringFollowupWebUpdate(
            access,
            input,
            proofGuard,
            run,
          ) {
            const verifyAuthority = run?.verifyBeforeCommit;
            if (verifyAuthority === undefined)
              throw new Error(
                "Expected the coordinator's late authority check",
              );
            return f.app.approveAndPostEngineeringFollowupWebUpdate(
              access,
              input,
              proofGuard,
              {
                ...run,
                async verifyBeforeCommit() {
                  await verifyAuthority();
                  authorityReturned = true;
                  f.advance(3_500);
                },
              },
            );
          },
        },
      });
      await expect(
        followup.approveAndPostWebUpdate(engineeringFollowupStaff, command, {
          verifyBeforeCommit,
        }),
      ).rejects.toMatchObject({ category: "deadline" });
      expect(authorityReturned).toBe(true);
      expect(verifyBeforeCommit).toHaveBeenCalledOnce();
      expect(await f.rows()).toEqual(beforeRows);
      expect((await f.work()).status).toBe("bundle_prepared");
      expect(f.generate).toHaveBeenCalledOnce();
    });

    it("recovers an accepted post acknowledgement without another message or model call", async () => {
      const f = await engineeringFollowupAiFixture(createStore());
      await f.prepareBundle();
      const command = await f.postCommand();
      let lost = false;
      let proofReadsAtCommit = 0;
      const verifyBeforeCommit = vi.fn(() => {
        if (lost) throw new Error("Exact replay must skip new-write authority");
      });
      const post = vi.fn<
        typeof f.app.approveAndPostEngineeringFollowupWebUpdate
      >(async (...args) => {
        const result = await f.app.approveAndPostEngineeringFollowupWebUpdate(
          ...args,
        );
        if (!lost) {
          lost = true;
          proofReadsAtCommit = f.confirm.mock.calls.length;
          f.releaseState.currentOutcome = "unavailable";
          throw new Error("Synthetic lost committed notice ACK");
        }
        return result;
      });
      const followup = createSupportDeskReleaseFollowup({
        ...f.baseOptions,
        application: {
          ...f.app,
          approveAndPostEngineeringFollowupWebUpdate: post,
        },
      });
      const result = await followup.approveAndPostWebUpdate(
        engineeringFollowupStaff,
        command,
        { verifyBeforeCommit },
      );
      expect(result.messageId).toBe(command.messageId);
      expect(post).toHaveBeenCalledTimes(2);
      expect(verifyBeforeCommit).toHaveBeenCalledOnce();
      expect(f.confirm).toHaveBeenCalledTimes(proofReadsAtCommit);
      expect(
        (
          await f.app.readCustomerTicket(engineeringFollowupCustomer, "ticket")
        ).messages.filter((message) => message.id === command.messageId),
      ).toHaveLength(1);
      expect((await f.work()).status).toBe("delivered");
      expect(f.generate).toHaveBeenCalledOnce();
      for (const [, replay] of post.mock.calls) expect(replay).toEqual(command);
    });

    it("replays a committed staff reassessment after lost acknowledgements without fresh external dependencies", async () => {
      const f = await engineeringFollowupAiFixture(createStore());
      await f.prepareBundle();
      const prepared = await f.work();
      await f.app.rejectEngineeringFollowupBundle(engineeringFollowupStaff, {
        ...f.command("hold-before-staff-reassessment-ack"),
        ...f.key,
        expectedWorkGeneration: prepared.workGeneration,
        bundleHash: prepared.preparedBundle!.bundleHash,
        reason: "Recheck this private release update.",
      });
      const held = await f.work();
      const command = {
        ...f.command("staff-reassessment-lost-ack"),
        ...f.key,
        expectedWorkGeneration: held.workGeneration,
      };
      const prepare = vi.fn<typeof f.app.prepareEngineeringFollowupBundle>(
        async (...args) => {
          await f.app.prepareEngineeringFollowupBundle(...args);
          throw new Error("Synthetic lost committed reassessment ACK");
        },
      );
      let droppedRecoveryAcknowledgements = 0;
      const recover = vi.fn<typeof f.app.recoverEngineeringFollowupPreparation>(
        async (...args) => {
          const result = await f.app.recoverEngineeringFollowupPreparation(
            ...args,
          );
          if (result !== null) {
            droppedRecoveryAcknowledgements += 1;
            throw new Error(
              "Synthetic lost committed reassessment recovery ACK",
            );
          }
          return result;
        },
      );
      const crashed = createSupportDeskReleaseFollowup({
        ...f.baseOptions,
        application: {
          ...f.app,
          prepareEngineeringFollowupBundle: prepare,
          recoverEngineeringFollowupPreparation: recover,
        },
      });
      await expect(
        crashed.prepareStaffReassessment(engineeringFollowupStaff, command),
      ).rejects.toThrow();
      expect(droppedRecoveryAcknowledgements).toBeGreaterThan(0);
      for (const [, replay] of recover.mock.calls)
        expect(replay).toEqual(recover.mock.calls[0]![1]);
      const committed = await f.work();
      expect(committed.status).toBe("bundle_prepared");
      expect(committed.bundleRevision).toBe(held.bundleRevision + 1);
      const checks = f.check.mock.calls.length;
      const rows = await f.rows();
      f.state.configurationOutcome = "disabled";
      f.releaseState.currentOutcome = "unavailable";
      const replay = await f.followup.prepareStaffReassessment(
        engineeringFollowupStaff,
        command,
      );
      expect(replay.bundleHash).toBe(committed.preparedBundle!.bundleHash);
      expect(await f.work()).toEqual(committed);
      expect(await f.rows()).toEqual(rows);
      expect(f.check.mock.calls).toHaveLength(checks);
      expect(f.generate).toHaveBeenCalledOnce();
    });
  });
}
