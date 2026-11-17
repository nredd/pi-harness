import { definePackageConfig } from "../../scripts/vitest-package.ts";

const config = definePackageConfig("test-lib", {
	provider: "v8",
	test: {
		pool: "forks",
		maxWorkers: 2,
	},
});

export default config;
