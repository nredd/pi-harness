import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isolatedHomeEnv } from "../tests/lib/src/isolated-home.ts";

const FAILURE_EXIT_STATUS = 1;
const MILLISECONDS_PER_SECOND = 1000;
const TIMING_DECIMAL_PLACES = 2;
const CLEANUP_RETRIES = 1;
// Activation goes FIRST: Vitest's CLI parser turns a bare `--coverage` into `{ enabled: true }` and drops any
// `--coverage.*` field parsed before it, so a caller's own reporter would be erased if it came after.
const BUN_COVERAGE_ACTIVATION = "--coverage";
// The Bun signal's one instrument, placed after the caller's arguments so they cannot weaken it: Istanbul,
// both reporters, independent of the primary report. A caller's extra reporters merge with these.
const BUN_COVERAGE_ARGS = [
	"--coverage.provider=istanbul",
	"--coverage.reporter=text",
	"--coverage.reporter=lcov",
	"--coverage.reporter=json-summary",
];
// Set for every Bun child so a suite can assert it really runs on the pinned Bun, not a Node fallback.
const BUN_RUNTIME_ENV = { PI_EXPECT_BUN_RUNTIME: "1" } as const;
const COVERAGE_DISABLED_ARG = "--coverage.enabled=false";

/**
 * Turn off jiti's transform cache for test children. Pi's extension loader leaves it at the default,
 * `$TMPDIR/jiti`, keyed by absolute path and never evicted, so every fixture extension a test writes
 * into a fresh mkdtemp dir would add a file there for good. jiti 2.7 reads this variable as a boolean
 * only, so a per-run cache path is not an option.
 */
const TEST_JITI_ENV = { JITI_FS_CACHE: "false" } as const;

/**
 * Pin the Rust toolchain homes to the account's before HOME is isolated. rustup's `cargo` proxy and
 * `cargo nextest` resolve `$HOME/.rustup` and `$HOME/.cargo` when these are unset, so a disposable
 * HOME would make them fail and silently skip every real-toolchain suite (dev-tools' cargo tools).
 * Explicit values win; the account home comes from the passwd entry, not a possibly isolated HOME.
 */
export function toolchainHomeEnv(env: NodeJS.ProcessEnv): Record<string, string> {
	const account = userInfo().homedir;
	return {
		CARGO_HOME: env.CARGO_HOME ?? join(account, ".cargo"),
		RUSTUP_HOME: env.RUSTUP_HOME ?? join(account, ".rustup"),
	};
}

/**
 * Run Vitest once under `engine` with a disposable home and temp directory, then remove both.
 *
 * The child gets the home before any import: Bun caches `os.homedir()`, and Pi can read global model
 * policy. A run that disables coverage must not overwrite another signal's report, so only the
 * exact `--coverage.enabled=false` argument opts out of the Bun signal's appended coverage arguments.
 * Bun children also get `PI_EXPECT_BUN_RUNTIME=1`, which a suite may check to prove its engine.
 *
 * @param argv The engine (`node` or `bun`), optional `--keep-home` for operator-backed commands,
 *   optional `bench` command (default: `run`), then Vitest arguments.
 * @param env The environment the child inherits under the isolated home; also where
 *   `GITHUB_STEP_SUMMARY` is read.
 * @returns The child's exit status, or 1 when it was killed by a signal.
 * @throws When the engine is neither `node` nor `bun`, or the child cannot be spawned.
 */
export function main(argv: readonly string[], env: NodeJS.ProcessEnv): number {
	const [engine, ...args] = argv;
	if (engine !== "bun" && engine !== "node") throw new Error("Expected engine: node or bun");
	const keepHome = args[0] === "--keep-home";
	if (keepHome) args.shift();
	const command = args[0] === "bench" ? "bench" : "run";
	const packageArgs = command === "bench" ? args.slice(1) : args;
	const directory =
		[...packageArgs].reverse().find((arg) => arg.startsWith("--coverage.reportsDirectory=")) ??
		"--coverage.reportsDirectory=coverage/bun";
	const vitestArgs =
		engine === "bun" && command === "run" && !packageArgs.includes(COVERAGE_DISABLED_ARG)
			? [
					BUN_COVERAGE_ACTIVATION,
					...packageArgs.filter(
						(arg) => arg !== BUN_COVERAGE_ACTIVATION && !arg.startsWith("--coverage.reportsDirectory="),
					),
					...BUN_COVERAGE_ARGS,
					directory,
				]
			: packageArgs;
	const sandbox = mkdtempSync(join(tmpdir(), "pi-vt-"));
	const start = performance.now();
	let status = FAILURE_EXIT_STATUS;
	try {
		const home = join(sandbox, "home");
		const temp = join(sandbox, "tmp");
		if (!keepHome) mkdirSync(home);
		mkdirSync(temp);
		const result = spawnSync(
			engine === "node" ? process.execPath : "bun",
			[
				...(engine === "bun" ? ["--bun"] : []),
				fileURLToPath(new URL("../node_modules/vitest/vitest.mjs", import.meta.url)),
				command,
				...vitestArgs,
			],
			{
				stdio: "inherit",
				env: {
					...env,
					...(engine === "bun" ? BUN_RUNTIME_ENV : {}),
					...(keepHome ? {} : { ...toolchainHomeEnv(env), ...isolatedHomeEnv(home) }),
					...TEST_JITI_ENV,
					// Node, Bun and child tools use different precedence across platforms.
					TMPDIR: temp,
					TMP: temp,
					TEMP: temp,
				},
			},
		);
		if (result.error) throw result.error;
		status = result.status ?? FAILURE_EXIT_STATUS;
	} finally {
		try {
			rmSync(sandbox, { recursive: true, force: true, maxRetries: CLEANUP_RETRIES });
		} catch (error) {
			console.warn(`Could not remove Vitest sandbox ${sandbox}:`, error);
		}
		const timing = `${process.platform} | ${basename(process.cwd())} | ${((performance.now() - start) / MILLISECONDS_PER_SECOND).toFixed(TIMING_DECIMAL_PLACES)} s | exit ${status}`;
		console.log(`${engine} Vitest timing: ${timing}`);
		if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `\n${engine} Vitest timing: ${timing}\n`);
	}
	return status;
}

/** Dispatch only when invoked as the entry module. */
export function dispatch(isMain: boolean): void {
	if (isMain) process.exitCode = main(process.argv.slice(2), process.env);
}

dispatch(import.meta.main);
