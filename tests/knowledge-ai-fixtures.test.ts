import { describe, expect, it } from "vitest";

import {
  acceptanceCases,
  fixtureInstances,
  planScenarios,
} from "../test/knowledge-ai/corpus.js";
import { evaluateObservation } from "../test/knowledge-ai/evaluate.js";
import { createScriptedModel } from "../test/knowledge-ai/fake-model.js";
import type {
  AcceptanceCase,
  ModelReply,
  ModelRequest,
  Observation,
} from "../test/knowledge-ai/types.js";

function fixtureCase(suffix: string): AcceptanceCase {
  const result = acceptanceCases.find(
    (item) => item.id === `workshop/${suffix}`,
  );
  if (result === undefined) throw new Error(`Missing fixture ${suffix}`);
  return result;
}

function request(operationId = "turn-1", revision = 1, generation = 1) {
  return {
    operationId,
    instanceId: "workshop" as const,
    purpose: "answer" as const,
    trigger: { ticketId: "workshop/ticket-1", revision, generation },
    promptVersion: "prompt-fixture-1",
    configurationVersion: "config-fixture-1",
    providerVerificationRef: "workshop/zdr-verification-1",
    messages: [{ role: "customer" as const, content: "How do I export?" }],
    sources: [
      {
        reference: fixtureInstances.workshop.portalSource,
        text: "Use Export.",
      },
      { reference: fixtureInstances.workshop.botSource, text: "Retry once." },
    ],
    budget: {
      inputTokens: 512,
      outputTokens: 128,
      deadlineMilliseconds: 1_000,
    },
  } satisfies ModelRequest;
}

function safeObservation(): Observation {
  return {
    instanceId: "workshop",
    outcome: "answered",
    modelRequests: [request()],
    artifacts: [
      {
        kind: "portal",
        instanceId: "workshop",
        id: "portal-1",
        text: "Export guide",
        sources: [fixtureInstances.workshop.portalSource],
      },
      {
        kind: "message",
        instanceId: "workshop",
        id: "answer-1",
        text: "Use Export. If it fails, retry once.",
        sources: [
          fixtureInstances.workshop.portalSource,
          fixtureInstances.workshop.botSource,
        ],
      },
    ],
  };
}

function newerTurnObservation(): Observation {
  const observed = safeObservation();
  observed.modelRequests = [
    request("workshop/old-turn", 1, 1),
    request("workshop/new-turn", 2, 2),
  ];
  observed.artifacts = observed.artifacts
    .filter((artifact) => artifact.kind === "message")
    .map((artifact) => ({
      ...artifact,
      committedTurn: {
        operationId: "workshop/new-turn",
        ticketId: "workshop/ticket-1",
        revision: 2,
        generation: 2,
      },
    }));
  return observed;
}

const firstReply: ModelReply = {
  kind: "answer",
  text: "Use Export.",
  citations: [fixtureInstances.workshop.portalSource],
  model: "fixture-model",
  requestId: "response-1",
  usage: { inputTokens: 25, outputTokens: 4 },
};

describe("knowledge/AI acceptance corpus integrity (not service acceptance)", () => {
  it("maps every planned scenario to both wholly fictional instances", () => {
    expect(acceptanceCases).toHaveLength(80);
    expect(new Set(acceptanceCases.map((item) => item.id)).size).toBe(80);
    for (const scenario of planScenarios) {
      for (const instanceId of ["workshop", "observatory"] as const) {
        expect(
          acceptanceCases.some(
            (item) =>
              item.scenario === scenario && item.instanceId === instanceId,
          ),
        ).toBe(true);
      }
    }
    for (const item of acceptanceCases) {
      expect(item.ownerTasks.length).toBeGreaterThan(0);
      expect(item.steps.length).toBeGreaterThan(0);
      expect(item.id.startsWith(`${item.instanceId}/`)).toBe(true);
      for (const source of [
        ...item.expected.modelSources,
        ...item.expected.portalSources,
        ...item.expected.messageSources,
      ]) {
        expect(source.instanceId).toBe(item.instanceId);
      }
      for (const target of item.expected.repositoryTargets ?? []) {
        expect(
          Object.values(fixtureInstances[item.instanceId].repositories).some(
            (repository) => repository.id === target.repositoryId,
          ),
        ).toBe(true);
      }
    }
    expect(fixtureInstances.workshop.customerId).not.toBe(
      fixtureInstances.observatory.customerId,
    );
    const repositoryIds = Object.values(fixtureInstances).flatMap((instance) =>
      Object.values(instance.repositories).map((repository) => repository.id),
    );
    expect(new Set(repositoryIds).size).toBe(repositoryIds.length);
  });

  it("keeps ordinary submitted sensitive context permitted under verified ZDR", () => {
    const permitted = fixtureCase("sensitive-submitted-context");
    expect(permitted.input.provider).toBe("verified_zdr");
    expect(permitted.expected.modelCalls).toBe(1);
    expect(permitted.expected.outcome).toBe("answered");
    expect(fixtureCase("zdr-unverified").expected.modelCalls).toBe(0);
    expect(fixtureCase("credential-revoked").expected.modelCalls).toBe(0);
  });

  it("requires qualifying evidence before learning from a resolved status", () => {
    const unverified = fixtureCase("unverified-resolution");
    const observed: Observation = {
      instanceId: "workshop",
      outcome: "human_review",
      modelRequests: [],
      artifacts: [],
    };
    expect(evaluateObservation(unverified, observed)).toEqual([]);
    observed.modelRequests = [
      { ...request(), purpose: "learning", sources: [] },
    ];
    observed.artifacts = [
      {
        kind: "draft",
        instanceId: "workshop",
        id: "ineligible",
        text: "Draft",
      },
    ];
    const failures = evaluateObservation(unverified, observed);
    expect(failures).toContain("count:model");
    expect(failures).toContain("count:draft");
  });
});

describe("observation evaluator discrimination", () => {
  it("rejects an outcome that disagrees with the authored oracle", () => {
    expect(
      evaluateObservation(fixtureCase("collection-audiences"), {
        ...safeObservation(),
        outcome: "escalated",
      }),
    ).toContain("outcome");
  });

  it("accepts a manually authored safe observation", () => {
    expect(
      evaluateObservation(
        fixtureCase("collection-audiences"),
        safeObservation(),
      ),
    ).toEqual([]);
  });

  it("rejects bot-only portal exposure even when aggregate customer sources match", () => {
    const observed = safeObservation();
    observed.artifacts = observed.artifacts.map((artifact) => ({
      ...artifact,
      sources:
        artifact.kind === "portal"
          ? [fixtureInstances.workshop.botSource]
          : [fixtureInstances.workshop.portalSource],
    }));
    const failures = evaluateObservation(
      fixtureCase("collection-audiences"),
      observed,
    );
    expect(failures).toContain("sources:portal");
    expect(failures).toContain("sources:message");
  });

  it("accepts a commit bound to the newer requested turn", () => {
    expect(
      evaluateObservation(
        fixtureCase("new-message-race"),
        newerTurnObservation(),
      ),
    ).toEqual([]);
  });

  it.each([
    { operationId: "workshop/old-turn" },
    { ticketId: "workshop/other-ticket" },
    { revision: 1 },
    { generation: 1 },
  ])("rejects a stale or mismatched committed turn %o", (changedCause) => {
    const observed = newerTurnObservation();
    observed.artifacts = observed.artifacts.map((artifact) => ({
      ...artifact,
      committedTurn: {
        operationId: "workshop/new-turn",
        ticketId: "workshop/ticket-1",
        revision: 2,
        generation: 2,
        ...changedCause,
      },
    }));
    expect(
      evaluateObservation(fixtureCase("new-message-race"), observed),
    ).toContain("turns:message");
  });

  it("rejects the old turn as the only commit despite correct counts and sources", () => {
    const observed = newerTurnObservation();
    observed.artifacts = observed.artifacts.map((artifact) => ({
      ...artifact,
      committedTurn: {
        operationId: "workshop/old-turn",
        ticketId: "workshop/ticket-1",
        revision: 1,
        generation: 1,
      },
    }));
    expect(
      evaluateObservation(fixtureCase("new-message-race"), observed),
    ).toContain("turns:message");
  });

  it("rejects a message without the required committed turn identity", () => {
    const observed = newerTurnObservation();
    observed.artifacts = observed.artifacts.map(
      ({ committedTurn: _committedTurn, ...artifact }) => artifact,
    );
    expect(
      evaluateObservation(fixtureCase("new-message-race"), observed),
    ).toContain("turns:message");
  });

  it("requires the committed turn to appear in the actual model request trace", () => {
    const observed = newerTurnObservation();
    observed.modelRequests = [
      request("workshop/old-turn", 1, 1),
      request("workshop/old-turn", 1, 1),
    ];
    expect(
      evaluateObservation(fixtureCase("new-message-race"), observed),
    ).toContain("turn:unrequested");
  });

  it("checks the exact route target even when another allowed repository was chosen", () => {
    const scenario = fixtureCase("confident-repository");
    const observed: Observation = {
      instanceId: "workshop",
      outcome: "awaiting_approval",
      modelRequests: [{ ...request(), purpose: "routing", sources: [] }],
      artifacts: [
        {
          kind: "draft",
          instanceId: "workshop",
          id: "routing-proposal",
          text: "Verified guide export failure.",
          repositoryId: fixtureInstances.workshop.repositories.guides.id,
        },
      ],
    };
    expect(evaluateObservation(scenario, observed)).toEqual([]);
    observed.artifacts = observed.artifacts.map((artifact) => ({
      ...artifact,
      repositoryId: fixtureInstances.workshop.repositories.product.id,
    }));
    expect(evaluateObservation(scenario, observed)).toContain(
      "repository:targets",
    );
    observed.artifacts = observed.artifacts.map((artifact) => ({
      ...artifact,
      repositoryId: fixtureInstances.observatory.repositories.guides.id,
    }));
    expect(evaluateObservation(scenario, observed)).toContain(
      "repository:targets",
    );
  });

  it.each([
    ["public-export", "guides", "product"],
    ["private-export", "product", "guides"],
  ] as const)(
    "checks the actual repository on %s",
    (caseId, correct, wrong) => {
      const observed: Observation = {
        instanceId: "workshop",
        outcome: "exported",
        modelRequests: [],
        artifacts: [
          {
            kind: "issue",
            instanceId: "workshop",
            id: "issue-1",
            text: "Sanitized guide export reproduction.",
            repositoryId: fixtureInstances.workshop.repositories[correct].id,
          },
        ],
      };
      expect(evaluateObservation(fixtureCase(caseId), observed)).toEqual([]);
      observed.artifacts = observed.artifacts.map((artifact) => ({
        ...artifact,
        repositoryId: fixtureInstances.workshop.repositories[wrong].id,
      }));
      expect(evaluateObservation(fixtureCase(caseId), observed)).toContain(
        "repository:targets",
      );
    },
  );

  it.each(["model", "customer"] as const)(
    "rejects private-note leakage to %s",
    (sink) => {
      const observed = structuredClone(safeObservation());
      if (sink === "model") {
        observed.modelRequests = [
          {
            ...request(),
            messages: [
              {
                role: "customer",
                content: fixtureInstances.workshop.staffSentinel,
              },
            ],
          },
        ];
      } else {
        observed.artifacts = [
          ...observed.artifacts,
          {
            kind: "private" as const,
            instanceId: "workshop" as const,
            id: "evidence",
            text: "Staff may read this.",
          },
        ].map((artifact) =>
          artifact.kind === "message"
            ? { ...artifact, text: fixtureInstances.workshop.staffSentinel }
            : artifact,
        );
      }
      expect(
        evaluateObservation(fixtureCase("collection-audiences"), observed),
      ).toContain(`forbidden:${sink}`);
    },
  );

  it("rejects wrong source revision and foreign-instance references", () => {
    const observed = safeObservation();
    observed.modelRequests = [
      {
        ...request(),
        sources: [
          {
            reference: {
              ...fixtureInstances.workshop.portalSource,
              revision: 2,
            },
            text: "Stale.",
          },
        ],
      },
    ];
    expect(
      evaluateObservation(fixtureCase("collection-audiences"), observed),
    ).toContain("sources:model");
    observed.modelRequests = [
      {
        ...request(),
        sources: [
          {
            reference: fixtureInstances.observatory.portalSource,
            text: "Foreign.",
          },
        ],
      },
    ];
    expect(
      evaluateObservation(fixtureCase("collection-audiences"), observed),
    ).toContain("sources:model");
  });

  it("rejects incorrect customer citations and disguised foreign content", () => {
    const observed = safeObservation();
    observed.artifacts = observed.artifacts.map((artifact) =>
      artifact.kind === "message"
        ? { ...artifact, sources: [fixtureInstances.observatory.portalSource] }
        : artifact,
    );
    expect(
      evaluateObservation(fixtureCase("collection-audiences"), observed),
    ).toContain("sources:message");
    observed.modelRequests = [
      {
        ...request(),
        messages: [
          {
            role: "customer",
            content: fixtureInstances.observatory.publicSentinel,
          },
        ],
      },
    ];
    expect(
      evaluateObservation(fixtureCase("collection-audiences"), observed),
    ).toContain("forbidden:model");
  });

  it("permits private evidence for authorized staff without exposing it", () => {
    const observed = safeObservation();
    observed.artifacts = [
      ...observed.artifacts,
      {
        kind: "private",
        instanceId: "workshop",
        id: "staff-evidence",
        text: fixtureInstances.workshop.staffSentinel,
      },
    ];
    expect(
      evaluateObservation(fixtureCase("collection-audiences"), observed),
    ).toEqual([]);
  });

  it("permits submitted sensitive context in the approved ZDR processing case", () => {
    const scenario = fixtureCase("sensitive-submitted-context");
    const observed = safeObservation();
    observed.artifacts = observed.artifacts.filter(
      (artifact) => artifact.kind === "message",
    );
    observed.modelRequests = [
      {
        ...request(),
        messages: [
          {
            role: "customer",
            content: `${String(scenario.input.customerSubmittedText)} ${fixtureInstances.workshop.customerSentinel}`,
          },
        ],
      },
    ];
    expect(evaluateObservation(scenario, observed)).toEqual([]);
  });

  it.each(["model", "customer"] as const)(
    "rejects another instance's customer details in %s",
    (sink) => {
      const observed = safeObservation();
      if (sink === "model") {
        observed.modelRequests = [
          {
            ...request(),
            messages: [
              {
                role: "customer",
                content: fixtureInstances.observatory.customerSentinel,
              },
            ],
          },
        ];
      } else {
        observed.artifacts = observed.artifacts.map((artifact) =>
          artifact.kind === "message"
            ? {
                ...artifact,
                text: fixtureInstances.observatory.customerSentinel,
              }
            : artifact,
        );
      }
      expect(
        evaluateObservation(fixtureCase("collection-audiences"), observed),
      ).toContain(`forbidden:${sink}`);
    },
  );

  it("detects a provider call after a credential rejection", () => {
    const observed: Observation = {
      instanceId: "workshop",
      outcome: "denied",
      modelRequests: [request()],
      artifacts: [],
    };
    expect(
      evaluateObservation(fixtureCase("credential-revoked"), observed),
    ).toContain("count:model");
  });

  it("rejects duplicate commits and cross-instance artifacts", () => {
    const observed = safeObservation();
    observed.artifacts = [...observed.artifacts, observed.artifacts[1]!];
    expect(
      evaluateObservation(fixtureCase("collection-audiences"), observed),
    ).toContain("duplicate:message:answer-1");
    observed.artifacts = observed.artifacts.map((artifact) => ({
      ...artifact,
      instanceId: "observatory",
    }));
    expect(
      evaluateObservation(fixtureCase("collection-audiences"), observed),
    ).toContain("instance:artifact");
  });

  it.each(["issue", "notification", "publication"] as const)(
    "rejects an unapproved %s send",
    (kind) => {
      const observed = safeObservation();
      observed.artifacts = [
        ...observed.artifacts,
        {
          kind,
          instanceId: "workshop",
          id: "unauthorized",
          text: "Unexpected send.",
        },
      ];
      expect(
        evaluateObservation(fixtureCase("collection-audiences"), observed),
      ).toContain(`count:${kind}`);
    },
  );

  it("rejects private customer details in public exports", () => {
    const observed: Observation = {
      instanceId: "workshop",
      outcome: "exported",
      modelRequests: [],
      artifacts: [
        {
          kind: "issue",
          instanceId: "workshop",
          id: "issue-1",
          text: fixtureInstances.workshop.customerSentinel,
        },
      ],
    };
    expect(
      evaluateObservation(fixtureCase("public-export"), observed),
    ).toContain("forbidden:issue");
  });
});

describe("scripted model test double", () => {
  it("records immutable snapshots without consulting a case oracle", async () => {
    const model = createScriptedModel([{ kind: "reply", value: firstReply }]);
    const input = request();
    const output = await model.generate(input);
    input.messages[0]!.content = "Caller changed this after invocation.";
    expect(model.requests[0]?.messages[0]?.content).toBe("How do I export?");
    expect(output).toEqual(firstReply);
    const recorded = model.requests;
    expect(recorded).not.toBe(model.requests);
    await expect(model.generate(request())).rejects.toThrow(
      "No scripted model step",
    );
  });

  it("can complete later turns before older turns and reject pending calls", async () => {
    const model = createScriptedModel([
      { kind: "defer", id: "old" },
      { kind: "defer", id: "new" },
      { kind: "defer", id: "failed" },
    ]);
    const completed: string[] = [];
    const old = model.generate(request("old-turn", 1)).then(() => {
      completed.push("old");
    });
    const newer = model.generate(request("new-turn", 2)).then(() => {
      completed.push("new");
    });
    const failed = model.generate(request("failed-turn", 3));
    const failedAssertion = expect(failed).rejects.toThrow(
      "Provider unavailable",
    );
    expect(model.pendingIds).toEqual(["old", "new", "failed"]);
    model.complete("new", { ...firstReply, requestId: "response-new" });
    await newer;
    expect(completed).toEqual(["new"]);
    model.complete("old", firstReply);
    await old;
    model.reject("failed", new Error("Provider unavailable"));
    await failedAssertion;
    expect(completed).toEqual(["new", "old"]);
    expect(model.pendingIds).toEqual([]);
    expect(() => model.complete("old", firstReply)).toThrow(
      "Unknown deferred model step",
    );
  });
});
