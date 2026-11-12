import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

// `computer-use-vitest`: the JS/TS runtime slice these suites measure; `computer-use` also inventories native and docs source.
const {
	owned,
	exclusions,
}: { owned: string[]; exclusions: { path: string }[] } = JSON.parse(
	readFileSync(new URL("../../coverage/policy.json", import.meta.url), "utf8"),
).packages["computer-use-vitest"];

/**
 * Files already at 0 uncovered lines, functions and branches on every OS (#645 T0). The policy schema has
 * no per-file pins, so Vitest enforces them: any regression fails `npm test` even inside the aggregate cap.
 */
const ZERO_UNCOVERED_FILES = [
	"scripts/build-native.mjs",
	"scripts/docs-generators/generate-source-references.mjs",
	"scripts/docs-generators/generate-tool-reference.mjs",
	"scripts/rust-coverage.mjs",
	"scripts/setup-helper.mjs",
	"src/bridge.ts",
	"src/outline-store.ts",
	"src/outline.ts",
	"src/platform/macos/helper-path.mjs",
	"src/platform/macos/helper.ts",
];

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
		// `istanbul` like the other Pi-loading packages; caps in `coverage/policy.json`.
		coverage: {
			provider: "istanbul",
			reporter: ["text", "lcov"],
			reportsDirectory: "coverage/primary",
			reportOnFailure: true,
			include: owned,
			exclude: exclusions.map(({ path }) => path),
			thresholds: {
				// The aggregate policy does not yet account statements (#742).
				statements: 100,
				...Object.fromEntries(
					ZERO_UNCOVERED_FILES.map((path) => [path, { lines: 100, functions: 100, branches: 100 }]),
				),
			},
		},
	},
});
