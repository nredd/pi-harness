import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

const { owned, exclusions }: { owned: string[]; exclusions: { path: string }[] } = JSON.parse(
	readFileSync(new URL("../../coverage/policy.json", import.meta.url), "utf8"),
).packages["dev-tools"];

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
			include: owned,
			exclude: exclusions.map(({ path }) => path),
		},
		pool: "forks",
		maxWorkers: 2,
		setupFiles: ["../../integration/inprocess/verification/home-setup.ts"],
		testTimeout: 20_000,
	},
});
