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
    include: ["test/**/*.test.ts"],
    globalSetup: ["./test/harness/vitest.global-setup.ts"],
    pool: "forks",
    runner: "./test/harness/vitest.runner.ts",
    setupFiles: ["./test/harness/vitest.setup.ts"],
    teardownTimeout: 10_000,
    testTimeout: 5_000,
  },
});
