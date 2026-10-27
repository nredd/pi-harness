#!/usr/bin/env node
// Headless Linux native checks: the crate's own cargo tests, the source build from the PACKED tarball
// into a user-writable target dir, the built helper's real `diagnostics` contract, compiler cleanup and
// the cargo-missing hint. Needs a Linux host with cargo; elsewhere it prints NOT RUN (not a pass).
// No display, desktop, screenshot or live-UI probe runs here (see check-linux-live.mjs for those).
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

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

/** Start setup-helper.mjs from `packageDir` like Pi does (`--platform linux`); `done` resolves with the outcome. */
function startSetup(packageDir, env, extraArgs = []) {
	const child = spawn(
		process.execPath,
		[
			path.join(packageDir, "scripts", "setup-helper.mjs"),
			"--platform",
			"linux",
			...extraArgs,
		],
		{ env, stdio: ["ignore", "pipe", "pipe"] },
	);
	let output = "";
	child.stdout.on("data", (chunk) => {
		output += chunk;
	});
	child.stderr.on("data", (chunk) => {
		output += chunk;
	});
	const done = new Promise((resolve) =>
		child.on("close", (code, signal) => resolve({ code, signal, output })),
	);
	return { child, done };
}

const runSetup = (packageDir, env, extraArgs) =>
	startSetup(packageDir, env, extraArgs).done;

async function writeFakeCargo(dir, body) {
	await fs.mkdir(dir, { recursive: true });
	await fs.writeFile(path.join(dir, "cargo"), `#!/bin/sh\n${body}\n`, {
		mode: 0o755,
	});
}

try {
	// 1. Crate unit/integration tests, built outside the source tree.
	await execFileAsync(
		"cargo",
		[
			"test",
			"--locked",
			"--manifest-path",
			crateManifest,
			"--target-dir",
			path.join(work, "test-target"),
		],
		{ maxBuffer: 64 * 1024 * 1024 },
	);
	console.log("cargo test --locked passed");

	// 2. Pack the real tarball and extract it read-only: the build must not write into the npm install.
	const { stdout } = await execFileAsync(
		"npm",
		["pack", "--ignore-scripts", "--silent", "--pack-destination", work],
		{ cwd: rootDir, encoding: "utf8" },
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
	await execFileAsync("tar", ["-xzf", tarball, "-C", extractDir]);
	const packageDir = path.join(extractDir, "package");
	await execFileAsync("chmod", ["-R", "a-w", packageDir]);

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
sh -c 'trap "" TERM; echo $$ > "${pidFile}"; exec sleep 300' &
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
		const { child: setupChild, done } = startSetup(packageDir, env, [
			"--allow-build",
		]);
		const waitForReadyPid = async (file) => {
			for (const deadline = Date.now() + 10_000; Date.now() < deadline; ) {
				const pid = Number(await fs.readFile(file, "utf8").catch(() => ""));
				if (Number.isInteger(pid) && pid > 0) return pid;
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
			throw new Error(
				`Timed out waiting for compiler fixture signal readiness: ${file}`,
			);
		};
		let timer;
		let compilerReaped = false;
		try {
			const [compilerPid] = await Promise.all([
				waitForReadyPid(pidFile),
				waitForReadyPid(leaderFile),
			]);
			process.kill(compilerPid, 0); // compiler child alive after its TERM disposition is ready
			setupChild.kill("SIGTERM");
			const finished = await Promise.race([
				done,
				new Promise((_, reject) => {
					timer = setTimeout(
						() =>
							reject(
								new Error(
									"Packed setup exceeded the 10s compiler cancellation backstop",
								),
							),
						10_000,
					);
				}),
			]);
			assert.equal(finished.code, 143, finished.output);
			let alive = true;
			for (let i = 0; i < 100 && alive; i += 1) {
				try {
					process.kill(compilerPid, 0);
					await new Promise((r) => setTimeout(r, 50));
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
			clearTimeout(timer);
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
			{ timeoutMs: 10_000 },
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
		await execFileAsync(
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
			{ maxBuffer: 64 * 1024 * 1024 },
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
} finally {
	await execFileAsync("chmod", ["-R", "u+w", work]).catch(() => undefined);
	await fs.rm(work, { recursive: true, force: true });
}
