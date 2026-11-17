import { definePackageConfig } from "../../../scripts/vitest-package.ts";

// Match `tests/inprocess`: forks, because `process-lifecycle.test.ts` spawns and signals real
// process groups through the production runners. Explicit test files, no glob.
const config = definePackageConfig("probes", {
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
		coverage: { thresholds: { perFile: true, lines: 100, functions: 100, branches: 100, statements: 100 } },
	},
});

export default config;
