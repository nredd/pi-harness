import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		dir: "test",
		// The suites came from `node --test` and chained `node`/`tsx` scripts, which ran one at a time.
		// Keep that: real process groups, Swift/cargo builds and git fixtures share the host. Forks like
		// `dev-tools`, one worker like `resource-sampler`.
		pool: "forks",
		maxWorkers: 1,
		// The `dev-tools` default. Slowest warm case on an M-series Mac is ~10.1 s (`async` signal
		// observer). The two `async` cases that wait out TERM/KILL escalation and the two cold-cache
		// `swiftc` invariants (INV-8, INV-17) carry their own derived budgets.
		testTimeout: 20_000,
		setupFiles: ["../../integration/inprocess/verification/home-setup.ts"],
		// `istanbul` like the other Pi-loading packages; report-only, see `coverage/policy.json`.
		coverage: {
			provider: "istanbul",
			reporter: ["text", "lcov"],
			reportsDirectory: "coverage/primary",
			reportOnFailure: true,
			// Globs mirror the policy `owned` set so a new module cannot drop out of the report.
			include: [
				"extensions/**/*.ts",
				"scripts/build-native.mjs",
				"scripts/docs-generators/*.mjs",
				"scripts/rust-coverage.mjs",
				"scripts/setup-helper.mjs",
				"src/**/*.mjs",
				"src/**/*.ts",
			],
			// Type-only declarations; matches the policy exclusion.
			exclude: ["src/platform/types.ts"],
		},
	},
});
