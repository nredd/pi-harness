import { defineConfig } from "vitest/config";

/** Runs only the killable worker fixture, never the package's ordinary test selection. */
export default defineConfig({
	test: {
		include: ["test/monitor/worker-death.fixture.ts"],
		pool: "forks",
		maxWorkers: 1,
		testTimeout: 15_000,
	},
});
