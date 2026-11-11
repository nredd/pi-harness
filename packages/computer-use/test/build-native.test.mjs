import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { main, run, runCli } from "../scripts/build-native.mjs";

const scriptPath = fileURLToPath(new URL("../scripts/build-native.mjs", import.meta.url));
const X64_TRIPLE = "x86_64-unknown-linux-gnu";
const ARM_TRIPLE = "aarch64-unknown-linux-gnu";

let sandbox;
let rootDir;
let tmpdir;
let cwd;

beforeEach(() => {
	sandbox = mkdtempSync(path.join(os.tmpdir(), "cu-build-native-"));
	rootDir = path.join(sandbox, "pkg");
	tmpdir = path.join(sandbox, "tmp");
	cwd = path.join(sandbox, "cwd");
	for (const dir of [rootDir, tmpdir, cwd]) mkdirSync(dir, { recursive: true });
});

afterEach(() => {
	rmSync(sandbox, { recursive: true, force: true });
});

function elf(machine) {
	const header = Buffer.alloc(24);
	Buffer.from([0x7f, 0x45, 0x4c, 0x46]).copy(header);
	header.writeUInt16LE(machine, 18);
	return header;
}

function write(file, content) {
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, content);
}

/** Fake `run` recording argv and emulating the artifacts each toolchain would leave behind. */
function harness({ cargoOutput, fail } = {}) {
	const calls = [];
	const log = [];
	const fakeRun = async (command, args) => {
		calls.push([command, args]);
		if (fail?.(command, args)) throw new Error(`Command failed (1): ${command}`);
		if (command === "xcrun") write(args[args.indexOf("-o") + 1], "swift");
		if (command === "lipo") write(args[args.indexOf("-output") + 1], "lipo");
		if (command === "cargo") {
			const manifest = args[args.indexOf("--manifest-path") + 1];
			const crateDir = path.dirname(manifest);
			const target = args.includes("--target") ? args[args.indexOf("--target") + 1] : undefined;
			const release = target ? path.join(crateDir, "target", target, "release") : path.join(crateDir, "target", "release");
			const name = manifest.includes("windows") ? "windows-bridge.exe" : "linux-bridge";
			const content = typeof cargoOutput === "function" ? cargoOutput(target) : cargoOutput;
			if (content !== null) write(path.join(release, name), content ?? (manifest.includes("windows") ? "MZ-pe" : elf(0x3e)));
		}
	};
	const deps = (extra = {}) => ({ run: fakeRun, rootDir, tmpdir, cwd, env: {}, log: (line) => log.push(line), platform: "darwin", arch: "arm64", ...extra });
	return { calls, log, deps };
}

const mac = (...parts) => path.join(rootDir, "prebuilt", "macos", ...parts);

test("macOS arm64 build compiles with swiftc, chmods and ad-hoc signs", async () => {
	const h = harness();
	await main([], h.deps());
	assert.deepEqual(
		h.calls.map(([command]) => command),
		["xcrun", "codesign"],
	);
	const [, swift] = h.calls[0];
	assert.equal(swift[0], "swiftc");
	assert.equal(swift[swift.indexOf("-target") + 1], "arm64-apple-macosx14.0");
	assert.ok(swift.includes("-O"));
	for (const framework of ["ApplicationServices", "AppKit", "ScreenCaptureKit", "Foundation", "SwiftUI"]) {
		assert.equal(swift[swift.indexOf(framework) - 1], "-framework");
	}
	const sources = swift.filter((arg) => arg.endsWith(".swift")).map((arg) => path.relative(path.join(rootDir, "native", "macos"), arg));
	assert.deepEqual(sources, ["activity_glow.swift", "agent_cursor.swift", "agent_cursor_motion.swift", "bridge.swift"]);
	assert.equal(swift.at(-2), "-o");
	assert.equal(swift.at(-1), mac("arm64", "bridge"));
	assert.deepEqual(h.calls[1][1], ["--force", "-i", "com.injaneity.pi-computer-use", "--timestamp=none", "--sign", "-", mac("arm64", "bridge")]);
	assert.equal(statSync(mac("arm64", "bridge")).mode & 0o777, 0o755);
	assert.deepEqual(h.log, ["Building native helper for arm64...", `Built helper at ${mac("arm64", "bridge")}`]);
	assert.deepEqual(readdirSync(tmpdir), [], "swift module cache is removed");
});

test("x64 and --platform darwin on a foreign host honour --output relative to cwd", async () => {
	const h = harness();
	await main(["--platform", "darwin", "--arch", "x64", "--output", "out/bridge"], h.deps({ platform: "freebsd" }));
	const [, swift] = h.calls[0];
	assert.equal(swift[swift.indexOf("-target") + 1], "x86_64-apple-macosx14.0");
	assert.equal(swift.at(-1), path.join(cwd, "out", "bridge"));
	assert.ok(existsSync(path.join(cwd, "out", "bridge")));
});

test("codesign flags come from arguments, then environment, then defaults", async () => {
	const h = harness();
	await main(
		["--arch", "x64", "--sign-identity", "Dev ID", "--sign-identifier", "com.example.cli", "--hardened-runtime", "--timestamp"],
		h.deps({ env: { PI_COMPUTER_USE_CODESIGN_IDENTITY: "env-id", PI_COMPUTER_USE_CODESIGN_IDENTIFIER: "env.ident" } }),
	);
	assert.deepEqual(h.calls[1][1], ["--force", "-i", "com.example.cli", "--options", "runtime", "--timestamp", "--sign", "Dev ID", mac("x64", "bridge")]);

	const env = harness();
	await main(["--arch", "x64"], env.deps({ env: { PI_COMPUTER_USE_CODESIGN_IDENTITY: "env-id", PI_COMPUTER_USE_CODESIGN_IDENTIFIER: "env.ident" } }));
	assert.deepEqual(env.calls[1][1], ["--force", "-i", "env.ident", "--timestamp=none", "--sign", "env-id", mac("x64", "bridge")]);
});

test("signing is skipped by --no-sign and PI_COMPUTER_USE_NO_SIGN=1", async () => {
	const flag = harness();
	await main(["--no-sign"], flag.deps());
	const env = harness();
	await main([], env.deps({ env: { PI_COMPUTER_USE_NO_SIGN: "1" } }));
	for (const h of [flag, env]) assert.deepEqual(h.calls.map(([command]) => command), ["xcrun"]);
});

test("a failing swiftc still removes the module cache and skips signing", async () => {
	const h = harness({ fail: (command) => command === "xcrun" });
	await expect(main([], h.deps())).rejects.toThrow(/Command failed \(1\): xcrun/);
	assert.deepEqual(readdirSync(tmpdir), []);
	assert.ok(!h.calls.some(([command]) => command === "codesign"));
});

test("a failing codesign propagates", async () => {
	const h = harness({ fail: (command) => command === "codesign" });
	await expect(main([], h.deps())).rejects.toThrow(/codesign/);
});

test("--arch all builds both macOS slices and rejects --output", async () => {
	const h = harness();
	await main(["--arch", "all", "--no-sign"], h.deps());
	assert.deepEqual(
		h.calls.map(([, args]) => args.at(-1)),
		[mac("x64", "bridge"), mac("arm64", "bridge")],
	);
	await expect(main(["--arch", "all", "--output", "x"], h.deps())).rejects.toThrow(/--output is not supported with --arch all/);
});

test("--arch universal builds both slices, lipo-merges and signs", async () => {
	const h = harness();
	await main(["--arch", "universal"], h.deps());
	assert.deepEqual(
		h.calls.map(([command]) => command),
		["xcrun", "codesign", "xcrun", "codesign", "lipo", "codesign"],
	);
	const lipo = h.calls[4][1];
	assert.deepEqual(lipo.slice(0, 2), ["-create", "-output"]);
	assert.equal(lipo[2], mac("universal", "bridge"));
	assert.ok(lipo[3].endsWith("bridge-x64") && lipo[4].endsWith("bridge-arm64"));
	assert.equal(statSync(mac("universal", "bridge")).mode & 0o777, 0o755);
	assert.equal(h.calls[5][1].at(-1), mac("universal", "bridge"));
	assert.ok(h.log.includes(`Built universal helper at ${mac("universal", "bridge")}`));
	assert.deepEqual(readdirSync(tmpdir), [], "temporary slices are removed");
});

test("a failing lipo aborts the universal build", async () => {
	const h = harness({ fail: (command) => command === "lipo" });
	await expect(main(["--arch", "universal", "--no-sign"], h.deps())).rejects.toThrow(/lipo/);
	assert.ok(!existsSync(mac("universal", "bridge")));
});

test("unsupported architectures are rejected", async () => {
	await expect(main(["--arch", "ppc"], harness().deps())).rejects.toThrow("Unsupported architecture 'ppc'. Supported: arm64, x64, universal, all.");
});

test("a flag without a value is ignored and defaults apply", async () => {
	const h = harness();
	await main(["--no-sign", "--arch"], h.deps({ arch: "x64" }));
	assert.equal(h.calls[0][1].at(-1), mac("x64", "bridge"));
});

test("unsupported host platforms skip with guidance", async () => {
	const h = harness();
	await main([], h.deps({ platform: "freebsd" }));
	assert.deepEqual(h.calls, []);
	assert.match(h.log[0], /Skipping native build: unsupported platform "freebsd"\. Use --platform windows or --platform linux/);
});

const win = (...parts) => path.join(rootDir, "native", "windows", "bridge-rs", ...parts);

test("Windows host builds with cargo, validates the PE header and copies to prebuilt", async () => {
	const h = harness();
	await main([], h.deps({ platform: "win32" }));
	assert.deepEqual(h.calls, [["cargo", ["build", "--release", "--manifest-path", win("Cargo.toml")]]]);
	const dest = path.join(rootDir, "prebuilt", "windows", "windows-bridge.exe");
	assert.ok(existsSync(dest));
	assert.equal(statSync(dest).mode & 0o777, 0o755);
	assert.deepEqual(h.log, ["Building Windows helper with cargo...", `Built Windows helper at ${dest}`]);
});

test("--platform windows from a non-Windows host needs a Windows target triple", async () => {
	const refused = harness();
	await expect(main(["--platform", "windows"], refused.deps())).rejects.toThrow(/Refusing to label a host binary as Windows/);
	assert.deepEqual(refused.calls, []);
	await expect(main(["--platform", "windows", "--target", "x86_64-unknown-linux-gnu"], refused.deps())).rejects.toThrow(/Refusing/);

	const h = harness();
	await main(["--platform", "windows", "--target", "x86_64-pc-windows-msvc", "--output", "dist/windows-bridge.exe"], h.deps());
	assert.deepEqual(h.calls[0][1].slice(-2), ["--target", "x86_64-pc-windows-msvc"]);
	assert.ok(existsSync(path.join(cwd, "dist", "windows-bridge.exe")));
});

test("a non-PE cargo output is rejected and a missing one fails", async () => {
	await expect(main(["--platform", "windows"], harness({ cargoOutput: "ELF!" }).deps({ platform: "win32" }))).rejects.toThrow(/not a Windows PE executable/);
	rmSync(path.join(rootDir, "native"), { recursive: true, force: true });
	await expect(main([], harness({ cargoOutput: null }).deps({ platform: "win32" }))).rejects.toThrow(/ENOENT/);
});

const lin = (...parts) => path.join(rootDir, "native", "linux", "bridge-rs", ...parts);
const linuxOut = (arch) => path.join(rootDir, "prebuilt", "linux", arch, "linux-bridge");

test("Linux host building its own arch passes no --target", async () => {
	const h = harness({ cargoOutput: elf(0x3e) });
	await main([], h.deps({ platform: "linux", arch: "x64" }));
	assert.deepEqual(h.calls, [["cargo", ["build", "--release", "--manifest-path", lin("Cargo.toml")]]]);
	assert.ok(existsSync(linuxOut("x64")));
	assert.equal(statSync(linuxOut("x64")).mode & 0o777, 0o755);
	assert.ok(h.log.includes(`Built Linux helper at ${linuxOut("x64")}`));
});

test("cross-arch and cross-platform Linux builds select the matching triple", async () => {
	const arm = harness({ cargoOutput: elf(0xb7) });
	await main(["--platform", "linux", "--arch", "arm64"], arm.deps({ platform: "linux", arch: "x64" }));
	assert.deepEqual(arm.calls[0][1].slice(-2), ["--target", ARM_TRIPLE]);
	assert.ok(existsSync(linuxOut("arm64")));

	const mac64 = harness({ cargoOutput: elf(0x3e) });
	await main(["--platform", "linux", "--arch", "x64", "--output", "bin/bridge"], mac64.deps());
	assert.deepEqual(mac64.calls[0][1].slice(-2), ["--target", X64_TRIPLE]);
	assert.ok(existsSync(path.join(cwd, "bin", "bridge")));

	const explicit = harness({ cargoOutput: elf(0xb7) });
	await main(["--platform", "linux", "--arch", "arm64", "--target", "aarch64-unknown-linux-musl"], explicit.deps());
	assert.deepEqual(explicit.calls[0][1].slice(-2), ["--target", "aarch64-unknown-linux-musl"]);
});

test("Linux --arch all builds x64 then arm64 and rejects --output and universal", async () => {
	const h = harness({ cargoOutput: (target) => (target === ARM_TRIPLE ? elf(0xb7) : elf(0x3e)) });
	await main(["--arch", "all"], h.deps({ platform: "linux", arch: "riscv64" }));
	assert.deepEqual(
		h.calls.map(([, args]) => args.at(-1)),
		[X64_TRIPLE, ARM_TRIPLE],
	);
	assert.ok(existsSync(linuxOut("x64")) && existsSync(linuxOut("arm64")));
	await expect(main(["--arch", "all", "--output", "o"], h.deps({ platform: "linux" }))).rejects.toThrow(/--output is not supported with --arch all/);
	await expect(main(["--arch", "universal"], h.deps({ platform: "linux" }))).rejects.toThrow(/Linux does not support --arch universal/);
	await expect(main(["--arch", "mips"], h.deps({ platform: "linux" }))).rejects.toThrow(/Unsupported architecture 'mips'/);
});

test("Linux rejects non-Linux targets, non-ELF output, truncated output and arch mismatches", async () => {
	await expect(main(["--platform", "linux", "--target", "x86_64-pc-windows-msvc"], harness().deps())).rejects.toThrow(
		"Linux builds require a Linux --target triple, got x86_64-pc-windows-msvc.",
	);
	const bad = async (cargoOutput, arch) => {
		rmSync(path.join(rootDir, "native"), { recursive: true, force: true });
		await main(["--platform", "linux", "--arch", arch], harness({ cargoOutput }).deps());
	};
	await expect(bad(Buffer.from("not an elf binary at all!!"), "x64")).rejects.toThrow(/not a Linux ELF executable/);
	await expect(bad(elf(0x3e).subarray(0, 10), "x64")).rejects.toThrow(/not a Linux ELF executable/);
	await expect(bad(elf(0xb7), "x64")).rejects.toThrow(/architecture does not match x64/);
	await expect(bad(elf(0x3e), "arm64")).rejects.toThrow(/architecture does not match arm64/);
	await expect(bad(null, "x64")).rejects.toThrow(/ENOENT/);
});

test("run() resolves on exit 0 and rejects on failure or spawn error", async () => {
	await run(process.execPath, ["-e", "process.exit(0)"]);
	await expect(run(process.execPath, ["-e", "process.exit(3)"])).rejects.toThrow(/Command failed \(3\): .*node.* -e process\.exit\(3\)/);
	await expect(run(path.join(sandbox, "no-such-binary"), [])).rejects.toThrow(/ENOENT/);
});

test("runCli maps success to 0 and failures to a printed message and exit code 1", async () => {
	const errors = [];
	const h = harness();
	assert.equal(await runCli(["--no-sign"], { ...h.deps(), error: (m) => errors.push(m) }), 0);
	assert.equal(await runCli(["--arch", "x"], { ...h.deps(), error: (m) => errors.push(m) }), 1);
	assert.equal(
		await runCli([], {
			...h.deps(),
			run: async () => {
				throw "plain string";
			},
			error: (m) => errors.push(m),
		}),
		1,
	);
	assert.deepEqual(errors, ["Unsupported architecture 'x'. Supported: arm64, x64, universal, all.", "plain string"]);
	const spy = vi.spyOn(console, "error").mockImplementation(() => {});
	try {
		assert.equal(await runCli(["--arch", "x"]), 1);
		assert.equal(spy.mock.calls.length, 1);
	} finally {
		spy.mockRestore();
	}
});

test("main with no injected deps uses process defaults", async () => {
	await expect(main(["--platform", "darwin", "--arch", "bad"])).rejects.toThrow(/Unsupported architecture/);
});

test("running the script as the entry point sets the exit code", async () => {
	const argv = process.argv;
	const exitCode = process.exitCode;
	const spy = vi.spyOn(console, "error").mockImplementation(() => {});
	try {
		vi.resetModules();
		process.argv = [argv[0], scriptPath, "--platform", "darwin", "--arch", "bogus"];
		await import("../scripts/build-native.mjs");
		assert.equal(process.exitCode, 1);
		assert.match(spy.mock.calls[0][0], /Unsupported architecture 'bogus'/);
		vi.resetModules();
		process.argv = [argv[0], undefined];
		process.exitCode = undefined;
		await import("../scripts/build-native.mjs");
		assert.equal(process.exitCode, undefined, "no entry script means nothing runs");
	} finally {
		process.argv = argv;
		process.exitCode = exitCode;
		spy.mockRestore();
		vi.resetModules();
	}
});

test("a symlinked entry path still runs the script instead of silently exiting 0", async () => {
	const argv = process.argv;
	const exitCode = process.exitCode;
	const spy = vi.spyOn(console, "error").mockImplementation(() => {});
	try {
		const link = path.join(sandbox, "linked-build-native.mjs");
		symlinkSync(scriptPath, link);
		vi.resetModules();
		process.exitCode = undefined;
		process.argv = [argv[0], link, "--platform", "darwin", "--arch", "bogus"];
		await import("../scripts/build-native.mjs");
		assert.equal(process.exitCode, 1);
		assert.match(spy.mock.calls[0][0], /Unsupported architecture 'bogus'/);
	} finally {
		process.argv = argv;
		process.exitCode = exitCode;
		spy.mockRestore();
		vi.resetModules();
	}
});
