import { defineConfig } from "vitest/config";

// Child processes, not worker threads: pi loads extensions on the main thread, and the process
// runner's signal handling showed stalls under the threads pool that never reproduce in forks.
// Two workers at most: the cargo and uv suites compile real projects, and a cold build running
// next to the timing-sensitive core tests made them flaky.
export default defineConfig({
	test: {
		coverage: {
			provider: "istanbul",
			reporter: ["text", "lcov"],
			reportsDirectory: "coverage/primary",
			reportOnFailure: true,
			include: [
				"src/index.ts",
				"src/cargo/index.ts",
				"src/cargo/parse.ts",
				"src/core/filelock.ts",
				"src/core/lock.ts",
				"src/core/output.ts",
				"src/core/process.ts",
				"src/core/result.ts",
				"src/core/tool.ts",
				"src/git/commit-message.ts",
				"src/git/guard.ts",
				"src/git/push-remote.ts",
				"src/git/index.ts",
				"src/git/merge.ts",
				"src/git/run.ts",
				"src/git/status.ts",
				"src/git/worktree.ts",
				"src/py/index.ts",
				"src/py/parse.ts",
				"src/resource/index.ts",
				"src/ssh/exec.ts",
				"src/ssh/hosts.ts",
				"src/ssh/index.ts",
			],
		},
		pool: "forks",
		maxWorkers: 2,
		testTimeout: 20_000,
	},
});
