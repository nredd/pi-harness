import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

const {
	owned,
	exclusions,
}: { owned: string[]; exclusions: { path: string }[] } = JSON.parse(
	readFileSync(new URL("../../coverage/policy.json", import.meta.url), "utf8"),
).packages["computer-use-vitest"];

export default defineConfig({
	test: {
		dir: "test",
		// The suites came from `node --test` and chained `node`/`tsx` scripts, which ran one at a time.
		// Keep that: real process groups, Swift/cargo builds and git fixtures share the host. Forks like
		// `dev-tools`, one worker like `resource-sampler`.
		pool: "forks",
		maxWorkers: 1,
		// The `dev-tools` default. Slowest warm case on an M-series Mac is ~10.1 s (`async` signal
		// observer). The two `async` cases that wait out TERM/KILL escalation, the two cold-cache
		// `swiftc` invariants (INV-8, INV-17) and the `macos-native-pure` Swift compile carry their
		// own derived budgets.
		testTimeout: 20_000,
		setupFiles: ["../../integration/inprocess/verification/home-setup.ts"],
		// `istanbul` like the other Pi-loading packages; report-only, see `coverage/policy.json`.
		coverage: {
			provider: "istanbul",
			reporter: ["text", "lcov"],
			reportsDirectory: "coverage/primary",
			reportOnFailure: true,
			include: owned,
			exclude: exclusions.map(({ path }) => path),
		},
	},
});
