import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

// `runtime-build-tooling`: plan-mode's `scripts/*.mjs` runtime builders that `test:dist` measures, not `src/`.
const { owned, exclusions }: { owned: string[]; exclusions: { path: string }[] } = JSON.parse(
  readFileSync(new URL("../../coverage/policy.json", import.meta.url), "utf8"),
).packages["runtime-build-tooling"];

export default defineConfig({
  test: {
    coverage: {
      provider: "istanbul",
      reporter: ["text", "lcov"],
      reportsDirectory: "coverage/runtime-build-tooling",
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
    include: ["test/build-runtime.test.ts"],
    globalSetup: ["./test/harness/vitest.global-setup.ts"],
    pool: "forks",
    runner: "./test/harness/vitest.runner.ts",
    setupFiles: ["./test/harness/vitest.setup.ts"],
    teardownTimeout: 10_000,
    testTimeout: 5_000,
  },
});
