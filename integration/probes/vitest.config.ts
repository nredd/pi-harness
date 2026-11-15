import { definePackageConfig } from "../../scripts/vitest-package.ts";

// Match `integration/inprocess`: forks, because `process-lifecycle.test.ts` spawns and signals real
// process groups through the production runners. Explicit test files, no glob.
export default definePackageConfig("probes", {
	provider: "v8",
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
		pool: "forks",
		maxWorkers: 2,
		testTimeout: 20_000,
	},
});
