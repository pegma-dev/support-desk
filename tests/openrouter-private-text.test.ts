import { describe, expect, it } from "vitest";
import { containsPrivateText } from "../packages/ai/src/openrouter/private-text.js";
import { actualEngineeringCheckerFixture } from "../test/openrouter-fixtures.js";

describe("shared deterministic private-text exclusion", () => {
  it.each([
    "PRIVATE first\nsecond",
    'PRIVATE "quoted" text',
    "PRIVATE \\ backslash text",
  ])("detects an exact private string under JSON escaping: %s", (value) => {
    expect(
      containsPrivateText(
        JSON.stringify({ nested: [{ body: "prefix " + value + " suffix" }] }),
        [value],
      ),
    ).toBe(true);
  });
  it("preserves benign nonmatches and ignores empty private needles", () => {
    const body = JSON.stringify({ body: "Public workspace guidance" });
    expect(containsPrivateText(body, ["PRIVATE unavailable"])).toBe(false);
    expect(containsPrivateText(body, ["", ""])).toBe(false);
    expect(containsPrivateText(body, [])).toBe(false);
  });
  it("does not turn programming errors into a privacy pass", () => {
    expect(() =>
      Reflect.apply(containsPrivateText, undefined, [undefined, []]),
    ).toThrow(TypeError);
  });
  it.each([
    "PRIVATE first\nsecond",
    'PRIVATE "quoted" text',
    "PRIVATE \\ backslash text",
  ])(
    "blocks an actual engineering private note before HTTP: %s",
    async (note) => {
      const f = await actualEngineeringCheckerFixture("pegma.dev", false, {
        privateNote: note,
        candidateSummary: note,
      });
      const result = await f.adapter
        .engineeringFor(f.f.key)
        .check(f.input, f.context);
      expect(result.outcome).toBe("held");
      expect(f.p.state.calls).toBe(0);
      expect(f.f.createIssue).not.toHaveBeenCalled();
    },
  );
});
