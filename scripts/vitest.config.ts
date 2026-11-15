import { fileURLToPath } from "node:url";
import { definePackageConfig } from "./vitest-package.ts";

// Match `integration/inprocess`. Explicit test files, no glob: `tests/` is the pytest suite. The root is
// the repository, not `scripts/`: the report names every producer configuration by a repo-relative path.
export default definePackageConfig("import-audit", {
	provider: "v8",
	reportsDirectory: "scripts/coverage/primary",
	root: fileURLToPath(new URL("..", import.meta.url)),
	test: {
		include: [
			"scripts/coverage-configs.test.ts",
			"scripts/import_audit.test.ts",
			"scripts/merge-pr.test.ts",
			"scripts/router_contract.test.mjs",
			"scripts/run-vitest.test.ts",
		],
		pool: "forks",
		maxWorkers: 2,
		testTimeout: 20_000,
	},
});
