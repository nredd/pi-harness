import { definePackageConfig } from "../../scripts/vitest-package.ts";

export default definePackageConfig("test-lib", {
	provider: "v8",
	test: {
		pool: "forks",
		maxWorkers: 2,
	},
});
