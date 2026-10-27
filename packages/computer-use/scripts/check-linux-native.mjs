#!/usr/bin/env node
// Headless Linux native checks: the crate's own cargo tests, the source build from the PACKED tarball
// into a user-writable target dir, the built helper's real `diagnostics` contract, compiler cleanup and
// the cargo-missing hint. Needs a Linux host with cargo; elsewhere it prints NOT RUN (not a pass).
// No display, desktop, screenshot or live-UI probe runs here (see check-linux-live.mjs for those).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	finishCheckCleanup,
	SIGNAL_READINESS_POLL_MS as POLL_INTERVAL_MS,
	PARENT_READINESS_TIMEOUT_MS as READINESS_TIMEOUT_MS,
	runCheckCommand,
	stopCheckChild,
	within,
	writeSignalReadinessObserver,
} from "./check-async.mjs";

const SETUP_COMPLETION_TIMEOUT_MS = 30_000;
const SOURCE_BUILD_TIMEOUT_MS = 15 * 60 * 1000;
const CANCELLATION_BACKSTOP_MS = 10_000;
const COMPILER_EXIT_TIMEOUT_MS = 5000;
const DIAGNOSTICS_TIMEOUT_MS = 10_000;
const FAKE_COMPILER_LIFETIME_SECONDS = 300;
const CARGO_TEST_TIMEOUT_MS = 15 * 60 * 1000;
const ARM64_CHECK_TIMEOUT_MS = 15 * 60 * 1000;
const PACKAGE_PACK_TIMEOUT_MS = 2 * 60 * 1000;
const ARCHIVE_EXTRACT_TIMEOUT_MS = 60_000;
const PERMISSION_CHANGE_TIMEOUT_MS = 30_000;
const NATIVE_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

if (process.platform !== "linux") {
	console.log(
		`Linux native checks NOT RUN: host is ${process.platform}; cargo tests, packed-source build and helper diagnostics need Linux. This is not a pass.`,
	);
	process.exit(0);
}

const rootDir = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);
const crateManifest = path.join(
	rootDir,
	"native",
	"linux",
	"bridge-rs",
	"Cargo.toml",
);
const work = await fs.mkdtemp(
	path.join(os.tmpdir(), "pi-computer-use-linux-native-"),
);
const archName = { x64: "x86_64", arm64: "aarch64" }[process.arch];
assert.ok(archName, `unsupported host architecture ${process.arch}`);

/**
 * Start the real setup CLI with optional test-only signal-registration observation.
 * @param {string} packageDir Packed package containing the production setup script.
 * @param {NodeJS.ProcessEnv} env Child environment, including fixture paths.
 * @param {string[]} [extraArgs=[]] Additional production CLI arguments.
 * @param {string} [observer] Test-only Node preload; never modifies production handlers.
 * @returns {{child: import('node:child_process').ChildProcess, done: Promise<object>, closed: Promise<void>, capture: {output: string}}} Child, outcomes and live diagnostic capture.
 * @throws {Error} Spawn errors reject `done`.
 */
function startSetup(packageDir, env, extraArgs = [], observer) {
	const child = spawn(
		process.execPath,
		[
			...(observer ? ["--import", observer] : []),
			path.join(packageDir, "scripts", "setup-helper.mjs"),
			"--platform",
			"linux",
			...extraArgs,
		],
		{ env, stdio: ["ignore", "pipe", "pipe"] },
	);
	const capture = { output: "" };
	child.stdout.on("data", (chunk) => {
		capture.output += chunk;
	});
	child.stderr.on("data", (chunk) => {
		capture.output += chunk;
	});
	const closed = new Promise((resolve) => child.once("close", () => resolve()));
	const done = new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (code, signal) =>
			resolve({ code, signal, output: capture.output }),
		);
	});
	return { child, done, closed, capture };
}

/**
 * Await setup completion with a contextual deadline and bounded cancellation on failure.
 * @param {string} packageDir Packed package containing the production CLI.
 * @param {NodeJS.ProcessEnv} env Child environment.
 * @param {string[]} [extraArgs=[]] Additional CLI arguments.
 * @param {number} [timeoutMs=SETUP_COMPLETION_TIMEOUT_MS] Completion budget, in milliseconds.
 * @returns {Promise<object>} Captured setup exit status and output.
 * @throws {Error} If setup cannot spawn or close before its deadline.
 * @throws {AggregateError} If setup and its bounded cancellation cleanup both fail.
 */
async function runSetup(
	packageDir,
	env,
	extraArgs = [],
	timeoutMs = SETUP_COMPLETION_TIMEOUT_MS,
) {
	const { child, done, closed } = startSetup(packageDir, env, extraArgs);
	try {
		return await within(
			done,
			`Linux setup ${extraArgs.join(" ")} in ${packageDir} to close`,
			timeoutMs,
		);
	} catch (error) {
		try {
			await stopCheckChild(child, closed, "timed-out Linux setup");
		} catch (cleanupError) {
			throw new AggregateError(
				[error, cleanupError],
				"Linux setup completion and bounded cleanup failed",
			);
		}
		throw error;
	}
}

/**
 * Observe a process-owned PID marker published only after fixture signal readiness.
 * @param {string} file Marker written by the compiler, leader or setup observer.
 * @returns {Promise<number>} Valid positive PID contained in the marker.
 * @throws {Error} If no valid PID becomes observable before the readiness deadline.
 */
async function waitForReadyPid(file) {
	for (
		const deadline = Date.now() + READINESS_TIMEOUT_MS;
		Date.now() < deadline;
	) {
		const pid = Number(await fs.readFile(file, "utf8").catch(() => ""));
		if (Number.isInteger(pid) && pid > 0) return pid;
		await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
	}
	throw new Error(
		`Timed out waiting for compiler/setup fixture signal readiness: ${file}`,
	);
}

/**
 * Write an executable fake cargo into a disposable fixture directory.
 * @param {string} dir Fixture PATH directory.
 * @param {string} body Shell program after the shebang.
 * @returns {Promise<void>} Completion of directory/file creation.
 * @throws {Error} Propagates filesystem write errors.
 */
async function writeFakeCargo(dir, body) {
	await fs.mkdir(dir, { recursive: true });
	await fs.writeFile(path.join(dir, "cargo"), `#!/bin/sh\n${body}\n`, {
		mode: 0o755,
	});
}

let nativeFailure;
try {
	// 1. Crate unit/integration tests, built outside the source tree.
	await runCheckCommand(
		"cargo",
		[
			"test",
			"--locked",
			"--manifest-path",
			crateManifest,
			"--target-dir",
			path.join(work, "test-target"),
		],
		{
			label: "locked native cargo tests",
			timeoutMs: CARGO_TEST_TIMEOUT_MS,
			maxBuffer: NATIVE_MAX_OUTPUT_BYTES,
		},
	);
	console.log("cargo test --locked passed");

	// 2. Pack the real tarball and extract it read-only: the build must not write into the npm install.
	const { stdout } = await runCheckCommand(
		"npm",
		["pack", "--ignore-scripts", "--silent", "--pack-destination", work],
		{
			label: "native package npm pack",
			timeoutMs: PACKAGE_PACK_TIMEOUT_MS,
			cwd: rootDir,
		},
	);
	const tarball = path.join(
		work,
		stdout
			.trim()
			.split("\n")
			.reverse()
			.find((line) => line.endsWith(".tgz")),
	);
	const extractDir = path.join(work, "extract");
	await fs.mkdir(extractDir);
	await runCheckCommand("tar", ["-xzf", tarball, "-C", extractDir], {
		label: "native package extraction",
		timeoutMs: ARCHIVE_EXTRACT_TIMEOUT_MS,
	});
	const packageDir = path.join(extractDir, "package");
	await runCheckCommand("chmod", ["-R", "a-w", packageDir], {
		label: "make packed native sources read-only",
		timeoutMs: PERMISSION_CHANGE_TIMEOUT_MS,
	});

	// 3. Compiler-facing contract with a fake cargo: argv, user cache target dir, install, cargo-missing hint, cleanup.
	const base = { ...process.env, PI_COMPUTER_USE_ALLOW_BUILD: "" };
	{
		const cache = path.join(work, "fake-cache");
		const helper = path.join(work, "fake-helper", "linux-bridge");
		const fakeBin = path.join(work, "fake-bin");
		await writeFakeCargo(
			fakeBin,
			`echo "$@" > "${path.join(work, "cargo-argv")}"
while [ $# -gt 0 ]; do [ "$1" = --target-dir ] && target="$2"; shift; done
mkdir -p "$target/release" && printf '#!/bin/sh\\n' > "$target/release/linux-bridge" && chmod 755 "$target/release/linux-bridge"`,
		);
		const env = {
			...base,
			XDG_CACHE_HOME: cache,
			PI_COMPUTER_USE_LINUX_HELPER_PATH: helper,
			PATH: `${fakeBin}:/usr/bin:/bin`,
		};
		const result = await runSetup(packageDir, env, ["--allow-build"]);
		assert.equal(result.code, 0, result.output);
		const argv = (
			await fs.readFile(path.join(work, "cargo-argv"), "utf8")
		).trim();
		const targetDir = path.join(
			cache,
			"pi-computer-use",
			"linux-bridge-target",
		);
		assert.match(
			argv,
			/^build --locked --release --manifest-path \S+native\/linux\/bridge-rs\/Cargo\.toml --target-dir /,
		);
		assert.ok(argv.endsWith(`--target-dir ${targetDir}`), argv);
		assert.ok(
			(await fs.stat(helper)).mode & 0o100,
			"helper installed executable",
		);
	}
	{
		const empty = path.join(work, "empty-bin");
		await fs.mkdir(empty);
		const result = await runSetup(
			packageDir,
			{
				...base,
				XDG_CACHE_HOME: path.join(work, "c2"),
				PI_COMPUTER_USE_LINUX_HELPER_PATH: path.join(
					work,
					"never",
					"linux-bridge",
				),
				PATH: empty,
			},
			["--allow-build"],
		);
		assert.equal(result.code, 1);
		assert.match(
			result.output,
			/'cargo' was not found on PATH\. Install the Rust toolchain \(https:\/\/rustup\.rs\)/,
		);
		assert.doesNotMatch(
			result.output,
			/prebuilt\/linux/,
			"no package ships a Linux prebuilt; the hint must not suggest one",
		);
		assert.equal(
			await fs.stat(path.join(work, "never")).then(
				() => true,
				() => false,
			),
			false,
			"no helper written when cargo is missing",
		);
	}
	{
		const fakeBin = path.join(work, "slow-bin");
		const pidFile = path.join(work, "compiler.pid");
		// Publish each PID only after installing its signal disposition. The descendant's ignored
		// TERM survives exec; a parent-side $! alone would race the child's trap installation.
		const leaderFile = path.join(work, "cargo-ready.pid");
		await writeFakeCargo(
			fakeBin,
			`trap 'exit 0' TERM
sh -c 'trap "" TERM; echo $$ > "${pidFile}"; exec sleep ${FAKE_COMPILER_LIFETIME_SECONDS}' &
echo $$ > "${leaderFile}"
wait`,
		);
		const env = {
			...base,
			XDG_CACHE_HOME: path.join(work, "c3"),
			PI_COMPUTER_USE_LINUX_HELPER_PATH: path.join(
				work,
				"slow",
				"linux-bridge",
			),
			PATH: `${fakeBin}:/usr/bin:/bin`,
		};
		const setupReady = path.join(work, "setup-ready.pid");
		const observer = path.join(work, "setup-observer.mjs");
		await writeSignalReadinessObserver(observer, setupReady);
		const {
			child: setupChild,
			done,
			capture,
		} = startSetup(packageDir, env, ["--allow-build"], observer);
		let compilerReaped = false;
		try {
			const [compilerPid, , wrapperPid] = await Promise.all([
				waitForReadyPid(pidFile),
				waitForReadyPid(leaderFile),
				Promise.race([
					waitForReadyPid(setupReady).catch((error) => {
						throw new Error(`${error.message}\n${capture.output}`, {
							cause: error,
						});
					}),
					done.then((result) => {
						throw new Error(
							`Packed setup closed before wrapper readiness: ${result.output}`,
						);
					}),
				]),
			]);
			assert.equal(
				wrapperPid,
				setupChild.pid,
				"packed setup handlers must be live before TERM",
			);
			process.kill(compilerPid, 0); // compiler child alive after its TERM disposition is ready
			setupChild.kill("SIGTERM");
			const finished = await within(
				done,
				"packed setup to close after compiler cancellation",
				CANCELLATION_BACKSTOP_MS,
			);
			assert.equal(finished.code, 143, finished.output);
			let alive = true;
			for (
				const deadline = Date.now() + COMPILER_EXIT_TIMEOUT_MS;
				alive && Date.now() < deadline;
			) {
				try {
					process.kill(compilerPid, 0);
					await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
				} catch (error) {
					assert.equal(error.code, "ESRCH");
					alive = false;
				}
			}
			assert.equal(
				alive,
				false,
				"SIGTERM to setup must reap the compiler process group",
			);
			compilerReaped = true;
		} finally {
			setupChild.kill("SIGKILL");
			// Successful cancellation releases PID ownership; cleanup only a failed fixture.
			for (const file of compilerReaped ? [] : [leaderFile, pidFile]) {
				const pid = Number(await fs.readFile(file, "utf8").catch(() => ""));
				if (pid > 0) {
					try {
						if (file === leaderFile) process.kill(-pid, "SIGKILL");
					} catch {
						/* already gone */
					}
					try {
						process.kill(pid, "SIGKILL");
					} catch {
						/* already gone */
					}
				}
			}
		}
	}

	// 4. REAL build from the packed source, then the real helper's diagnostics through the TS client.
	const cache = path.join(work, "real-cache");
	const helper = path.join(work, "real-helper", "linux-bridge");
	const real = await runSetup(
		packageDir,
		{
			...process.env,
			PI_COMPUTER_USE_ALLOW_BUILD: "",
			XDG_CACHE_HOME: cache,
			PI_COMPUTER_USE_LINUX_HELPER_PATH: helper,
		},
		["--allow-build"],
		SOURCE_BUILD_TIMEOUT_MS,
	);
	assert.equal(real.code, 0, real.output);
	assert.ok(
		await fs.stat(
			path.join(
				cache,
				"pi-computer-use",
				"linux-bridge-target",
				"release",
				"linux-bridge",
			),
		),
		"built into the user cache",
	);
	assert.equal(
		await fs
			.stat(path.join(packageDir, "native", "linux", "bridge-rs", "target"))
			.then(
				() => true,
				() => false,
			),
		false,
		"no target/ inside the package",
	);
	const { LinuxHelperClient } = await import("../src/platform/linux/helper.ts");
	const failingSetup = path.join(work, "must-not-run.cjs");
	await fs.writeFile(failingSetup, "process.exit(99);\n");
	const client = new LinuxHelperClient({
		helperPath: helper,
		setupHelperScript: failingSetup,
	});
	try {
		const diagnostics = await client.command(
			"diagnostics",
			{},
			{ timeoutMs: DIAGNOSTICS_TIMEOUT_MS },
		);
		assert.equal(diagnostics.protocolVersion, 4);
		assert.equal(diagnostics.os, "linux");
		assert.equal(diagnostics.arch, archName);
		assert.equal(diagnostics.architectureVersion, 1);
	} finally {
		client.dispose();
	}
	console.log(
		`packed-source build and helper diagnostics passed (${archName}, headless)`,
	);

	// 5. ARM64 is compile-only: no runtime claim. CI opts in after `rustup target add`.
	if (process.env.PI_CU_LINUX_ARM64_CHECK === "1") {
		await runCheckCommand(
			"cargo",
			[
				"check",
				"--locked",
				"--target",
				"aarch64-unknown-linux-gnu",
				"--manifest-path",
				crateManifest,
				"--target-dir",
				path.join(work, "arm64-target"),
			],
			{
				label: "ARM64 native compile-only cargo check",
				timeoutMs: ARM64_CHECK_TIMEOUT_MS,
				maxBuffer: NATIVE_MAX_OUTPUT_BYTES,
			},
		);
		console.log(
			"aarch64-unknown-linux-gnu cargo check --locked passed (compile-only; ARM64 runtime NOT RUN)",
		);
	} else {
		console.log(
			"aarch64-unknown-linux-gnu compile check NOT RUN (set PI_CU_LINUX_ARM64_CHECK=1 with the rustup target installed)",
		);
	}
	console.log("Linux native checks passed");
} catch (error) {
	nativeFailure = error;
	throw error;
} finally {
	await finishCheckCleanup(
		"native check cleanup",
		[
			() =>
				runCheckCommand("chmod", ["-R", "u+w", work], {
					label: "restore native scratch permissions",
					timeoutMs: PERMISSION_CHANGE_TIMEOUT_MS,
				}),
			() => fs.rm(work, { recursive: true, force: true }),
		],
		nativeFailure,
	);
}
