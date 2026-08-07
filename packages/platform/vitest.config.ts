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
    // Runs once per run, not once per file. It states which store adapters the
    // run covered, because a run without PV_TEST_DATABASE_URL skips 158
    // persistence contract assertions and still prints a green summary.
    globalSetup: ["./tools/vitest-global-setup.ts"],
  },
});
