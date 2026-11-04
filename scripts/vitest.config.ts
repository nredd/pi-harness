import { defineConfig } from "vitest/config";

// Match `integration/inprocess`. Explicit files, no glob: `tests/` is the pytest suite.
export default defineConfig({
	test: {
		include: ["check-biome-paths.test.mjs", "import_audit.test.ts"],
		coverage: {
			provider: "v8",
			reporter: ["text", "lcov"],
			reportsDirectory: "coverage/primary",
			reportOnFailure: true,
			include: ["import_audit.ts"],
		},
		pool: "forks",
		maxWorkers: 2,
		testTimeout: 20_000,
		setupFiles: ["../integration/inprocess/verification/home-setup.ts"],
	},
});
