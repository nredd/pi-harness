import { fileURLToPath } from "node:url";
import { definePackageConfig } from "../../scripts/vitest-package.ts";

// `runtime-build-tooling`: plan-mode's `scripts/build-runtime.mjs` plus the shared root `scripts/runtime-builder.mjs`
// that `test:runtime-build` measures, not `src/`. The root is the repository so both files sit inside it (as `import-audit`).
// No home guard: this producer never read one.
export default definePackageConfig("runtime-build-tooling", {
  provider: "istanbul",
  reportsDirectory: "packages/plan-mode/coverage/runtime-build-tooling",
  homeGuard: false,
  root: fileURLToPath(new URL("../..", import.meta.url)),
  test: {
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
