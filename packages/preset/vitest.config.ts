import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

const { owned, exclusions }: { owned: string[]; exclusions: { path: string }[] } = JSON.parse(
	readFileSync(new URL("../../coverage/policy.json", import.meta.url), "utf8"),
).packages.preset;

// Interactive theme/keybinding state is process-global; keep hosts serial per worker.
export default defineConfig({
	test: {
		coverage: {
			provider: "istanbul",
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
