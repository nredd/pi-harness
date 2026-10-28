import { defineConfig } from "vitest/config";

// Interactive theme/keybinding state is process-global; keep hosts serial per worker.
export default defineConfig({
	test: {
		pool: "forks",
		maxWorkers: 2,
		testTimeout: 20_000,
		setupFiles: ["../../integration/inprocess/verification/home-setup.ts"],
	},
});
