import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts", "tests/**/*.test.ts"],
    exclude: ["**/dist/**", "**/node_modules/**"],
    globalSetup: ["./test/azurite.ts"],
    // Integration files share one Azurite service; bound concurrent file workers.
    maxWorkers: 2,
    testTimeout: 30_000,
  },
});
