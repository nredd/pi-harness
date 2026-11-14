import { definePackageConfig } from "../../scripts/vitest-package.ts";

// No home guard: this producer never read one.
export default definePackageConfig("subagents-runtime-tooling", {
  provider: "istanbul",
  reportsDirectory: "coverage/runtime-build-tooling",
  homeGuard: false,
  test: {
    maxWorkers: 1,
    include: ["test/runtime-scripts.test.ts"],
    testTimeout: 15_000,
    coverage: {
      thresholds: {
        "scripts/build-runtime.mjs": { lines: 100, functions: 100, branches: 100, statements: 100 },
      },
    },
  },
});
