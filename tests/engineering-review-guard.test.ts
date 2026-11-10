import type { CollectionDefinition, Store } from "@pegma/storage-core";
import { createMemoryStore } from "@pegma/storage-core";
import {
  engineeringPolicyRecords,
  type ReviewEngineeringProposalCommand,
} from "@pegma/support-desk-application";
import { createSupportDeskEngineering } from "@pegma/support-desk-ai";
import { describe, expect, it, vi } from "vitest";
import {
  engineeringAiFixture,
  engineeringBarrier,
  engineeringFixture,
  engineeringStaff as staff,
} from "../test/engineering-fixtures.js";

/** Delay only actual policy-adapter reads. No copied policy key/codec or state. */
function observePolicyReads(backing: Store) {
  let afterRead: (() => Promise<void>) | undefined;
  const store: Store = {
    collection<T>(definition: CollectionDefinition<T>) {
      const target = backing.collection(definition);
      return new Proxy(target, {
        get(object, property) {
          if (
            definition.name === engineeringPolicyRecords.name &&
            property === "getVersioned"
          )
            return async (key: Parameters<typeof object.getVersioned>[0]) => {
              const result = await object.getVersioned(key);
              await afterRead?.();
              return result;
            };
          const value: unknown = Reflect.get(object, property, object);
          return typeof value === "function" ? value.bind(object) : value;
        },
      });
    },
  };
  return {
    store,
    afterRead(hook: typeof afterRead) {
      afterRead = hook;
    },
  };
}

type Fixture = ReturnType<typeof engineeringFixture>;
async function reviewCommand(
  f: Pick<Fixture, "source" | "work" | "command">,
  decision: "approve" | "reject",
): Promise<ReviewEngineeringProposalCommand> {
  const source = await f.source();
  const work = await f.work();
  if (work.proposal === undefined) throw new Error("Actual proposal missing");
  return {
    ...f.command("review-commit-guard"),
    sourceGeneration: source.sourceGeneration,
    expectedWorkGeneration: work.workGeneration,
    proposalHash: work.proposal.proposalHash,
    decision,
  };
}

function withoutExportProofs(f: Pick<Fixture, "freshApplication">) {
  return f.freshApplication({
    engineering: {
      productContext: undefined,
      testReceipts: undefined,
      repositoryMetadata: undefined,
      routing: undefined,
      checks: undefined,
    },
  });
}

describe("engineering review final host guard over real MemoryStore services", () => {
  it.each(["repository", "policy"] as const)(
    "denies approval without a commit when browser authority changes during the final %s observation",
    async (boundary) => {
      const observed = observePolicyReads(createMemoryStore());
      const f = engineeringFixture(observed.store);
      await f.eligible();
      await f.prepareProposal();
      const command = await reviewCommand(f, "approve");
      const metadata = f.engineeringOptions.repositoryMetadata;
      if (metadata === undefined)
        throw new Error("Actual metadata port missing");
      const barrier = engineeringBarrier();
      const order: string[] = [];
      let browserCurrent = true;
      const denied = new Error(
        "Synthetic current original browser session denied",
      );
      const guard = vi.fn(async () => {
        order.push("guard");
        if (!browserCurrent) throw denied;
      });
      const application = f.freshApplication({
        engineering: {
          repositoryMetadata: {
            async resolve(...args) {
              const result = await metadata.resolve(...args);
              order.push("repository");
              // The next actual policy read is the final application observation,
              // not an ordinal-based guess across fixture/setup calls.
              observed.afterRead(async () => {
                observed.afterRead(undefined);
                order.push("policy");
                if (boundary === "policy") await barrier.wait();
              });
              if (boundary === "repository") await barrier.wait();
              return result;
            },
          },
        },
      });
      const before = await f.rows();
      const transactions = f.observed.transactions.length;
      const settled = application
        .reviewEngineeringProposal(staff, command, guard)
        .then(
          () => ({ committed: true }),
          (error: unknown) => ({ error }),
        );
      await barrier.reached;
      try {
        browserCurrent = false;
      } finally {
        barrier.release();
      }
      expect(await settled).toEqual({ error: denied });
      expect(order).toEqual(["repository", "policy", "guard"]);
      expect(guard).toHaveBeenCalledOnce();
      expect(f.observed.transactions).toHaveLength(transactions);
      // Includes the real work, Audit and receipts: no review effect was saved.
      expect(await f.rows()).toEqual(before);
      expect((await f.work()).approval).toBeUndefined();
    },
  );

  it("honors a supplied rejection guard without consulting absent export proofs", async () => {
    const f = engineeringFixture(createMemoryStore());
    await f.eligible();
    await f.prepareProposal();
    const command = await reviewCommand(f, "reject");
    const application = withoutExportProofs(f);
    const before = await f.rows();
    const transactions = f.observed.transactions.length;
    const denied = new Error("Synthetic rejecting browser session revoked");
    const guard = vi.fn(async () => {
      throw denied;
    });
    await expect(
      application.reviewEngineeringProposal(staff, command, guard),
    ).rejects.toBe(denied);
    expect(guard).toHaveBeenCalledOnce();
    expect(f.observed.transactions).toHaveLength(transactions);
    expect(await f.rows()).toEqual(before);
    expect((await f.work()).approval).toBeUndefined();
  });

  it("preserves an unguarded direct rejection when external proof ports are absent", async () => {
    const f = engineeringFixture(createMemoryStore());
    await f.eligible();
    await f.prepareProposal();
    const command = await reviewCommand(f, "reject");
    const application = withoutExportProofs(f);
    await f.putPolicy({ enabled: false });
    await expect(
      application.reviewEngineeringProposal(staff, command),
    ).resolves.toMatchObject({ status: "held" });
    expect((await f.work()).approval).toMatchObject({
      decision: "reject",
      reviewedBy: staff.principalId,
    });
  });

  it.each([false, true])(
    "supplies the coordinator rejection guard for the real application's host wrapper (deny=%s)",
    async (deny) => {
      const f = await engineeringAiFixture(createMemoryStore());
      await f.prepareProposal();
      const command = await reviewCommand(f, "reject");
      const actual = withoutExportProofs(f);
      const before = await f.rows();
      const transactions = f.observed.transactions.length;
      let guardSupplied = false;
      const hostGuard = vi.fn(async () => {
        if (deny) throw new Error("Synthetic current browser role revoked");
      });
      const engineering = createSupportDeskEngineering({
        ...f.baseOptions,
        storageCommandAttempts: 1,
        application: {
          ...actual,
          reviewEngineeringProposal(access, input, guard) {
            guardSupplied = typeof guard === "function";
            return actual.reviewEngineeringProposal(access, input, async () => {
              if (guard === undefined)
                throw new Error("Missing coordinator staff guard");
              await guard();
              await hostGuard();
            });
          },
        },
      });
      // All external export proof paths are unavailable. Rejection uses only
      // current staff authority, then this host's current-browser check.
      f.state.authorityOutcome = "unavailable";
      f.state.metadataOutcome = "unavailable";
      f.state.configurationOutcome = "disabled";
      f.state.checkPolicyOutcome = "unavailable";
      f.trust.state.routingOutage = true;
      f.trust.state.checksOutage = true;
      const proofCalls = [
        f.getMetadata.mock.calls.length,
        f.resolveAuthority.mock.calls.length,
        f.checksVerify.mock.calls.length,
        f.routingVerify.mock.calls.length,
      ];
      if (deny) {
        await expect(
          engineering.reviewProposal(staff, command),
        ).rejects.toThrow();
        expect(f.observed.transactions).toHaveLength(transactions);
        expect(await f.rows()).toEqual(before);
      } else {
        await expect(
          engineering.reviewProposal(staff, command),
        ).resolves.toMatchObject({ status: "held" });
        expect((await f.work()).approval).toMatchObject({ decision: "reject" });
      }
      expect(guardSupplied).toBe(true);
      expect(hostGuard).toHaveBeenCalledOnce();
      expect([
        f.getMetadata.mock.calls.length,
        f.resolveAuthority.mock.calls.length,
        f.checksVerify.mock.calls.length,
        f.routingVerify.mock.calls.length,
      ]).toEqual(proofCalls);
      expect(f.createIssue).not.toHaveBeenCalled();
    },
  );

  it.each(["approve", "reject"] as const)(
    "recovers an exact accepted %s receipt before the guard after actual source and catalog changes",
    async (decision) => {
      const observed = observePolicyReads(createMemoryStore());
      const f = engineeringFixture(observed.store);
      await f.eligible();
      await f.prepareProposal();
      const command = await reviewCommand(f, decision);
      const accepted = await f.app.reviewEngineeringProposal(
        staff,
        command,
        async () => {},
      );
      await f.app.invalidateEngineeringSource(staff, {
        ...f.command("invalidate-after-accepted-review"),
        reason: "evidence_revoked",
      });
      await f.putPolicy({ repositories: [] });
      const before = await f.rows();
      const transactions = f.observed.transactions.length;
      const guard = vi.fn(async () => {
        throw new Error("Stale review must not run guard");
      });
      observed.afterRead(async () => {
        throw new Error("Replay must not reload repository policy");
      });
      await expect(
        withoutExportProofs(f).reviewEngineeringProposal(staff, command, guard),
      ).resolves.toEqual(accepted);
      expect(guard).not.toHaveBeenCalled();
      expect(f.observed.transactions).toHaveLength(transactions);
      expect(await f.rows()).toEqual(before);
      observed.afterRead(undefined);
    },
  );

  it.each(["approve", "reject"] as const)(
    "lets a fresh coordinator recover an accepted %s receipt without source, service or vendor proof",
    async (decision) => {
      const f = await engineeringAiFixture(createMemoryStore());
      await f.prepareProposal();
      const command = await reviewCommand(f, decision);
      const accepted = await f.engineering.reviewProposal(staff, command);
      await f.app.invalidateEngineeringSource(staff, {
        ...f.command("invalidate-before-restarted-review"),
        reason: "evidence_revoked",
      });
      await f.putPolicy({ repositories: [] });
      const before = await f.rows();
      const transactions = f.observed.transactions.length;
      const actual = withoutExportProofs(f);
      const guardCalls = vi.fn();
      const policy = vi.fn(async () => {
        throw new Error("Replay must not consult policy");
      });
      const restarted = createSupportDeskEngineering({
        ...f.baseOptions,
        storageCommandAttempts: 1,
        policy: { resolve: policy },
        application: {
          ...actual,
          reviewEngineeringProposal(access, input, guard) {
            return actual.reviewEngineeringProposal(access, input, async () => {
              guardCalls();
              if (guard !== undefined) await guard();
            });
          },
        },
      });
      f.state.authorityOutcome = "unavailable";
      f.state.metadataOutcome = "unavailable";
      f.state.configurationOutcome = "disabled";
      const proofCalls = [
        f.getMetadata.mock.calls.length,
        f.resolveAuthority.mock.calls.length,
        f.checksVerify.mock.calls.length,
        f.routingVerify.mock.calls.length,
      ];
      await expect(restarted.reviewProposal(staff, command)).resolves.toEqual(
        accepted,
      );
      expect(guardCalls).not.toHaveBeenCalled();
      expect(policy).not.toHaveBeenCalled();
      expect(f.observed.transactions).toHaveLength(transactions);
      expect(await f.rows()).toEqual(before);
      expect([
        f.getMetadata.mock.calls.length,
        f.resolveAuthority.mock.calls.length,
        f.checksVerify.mock.calls.length,
        f.routingVerify.mock.calls.length,
      ]).toEqual(proofCalls);
      expect(f.createIssue).not.toHaveBeenCalled();
    },
  );

  it("retains verification expiry checking after a successful final guard", async () => {
    const f = engineeringFixture(createMemoryStore());
    await f.eligible();
    await f.prepareProposal();
    const command = await reviewCommand(f, "approve");
    const before = await f.rows();
    const transactions = f.observed.transactions.length;
    const guard = vi.fn(async () => {
      f.advance(61_000);
    });
    await expect(
      f.app.reviewEngineeringProposal(staff, command, guard),
    ).rejects.toThrow("expired");
    expect(guard).toHaveBeenCalledOnce();
    expect(f.observed.transactions).toHaveLength(transactions);
    expect(await f.rows()).toEqual(before);
  });
});
