import type {
  CollectionDefinition,
  EntityKey,
  Store,
} from "@pegma/storage-core";
import {
  SupportDeskAuthorizationError,
  supportPermissions,
  supportRecords,
  type EngineeringReviewObservation,
  type ReviewEngineeringProposalCommand,
} from "@pegma/support-desk-application";
import { createSupportDeskEngineering } from "@pegma/support-desk-ai";
import { describe, expect, it, vi } from "vitest";
import {
  engineeringAiFixture,
  engineeringBarrier,
  engineeringStaff as staff,
  engineeringStores,
} from "../test/engineering-fixtures.js";

function observe(backing: Store) {
  const reads: EntityKey[] = [];
  const store: Store = {
    collection<T>(definition: CollectionDefinition<T>) {
      const target = backing.collection(definition);
      if (definition.name !== supportRecords.name) return target;
      return new Proxy(target, {
        get(object, property) {
          if (property === "get" || property === "getVersioned")
            return async (key: EntityKey) => {
              reads.push(key);
              return object[property](key);
            };
          const value: unknown = Reflect.get(object, property, object);
          return typeof value === "function" ? value.bind(object) : value;
        },
      });
    },
  };
  return { store, reads };
}

type Fixture = Awaited<ReturnType<typeof engineeringAiFixture>>;
async function prepare(f: Fixture): Promise<ReviewEngineeringProposalCommand> {
  await f.prepareProposal();
  const work = await f.work();
  return {
    ...f.command("observed-review"),
    ...f.key,
    expectedWorkGeneration: work.workGeneration,
    proposalHash: work.proposal!.proposalHash,
    decision: "approve",
  };
}

/** Real adapter writes change only opaque versions, not any engineering fence. */
async function advanceVersion(backing: Store, key: EntityKey) {
  const records = backing.collection(supportRecords);
  const row = await records.getVersioned(key);
  if (row === null) throw new Error("Actual stored record missing");
  expect(await records.putIfUnchanged(row.value, row.version)).toBe(true);
}

for (const [name, createStore] of engineeringStores) {
  describe(`engineering review operation observations (${name})`, () => {
    it("confirms the same authorized records without standalone rehydration or adjacent authority rereads", async () => {
      const observed = observe(createStore());
      const f = await engineeringAiFixture(observed.store);
      const command = await prepare(f);
      observed.reads.length = 0;
      f.resolveAuthority.mockClear();
      const hostGuard = vi.fn(async () => {});
      await expect(
        f.engineering.reviewProposal(staff, command, {
          verifyBeforeCommit: hostGuard,
        }),
      ).resolves.toMatchObject({ status: "approved" });
      expect(hostGuard).toHaveBeenCalledOnce();
      expect(f.resolveAuthority).toHaveBeenCalledTimes(2);
      expect(
        observed.reads.filter((key) => key.id === "engineering-source"),
      ).toHaveLength(2);
      expect(
        observed.reads.filter(
          (key) => key.id === `engineering-work:${f.key.sourceGeneration}`,
        ),
      ).toHaveLength(2);
      expect(observed.reads.filter((key) => key.id === "ticket")).toHaveLength(
        1,
      );
      const after = await f.rows();
      f.resolveAuthority.mockRejectedValue(
        new Error("Current service unavailable"),
      );
      await expect(
        f.engineering.reviewProposal(staff, command),
      ).resolves.toMatchObject({ status: "approved" });
      expect(await f.rows()).toEqual(after);
      expect(f.createIssue).not.toHaveBeenCalled();
    });

    it.each(["engineering-source", "engineering-work:1"])(
      "denies a changed opaque %s version after actual external proof",
      async (id) => {
        const backing = createStore();
        const observed = observe(backing);
        const f = await engineeringAiFixture(observed.store);
        const command = await prepare(f);
        const barrier = engineeringBarrier();
        const metadata = f.getMetadata.getMockImplementation()!;
        f.getMetadata.mockImplementationOnce(async (...args) => {
          const value = await metadata(...args);
          await barrier.wait();
          return value;
        });
        const hostGuard = vi.fn(async () => {});
        const settled = f.engineering
          .reviewProposal(staff, command, {
            verifyBeforeCommit: hostGuard,
          })
          .then(
            () => ({ committed: true }),
            (error: unknown) => ({ error }),
          );
        await barrier.reached;
        try {
          await advanceVersion(backing, { partition: f.key.ticketId, id });
          observed.reads.length = 0;
        } finally {
          barrier.release();
        }
        expect(await settled).toHaveProperty("error");
        expect(hostGuard).not.toHaveBeenCalled();
        expect(observed.reads.map((key) => key.id)).toEqual(
          id === "engineering-source"
            ? ["engineering-source"]
            : ["engineering-source", "engineering-work:1"],
        );
        expect((await f.work()).approval).toBeUndefined();
        expect(f.createIssue).not.toHaveBeenCalled();
      },
    );

    it("keeps the Ticket CAS and obtains a new observation on a real conflict retry", async () => {
      const backing = createStore();
      const f = await engineeringAiFixture(backing);
      const command = await prepare(f);
      const hostGuard = vi.fn(async () => {
        if (hostGuard.mock.calls.length === 1)
          await advanceVersion(backing, {
            partition: f.key.ticketId,
            id: "ticket",
          });
      });
      const outcomes: boolean[] = [];
      f.observed.intercept(async (_trace, commit) => {
        const outcome = await commit();
        outcomes.push(outcome.committed);
        return outcome;
      });
      f.resolveAuthority.mockClear();
      await expect(
        f.engineering.reviewProposal(staff, command, {
          verifyBeforeCommit: hostGuard,
        }),
      ).resolves.toMatchObject({ status: "approved" });
      expect(outcomes).toEqual([false, true]);
      expect(hostGuard).toHaveBeenCalledTimes(2);
      expect(f.resolveAuthority).toHaveBeenCalledTimes(4);
      const rows = await f.rows();
      expect(
        rows.filter(
          (row) =>
            row.kind === "engineering_receipt" &&
            row.id === `engineering-command:${command.commandId}`,
        ),
      ).toHaveLength(1);
    });

    it("checks fresh policy after the last external-proof authority await", async () => {
      const f = await engineeringAiFixture(createStore());
      const command = await prepare(f);
      const barrier = engineeringBarrier();
      const resolve = f.resolveAuthority.getMockImplementation()!;
      let calls = 0;
      f.resolveAuthority.mockImplementation(async (...args) => {
        const authority = await resolve(...args);
        if (++calls === 2) await barrier.wait();
        return authority;
      });
      const hostGuard = vi.fn(async () => {});
      const settled = f.engineering
        .reviewProposal(staff, command, {
          verifyBeforeCommit: hostGuard,
        })
        .then(
          () => ({ committed: true }),
          (error: unknown) => ({ error }),
        );
      await barrier.reached;
      try {
        await f.putPolicy({ enabled: false });
      } finally {
        barrier.release();
      }
      expect(await settled).toHaveProperty("error");
      expect(hostGuard).not.toHaveBeenCalled();
      expect((await f.work()).approval).toBeUndefined();
    });

    it("retains process-authorized service policy reads through the public coordinator and late host guard", async () => {
      const f = await engineeringAiFixture(createStore());
      const command = await prepare(f);
      const reviewer = {
        ...staff,
        permissions: [
          supportPermissions.engineeringReview,
          supportPermissions.queueRead,
          supportPermissions.engineeringRead,
          supportPermissions.engineeringPolicyRead,
        ],
      };
      f.state.authority = {
        ...f.state.authority,
        access: {
          ...f.state.authority.access,
          permissions: [
            supportPermissions.engineeringProcess,
            supportPermissions.queueRead,
            supportPermissions.engineeringRead,
          ],
        },
      };
      // The real host's processing principal has no staff policy-read grant.
      // Confirm the established public policy service accepts these exact grants.
      await expect(
        f.app.readRepositoryPolicy(f.state.authority.access),
      ).resolves.toMatchObject({ policy: { enabled: true } });
      const metadata = f.getMetadata.mock.calls.length;
      const checks = f.checksVerify.mock.calls.length;
      const verifyBeforeCommit = vi.fn(async () => {
        expect(f.getMetadata.mock.calls.length).toBeGreaterThan(metadata);
        expect(f.checksVerify.mock.calls.length).toBeGreaterThan(checks);
      });
      const engineering = createSupportDeskEngineering(f.baseOptions);
      await expect(
        engineering.reviewProposal(reviewer, command, { verifyBeforeCommit }),
      ).resolves.toMatchObject({ status: "approved" });
      expect(verifyBeforeCommit).toHaveBeenCalledOnce();
      expect((await f.work()).approval).toMatchObject({
        decision: "approve",
        reviewedBy: reviewer.principalId,
      });
      expect(
        (await f.rows()).filter(
          (row) =>
            row.kind === "engineering_receipt" &&
            row.id === `engineering-command:${command.commandId}`,
        ),
      ).toHaveLength(1);
    });

    it("leaves an ignored observation compatible with review-only guards and expires captured accessors", async () => {
      const f = await engineeringAiFixture(createStore());
      const command = await prepare(f);
      const reviewer = {
        ...staff,
        permissions: staff.permissions.filter(
          (name) => name !== supportPermissions.engineeringRead,
        ),
      };
      let captured: EngineeringReviewObservation | undefined;
      await expect(
        f.app.reviewEngineeringProposal(
          reviewer,
          command,
          async (observation) => {
            captured = observation;
            expect(() => observation!.readWork(reviewer)).toThrow(
              SupportDeskAuthorizationError,
            );
            expect(() =>
              observation!.readWork({ ...staff, principalId: "" }),
            ).toThrow(TypeError);
            expect(() => observation!.read(reviewer)).toThrow(
              SupportDeskAuthorizationError,
            );
            expect(() =>
              observation!.read({
                ...staff,
                permissions: [
                  supportPermissions.engineeringRead,
                  supportPermissions.queueRead,
                ],
              }),
            ).toThrow(SupportDeskAuthorizationError);
          },
        ),
      ).resolves.toMatchObject({ status: "approved" });
      expect(captured).toBeDefined();
      expect(() => captured!.readWork(staff)).toThrow("expired");
      await expect(captured!.confirm(staff)).rejects.toThrow("expired");
    });
  });
}
