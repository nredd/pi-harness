import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const { owned, exclusions }: { owned: string[]; exclusions: { path: string }[] } = JSON.parse(
	readFileSync(new URL("../coverage/policy.json", import.meta.url), "utf8"),
).packages["import-audit"];

// Match `integration/inprocess`. Explicit test files, no glob: `tests/` is the pytest suite. The root is
// the repository, not `scripts/`: the report names every producer configuration by a repo-relative path.
export default defineConfig({
	root: fileURLToPath(new URL("..", import.meta.url)),
	test: {
		include: [
			"scripts/check-biome-paths.test.mjs",
			"scripts/coverage-configs.test.ts",
			"scripts/import_audit.test.ts",
			"scripts/router_contract.test.mjs",
			"scripts/run-vitest.test.ts",
		],
		coverage: {
			provider: "v8",
			reporter: ["text", "lcov", "json-summary"],
			reportsDirectory: "scripts/coverage/primary",
			reportOnFailure: true,
			include: owned,
			exclude: exclusions.map(({ path }) => path),
		},
		pool: "forks",
		maxWorkers: 2,
		testTimeout: 20_000,
		setupFiles: ["integration/inprocess/verification/home-setup.ts"],
	},
});
