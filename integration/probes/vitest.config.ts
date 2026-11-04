import { defineConfig } from "vitest/config";

// Match `integration/inprocess`: forks, because `process-lifecycle.test.ts` spawns and signals real
// process groups through the production runners. Explicit files, no glob.
export default defineConfig({
	test: {
		include: [
			"anthropic-block-types.test.ts",
			"latency.test.ts",
			"process-lifecycle.test.ts",
			"render.test.ts",
			"session-kit-child-scope.test.ts",
			"stack-resources.test.ts",
			"transcript-types.test.ts",
		],
		coverage: {
			provider: "v8",
			reporter: ["text", "lcov"],
			reportsDirectory: "coverage/primary",
			reportOnFailure: true,
			include: [
				"anthropic-block-types.mjs",
				"latency.ts",
				"render.ts",
				"session-kit-child-scope.ts",
				"stack-resources.ts",
				"transcript-types.ts",
			],
		},
		pool: "forks",
		maxWorkers: 2,
		testTimeout: 20_000,
		setupFiles: ["../inprocess/verification/home-setup.ts"],
	},
});
