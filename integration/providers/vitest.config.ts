import { defineConfig } from "vitest/config";

// Match `integration/probes`: forks, so each file gets its own process. `preloads.test.ts` installs the
// redirect preload's process-wide `fetch` accessor and `child_process` wrappers, which must not leak
// into another file. Explicit files, no glob.
export default defineConfig({
	test: {
		include: ["extension_inventory.test.ts", "faux.test.ts", "preloads.test.ts", "usage_fixture.test.ts"],
		coverage: {
			provider: "v8",
			reporter: ["text", "lcov"],
			reportsDirectory: "coverage/primary",
			reportOnFailure: true,
			include: [
				"auth_guard.mjs",
				"auth_runtime_fixture.mjs",
				"auth_transport.mjs",
				"extension_inventory.ts",
				"faux.ts",
				"redirect_anthropic.mjs",
				"usage_fixture.ts",
			],
		},
		pool: "forks",
		maxWorkers: 2,
		testTimeout: 20_000,
		setupFiles: ["../inprocess/verification/home-setup.ts"],
	},
});
