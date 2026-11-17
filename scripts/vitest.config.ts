import { fileURLToPath } from "node:url";
import { definePackageConfig } from "./vitest-package.ts";

// Match `tests/inprocess`. Explicit test files, no glob: `tests/` is the pytest suite. The root is
// the repository, not `scripts/`: the report names every producer configuration by a repo-relative path.
const config = definePackageConfig("import-audit", {
	provider: "v8",
	reportsDirectory: "scripts/coverage/primary",
	root: fileURLToPath(new URL("..", import.meta.url)),
	test: {
		include: [
			"scripts/tests/commit-messages.test.mjs",
			"scripts/tests/commit-policy.test.mjs",
			"scripts/coverage-configs.test.ts",
			"scripts/import_audit.test.ts",
			"scripts/merge-pr.test.ts",
			"scripts/router_contract.test.mjs",
			"scripts/run-vitest.test.ts",
		],
		pool: "forks",
		maxWorkers: 2,
		testTimeout: 20_000,
		coverage: { thresholds: { perFile: true, lines: 100, functions: 100, branches: 100, statements: 100 } },
	},
});

export default config;
