import { definePackageConfig } from "../../scripts/vitest-package.ts";

const config = definePackageConfig("subscription-router", {
	provider: "v8",
	test: { maxWorkers: 2, include: ["tests/*.test.ts", "tests/scenarios/*.test.ts"] },
});

export default config;
