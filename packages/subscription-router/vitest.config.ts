import { definePackageConfig } from "../../scripts/vitest-package.ts";

export default definePackageConfig("subscription-router", {
	provider: "v8",
	test: { maxWorkers: 2, include: ["tests/*.test.ts", "tests/scenarios/*.test.ts"] },
});
