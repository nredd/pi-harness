import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// `runtime-build-tooling`: plan-mode's `scripts/build-runtime.mjs` plus the shared root `scripts/runtime-builder.mjs`
// that `test:dist` measures, not `src/`. The root is the repository so both files sit inside it (as `import-audit`).
const { owned, exclusions }: { owned: string[]; exclusions: { path: string }[] } = JSON.parse(
  readFileSync(new URL("../../coverage/policy.json", import.meta.url), "utf8"),
).packages["runtime-build-tooling"];

export default defineConfig({
  root: fileURLToPath(new URL("../..", import.meta.url)),
  test: {
    coverage: {
      provider: "istanbul",
      reporter: ["text", "lcov", "json-summary"],
      reportsDirectory: "packages/plan-mode/coverage/runtime-build-tooling",
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
    include: ["packages/plan-mode/test/build-runtime.test.ts"],
    globalSetup: ["./packages/plan-mode/test/harness/vitest.global-setup.ts"],
    pool: "forks",
    runner: "./packages/plan-mode/test/harness/vitest.runner.ts",
    setupFiles: ["./packages/plan-mode/test/harness/vitest.setup.ts"],
    teardownTimeout: 10_000,
    testTimeout: 5_000,
  },
});
