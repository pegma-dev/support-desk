import { describe, expect, it, vi } from "vitest";
import {
  createSupportIndependentCheckModel,
  independentCheckRoutePolicyHash,
  type ReleaseFollowupIndependentCheckInput,
} from "../packages/ai/src/openrouter/support-independent-checks-model.js";
import {
  checkerModelFixture,
  CHECK_PASS,
} from "../test/openrouter-fixtures.js";
import { followupCandidate } from "../test/engineering-followup-ai-fixtures.js";

// Fictional route/evidence and a controlled HTTP port; no real provider calls.
async function fixture(
  allowApprovalRenewal = true,
  approvalMilliseconds = 60_000,
) {
  const f = await checkerModelFixture();
  const start = Date.parse(f.state.now);
  f.route.releaseFollowup = {
    purpose: "support_release_followup",
    wireVersion: "openrouter-support-release-followup-check-v1",
    evidenceRef: "fictional-followup-approval",
    verifiedAt: f.state.now,
    validUntil: f.c.dataControls.validUntil,
  };
  f.route.approval.validUntil = new Date(
    start + approvalMilliseconds,
  ).toISOString();
  const { approval, ...base } = f.route;
  approval.requestPolicySha256 = await independentCheckRoutePolicyHash(base);
  const model = allowApprovalRenewal
    ? createSupportIndependentCheckModel(f.options, "pegma.dev", {
        allowApprovalRenewal: true,
      })
    : createSupportIndependentCheckModel(f.options, "pegma.dev");
  expect(await model.resolve()).not.toBeNull();
  const candidate = followupCandidate();
  if (!candidate.kbProposal) throw new Error("Expected complete proposal");
  const input: ReleaseFollowupIndependentCheckInput = {
    trustedInstructions: f.c.trustedInstructions,
    kind: "release_followup",
    purpose: "support_release_followup",
    facts: {
      messages: ["The fictional export was empty."],
      publicReleaseFacts: [
        { ref: "release-1", text: "The deployed fix exports every row." },
      ],
    },
    candidate,
    outbound: {
      customerDraft: candidate.customerDraft,
      kbProposal: {
        target: {
          kind: "article",
          articleId: "fictional-article",
          collectionId: "fictional-collection",
          articleRevision: 1,
          contentHash: "a".repeat(64),
          validationRequirementsHash: "b".repeat(64),
          validationRequirementIds: ["fictional-regression"],
        },
        ...candidate.kbProposal,
      },
      retestRequests: candidate.retestRequests.map((request, index) => ({
        ...request,
        requestId: "fictional-retest-" + index,
        productBinding: "c".repeat(64),
        validationRequirementIds: ["fictional-regression"],
      })),
    },
    binding: {
      workBindingHash: "d".repeat(64),
      candidateHash: "e".repeat(64),
      bundleHash: "f".repeat(64),
      checkPolicyVersion: f.c.policyVersion,
      followupRevocationEpoch: 0,
      issueHeadHash: "a".repeat(64),
      deploymentHeadHash: "b".repeat(64),
    },
    targetBaseline: null,
    validationRequirements: null,
  };
  const physical = vi.fn();
  const context = {
    ...f.context,
    onPhysicalCall: physical,
    current: () => f.options.readApiKey() === "fictional-provider-key",
  };
  const renew = () => {
    f.state.now = new Date(start + 100).toISOString();
    f.route.approval.verifiedAt = f.state.now;
    f.route.approval.validUntil = new Date(start + 120_000).toISOString();
  };
  return { ...f, model, input, context, physical, renew, start };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
type AwaitPoint = "fetch" | "body";

async function pendingAt(f: Fixture, point: AwaitPoint) {
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let complete!: () => void;
  const response = () =>
    new Response(JSON.stringify(f.state.document), {
      headers: { "content-type": "application/json" },
    });
  const http = vi.fn(async (_url: string, _init: RequestInit) => {
    if (point === "fetch") {
      entered();
      return await new Promise<Response>((resolve) => {
        complete = () => resolve(response());
      });
    }
    return new Response(
      new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            entered();
            return new Promise<void>((resolve) => {
              complete = () => {
                controller.enqueue(
                  new TextEncoder().encode(JSON.stringify(f.state.document)),
                );
                controller.close();
                resolve();
              };
            });
          },
        },
        { highWaterMark: 0 },
      ),
      { headers: { "content-type": "application/json" } },
    );
  });
  f.options.fetch = http;
  const pending = f.model.generate(f.input, f.context, f.c);
  // Attach rejection handling before deliberately changing the current evidence.
  void pending.catch(() => {});
  await waiting;
  return { pending, complete: () => complete(), http };
}

describe("SD05-only approval renewal through the real checker transport", () => {
  it("keeps the qualified snapshot detached from returned configuration", async () => {
    const f = await fixture();
    const resolved = await f.model.resolve();
    if (!resolved) throw new Error("Expected qualified route");
    resolved.configuration.trustedInstructions += " replacement";
    f.c.trustedInstructions = resolved.configuration.trustedInstructions;
    expect(f.model.currentRoute()).toBeUndefined();
  });

  it.each(["fetch", "body"] as const)(
    "accepts only approval-window renewal while %s is unresolved",
    async (point) => {
      const f = await fixture();
      const p = await pendingAt(f, point);
      f.renew();
      // This read independently exercises the last-qualified snapshot guard.
      const renewed = f.model.currentRoute();
      p.complete();
      const result = await p.pending;
      expect(renewed).toEqual(f.route);
      expect(f.model.parseVerdict(result.outputJson)).toEqual(CHECK_PASS);
      expect(result.usage.costMicros).toBe(100);
      expect(f.physical).toHaveBeenCalledTimes(1);
      expect(p.http).toHaveBeenCalledTimes(1);
      const body = JSON.parse(String(p.http.mock.calls[0]?.[1]?.body));
      expect(Object.keys(body).sort()).toEqual([
        "max_tokens",
        "messages",
        "model",
        "provider",
        "response_format",
        "stream",
      ]);
    },
  );

  const rejected: { name: string; change(f: Fixture): void }[] = [
    {
      name: "shorter approval",
      change: (f) => {
        f.route.approval.validUntil = new Date(f.start + 30_000).toISOString();
      },
    },
    {
      name: "expired approval",
      change: (f) => {
        f.route.approval.validUntil = f.state.now;
      },
    },
    {
      name: "future approval",
      change: (f) => {
        f.route.approval.verifiedAt = new Date(f.start + 1_000).toISOString();
      },
    },
    {
      name: "semantic approval",
      change: (f) => {
        f.route.approval.evidenceRef += "-replacement";
      },
    },
    {
      name: "semantic route",
      change: (f) => {
        f.route.usageScopeRef += "-replacement";
      },
    },
    {
      name: "privacy evidence",
      change: (f) => {
        f.c.dataControls.accountRef = "replacement";
      },
    },
    {
      name: "configuration",
      change: (f) => {
        f.c.trustedInstructions += " replacement";
      },
    },
    {
      name: "token qualification",
      change: (f) => {
        Reflect.set(f.counter.qualification, "evidenceRef", "replacement");
      },
    },
    {
      name: "key rotation",
      change: (f) => {
        f.options.readApiKey = () => "fictional-replacement-key";
      },
    },
  ];
  for (const point of ["fetch", "body"] as const) {
    it.each(rejected)(
      "rejects $name during " + point + " after exactly one physical call",
      async ({ change }) => {
        const f = await fixture();
        const p = await pendingAt(f, point);
        f.renew();
        change(f);
        p.complete();
        await expect(p.pending).rejects.toThrow();
        expect(f.physical).toHaveBeenCalledTimes(1);
        expect(p.http).toHaveBeenCalledTimes(1);
      },
    );
  }

  it.each(["fetch", "body"] as const)(
    "keeps the default exact snapshot strict during %s",
    async (point) => {
      const f = await fixture(false);
      const p = await pendingAt(f, point);
      f.renew();
      expect(f.model.currentRoute()).toBeUndefined();
      p.complete();
      await expect(p.pending).rejects.toThrow();
      expect(p.http).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["fetch", "body"] as const)(
    "does not extend the originally captured approval expiry during %s",
    async (point) => {
      const f = await fixture(true, 500);
      const p = await pendingAt(f, point);
      f.renew();
      f.state.now = new Date(f.start + 600).toISOString();
      p.complete();
      await expect(p.pending).rejects.toThrow();
      expect(p.http).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["fetch", "body"] as const)(
    "does not extend the original attempt deadline during %s",
    async (point) => {
      const f = await fixture();
      const p = await pendingAt(f, point);
      f.renew();
      f.state.now = f.context.deadline;
      p.complete();
      await expect(p.pending).rejects.toThrow();
      expect(p.http).toHaveBeenCalledTimes(1);
    },
  );
});
