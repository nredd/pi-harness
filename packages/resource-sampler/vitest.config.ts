import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

const { owned, exclusions }: { owned: string[]; exclusions: { path: string }[] } = JSON.parse(
	readFileSync(new URL("../../coverage/policy.json", import.meta.url), "utf8"),
).packages["resource-sampler"];

export default defineConfig({
	test: {
		maxWorkers: 1,
		coverage: {
			provider: "v8",
			reporter: ["text", "lcov", "json-summary"],
			reportsDirectory: "coverage/primary",
			reportOnFailure: true,
			include: owned,
			exclude: exclusions.map(({ path }) => path),
		},
		setupFiles: ["../../tests/lib/src/home-setup.ts"],
	},
});
