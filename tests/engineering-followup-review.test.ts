import { createSupportDeskReleaseFollowup } from "@pegma/support-desk-ai";
import { supportPermissions } from "@pegma/support-desk-application";
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

    it("recovers an accepted post acknowledgement without another message or model call", async () => {
      const f = await engineeringFollowupAiFixture(createStore());
      await f.prepareBundle();
      const command = await f.postCommand();
      let lost = false;
      const post = vi.fn<
        typeof f.app.approveAndPostEngineeringFollowupWebUpdate
      >(async (...args) => {
        const result = await f.app.approveAndPostEngineeringFollowupWebUpdate(
          ...args,
        );
        if (!lost) {
          lost = true;
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
      );
      expect(result.messageId).toBe(command.messageId);
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
