import { defineConfig } from "vitest/config";
export default defineConfig({
	test: {
		coverage: {
			provider: "v8",
			reporter: ["text", "lcov"],
			reportsDirectory: "coverage/primary",
			reportOnFailure: true,
			include: ["src/collect.ts", "src/counters.ts", "src/index.ts"],
		},
	},
});
