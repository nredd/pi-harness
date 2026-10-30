import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "istanbul",
      reporter: ["text", "lcov"],
      reportsDirectory: "coverage/runtime-build-tooling",
      reportOnFailure: true,
      include: ["scripts/*.mjs"],
    },
    environment: "node",
    env: {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "commit.gpgsign",
      GIT_CONFIG_VALUE_0: "false",
    },
    hookTimeout: 30_000,
    include: ["test/build-runtime.test.ts"],
    globalSetup: ["./test/harness/vitest.global-setup.ts"],
    pool: "forks",
    runner: "./test/harness/vitest.runner.ts",
    setupFiles: ["./test/harness/vitest.setup.ts"],
    teardownTimeout: 10_000,
    testTimeout: 5_000,
  },
});
