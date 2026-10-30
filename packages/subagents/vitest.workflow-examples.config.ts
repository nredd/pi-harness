import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    env: { PI_WORKFLOW_EXAMPLE_COVERAGE: "1" },
    setupFiles: ["../../integration/inprocess/verification/home-setup.ts"],
    server: { deps: { inline: [/@earendil-works\/pi-/] } },
    coverage: {
      provider: "istanbul",
      reporter: ["text", "lcov"],
      reportsDirectory: "coverage/workflow-examples",
      reportOnFailure: true,
      include: ["examples/**/*.js"],
    },
    include: ["test/workflow-examples.test.ts"],
  },
  resolve: { dedupe: ["@earendil-works/pi-ai"] },
});
