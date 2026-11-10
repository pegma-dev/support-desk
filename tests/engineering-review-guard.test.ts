import type {
  CollectionDefinition,
  EntityKey,
  Store,
} from "@pegma/storage-core";
import { createMemoryStore } from "@pegma/storage-core";
import {
  engineeringPolicyRecords,
  supportPermissions,
  supportRecords,
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

/** Observe a collection's real versioned reads without replacing stored data. */
function observeVersionedReads(
  backing: Store,
  collectionName = engineeringPolicyRecords.name,
) {
  let afterRead: ((key: EntityKey) => Promise<void>) | undefined;
  const store: Store = {
    collection<T>(definition: CollectionDefinition<T>) {
      const target = backing.collection(definition);
      return new Proxy(target, {
        get(object, property) {
          if (definition.name === collectionName && property === "getVersioned")
            return async (key: Parameters<typeof object.getVersioned>[0]) => {
              const result = await object.getVersioned(key);
              await afterRead?.(key);
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
      const observed = observeVersionedReads(createMemoryStore());
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
    "runs the bounded rejection callback without export proof and classifies a first denial (deny=%s)",
    async (deny) => {
      const f = await engineeringAiFixture(createMemoryStore());
      await f.prepareProposal();
      const command = await reviewCommand(f, "reject");
      const actual = withoutExportProofs(f);
      const before = await f.rows();
      const transactions = f.observed.transactions.length;
      const review = vi.fn(actual.reviewEngineeringProposal);
      const privateFailure = new Error(
        "PRIVATE_SYNTHETIC_BROWSER_ROLE_REVOKED",
      );
      const verifyBeforeCommit = vi.fn(async () => {
        if (deny) throw privateFailure;
      });
      const engineering = createSupportDeskEngineering({
        ...f.baseOptions,
        application: { ...actual, reviewEngineeringProposal: review },
      });
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
      const reviewing = engineering.reviewProposal(staff, command, {
        verifyBeforeCommit,
      });
      if (deny) {
        const error: unknown = await reviewing.then(
          () => null,
          (failure: unknown) => failure,
        );
        expect(error).toBeInstanceOf(Error);
        expect(error).toMatchObject({
          name: "AssistantBoundaryError",
          category: "verification_unavailable",
          message: "Assistant processing could not be safely completed",
        });
        expect(error).not.toHaveProperty("failureCategory");
        expect(error).not.toHaveProperty("cause");
        expect(error).not.toBe(privateFailure);
        expect(JSON.stringify(error)).not.toContain(privateFailure.message);
        expect(f.observed.transactions).toHaveLength(transactions);
        expect(await f.rows()).toEqual(before);
      } else {
        await expect(reviewing).resolves.toMatchObject({ status: "held" });
        expect((await f.work()).approval).toMatchObject({ decision: "reject" });
      }
      // The default two-attempt budget must still dispatch just one call.
      expect(review).toHaveBeenCalledOnce();
      expect(verifyBeforeCommit).toHaveBeenCalledOnce();
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
      const observed = observeVersionedReads(createMemoryStore());
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
      const verifyBeforeCommit = vi.fn(async () => {
        throw new Error("Accepted receipt must bypass the new host callback");
      });
      const policy = vi.fn(async () => {
        throw new Error("Replay must not consult policy");
      });
      const restarted = createSupportDeskEngineering({
        ...f.baseOptions,
        storageCommandAttempts: 1,
        policy: { resolve: policy },
        application: actual,
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
      await expect(
        restarted.reviewProposal(staff, command, { verifyBeforeCommit }),
      ).resolves.toEqual(accepted);
      expect(verifyBeforeCommit).not.toHaveBeenCalled();
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

  it.each([
    { decision: "reject", stop: "cancelled" },
    { decision: "approve", stop: "cancelled" },
    { decision: "reject", stop: "deadline" },
  ] as const)(
    "withholds a late $decision after $stop during a real application work read",
    async ({ decision, stop }) => {
      const observed = observeVersionedReads(
        createMemoryStore(),
        supportRecords.name,
      );
      const f = await engineeringAiFixture(observed.store);
      await f.prepareProposal();
      const work = await f.work();
      const command = await reviewCommand(f, decision);
      const before = await f.rows();
      const transactions = f.observed.transactions.length;
      const barrier = engineeringBarrier();
      const controller = new AbortController();
      observed.afterRead(async (key) => {
        if (key.id !== work.id || key.partition !== work.partition) return;
        observed.afterRead(undefined);
        await barrier.wait();
      });
      const underlying: Promise<unknown>[] = [];
      const engineering = createSupportDeskEngineering({
        ...f.baseOptions,
        ...(stop === "deadline"
          ? { maxOperationMilliseconds: 2_000, storageCommandAttempts: 1 }
          : {}),
        application: {
          ...f.app,
          reviewEngineeringProposal(...args) {
            const actual = f.app.reviewEngineeringProposal(...args);
            underlying.push(
              actual.then(
                () => ({ accepted: true }),
                (error: unknown) => ({ accepted: false, error }),
              ),
            );
            return actual;
          },
        },
      });
      const verifyBeforeCommit = vi.fn();
      const result = engineering
        .reviewProposal(staff, command, {
          signal: controller.signal,
          verifyBeforeCommit,
        })
        .then(
          () => null,
          (error: unknown) => error,
        );
      try {
        expect(
          await Promise.race([
            barrier.reached.then(() => "read held"),
            result.then(() => "coordinator settled first"),
          ]),
        ).toBe("read held");
        if (stop === "cancelled") controller.abort();
        expect(await result).toMatchObject({
          category: "review_acknowledgement_unknown",
          failureCategory: stop,
        });
      } finally {
        barrier.release();
        // Wait for the actual application call, not just the coordinator race.
        await Promise.all(underlying);
      }
      expect(await Promise.all(underlying)).toMatchObject([
        { accepted: false, error: { category: "cancelled" } },
      ]);
      expect(verifyBeforeCommit).not.toHaveBeenCalled();
      expect(f.observed.transactions).toHaveLength(transactions);
      expect(await f.rows()).toEqual(before);
      expect((await f.work()).approval).toBeUndefined();
    },
  );

  it("keeps an earlier transaction acknowledgement unknown when a later guard denies", async () => {
    const f = await engineeringAiFixture(createMemoryStore());
    await f.prepareProposal();
    const command = await reviewCommand(f, "reject");
    const before = await f.rows();
    const transactions = f.observed.transactions.length;
    const verifyBeforeCommit = vi
      .fn(async (): Promise<void> => {
        throw new Error("PRIVATE_SYNTHETIC_LATER_ROLE_DENIAL");
      })
      .mockResolvedValueOnce(undefined);
    // Fail the first observed transaction port call before delegating. The
    // coordinator cannot infer commitment from that transport failure.
    f.observed.intercept(async () => {
      throw new Error("PRIVATE_SYNTHETIC_TRANSACTION_ACK_UNAVAILABLE");
    });
    try {
      const error: unknown = await f.engineering
        .reviewProposal(staff, command, { verifyBeforeCommit })
        .then(
          () => null,
          (failure: unknown) => failure,
        );
      expect(error).toMatchObject({
        category: "review_acknowledgement_unknown",
        failureCategory: "verification_unavailable",
      });
      expect(error).not.toHaveProperty("cause");
      expect(JSON.stringify(error)).not.toContain("PRIVATE_SYNTHETIC_");
    } finally {
      f.observed.intercept(undefined);
    }
    expect(verifyBeforeCommit).toHaveBeenCalledTimes(2);
    expect(f.observed.transactions).toHaveLength(transactions + 1);
    expect(await f.rows()).toEqual(before);
    expect((await f.work()).approval).toBeUndefined();
  });

  it("observes approval proofs before the host check and rechecks staff after it awaits", async () => {
    const f = await engineeringAiFixture(createMemoryStore());
    await f.prepareProposal();
    const command = await reviewCommand(f, "approve");
    const access = { ...staff, permissions: [...staff.permissions] };
    const before = await f.rows();
    const transactions = f.observed.transactions.length;
    // The application uses its own repository resolver. This spy observes
    // the coordinator's separate external proof after the application reads.
    const metadataCalls = f.getMetadata.mock.calls.length;
    const check = engineeringBarrier();
    let metadataCallsAtGuard = 0;
    const verifyBeforeCommit = vi.fn(async () => {
      metadataCallsAtGuard = f.getMetadata.mock.calls.length;
      await check.wait();
    });
    const result = f.engineering
      .reviewProposal(access, command, { verifyBeforeCommit })
      .then(
        () => null,
        (error: unknown) => error,
      );
    try {
      expect(
        await Promise.race([
          check.reached.then(() => "host check reached"),
          result.then(() => "coordinator settled first"),
        ]),
      ).toBe("host check reached");
      access.permissions = access.permissions.filter(
        (p) => p !== supportPermissions.engineeringReview,
      );
    } finally {
      check.release();
    }
    expect(await result).toMatchObject({ category: "authority_changed" });
    expect(metadataCallsAtGuard).toBeGreaterThan(metadataCalls);
    expect(metadataCallsAtGuard).toBe(f.getMetadata.mock.calls.length);
    expect(verifyBeforeCommit).toHaveBeenCalledOnce();
    expect(f.observed.transactions).toHaveLength(transactions);
    expect(await f.rows()).toEqual(before);
  });

  it("rejects a non-callable JavaScript rejection guard before loading new work and preserves exact receipt replay", async () => {
    const observed = observeVersionedReads(
      createMemoryStore(),
      supportRecords.name,
    );
    const f = engineeringFixture(observed.store);
    await f.eligible();
    await f.prepareProposal();
    const command = await reviewCommand(f, "reject");
    const before = await f.rows();
    const transactions = f.observed.transactions.length;
    const read = vi.fn(async () => {
      throw new Error("Unexpected work load");
    });
    const rejectFromJavaScript = () =>
      Reflect.apply(f.app.reviewEngineeringProposal, f.app, [
        staff,
        command,
        null,
      ]);
    observed.afterRead(read);
    const rejected = rejectFromJavaScript();
    await expect(rejected).rejects.toThrow(TypeError);
    await expect(rejected).rejects.toThrow(
      "Engineering review guard must be a function",
    );
    expect(read).not.toHaveBeenCalled();
    expect(f.observed.transactions).toHaveLength(transactions);
    expect(await f.rows()).toEqual(before);
    observed.afterRead(undefined);
    const accepted = await f.app.reviewEngineeringProposal(staff, command);
    const after = await f.rows();
    observed.afterRead(read);
    await expect(rejectFromJavaScript()).resolves.toEqual(accepted);
    expect(read).not.toHaveBeenCalled();
    expect(await f.rows()).toEqual(after);
    expect(f.observed.transactions).toHaveLength(transactions + 1);
  });

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
