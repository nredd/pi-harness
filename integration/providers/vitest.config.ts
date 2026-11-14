import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

const { owned, exclusions }: { owned: string[]; exclusions: { path: string }[] } = JSON.parse(
	readFileSync(new URL("../../coverage/policy.json", import.meta.url), "utf8"),
).packages.providers;

// Match `integration/probes`: forks, so each file gets its own process. `preloads.test.ts` installs the
// redirect preload's process-wide `fetch` accessor and `child_process` wrappers, which must not leak
// into another file. Explicit test files, no glob.
export default defineConfig({
	test: {
		include: [
			"bun_runtime.test.ts",
			"extension_inventory.test.ts",
			"faux.test.ts",
			"preloads.test.ts",
			"usage_fixture.test.ts",
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
