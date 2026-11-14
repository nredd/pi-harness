import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

const { owned, exclusions }: { owned: string[]; exclusions: { path: string }[] } = JSON.parse(
	readFileSync(new URL("../../coverage/policy.json", import.meta.url), "utf8"),
).packages.probes;

// Match `integration/inprocess`: forks, because `process-lifecycle.test.ts` spawns and signals real
// process groups through the production runners. Explicit test files, no glob.
export default defineConfig({
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
		coverage: {
			provider: "v8",
			reporter: ["text", "lcov", "json-summary"],
			reportsDirectory: "coverage/primary",
			reportOnFailure: true,
			include: owned,
			exclude: exclusions.map(({ path }) => path),
		},
		pool: "forks",
		maxWorkers: 2,
		testTimeout: 20_000,
		setupFiles: ["../../tests/lib/src/home-setup.ts"],
	},
});
