import { describe, expect, it, vi } from "vitest";
import {
  createSupportIndependentCheckModel,
  independentCheckRoutePolicyHash,
  type ReleaseFollowupIndependentCheckInput,
} from "../packages/ai/src/openrouter/support-independent-checks-model.js";
import { SupportOpenRouterModelError } from "../packages/ai/src/openrouter/support-openrouter-model.js";
import {
  checkerModelFixture,
  CHECK_PASS,
} from "../test/openrouter-fixtures.js";
import { followupCandidate } from "../test/engineering-followup-ai-fixtures.js";

// Fictional complete input/route and in-process HTTP port, not provider qualification.
async function fixture() {
  const f = await checkerModelFixture();
  f.route.releaseFollowup = {
    purpose: "support_release_followup",
    wireVersion: "openrouter-support-release-followup-check-v1",
    evidenceRef: "fictional-followup-approval",
    verifiedAt: f.state.now,
    validUntil: f.route.approval.validUntil,
  };
  const { approval, ...base } = f.route;
  approval.requestPolicySha256 = await independentCheckRoutePolicyHash(base);
  const credential = vi.fn(f.options.readApiKey);
  const http = vi.fn(f.options.fetch);
  f.options.readApiKey = credential;
  f.options.fetch = http;
  const model = createSupportIndependentCheckModel(f.options, "pegma.dev");
  expect(await model.resolve()).not.toBeNull();
  const candidate = followupCandidate();
  if (candidate.kbProposal === null)
    throw new Error("Expected the existing complete fixture proposal");
  const input: ReleaseFollowupIndependentCheckInput = {
    trustedInstructions: f.c.trustedInstructions,
    kind: "release_followup",
    purpose: "support_release_followup",
    facts: {
      messages: ["The fictional export was empty."],
      publicReleaseFacts: [
        {
          ref: "release-1",
          text: "The fictional deployed fix exports every row.",
        },
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
  const admission = vi.fn(async () => {});
  const physical = vi.fn();
  return {
    ...f,
    model,
    input,
    credential,
    http,
    admission,
    physical,
    context: {
      ...f.context,
      beforePhysicalCall: admission,
      onPhysicalCall: physical,
    },
  };
}

function articleTarget(input: ReleaseFollowupIndependentCheckInput) {
  const target = input.outbound.kbProposal?.target;
  if (!target || target.kind !== "article")
    throw new Error("Expected article fixture");
  return target;
}

describe("direct SD05 checker caller-input error classification", () => {
  it("admits the complete valid fixture through the fake wire", async () => {
    const f = await fixture();
    const result = await f.model.generate(f.input, f.context, f.c);
    expect(f.model.parseVerdict(result.outputJson)).toEqual(CHECK_PASS);
    expect(f.credential).toHaveBeenCalledTimes(1);
    expect(f.admission).toHaveBeenCalledTimes(1);
    expect(f.physical).toHaveBeenCalledTimes(1);
    expect(f.http).toHaveBeenCalledTimes(1);
  });

  const malformed: {
    label: string;
    change: (input: ReleaseFollowupIndependentCheckInput) => void;
  }[] = [
    {
      label: "unknown envelope field",
      change: (input) => {
        Reflect.set(input, "extra", true);
      },
    },
    {
      label: "null nested release fact",
      change: (input) => {
        Reflect.set(input.facts.publicReleaseFacts, "0", null);
      },
    },
    {
      label: "non-string fact text",
      change: (input) => {
        Reflect.set(input.facts.publicReleaseFacts[0]!, "text", 17);
      },
    },
    {
      label: "null candidate",
      change: (input) => {
        Reflect.set(input, "candidate", null);
      },
    },
    {
      label: "null outbound body",
      change: (input) => {
        Reflect.set(input.outbound, "customerDraft", null);
      },
    },
    {
      label: "fractional article revision",
      change: (input) => {
        Reflect.set(articleTarget(input), "articleRevision", 1.5);
      },
    },
    {
      label: "string article revision",
      change: (input) => {
        Reflect.set(articleTarget(input), "articleRevision", "1");
      },
    },
    {
      label: "unknown nested target field",
      change: (input) => {
        Reflect.set(articleTarget(input), "extra", true);
      },
    },
    {
      label: "null nested retest request",
      change: (input) => {
        Reflect.set(input.outbound.retestRequests, "0", null);
      },
    },
    {
      label: "unknown nested retest field",
      change: (input) => {
        Reflect.set(input.outbound.retestRequests[0]!, "extra", true);
      },
    },
    {
      label: "null binding",
      change: (input) => {
        Reflect.set(input, "binding", null);
      },
    },
  ];
  it.each(malformed)(
    "classifies $label as invalid_input before credentials, admission or HTTP",
    async ({ change }) => {
      const f = await fixture();
      change(f.input);
      const pending = f.model.generate(f.input, f.context, f.c);
      await expect(pending).rejects.toBeInstanceOf(SupportOpenRouterModelError);
      await expect(pending).rejects.toMatchObject({ code: "invalid_input" });
      expect(f.credential).not.toHaveBeenCalled();
      expect(f.admission).not.toHaveBeenCalled();
      expect(f.physical).not.toHaveBeenCalled();
      expect(f.http).not.toHaveBeenCalled();
    },
  );

  it("keeps a null root input classified as invalid_input before credentials or HTTP", async () => {
    const f = await fixture();
    const pending = f.model.generate(
      null as unknown as ReleaseFollowupIndependentCheckInput,
      f.context,
      f.c,
    );
    await expect(pending).rejects.toMatchObject({ code: "invalid_input" });
    expect(f.credential).not.toHaveBeenCalled();
    expect(f.admission).not.toHaveBeenCalled();
    expect(f.http).not.toHaveBeenCalled();
  });

  it("classifies caller mutation after the awaited admission as invalid_input before HTTP", async () => {
    const f = await fixture();
    const context = {
      ...f.context,
      beforePhysicalCall: async () => {
        Reflect.set(f.input.outbound.customerDraft, "body", null);
      },
    };
    await expect(f.model.generate(f.input, context, f.c)).rejects.toMatchObject(
      { code: "invalid_input" },
    );
    expect(f.credential).toHaveBeenCalledTimes(1);
    expect(f.physical).not.toHaveBeenCalled();
    expect(f.http).not.toHaveBeenCalled();
  });

  it("keeps a malformed provider response classified as invalid_response after one fake HTTP call", async () => {
    const f = await fixture();
    Reflect.set(f.state.document, "id", null);
    const pending = f.model.generate(f.input, f.context, f.c);
    await expect(pending).rejects.toBeInstanceOf(SupportOpenRouterModelError);
    await expect(pending).rejects.toMatchObject({ code: "invalid_response" });
    expect(f.credential).toHaveBeenCalledTimes(1);
    expect(f.http).toHaveBeenCalledTimes(1);
  });
});
