import { definePackageConfig } from "../../scripts/vitest-package.ts";

// Verification tooling is measured independently of the runtime's 35-file slice.
export default definePackageConfig("computer-use-async", {
	provider: "istanbul",
	reportsDirectory: "coverage/async",
	test: {
		include: ["test/async.test.mjs", "test/async-observer.test.mjs", "test/async-safety.test.mjs"],
		pool: "forks",
		maxWorkers: 1,
		testTimeout: 20_000,
		coverage: {
			thresholds: { "scripts/check-async.mjs": { lines: 100, functions: 100, branches: 100, statements: 100 } },
		},
	},
});
