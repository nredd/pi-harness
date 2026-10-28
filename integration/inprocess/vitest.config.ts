import { defineConfig } from "vitest/config";

// Match dev-tools: extensions run on the main thread in Pi, never a worker thread.
export default defineConfig({
	test: {
		pool: "forks",
		maxWorkers: 2,
		testTimeout: 20_000,
		setupFiles: ["./verification/home-setup.ts"],
	},
});
