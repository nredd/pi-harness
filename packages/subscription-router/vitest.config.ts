import { defineConfig } from "vitest/config";
export default defineConfig({
	test: {
		coverage: {
			provider: "v8",
			reporter: ["text", "lcov"],
			reportsDirectory: "coverage/primary",
			reportOnFailure: true,
			include: [
				"src/config.ts",
				"src/exhaustion.ts",
				"src/index.ts",
				"src/model-ref.ts",
				"src/recovery.ts",
				"src/router.ts",
				"src/selection.ts",
				"src/usage.ts",
			],
		},
	},
});
