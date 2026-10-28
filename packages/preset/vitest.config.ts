import { defineConfig } from "vitest/config";

// Interactive theme/keybinding state is process-global; keep hosts serial per worker.
export default defineConfig({
	test: {
		coverage: {
			provider: "istanbul",
			reporter: ["text", "lcov"],
			reportsDirectory: "coverage/primary",
			reportOnFailure: true,
			include: ["extensions/expanded-footer.ts", "lib/footer-cache.ts", "lib/footer-quota.ts"],
		},
		pool: "forks",
		maxWorkers: 2,
		testTimeout: 20_000,
		setupFiles: ["../../integration/inprocess/verification/home-setup.ts"],
	},
});
