import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ViteUserConfig } from "vitest/config";
import { defineConfig } from "vitest/config";

/** The home guard every suite runs behind: it fails a test that changes or reads the real home. */
const HOME_GUARD = fileURLToPath(new URL("../tests/lib/src/home-setup.ts", import.meta.url));
const POLICY = new URL("../coverage/policy.json", import.meta.url);

type TestOptions = NonNullable<ViteUserConfig["test"]>;

/** The `coverage/policy.json` entry fields a Vitest producer measures. */
interface PolicyEntry {
	owned: string[];
	exclusions: { path: string }[];
}

export interface PackageConfigOptions extends Omit<ViteUserConfig, "test"> {
	/** Coverage provider. Explicit on purpose: `istanbul` and `v8` are both in use, see `packages/subagents/vitest.config.ts`. */
	provider: "istanbul" | "v8";
	/** Where the reports go, relative to the Vitest root. Default `coverage/primary`. */
	reportsDirectory?: string;
	/** Put the home guard first in `setupFiles`. Default true; only a producer that never touches a home opts out. */
	homeGuard?: boolean;
	/** The package's own options (`pool`, `maxWorkers`, `testTimeout`, `server.deps`, `runner`, ...). `coverage` is merged over the shared block. */
	test: TestOptions;
}

/**
 * Build one package's Vitest configuration from its `coverage/policy.json` signal.
 *
 * The factory owns what every producer repeats: the owned inventory and exclusions, the three reporters,
 * `reportOnFailure`, the report directory and the home guard. Everything else, with its comment, stays in
 * the package config and is merged as given.
 *
 * @param signal The `coverage/policy.json` package key whose `owned` and `exclusions` the run measures.
 * @param options The provider, report directory and the package's own Vitest options.
 * @returns A Vitest configuration.
 * @throws TypeError When the policy has no entry for `signal`.
 */
export function definePackageConfig(
	signal: string,
	{ provider, reportsDirectory = "coverage/primary", homeGuard = true, test, ...config }: PackageConfigOptions,
): ViteUserConfig {
	const { owned, exclusions }: PolicyEntry = JSON.parse(readFileSync(POLICY, "utf8")).packages[signal];
	const { coverage, setupFiles = [], ...rest } = test;
	const setup = [...(homeGuard ? [HOME_GUARD] : []), ...[setupFiles].flat()];
	return defineConfig({
		...config,
		test: {
			...rest,
			...(setup.length > 0 ? { setupFiles: setup } : {}),
			coverage: {
				provider,
				reporter: ["text", "lcov", "json-summary"],
				reportsDirectory,
				reportOnFailure: true,
				include: owned,
				exclude: exclusions.map(({ path }) => path),
				...coverage,
			},
		},
	});
}
