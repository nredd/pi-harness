import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

const { owned, exclusions }: { owned: string[]; exclusions: { path: string }[] } = JSON.parse(
	readFileSync(new URL("../coverage/policy.json", import.meta.url), "utf8"),
).packages["import-audit"];

// Match `integration/inprocess`. Explicit files, no glob: `tests/` is the pytest suite.
export default defineConfig({
	test: {
		include: ["check-biome-paths.test.mjs", "import_audit.test.ts", "router_contract.test.mjs", "run-vitest.test.ts"],
		coverage: {
			provider: "v8",
			reporter: ["text", "lcov"],
			reportsDirectory: "coverage/primary",
			reportOnFailure: true,
			include: owned,
			exclude: exclusions.map(({ path }) => path),
		},
		pool: "forks",
		maxWorkers: 2,
		testTimeout: 20_000,
		setupFiles: ["../integration/inprocess/verification/home-setup.ts"],
	},
});
