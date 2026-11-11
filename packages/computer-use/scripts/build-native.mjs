#!/usr/bin/env node

import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// `scripts/package_contracts.py` parses this declaration from the packed script: keep it a plain literal list plus `.map`.
const macosSourcePaths = [
	"activity_glow.swift",
	"agent_cursor.swift",
	"agent_cursor_motion.swift",
	"bridge.swift",
].map((file) => path.join("native", "macos", file));
const linuxTargets = { x64: "x86_64-unknown-linux-gnu", arm64: "aarch64-unknown-linux-gnu" };
const archTriples = {
	arm64: "arm64-apple-macosx",
	x64: "x86_64-apple-macosx",
};
const deploymentTarget = "14.0";
const frameworks = ["ApplicationServices", "AppKit", "ScreenCaptureKit", "Foundation", "SwiftUI"];
const defaultCodeSignIdentifier = "com.injaneity.pi-computer-use";

/**
 * Spawn a child with inherited stdio.
 * @param {string} command Executable.
 * @param {string[]} args Arguments.
 * @returns {Promise<void>} Resolves on exit 0, rejects otherwise.
 */
export async function run(command, args) {
	await new Promise((resolve, reject) => {
		const child = spawn(command, args, { stdio: "inherit" });
		child.on("error", reject);
		child.on("close", (code) => {
			if (code === 0) {
				resolve();
				return;
			}
			reject(new Error(`Command failed (${code}): ${command} ${args.join(" ")}`));
		});
	});
}

/**
 * Resolve the injectable process seams for one invocation.
 * @param {string[]} argv CLI arguments (without node and script).
 * @param {object} [deps] Overrides: `run`, `platform`, `arch`, `env`, `cwd`, `rootDir`, `tmpdir`, `log`.
 * @returns {object} Complete context.
 */
function createContext(argv, deps = {}) {
	return {
		argv,
		run: deps.run ?? run,
		platform: deps.platform ?? process.platform,
		arch: deps.arch ?? process.arch,
		env: deps.env ?? process.env,
		cwd: deps.cwd ?? process.cwd(),
		rootDir: deps.rootDir ?? packageRoot,
		tmpdir: deps.tmpdir ?? os.tmpdir(),
		log: deps.log ?? console.log,
	};
}

function getArg(ctx, name) {
	const index = ctx.argv.indexOf(name);
	if (index >= 0 && index + 1 < ctx.argv.length) {
		return ctx.argv[index + 1];
	}
	return undefined;
}

function hasArg(ctx, name) {
	return ctx.argv.includes(name);
}

function normalizeArch(arch) {
	if (arch === "universal" || arch === "all") return arch;
	if (arch === "arm64" || arch === "x64") return arch;
	throw new Error(`Unsupported architecture '${arch}'. Supported: arm64, x64, universal, all.`);
}

function defaultOutputPath(ctx, arch) {
	return path.join(ctx.rootDir, "prebuilt", "macos", arch, "bridge");
}

function swiftArgsForArch(ctx, arch, outputPath, moduleCachePath) {
	const args = [
		"swiftc",
		"-target",
		`${archTriples[arch]}${deploymentTarget}`,
		"-module-cache-path",
		moduleCachePath,
		"-O",
	];
	for (const framework of frameworks) args.push("-framework", framework);
	args.push(...macosSourcePaths.map((file) => path.join(ctx.rootDir, file)), "-o", outputPath);
	return args;
}

async function signBinary(ctx, outputPath) {
	if (hasArg(ctx, "--no-sign") || ctx.env.PI_COMPUTER_USE_NO_SIGN === "1") {
		return;
	}

	const identity = getArg(ctx, "--sign-identity") ?? ctx.env.PI_COMPUTER_USE_CODESIGN_IDENTITY ?? "-";
	const identifier = getArg(ctx, "--sign-identifier") ?? ctx.env.PI_COMPUTER_USE_CODESIGN_IDENTIFIER ?? defaultCodeSignIdentifier;
	const args = ["--force", "-i", identifier];
	if (hasArg(ctx, "--hardened-runtime")) {
		args.push("--options", "runtime");
	}
	if (hasArg(ctx, "--timestamp")) {
		args.push("--timestamp");
	} else {
		args.push("--timestamp=none");
	}
	args.push("--sign", identity, outputPath);
	await ctx.run("codesign", args);
}

async function buildForArch(ctx, arch, outputPath) {
	await fs.mkdir(path.dirname(outputPath), { recursive: true });
	ctx.log(`Building native helper for ${arch}...`);
	// A private, owned module cache: a fixed name in a shared `os.tmpdir()` (`/tmp` for several
	// accounts on one host) is owned by whoever built first and denies everyone else.
	const moduleCachePath = await fs.mkdtemp(path.join(ctx.tmpdir, "pi-computer-use-swift-module-cache-"));
	try {
		await ctx.run("xcrun", swiftArgsForArch(ctx, arch, outputPath, moduleCachePath));
	} finally {
		await fs.rm(moduleCachePath, { recursive: true, force: true });
	}
	await fs.chmod(outputPath, 0o755);
	await signBinary(ctx, outputPath);
	ctx.log(`Built helper at ${outputPath}`);
}

async function buildUniversal(ctx, outputPath) {
	const tempDir = await fs.mkdtemp(path.join(ctx.tmpdir, "pi-computer-use-build-"));
	const x64Output = path.join(tempDir, "bridge-x64");
	const arm64Output = path.join(tempDir, "bridge-arm64");
	await buildForArch(ctx, "x64", x64Output);
	await buildForArch(ctx, "arm64", arm64Output);
	await fs.mkdir(path.dirname(outputPath), { recursive: true });
	await ctx.run("lipo", ["-create", "-output", outputPath, x64Output, arm64Output]);
	await fs.chmod(outputPath, 0o755);
	await signBinary(ctx, outputPath);
	ctx.log(`Built universal helper at ${outputPath}`);
	await fs.rm(tempDir, { recursive: true, force: true });
}

/**
 * Return the cargo binary path. The crate always emits `windows-bridge.exe`.
 */
function windowsBinaryPath(crateDir, target) {
	const releaseDir = target
		? path.join(crateDir, "target", target, "release")
		: path.join(crateDir, "target", "release");
	return path.join(releaseDir, "windows-bridge.exe");
}

async function buildWindowsHelper(ctx, prebuiltOutput) {
	const windowsCrateDir = path.join(ctx.rootDir, "native", "windows", "bridge-rs");
	const target = getArg(ctx, "--target");
	if (ctx.platform !== "win32" && !target?.includes("windows")) {
		throw new Error("Refusing to label a host binary as Windows. Build on Windows or pass an explicit Windows --target triple.");
	}
	const prebuiltDir = prebuiltOutput
		? path.resolve(ctx.cwd, prebuiltOutput, "..")
		: path.join(ctx.rootDir, "prebuilt", "windows");
	const manifestPath = path.join(windowsCrateDir, "Cargo.toml");

	ctx.log("Building Windows helper with cargo...");
	const cargoArgs = [
		"build",
		"--release",
		"--manifest-path",
		manifestPath,
	];
	if (target) cargoArgs.push("--target", target);
	await ctx.run("cargo", cargoArgs);

	await fs.mkdir(prebuiltDir, { recursive: true });

	const cargoOutput = windowsBinaryPath(windowsCrateDir, target);
	const handle = await fs.open(cargoOutput, "r");
	try {
		const signature = Buffer.alloc(2);
		await handle.read(signature, 0, 2, 0);
		if (signature.toString("ascii") !== "MZ") {
			throw new Error(`Cargo output is not a Windows PE executable: ${cargoOutput}`);
		}
	} finally {
		await handle.close();
	}
	const prebuiltDest = path.join(prebuiltDir, "windows-bridge.exe");
	await fs.copyFile(cargoOutput, prebuiltDest);
	await fs.chmod(prebuiltDest, 0o755);
	ctx.log(`Built Windows helper at ${prebuiltDest}`);
}

function linuxBinaryPath(crateDir, target) {
	const targetDir = target ? path.join("target", target) : "target";
	return path.join(crateDir, targetDir, "release", "linux-bridge");
}

function defaultLinuxOutputPath(ctx, arch) {
	return path.join(ctx.rootDir, "prebuilt", "linux", arch, "linux-bridge");
}

async function buildLinuxForArch(ctx, arch, outputPath) {
	const linuxCrateDir = path.join(ctx.rootDir, "native", "linux", "bridge-rs");
	const explicitTarget = getArg(ctx, "--target");
	if (explicitTarget && !explicitTarget.includes("linux")) throw new Error(`Linux builds require a Linux --target triple, got ${explicitTarget}.`);
	const target = explicitTarget ?? (ctx.platform === "linux" && ctx.arch === arch ? undefined : linuxTargets[arch]);
	ctx.log(`Building Linux helper for ${arch} with cargo...`);
	const cargoArgs = ["build", "--release", "--manifest-path", path.join(linuxCrateDir, "Cargo.toml")];
	if (target) cargoArgs.push("--target", target);
	await ctx.run("cargo", cargoArgs);
	const cargoOutput = linuxBinaryPath(linuxCrateDir, target);
	const header = await fs.readFile(cargoOutput).then((data) => data.subarray(0, 20));
	if (header.length < 20 || !header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) throw new Error(`Cargo output is not a Linux ELF executable: ${cargoOutput}`);
	const machine = header.readUInt16LE(18);
	const expectedMachine = arch === "x64" ? 0x3e : 0xb7;
	if (machine !== expectedMachine) throw new Error(`Cargo output architecture does not match ${arch}: ${cargoOutput}`);
	await fs.mkdir(path.dirname(outputPath), { recursive: true });
	await fs.copyFile(cargoOutput, outputPath);
	await fs.chmod(outputPath, 0o755);
	ctx.log(`Built Linux helper at ${outputPath}`);
}

async function buildLinuxHelper(ctx) {
	const arch = normalizeArch(getArg(ctx, "--arch") ?? ctx.arch);
	if (arch === "universal") throw new Error("Linux does not support --arch universal. Use x64, arm64, or all.");
	const outputArg = getArg(ctx, "--output");
	if (arch === "all") {
		if (outputArg) throw new Error("--output is not supported with --arch all. Use a single architecture for one output.");
		for (const nextArch of ["x64", "arm64"]) await buildLinuxForArch(ctx, nextArch, defaultLinuxOutputPath(ctx, nextArch));
		return;
	}
	await buildLinuxForArch(ctx, arch, outputArg ? path.resolve(ctx.cwd, outputArg) : defaultLinuxOutputPath(ctx, arch));
}

/**
 * Build the native helper for the selected or host platform.
 * @param {string[]} argv CLI arguments (without node and script).
 * @param {object} [deps] Process seams, see `createContext`.
 * @returns {Promise<void>}
 * @throws {Error} On bad arguments, failed children or invalid cargo output.
 */
export async function main(argv, deps) {
	const ctx = createContext(argv, deps);
	const explicitPlatform = getArg(ctx, "--platform");

	if (explicitPlatform === "windows") {
		await buildWindowsHelper(ctx, getArg(ctx, "--output"));
		return;
	}

	if (explicitPlatform === "linux") {
		await buildLinuxHelper(ctx);
		return;
	}

	if (explicitPlatform === "darwin") {
		// Fall through to macOS build logic below.
	} else if (ctx.platform === "win32") {
		await buildWindowsHelper(ctx, getArg(ctx, "--output"));
		return;
	} else if (ctx.platform === "linux") {
		await buildLinuxHelper(ctx);
		return;
	} else if (ctx.platform !== "darwin") {
		ctx.log(
			`Skipping native build: unsupported platform "${ctx.platform}". ` +
				"Use --platform windows or --platform linux to build a helper, or run on macOS for the macOS helper.",
		);
		return;
	}

	const arch = normalizeArch(getArg(ctx, "--arch") ?? ctx.arch);
	const outputArg = getArg(ctx, "--output");

	if (arch === "all") {
		if (outputArg) {
			throw new Error("--output is not supported with --arch all. Use a single architecture for one output.");
		}
		for (const nextArch of ["x64", "arm64"]) {
			await buildForArch(ctx, nextArch, defaultOutputPath(ctx, nextArch));
		}
		return;
	}

	const outputPath = outputArg ? path.resolve(ctx.cwd, outputArg) : defaultOutputPath(ctx, arch);
	if (arch === "universal") {
		await buildUniversal(ctx, outputPath);
		return;
	}

	await buildForArch(ctx, arch, outputPath);
}

/**
 * CLI wrapper: run `main`, print the error message and return the exit code.
 * @param {string[]} argv CLI arguments.
 * @param {object} [deps] Process seams plus `error` (stderr logger).
 * @returns {Promise<number>} Process exit code.
 */
export async function runCli(argv, deps = {}) {
	try {
		await main(argv, deps);
		return 0;
	} catch (error) {
		(deps.error ?? console.error)(error instanceof Error ? error.message : String(error));
		return 1;
	}
}

if (process.argv[1] && realpathSync(path.resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
	process.exitCode = await runCli(process.argv.slice(2));
}
