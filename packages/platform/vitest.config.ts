import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    globals: false,
    // The suite must be deterministic: no wall-clock dependence, no shared DB
    // state between files. Sequential file execution keeps the Postgres
    // contract tests from racing each other on the same schema.
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
