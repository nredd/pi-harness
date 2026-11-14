import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

const { owned, exclusions }: { owned: string[]; exclusions: { path: string }[] } = JSON.parse(
  readFileSync(new URL("../../coverage/policy.json", import.meta.url), "utf8"),
).packages["plan-mode"];

export default defineConfig({
  test: {
    maxWorkers: 2,
    coverage: {
      provider: "istanbul",
      reporter: ["text", "lcov", "json-summary"],
      reportsDirectory: "coverage/primary",
      reportOnFailure: true,
      include: owned,
      exclude: exclusions.map(({ path }) => path),
    },
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
    setupFiles: ["./test/harness/vitest.setup.ts", "../../integration/inprocess/verification/home-setup.ts"],
    teardownTimeout: 10_000,
    testTimeout: 5_000,
  },
});
