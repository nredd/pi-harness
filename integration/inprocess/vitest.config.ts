import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

const { owned, exclusions }: { owned: string[]; exclusions: { path: string }[] } = JSON.parse(
	readFileSync(new URL("../../coverage/policy.json", import.meta.url), "utf8"),
).packages.inprocess;

// Match dev-tools: extensions run on the main thread in Pi, never a worker thread.
export default defineConfig({
	test: {
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
		setupFiles: ["./verification/home-setup.ts"],
	},
});
