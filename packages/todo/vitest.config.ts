import { fileURLToPath } from "node:url";
import { definePackageConfig } from "../../scripts/vitest-package.ts";

export default definePackageConfig("todo", {
	provider: "istanbul",
	resolve: {
		alias: {
			"@juicesharp/rpiv-test-utils": fileURLToPath(new URL("./.test-support/upstream/index.ts", import.meta.url)),
		},
	},
	test: {
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
