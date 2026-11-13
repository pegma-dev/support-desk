import {
  createSupportReleaseFollowupChecks,
  independentCheckRoutePolicyHash,
  releaseFollowupCheckAttempts,
} from "@pegma/support-desk-ai/openrouter";
import type { Store } from "@pegma/storage-core";
import { describe, expect, it } from "vitest";
import { followupChecksFixture } from "../test/openrouter-release-followup-fixtures.js";
import {
  engineeringFollowupStaff,
  engineeringFollowupStores,
} from "../test/engineering-followup-fixtures.js";

for (const [backend, createStore] of engineeringFollowupStores) {
  describe(`deferred SD05 receipt lifetime (${backend})`, () => {
    async function received(retention = 60000) {
      const f = await followupChecksFixture(createStore());
      const { maxOperationMilliseconds, ...options } = f.options;
      void maxOperationMilliseconds;
      let receiptKey = options.readReceiptKey!()!;
      let beforeAttemptUpdate: (() => void) | undefined;
      const store: Store = {
        collection(definition) {
          const records = f.store.collection(definition);
          return {
            ...records,
            async update(key, decide, updateOptions) {
              if (definition.name === releaseFollowupCheckAttempts.name)
                beforeAttemptUpdate?.();
              return records.update(key, decide, updateOptions);
            },
          };
        },
      };
      const controller = createSupportReleaseFollowupChecks(
        {
          ...options,
          deferred: true,
          deferredRetentionMilliseconds: retention,
          readReceiptKey: () => receiptKey,
          store,
        },
        "pegma.dev",
      );
      const context = () => ({
        purpose: "support_release_followup" as const,
        signal: new AbortController().signal,
        deadline: new Date(Date.parse(f.wire.state.now) + 5000).toISOString(),
      });
      const port = controller.forWork(f.f.key);
      expect(await port.prepare!(f.input, context())).toMatchObject({
        outcome: "deferred",
      });
      const [pending] = await controller.scanPending();
      expect(pending).toBeDefined();
      expect(
        await controller.precomputePending(
          pending!.operationId,
          context(),
          f.f.key,
        ),
      ).toEqual({ outcome: "received" });
      return {
        ...f,
        controller,
        port,
        pending: pending!,
        context,
        advance(milliseconds: number) {
          f.f.advance(milliseconds);
          f.wire.state.now = f.f.clock.now();
        },
        replaceKey() {
          receiptKey = { ...receiptKey, id: "fictional-replacement-key" };
        },
        delayNextCommit(milliseconds: number) {
          beforeAttemptUpdate = () => {
            beforeAttemptUpdate = undefined;
            f.f.advance(milliseconds);
            f.wire.state.now = f.f.clock.now();
          };
        },
      };
    }

    it("recovers the exact paid receipt and prepares its bundle after the default five-second invocation bound", async () => {
      const f = await received();
      const checked = await f.controller.precomputePending(
        f.pending.operationId,
        f.context(),
        f.f.key,
      );
      expect(checked.outcome).toBe("checked");
      expect(checked.receipt).toBeDefined();
      f.advance(6000);
      expect(
        await f.controller.precomputePending(
          f.pending.operationId,
          f.context(),
          f.f.key,
        ),
      ).toEqual(checked);
      expect(await f.port.check(f.input, f.context())).toEqual(checked);
      const verified = await f.controller
        .currentVerifierFor(f.f.key)
        .verify(checked.receipt!, f.input.binding, f.context().signal);
      expect(verified).not.toBeNull();
      expect(Date.parse(verified!.validUntil)).toBeLessThanOrEqual(
        Date.parse(f.pending.expiresAt),
      );
      const prepared = await f.f.prepareBundle({
        exactBundle: f.input.exactBundle,
        checksReceipt: checked.receipt!,
        checkPolicyVersion: f.input.binding.checkPolicyVersion,
      });
      expect(prepared.work.preparedBundle?.checksReceipt).toBe(checked.receipt);
      expect(f.wire.state.calls).toBe(1);
      const head = await f.store
        .collection(releaseFollowupCheckAttempts)
        .get({ partition: "support_release_followup", id: "attempts" });
      expect(head?.entries).toHaveLength(1);
      expect(head?.entries[0]).toMatchObject({
        operation: f.pending.operationId,
        state: "checked",
        receipt: checked.receipt,
        expiresAt: f.pending.expiresAt,
      });
    });

    it("still refuses a receipt commit after its physical invocation deadline and resumes without another paid call", async () => {
      const f = await received();
      f.delayNextCommit(6000);
      expect(
        await f.controller.precomputePending(
          f.pending.operationId,
          f.context(),
          f.f.key,
        ),
      ).toEqual({ outcome: "held" });
      const head = await f.store
        .collection(releaseFollowupCheckAttempts)
        .get({ partition: "support_release_followup", id: "attempts" });
      expect(head?.entries[0]).toMatchObject({
        state: "received",
        receipt: null,
      });
      expect(
        await f.controller.precomputePending(
          f.pending.operationId,
          f.context(),
          f.f.key,
        ),
      ).toMatchObject({ outcome: "checked" });
      expect(f.wire.state.calls).toBe(1);
    });

    it("keeps the original queued semantic expiry when receipt completion happens later", async () => {
      const f = await received(10000);
      f.advance(3000);
      const checked = await f.controller.precomputePending(
        f.pending.operationId,
        f.context(),
        f.f.key,
      );
      expect(checked.outcome).toBe("checked");
      const verified = await f.controller.sdkVerifier.verify(
        checked.receipt!,
        f.input.binding,
        f.context().signal,
      );
      expect(verified?.validUntil).toBe(f.pending.expiresAt);
      f.advance(7000);
      expect(
        await f.controller.precomputePending(
          f.pending.operationId,
          f.context(),
          f.f.key,
        ),
      ).toEqual({ outcome: "held" });
      expect(await f.port.prepare!(f.input, f.context())).toEqual({
        outcome: "held",
      });
      expect(f.wire.state.calls).toBe(1);
    });

    it.each([
      "shortened approval",
      "expired approval",
      "changed route",
      "withdrawn source",
      "replaced key",
      "revoked authority",
    ] as const)(
      "still holds checked replay after %s during the queue gap",
      async (change) => {
        const f = await received();
        const checked = await f.controller.precomputePending(
          f.pending.operationId,
          f.context(),
          f.f.key,
        );
        expect(checked.outcome).toBe("checked");
        f.advance(6000);
        if (change === "shortened approval" || change === "expired approval")
          f.wire.route.approval.validUntil = new Date(
            Date.parse(f.wire.state.now) +
              (change === "expired approval" ? -1 : 500),
          ).toISOString();
        if (change === "changed route") {
          f.wire.route.credentialRef = "fictional-replaced-route-credential";
          const { approval, ...route } = f.wire.route;
          void approval;
          f.wire.route.approval.requestPolicySha256 =
            await independentCheckRoutePolicyHash(route);
        }
        if (change === "withdrawn source")
          await f.f.app.withdrawEngineeringSource(engineeringFollowupStaff, {
            ...f.f.command("withdraw-before-check-replay"),
            reason: "privacy_withdrawal",
          });
        if (change === "replaced key") f.replaceKey();
        if (change === "revoked authority") f.state.active = false;
        expect(
          await f.controller.precomputePending(
            f.pending.operationId,
            f.context(),
            f.f.key,
          ),
        ).toEqual({ outcome: "held" });
        expect(await f.port.check(f.input, f.context())).toEqual({
          outcome: "held",
        });
        expect(f.wire.state.calls).toBe(1);
      },
    );
  });
}
