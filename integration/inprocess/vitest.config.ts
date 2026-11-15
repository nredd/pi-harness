import { definePackageConfig } from "../../scripts/vitest-package.ts";

// Match dev-tools: extensions run on the main thread in Pi, never a worker thread.
export default definePackageConfig("inprocess", {
	provider: "v8",
	test: {
		pool: "forks",
		maxWorkers: 2,
		testTimeout: 20_000,
	},
});
