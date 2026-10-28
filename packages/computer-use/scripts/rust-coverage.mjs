#!/usr/bin/env node
// Opt-in report-only native coverage. No thresholds and no normal-check invocation.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const TOOL_VERSION = "0.9.1";

/** Parse explicit platform/output arguments without interpreting shell fragments.
 * @param {string[]} args CLI arguments.
 * @param {string} platform Host platform.
 * @returns {{crate: string, output: string | undefined}} Validated selection.
 * @throws {Error} On unsupported platforms or arguments.
 */
export function parseArgs(args, platform = process.platform) {
	let crate = platform === "win32" ? "windows" : "linux";
	let output;
	const seen = new Set();
	for (let index = 0; index < args.length; index += 2) {
		const flag = args[index];
		const value = args[index + 1];
		if (!["--crate", "--output"].includes(flag) || !value || value.startsWith("--") || seen.has(flag)) {
			throw new Error("Usage: coverage:rust -- [--crate linux|windows] [--output directory]");
		}
		seen.add(flag);
		if (flag === "--crate") crate = value;
		else output = path.resolve(value);
	}
	if (!["linux", "windows"].includes(crate)) throw new Error("--crate must be linux or windows");
	if (crate === "windows" && platform !== "win32")
		throw new Error(
			"Windows coverage requires a Windows runner; cross-platform protocol tests are not Windows coverage",
		);
	if (crate === "linux" && !["linux", "darwin"].includes(platform))
		throw new Error("Linux crate coverage requires Linux or macOS (macOS excludes Linux-gated code)");
	return { crate, output };
}

/** Collect tests once, then render LCOV, JSON and a per-file summary from that run.
 * @param {string[]} args CLI arguments.
 * @param {typeof spawnSync} spawn Process runner, injectable for deterministic tests.
 * @returns {void}
 * @throws {Error} On tool, instrumentation, test or report failures.
 */
export function runCoverage(args, spawn = spawnSync) {
	const { crate, output } = parseArgs(args);
	const version = spawn("cargo", ["llvm-cov", "--version"], { encoding: "utf8" });
	if (version.error || version.status !== 0)
		throw new Error(
			"Missing cargo-llvm-cov; install pinned cargo-llvm-cov and llvm-tools-preview using docs/rust-coverage.md",
		);
	if (version.stdout.trim() !== `cargo-llvm-cov ${TOOL_VERSION}`)
		throw new Error(`Expected cargo-llvm-cov ${TOOL_VERSION}; see docs/rust-coverage.md`);
	const directory = output ?? mkdtempSync(path.join(os.tmpdir(), `cu-rust-coverage-${crate}-`));
	// Never clean a caller's output or reuse instrumented profiles from an earlier run.
	mkdirSync(directory, { recursive: true });
	const run = mkdtempSync(path.join(directory, `${crate}-`));
	const manifest = path.join(root, "native", crate, "bridge-rs", "Cargo.toml");
	const env = {
		...process.env,
		CARGO_TARGET_DIR: path.join(run, "target"),
		CARGO_BUILD_JOBS: process.env.CARGO_BUILD_JOBS ?? "2",
	};
	const started = Date.now();
	const commands = [];
	const execute = (parameters) => {
		commands.push(parameters);
		const result = spawn("cargo", ["llvm-cov", ...parameters], {
			cwd: root,
			env,
			encoding: "utf8",
			timeout: 900_000,
			maxBuffer: 32 * 1024 * 1024,
		});
		writeFileSync(path.join(run, "commands.log"), `${commands.map((command) => JSON.stringify(command)).join("\n")}\n`);
		writeFileSync(path.join(run, "run.log"), `${result.stdout ?? ""}\n${result.stderr ?? ""}`, { flag: "a" });
		if (result.error || result.status !== 0)
			throw new Error(
				`cargo llvm-cov failed (${result.error?.message ?? result.status}); inspect ${run}/run.log; install matching llvm-tools-preview per docs/rust-coverage.md`,
			);
		return result.stdout;
	};
	try {
		execute(["test", "--locked", "--manifest-path", manifest, "--no-report"]);
		for (const [format, filename] of [
			["--lcov", "lcov.info"],
			["--json", "coverage.json"],
		]) {
			execute(["report", "--manifest-path", manifest, format, "--output-path", path.join(run, filename)]);
		}
		writeFileSync(path.join(run, "summary.txt"), execute(["report", "--manifest-path", manifest]));
		for (const filename of ["lcov.info", "coverage.json", "summary.txt"]) {
			if (!existsSync(path.join(run, filename)) || !readFileSync(path.join(run, filename), "utf8").trim())
				throw new Error(`Empty coverage report: ${filename}`);
		}
		const report = JSON.parse(readFileSync(path.join(run, "coverage.json"), "utf8"));
		if (
			!report.data?.some((data) =>
				data.files?.some((file) => file.filename.replaceAll("\\", "/").includes(`${crate}/bridge-rs/src/`)),
			)
		)
			throw new Error("Coverage report has no intended crate source");
		if (!readFileSync(path.join(run, "lcov.info"), "utf8").replaceAll("\\", "/").includes(`${crate}/bridge-rs/src/`))
			throw new Error("LCOV report has no intended crate source");
		if (!readFileSync(path.join(run, "summary.txt"), "utf8").includes("TOTAL"))
			throw new Error("Coverage summary has no totals");
	} finally {
		writeFileSync(
			path.join(run, "metadata.json"),
			JSON.stringify(
				{
					crate,
					platform: process.platform,
					tool: version.stdout.trim(),
					elapsedSeconds: (Date.now() - started) / 1000,
					commands,
				},
				null,
				2,
			),
		);
		console.log(`Rust coverage reports: ${run}`);
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	try {
		runCoverage(process.argv.slice(2));
	} catch (error) {
		console.error(error.message);
		process.exitCode = 1;
	}
}
