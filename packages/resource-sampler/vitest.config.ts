import { definePackageConfig } from "../../scripts/vitest-package.ts";

const config = definePackageConfig("resource-sampler", {
	provider: "v8",
	test: { maxWorkers: 1 },
});

export default config;
