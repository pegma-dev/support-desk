import { describe, expect, it, vi } from "vitest";
import {
  createSupportIndependentChecks,
  independentCheckAttempts,
  purgeSupportIndependentCheckRequests,
} from "@pegma/support-desk-ai/openrouter";
import {
  actualEngineeringCheckerFixture,
  checkerModelFixture,
} from "../test/openrouter-fixtures.js";
import { engineeringStaff } from "../test/engineering-fixtures.js";

const signal = () => new AbortController().signal;
describe("portable independent checker receipt and Store contracts", () => {
  it("retains the PG ic2/MAC bytes and separates current-source and SDK zero-I/O verifiers", async () => {
    const f = await actualEngineeringCheckerFixture();
    const originalSign = crypto.subtle.sign.bind(crypto.subtle);
    let mac = "";
    const signer = vi
      .spyOn(crypto.subtle, "sign")
      .mockImplementation(async (algorithm, key, data) => {
        mac = new TextDecoder().decode(data);
        return originalSign(algorithm, key, data);
      });
    const result = await f.adapter
      .engineeringFor(f.f.key)
      .check(f.input, f.context);
    signer.mockRestore();
    expect(result.outcome).toBe("checked");
    if (result.outcome !== "checked")
      throw new Error("Expected actual portable checker receipt");
    expect(result.receipt.startsWith("ic2.")).toBe(true);
    expect(result.receipt.length).toBeLessThanOrEqual(200);
    const payload = JSON.parse(mac);
    expect(payload.domain).toBe("pegma.dev.support-independent-checks.v2");
    // This is the original PG domain and unchanged signing serialization. The
    // same input bytes signed with the same key must reproduce the exact token.
    const signed = await originalSign(
      "HMAC",
      f.state.key!.key,
      new TextEncoder().encode(mac),
    );
    expect(Buffer.from(signed).toString("base64url")).toBe(
      result.receipt.split(".")[6],
    );
    const before = f.calls.length;
    expect(
      await f.adapter.engineeringSdkVerifier.verify(
        result.receipt,
        f.input.binding,
      ),
    ).not.toBeNull();
    expect(f.calls.length).toBe(before);
    expect(
      await f.adapter.engineeringVerifier.verify(
        result.receipt,
        f.input.binding,
      ),
    ).not.toBeNull();
    expect(f.calls.length).toBeGreaterThan(before);
    expect(f.p.state.calls).toBe(1);
    expect(JSON.stringify(f.p.state.requests)).not.toContain(
      "PRIVATE_ENGINEERING_INTERNAL_NOTE",
    );
    expect(JSON.stringify(f.p.state.requests)).not.toContain(
      "PRIVATE_ENGINEERING_VERIFICATION_REFERENCE",
    );
    expect(f.f.createIssue).not.toHaveBeenCalled();
    const after = await f.store
      .collection(independentCheckAttempts)
      .get({ partition: "support_independent_check", id: "attempts" });
    expect(after?.entries).toHaveLength(1);
  });
  it("denies a PG receipt on a second logical host even when the signing key is identical", async () => {
    const f = await actualEngineeringCheckerFixture();
    const result = await f.adapter
      .engineeringFor(f.f.key)
      .check(f.input, f.context);
    if (result.outcome !== "checked")
      throw new Error("Expected actual PG receipt");
    const other = await checkerModelFixture(
      "retiregolden.org",
      f.f.state.checkPolicy.version,
      f.f.clock.now(),
    );
    const options = {
      ...f.options,
      ...other.options,
      clock: f.f.clock,
      readReceiptKey: () => f.state.key,
    };
    const second = createSupportIndependentChecks(options, "retiregolden.org");
    expect(
      await second.engineeringSdkVerifier.verify(
        result.receipt,
        f.input.binding,
      ),
    ).toBeNull();
    expect(
      await second.engineeringVerifier.verify(result.receipt, f.input.binding),
    ).toBeNull();
    expect(other.state.calls).toBe(0);
  });
  it("keeps current-source verification live while leaving the authentic-byte SDK helper read-free", async () => {
    const f = await actualEngineeringCheckerFixture();
    const result = await f.adapter
      .engineeringFor(f.f.key)
      .check(f.input, f.context);
    if (result.outcome !== "checked")
      throw new Error("Expected actual receipt");
    await f.f.app.withdrawEngineeringSource(engineeringStaff, {
      ...f.f.command("withdraw-after-check"),
      reason: "privacy_withdrawal",
    });
    expect(
      await f.adapter.engineeringVerifier.verify(
        result.receipt,
        f.input.binding,
      ),
    ).toBeNull();
    const before = f.calls.length;
    // The enclosing SDK owns current Source/Work/permission/raw-version fences.
    // This helper only authenticates the exact receipt inside that boundary.
    expect(
      await f.adapter.engineeringSdkVerifier.verify(
        result.receipt,
        f.input.binding,
      ),
    ).not.toBeNull();
    expect(f.calls.length).toBe(before);
    expect(f.p.state.calls).toBe(1);
  });
  it("observes signing callback rebinding instead of retaining a constructor key", async () => {
    const f = await actualEngineeringCheckerFixture();
    const result = await f.adapter
      .engineeringFor(f.f.key)
      .check(f.input, f.context);
    if (result.outcome !== "checked")
      throw new Error("Expected actual receipt");
    Reflect.set(f.options, "readReceiptKey", () => null);
    expect(
      await f.adapter.engineeringSdkVerifier.verify(
        result.receipt,
        f.input.binding,
      ),
    ).toBeNull();
    expect(await f.adapter.resolvePolicy(undefined, signal())).toEqual({
      outcome: "unavailable",
    });
    expect(f.p.state.calls).toBe(1);
  });
  it("durably defers one complete request and processes it once across reconstructed factories", async () => {
    const f = await actualEngineeringCheckerFixture("pegma.dev", true);
    expect(
      (await f.adapter.engineeringFor(f.f.key).check(f.input, f.context))
        .outcome,
    ).toBe("held");
    expect(f.p.state.calls).toBe(0);
    const hints = await f.adapter.scanPending();
    expect(hints).toHaveLength(1);
    expect(JSON.stringify(hints)).not.toContain(
      "PRIVATE_ENGINEERING_INTERNAL_NOTE",
    );
    const cold = createSupportIndependentChecks(f.options, "pegma.dev");
    const outcome = await cold.precomputePending(
      hints[0]!.operationId,
      f.context,
      f.f.key,
    );
    expect(outcome.outcome).toBe("checked");
    expect(f.p.state.calls).toBe(1);
    const receipt = await cold.readEngineeringReceipt(
      f.f.key,
      f.input.binding,
      f.input.checkPolicyVersion,
    );
    expect(typeof receipt).toBe("string");
    expect(
      await cold.engineeringSdkVerifier.verify(receipt!, f.input.binding),
    ).not.toBeNull();
    expect(await f.adapter.scanPending()).toHaveLength(0);
    expect(
      (await cold.engineeringFor(f.f.key).check(f.input, f.context)).outcome,
    ).toBe("checked");
    expect(f.p.state.calls).toBe(1);
  });
  it("retains uncertain paid accounting and never regenerates the same deferred attempt", async () => {
    const f = await actualEngineeringCheckerFixture("pegma.dev", true);
    await f.adapter.engineeringFor(f.f.key).check(f.input, f.context);
    const hint = (await f.adapter.scanPending())[0]!;
    Reflect.set(f.options, "fetch", async () => {
      f.p.state.calls++;
      throw new Error("Fictional lost paid ACK");
    });
    expect(
      (await f.adapter.precomputePending(hint.operationId, f.context, f.f.key))
        .outcome,
    ).toBe("unknown");
    expect(f.p.state.calls).toBe(1);
    const cold = createSupportIndependentChecks(f.options, "pegma.dev");
    expect(
      (await cold.precomputePending(hint.operationId, f.context, f.f.key))
        .outcome,
    ).toBe("unknown");
    expect(f.p.state.calls).toBe(1);
  });
  it("redacts expired durable request text after route and key removal without a paid call", async () => {
    const f = await actualEngineeringCheckerFixture("pegma.dev", true);
    await f.adapter.engineeringFor(f.f.key).check(f.input, f.context);
    const records = f.store.collection(independentCheckAttempts);
    const key = { partition: "support_independent_check", id: "attempts" };
    expect((await records.get(key))?.entries[0]?.request).toBeTypeOf("string");
    f.f.advance(60_001);
    f.p.state.enabled = false;
    f.state.key = null;
    expect(
      await purgeSupportIndependentCheckRequests({
        store: f.store,
        clock: f.f.clock,
      }),
    ).toBe(1);
    expect((await records.get(key))?.entries[0]).toMatchObject({
      state: "held",
      request: null,
    });
    expect(f.p.state.calls).toBe(0);
  });
  it("retains the 60000-byte physical record decoder bound", () => {
    expect(() =>
      independentCheckAttempts.codec.decode({
        partition: "support_independent_check",
        id: "attempts",
        format: 1,
        payload: "x".repeat(60_001),
      }),
    ).toThrow();
  });
});
