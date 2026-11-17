import { definePackageConfig } from "../../scripts/vitest-package.ts";

// Additional fixed inventory for the unreleased core cancellation contract. Run alongside the complete package gate.
// A named initializer, not `export default <call>`: Istanbul only counts executable statements it can name.
const config = definePackageConfig("subscription-router", {
	provider: "v8",
	reportsDirectory: "coverage/candidate",
	test: {
		maxWorkers: 1,
		include: [
			"tests/acceptance/core-settle-cancellation.test.ts",
			"tests/acceptance/ownership.test.ts",
			"../../tests/inprocess/router-failover.test.ts",
			"../../tests/inprocess/router-ownership.test.ts",
		],
	},
});

export default config;
