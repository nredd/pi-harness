/** Additional fixed inventory for the unreleased core cancellation contract. Run alongside the complete package gate. */
import { definePackageConfig } from "../../scripts/vitest-package.ts";

export default definePackageConfig("subscription-router", {
	provider: "v8",
	reportsDirectory: "coverage/candidate",
	test: {
		maxWorkers: 1,
		include: [
			"tests/acceptance/core-settle-cancellation.test.ts",
			"tests/acceptance/ownership.test.ts",
			"../../integration/inprocess/router-failover.test.ts",
			"../../integration/inprocess/router-ownership.test.ts",
		],
	},
});
