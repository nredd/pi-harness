import { fileURLToPath } from "node:url";
import { definePackageConfig } from "../../scripts/vitest-package.ts";

export default definePackageConfig("todo", {
	provider: "istanbul",
	resolve: {
		alias: {
			"@juicesharp/rpiv-test-utils": fileURLToPath(new URL("./tests/fixtures/upstream/index.ts", import.meta.url)),
		},
	},
	test: {
		include: ["tests/**/*.test.ts"],
		setupFiles: ["./tests/fixtures/setup.ts"],
		pool: "forks",
		maxWorkers: 2,
		hookTimeout: 30_000,
		testTimeout: 15_000,
		unstubGlobals: true,
		clearMocks: true,
		restoreMocks: true,
	},
});
