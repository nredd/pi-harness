import { definePackageConfig } from "../../scripts/vitest-package.ts";

// forks, not threads: same reason as pi-dev-tools (extension timers stall under the threads pool).
export default definePackageConfig("session-kit", {
	provider: "v8",
	test: {
		server: { deps: { inline: ["@nredd/pi-resource-sampler"] } },
		pool: "forks",
		maxWorkers: 2,
		testTimeout: 20_000,
	},
});
