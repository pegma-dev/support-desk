import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts"],
    exclude: ["**/dist/**", "**/node_modules/**"],
  },
});
