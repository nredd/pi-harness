import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		maxWorkers: 1,
		coverage: {
			provider: "v8",
			reporter: ["text", "lcov"],
			reportsDirectory: "coverage/primary",
			reportOnFailure: true,
			include: ["src/collect.ts", "src/counters.ts", "src/darwin.ts", "src/index.ts"],
		},
		setupFiles: ["../../integration/inprocess/verification/home-setup.ts"],
	},
});
