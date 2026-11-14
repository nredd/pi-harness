import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

const { owned, exclusions }: { owned: string[]; exclusions: { path: string }[] } = JSON.parse(
  readFileSync(new URL("../../coverage/policy.json", import.meta.url), "utf8"),
).packages["subagents-runtime-tooling"];

export default defineConfig({
  test: {
    maxWorkers: 1,
    include: ["test/runtime-scripts.test.ts"],
    testTimeout: 15_000,
    coverage: {
      provider: "istanbul",
      reporter: ["text", "lcov", "json-summary"],
      reportsDirectory: "coverage/runtime-build-tooling",
      reportOnFailure: true,
      include: owned,
      exclude: exclusions.map(({ path }) => path),
      thresholds: {
        "scripts/build-runtime.mjs": { lines: 100, functions: 100, branches: 100, statements: 100 },
      },
    },
  },
});
