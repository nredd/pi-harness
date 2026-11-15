import { definePackageConfig } from "../../scripts/vitest-package.ts";

export default definePackageConfig("resource-sampler", {
	provider: "v8",
	test: { maxWorkers: 1 },
});
