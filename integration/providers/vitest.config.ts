import { definePackageConfig } from "../../scripts/vitest-package.ts";

// Match `integration/probes`: forks, so each file gets its own process. `preloads.test.ts` installs the
// redirect preload's process-wide `fetch` accessor and `child_process` wrappers, which must not leak
// into another file. Explicit test files, no glob.
export default definePackageConfig("providers", {
	provider: "v8",
	test: {
		include: [
			"bun_runtime.test.ts",
			"extension_inventory.test.ts",
			"faux.test.ts",
			"preloads.test.ts",
			"usage_fixture.test.ts",
		],
		pool: "forks",
		maxWorkers: 2,
		testTimeout: 20_000,
	},
});
