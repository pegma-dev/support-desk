import type { AccessContext } from "@pegma/authorization-core";
import {
  supportPermissions,
  supportRecords,
  type EngineeringCommitGuard,
} from "@pegma/support-desk-application";
import { describe, expect, it } from "vitest";
import {
  engineeringFollowupBarrier,
  engineeringFollowupFixture,
  engineeringFollowupService as service,
  engineeringFollowupStaff as staff,
  engineeringFollowupStores,
} from "../test/engineering-followup-fixtures.js";

type Fixture = Awaited<ReturnType<typeof engineeringFollowupFixture>>;
type Operation =
  | "read"
  | "observe"
  | "observe replay"
  | "claim"
  | "claim replay"
  | "model prepare"
  | "model prepare replay"
  | "model complete"
  | "model complete replay"
  | "finish"
  | "finish replay"
  | "bundle prepare"
  | "bundle prepare replay"
  | "reassessment read"
  | "bundle reassessment"
  | "reject"
  | "reject replay"
  | "post"
  | "post replay"
  | "retest"
  | "retest replay"
  | "preparation recovery";

const staffOperation = (kind: Operation) =>
  [
    "reassessment read",
    "bundle reassessment",
    "reject",
    "reject replay",
    "post",
    "post replay",
    "preparation recovery",
  ].includes(kind);

function requiredPermission(kind: Operation): string {
  if (kind === "read") return supportPermissions.engineeringFollowupRead;
  if (
    kind === "observe" ||
    kind === "observe replay" ||
    kind === "retest" ||
    kind === "retest replay"
  )
    return supportPermissions.engineeringFollowupEvidenceSubmit;
  return staffOperation(kind)
    ? supportPermissions.engineeringFollowupReview
    : supportPermissions.engineeringFollowupProcess;
}

async function operation(
  f: Fixture,
  kind: Operation,
): Promise<
  (access: AccessContext, guard?: EngineeringCommitGuard) => Promise<unknown>
> {
  if (kind === "observe" || kind === "observe replay") {
    const association = await f.association();
    const command = {
      ...f.command("live-followup-observation"),
      association: {
        repositoryId: association.repositoryId,
        issueId: association.issueId,
      },
      inputReference: await f.issueInput(),
    };
    if (kind === "observe replay")
      await f.app.observeEngineeringFollowup(service, command);
    return (access: AccessContext) =>
      f.app.observeEngineeringFollowup(access, command);
  }
  const key = await f.eligible();
  if (kind === "read") {
    expect(JSON.stringify(await f.work(key))).toContain("PRIVATE_MAPPING_ID");
    return (access: AccessContext) =>
      f.app.readEngineeringFollowupWork(access, key);
  }
  if (kind === "claim" || kind === "claim replay") {
    const command = {
      ...key,
      workerId: "followup-authority-worker",
      claimId: "followup-authority-claim",
      leaseMilliseconds: 30_000,
    };
    if (kind === "claim replay")
      await f.app.claimEngineeringFollowupWork(service, command);
    return (access) => f.app.claimEngineeringFollowupWork(access, command);
  }
  if (
    kind.startsWith("model") ||
    kind === "finish" ||
    kind === "finish replay"
  ) {
    const owner = await f.claim();
    const prepare = { ...owner.fence, binding: await f.modelBinding(owner) };
    if (kind === "model prepare")
      return (access) => f.app.prepareEngineeringFollowupModel(access, prepare);
    const prepared = await f.app.prepareEngineeringFollowupModel(
      service,
      prepare,
    );
    if (kind === "model prepare replay")
      return (access) => f.app.prepareEngineeringFollowupModel(access, prepare);
    if (kind === "finish" || kind === "finish replay") {
      const command = {
        ...owner.fence,
        stepId: prepared.stepId,
        requestHash: prepared.requestHash,
        disposition: "retry" as const,
        retryAt: f.clock.now(),
        accounting: "unknown" as const,
      };
      if (kind === "finish replay")
        await f.app.finishEngineeringFollowupModel(service, command);
      return (access) => f.app.finishEngineeringFollowupModel(access, command);
    }
    const command = {
      ...owner.fence,
      stepId: prepared.stepId,
      requestHash: prepared.requestHash,
      candidate: f.candidate(),
      accounting: "accounted" as const,
    };
    if (kind === "model complete replay")
      await f.app.completeEngineeringFollowupModel(
        service,
        command,
        async () => {},
      );
    return (access, guard = async () => {}) =>
      f.app.completeEngineeringFollowupModel(access, command, guard);
  }
  if (kind === "bundle prepare" || kind === "bundle prepare replay") {
    if (kind === "bundle prepare replay") {
      const prepared = await f.prepareBundle();
      return (access, guard = async () => {}) =>
        f.app.prepareEngineeringFollowupBundle(access, prepared.command, guard);
    }
    await f
      .prepareBundle({
        beforePrepare() {
          throw new Error("Capture actual bundle input before its public call");
        },
      })
      .catch(() => undefined);
    const command = f.bundleCommands.at(-1);
    if (command === undefined)
      throw new Error("Expected the actual built bundle command");
    return (access, guard = async () => {}) =>
      f.app.prepareEngineeringFollowupBundle(access, command, guard);
  }
  const prepared = await f.prepareBundle();
  if (kind === "retest" || kind === "retest replay") {
    const binding = await f.retestBinding();
    const receiptReference = f.trust.issueRetest(
      "followup-authority-retest-proof",
      binding,
    );
    const command = {
      ...f.command("authority-retest"),
      ...key,
      retestRequestId: binding.requestId,
      receiptReference,
    };
    if (kind === "retest replay")
      await f.app.submitEngineeringFollowupRetestResult(service, command);
    return (access) =>
      f.app.submitEngineeringFollowupRetestResult(access, command);
  }
  if (kind === "post" || kind === "post replay") {
    if (kind === "post replay") {
      const posted = await f.post();
      return (access, guard = async () => {}) =>
        f.app.approveAndPostEngineeringFollowupWebUpdate(
          access,
          posted.command,
          guard,
        );
    }
    await f
      .post({
        beforePost() {
          throw new Error("Capture actual staff post before its public call");
        },
      })
      .catch(() => undefined);
    const command = f.postCommands.at(-1);
    if (command === undefined)
      throw new Error("Expected the actual built post command");
    return (access, guard = async () => {}) =>
      f.app.approveAndPostEngineeringFollowupWebUpdate(access, command, guard);
  }
  const reject = {
    ...f.command("authority-private-reject"),
    ...key,
    expectedWorkGeneration: prepared.work.workGeneration,
    bundleHash: prepared.work.preparedBundle!.bundleHash,
    reason: "Staff requested reassessment of this exact bundle.",
  };
  if (kind === "reject")
    return (access) => f.app.rejectEngineeringFollowupBundle(access, reject);
  await f.app.rejectEngineeringFollowupBundle(staff, reject);
  if (kind === "reject replay")
    return (access) => f.app.rejectEngineeringFollowupBundle(access, reject);
  if (kind === "reassessment read")
    return (access) => f.app.readEngineeringFollowupReassessment(access, key);
  await f
    .prepareBundle({
      mode: "staff_reassessment",
      beforePrepare() {
        throw new Error(
          "Capture actual staff reassessment before its public call",
        );
      },
    })
    .catch(() => undefined);
  const command = f.bundleCommands.at(-1);
  if (command?.mode !== "staff_reassessment")
    throw new Error("Expected the actual reassessment command");
  if (kind === "preparation recovery") {
    const recoveryIntentHash = "c".repeat(64);
    await f.app.prepareEngineeringFollowupBundle(
      staff,
      { ...command, recoveryIntentHash },
      async () => {},
    );
    return (access) =>
      f.app.recoverEngineeringFollowupPreparation(access, {
        ...key,
        commandId: command.commandId,
        recoveryIntentHash,
      });
  }
  return (access, guard = async () => {}) =>
    f.app.prepareEngineeringFollowupBundle(access, command, guard);
}

for (const [name, createStore] of engineeringFollowupStores) {
  describe(`follow-up live authority (${name})`, () => {
    for (const kind of [
      "read",
      "observe",
      "observe replay",
      "claim",
      "claim replay",
      "model prepare",
      "model prepare replay",
      "model complete",
      "model complete replay",
      "finish",
      "finish replay",
      "bundle prepare",
      "bundle prepare replay",
      "reassessment read",
      "bundle reassessment",
      "reject",
      "reject replay",
      "post",
      "post replay",
      "retest",
      "retest replay",
      "preparation recovery",
    ] as const) {
      it.each(["permission", "principal"] as const)(
        `rejects ${kind} after the original caller's %s changes during a real store await`,
        async (change) => {
          const f = await engineeringFollowupFixture(createStore());
          const execute = await operation(f, kind);
          const before = await f.rows();
          const baseline =
            kind === "read" || staffOperation(kind) ? staff : service;
          const access = {
            ...baseline,
            permissions: [...baseline.permissions],
          };
          const barrier = engineeringFollowupBarrier();
          let armed = true;
          f.readObserver.afterRead(async (trace) => {
            if (!armed || trace.collection !== supportRecords.name) return;
            armed = false;
            await barrier.wait();
          });
          const settled = execute(access).then(
            () => ({ allowed: true }),
            () => ({ allowed: false }),
          );
          await barrier.reached;
          if (change === "principal")
            access.principalId = "different-followup-principal";
          else {
            const revoked = requiredPermission(kind);
            access.permissions = access.permissions.filter(
              (permission) => permission !== revoked,
            );
          }
          barrier.release();
          expect(await settled).toEqual({ allowed: false });
          f.readObserver.afterRead(undefined);
          expect(await f.rows()).toEqual(before);
        },
      );
    }

    for (const kind of [
      "model complete",
      "bundle prepare",
      "bundle reassessment",
      "post",
    ] as const) {
      const changes =
        kind === "post"
          ? (["principal", "permission", "reply", "queue"] as const)
          : (["principal", "permission"] as const);
      it.each(changes)(
        `rechecks the caller's %s after an actual awaited ${kind} guard`,
        async (change) => {
          const f = await engineeringFollowupFixture(createStore());
          const execute = await operation(f, kind);
          const baseline = staffOperation(kind) ? staff : service;
          const access = {
            ...baseline,
            permissions: [...baseline.permissions],
          };
          const before = await f.rows();
          const barrier = engineeringFollowupBarrier();
          const settled = execute(access, () => barrier.wait()).then(
            () => ({ accepted: true }),
            () => ({ accepted: false }),
          );
          await barrier.reached;
          if (change === "principal")
            access.principalId = "different-followup-guard-principal";
          else {
            const revoked =
              change === "reply"
                ? supportPermissions.replyAny
                : change === "queue"
                  ? supportPermissions.queueRead
                  : requiredPermission(kind);
            access.permissions = access.permissions.filter(
              (permission) => permission !== revoked,
            );
          }
          barrier.release();
          expect(await settled).toEqual({ accepted: false });
          expect(await f.rows()).toEqual(before);
        },
      );
    }

    it.each([
      supportPermissions.engineeringFollowupReview,
      supportPermissions.replyAny,
      supportPermissions.queueRead,
    ])("requires current %s for atomic staff posting", async (revoked) => {
      const f = await engineeringFollowupFixture(createStore());
      const execute = await operation(f, "post");
      const access = {
        ...staff,
        permissions: staff.permissions.filter(
          (permission) => permission !== revoked,
        ),
      };
      const before = await f.rows();
      await expect(execute(access)).rejects.toThrow();
      expect(await f.rows()).toEqual(before);
    });

    it.each([
      "bundle preparation",
      "staff reassessment",
      "staff posting",
    ] as const)(
      "rejects %s when its real awaited guard crosses the original work deadline",
      async (phase) => {
        const maxWorkMilliseconds = 10_000;
        const f = await engineeringFollowupFixture(createStore(), {
          followup: { maxWorkMilliseconds },
        });
        f.state.validForMilliseconds = 3_600_000;
        const execute = await operation(
          f,
          phase === "bundle preparation"
            ? "bundle prepare"
            : phase === "staff reassessment"
              ? "bundle reassessment"
              : "post",
        );
        const work = await f.work();
        const before = await f.rows();
        const barrier = engineeringFollowupBarrier();
        const settled = execute(
          phase === "bundle preparation" ? service : staff,
          () => barrier.wait(),
        ).then(
          () => ({ accepted: true }),
          () => ({ accepted: false }),
        );
        await barrier.reached;
        const beyondRenewal =
          Date.parse(work.deadline) + maxWorkMilliseconds + 1;
        f.advance(Math.max(1, beyondRenewal - Date.parse(f.clock.now())));
        expect(Date.parse(f.clock.now())).toBeGreaterThan(
          Date.parse(work.deadline) + maxWorkMilliseconds,
        );
        barrier.release();
        expect(await settled).toEqual({ accepted: false });
        expect(await f.rows()).toEqual(before);
        expect((await f.work()).delivered).toBeUndefined();
        if (phase === "bundle preparation")
          expect((await f.work()).preparedBundle).toBeUndefined();
      },
    );

    it("does not confirm current work after its final real version read crosses the deadline", async () => {
      const f = await engineeringFollowupFixture(createStore(), {
        followup: { maxWorkMilliseconds: 10_000 },
      });
      f.state.validForMilliseconds = 3_600_000;
      await f.eligible();
      const work = await f.work();
      const barrier = engineeringFollowupBarrier();
      let workReads = 0;
      f.readObserver.afterRead(async (trace) => {
        if (
          trace.collection !== supportRecords.name ||
          trace.method !== "getVersioned" ||
          typeof trace.key !== "object" ||
          trace.key === null ||
          !("id" in trace.key) ||
          trace.key.id !== work.id
        )
          return;
        workReads += 1;
        if (workReads === 2) await barrier.wait();
      });
      const confirming = f.app.confirmEngineeringFollowupCurrent(service, {
        ...f.key,
        workBindingHash: work.workBindingHash,
        expectedWorkGeneration: work.workGeneration,
      });
      await barrier.reached;
      f.advance(Date.parse(work.deadline) - Date.parse(f.clock.now()) + 1);
      expect(Date.parse(f.clock.now())).toBeGreaterThan(
        Date.parse(work.deadline),
      );
      barrier.release();
      await expect(confirming).resolves.toBe(false);
      f.readObserver.afterRead(undefined);
      expect(await f.work()).toEqual(work);
    });

    it("rejects an over-returned real physical scan page before per-row private reads", async () => {
      const f = await engineeringFollowupFixture(createStore());
      await f.eligible();
      f.readObserver.reads.length = 0;
      f.readObserver.scans.length = 0;
      f.readObserver.overreturnScans();
      await expect(
        f.app.scanEngineeringFollowups(service, { limit: 1 }),
      ).rejects.toThrow();
      expect(f.readObserver.scans.at(-1)!.physicalRows).toBeGreaterThan(1);
      expect(
        f.readObserver.reads.filter(
          (trace) => trace.collection === supportRecords.name,
        ),
      ).toEqual([]);
    });
  });
}
