import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

const { owned, exclusions }: { owned: string[]; exclusions: { path: string }[] } = JSON.parse(
  readFileSync(new URL("../../coverage/policy.json", import.meta.url), "utf8"),
).packages["workflow-examples"];

export default defineConfig({
  test: {
    env: { PI_WORKFLOW_EXAMPLE_COVERAGE: "1" },
    setupFiles: ["./test/helpers/tmp-root-setup.ts", "../../integration/inprocess/verification/home-setup.ts"],
    server: { deps: { inline: [/@earendil-works\/pi-/] } },
    coverage: {
      provider: "istanbul",
      reporter: ["text", "lcov", "json-summary"],
      reportsDirectory: "coverage/workflow-examples",
      reportOnFailure: true,
      include: owned,
      exclude: exclusions.map(({ path }) => path),
    },
    include: ["test/workflow-examples.test.ts"],
  },
  resolve: { dedupe: ["@earendil-works/pi-ai"] },
});
