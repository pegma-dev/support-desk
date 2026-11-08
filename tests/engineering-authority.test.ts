import type { AccessContext } from "@pegma/authorization-core";
import type { CollectionDefinition, Store } from "@pegma/storage-core";
import {
  supportPermissions,
  supportRecords,
} from "@pegma/support-desk-application";
import { describe, expect, it } from "vitest";
import {
  engineeringAiFixture,
  engineeringBarrier,
  engineeringFixture,
  engineeringService as service,
  engineeringStaff as staff,
  engineeringStores,
} from "../test/engineering-fixtures.js";

interface ReadTrace {
  readonly collection: string;
  readonly method: "get" | "getVersioned";
  readonly key: unknown;
}

/** Observe awaited reads of the real adapter; this wrapper stores no records. */
function observeReads(backing: Store) {
  const reads: ReadTrace[] = [];
  let afterRead: ((trace: ReadTrace) => Promise<void>) | undefined;
  let overreturn = false;
  let physicalRows = 0;
  const store: Store = {
    collection<T>(definition: CollectionDefinition<T>) {
      const target = backing.collection(definition);
      return new Proxy(target, {
        get(object, property) {
          if (property === "get" || property === "getVersioned")
            return async (key: Parameters<typeof object.get>[0]) => {
              const result = await object[property](key);
              const trace: ReadTrace = {
                collection: definition.name,
                method: property,
                key,
              };
              reads.push(trace);
              await afterRead?.(trace);
              return result;
            };
          if (property === "scan")
            return async (bounds: Parameters<typeof object.scan>[0]) => {
              const page = await object.scan(
                overreturn && definition.name === supportRecords.name
                  ? { ...bounds, limit: bounds.limit + 1 }
                  : bounds,
              );
              physicalRows = page.records.length;
              return page;
            };
          const value: unknown = Reflect.get(object, property, object);
          return typeof value === "function" ? value.bind(object) : value;
        },
      });
    },
  };
  return {
    store,
    reads,
    afterRead(hook: typeof afterRead) {
      afterRead = hook;
    },
    overreturnNextScan() {
      overreturn = true;
    },
    physicalRows: () => physicalRows,
  };
}

type Fixture = ReturnType<typeof engineeringFixture>;
type Operation =
  | "claim"
  | "finish"
  | "prepare"
  | "complete"
  | "prepare replay"
  | "complete replay"
  | "finish replay"
  | "proposal replay"
  | "review replay";

async function prepareOperation(f: Fixture, operation: Operation) {
  const key = await f.eligible();
  if (operation === "claim")
    return (access: AccessContext) =>
      f.app.claimEngineeringWork(access, {
        ...key,
        workerId: "direct-worker",
        claimId: "direct-invocation",
        leaseMilliseconds: 10_000,
      });
  const owner = await f.claim();
  if (operation === "proposal replay" || operation === "review replay") {
    const proposal = await f.prepareProposal({ owner });
    if (operation === "review replay") {
      const command = {
        ...f.command("accepted-review-authority"),
        sourceGeneration: key.sourceGeneration,
        expectedWorkGeneration: proposal.work.workGeneration,
        proposalHash: proposal.proposal.proposalHash,
        decision: "approve" as const,
      };
      await f.app.reviewEngineeringProposal(staff, command, async () => {});
      return (access: AccessContext) =>
        f.app.reviewEngineeringProposal(access, command, async () => {});
    }
    return (access: AccessContext) =>
      f.app.prepareEngineeringProposal(
        access,
        proposal.command,
        async () => {},
      );
  }
  if (operation === "finish" || operation === "finish replay") {
    const command = {
      ...owner.fence,
      disposition: "held" as const,
      reason: "Human assessment required",
    };
    if (operation === "finish replay")
      await f.app.finishEngineeringWork(service, command);
    return (access: AccessContext) =>
      f.app.finishEngineeringWork(access, command);
  }
  const command = { ...owner.fence, binding: await f.modelBinding(owner) };
  if (operation === "prepare")
    return (access: AccessContext) =>
      f.app.prepareEngineeringModel(access, command);
  const prepared = await f.app.prepareEngineeringModel(service, command);
  if (operation === "prepare replay")
    return (access: AccessContext) =>
      f.app.prepareEngineeringModel(access, command);
  const completion = {
    ...owner.fence,
    stepId: prepared.stepId,
    requestHash: prepared.requestHash,
    candidate: f.candidate(),
    accounting: "accounted" as const,
  };
  if (operation === "complete replay")
    await f.app.completeEngineeringModel(service, completion, async () => {});
  return (access: AccessContext) =>
    f.app.completeEngineeringModel(access, completion, async () => {});
}

for (const [name, createStore] of engineeringStores) {
  describe(`engineering private read authority (${name})`, () => {
    for (const operation of ["source", "work"] as const) {
      it.each(["principal", "permission"] as const)(
        `rejects private ${operation} delivery when the caller's %s changes during its real key read`,
        async (change) => {
          const observed = observeReads(createStore());
          const f = engineeringFixture(observed.store);
          const key = await f.eligible();
          const privateValue =
            operation === "source" ? await f.source() : await f.work();
          expect(JSON.stringify(privateValue)).toContain(
            "PRIVATE_ENGINEERING_VERIFICATION_REFERENCE",
          );
          const before = await f.rows();
          const access = { ...staff, permissions: [...staff.permissions] };
          const barrier = engineeringBarrier();
          let armed = true;
          observed.afterRead(async (trace) => {
            if (
              !armed ||
              trace.collection !== supportRecords.name ||
              (trace.key as { readonly id?: string }).id !== privateValue.id
            )
              return;
            armed = false;
            await barrier.wait();
          });
          const reading =
            operation === "source"
              ? f.app.readEngineeringSource(access, key.ticketId)
              : f.app.readEngineeringWork(access, key);
          const settled = reading.then(
            () => ({ delivered: true }),
            () => ({ delivered: false }),
          );
          await barrier.reached;
          if (change === "principal")
            access.principalId = "different-authorized-private-reader";
          else
            access.permissions = access.permissions.filter(
              (permission) => permission !== supportPermissions.engineeringRead,
            );
          barrier.release();
          expect(await settled).toEqual({ delivered: false });
          observed.afterRead(undefined);
          expect(await f.rows()).toEqual(before);
        },
      );
    }
  });

  describe(`engineering live worker authority (${name})`, () => {
    for (const operation of [
      "claim",
      "finish",
      "prepare",
      "complete",
      "prepare replay",
      "complete replay",
      "finish replay",
      "proposal replay",
      "review replay",
    ] as const) {
      it.each(["permission", "principal"] as const)(
        `rechecks the original caller's %s after a real storage await during ${operation}`,
        async (change) => {
          const observed = observeReads(createStore());
          const f = engineeringFixture(observed.store);
          const execute = await prepareOperation(f, operation);
          const before = await f.rows();
          const baseline = operation === "review replay" ? staff : service;
          const access = {
            ...baseline,
            permissions: [...baseline.permissions],
          };
          const barrier = engineeringBarrier();
          let armed = true;
          observed.afterRead(async (trace) => {
            if (!armed || trace.collection !== supportRecords.name) return;
            armed = false;
            await barrier.wait();
          });
          const settled = execute(access).then(
            () => ({ authorized: true }),
            () => ({ authorized: false }),
          );
          await barrier.reached;
          if (change === "principal")
            access.principalId = "replacement-direct-worker";
          else
            access.permissions = access.permissions.filter(
              (permission) =>
                permission !==
                (operation === "review replay"
                  ? supportPermissions.engineeringReview
                  : supportPermissions.engineeringProcess),
            );
          barrier.release();
          expect(await settled).toEqual({ authorized: false });
          observed.afterRead(undefined);
          expect(await f.rows()).toEqual(before);
        },
      );
    }

    it("rejects an over-returned physical scan page before any source lookup", async () => {
      const observed = observeReads(createStore());
      const f = engineeringFixture(observed.store);
      await f.eligible();
      observed.reads.length = 0;
      observed.overreturnNextScan();
      await expect(
        f.app.scanEngineeringCandidates(service, { limit: 1 }),
      ).rejects.toThrow();
      expect(observed.physicalRows()).toBeGreaterThan(1);
      expect(
        observed.reads.filter(
          (trace) =>
            trace.collection === supportRecords.name &&
            (trace.key as { readonly id?: string }).id === "engineering-source",
        ),
      ).toEqual([]);
    });

    for (const replay of [false, true]) {
      for (const phase of replay
        ? (["read"] as const)
        : (["read", "guard"] as const)) {
        it.each(["permission", "principal"] as const)(
          `fences reconciliation %s through an awaited ${phase} (accepted replay: ${replay})`,
          async (change) => {
            const observed = observeReads(createStore());
            const f = await engineeringAiFixture(observed.store);
            await f.prepareProposal();
            await f.approve();
            f.setGitHubCreate(async (request, context) => {
              await f.acceptIssue(request, undefined, context);
              throw new Error(
                "Synthetic timeout after real fake-host acceptance",
              );
            });
            await f.engineering.processWork(f.nextCommand());
            const view = await f.app.readEngineeringReconciliation(
              service,
              "ticket",
            );
            const work = await f.work();
            const command = {
              ...f.key,
              expectedSourceWorkGeneration: view.sourceWorkGeneration,
              repositoryId: work.dispatch!.repositoryId,
              dispatchId: work.dispatch!.dispatchId,
              requestHash: work.dispatch!.requestHash,
              result: {
                outcome: "accepted" as const,
                acknowledgement: f.acceptedIssues.get(
                  work.dispatch!.exportMarker,
                )!,
                proof: "trusted-github-unique-marker-acceptance",
              },
            };
            const access = {
              ...service,
              permissions: [
                supportPermissions.engineeringReconcile,
              ] as string[],
            };
            if (replay)
              await f.app.recordEngineeringReconciliation(
                access,
                command,
                async () => {},
              );
            const before = await f.rows();
            const barrier = engineeringBarrier();
            let armed = true;
            observed.afterRead(async (trace) => {
              if (
                phase !== "read" ||
                !armed ||
                trace.collection !== supportRecords.name
              )
                return;
              armed = false;
              await barrier.wait();
            });
            const settled = f.app
              .recordEngineeringReconciliation(
                access,
                command,
                phase === "guard" ? () => barrier.wait() : async () => {},
              )
              .then(
                () => ({ authorized: true }),
                () => ({ authorized: false }),
              );
            await barrier.reached;
            if (change === "principal")
              access.principalId = "replacement-reconciliation-actor";
            else access.permissions = [];
            barrier.release();
            expect(await settled).toEqual({ authorized: false });
            observed.afterRead(undefined);
            expect(await f.rows()).toEqual(before);
          },
        );
      }
    }
  });
}
