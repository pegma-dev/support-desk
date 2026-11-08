import {
  createInboundMailProcessor,
  supportPermissions,
  supportRecords,
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

type Fixture = Awaited<ReturnType<typeof engineeringFollowupFixture>>;

async function observeReference(f: Fixture, inputReference: string) {
  const association = await f.association();
  return f.app.observeEngineeringFollowup(service, {
    ...f.command("explicit-followup-observation"),
    association: {
      repositoryId: association.repositoryId,
      issueId: association.issueId,
    },
    inputReference,
  });
}

const followupRows = async (f: Fixture) =>
  (await f.rows()).filter((row) => row.kind === "engineering_followup_work");

for (const [name, createStore] of engineeringFollowupStores) {
  describe(`engineering follow-up source (${name})`, () => {
    it("queues a private work set only from a real approved accepted ordinary engineering association and applicable deployed mapping", async () => {
      const f = await engineeringFollowupFixture(createStore());
      const association = await f.association();
      const source = await f.support.source();
      expect(association.followupRevocationEpoch).toBe(
        source.followupRevocationEpoch,
      );
      expect((await f.support.work()).status).toBe("accepted");
      const key = await f.eligible();
      const work = await f.work(key);
      expect(work).toMatchObject({
        status: "pending",
        stage: "model",
        security: "ordinary",
        association,
        semanticIdentity: {
          repositoryId: association.repositoryId,
          issueId: association.issueId,
          semanticMappingId: f.state.context!.mapping!.semanticMappingId,
          deploymentEpoch: f.state.context!.deploymentHead.deploymentEpoch,
        },
        modelAttempts: [],
        completionRows: 5,
        messageSlots: 1,
      });
      expect(work.context?.mapping?.fixedProduct).toEqual({
        productId: "workspace",
        version: "2.3.1",
        buildId: "build-fixed-231",
      });
      expect(f.verifyInput).toHaveBeenCalledOnce();
      expect(f.support.generate).toHaveBeenCalledTimes(1);
      const customerDto = JSON.stringify(
        await f.app.readCustomerTicket(customer, "ticket"),
      );
      for (const secret of [
        association.issueId,
        "PRIVATE_RELEASE_REF",
        "PRIVATE_MAPPING_ID",
        "workBindingHash",
        "engineering_followup_work",
      ])
        expect(customerDto).not.toContain(secret);
    });

    it.each([
      "unknown signed input",
      "verification refusal",
      "repository not allowlisted",
    ] as const)(
      "holds %s without a follow-up job or paid call",
      async (reason) => {
        const f = await engineeringFollowupFixture(createStore());
        const input =
          reason === "unknown signed input"
            ? "unverified-caller-input"
            : await f.issueInput();
        if (reason === "verification refusal") f.state.inputOutcome = "refused";
        if (reason === "repository not allowlisted")
          f.state.allowedRepositories = [];
        expect((await observeReference(f, input)).outcome).toBe("held");
        expect(await followupRows(f)).toEqual([]);
        expect(f.support.generate).toHaveBeenCalledTimes(1);
      },
    );

    it.each([
      "missing mapping",
      "tag or package release",
      "wrong affected product",
      "wrong fixed product",
      "wrong issue head",
      "wrong deployment head",
    ] as const)(
      "does not qualify %s as an applicable deployed fix",
      async (variant) => {
        const f = await engineeringFollowupFixture(createStore());
        const context = structuredClone(f.state.context!);
        if (
          variant === "missing mapping" ||
          variant === "tag or package release"
        ) {
          const { mapping: _mapping, ...unmapped } = context;
          f.state.context = {
            ...unmapped,
            ...(variant === "tag or package release"
              ? {
                  deploymentHead: {
                    ...context.deploymentHead,
                    state: "unknown" as const,
                  },
                }
              : {}),
          };
        } else {
          const mapping = context.mapping!;
          f.state.context = {
            ...context,
            mapping: {
              ...mapping,
              ...(variant === "wrong affected product"
                ? {
                    affectedProductBinding:
                      "different-affected-product-binding",
                  }
                : {}),
              ...(variant === "wrong fixed product"
                ? {
                    fixedProduct: {
                      ...mapping.fixedProduct,
                      productId: "other-product",
                    },
                  }
                : {}),
              ...(variant === "wrong issue head"
                ? { issueHeadHash: "different-issue-head" }
                : {}),
              ...(variant === "wrong deployment head"
                ? { deploymentHeadHash: "different-deployment-head" }
                : {}),
            },
          };
        }
        expect((await f.observe()).outcome).toBe("held");
        expect(await followupRows(f)).toEqual([]);
        expect(f.support.generate).toHaveBeenCalledTimes(1);
      },
    );

    it("returns body-free bounded association hints and confirms the real source again when a hint is observed", async () => {
      const f = await engineeringFollowupFixture(createStore());
      const expected = await f.association();
      const associations = [];
      let cursor: string | undefined;
      for (let pageNumber = 0; pageNumber < 128; pageNumber += 1) {
        const page = await f.scan(service, 1, cursor);
        expect(page.pages).toBe(1);
        expect(page.physicalRows).toBeLessThanOrEqual(1);
        associations.push(...page.associations);
        if (page.nextCursor === null) break;
        cursor = page.nextCursor;
        if (pageNumber === 127)
          throw new Error("Follow-up association scan exceeded 128 pages");
      }
      expect(associations).toContainEqual(expected);
      for (const hint of associations)
        expect(Object.keys(hint).sort()).toEqual([
          "dispatchId",
          "engineeringSourceGeneration",
          "followupRevocationEpoch",
          "issueId",
          "issueNumber",
          "repositoryId",
          "requestHash",
          "ticketId",
        ]);
      const input = await f.issueInput();
      await f.app.withdrawEngineeringSource(staff, {
        ...f.command("withdraw-after-association-hint"),
        reason: "privacy_withdrawal",
      });
      const result = await f.app.observeEngineeringFollowup(service, {
        ...f.command("confirm-stale-association-hint"),
        association: {
          repositoryId: expected.repositoryId,
          issueId: expected.issueId,
        },
        inputReference: input,
      });
      expect(result.outcome).toBe("held");
      expect(await followupRows(f)).toEqual([]);
    });

    it("rejects oversized physical scan pages before key reads or external source confirmation", async () => {
      const f = await engineeringFollowupFixture(createStore());
      await expect(f.scan(service, 65)).rejects.toThrow();
      expect(f.readObserver.scans).toEqual([]);
      const page = await f.scan(service, 64);
      expect(page.pages).toBe(1);
      expect(page.physicalRows).toBeLessThanOrEqual(64);
      f.readObserver.reads.length = 0;
      f.verifyInput.mockClear();
      f.confirm.mockClear();
      f.readObserver.overreturnScans();
      await expect(f.scan(service, 1)).rejects.toThrow();
      expect(f.readObserver.scans.at(-1)).toMatchObject({
        limit: 1,
        physicalRows: 2,
      });
      expect(f.readObserver.reads).toEqual([]);
      expect(f.verifyInput).not.toHaveBeenCalled();
      expect(f.confirm).not.toHaveBeenCalled();
    });

    it.each(["source epoch", "destination epoch"] as const)(
      "holds a real legacy association missing its %s",
      async (missing) => {
        const f = await engineeringFollowupFixture(createStore());
        const association = await f.association();
        const input = await f.issueInput();
        const source = await f.support.source();
        // Migration fixture: omit only optional epoch metadata from the actual
        // service-produced row and pass the legacy shape through the real codec.
        const { followupRevocationEpoch: _epoch, ...legacySource } = source;
        await f.backing.collection(supportRecords).put(
          missing === "source epoch"
            ? legacySource
            : {
                ...source,
                destinations: source.destinations.map(
                  ({
                    followupRevocationEpoch: _captured,
                    ...legacyDestination
                  }) => legacyDestination,
                ),
              },
        );
        expect(
          (
            await f.app.observeEngineeringFollowup(service, {
              ...f.command("observe-legacy-association"),
              association: {
                repositoryId: association.repositoryId,
                issueId: association.issueId,
              },
              inputReference: input,
            })
          ).outcome,
        ).toBe("held");
        expect(await followupRows(f)).toEqual([]);
      },
    );

    it("keeps a late accepted export bound to its dispatch-start epoch after explicit revocation", async () => {
      const f = await engineeringFollowupFixture(createStore(), {
        associate: false,
      });
      await f.support.prepareProposal();
      await f.support.approve();
      const before = await f.support.source();
      const gate = engineeringFollowupBarrier();
      f.support.setGitHubCreate(async (request, context) => {
        await gate.wait();
        return f.support.acceptIssue(
          request,
          {
            repositoryId: request.repository.repositoryId,
            issueId: f.state.context!.issueHead.issueId,
            issueNumber: f.state.context!.issueHead.issueNumber,
          },
          context,
        );
      });
      const pending = f.support.engineering.processWork(
        f.support.nextCommand(),
      );
      try {
        await Promise.race([
          gate.reached,
          pending.then(() => {
            throw new Error("Export did not reach the physical-create barrier");
          }),
        ]);
        const started = (await f.support.source()).destinations[0]!;
        expect(started.followupRevocationEpoch).toBe(
          before.followupRevocationEpoch,
        );
        await f.app.invalidateEngineeringSource(staff, {
          ...f.command("revoke-during-export"),
          reason: "evidence_revoked",
        });
      } finally {
        gate.release();
      }
      await pending;
      const source = await f.support.source();
      const destination = source.destinations[0]!;
      expect(destination).toMatchObject({
        outcome: "accepted",
        followupRevocationEpoch: before.followupRevocationEpoch,
      });
      expect(source.followupRevocationEpoch).toBe(
        before.followupRevocationEpoch! + 1,
      );
      expect((await f.observe()).outcome).toBe("held");
      expect(await followupRows(f)).toEqual([]);
      expect(f.support.createIssue).toHaveBeenCalledOnce();
    });

    it("requires an explicitly checked and reviewed new association after revocation; fresh ordinary proof alone never revives the old destination", async () => {
      const f = await engineeringFollowupFixture(createStore());
      const original = await f.association();
      await f.app.invalidateEngineeringSource(staff, {
        ...f.command("revoke-original-followup-authority"),
        reason: "product_binding_revoked",
      });
      const ticket = (await f.app.readStaffTicket(staff, "ticket")).ticket;
      await f.app.submitEngineeringEvidence(staff, {
        ...f.command("fresh-proof-after-revocation"),
        expectedRevision: ticket.revision,
        security: "ordinary",
        evidence: {
          ...(await f.support.reportInput()),
          verificationReference:
            "new-independent-verified-failure-after-revocation",
        },
      });
      expect((await f.support.source()).state).toBe("eligible");
      expect((await f.association()).followupRevocationEpoch).toBe(
        original.followupRevocationEpoch,
      );
      expect((await f.observe()).outcome).toBe("held");
      expect(await followupRows(f)).toEqual([]);
      const linked = await f.linkExisting();
      expect(linked.association.issueId).toBe(original.issueId);
      expect(linked.association.followupRevocationEpoch).toBe(
        (await f.support.source()).followupRevocationEpoch,
      );
      expect(linked.association.followupRevocationEpoch).toBeGreaterThan(
        original.followupRevocationEpoch,
      );
      const key = await f.eligible();
      expect((await f.work(key)).association).toEqual(linked.association);
      expect(await followupRows(f)).toHaveLength(1);
      expect(f.support.createIssue).toHaveBeenCalledOnce();
      expect(f.support.githubReconcile).toHaveBeenCalled();
    });

    it("rechecks the private work reader's principal after an actual awaited Store read", async () => {
      const f = await engineeringFollowupFixture(createStore(), {
        observe: true,
      });
      const gate = engineeringFollowupBarrier();
      const actor = {
        ...staff,
        principalId: "followup-original-reader",
        permissions: [...staff.permissions],
      };
      f.readObserver.afterRead(async (trace) => {
        if (
          typeof trace.key === "object" &&
          trace.key !== null &&
          "id" in trace.key &&
          trace.key.id === `engineering-followup:${f.key.workId}`
        )
          await gate.wait();
      });
      const pending = f.app.readEngineeringFollowupWork(actor, f.key).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      try {
        await Promise.race([
          gate.reached,
          pending.then(() => {
            throw new Error(
              "Private follow-up read did not reach its real-read barrier",
            );
          }),
        ]);
        actor.principalId = "different-followup-reader";
      } finally {
        gate.release();
      }
      expect(await pending).toHaveProperty("error");
      await expect(
        f.app.readEngineeringFollowupWork(customer, f.key),
      ).rejects.toMatchObject({
        permission: supportPermissions.engineeringFollowupRead,
      });
    });

    it("requires authenticated web support before admitting follow-up for an otherwise real accepted mail association", async () => {
      const f = await engineeringFollowupFixture(createStore());
      const processor = createInboundMailProcessor({
        store: f.store,
        clock: f.clock,
        accountMatcher: {
          matchSenderEmail: async () => ({
            matches: "one",
            principalId: customer.principalId,
          }),
        },
        routingPolicy: { routeNewConversation: () => ({ priority: "normal" }) },
      });
      await processor.processInboundEmail({
        channelId: "followup-mail",
        providerEventId: "followup-new-mail-ticket",
        ticketId: "mail-ticket",
        messageId: "mail-initial",
        correlationId: "followup-mail-test",
        from: "mail-followup@fixtures.invalid",
        senderAuthentication: {
          method: "host_identity",
          result: "pass",
          email: "mail-followup@fixtures.invalid",
        },
        subject: "The workspace export is empty",
        body: "The exported file contains no rows.",
      });
      const ticket = (await f.app.readStaffTicket(staff, "mail-ticket")).ticket;
      expect(ticket.channel).toBe("email");
      await f.app.enrollEngineeringSource(staff, {
        ...f.command("enroll-mail-engineering", "mail-ticket"),
        expectedRevision: ticket.revision,
      });
      await f.app.submitEngineeringEvidence(staff, {
        ...f.command("verify-mail-failure", "mail-ticket"),
        expectedRevision: ticket.revision,
        security: "ordinary",
        evidence: {
          kind: "staff_verified_failure",
          expectedBehavior: "The export includes two workspace rows.",
          actualBehavior: "The exported file contains no rows.",
          reproductionSteps: ["Export a synthetic two-row workspace."],
          visibleMessageIds: ["mail-initial"],
          verificationReference: "verified-mail-workspace-export-failure",
        },
      });
      const source = await f.app.readEngineeringSource(staff, "mail-ticket");
      const key = {
        ticketId: "mail-ticket",
        sourceGeneration: source.sourceGeneration,
      };
      const dispatch = {
        ...key,
        workerId: "mail-export-worker",
        leaseMilliseconds: 30_000,
      };
      expect((await f.support.engineering.processWork(dispatch)).outcome).toBe(
        "candidate",
      );
      expect((await f.support.engineering.processWork(dispatch)).outcome).toBe(
        "prepared",
      );
      const proposal = await f.app.readEngineeringWork(staff, key);
      await f.support.engineering.reviewProposal(staff, {
        ...f.command("approve-mail-export", "mail-ticket"),
        ...key,
        expectedWorkGeneration: proposal.workGeneration,
        proposalHash: proposal.proposal!.proposalHash,
        decision: "approve",
      });
      await f.support.engineering.processWork(dispatch);
      const exported = await f.app.readEngineeringWork(staff, key);
      expect(exported.status).toBe("accepted");
      const modelCalls = f.support.generate.mock.calls.length;
      f.verifyInput.mockClear();
      const result = await f.app.observeEngineeringFollowup(service, {
        ...f.command("mail-is-not-web-followup", "mail-ticket"),
        association: {
          repositoryId: exported.acknowledgement!.repositoryId,
          issueId: exported.acknowledgement!.issueId,
        },
        inputReference: "signed-mail-release-event",
      });
      expect(result.outcome).toBe("held");
      expect(
        (await f.rows("mail-ticket")).filter(
          (row) => row.kind === "engineering_followup_work",
        ),
      ).toEqual([]);
      expect(f.verifyInput).not.toHaveBeenCalled();
      expect(f.support.generate).toHaveBeenCalledTimes(modelCalls);
    });
  });
}
