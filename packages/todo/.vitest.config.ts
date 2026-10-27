import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: {
		alias: {
			"@juicesharp/rpiv-test-utils": fileURLToPath(new URL("./.test-support/upstream/index.ts", import.meta.url)),
		},
	},
	test: {
		coverage: {
			provider: "v8",
			reporter: ["text", "lcov"],
			reportsDirectory: "coverage/primary",
			reportOnFailure: true,
			include: [
				"config.ts",
				"index.ts",
				"plan-hooks.ts",
				"todo-overlay.ts",
				"todo.ts",
				"state/i18n-bridge.ts",
				"state/invariants.ts",
				"state/plan.ts",
				"state/replay.ts",
				"state/selectors.ts",
				"state/state-reducer.ts",
				"state/state.ts",
				"state/store.ts",
				"state/task-graph.ts",
				"tool/response-envelope.ts",
				"tool/sanitize.ts",
				"tool/types.ts",
				"view/format.ts",
			],
		},
		include: ["*.test.ts", "state/**/*.test.ts", "tool/**/*.test.ts", "view/**/*.test.ts"],
		setupFiles: ["./.test-support/setup.ts"],
		pool: "forks",
		maxWorkers: 2,
		hookTimeout: 30_000,
		testTimeout: 15_000,
		unstubGlobals: true,
		clearMocks: true,
		restoreMocks: true,
	},
});
