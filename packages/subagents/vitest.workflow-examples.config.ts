import { definePackageConfig } from "../../scripts/vitest-package.ts";

export default definePackageConfig("workflow-examples", {
  provider: "istanbul",
  reportsDirectory: "coverage/workflow-examples",
  test: {
    env: { PI_WORKFLOW_EXAMPLE_COVERAGE: "1" },
    setupFiles: ["./tests/fixtures/tmp-root-setup.ts"],
    server: { deps: { inline: [/@earendil-works\/pi-/] } },
    include: ["tests/workflow/workflow-examples.test.ts"],
  },
  resolve: { dedupe: ["@earendil-works/pi-ai"] },
});
