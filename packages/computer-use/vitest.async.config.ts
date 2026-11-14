import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

// Verification tooling is measured independently of the runtime's 35-file slice.
const { owned, exclusions }: { owned: string[]; exclusions: { path: string }[] } = JSON.parse(
	readFileSync(new URL("../../coverage/policy.json", import.meta.url), "utf8"),
).packages["computer-use-async"];

export default defineConfig({
	test: {
		include: ["test/async.test.mjs", "test/async-observer.test.mjs", "test/async-safety.test.mjs"],
		pool: "forks",
		maxWorkers: 1,
		testTimeout: 20_000,
		setupFiles: ["../../integration/inprocess/verification/home-setup.ts"],
		coverage: {
			provider: "istanbul",
			reporter: ["text", "lcov", "json-summary"],
			reportsDirectory: "coverage/async",
			reportOnFailure: true,
			include: owned,
			exclude: exclusions.map(({ path }) => path),
			thresholds: { "scripts/check-async.mjs": { lines: 100, functions: 100, branches: 100, statements: 100 } },
		},
	},
});
