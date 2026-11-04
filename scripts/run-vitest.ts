import { spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const FAILURE_EXIT_STATUS = 1;
const MILLISECONDS_PER_SECOND = 1000;
const TIMING_DECIMAL_PLACES = 2;
// The Bun signal's one instrument: Istanbul, both reporters, independent of the primary report.
const BUN_COVERAGE_ARGS = [
	"--coverage",
	"--coverage.provider=istanbul",
	"--coverage.reporter=text",
	"--coverage.reporter=lcov",
	"--coverage.reportsDirectory=coverage/bun",
];
const COVERAGE_DISABLED_ARG = "--coverage.enabled=false";

/**
 * Turn off jiti's transform cache for test children. Pi's extension loader leaves it at the default,
 * `$TMPDIR/jiti`, keyed by absolute path and never evicted, so every fixture extension a test writes
 * into a fresh mkdtemp dir would add a file there for good. jiti 2.7 reads this variable as a boolean
 * only, so a per-run cache path is not an option.
 */
const TEST_JITI_ENV = { JITI_FS_CACHE: "false" } as const;

/** Every home-derived variable a Vitest child must not inherit; one place for each new guarded var. */
export function isolatedHomeEnv(home: string): Record<string, string> {
	return {
		HOME: home,
		USERPROFILE: home,
		XDG_CONFIG_HOME: join(home, ".config"),
		PI_CODING_AGENT_DIR: join(home, ".pi", "agent"),
		PI_SUBAGENTS_CONFIG_DIR: join(home, ".pi", "agent"),
	};
}

// Isolate before imports: Bun caches os.homedir(), and Pi can read global model policy.
if (import.meta.main) {
	const [, , engine, ...packageArgs] = process.argv;
	if (engine !== "bun" && engine !== "node") throw new Error("Expected engine: node or bun");
	// A canary that disables coverage must not overwrite another signal's report. Only this exact
	// argument opts out; every current canary passes it verbatim (subagents, session-kit, plan-mode, dev-tools).
	const vitestArgs =
		engine === "bun" && !packageArgs.includes(COVERAGE_DISABLED_ARG)
			? [...packageArgs, ...BUN_COVERAGE_ARGS]
			: packageArgs;
	const home = mkdtempSync(join(tmpdir(), "pi-bun-vitest-"));
	const start = performance.now();
	let status = FAILURE_EXIT_STATUS;
	try {
		const result = spawnSync(
			engine === "node" ? process.execPath : "bun",
			[
				...(engine === "bun" ? ["--bun"] : []),
				fileURLToPath(new URL("../node_modules/vitest/vitest.mjs", import.meta.url)),
				"run",
				...vitestArgs,
			],
			{ stdio: "inherit", env: { ...process.env, ...isolatedHomeEnv(home), ...TEST_JITI_ENV } },
		);
		if (result.error) throw result.error;
		status = result.status ?? FAILURE_EXIT_STATUS;
	} finally {
		rmSync(home, { recursive: true, force: true });
		const timing = `${process.platform} | ${basename(process.cwd())} | ${((performance.now() - start) / MILLISECONDS_PER_SECOND).toFixed(TIMING_DECIMAL_PLACES)} s | exit ${status}`;
		console.log(`${engine} Vitest timing: ${timing}`);
		if (process.env.GITHUB_STEP_SUMMARY)
			appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n${engine} Vitest timing: ${timing}\n`);
	}
	process.exitCode = status;
}
