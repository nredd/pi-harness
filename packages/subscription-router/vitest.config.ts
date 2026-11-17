import { definePackageConfig } from "../../scripts/vitest-package.ts";

const config = definePackageConfig("subscription-router", {
	provider: "v8",
	test: { maxWorkers: 2 },
});

export default config;
