import {
  supportPermissions,
  supportRecords,
  type EngineeringFollowupWorkRecord,
} from "@pegma/support-desk-application";
import { describe, expect, it } from "vitest";
import {
  engineeringFollowupBarrier,
  engineeringFollowupCustomer as customer,
  engineeringFollowupFixture,
  engineeringFollowupService as service,
  engineeringFollowupStaff as staff,
  engineeringFollowupStores,
} from "../test/engineering-followup-fixtures.js";
import { engineeringService as parentService } from "../test/engineering-fixtures.js";

for (const [name, createStore] of engineeringFollowupStores) {
  describe(`release follow-up durable work (${name})`, () => {
    it.each([
      "completion lease",
      "completion model deadline",
      "restricted finish lease",
    ] as const)(
      "rechecks the parent %s after the actual child source-change planner awaits storage",
      async (phase) => {
        const f = await engineeringFollowupFixture(createStore());
        await f.eligible();
        const refreshed = await f.refreshEvidence();
        const owner = await f.support.claim(
          "parent-classification-claim",
          "parent-classification-worker",
          "ticket",
          30_000,
        );
        expect(owner.fence.sourceGeneration).toBe(
          refreshed.key.sourceGeneration,
        );
        const modelDeadline =
          phase === "completion model deadline"
            ? new Date(Date.parse(f.clock.now()) + 5_000).toISOString()
            : owner.leaseUntil;
        const prepared = await f.app.prepareEngineeringModel(parentService, {
          ...owner.fence,
          binding: await f.support.modelBinding(owner, {
            deadline: modelDeadline,
          }),
        });
        const beforeParent = await f.support.work(
          "ticket",
          refreshed.key.sourceGeneration,
        );
        const before = await f.rows();
        const barrier = engineeringFollowupBarrier();
        let armed = true;
        f.readObserver.afterRead(async (trace) => {
          if (
            !armed ||
            trace.collection !== supportRecords.name ||
            trace.method !== "getVersioned" ||
            (trace.key as { readonly id?: string }).id !==
              "engineering-followup-head"
          )
            return;
          armed = false;
          await barrier.wait();
        });
        const processing = {
          requestId: "PRIVATE_LATE_PARENT_ACCOUNTING",
          costMicros: 17,
        };
        const completing =
          phase === "restricted finish lease"
            ? f.app.finishEngineeringWork(parentService, {
                ...owner.fence,
                stepId: prepared.stepId,
                requestHash: prepared.requestHash,
                disposition: "restricted",
                accounting: "accounted",
                processing,
              })
            : f.app.completeEngineeringModel(
                parentService,
                {
                  ...owner.fence,
                  stepId: prepared.stepId,
                  requestHash: prepared.requestHash,
                  candidate: f.support.candidate({
                    security: "restricted",
                    summary: "PRIVATE_LATE_PARENT_OUTPUT",
                  }),
                  accounting: "accounted",
                  processing,
                },
                async () => {},
              );
        const settled = completing.then(
          () => ({ accepted: true }),
          () => ({ accepted: false }),
        );
        await barrier.reached;
        const expiredAt =
          phase === "completion model deadline"
            ? modelDeadline
            : owner.leaseUntil;
        f.advance(Date.parse(expiredAt) - Date.parse(f.clock.now()) + 1);
        expect(Date.parse(f.clock.now())).toBeGreaterThan(
          Date.parse(expiredAt),
        );
        if (phase === "completion model deadline")
          expect(Date.parse(owner.leaseUntil)).toBeGreaterThan(
            Date.parse(f.clock.now()),
          );
        barrier.release();
        expect(await settled).toEqual({ accepted: false });
        f.readObserver.afterRead(undefined);
        expect(await f.rows()).toEqual(before);
        const current = await f.support.work(
          "ticket",
          refreshed.key.sourceGeneration,
        );
        expect(current.candidate).toBeUndefined();
        expect(current.modelAttempts).toEqual(beforeParent.modelAttempts);
        expect(JSON.stringify(current)).not.toContain(
          "PRIVATE_LATE_PARENT_ACCOUNTING",
        );
        expect(JSON.stringify(current)).not.toContain(
          "PRIVATE_LATE_PARENT_OUTPUT",
        );
      },
    );

    it("queues one prepaid work set and claims only customer-visible conversation without changing the ticket", async () => {
      const f = await engineeringFollowupFixture(createStore());
      const before = (await f.app.readStaffTicket(staff, "ticket")).ticket;
      const key = await f.eligible();
      expect(await f.work()).toMatchObject({
        completionRows: 5,
        messageSlots: 1,
        modelAttempts: [],
      });
      expect(f.modelCommands).toEqual([]);
      const owner = await f.claim();
      expect(owner.sourceFence).toMatchObject(key);
      expect(JSON.stringify(owner.messages)).not.toContain(
        "PRIVATE_ENGINEERING_INTERNAL_NOTE",
      );
      expect(JSON.stringify(owner.messages)).not.toContain(
        "PRIVATE_ENGINEERING_VERIFICATION_REFERENCE",
      );
      expect((await f.app.readStaffTicket(staff, "ticket")).ticket).toEqual(
        before,
      );
      expect((await f.work()).completionRows).toBe(5);
      expect((await f.work()).messageSlots).toBe(1);
    });

    it("applies an expired historical parent classification only to its original associated child", async () => {
      const f = await engineeringFollowupFixture(createStore());
      const oldParent = await f.support.work();
      const oldChild = await f.eligible();
      if (
        oldParent.dispatch === undefined ||
        oldParent.proposal === undefined ||
        oldParent.candidateHash === undefined
      )
        throw new Error(
          "Expected the original real accepted parent candidate and dispatch",
        );
      const originalChild = await f.work(oldChild);
      expect(originalChild.association).toMatchObject({
        engineeringSourceGeneration: oldParent.sourceGeneration,
        dispatchId: oldParent.dispatch.dispatchId,
        repositoryId: oldParent.dispatch.repositoryId,
      });
      await f.refreshEvidence();
      const linked = await f.linkExisting({
        repositoryId: oldParent.dispatch.repositoryId,
        issueId: "new-independently-reviewed-parent-issue",
        issueNumber: 17,
      });
      const context = f.state.context;
      if (context === undefined || context.mapping === undefined)
        throw new Error("Expected the current verified deployment mapping");
      f.state.context = {
        ...context,
        issueHead: {
          ...context.issueHead,
          repositoryId: linked.association.repositoryId,
          issueId: linked.association.issueId,
          issueNumber: linked.association.issueNumber,
          hash: "new-associated-issue-head",
        },
        deploymentHead: {
          ...context.deploymentHead,
          generation: 2,
          hash: "new-associated-deployment-head",
          deploymentEpoch: "new-associated-deployment-epoch",
        },
        mapping: {
          ...context.mapping,
          issueHeadHash: "new-associated-issue-head",
          deploymentHeadHash: "new-associated-deployment-head",
        },
      };
      const observed = await f.observe();
      if (observed.workId === undefined)
        throw new Error("Expected a distinct current association child");
      const newChild = { ticketId: observed.ticketId, workId: observed.workId };
      expect(newChild.workId).not.toBe(oldChild.workId);
      const currentSource = await f.support.source();
      const currentChild = await f.work(newChild);
      expect(currentChild).toMatchObject({
        status: "pending",
        completionRows: 5,
        messageSlots: 1,
        parentSourceGeneration: currentSource.sourceGeneration,
        association: {
          repositoryId: linked.association.repositoryId,
          issueId: linked.association.issueId,
          issueNumber: linked.association.issueNumber,
          dispatchId: linked.association.dispatchId,
          requestHash: linked.association.requestHash,
          engineeringSourceGeneration: linked.key.sourceGeneration,
        },
      });
      expect(linked.key.sourceGeneration).toBeGreaterThan(
        oldParent.sourceGeneration,
      );
      expect(currentSource.sourceGeneration).toBe(linked.key.sourceGeneration);
      expect(currentChild.association.issueId).not.toBe(
        originalChild.association.issueId,
      );
      f.advance(
        Math.max(
          1,
          Date.parse(oldParent.deadline) - Date.parse(f.clock.now()) + 1,
        ),
      );
      expect(Date.parse(f.clock.now())).toBeGreaterThan(
        Date.parse(oldParent.deadline),
      );
      await f.app.finishEngineeringWork(parentService, {
        ticketId: oldParent.ticketId,
        sourceGeneration: oldParent.sourceGeneration,
        workerId: oldParent.dispatch.workerId,
        claimId: oldParent.dispatch.claimId,
        claimGeneration: oldParent.dispatch.claimGeneration,
        stepId: oldParent.proposal.stepId,
        requestHash: oldParent.proposal.requestHash,
        disposition: "restricted",
        classificationCandidateHash: oldParent.candidateHash,
        reason:
          "Historical accepted proposal was independently classified as restricted.",
      });
      expect(await f.support.source()).toEqual(currentSource);
      expect(await f.work(newChild)).toEqual(currentChild);
      expect(await f.work(oldChild)).toMatchObject({
        security: "restricted",
        completionRows: 0,
        messageSlots: 0,
      });
      const classified = await f.support.work(
        "ticket",
        oldParent.sourceGeneration,
      );
      expect(classified.security).toBe("restricted");
      expect(classified.modelAttempts).toEqual(oldParent.modelAttempts);
    });

    it("keeps duplicate physical workers out of an active claim", async () => {
      const f = await engineeringFollowupFixture(createStore());
      const key = await f.eligible();
      const owner = await f.claim();
      const before = await f.rows();
      await expect(
        f.app.claimEngineeringFollowupWork(service, {
          ...key,
          workerId: "duplicate-worker",
          claimId: "duplicate-physical-call",
          leaseMilliseconds: 30_000,
        }),
      ).resolves.toBeNull();
      expect(await f.rows()).toEqual(before);
      expect((await f.work()).claim).toEqual(owner.fence);
    });

    it("recovers the same paid preparation without another attempt or a changed request", async () => {
      const f = await engineeringFollowupFixture(createStore());
      await f.eligible();
      const owner = await f.claim();
      const command = { ...owner.fence, binding: await f.modelBinding(owner) };
      const prepared = await f.app.prepareEngineeringFollowupModel(
        service,
        command,
      );
      const before = await f.rows();
      expect((await f.work()).completionRows).toBe(5);
      expect((await f.work()).messageSlots).toBe(1);
      await expect(
        f.app.prepareEngineeringFollowupModel(service, command),
      ).resolves.toEqual(prepared);
      expect(await f.rows()).toEqual(before);
      await expect(
        f.app.prepareEngineeringFollowupModel(service, {
          ...command,
          binding: {
            ...command.binding,
            inputFingerprint: "different-paid-input",
          },
        }),
      ).rejects.toThrow();
      expect(await f.rows()).toEqual(before);
      expect((await f.work()).modelAttempts).toHaveLength(1);
    });

    it("does not let replacement claims complete another invocation's prepared model request", async () => {
      const f = await engineeringFollowupFixture(createStore());
      const key = await f.eligible();
      const owner = await f.claim();
      const prepared = await f.app.prepareEngineeringFollowupModel(service, {
        ...owner.fence,
        binding: await f.modelBinding(owner),
      });
      f.advance(Date.parse(owner.leaseUntil) - Date.parse(f.clock.now()) + 1);
      expect(Date.parse(f.clock.now())).toBeGreaterThan(
        Date.parse(owner.leaseUntil),
      );
      const replacement = await f.claim(key);
      expect(replacement.fence.claimGeneration).toBeGreaterThan(
        owner.fence.claimGeneration,
      );
      const before = await f.rows();
      for (const fence of [owner.fence, replacement.fence]) {
        await expect(
          f.app.completeEngineeringFollowupModel(
            service,
            {
              ...fence,
              stepId: prepared.stepId,
              requestHash: prepared.requestHash,
              candidate: f.candidate(),
              accounting: "accounted",
            },
            async () => {},
          ),
        ).rejects.toThrow();
        expect(await f.rows()).toEqual(before);
      }
      expect((await f.work()).candidate).toBeUndefined();
      expect((await f.work()).modelAttempts).toHaveLength(1);
    });

    it("recovers a committed model completion after lost ACK, replacement and configuration disablement", async () => {
      const f = await engineeringFollowupFixture(createStore());
      await f.eligible();
      const owner = await f.claim();
      const prepared = await f.app.prepareEngineeringFollowupModel(service, {
        ...owner.fence,
        binding: await f.modelBinding(owner),
      });
      const command = {
        ...owner.fence,
        stepId: prepared.stepId,
        requestHash: prepared.requestHash,
        candidate: f.candidate(),
        accounting: "accounted" as const,
      };
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
            const row = action.value as Partial<EngineeringFollowupWorkRecord>;
            return (
              row.kind === "engineering_followup_work" &&
              row.stage === "bundle" &&
              row.status === "candidate" &&
              row.lastCompletion !== undefined
            );
          })
        ) {
          lost = true;
          throw new Error("Synthetic committed follow-up completion ACK lost");
        }
        return outcome;
      });
      await expect(
        f.app.completeEngineeringFollowupModel(
          service,
          command,
          async () => {},
        ),
      ).rejects.toThrow("ACK lost");
      f.observed.intercept(undefined);
      expect(lost).toBe(true);
      const committed = await f.work();
      f.advance(Date.parse(owner.leaseUntil) - Date.parse(f.clock.now()) + 1);
      expect(Date.parse(f.clock.now())).toBeGreaterThan(
        Date.parse(owner.leaseUntil),
      );
      const replacement = await f.claim();
      const before = await f.rows();
      const disabled = f.support.freshApplication({
        engineeringFollowup: { enabled: false },
      });
      await expect(
        disabled.completeEngineeringFollowupModel(
          service,
          command,
          async () => {
            throw new Error(
              "A historical completion must not rerun current guards",
            );
          },
        ),
      ).resolves.toEqual(committed.lastCompletion!.result);
      expect(await f.rows()).toEqual(before);
      expect((await f.work()).claim).toEqual(replacement.fence);
      const denied = {
        ...service,
        permissions: service.permissions.filter(
          (permission) =>
            permission !== supportPermissions.engineeringFollowupProcess,
        ),
      };
      await expect(
        disabled.completeEngineeringFollowupModel(
          denied,
          command,
          async () => {},
        ),
      ).rejects.toThrow();
      expect(await f.rows()).toEqual(before);
    });

    it("holds a model completion when a relevant customer reply occurs during its awaited guard", async () => {
      const f = await engineeringFollowupFixture(createStore());
      await f.eligible();
      const owner = await f.claim();
      const prepared = await f.app.prepareEngineeringFollowupModel(service, {
        ...owner.fence,
        binding: await f.modelBinding(owner),
      });
      const barrier = engineeringFollowupBarrier();
      const completing = f.app.completeEngineeringFollowupModel(
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
      const settled = completing.catch(() => undefined);
      await barrier.reached;
      try {
        await f.app.replyToCustomerTicket(customer, {
          ...f.command("customer-during-followup-model"),
          messageId: "current-customer-context",
          body: "My deployment now has a different symptom.",
        });
      } finally {
        barrier.release();
      }
      await settled;
      expect((await f.work()).candidate).toBeUndefined();
      expect((await f.work()).completionRows).toBe(0);
      expect((await f.work()).messageSlots).toBe(0);
      expect((await f.work()).delivered).toBeUndefined();
    });

    it.each(["open", "resolved", "closed"] as const)(
      "prepares one private bundle and atomically posts one informational web notice to an %s ticket",
      async (status) => {
        const f = await engineeringFollowupFixture(createStore());
        if (status !== "open")
          await f.app.resolveTicket(
            staff,
            f.command("resolve-before-followup"),
          );
        if (status === "closed")
          await f.app.closeTicket(staff, f.command("close-before-followup"));
        await f.eligible();
        const ticket = (await f.app.readStaffTicket(staff, "ticket")).ticket;
        const parent = await f.support.source();
        const rowCount = (await f.rows()).length;
        await f.prepareCandidate();
        expect(await f.rows()).toHaveLength(rowCount);
        expect(await f.work()).toMatchObject({
          completionRows: 5,
          messageSlots: 1,
        });
        const prepared = await f.prepareBundle();
        expect(await f.rows()).toHaveLength(rowCount + 2);
        expect(await f.work()).toMatchObject({
          status: "bundle_prepared",
          completionRows: 3,
          messageSlots: 1,
        });
        expect((await f.work()).candidate).toBeUndefined();
        const before = await f.rows();
        const posted = await f.post({
          messageId: "stable-release-followup-notice",
          access: {
            ...staff,
            permissions: [
              supportPermissions.engineeringFollowupReview,
              supportPermissions.replyAny,
              supportPermissions.queueRead,
            ],
          },
        });
        const after = await f.rows();
        expect(after).toHaveLength(before.length + 3);
        const added = after.filter(
          (row) => !before.some((old) => old.id === row.id),
        );
        expect(added.map((row) => row.kind).sort()).toEqual([
          "audit",
          "engineering_followup_receipt",
          "message",
        ]);
        const notice = added.find((row) => row.kind === "message");
        if (notice?.kind !== "message")
          throw new Error("Expected the actual canonical notice");
        expect(notice.message).toMatchObject({
          id: posted.command.messageId,
          authorKind: "staff",
          authorPrincipalId: staff.principalId,
          channel: "web",
          visibility: "customer",
          format: "plain_text",
          body: prepared.bundle.customerDraft.body,
        });
        const current = (await f.app.readStaffTicket(staff, "ticket")).ticket;
        expect(current.status).toBe(status);
        expect(current.revision).toBe(ticket.revision + 1);
        expect(current.handling).toEqual(ticket.handling);
        expect(current.resolvedAt).toBe(ticket.resolvedAt);
        expect(current.closedAt).toBe(ticket.closedAt);
        expect(current.firstStaffRespondedAt).toBe(
          ticket.firstStaffRespondedAt,
        );
        expect(await f.work()).toMatchObject({
          status: "delivered",
          completionRows: 0,
          messageSlots: 0,
        });
        expect((await f.support.source()).sourceGeneration).toBe(
          parent.sourceGeneration,
        );
        expect((await f.support.source()).followupRevocationEpoch).toBe(
          parent.followupRevocationEpoch,
        );
        expect(after.filter((row) => row.kind === "delivery_job")).toEqual(
          before.filter((row) => row.kind === "delivery_job"),
        );
        expect((await f.work()).handoff?.kbProposal).toEqual(
          prepared.bundle.kbProposal,
        );
        expect((await f.work()).handoff?.retestRequests).toEqual(
          prepared.bundle.retestRequests,
        );
        await expect(
          f.app.approveAndPostEngineeringFollowupWebUpdate(
            staff,
            posted.command,
            async () => {},
          ),
        ).resolves.toEqual(posted.result);
        expect(await f.rows()).toEqual(after);
      },
    );

    it("replays a lost bundle ACK after a private rejection and configuration disablement without unholding it", async () => {
      const f = await engineeringFollowupFixture(createStore());
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
            const row = action.value as Partial<EngineeringFollowupWorkRecord>;
            return (
              row.kind === "engineering_followup_work" &&
              row.status === "bundle_prepared" &&
              row.preparedBundle !== undefined
            );
          })
        ) {
          lost = true;
          throw new Error("Synthetic exact bundle ACK lost");
        }
        return outcome;
      });
      await f.prepareBundle().catch(() => undefined);
      f.observed.intercept(undefined);
      expect(lost).toBe(true);
      const command = f.bundleCommands.at(-1)!;
      const work = await f.work();
      const committedRows = await f.rows();
      const receipt = committedRows.find(
        (row) =>
          row.kind === "engineering_followup_receipt" &&
          "status" in row.result &&
          row.result.status === "bundle_prepared",
      );
      if (receipt?.kind !== "engineering_followup_receipt")
        throw new Error("Expected the committed bundle receipt");
      await f.app.rejectEngineeringFollowupBundle(staff, {
        ...f.command("reject-after-lost-bundle-ack"),
        ...f.key,
        expectedWorkGeneration: work.workGeneration,
        bundleHash: work.preparedBundle!.bundleHash,
        reason: "Staff rejected this exact draft.",
      });
      const before = await f.rows();
      const disabled = f.support.freshApplication({
        engineeringFollowup: { enabled: false },
      });
      await expect(
        disabled.prepareEngineeringFollowupBundle(
          service,
          command,
          async () => {
            throw new Error(
              "A historical bundle must not rerun current export checks",
            );
          },
        ),
      ).resolves.toEqual(receipt.result);
      expect(await f.rows()).toEqual(before);
      expect(await f.work()).toMatchObject({
        status: "held",
        completionRows: 0,
        messageSlots: 0,
      });
    });

    it("recovers a lost atomic notice ACK after a new visible generation without another message or email job", async () => {
      const f = await engineeringFollowupFixture(createStore());
      await f.eligible();
      await f.prepareBundle();
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
            const row = action.value as Partial<EngineeringFollowupWorkRecord>;
            return (
              row.kind === "engineering_followup_work" &&
              row.status === "delivered" &&
              row.delivered?.messageId === "notice-with-lost-ack"
            );
          })
        ) {
          lost = true;
          throw new Error("Synthetic atomic notice ACK lost");
        }
        return outcome;
      });
      await f
        .post({ messageId: "notice-with-lost-ack" })
        .catch(() => undefined);
      f.observed.intercept(undefined);
      expect(lost).toBe(true);
      const command = f.postCommands.at(-1)!;
      const receipt = (await f.rows()).find(
        (row) =>
          row.kind === "engineering_followup_receipt" &&
          "messageId" in row.result &&
          row.result.messageId === command.messageId,
      );
      if (receipt?.kind !== "engineering_followup_receipt")
        throw new Error("Expected the actual post receipt");
      await f.app.replyToCustomerTicket(customer, {
        ...f.command("new-message-after-notice"),
        messageId: "customer-after-notice",
        body: "I can now see the fixed build.",
      });
      const before = await f.rows();
      const disabled = f.support.freshApplication({
        engineeringFollowup: { enabled: false },
      });
      await expect(
        disabled.approveAndPostEngineeringFollowupWebUpdate(
          staff,
          command,
          async () => {
            throw new Error(
              "Historical posting must not rerun live proof guards",
            );
          },
        ),
      ).resolves.toEqual(receipt.result);
      expect(await f.rows()).toEqual(before);
      expect(
        before.filter(
          (row) =>
            row.kind === "message" && row.message.id === command.messageId,
        ),
      ).toHaveLength(1);
      expect(await f.work()).toMatchObject({
        status: "delivered",
        completionRows: 0,
        messageSlots: 0,
      });
      await expect(
        disabled.approveAndPostEngineeringFollowupWebUpdate(
          service,
          command,
          async () => {},
        ),
      ).rejects.toThrow();
      expect(await f.rows()).toEqual(before);
    });

    it("records private rejection without provider, release or check ports and spends only its own two rows", async () => {
      const f = await engineeringFollowupFixture(createStore());
      await f.eligible();
      const prepared = await f.prepareBundle();
      const before = await f.rows();
      const disabled = f.support.freshApplication({
        engineeringFollowup: {
          enabled: false,
        },
      });
      const access = {
        ...staff,
        permissions: [
          supportPermissions.engineeringFollowupReview,
          supportPermissions.queueRead,
        ],
      };
      const command = {
        ...f.command("private-reject-without-ports"),
        ...f.key,
        expectedWorkGeneration: prepared.work.workGeneration,
        bundleHash: prepared.work.preparedBundle!.bundleHash,
        reason: "This exact private draft is not ready for the customer.",
      };
      const rejected = await disabled.rejectEngineeringFollowupBundle(
        access,
        command,
      );
      const after = await f.rows();
      expect(after).toHaveLength(before.length + 2);
      expect(await f.work()).toMatchObject({
        status: "held",
        completionRows: 0,
        messageSlots: 0,
      });
      expect((await f.work()).preparedBundle!.bundle).toEqual(prepared.bundle);
      await expect(
        disabled.rejectEngineeringFollowupBundle(access, command),
      ).resolves.toEqual(rejected);
      expect(await f.rows()).toEqual(after);
      await expect(f.post()).rejects.toThrow();
      expect((await f.work()).delivered).toBeUndefined();
    });

    it("refuses expired normal preparation and requires explicit staff reassessment without another paid attempt", async () => {
      const f = await engineeringFollowupFixture(createStore(), {
        followup: { maxWorkMilliseconds: 10_000 },
      });
      f.state.validForMilliseconds = 3_600_000;
      await f.eligible();
      const completed = await f.prepareCandidate();
      const expired = await f.work();
      f.advance(Date.parse(expired.deadline) - Date.parse(f.clock.now()) + 1);
      expect(Date.parse(f.clock.now())).toBeGreaterThan(
        Date.parse(expired.deadline),
      );
      const before = await f.rows();
      await expect(f.prepareBundle({ mode: "prepare" })).rejects.toThrow();
      expect(await f.rows()).toEqual(before);
      await expect(
        f.app.confirmEngineeringFollowupCurrent(service, {
          ...f.key,
          workBindingHash: expired.workBindingHash,
          expectedWorkGeneration: expired.workGeneration,
        }),
      ).resolves.toBe(false);
      await expect(
        f.app.completeEngineeringFollowupModel(
          service,
          completed.completeCommand,
          async () => {
            throw new Error(
              "The recorded completion acknowledgement is independent of the expired work deadline",
            );
          },
        ),
      ).resolves.toEqual(completed.result);
      expect(await f.rows()).toEqual(before);
      const reassessed = await f.prepareBundle({ mode: "staff_reassessment" });
      expect(await f.rows()).toHaveLength(before.length + 2);
      expect(reassessed.work).toMatchObject({
        workId: expired.workId,
        status: "bundle_prepared",
        completionRows: 3,
        messageSlots: 1,
      });
      expect(Date.parse(reassessed.work.deadline)).toBeGreaterThan(
        Date.parse(f.clock.now()),
      );
      expect(reassessed.work.usageTombstones).toEqual(expired.usageTombstones);
      expect(f.modelCommands).toHaveLength(1);
    });

    it("refuses an expired prepared bundle despite current external proofs but replays its historical preparation acknowledgement", async () => {
      const f = await engineeringFollowupFixture(createStore(), {
        followup: { maxWorkMilliseconds: 10_000 },
      });
      f.state.validForMilliseconds = 3_600_000;
      await f.eligible();
      const prepared = await f.prepareBundle();
      f.advance(
        Date.parse(prepared.work.deadline) - Date.parse(f.clock.now()) + 1,
      );
      expect(Date.parse(f.clock.now())).toBeGreaterThan(
        Date.parse(prepared.work.deadline),
      );
      const before = await f.rows();
      await expect(
        f.post({ messageId: "must-not-post-expired-bundle" }),
      ).rejects.toThrow();
      expect(await f.rows()).toEqual(before);
      await expect(
        f.app.prepareEngineeringFollowupBundle(
          service,
          prepared.command,
          async () => {
            throw new Error(
              "An exact accepted preparation acknowledgement must not re-run live guards",
            );
          },
        ),
      ).resolves.toEqual(prepared.result);
      expect(await f.rows()).toEqual(before);
      expect((await f.work()).delivered).toBeUndefined();
      expect((await f.work()).preparedBundle).toEqual(
        prepared.work.preparedBundle,
      );
    });

    it("requires explicit reassessment with fresh checks and readmission under the same ID without resetting paid attempts", async () => {
      const f = await engineeringFollowupFixture(createStore(), {
        followup: { maxModelAttempts: 1 },
      });
      const key = await f.eligible();
      const prepared = await f.prepareBundle();
      await f.app.rejectEngineeringFollowupBundle(staff, {
        ...f.command("reject-before-reassessment"),
        ...key,
        expectedWorkGeneration: prepared.work.workGeneration,
        bundleHash: prepared.work.preparedBundle!.bundleHash,
        reason: "Staff requested a fresh applicability check.",
      });
      const held = await f.work();
      expect(held.preparedBundle).toBeDefined();
      f.advance(Date.parse(held.deadline) - Date.parse(f.clock.now()) + 1);
      expect(Date.parse(f.clock.now())).toBeGreaterThan(
        Date.parse(held.deadline),
      );
      await expect(f.prepareBundle({ mode: "prepare" })).rejects.toThrow();
      const reassessed = await f.prepareBundle({ mode: "staff_reassessment" });
      expect(reassessed.key).toEqual(key);
      expect(reassessed.work.workId).toBe(held.workId);
      expect(reassessed.work.modelAttempts).toEqual(held.modelAttempts);
      expect(reassessed.work.bundleRevision).toBe(held.bundleRevision + 1);
      expect(reassessed.work).toMatchObject({
        status: "bundle_prepared",
        completionRows: 3,
        messageSlots: 1,
      });
      expect(f.modelCommands).toHaveLength(1);
      await f.post();
      expect((await f.work()).status).toBe("delivered");
      await expect(
        f.prepareBundle({ mode: "staff_reassessment" }),
      ).rejects.toThrow();
      expect((await f.work()).modelAttempts).toEqual(held.modelAttempts);
    });

    it("never rearms a delivered semantic notice after revocation, fresh proof and a newly reviewed existing-issue association", async () => {
      const f = await engineeringFollowupFixture(createStore());
      const first = await f.eligible();
      const prepared = await f.prepareBundle();
      const posted = await f.post({ messageId: "one-semantic-release-notice" });
      await f.app.invalidateEngineeringSource(staff, {
        ...f.command("revoke-after-delivery"),
        reason: "evidence_revoked",
      });
      await f.refreshEvidence();
      await f.linkExisting();
      const retained = await f.work();
      const beforeObservation = await f.rows();
      const observation = await f.observe();
      expect(observation.outcome).toBe("unchanged");
      if (observation.workId !== undefined)
        expect(observation.workId).toBe(first.workId);
      expect(await f.rows()).toEqual(beforeObservation);
      expect(await f.work()).toEqual(retained);
      expect(retained.workId).toBe(first.workId);
      expect(retained.delivered).toEqual(posted.work.delivered);
      expect((await f.head()).workCount).toBe(1);
      expect(
        (await f.rows()).filter(
          (row) => row.kind === "engineering_followup_work",
        ),
      ).toHaveLength(1);
      expect(await f.work()).toMatchObject({
        status: "delivered",
        completionRows: 0,
        messageSlots: 0,
      });
      await expect(
        f.prepareBundle({ mode: "staff_reassessment" }),
      ).rejects.toThrow();
      const ticket = (await f.app.readStaffTicket(staff, "ticket")).ticket;
      const before = await f.rows();
      await expect(
        f.app.approveAndPostEngineeringFollowupWebUpdate(
          staff,
          {
            ...posted.command,
            ...f.command("cannot-rearm-delivered"),
            expectedWorkGeneration: (await f.work()).workGeneration,
            expectedTicketRevision: ticket.revision,
            messageId: "forbidden-second-notice",
          },
          async () => {},
        ),
      ).rejects.toThrow();
      expect(await f.rows()).toEqual(before);
      expect(
        before.filter(
          (row) =>
            row.kind === "message" &&
            row.message.id === posted.command.messageId,
        ),
      ).toHaveLength(1);
      expect(
        before.find(
          (row) =>
            row.kind === "message" &&
            row.message.id === posted.command.messageId,
        ),
      ).toMatchObject({
        kind: "message",
        message: { body: prepared.bundle.customerDraft.body },
      });
      expect(f.modelCommands).toHaveLength(1);
    });

    it("recovers only the original staff preparation acknowledgement after withdrawal without reading private source or work", async () => {
      const f = await engineeringFollowupFixture(createStore());
      await f.eligible();
      const prepared = await f.prepareBundle();
      await f.app.rejectEngineeringFollowupBundle(staff, {
        ...f.command("reject-before-recoverable-reassessment"),
        ...f.key,
        expectedWorkGeneration: prepared.work.workGeneration,
        bundleHash: prepared.work.preparedBundle!.bundleHash,
        reason:
          "Refresh the exact private proposal with independently current checks.",
      });
      await f
        .prepareBundle({
          mode: "staff_reassessment",
          beforePrepare() {
            throw new Error(
              "Capture the actual reassessment input before acceptance",
            );
          },
        })
        .catch(() => undefined);
      const built = f.bundleCommands.at(-1);
      if (built?.mode !== "staff_reassessment")
        throw new Error("Expected an actual staff reassessment command");
      const command = { ...built, recoveryIntentHash: "d".repeat(64) };
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
            const row = action.value as {
              readonly kind?: string;
              readonly id?: string;
            };
            return (
              row.kind === "engineering_followup_receipt" &&
              row.id === `engineering-followup-command:${command.commandId}`
            );
          })
        ) {
          lost = true;
          throw new Error(
            "Accepted reassessment acknowledgement lost after its real durable commit",
          );
        }
        return outcome;
      });
      await f.app
        .prepareEngineeringFollowupBundle(staff, command, async () => {})
        .catch(() => undefined);
      f.observed.intercept(undefined);
      expect(lost).toBe(true);
      const receipt = (await f.rows()).find(
        (row) =>
          row.kind === "engineering_followup_receipt" &&
          row.id === `engineering-followup-command:${command.commandId}`,
      );
      if (receipt?.kind !== "engineering_followup_receipt")
        throw new Error("Expected the durable staff preparation receipt");
      await f.app.withdrawEngineeringSource(staff, {
        ...f.command("withdraw-before-preparation-recovery"),
        reason: "privacy_withdrawal",
      });
      const before = await f.rows();
      const omitted = f.support.freshApplicationWithoutEngineeringFollowup();
      const access = {
        ...staff,
        permissions: [
          supportPermissions.engineeringFollowupReview,
          supportPermissions.queueRead,
        ],
      };
      const recover = {
        ...f.key,
        commandId: command.commandId,
        recoveryIntentHash: command.recoveryIntentHash,
      };
      const reads: string[] = [];
      f.readObserver.afterRead(async (trace) => {
        if (trace.collection !== supportRecords.name) return;
        const id = (trace.key as { readonly id?: string }).id;
        if (id !== `engineering-followup-command:${command.commandId}`)
          throw new Error(
            `Receipt recovery unexpectedly read private state: ${String(id)}`,
          );
        reads.push(id);
      });
      await expect(
        omitted.recoverEngineeringFollowupPreparation(access, recover),
      ).resolves.toEqual(receipt.result);
      await expect(
        omitted.recoverEngineeringFollowupPreparation(
          { ...access, principalId: "another-staff-principal" },
          recover,
        ),
      ).rejects.toThrow();
      await expect(
        omitted.recoverEngineeringFollowupPreparation(access, {
          ...recover,
          recoveryIntentHash: "e".repeat(64),
        }),
      ).rejects.toThrow();
      await expect(
        omitted.recoverEngineeringFollowupPreparation(
          { ...access, permissions: [supportPermissions.queueRead] },
          recover,
        ),
      ).rejects.toThrow();
      f.readObserver.afterRead(undefined);
      expect(reads.length).toBeGreaterThan(0);
      expect(await f.rows()).toEqual(before);
      expect((await f.work()).withdrawn).toBe(true);
    });
  });
}
