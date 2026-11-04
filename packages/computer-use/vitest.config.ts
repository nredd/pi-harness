import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		dir: "test",
		// The suites came from `node --test` and chained `node`/`tsx` scripts, which ran one at a time
		// with no per-test deadline. Keep both: real process groups, Swift/cargo builds and git
		// fixtures share the host, and every suite carries its own bounded waits.
		fileParallelism: false,
		testTimeout: 0,
		setupFiles: ["../../integration/inprocess/verification/home-setup.ts"],
		// `istanbul` like the other Pi-loading packages; report-only, see `coverage/policy.json`.
		coverage: {
			provider: "istanbul",
			reporter: ["text", "lcov"],
			reportsDirectory: "coverage/primary",
			reportOnFailure: true,
			include: [
				"extensions/computer-use.ts",
				"scripts/build-native.mjs",
				"scripts/docs-generators/generate-source-references.mjs",
				"scripts/docs-generators/generate-tool-reference.mjs",
				"scripts/rust-coverage.mjs",
				"scripts/setup-helper.mjs",
				"src/actions.ts",
				"src/bridge.ts",
				"src/cdp.ts",
				"src/config.ts",
				"src/contract.ts",
				"src/desktop.ts",
				"src/find-params.ts",
				"src/note.ts",
				"src/outline.ts",
				"src/output.ts",
				"src/permissions.ts",
				"src/platform/architecture.ts",
				"src/platform/coerce.ts",
				"src/platform/index.ts",
				"src/platform/linux/backend.ts",
				"src/platform/linux/helper.ts",
				"src/platform/macos/backend.ts",
				"src/platform/macos/browser.ts",
				"src/platform/macos/helper-path.mjs",
				"src/platform/macos/helper.ts",
				"src/platform/macos/permissions.ts",
				"src/platform/windows/backend.ts",
				"src/platform/windows/helper.ts",
				"src/root-selection.ts",
				"src/runtime.ts",
				"src/state.ts",
				"src/view.ts",
			],
		},
	},
});
