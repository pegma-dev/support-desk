import { describe, expect, it, vi } from "vitest";
import {
  defineCannedResponse,
  defineCannedResponseCatalog,
  renderCannedResponse,
  type CannedResponseDefinition,
} from "./index.js";

const definition = {
  id: "acknowledgement",
  version: 1,
  title: "Acknowledge a question",
  target: "reply" as const,
  variables: ["topic"],
  body: "Thank you. We will review {{topic}}.",
};

describe("plain-text canned responses", () => {
  it("snapshots a versioned definition and expands literal values once", () => {
    const input = { ...definition, variables: [...definition.variables] };
    const response = defineCannedResponse(input);
    input.body = "Changed";
    input.variables.push("secret");
    expect(Object.isFrozen(response)).toBe(true);
    expect(Object.isFrozen(response.variables)).toBe(true);
    expect(renderCannedResponse(response, { topic: "<b>{{topic}}</b>" })).toBe(
      "Thank you. We will review <b>{{topic}}</b>.",
    );
  });

  it("rejects missing, extra, inherited and accessor values without executing them", () => {
    const getter = vi.fn(() => "topic");
    for (const values of [
      {},
      { topic: "question", extra: "private" },
      Object.create({ topic: "inherited" }),
      Object.defineProperty({}, "topic", { get: getter }),
    ]) {
      expect(() => renderCannedResponse(definition, values)).toThrow(TypeError);
    }
    expect(getter).not.toHaveBeenCalled();
  });

  it("rejects malformed definitions and bounded or hostile values", () => {
    for (const change of [
      { id: "bad id" },
      { version: 0 },
      { target: "resolve" },
      { title: "bad\u0000" },
      { variables: ["topic", "topic"] },
      { variables: ["unused"] },
      { body: "{{unknown}}" },
      { body: "{{ topic }}" },
      { body: "missing }}" },
      { body: "" },
      { body: "x".repeat(16_001) },
      { permissions: ["support.ticket.manage"] },
    ]) {
      expect(() =>
        defineCannedResponse({
          ...definition,
          ...change,
        } as CannedResponseDefinition),
      ).toThrow(TypeError);
    }
    for (const topic of ["", "a\u0000b", "a\u007fb", "x".repeat(2001)])
      expect(() => renderCannedResponse(definition, { topic })).toThrow(
        TypeError,
      );
  });

  it("bounds expanded output before allocating it and rejects hidden expressions", () => {
    expect(() =>
      renderCannedResponse(
        { ...definition, body: "{{topic}}".repeat(10) },
        { topic: "x".repeat(2000) },
      ),
    ).toThrow(TypeError);
    expect(() =>
      defineCannedResponse({ ...definition, body: "{{{{topic}}}}" }),
    ).toThrow(TypeError);
  });

  it("validates and snapshots the bounded deployment catalog, including every physical slot", () => {
    expect(defineCannedResponseCatalog(undefined)).toEqual([]);
    expect(() =>
      defineCannedResponseCatalog(Array(65).fill(definition)),
    ).toThrow(TypeError);
    expect(() => defineCannedResponseCatalog([definition, definition])).toThrow(
      TypeError,
    );
    expect(
      defineCannedResponseCatalog([definition, { ...definition, version: 2 }]),
    ).toHaveLength(2);
    const getter = vi.fn(() => definition);
    const definitions = [definition];
    Object.defineProperty(definitions, 0, { get: getter });
    expect(() => defineCannedResponseCatalog(definitions)).toThrow(TypeError);
    const variables = ["topic"];
    Object.defineProperty(variables, 0, { get: getter });
    expect(() => defineCannedResponse({ ...definition, variables })).toThrow(
      TypeError,
    );
    expect(() => defineCannedResponseCatalog(new Array(1))).toThrow(TypeError);
    expect(() => defineCannedResponse(Object.create(definition))).toThrow(
      TypeError,
    );
    expect(() =>
      defineCannedResponse(
        Object.defineProperty({ ...definition }, "body", { get: getter }),
      ),
    ).toThrow(TypeError);
    expect(() =>
      defineCannedResponse({ ...definition, [Symbol("hidden")]: "value" }),
    ).toThrow(TypeError);
    expect(getter).not.toHaveBeenCalled();
  });
});
