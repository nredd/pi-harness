import { defineConfig } from "vitest/config";

// Match dev-tools: extensions run on the main thread in Pi, never a worker thread.
export default defineConfig({
	test: {
		coverage: {
			provider: "v8",
			reporter: ["text", "lcov"],
			reportsDirectory: "coverage/primary",
			reportOnFailure: true,
			include: ["goal-support.ts", "native-timers.ts", "support.ts"],
		},
		pool: "forks",
		maxWorkers: 2,
		testTimeout: 20_000,
	},
});
