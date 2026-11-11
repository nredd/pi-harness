/**
 * In-process tests for `scripts/setup-helper.mjs` (#704, T2 of #645).
 *
 * `main(argv, deps)` runs against a real scratch filesystem with fake `spawn`, `execFile`, `fetch`,
 * `runCancellable`, clock, console and exit seams, so every platform arm runs on any host and no
 * real signing, download, pkill or cargo ever happens.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { createWriteStream } from "node:fs";
import realFs from "node:fs/promises";
import realOs from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { afterEach, describe, test, vi } from "vitest";
import { defaultDeps, dispatch, isEntrypoint, main, reapProcessGroup, runCancellable, withDirectoryLock } from "../scripts/setup-helper.mjs";

const LSREGISTER = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
const RELEASE_BASE = "https://github.com/injaneity/pi-computer-use/releases/download/v1.2.3";
const ZIP_URL = `${RELEASE_BASE}/pi-computer-use.app.zip`;
const SUMS_URL = `${RELEASE_BASE}/SHA256SUMS`;
const LOCAL_CN = "pi-computer-use Local Signing (com.injaneity.pi-computer-use)";
const LOCAL_FPR = "A".repeat(40);
const DEV_FPR = "B".repeat(40);
const ZIP_BYTES = Buffer.from("fake zip payload");
const ZIP_SHA = createHash("sha256").update(ZIP_BYTES).digest("hex");

/** @type {string[]} */
let scratchDirs = [];

afterEach(async () => {
	await Promise.all(scratchDirs.map((dir) => realFs.rm(dir, { force: true, recursive: true })));
	scratchDirs = [];
});

/**
 * @param {string} file Path to write.
 * @param {string | Buffer} content File body.
 * @returns {Promise<void>} Resolves once written, parents created.
 * @throws {Error} On filesystem failure.
 */
async function put(file, content) {
	await realFs.mkdir(path.dirname(file), { recursive: true });
	await realFs.writeFile(file, content);
}

/**
 * @param {string} appPath Bundle directory.
 * @param {string} exe Executable body.
 * @param {string} plist Info.plist body.
 * @returns {Promise<void>} Resolves once the bundle exists.
 * @throws {Error} On filesystem failure.
 */
async function makeApp(appPath, exe, plist = "<plist/>") {
	await put(path.join(appPath, "Contents", "MacOS", "bridge"), exe);
	await put(path.join(appPath, "Contents", "Info.plist"), plist);
}

/**
 * @param {string} file Path to test.
 * @returns {Promise<boolean>} Whether it exists.
 * @throws {never} Failures read as absent.
 */
async function present(file) {
	return realFs.access(file).then(() => true, () => false);
}

/**
 * @param {string} message Error text.
 * @param {string} code Error code.
 * @returns {Error} Node-style system error.
 * @throws {never} Pure.
 */
function sysError(message, code) {
	return Object.assign(new Error(message), { code });
}

/**
 * Build a host: scratch dirs, fakes, and a mutable `state` the tests script.
 * @param {object} [options] Host options.
 * @param {string} [options.platform] Reported `process.platform`.
 * @param {string} [options.hostArch] Reported `process.arch`.
 * @param {Record<string, string>} [options.env] Extra environment.
 * @param {boolean} [options.sources] Create the Swift sources under `native/macos`.
 * @returns {Promise<object>} Host with `deps`, `dirs`, `state` and recorders.
 * @throws {Error} On filesystem failure.
 */
async function makeHost({ platform = "darwin", hostArch = "arm64", env = {}, sources = true } = {}) {
	const base = await realFs.mkdtemp(path.join(realOs.tmpdir(), "cu-setup-inproc-"));
	scratchDirs.push(base);
	const dirs = {
		base,
		root: path.join(base, "root"),
		home: path.join(base, "home"),
		tmp: path.join(base, "tmp"),
		app: path.join(base, "app dir (1)+x", "pi-computer-use.app"),
		winDest: path.join(base, "dest", "windows-bridge.exe"),
		linuxDest: path.join(base, "dest", "linux-bridge"),
		cache: path.join(base, "cache"),
	};
	await realFs.mkdir(dirs.tmp, { recursive: true });
	await put(path.join(dirs.root, "package.json"), JSON.stringify({ version: "1.2.3" }));
	if (sources) {
		for (const file of ["activity_glow.swift", "agent_cursor.swift", "agent_cursor_motion.swift", "bridge.swift"]) {
			await put(path.join(dirs.root, "native", "macos", file), "// swift");
		}
	}
	const state = {
		/** Scripted per-command exec failures and outputs. */
		devIdOutput: "",
		localListing: () => "",
		which: { codesign: true, openssl: true },
		codesignInfo: { stdout: "", stderr: "Signature=Developer ID" },
		codesignVerifyExit: 0,
		lsregister: false,
		pgrepAlive: 0,
		pgrepForever: false,
		opensslFail: new Set(),
		securityImportFail: undefined,
		spawnExit: {},
		spawnError: {},
		fetchRoutes: new Map(),
		archive: async () => {},
		xcrunWrites: "built binary",
		failRm: () => false,
		accessFail: () => false,
		renameError: undefined,
	};
	const rec = { spawn: [], exec: [], sleep: 0, exit: [], log: [], warn: [], error: [], cargo: [], fetch: [], pgrep: 0 };
	const fsFake = {
		...realFs,
		access: async (target, mode) => {
			if (target === LSREGISTER) {
				if (state.lsregister) return;
				throw sysError("nope", "ENOENT");
			}
			if (state.accessFail(target)) throw sysError("read-only", "EACCES");
			return realFs.access(target, mode);
		},
		rm: async (target, options) => {
			if (state.failRm(target)) throw sysError("rm denied", "EACCES");
			return realFs.rm(target, options);
		},
		rename: async (from, to) => {
			if (state.renameError) throw state.renameError;
			return realFs.rename(from, to);
		},
	};
	const osFake = { homedir: () => dirs.home, tmpdir: () => dirs.tmp, constants: realOs.constants };
	const spawn = (command, args) => {
		rec.spawn.push([command, ...args]);
		const child = new EventEmitter();
		setImmediate(async () => {
			const failure = state.spawnError[command];
			if (failure !== undefined) {
				child.emit("error", failure);
				return;
			}
			try {
				await spawnSideEffects(command, args);
			} catch (error) {
				child.emit("error", error);
				return;
			}
			let code = state.spawnExit[command] ?? 0;
			if (command === "codesign" && args[0] === "--verify") code = state.codesignVerifyExit;
			child.emit("close", code);
		});
		return child;
	};
	const spawnSideEffects = async (command, args) => {
		if (command === "/usr/bin/ditto" && args[0] === "-x") await state.archive(args[3]);
		else if (command === "/usr/bin/ditto") await realFs.cp(args[0], args[1], { recursive: true });
		else if (command === "xcrun") await put(args[args.indexOf("-o") + 1], state.xcrunWrites);
	};
	const execFile = async (command, args) => {
		rec.exec.push([command, ...args]);
		if (command === "security" && args[0] === "find-identity") {
			if (state.securityListFails) throw sysError("security unavailable", "ENOENT");
			return { stdout: args.includes("-v") ? state.devIdOutput : state.localListing(), stderr: "" };
		}
		if (command === "security" && args[0] === "import") {
			if (state.securityImportFail !== undefined) throw state.securityImportFail;
			return { stdout: "", stderr: "" };
		}
		if (command === "which") {
			if (state.which[args[0]]) return { stdout: `/usr/bin/${args[0]}\n`, stderr: "" };
			throw sysError("not found", "ENOENT");
		}
		if (command === "openssl") {
			if (args[0] === "req") state.lockSeen = await realFs.readdir(osFake.tmpdir()).then((names) => names.filter((name) => name.endsWith(".lock")));
			const key = args.includes("-legacy") ? "legacy" : args[0];
			if (state.opensslFail.has(key)) throw new Error(`openssl ${key} failed`);
			return { stdout: "", stderr: "" };
		}
		if (command === "codesign") {
			if (state.codesignInfo instanceof Error) throw state.codesignInfo;
			return state.codesignInfo;
		}
		if (command === "pgrep") {
			rec.pgrep += 1;
			if (state.pgrepForever || rec.pgrep <= state.pgrepAlive) return { stdout: "1\n", stderr: "" };
			throw sysError("no match", "1");
		}
		throw sysError(`${command} unavailable`, "ENOENT");
	};
	const fetch = async (url) => {
		rec.fetch.push(String(url));
		const route = state.fetchRoutes.get(String(url));
		if (route === undefined) return new Response("missing", { status: 404, statusText: "Not Found" });
		return typeof route === "function" ? route() : route;
	};
	const deps = {
		platform,
		hostArch,
		env: {
			PI_COMPUTER_USE_HELPER_APP_PATH: dirs.app,
			PI_COMPUTER_USE_WINDOWS_HELPER_PATH: dirs.winDest,
			PI_COMPUTER_USE_LINUX_HELPER_PATH: dirs.linuxDest,
			XDG_CACHE_HOME: dirs.cache,
			...env,
		},
		pid: 4242,
		uid: "501",
		rootDir: dirs.root,
		fs: fsFake,
		os: osFake,
		spawn,
		execFile,
		runCancellable: async (command, args) => {
			rec.cargo.push([command, ...args]);
			if (state.cargoFail) throw state.cargoFail;
			if (state.cargoWrites) await put(state.cargoWrites, "cargo built");
		},
		fetch,
		createWriteStream,
		pipeline,
		now: () => 1_700_000_000_000,
		sleep: async () => {
			rec.sleep += 1;
		},
		console: {
			log: (message) => rec.log.push(message),
			warn: (message) => rec.warn.push(message),
			error: (message) => rec.error.push(message),
		},
		exit: (code) => {
			rec.exit.push(code);
		},
	};
	return { deps, dirs, state, rec };
}

/**
 * @param {object} host Host from `makeHost`.
 * @param {string[]} argv CLI arguments.
 * @returns {Promise<object>} The host's recorders after `main` settles.
 * @throws {Error} Never for setup failures; they surface through `rec.exit`.
 */
async function runMain(host, argv = []) {
	host.rec.log.length = 0;
	host.rec.warn.length = 0;
	host.rec.error.length = 0;
	host.rec.exit.length = 0;
	host.rec.spawn.length = 0;
	host.rec.exec.length = 0;
	await main(argv, host.deps);
	return host.rec;
}

/** @param {string} line Identity listing line text. @returns {string} Listing with one local identity. @throws {never} Pure. */
function localListing(line = `  1) ${LOCAL_FPR} "${LOCAL_CN}" (CSSMERR_TP_NOT_TRUSTED)`) {
	return `Policy: Code Signing\n  Matching identities\n${line}\n     1 identities found\n`;
}

/**
 * @param {object} host Host.
 * @param {string} arch Arch dir.
 * @param {string} exe Executable body for the loose prebuilt.
 * @returns {Promise<void>} Resolves once the prebuilt exists.
 * @throws {Error} On filesystem failure.
 */
async function prebuiltBinary(host, arch, exe) {
	await put(path.join(host.dirs.root, "prebuilt", "macos", arch, "bridge"), exe);
}

describe("CLI wiring", () => {
	test("isEntrypoint compares resolved real paths and tolerates a missing argv[1]", () => {
		const real = (target) => (target === "/link/setup.mjs" ? "/real/setup.mjs" : target);
		assert.equal(isEntrypoint("/link/setup.mjs", "file:///real/setup.mjs", real), true);
		assert.equal(isEntrypoint("/other.mjs", "file:///real/setup.mjs", real), false);
		assert.equal(isEntrypoint(undefined, "file:///real/setup.mjs", () => assert.fail("must not resolve")), false);
		assert.equal(isEntrypoint("", "file:///real/setup.mjs", () => assert.fail("must not resolve")), false);
		// Default resolver: this test file is not the setup script.
		assert.equal(isEntrypoint(import.meta.filename, new URL("../scripts/setup-helper.mjs", import.meta.url).href), false);
	});

	test("dispatch runs main only for the entry script", async () => {
		const host = await makeHost({ platform: "freebsd" });
		await dispatch(false, ["--postinstall"], host.deps);
		assert.deepEqual(host.rec.warn, []);
		await dispatch(true, ["--postinstall"], host.deps);
		assert.deepEqual(host.rec.warn, ["[pi-computer-use] skipping helper setup: platform is not macOS."]);
		assert.deepEqual(host.rec.exit, []);
	});

	test("defaultDeps wires the real process and seams", () => {
		const deps = defaultDeps();
		assert.equal(deps.platform, process.platform);
		assert.equal(deps.hostArch, process.arch);
		assert.equal(deps.env, process.env);
		assert.equal(deps.pid, process.pid);
		assert.equal(deps.uid, typeof process.getuid === "function" ? String(process.getuid()) : undefined);
		assert.equal(deps.rootDir, path.resolve(import.meta.dirname, ".."));
		assert.equal(deps.fetch, fetch);
		assert.ok(Math.abs(deps.now() - Date.now()) < 1000);
		assert.equal(typeof deps.exit, "function");
		assert.equal(deps.console, console);
	});

	test("defaultDeps reports no uid where getuid does not exist", () => {
		const original = Object.getOwnPropertyDescriptor(process, "getuid");
		Object.defineProperty(process, "getuid", { value: undefined, configurable: true });
		try {
			assert.equal(defaultDeps().uid, undefined);
		} finally {
			if (original) Object.defineProperty(process, "getuid", original);
		}
	});

	test("defaultDeps sleep resolves after the delay", async () => {
		const started = Date.now();
		await defaultDeps().sleep(15);
		assert.ok(Date.now() - started >= 10);
	});

	test("a failure exits 1 with the message, or 0 with a warning under --postinstall", async () => {
		const host = await makeHost({ platform: "freebsd" });
		let rec = await runMain(host, []);
		assert.deepEqual(rec.exit, [1]);
		assert.match(rec.error[0], /supported on macOS, Windows, and Linux/);
		rec = await runMain(host, ["--postinstall"]);
		assert.deepEqual(rec.exit, []);
		assert.deepEqual(rec.error, []);
		// postinstall failure on a supported platform: exit 0 plus warning.
		const win = await makeHost({ platform: "win32" });
		rec = await runMain(win, ["--postinstall"]);
		assert.deepEqual(rec.exit, [0]);
		assert.match(rec.warn[0], /^\[pi-computer-use\] postinstall helper setup skipped: No Windows prebuilt helper found at /);
	});

	test("a non-Error rejection is stringified", async () => {
		const host = await makeHost();
		await makeApp(path.join(host.dirs.root, "prebuilt", "macos", "universal", "pi-computer-use.app"), "x");
		host.state.spawnError.codesign = "boom";
		const rec = await runMain(host);
		assert.deepEqual(rec.exit, [1]);
		assert.deepEqual(rec.error, ["boom"]);
	});

	test("a non-Error rejection from installing a downloaded app is stringified in the warning", async () => {
		const host = await makeHost();
		host.state.fetchRoutes.set(ZIP_URL, () => new Response(ZIP_BYTES));
		host.state.archive = async (dir) => makeApp(path.join(dir, "pi-computer-use.app"), "x");
		host.state.spawnError.codesign = "boom";
		const rec = await runMain(host);
		assert.equal(rec.warn[0], "[pi-computer-use] signed helper release download unavailable: boom");
	});

	test("--platform overrides the host platform", async () => {
		const host = await makeHost({ platform: "darwin" });
		await put(path.join(host.dirs.root, "prebuilt", "windows", "windows-bridge.exe"), "win");
		let rec = await runMain(host, ["--platform", "windows"]);
		assert.match(rec.log[0], /installed Windows helper from prebuilt/);
		assert.equal(await realFs.readFile(host.dirs.winDest, "utf8"), "win");
		rec = await runMain(host, ["--platform"]);
		// A dangling flag has no value: falls through to the darwin arm.
		assert.match(rec.warn[0], /signed helper release download unavailable/);
	});
});

describe("Windows helper", () => {
	test("prebuilt install copies once, then reports up to date and repairs the mode", async () => {
		const host = await makeHost({ platform: "win32" });
		await put(path.join(host.dirs.root, "prebuilt", "windows", "windows-bridge.exe"), "v1");
		let rec = await runMain(host, []);
		assert.equal(rec.log[0], `[pi-computer-use] installed Windows helper from prebuilt to ${host.dirs.winDest}`);
		await realFs.chmod(host.dirs.winDest, 0o600);
		rec = await runMain(host, []);
		assert.equal(rec.log[0], `[pi-computer-use] Windows helper already up to date at ${host.dirs.winDest}`);
		assert.equal((await realFs.stat(host.dirs.winDest)).mode & 0o777, 0o755);
		await put(path.join(host.dirs.root, "prebuilt", "windows", "windows-bridge.exe"), "v2");
		rec = await runMain(host, []);
		assert.match(rec.log[0], /installed Windows helper from prebuilt/);
		assert.equal(await realFs.readFile(host.dirs.winDest, "utf8"), "v2");
	});

	test("no prebuilt and no build flag fails with the remedy", async () => {
		const host = await makeHost({ platform: "win32" });
		const rec = await runMain(host, []);
		assert.deepEqual(rec.exit, [1]);
		assert.match(rec.error[0], /No Windows prebuilt helper found at .*build-native\.mjs --platform windows.*PI_COMPUTER_USE_ALLOW_BUILD=1/);
		assert.deepEqual(host.rec.spawn, []);
	});

	for (const [label, argv, env] of [
		["--allow-build", ["--allow-build"], {}],
		["--runtime", ["--runtime"], {}],
		["PI_COMPUTER_USE_ALLOW_BUILD", [], { PI_COMPUTER_USE_ALLOW_BUILD: "1" }],
	]) {
		test(`cargo fallback via ${label} picks the .exe, then the bare binary, else the .exe path`, async () => {
			const host = await makeHost({ platform: "win32", env });
			const release = path.join(host.dirs.root, "native", "windows", "bridge-rs", "target", "release");
			await put(path.join(release, "windows-bridge.exe"), "exe");
			let rec = await runMain(host, argv);
			assert.deepEqual(rec.spawn[0].slice(0, 3), ["cargo", "build", "--release"]);
			assert.equal(rec.spawn[0][4], path.join(host.dirs.root, "native", "windows", "bridge-rs", "Cargo.toml"));
			assert.equal(rec.log[0], "[pi-computer-use] Windows prebuilt helper missing; attempting source build with cargo...");
			assert.equal(rec.log[1], `[pi-computer-use] built and installed Windows helper at ${host.dirs.winDest}`);
			assert.equal(await realFs.readFile(host.dirs.winDest, "utf8"), "exe");
			rec = await runMain(host, argv);
			assert.equal(rec.log[1], `[pi-computer-use] Windows helper already up to date at ${host.dirs.winDest}`);

			await realFs.rm(path.join(release, "windows-bridge.exe"));
			await put(path.join(release, "windows-bridge"), "bin");
			await runMain(host, argv);
			assert.equal(await realFs.readFile(host.dirs.winDest, "utf8"), "bin");

			await realFs.rm(path.join(release, "windows-bridge"));
			rec = await runMain(host, argv);
			assert.deepEqual(rec.exit, [1]);
			assert.match(rec.error[0], /ENOENT/);
		});
	}

	test("a failing cargo build surfaces the command and exit code", async () => {
		const host = await makeHost({ platform: "win32" });
		host.state.spawnExit.cargo = 101;
		const rec = await runMain(host, ["--allow-build"]);
		assert.deepEqual(rec.exit, [1]);
		assert.match(rec.error[0], /^Command failed \(101\): cargo build --release --manifest-path /);
	});

	test("the helper destination defaults under the home directory", async () => {
		const host = await makeHost({ platform: "win32" });
		delete host.deps.env.PI_COMPUTER_USE_WINDOWS_HELPER_PATH;
		await put(path.join(host.dirs.root, "prebuilt", "windows", "windows-bridge.exe"), "w");
		await runMain(host, []);
		assert.equal(await realFs.readFile(path.join(host.dirs.home, ".pi", "agent", "helpers", "pi-computer-use", "windows-bridge.exe"), "utf8"), "w");
	});

	test("a rename blocked by a running helper names the fix and removes the temp copy", async () => {
		const host = await makeHost({ platform: "win32" });
		await put(path.join(host.dirs.root, "prebuilt", "windows", "windows-bridge.exe"), "new");
		host.state.renameError = sysError("busy", "EPERM");
		host.state.failRm = (target) => target.includes(".tmp-"); // the cleanup `.catch` must absorb this
		let rec = await runMain(host, []);
		assert.deepEqual(rec.exit, [1]);
		assert.match(rec.error[0], /^Cannot update helper at .*the existing helper process is still running/);
		const tempCopies = async () => (await realFs.readdir(path.dirname(host.dirs.winDest))).filter((name) => name.includes(".tmp-"));
		assert.equal((await tempCopies()).length, 1, "the copy whose rm was denied remains");
		host.state.failRm = () => false;
		host.state.renameError = sysError("io", "EIO");
		rec = await runMain(host, []);
		assert.equal(rec.error[0], "io");
		assert.deepEqual(await tempCopies(), [], "a successful rm leaves no temp copy");
	});
});

describe("Linux helper", () => {
	const prebuiltFor = (host, arch) => path.join(host.dirs.root, "prebuilt", "linux", arch, "linux-bridge");

	test("prebuilt install is arch-specific and idempotent", async () => {
		const host = await makeHost({ platform: "linux", hostArch: "x64" });
		await put(prebuiltFor(host, "x64"), "x64 helper");
		let rec = await runMain(host, []);
		assert.equal(rec.log[0], `[pi-computer-use] installed Linux helper (x64) from prebuilt to ${host.dirs.linuxDest}`);
		rec = await runMain(host, []);
		assert.equal(rec.log[0], `[pi-computer-use] Linux helper already up to date at ${host.dirs.linuxDest}`);
	});

	test("an unsupported architecture is rejected", async () => {
		const host = await makeHost({ platform: "linux", hostArch: "ia32" });
		const rec = await runMain(host, []);
		assert.deepEqual(rec.exit, [1]);
		assert.equal(rec.error[0], "Unsupported architecture 'ia32'. Supported: arm64, x64.");
	});

	test("missing prebuilt without --allow-build fails; --runtime does not enable the build", async () => {
		const host = await makeHost({ platform: "linux", hostArch: "arm64" });
		for (const argv of [[], ["--runtime"]]) {
			const rec = await runMain(host, argv);
			assert.deepEqual(rec.exit, [1]);
			assert.match(rec.error[0], /^No Linux prebuilt helper found for arm64 at .*PI_COMPUTER_USE_ALLOW_BUILD=1/);
		}
		assert.deepEqual(host.rec.cargo, []);
	});

	test("the source fallback needs Linux and the crate", async () => {
		const host = await makeHost({ platform: "linux" });
		let rec = await runMain(host, ["--allow-build"]);
		assert.match(rec.error[0], /^Linux helper source not found at .*reinstall @nredd\/pi-computer-use\.$/);
		host.deps.platform = "darwin";
		rec = await runMain(host, ["--platform", "linux", "--allow-build"]);
		assert.equal(rec.error[0], "The Linux helper source fallback must be built on Linux.");
		assert.deepEqual(host.rec.cargo, []);
	});

	for (const [label, argv, env] of [
		["--allow-build", ["--allow-build"], {}],
		["PI_COMPUTER_USE_ALLOW_BUILD", [], { PI_COMPUTER_USE_ALLOW_BUILD: "1" }],
	]) {
		test(`cargo fallback via ${label} builds into the user cache and installs the result`, async () => {
			const host = await makeHost({ platform: "linux", env });
			await put(path.join(host.dirs.root, "native", "linux", "bridge-rs", "Cargo.toml"), "[package]");
			const target = path.join(host.dirs.cache, "pi-computer-use", "linux-bridge-target");
			host.state.cargoWrites = path.join(target, "release", "linux-bridge");
			let rec = await runMain(host, argv);
			assert.deepEqual(host.rec.cargo[0], [
				"cargo", "build", "--locked", "--release",
				"--manifest-path", path.join(host.dirs.root, "native", "linux", "bridge-rs", "Cargo.toml"),
				"--target-dir", target,
			]);
			assert.match(rec.log[0], /building from source with cargo \(target dir .*linux-bridge-target\)/);
			assert.equal(rec.log[1], `[pi-computer-use] built and installed Linux helper at ${host.dirs.linuxDest}`);
			rec = await runMain(host, argv);
			assert.equal(rec.log[1], `[pi-computer-use] Linux helper already up to date at ${host.dirs.linuxDest}`);
		});
	}

	test("the cache and destination default under the home directory", async () => {
		const host = await makeHost({ platform: "linux", env: { PI_COMPUTER_USE_ALLOW_BUILD: "1" } });
		delete host.deps.env.XDG_CACHE_HOME;
		delete host.deps.env.PI_COMPUTER_USE_LINUX_HELPER_PATH;
		await put(path.join(host.dirs.root, "native", "linux", "bridge-rs", "Cargo.toml"), "[package]");
		host.state.cargoWrites = path.join(host.dirs.home, ".cache", "pi-computer-use", "linux-bridge-target", "release", "linux-bridge");
		await runMain(host, []);
		assert.equal(await realFs.readFile(path.join(host.dirs.home, ".pi", "agent", "helpers", "pi-computer-use", "linux-bridge"), "utf8"), "cargo built");
	});

	test("a failing cargo build is reported", async () => {
		const host = await makeHost({ platform: "linux", env: { PI_COMPUTER_USE_ALLOW_BUILD: "1" } });
		await put(path.join(host.dirs.root, "native", "linux", "bridge-rs", "Cargo.toml"), "[package]");
		host.state.cargoFail = new Error("cargo exploded");
		const rec = await runMain(host, []);
		assert.deepEqual(rec.exit, [1]);
		assert.equal(rec.error[0], "cargo exploded");
	});
});

describe("platform routing", () => {
	test("unsupported platforms skip under --postinstall and fail otherwise", async () => {
		for (const platform of ["freebsd", "sunos"]) {
			const host = await makeHost({ platform });
			let rec = await runMain(host, ["--postinstall"]);
			assert.deepEqual(rec.warn, ["[pi-computer-use] skipping helper setup: platform is not macOS."]);
			assert.deepEqual(rec.exit, []);
			rec = await runMain(host, []);
			assert.deepEqual(rec.exit, [1]);
		}
	});

	test("--platform linux from a Windows host routes to the Linux helper", async () => {
		const host = await makeHost({ platform: "win32", hostArch: "arm64" });
		await put(path.join(host.dirs.root, "prebuilt", "linux", "arm64", "linux-bridge"), "l");
		const rec = await runMain(host, ["--platform", "linux"]);
		assert.match(rec.log[0], /installed Linux helper \(arm64\)/);
	});

	test("an unsupported darwin architecture is rejected", async () => {
		const host = await makeHost({ hostArch: "riscv64" });
		const rec = await runMain(host, []);
		assert.equal(rec.error[0], "Unsupported architecture 'riscv64'. Supported: arm64, x64.");
	});
});

describe("macOS sealed app installs", () => {
	const universal = (host) => path.join(host.dirs.root, "prebuilt", "macos", "universal", "pi-computer-use.app");

	test("universal bundle: verify, stop the old helper, ditto, then current on rerun", async () => {
		const host = await makeHost();
		await makeApp(universal(host), "sealed exe", "<plist v1/>");
		host.state.lsregister = true;
		host.state.pgrepAlive = 2;
		let rec = await runMain(host, []);
		assert.deepEqual(rec.exit, []);
		assert.equal(rec.log[0], `[pi-computer-use] installed pre-signed helper app (arm64) at ${host.dirs.app}`);
		const names = rec.spawn.map(([command, ...args]) => `${command} ${args[0]}`);
		assert.deepEqual(names, ["codesign --verify", "/usr/bin/ditto " + universal(host), `${LSREGISTER} -f`]);
		assert.deepEqual(rec.spawn[0], ["codesign", "--verify", "--strict", universal(host)]);
		// Regex metacharacters, spaces and parens in the bundle path match literally under `pkill -f`.
		const escaped = `${path.join(host.dirs.app, "Contents", "MacOS", "bridge").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} serve`;
		assert.deepEqual(rec.exec.find(([command]) => command === "pkill"), ["pkill", "-f", escaped]);
		assert.match(escaped, /app dir \\\(1\\\)\\\+x/);
		assert.equal(rec.exec.filter(([command]) => command === "pgrep").length, 3, "polls until pgrep stops matching");
		assert.equal(host.rec.sleep, 2);
		assert.equal(await realFs.readFile(path.join(host.dirs.app, "Contents", "MacOS", "bridge"), "utf8"), "sealed exe");

		rec = await runMain(host, []);
		assert.equal(rec.log[0], `[pi-computer-use] pre-signed helper app (arm64) already current at ${host.dirs.app}`);
		assert.deepEqual(rec.spawn.map(([command]) => command), [LSREGISTER], "nothing is verified, killed or copied when current");
	});

	test("a changed Info.plist alone reinstalls; the per-arch bundle is used without a universal one", async () => {
		const host = await makeHost({ hostArch: "x64" });
		const perArch = path.join(host.dirs.root, "prebuilt", "macos", "x64", "pi-computer-use.app");
		await makeApp(perArch, "same", "<plist v1/>");
		await runMain(host, []);
		await put(path.join(perArch, "Contents", "Info.plist"), "<plist v2/>");
		const rec = await runMain(host, []);
		assert.equal(rec.log[0], `[pi-computer-use] installed pre-signed helper app (x64) at ${host.dirs.app}`);
		assert.equal(await realFs.readFile(path.join(host.dirs.app, "Contents", "Info.plist"), "utf8"), "<plist v2/>");
	});

	test("a changed executable alone reinstalls, and an exited-0 pgrep that never clears is bounded", async () => {
		const host = await makeHost();
		await makeApp(universal(host), "one");
		await runMain(host, []);
		await put(path.join(universal(host), "Contents", "MacOS", "bridge"), "two");
		host.state.pgrepForever = true;
		host.rec.pgrep = 0;
		const rec = await runMain(host, []);
		assert.equal(rec.log[0].startsWith("[pi-computer-use] installed pre-signed"), true);
		assert.equal(host.rec.pgrep, 20, "gives up after 20 polls rather than hanging");
		assert.equal(host.rec.sleep, 20);
	});

	test("a bundle that fails strict verification is never installed", async () => {
		const host = await makeHost();
		await makeApp(universal(host), "tampered");
		host.state.codesignVerifyExit = 1;
		const rec = await runMain(host, []);
		assert.deepEqual(rec.exit, [1]);
		assert.equal(rec.error[0], `Command failed (1): codesign --verify --strict ${universal(host)}`);
		assert.equal(await present(host.dirs.app), false);
		assert.equal(rec.spawn.some(([command]) => command === "/usr/bin/ditto"), false);
	});

	test("a failing lsregister is ignored", async () => {
		const host = await makeHost();
		await makeApp(universal(host), "x");
		host.state.lsregister = true;
		host.state.spawnExit[LSREGISTER] = 3;
		const rec = await runMain(host, []);
		assert.deepEqual(rec.exit, []);
		assert.match(rec.log[0], /installed pre-signed helper app/);
	});

	test("an unwritable parent directory aborts before anything is touched", async () => {
		const host = await makeHost();
		await makeApp(universal(host), "x");
		host.state.accessFail = (target) => target === path.dirname(host.dirs.app);
		const rec = await runMain(host, []);
		assert.deepEqual(rec.exit, [1]);
		assert.equal(rec.error[0], "read-only");
		assert.deepEqual(rec.spawn, []);
	});
});

describe("macOS local helper install and signing", () => {
	test("no identity: ad-hoc signs, warns, then reports current", async () => {
		const host = await makeHost();
		await prebuiltBinary(host, "arm64", "bin v1");
		host.state.which.codesign = false;
		let rec = await runMain(host, []);
		assert.equal(rec.log[0], `[pi-computer-use] installed helper app (arm64) at ${host.dirs.app}`);
		assert.deepEqual(rec.spawn.find(([command]) => command === "codesign"), ["codesign", "--force", "--deep", "-i", "com.injaneity.pi-computer-use", "--timestamp=none", "--sign", "-", host.dirs.app]);
		assert.match(rec.warn[0], /signed helper ad-hoc; macOS may require permission review/);
		const plist = await realFs.readFile(path.join(host.dirs.app, "Contents", "Info.plist"), "utf8");
		// Byte-exact: an installed bundle is compared against this text to decide "already current".
		assert.equal(plist, [
			'<?xml version="1.0" encoding="UTF-8"?>',
			'<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
			'<plist version="1.0"><dict>',
			"<key>CFBundleIdentifier</key><string>com.injaneity.pi-computer-use</string>",
			"<key>CFBundleName</key><string>pi-computer-use</string>",
			"<key>CFBundleDisplayName</key><string>pi-computer-use</string>",
			"<key>CFBundleExecutable</key><string>bridge</string>",
			"<key>CFBundlePackageType</key><string>APPL</string>",
			"<key>CFBundleShortVersionString</key><string>1.2.3</string>",
			"<key>CFBundleVersion</key><string>1.2.3</string>",
			"<key>LSMinimumSystemVersion</key><string>14.0</string>",
			"<key>LSUIElement</key><true/>",
			"</dict></plist>\n",
		].join("\n"));
		assert.equal((await realFs.stat(path.join(host.dirs.app, "Contents", "MacOS", "bridge"))).mode & 0o777, 0o755);
		const hash = createHash("sha256").update("bin v1").digest("hex");
		assert.equal(await realFs.readFile(path.join(host.dirs.app, "Contents", "Resources", "source.sha256"), "utf8"), `${hash}\n`);

		rec = await runMain(host, []);
		assert.equal(rec.log[0], `[pi-computer-use] helper app (arm64) already current at ${host.dirs.app}`);
		assert.equal(rec.spawn.some(([command]) => command === "codesign"), false);
	});

	test("ad-hoc replacement is refused unless allowed by flag or environment", async () => {
		const host = await makeHost();
		await prebuiltBinary(host, "arm64", "bin v1");
		host.state.which.codesign = false;
		await runMain(host, []);
		await prebuiltBinary(host, "arm64", "bin v2");
		let rec = await runMain(host, []);
		assert.deepEqual(rec.exit, [1]);
		assert.match(rec.error[0], /^Refusing to replace an installed helper with an ad-hoc signed rebuild/);
		assert.equal(await realFs.readFile(path.join(host.dirs.app, "Contents", "MacOS", "bridge"), "utf8"), "bin v1");

		rec = await runMain(host, ["--allow-adhoc-update"]);
		assert.deepEqual(rec.exit, []);
		assert.equal(await realFs.readFile(path.join(host.dirs.app, "Contents", "MacOS", "bridge"), "utf8"), "bin v2");

		await prebuiltBinary(host, "arm64", "bin v3");
		host.deps.env.PI_COMPUTER_USE_ALLOW_ADHOC_UPDATE = "1";
		rec = await runMain(host, []);
		assert.deepEqual(rec.exit, []);
		assert.equal(await realFs.readFile(path.join(host.dirs.app, "Contents", "MacOS", "bridge"), "utf8"), "bin v3");
	});

	test("an explicit identity signs without warnings and upgrades an ad-hoc install in place", async () => {
		const host = await makeHost({ env: { PI_COMPUTER_USE_CODESIGN_IDENTITY: "My Identity" } });
		await prebuiltBinary(host, "arm64", "bin");
		let rec = await runMain(host, []);
		assert.deepEqual(rec.spawn.find(([command]) => command === "codesign").slice(6, 8), ["--sign", "My Identity"]);
		assert.deepEqual(rec.warn, []);
		assert.equal(rec.log.length, 1);

		host.state.codesignInfo = { stdout: "", stderr: "Signature=adhoc\n" };
		rec = await runMain(host, []);
		assert.equal(rec.log[0], `[pi-computer-use] installed helper app (arm64) at ${host.dirs.app}`);
		assert.equal(rec.spawn.filter(([command]) => command === "codesign").length, 1, "re-signed in place");

		host.state.codesignInfo = { stdout: "Signature size=9\n", stderr: "" };
		rec = await runMain(host, []);
		assert.equal(rec.log[0], `[pi-computer-use] helper app (arm64) already current at ${host.dirs.app}`);
		assert.equal(rec.spawn.some(([command]) => command === "codesign"), false);
	});

	test("an ad-hoc probe that errors is judged by its output, and a bare error is not ad-hoc", async () => {
		const host = await makeHost({ env: { PI_COMPUTER_USE_CODESIGN_IDENTITY: "My Identity" } });
		await prebuiltBinary(host, "arm64", "bin");
		await runMain(host, []);
		host.state.codesignInfo = Object.assign(new Error("exit 1"), { stdout: "", stderr: "Signature=adhoc" });
		let rec = await runMain(host, []);
		assert.match(rec.log[0], /^\[pi-computer-use\] installed helper app/);
		host.state.codesignInfo = new Error("exit 1");
		rec = await runMain(host, []);
		assert.match(rec.log[0], /already current/);
	});

	test("an ad-hoc probe with empty result fields reads as not ad-hoc", async () => {
		const host = await makeHost({ env: { PI_COMPUTER_USE_CODESIGN_IDENTITY: "My Identity" } });
		await prebuiltBinary(host, "arm64", "bin");
		await runMain(host, []);
		host.state.codesignInfo = {};
		const rec = await runMain(host, []);
		assert.match(rec.log[0], /already current/);
	});

	test("PI_COMPUTER_USE_NO_SIGN skips signing and never upgrades an installed helper", async () => {
		const host = await makeHost({ env: { PI_COMPUTER_USE_NO_SIGN: "1" } });
		await prebuiltBinary(host, "arm64", "bin");
		let rec = await runMain(host, []);
		assert.equal(rec.spawn.some(([command]) => command === "codesign"), false);
		assert.match(rec.log[0], /installed helper app/);
		rec = await runMain(host, []);
		assert.match(rec.log[0], /already current/);
	});

	test("a Developer ID identity wins and prints no ad-hoc or local message", async () => {
		const host = await makeHost();
		await prebuiltBinary(host, "arm64", "bin");
		host.state.devIdOutput = `  1) ${DEV_FPR} "Developer ID Application: Someone (TEAM123456)"\n     1 valid identities found\n`;
		const rec = await runMain(host, []);
		assert.deepEqual(rec.spawn.find(([command]) => command === "codesign").slice(6, 8), ["--sign", DEV_FPR]);
		assert.deepEqual(rec.warn, []);
		assert.equal(rec.log.length, 1);
		assert.equal(rec.exec.some(([command, ...args]) => command === "which"), false, "no local lookup when a Developer ID exists");
	});

	test("a Developer ID listing with no matching line falls through, as does a failing security", async () => {
		const host = await makeHost();
		await prebuiltBinary(host, "arm64", "bin");
		host.state.devIdOutput = `  1) ${DEV_FPR} "Apple Development: Someone"\n`;
		host.state.which.codesign = false;
		const rec = await runMain(host, []);
		assert.equal(rec.spawn.find(([command]) => command === "codesign")[7], "-");
	});

	test("a failing security listing reads as no identity, and a missing uid names the lock for `user`", async () => {
		const host = await makeHost();
		host.deps.uid = undefined;
		await prebuiltBinary(host, "arm64", "bin");
		await put(path.join(host.dirs.home, "Library", "Keychains", "login.keychain"), "kc");
		host.state.securityListFails = true;
		host.state.securityImportFail = new Error("import denied");
		const rec = await runMain(host, []);
		assert.equal(rec.spawn.find(([command]) => command === "codesign")[7], "-");
		// The identity is resolved twice (to pick the install path, then to sign), each failing the same way.
		const warning = "[pi-computer-use] could not create a valid local signing identity: import denied";
		assert.deepEqual(rec.warn.filter((line) => line.includes("could not create")), [warning, warning]);
		// Per resolution: Developer ID lookup, local lookup, once more before the lock and once inside it.
		assert.equal(rec.exec.filter(([command, sub]) => command === "security" && sub === "find-identity").length, 8);
		assert.deepEqual(host.state.lockSeen, ["pi-computer-use-local-signing-user.lock"]);
	});

	test("with several identities listed, the first matching one is used", async () => {
		const host = await makeHost();
		await prebuiltBinary(host, "arm64", "bin");
		host.state.devIdOutput = [
			`  1) ${"C".repeat(40)} "Apple Development: Someone"`,
			`  2) ${DEV_FPR} "Developer ID Application: First (TEAM000001)"`,
			`  3) ${"D".repeat(40)} "Developer ID Application: Second (TEAM000002)"`,
		].join("\n");
		let rec = await runMain(host, []);
		assert.equal(rec.spawn.find(([command]) => command === "codesign")[7], DEV_FPR);

		const local = await makeHost();
		await prebuiltBinary(local, "arm64", "bin");
		local.state.localListing = () => [
			`  1) ${"C".repeat(40)} "Some Other Identity" (CSSMERR_TP_NOT_TRUSTED)`,
			`  2) ${LOCAL_FPR} "${LOCAL_CN}" (CSSMERR_TP_NOT_TRUSTED)`,
			`  3) ${"E".repeat(40)} "${LOCAL_CN}" (CSSMERR_TP_NOT_TRUSTED)`,
		].join("\n");
		rec = await runMain(local, []);
		assert.equal(rec.spawn.find(([command]) => command === "codesign")[7], LOCAL_FPR);
	});

	test("an existing local identity is used by fingerprint and announced", async () => {
		const host = await makeHost();
		await prebuiltBinary(host, "arm64", "bin");
		host.state.localListing = () => localListing();
		const rec = await runMain(host, []);
		assert.deepEqual(rec.spawn.find(([command]) => command === "codesign").slice(6, 8), ["--sign", LOCAL_FPR]);
		assert.equal(rec.log[0], `[pi-computer-use] signed ${host.dirs.app} with local identity '${LOCAL_CN}'. macOS may still require permission review after local rebuilds.`);
		assert.equal(rec.warn.length, 0);
	});

	test("with no local identity and no openssl or keychain, signing falls back to ad-hoc", async () => {
		for (const [label, tweak] of [
			["no openssl", (host) => { host.state.which.openssl = false; }],
			["no keychain", () => {}],
		]) {
			const host = await makeHost();
			await prebuiltBinary(host, "arm64", "bin");
			tweak(host);
			const rec = await runMain(host, []);
			assert.equal(rec.spawn.find(([command]) => command === "codesign")[7], "-", label);
			assert.equal(rec.exec.some(([command]) => command === "openssl"), false, label);
		}
	});

	for (const keychain of ["login.keychain-db", "login.keychain"]) {
		test(`creates a local identity in ${keychain}, with the legacy pkcs12 flag first`, async () => {
			const host = await makeHost();
			await prebuiltBinary(host, "arm64", "bin");
			await put(path.join(host.dirs.home, "Library", "Keychains", keychain), "kc");
			let imported = false;
			host.state.localListing = () => (imported ? localListing() : "");
			const baseExec = host.deps.execFile;
			host.deps.execFile = async (command, args) => {
				const result = await baseExec(command, args);
				if (command === "security" && args[0] === "import") imported = true;
				return result;
			};
			const rec = await runMain(host, []);
			const openssl = rec.exec.filter(([command]) => command === "openssl");
			assert.deepEqual(openssl.map(([, sub]) => sub), ["req", "pkcs12"]);
			assert.ok(openssl[1].includes("-legacy"));
			const imports = rec.exec.find(([command, sub]) => command === "security" && sub === "import");
			assert.equal(imports[3], "-k");
			assert.equal(imports[4], path.join(host.dirs.home, "Library", "Keychains", keychain));
			assert.deepEqual(imports.slice(-3), ["-A", "-T", "/usr/bin/codesign"]);
			assert.deepEqual(rec.spawn.find(([command]) => command === "codesign").slice(6, 8), ["--sign", LOCAL_FPR]);
			const leftovers = (await realFs.readdir(host.dirs.tmp)).filter((name) => name.startsWith("pi-computer-use-signing-"));
			assert.deepEqual(leftovers, [], "scratch key material is removed");
			assert.deepEqual(host.state.lockSeen, ["pi-computer-use-local-signing-501.lock"], "creation runs under the uid-named lock");
			assert.equal(await present(path.join(host.dirs.tmp, "pi-computer-use-local-signing-501.lock")), false, "lock released");
		});
	}

	test("falls back to pkcs12 without -legacy, tolerating a cleanup failure", async () => {
		const host = await makeHost();
		await prebuiltBinary(host, "arm64", "bin");
		await put(path.join(host.dirs.home, "Library", "Keychains", "login.keychain-db"), "kc");
		let imported = false;
		host.state.localListing = () => (imported ? localListing() : "");
		host.state.opensslFail = new Set(["legacy"]);
		host.state.failRm = (target) => path.basename(target).startsWith("pi-computer-use-signing-");
		const baseExec = host.deps.execFile;
		host.deps.execFile = async (command, args) => {
			const result = await baseExec(command, args);
			if (command === "security" && args[0] === "import") imported = true;
			return result;
		};
		const rec = await runMain(host, []);
		const pkcs = rec.exec.filter(([command, sub]) => command === "openssl" && sub === "pkcs12");
		assert.equal(pkcs.length, 2);
		assert.equal(pkcs[1].includes("-legacy"), false);
		assert.deepEqual(rec.warn, []);
		assert.deepEqual(rec.spawn.find(([command]) => command === "codesign").slice(6, 8), ["--sign", LOCAL_FPR]);
	});

	test("creation failures warn and fall back to ad-hoc, for Error and non-Error causes", async () => {
		const cases = [
			["both pkcs12 attempts fail", (host) => { host.state.opensslFail = new Set(["legacy", "pkcs12"]); }, /could not create a valid local signing identity: openssl pkcs12 failed$/],
			["security import fails", (host) => { host.state.securityImportFail = new Error("import denied"); }, /could not create a valid local signing identity: import denied$/],
			["security import fails with a string", (host) => { host.state.securityImportFail = "plain string"; }, /could not create a valid local signing identity: plain string$/],
			["imported cert is not a code-signing identity", () => {}, /could not create a valid local signing identity: Imported local signing certificate is not a valid code-signing identity\.$/],
		];
		for (const [label, tweak, pattern] of cases) {
			const host = await makeHost();
			await prebuiltBinary(host, "arm64", "bin");
			await put(path.join(host.dirs.home, "Library", "Keychains", "login.keychain-db"), "kc");
			tweak(host);
			const rec = await runMain(host, []);
			const warning = rec.warn.find((line) => line.includes("could not create"));
			assert.match(warning ?? "", pattern, label);
			assert.equal(rec.spawn.find(([command]) => command === "codesign")[7], "-", label);
		}
	});

	test("an identity created by a concurrent installer while waiting for the lock is reused", async () => {
		const host = await makeHost();
		await prebuiltBinary(host, "arm64", "bin");
		await put(path.join(host.dirs.home, "Library", "Keychains", "login.keychain-db"), "kc");
		let lookups = 0;
		host.state.localListing = () => (++lookups >= 3 ? localListing() : "");
		const rec = await runMain(host, []);
		assert.equal(rec.exec.some(([command]) => command === "openssl"), false, "nothing is created");
		assert.deepEqual(rec.spawn.find(([command]) => command === "codesign").slice(6, 8), ["--sign", LOCAL_FPR]);
	});

	test("a codesign failure aborts the install", async () => {
		const host = await makeHost();
		await prebuiltBinary(host, "arm64", "bin");
		host.state.which.codesign = false;
		host.state.spawnExit.codesign = 1;
		const rec = await runMain(host, []);
		assert.deepEqual(rec.exit, [1]);
		assert.match(rec.error[0], /^Command failed \(1\): codesign --force --deep/);
	});

	test("an unreadable package version fails the local install", async () => {
		const host = await makeHost();
		await prebuiltBinary(host, "arm64", "bin");
		await put(path.join(host.dirs.root, "package.json"), JSON.stringify({ version: "" }));
		const rec = await runMain(host, []);
		assert.match(rec.error[0], /^Could not read package version from .*package\.json\.$/);
	});
});

describe("macOS release download", () => {
	/** @param {object} host Host. @param {(extractDir: string) => Promise<void>} layout Archive layout. @returns {void} @throws {never} Pure. */
	function serveRelease(host, layout) {
		host.state.fetchRoutes.set(ZIP_URL, () => new Response(ZIP_BYTES));
		host.state.fetchRoutes.set(SUMS_URL, () => new Response(`# comment\nnot a checksum line\n${ZIP_SHA.toUpperCase()}  *dist/pi-computer-use.app.zip\n${"0".repeat(64)}  other.zip\n`));
		host.state.archive = layout;
	}
	const direct = (host) => async (dir) => makeApp(path.join(dir, "pi-computer-use.app"), "release exe");
	const leftovers = async (host) => (await realFs.readdir(host.dirs.tmp)).filter((name) => name.startsWith("pi-computer-use-release-helper-"));

	test("downloads, verifies the checksum, extracts and installs, then cleans the temp dir", async () => {
		const host = await makeHost();
		serveRelease(host, direct(host));
		const rec = await runMain(host, []);
		assert.deepEqual(rec.exit, []);
		assert.equal(rec.log[0], `[pi-computer-use] installed signed helper app from GitHub Release v1.2.3 (pi-computer-use.app.zip) at ${host.dirs.app}`);
		assert.deepEqual(host.rec.fetch, [SUMS_URL, ZIP_URL]);
		assert.equal(await realFs.readFile(path.join(host.dirs.app, "Contents", "MacOS", "bridge"), "utf8"), "release exe");
		assert.deepEqual(await leftovers(host), []);

		const second = await runMain(host, []);
		assert.match(second.log[0], /signed helper app from GitHub Release v1\.2\.3 \(pi-computer-use\.app\.zip\) already current/);
	});

	test("a nested archive layout is searched, skipping files and empty directories", async () => {
		const host = await makeHost();
		serveRelease(host, async (dir) => {
			await put(path.join(dir, "README.txt"), "file entry");
			await realFs.mkdir(path.join(dir, "aaa-empty"));
			await makeApp(path.join(dir, "zzz", "inner", "pi-computer-use.app"), "nested exe");
		});
		const rec = await runMain(host, []);
		assert.match(rec.log[0], /^\[pi-computer-use\] installed signed helper app from GitHub Release/);
		assert.equal(await realFs.readFile(path.join(host.dirs.app, "Contents", "MacOS", "bridge"), "utf8"), "nested exe");
	});

	test("a wrong checksum is rejected before extraction and the temp dir is removed", async () => {
		const host = await makeHost();
		serveRelease(host, direct(host));
		host.state.fetchRoutes.set(ZIP_URL, () => new Response("tampered bytes"));
		const rec = await runMain(host, []);
		assert.match(rec.warn[0], new RegExp(`^\\[pi-computer-use\\] signed helper release download unavailable: No signed helper release asset found for v1\\.2\\.3: SHA256 mismatch for pi-computer-use\\.app\\.zip: expected ${ZIP_SHA}, got [0-9a-f]{64}$`));
		assert.equal(rec.spawn.some(([command]) => command === "/usr/bin/ditto"), false, "no extraction of an unverified archive");
		assert.deepEqual(await leftovers(host), []);
		assert.match(rec.error[0], /^No prebuilt helper found for arm64 at /);
	});

	test("a missing or empty SHA256SUMS skips verification; a throwing checksum fetch does too", async () => {
		for (const sums of [undefined, new Response("", { status: 200 }), () => { throw new Error("network down"); }]) {
			const host = await makeHost();
			serveRelease(host, direct(host));
			if (sums === undefined) host.state.fetchRoutes.delete(SUMS_URL);
			else host.state.fetchRoutes.set(SUMS_URL, sums);
			const rec = await runMain(host, []);
			assert.match(rec.log[0], /installed signed helper app from GitHub Release/);
		}
	});

	test("HTTP errors, empty bodies and truncated bodies are reported and fall through", async () => {
		const bodies = [
			["404", () => new Response("nope", { status: 404, statusText: "Not Found" }), "HTTP 404 Not Found"],
			["no body", () => new Response(null, { status: 200 }), "empty response body"],
			["truncated", () => new Response(new ReadableStream({
				start(controller) {
					controller.enqueue(new Uint8Array([1, 2, 3]));
					controller.error(new Error("terminated"));
				},
			})), "terminated"],
		];
		for (const [label, route, message] of bodies) {
			const host = await makeHost();
			serveRelease(host, direct(host));
			host.state.fetchRoutes.set(ZIP_URL, route);
			const rec = await runMain(host, []);
			assert.equal(rec.warn[0], `[pi-computer-use] signed helper release download unavailable: No signed helper release asset found for v1.2.3: ${message}`, label);
			assert.match(rec.error[0], /^No prebuilt helper found for arm64 at .*npm run build:native/, label);
			assert.deepEqual(await leftovers(host), [], label);
		}
	});

	test("a throwing asset fetch is reported as a failed download", async () => {
		const host = await makeHost();
		host.state.fetchRoutes.set(ZIP_URL, () => { throw new Error("socket hang up"); });
		const rec = await runMain(host, []);
		assert.match(rec.warn[0], /No signed helper release asset found for v1\.2\.3: socket hang up$/);
	});

	test("a non-Error thrown by the asset fetch is stringified", async () => {
		const host = await makeHost();
		host.state.fetchRoutes.set(ZIP_URL, () => { throw "socket reset"; });
		const rec = await runMain(host, []);
		assert.match(rec.warn[0], /No signed helper release asset found for v1\.2\.3: socket reset$/);
	});

	test("an archive without the app is rejected", async () => {
		const host = await makeHost();
		serveRelease(host, async (dir) => put(path.join(dir, "other.txt"), "x"));
		const rec = await runMain(host, []);
		assert.match(rec.warn[0], /No signed helper release asset found for v1\.2\.3: missing pi-computer-use\.app in pi-computer-use\.app\.zip$/);
	});

	test("a failing extraction is reported with temp cleanup tolerating its own failure", async () => {
		const host = await makeHost();
		serveRelease(host, direct(host));
		host.state.spawnExit["/usr/bin/ditto"] = 1;
		host.state.failRm = (target) => path.basename(target).startsWith("pi-computer-use-release-helper-");
		const rec = await runMain(host, []);
		assert.match(rec.warn[0], /Command failed \(1\): \/usr\/bin\/ditto -x -k /);
	});

	test("an unreadable package version skips the download", async () => {
		const host = await makeHost();
		await put(path.join(host.dirs.root, "package.json"), JSON.stringify({}));
		const rec = await runMain(host, []);
		assert.match(rec.warn[0], /signed helper release download unavailable: Could not read package version from .*package\.json\.$/);
		assert.deepEqual(host.rec.fetch, []);
	});

	test("a release app that fails verification is not installed, and temp cleanup failures are tolerated", async () => {
		const host = await makeHost();
		serveRelease(host, direct(host));
		host.state.codesignVerifyExit = 1;
		host.state.failRm = (target) => path.basename(target).startsWith("pi-computer-use-release-helper-");
		const rec = await runMain(host, []);
		assert.match(rec.warn[0], /Command failed \(1\): codesign --verify --strict .*extract\/pi-computer-use\.app$/);
		assert.equal(await present(host.dirs.app), false);
	});
});

describe("macOS source build fallback", () => {
	test("builds with swiftc for the host arch, signs, installs and reports current on rerun", async () => {
		const host = await makeHost({ hostArch: "x64", env: { PI_COMPUTER_USE_NO_SIGN: "1" } });
		let rec = await runMain(host, ["--allow-build"]);
		assert.deepEqual(rec.exit, []);
		assert.equal(rec.log[0], "[pi-computer-use] prebuilt helper missing; attempting source build with xcrun swiftc...");
		assert.equal(rec.log[1], `[pi-computer-use] built helper app at ${host.dirs.app}`);
		const xcrun = rec.spawn.find(([command]) => command === "xcrun");
		assert.equal(xcrun[1], "swiftc");
		assert.equal(xcrun[3], "x86_64-apple-macosx14.0");
		assert.equal(xcrun[4], "-module-cache-path");
		assert.ok(xcrun[5].startsWith(path.join(host.dirs.tmp, "pi-computer-use-swift-module-cache-")));
		assert.equal(xcrun[6], "-O");
		for (const framework of ["ApplicationServices", "AppKit", "ScreenCaptureKit", "Foundation", "SwiftUI"]) {
			assert.ok(xcrun.join(" ").includes(`-framework ${framework}`));
		}
		assert.ok(xcrun.includes(path.join(host.dirs.root, "native", "macos", "bridge.swift")));
		assert.equal(await realFs.readFile(path.join(host.dirs.app, "Contents", "MacOS", "bridge"), "utf8"), "built binary");
		assert.equal((await realFs.readdir(host.dirs.tmp)).some((name) => name.includes("module-cache") || name.startsWith("pi-computer-use-bridge-")), false, "module cache and temp binary are removed");

		rec = await runMain(host, ["--allow-build"]);
		assert.equal(rec.log[1], `[pi-computer-use] built helper app; installed app already current at ${host.dirs.app}`);
	});

	test("the runtime flag and environment variable also enable the build, and signing runs when not disabled", async () => {
		for (const [argv, env] of [[["--runtime"], {}], [[], { PI_COMPUTER_USE_ALLOW_BUILD: "1" }]]) {
			const host = await makeHost({ env: { PI_COMPUTER_USE_CODESIGN_IDENTITY: "Dev", ...env } });
			const rec = await runMain(host, argv);
			assert.deepEqual(rec.exit, []);
			const signs = rec.spawn.filter(([command]) => command === "codesign");
			assert.equal(signs.length, 2, "the build output, then the installed bundle");
			assert.equal(signs[0].at(-1).startsWith(path.join(host.dirs.tmp, "pi-computer-use-bridge-4242-")), true);
			assert.equal(signs[0][4], "com.injaneity.pi-computer-use");
		}
	});

	test("a missing Swift source fails fast and tolerates a failing temp removal", async () => {
		const host = await makeHost({ sources: false });
		host.state.failRm = (target) => path.basename(target).startsWith("pi-computer-use-bridge-");
		const rec = await runMain(host, ["--allow-build"]);
		assert.deepEqual(rec.exit, [1]);
		assert.match(rec.error[0], /^Native helper source not found at .*activity_glow\.swift$/);
		assert.equal(rec.spawn.some(([command]) => command === "xcrun"), false);
	});

	test("a failing swiftc removes the module cache and reports the failure", async () => {
		const host = await makeHost();
		host.state.spawnExit.xcrun = 2;
		const rec = await runMain(host, ["--allow-build"]);
		assert.deepEqual(rec.exit, [1]);
		assert.match(rec.error[0], /^Command failed \(2\): xcrun swiftc -target arm64-apple-macosx14\.0/);
		assert.equal((await realFs.readdir(host.dirs.tmp)).some((name) => name.includes("module-cache")), false);
	});

	test("without a build flag the missing-helper error names the remedy", async () => {
		const host = await makeHost();
		const rec = await runMain(host, []);
		assert.match(rec.error[0], /^No prebuilt helper found for arm64 at .*prebuilt\/macos\/arm64\/bridge\. Run 'npm run build:native' to build locally\.$/);
		assert.match(rec.warn[0], /signed helper release download unavailable: .*HTTP 404 Not Found/);
	});
});

/**
 * A fake child process in its own group.
 * @param {number} [pid] Group leader pid.
 * @returns {EventEmitter & {pid: number}} Child emitter.
 * @throws {never} Pure.
 */
function fakeChild(pid = 4_000_001) {
	return Object.assign(new EventEmitter(), { pid });
}

/** Group that is already gone: every probe is ESRCH. @returns {never} Always throws. @throws {Error} ESRCH. */
function gone() {
	throw sysError("no such group", "ESRCH");
}

describe("runCancellable in process", () => {
	/** @type {import("vitest").MockInstance | undefined} */
	let onSpy;

	afterEach(() => {
		onSpy?.mockRestore();
		vi.restoreAllMocks();
	});

	/**
	 * Capture the handlers `runCancellable` registers instead of attaching them to the test process.
	 * @returns {Map<string, Function>} Handlers by event name.
	 * @throws {never} Pure.
	 */
	function captureHandlers() {
		const handlers = new Map();
		onSpy = vi.spyOn(process, "on").mockImplementation((event, handler) => {
			handlers.set(event, handler);
			return process;
		});
		return handlers;
	}

	/** @param {object} child Fake child. @param {Function} kill Kill seam. @returns {{promise: Promise<void>}} Pending run. @throws {never} Pure. */
	function start(child, kill, listStates = () => []) {
		return { promise: runCancellable("tool", ["a", "b"], { kill, listStates, spawnChild: () => child }) };
	}

	test("the default seams run a real command to success and reap its group", async () => {
		await runCancellable(process.execPath, ["-e", "0"]);
	});

	test("the default seams surface a real non-zero exit", async () => {
		await assert.rejects(runCancellable(process.execPath, ["-e", "process.exit(3)"]), /^Error: Command failed \(3\): /);
	});

	test("reapProcessGroup refuses an unownable group before touching its defaults", async () => {
		await assert.rejects(reapProcessGroup(1), /owned positive process-group ID above 1/);
	});

	test("a clean exit resolves and releases every handler", async () => {
		const handlers = captureHandlers();
		const child = fakeChild();
		const { promise } = start(child, gone);
		assert.deepEqual([...handlers.keys()].sort(), ["SIGHUP", "SIGINT", "SIGTERM", "exit"]);
		const off = vi.spyOn(process, "off").mockImplementation(() => process);
		child.emit("close", 0, null);
		await promise;
		assert.deepEqual(off.mock.calls.map(([event]) => event).sort(), ["SIGHUP", "SIGINT", "SIGTERM", "exit"]);
	});

	test("a failing exit reports the code, or the signal when there is no code", async () => {
		captureHandlers();
		let child = fakeChild();
		let run = start(child, gone);
		child.emit("close", 2, null);
		await assert.rejects(run.promise, /^Error: Command failed \(2\): tool a b$/);
		child = fakeChild();
		run = start(child, gone);
		child.emit("close", null, "SIGKILL");
		await assert.rejects(run.promise, /^Error: Command failed \(SIGKILL\): tool a b$/);
	});

	test("a missing binary names the toolchain; other spawn errors pass through", async () => {
		captureHandlers();
		let child = fakeChild(null);
		let run = start(child, gone);
		child.emit("error", sysError("spawn tool ENOENT", "ENOENT"));
		await assert.rejects(run.promise, /^Error: 'tool' was not found on PATH\. Install the Rust toolchain/);
		child = fakeChild(null);
		run = start(child, gone);
		const failure = sysError("denied", "EACCES");
		child.emit("error", failure);
		await assert.rejects(run.promise, (actual) => actual === failure);
	});

	test("failed cleanup after success rejects with the cleanup error; after a failed command it aggregates both", async () => {
		captureHandlers();
		const probeFailure = sysError("io error", "EIO");
		let child = fakeChild();
		let run = start(child, () => { throw probeFailure; });
		child.emit("close", 0, null);
		await assert.rejects(run.promise, (actual) => actual === probeFailure);
		child = fakeChild();
		run = start(child, () => { throw probeFailure; });
		child.emit("close", 1, null);
		await assert.rejects(run.promise, (actual) => actual instanceof AggregateError
			&& actual.errors[1] === probeFailure
			&& /^Command failed \(1\): tool a b; process-group cleanup also failed\.$/.test(actual.message));
	});

	test("the exit backstop kills a live group once, and never a reaped or unownable one", async () => {
		const handlers = captureHandlers();
		const signalled = [];
		const live = (pid, signal) => { signalled.push([pid, signal]); return true; };
		let child = fakeChild();
		let run = start(child, live);
		handlers.get("exit")();
		assert.deepEqual(signalled, [[-4_000_001, 0], [-4_000_001, "SIGKILL"]]);
		// The reaping probes never reach ESRCH; the fast clock ends the budget at once.
		fastForwardClock();
		child.emit("close", 0, null);
		await assert.rejects(run.promise, /remained non-empty after SIGKILL cleanup/);

		// After a successful reap the id may be recycled: the backstop must stay silent.
		signalled.length = 0;
		child = fakeChild();
		let alive = true;
		const dying = (pid, signal) => { signalled.push([pid, signal]); if (!alive) gone(); return true; };
		run = start(child, dying);
		alive = false;
		child.emit("close", 0, null);
		await run.promise;
		signalled.length = 0;
		handlers.get("exit")();
		assert.deepEqual(signalled, []);

		// A pid-less child is never signalled.
		child = fakeChild(null);
		run = start(child, live);
		signalled.length = 0;
		handlers.get("exit")();
		assert.deepEqual(signalled, []);
		child.emit("error", new Error("spawn failed"));
		await assert.rejects(run.promise);
	});

	test("the exit backstop swallows an ownership failure and then stays silent", async () => {
		const handlers = captureHandlers();
		const calls = [];
		const child = fakeChild();
		const run = start(child, (pid, signal) => { calls.push(signal); throw sysError("boom", "EIO"); });
		handlers.get("exit")();
		handlers.get("exit")();
		assert.deepEqual(calls, [0], "the first failure revokes the backstop");
		child.emit("close", 0, null);
		await assert.rejects(run.promise);
	});

	test("an unexplained EPERM gets no exit KILL", async () => {
		const handlers = captureHandlers();
		const calls = [];
		const child = fakeChild();
		const run = start(child, (pid, signal) => { calls.push(signal); if (signal === 0) throw sysError("eperm", "EPERM"); return true; }, () => { throw new Error("ps timed out"); });
		handlers.get("exit")();
		assert.deepEqual(calls, [0]);
		fastForwardClock();
		child.emit("close", 0, null);
		await assert.rejects(run.promise, /^Error: eperm$/);
	});

	/**
	 * Make every `Date.now()` jump a second so each reap stage hits its deadline on its first probe.
	 * @returns {void}
	 * @throws {never} Pure.
	 */
	function fastForwardClock() {
		let clock = 1_800_000_000_000;
		vi.spyOn(Date, "now").mockImplementation(() => (clock += 1000));
	}

	test("a group that survives SIGTERM and then vanishes at SIGKILL is reaped", async () => {
		fastForwardClock();
		const sent = [];
		let dead = false;
		await reapProcessGroup(4_000_002, (pid, signal) => {
			sent.push(signal);
			if (dead) gone();
			if (signal === "SIGKILL") dead = true;
			return true;
		}, () => []);
		assert.deepEqual(sent.filter((signal) => typeof signal === "string"), ["SIGTERM", "SIGKILL"]);
	});

	test("a group that exits between the TERM stage and the KILL is not signalled again", async () => {
		fastForwardClock();
		const sent = [];
		await reapProcessGroup(4_000_002, (pid, signal) => {
			sent.push(signal);
			if (signal === "SIGKILL") gone();
			return true;
		}, () => []);
		assert.deepEqual(sent.filter((signal) => typeof signal === "string"), ["SIGTERM", "SIGKILL"]);
	});

	test("a group that outlives SIGKILL rejects, and the exit backstop stays armed for it", async () => {
		const handlers = captureHandlers();
		fastForwardClock();
		const sent = [];
		const child = fakeChild();
		const run = start(child, (pid, signal) => { sent.push(signal); return true; });
		child.emit("close", 0, null);
		await assert.rejects(run.promise, /^Error: Process group 4000001 remained non-empty after SIGKILL cleanup\.$/);
		sent.length = 0;
		handlers.get("exit")();
		assert.deepEqual(sent, [0, "SIGKILL"], "exit still kills the surviving group");
	});

	test("a termination signal reaps the group, then exits 128 plus the signal number", async () => {
		const handlers = captureHandlers();
		const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined);
		const child = fakeChild();
		const run = start(child, gone);
		handlers.get("SIGINT")("SIGINT");
		handlers.get("SIGTERM")("SIGUSR9");
		await vi.waitFor(() => assert.equal(exit.mock.calls.length, 2));
		assert.deepEqual(exit.mock.calls.map(([code]) => code), [128 + realOs.constants.signals.SIGINT, 143]);
		child.emit("close", 0, null);
		await run.promise;
	});

	test("a termination signal whose cleanup fails logs it and still exits", async () => {
		const handlers = captureHandlers();
		const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined);
		const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const child = fakeChild();
		const run = start(child, () => { throw sysError("probe failed", "EIO"); });
		handlers.get("SIGHUP")("SIGHUP");
		await vi.waitFor(() => assert.equal(exit.mock.calls.length, 1));
		assert.deepEqual(errors.mock.calls[0], ["Process-group cleanup failed: probe failed"]);
		assert.equal(exit.mock.calls[0][0], 128 + realOs.constants.signals.SIGHUP);
		child.emit("close", 0, null);
		run.promise.catch(() => {});
	});
});

describe("withDirectoryLock", () => {
	afterEach(() => vi.restoreAllMocks());

	/** @returns {Promise<string>} Fresh scratch directory. @throws {Error} On filesystem failure. */
	async function scratch() {
		const dir = await realFs.mkdtemp(path.join(realOs.tmpdir(), "cu-lock-"));
		scratchDirs.push(dir);
		return dir;
	}

	test("runs the callback under the lock and releases it, even when the callback throws", async () => {
		const lock = path.join(await scratch(), "l.lock");
		assert.equal(await withDirectoryLock(lock, async () => (await present(lock) ? "held" : "free")), "held");
		assert.equal(await present(lock), false);
		await assert.rejects(withDirectoryLock(lock, async () => { throw new Error("inside"); }), /inside/);
		assert.equal(await present(lock), false);
	});

	test("a live lock times out; a failure other than EEXIST is rethrown", async () => {
		const dir = await scratch();
		const lock = path.join(dir, "l.lock");
		await realFs.mkdir(lock);
		await assert.rejects(withDirectoryLock(lock, async () => "x", { waitMs: 30, retryMs: 5 }), /^Error: Timed out waiting for local signing identity lock at /);
		await assert.rejects(withDirectoryLock(path.join(dir, "missing", "l.lock"), async () => "x"), /ENOENT/);
	});

	test("a stale lock is broken even when the first removal fails, and a failing release is tolerated", async () => {
		const dir = await scratch();
		const lock = path.join(dir, "l.lock");
		await realFs.mkdir(lock);
		const old = new Date(Date.now() - 3_600_000);
		await realFs.utimes(lock, old, old);
		const realRm = realFs.rm;
		let failures = 0;
		vi.spyOn(realFs, "rm").mockImplementation(async (target, options) => {
			if (failures++ === 0) throw sysError("busy", "EBUSY");
			return realRm(target, options);
		});
		assert.equal(await withDirectoryLock(lock, async () => "ok", { staleMs: 1000, retryMs: 1 }), "ok");
		assert.ok(failures >= 2);

		vi.restoreAllMocks();
		vi.spyOn(realFs, "rm").mockRejectedValue(sysError("busy", "EBUSY"));
		assert.equal(await withDirectoryLock(lock, async () => "again"), "again", "a failed release does not fail the callback");
		assert.equal(await present(lock), true, "the lock is left behind for the stale sweep");
	});

	test("a lock that vanishes between the EEXIST and the stat is simply retried", async () => {
		const lock = path.join(await scratch(), "l.lock");
		await realFs.mkdir(lock);
		const realStat = realFs.stat;
		vi.spyOn(realFs, "stat").mockImplementationOnce(async (target) => {
			await realFs.rm(lock, { recursive: true });
			return realStat(target);
		});
		assert.equal(await withDirectoryLock(lock, async () => "won", { retryMs: 1 }), "won");
	});
});
