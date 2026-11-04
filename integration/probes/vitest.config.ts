import { defineConfig } from "vitest/config";

// Match `integration/inprocess`: forks, because `process-lifecycle.test.ts` spawns and signals real
// process groups through the production runners. Explicit files, no glob.
export default defineConfig({
	test: {
		include: ["transcript-types.test.ts", "process-lifecycle.test.ts", "render.test.ts"],
		coverage: {
			provider: "v8",
			reporter: ["text", "lcov"],
			reportsDirectory: "coverage/primary",
			reportOnFailure: true,
			include: ["transcript-types.ts"],
		},
		pool: "forks",
		maxWorkers: 2,
		testTimeout: 20_000,
		setupFiles: ["../inprocess/verification/home-setup.ts"],
	},
});
