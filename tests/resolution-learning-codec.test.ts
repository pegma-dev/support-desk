import { createMemoryStore } from "@pegma/storage-core";
import {
  resolutionLearningDeliveryBinding,
  supportRecords,
  type ResolutionLearningCandidate,
  type ResolutionLearningSourceRecord,
  type ResolutionLearningWorkRecord,
  type SupportRecord,
} from "@pegma/support-desk-application";
import { describe, expect, it } from "vitest";
import {
  learningCustomer as customer,
  learningService as service,
  resolutionLearningFixture,
} from "../test/resolution-learning-fixtures.js";

const candidate: ResolutionLearningCandidate = {
  problem: "Export a workspace.",
  applicability: {
    productId: "workspace",
    version: "2.3.0",
    buildId: "build-verified-230",
  },
  steps: ["Open Workspace.", "Choose Export."],
  solution: "Download the completed export.",
  validationRequirements: ["Verify the exported file opens."],
};

type Fixture = ReturnType<typeof resolutionLearningFixture>;

async function workRecord(
  fixture: Fixture,
): Promise<ResolutionLearningWorkRecord> {
  const work = (await fixture.rows()).find(
    (row): row is ResolutionLearningWorkRecord =>
      row.kind === "resolution_learning_work",
  );
  if (work === undefined) throw new Error("Expected application-created work");
  return work;
}

async function sourceRecord(
  fixture: Fixture,
): Promise<ResolutionLearningSourceRecord> {
  const source = (await fixture.rows()).find(
    (row): row is ResolutionLearningSourceRecord =>
      row.kind === "resolution_learning_source",
  );
  if (source === undefined)
    throw new Error("Expected application-created source");
  return source;
}

/** Corrupt only an encoded payload; persistence still belongs to the real app. */
function corruptPayload(
  record: SupportRecord,
  change: (payload: Record<string, unknown>) => void,
) {
  const encoded = supportRecords.codec.encode(record);
  expect(supportRecords.codec.decode(encoded)).toEqual(record);
  const payload = JSON.parse(encoded.payload as string) as Record<
    string,
    unknown
  >;
  change(payload);
  return { ...encoded, payload: JSON.stringify(payload) };
}

async function completedCandidate(body = candidate) {
  const f = resolutionLearningFixture(createMemoryStore());
  await f.terminal("ticket", false, false);
  await f.confirm();
  const owner = await f.claim();
  const prepared = await f.app.prepareResolutionLearningStep(service, {
    ...owner.fence,
    step: "model",
    binding: f.modelBinding(owner),
  });
  const result = await f.app.completeResolutionLearningStep(
    service,
    {
      ...owner.fence,
      step: "model",
      stepId: prepared.stepId,
      requestHash: prepared.requestHash,
      candidate: body,
      accounting: "accounted",
    },
    async () => {},
  );
  return { f, work: await workRecord(f), result };
}

async function preparedDelivery() {
  const { f, result } = await completedCandidate();
  const owner = await f.claim("delivery-claim");
  const source = await f.source();
  const exactRequest = {
    operation: "create" as const,
    articleId: "workspace-export",
    collectionId: "workspace-help",
    draftPayload: JSON.stringify(candidate),
    sourceReferences: [
      {
        id: source.sourceId,
        system: "pegma.support-desk",
        resourceId: "ticket",
        version: owner.sourceFence.sourceBindingHash,
      },
    ],
    originalExpectedGeneration: 0,
    commandId: "codec-delivery-command",
    correlationId: "codec-delivery-correlation",
  };
  const policyVersion = "synthetic-check-policy-v1";
  const targetDecisionHash = "d".repeat(64);
  const binding = await resolutionLearningDeliveryBinding({
    candidateHash: result.candidateHash!,
    sourceBindingHash: owner.sourceFence.sourceBindingHash,
    policyVersion,
    targetDecisionHash,
    applicability: candidate.applicability,
    exactRequest,
  });
  f.trust.issueChecks("codec-independent-checks", binding);
  const command = {
    ...owner.fence,
    step: "kb_delivery" as const,
    candidateHash: result.candidateHash!,
    verifiedCheckReceipt: "codec-independent-checks",
    policyVersion,
    targetDecisionHash,
    exactRequest,
  };
  await f.app.prepareResolutionLearningStep(service, command);
  return { f, command, work: await workRecord(f) };
}

describe("resolution learning public record codec", () => {
  it("round-trips application-accepted multiline candidate content without relaxing metadata", async () => {
    const multiline = "First line\nSecond line\rThird line\twith a tab.";
    const { work } = await completedCandidate({
      ...candidate,
      problem: multiline,
      solution: multiline,
      steps: [multiline],
      validationRequirements: [multiline],
    });
    const encoded = supportRecords.codec.encode(work);
    expect(supportRecords.codec.decode(encoded)).toEqual(work);
    expect(work.candidate).toMatchObject({
      problem: multiline,
      solution: multiline,
      steps: [multiline],
      validationRequirements: [multiline],
    });
    for (const control of ["\t", "\n", "\r"])
      expect(() =>
        supportRecords.codec.decode(
          corruptPayload(work, (payload) => {
            const body = payload.candidate as Record<string, unknown>;
            (body.applicability as Record<string, unknown>).productId =
              `workspace${control}metadata`;
          }),
        ),
      ).toThrow(TypeError);
  });

  it("rejects every other C0 control and DEL in each candidate content field", async () => {
    const { work } = await completedCandidate();
    const forbidden = Array.from({ length: 32 }, (_, code) => code).filter(
      (code) => ![9, 10, 13].includes(code),
    );
    for (const code of [...forbidden, 127])
      for (const field of [
        "problem",
        "solution",
        "steps",
        "validationRequirements",
      ])
        expect(() =>
          supportRecords.codec.decode(
            corruptPayload(work, (payload) => {
              const body = payload.candidate as Record<string, unknown>;
              const value = `content${String.fromCharCode(code)}invalid`;
              body[field] =
                field === "steps" || field === "validationRequirements"
                  ? [value]
                  : value;
            }),
          ),
        ).toThrow(TypeError);
  });

  it("preserves candidate field and complete serialized-byte ceilings", async () => {
    const { work } = await completedCandidate();
    for (const [field, length] of [
      ["problem", 4_001],
      ["solution", 8_001],
      ["steps", 2_001],
      ["validationRequirements", 2_001],
    ] as const)
      expect(() =>
        supportRecords.codec.decode(
          corruptPayload(work, (payload) => {
            const body = payload.candidate as Record<string, unknown>;
            body[field] =
              field === "steps" || field === "validationRequirements"
                ? ["x".repeat(length)]
                : "x".repeat(length);
          }),
        ),
      ).toThrow(TypeError);
    expect(() =>
      supportRecords.codec.decode(
        corruptPayload(work, (payload) => {
          const body = payload.candidate as Record<string, unknown>;
          body.problem = "p".repeat(4_000);
          body.solution = "s".repeat(7_000);
          expect(JSON.stringify(body).length * 2).toBeGreaterThan(16_000);
        }),
      ),
    ).toThrow(TypeError);
  });

  it("rejects malformed optional source metadata and non-positive accepted revisions", async () => {
    const { f } = await completedCandidate();
    const source = await sourceRecord(f);
    for (const field of [
      "heldReason",
      "proofIdentity",
      "sourceBindingHash",
      "evidenceFingerprint",
      "productContextFingerprint",
      "pendingProofReference",
    ]) {
      const maximum = field === "pendingProofReference" ? 208 : 200;
      for (const value of [
        42,
        null,
        {},
        [],
        "",
        "x".repeat(maximum + 1),
        "value\tinvalid",
        "value\ninvalid",
        "value\rinvalid",
      ])
        expect(() =>
          supportRecords.codec.decode(
            corruptPayload(source, (payload) => {
              payload[field] = value;
            }),
          ),
        ).toThrow(TypeError);
    }
    for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1", null])
      expect(() =>
        supportRecords.codec.decode(
          corruptPayload(source, (payload) => {
            payload.acceptedTicketRevision = value;
          }),
        ),
      ).toThrow(TypeError);
    expect(() =>
      supportRecords.codec.decode(
        corruptPayload(source, (payload) => {
          payload.resolvedAt = "not-a-timestamp";
        }),
      ),
    ).toThrow(TypeError);
  });

  it("retains the full derived pending-proof reference for a maximum-length confirmation command", async () => {
    const f = resolutionLearningFixture(createMemoryStore());
    const terminal = await f.terminal("ticket", false, false);
    f.trust.setProductOutcome("missing");
    const commandId = "c".repeat(200);
    await f.app.confirmCustomerSuccess(customer, {
      ...f.command("pending-proof"),
      commandId,
      lastSeenVisibleMessageId: terminal.solutionMessageId,
    });
    const source = await sourceRecord(f);
    expect(source.pendingProofReference).toBe(`success:${commandId}`);
    expect(source.pendingProofReference).toHaveLength(208);
    expect(
      supportRecords.codec.decode(supportRecords.codec.encode(source)),
    ).toEqual(source);
  });

  it("validates optional work metadata, replay fingerprints, and acknowledgement fields", async () => {
    const { work } = await completedCandidate();
    for (const field of [
      "heldReason",
      "stepId",
      "requestHash",
      "candidateHash",
      "verifiedCheckReceipt",
      "checkPolicyVersion",
      "targetDecisionHash",
    ])
      for (const value of [
        42,
        null,
        "",
        "x".repeat(201),
        "value\tinvalid",
        "value\ninvalid",
        "value\rinvalid",
      ])
        expect(() =>
          supportRecords.codec.decode(
            corruptPayload(work, (payload) => {
              payload[field] = value;
            }),
          ),
        ).toThrow(TypeError);
    for (const field of ["lastCompletion", "lastFinish"])
      for (const value of [
        null,
        "not-a-receipt",
        {},
        { fingerprint: 42 },
        { fingerprint: "value\ninvalid" },
        { fingerprint: "valid", extra: true },
      ])
        expect(() =>
          supportRecords.codec.decode(
            corruptPayload(work, (payload) => {
              payload[field] = value;
            }),
          ),
        ).toThrow(TypeError);
    const acknowledgement = {
      id: "workspace-export",
      generation: 1,
      articleRevision: 1,
      contentHash: "a".repeat(64),
      state: "draft",
    };
    for (const field of ["id", "contentHash", "state"])
      for (const value of [42, "", "value\ninvalid", "x".repeat(201)])
        expect(() =>
          supportRecords.codec.decode(
            corruptPayload(work, (payload) => {
              payload.acknowledgement = { ...acknowledgement, [field]: value };
            }),
          ),
        ).toThrow(TypeError);
    for (const field of ["generation", "articleRevision"])
      for (const value of [0, -1, 1.5, "1"])
        expect(() =>
          supportRecords.codec.decode(
            corruptPayload(work, (payload) => {
              payload.acknowledgement = { ...acknowledgement, [field]: value };
            }),
          ),
        ).toThrow(TypeError);
  });

  it("classifies malformed delivery JSON as TypeError in commands and stored payloads", async () => {
    const { f, command, work } = await preparedDelivery();
    const before = await f.rows();
    for (const draftPayload of ["{", "not-json", '{"problem":}']) {
      expect(() =>
        supportRecords.codec.decode(
          corruptPayload(work, (payload) => {
            (payload.exactRequest as Record<string, unknown>).draftPayload =
              draftPayload;
          }),
        ),
      ).toThrow(TypeError);
      await expect(
        f.app.prepareResolutionLearningStep(service, {
          ...command,
          exactRequest: { ...command.exactRequest, draftPayload },
        }),
      ).rejects.toBeInstanceOf(TypeError);
    }
    expect(await f.rows()).toEqual(before);
  });
});
