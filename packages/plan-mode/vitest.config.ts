import { definePackageConfig } from "../../scripts/vitest-package.ts";

export default definePackageConfig("plan-mode", {
  provider: "istanbul",
  test: {
    maxWorkers: 2,
    environment: "node",
    env: {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "commit.gpgsign",
      GIT_CONFIG_VALUE_0: "false",
    },
    hookTimeout: 30_000,
    include: ["tests/**/*.test.ts"],
    globalSetup: ["./tests/fixtures/vitest.global-setup.ts"],
    pool: "forks",
    runner: "./tests/fixtures/vitest.runner.ts",
    setupFiles: ["./tests/fixtures/vitest.setup.ts"],
    teardownTimeout: 10_000,
    testTimeout: 5_000,
  },
});
