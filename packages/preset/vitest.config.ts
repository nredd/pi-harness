import { definePackageConfig } from "../../scripts/vitest-package.ts";

// Interactive theme/keybinding state is process-global; keep hosts serial per worker.
export default definePackageConfig("preset", {
	provider: "istanbul",
	test: {
		pool: "forks",
		maxWorkers: 2,
		testTimeout: 20_000,
	},
});
