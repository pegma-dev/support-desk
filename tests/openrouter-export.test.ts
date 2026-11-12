import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as root from "@pegma/support-desk-ai";
import * as provider from "@pegma/support-desk-ai/openrouter";

describe("optional public provider subpath", () => {
  it("exports one optional level while keeping the AI root provider-neutral", () => {
    const manifest = JSON.parse(
      readFileSync("packages/ai/package.json", "utf8"),
    );
    expect(Object.keys(manifest.exports)).toEqual([".", "./openrouter"]);
    expect(manifest.exports["./openrouter"]).toEqual({
      types: "./dist/openrouter/index.d.ts",
      import: "./dist/openrouter/index.js",
    });
    expect(manifest.dependencies).toMatchObject({
      zod: "4.4.3",
      "@pegma/storage-core": "0.4.0",
    });
    for (const name of [
      "createSupportOpenRouterModel",
      "createSupportModelUsageLedger",
      "createSupportIndependentCheckModel",
      "createSupportIndependentChecks",
    ] as const) {
      expect(provider[name]).toBeTypeOf("function");
      expect(root).not.toHaveProperty(name);
    }
  });
  it("imports in a clean process without provider, secret, application or Store activity", () => {
    const child = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `
      let calls = 0;
      globalThis.fetch = async () => { calls++; throw new Error('Unexpected network'); };
      Object.defineProperty(globalThis, 'crypto', { configurable: true, get() { throw new Error('Unexpected key or crypto activity'); } });
      const module = await import('@pegma/support-desk-ai/openrouter');
      if (typeof module.createSupportIndependentChecks !== 'function') throw new Error('Missing export');
      process.stdout.write(JSON.stringify({ calls }));
    `,
      ],
      {
        cwd: process.cwd(),
        env: process.env,
        encoding: "utf8",
        windowsHide: true,
      },
    );
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual({ calls: 0 });
  });
});
