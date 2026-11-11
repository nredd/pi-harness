import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test, vi } from "vitest";
import { parseArgs, runCoverage, TOOL_VERSION } from "../scripts/rust-coverage.mjs";

const scriptPath = fileURLToPath(new URL("../scripts/rust-coverage.mjs", import.meta.url));
const crate = process.platform === "win32" ? "windows" : "linux";
const source = `${crate}/bridge-rs/src/lib.rs`;
const goodJson = JSON.stringify({ data: [{ files: [{ filename: source }] }] });
const goodLcov = `SF:${source}\nend_of_record\n`;

let output;
let logged;
beforeEach(() => {
	output = mkdtempSync(path.join(os.tmpdir(), "cu-rust-cov-errors-"));
	logged = vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
	logged.mockRestore();
	vi.unstubAllEnvs();
	rmSync(output, { recursive: true, force: true });
});

/** Fake `cargo`: answers `--version`, then writes (or withholds) each report. */
function fakeCargo({ version = { status: 0, stdout: `cargo-llvm-cov ${TOOL_VERSION}\n` }, lcov = goodLcov, json = goodJson, summary = "TOTAL 100%\n", failOn } = {}) {
	const calls = [];
	const spawn = (_command, args, options) => {
		if (args.includes("--version")) return version;
		calls.push({ args, options });
		const verb = args[1];
		const format = args.includes("--lcov") ? "lcov" : args.includes("--json") ? "json" : verb === "report" ? "summary" : "test";
		if (failOn === format) return format === "test" ? { status: 101, stderr: "boom" } : { status: 2 };
		const index = args.indexOf("--output-path");
		if (index !== -1) {
			const content = format === "lcov" ? lcov : json;
			if (content !== null) writeFileSync(args[index + 1], content);
		}
		return { status: 0, stdout: format === "summary" ? summary : "" };
	};
	return { spawn, calls };
}

const runDir = () => path.join(output, readdirSync(output)[0]);

test("rejects the Linux crate on hosts that can not build it", () => {
	assert.throws(() => parseArgs(["--crate", "linux"], "win32"), /Linux crate coverage requires Linux or macOS/);
	assert.equal(parseArgs(["--crate", "linux"], "linux").crate, "linux");
});

test("a bad crate fails before any process is spawned", () => {
	const spawn = vi.fn();
	assert.throws(() => runCoverage(["--crate", "bogus"], spawn), /--crate must be linux or windows/);
	assert.equal(spawn.mock.calls.length, 0);
	assert.throws(() => runCoverage(["--crate", "bogus"]), /--crate must be linux or windows/);
});

test("a missing or broken cargo-llvm-cov reports the pinned install docs", () => {
	for (const version of [{ error: new Error("ENOENT"), status: null, stdout: "" }, { status: 1, stdout: "" }]) {
		assert.throws(() => runCoverage(["--output", output], () => version), /Missing cargo-llvm-cov; install pinned cargo-llvm-cov/);
	}
	assert.deepEqual(readdirSync(output), [], "nothing is created before the tool check passes");
});

test("a failed cargo step reports the exit status, keeps the log and still writes metadata", () => {
	const { spawn, calls } = fakeCargo({ failOn: "test" });
	assert.throws(() => runCoverage(["--output", output], spawn), /cargo llvm-cov failed \(101\); inspect .*run\.log; install matching llvm-tools-preview/);
	assert.equal(calls.length, 1, "stops at the first failure");
	assert.match(readFileSync(path.join(runDir(), "run.log"), "utf8"), /boom/);
	const metadata = JSON.parse(readFileSync(path.join(runDir(), "metadata.json"), "utf8"));
	assert.equal(metadata.crate, crate);
	assert.equal(metadata.commands.length, 1);
	assert.equal(logged.mock.calls[0][0], `Rust coverage reports: ${runDir()}`);
});

test("a spawn error is reported by message and report-stage failures are fatal", () => {
	const spawnError = (_command, args) => (args.includes("--version") ? { status: 0, stdout: `cargo-llvm-cov ${TOOL_VERSION}` } : { error: new Error("spawn ETIMEDOUT") });
	assert.throws(() => runCoverage(["--output", output], spawnError), /cargo llvm-cov failed \(spawn ETIMEDOUT\)/);
	assert.throws(() => runCoverage(["--output", output], fakeCargo({ failOn: "lcov" }).spawn), /cargo llvm-cov failed \(2\)/);
});

test.each([
	["empty LCOV", { lcov: "  \n" }, /Empty coverage report: lcov\.info/],
	["missing JSON", { json: null }, /Empty coverage report: coverage\.json/],
	["empty summary", { summary: "\n" }, /Empty coverage report: summary\.txt/],
	["JSON without data", { json: "{}" }, /Coverage report has no intended crate source/],
	["JSON entry without files", { json: JSON.stringify({ data: [{}] }) }, /Coverage report has no intended crate source/],
	["JSON for another crate", { json: JSON.stringify({ data: [{ files: [{ filename: "other/bridge-rs/src/lib.rs" }] }] }) }, /Coverage report has no intended crate source/],
	["LCOV for another crate", { lcov: "SF:other/src/lib.rs\nend_of_record\n" }, /LCOV report has no intended crate source/],
	["summary without totals", { summary: "Filename Regions\n" }, /Coverage summary has no totals/],
])("rejects %s", (_name, overrides, message) => {
	assert.throws(() => runCoverage(["--output", output], fakeCargo(overrides).spawn), message);
	assert.ok(existsSync(path.join(runDir(), "metadata.json")), "metadata survives validation failures");
});

test("accepts Windows-style separators in report paths", () => {
	const windows = JSON.stringify({ data: [{ files: [{ filename: `C:\\x\\${crate}\\bridge-rs\\src\\lib.rs` }] }] });
	runCoverage(["--output", output], fakeCargo({ json: windows, lcov: `SF:C:\\x\\${crate}\\bridge-rs\\src\\lib.rs\n` }).spawn);
	assert.match(readFileSync(path.join(runDir(), "summary.txt"), "utf8"), /TOTAL/);
});

test("defaults the output directory to the OS tmpdir and honours CARGO_BUILD_JOBS", () => {
	for (const name of ["TMPDIR", "TEMP", "TMP"]) vi.stubEnv(name, output);
	vi.stubEnv("CARGO_BUILD_JOBS", undefined);
	const unset = fakeCargo();
	runCoverage([], unset.spawn);
	assert.equal(unset.calls[0].options.env.CARGO_BUILD_JOBS, "2");
	const [dir] = readdirSync(output);
	assert.match(dir, new RegExp(`^cu-rust-coverage-${crate}-`));

	vi.stubEnv("CARGO_BUILD_JOBS", "7");
	const set = fakeCargo();
	runCoverage([], set.spawn);
	assert.equal(set.calls[0].options.env.CARGO_BUILD_JOBS, "7");
});

test("a run without stdout or stderr still logs cleanly", () => {
	const spawn = (_command, args) => (args.includes("--version") ? { status: 0, stdout: `cargo-llvm-cov ${TOOL_VERSION}` } : { status: 1 });
	assert.throws(() => runCoverage(["--output", output], spawn), /cargo llvm-cov failed \(1\)/);
	assert.equal(readFileSync(path.join(runDir(), "run.log"), "utf8"), "\n");
});

test("running the script as the entry point prints the error and sets the exit code", async () => {
	const argv = process.argv;
	const exitCode = process.exitCode;
	const error = vi.spyOn(console, "error").mockImplementation(() => {});
	try {
		vi.resetModules();
		process.argv = [argv[0], scriptPath, "--crate", "bogus"];
		await import("../scripts/rust-coverage.mjs");
		assert.equal(process.exitCode, 1);
		assert.deepEqual(error.mock.calls, [["--crate must be linux or windows"]]);
		vi.resetModules();
		error.mockClear();
		process.exitCode = undefined;
		process.argv = [argv[0], undefined, "--crate", "bogus"];
		await import("../scripts/rust-coverage.mjs");
		assert.equal(error.mock.calls.length, 0);
		assert.equal(process.exitCode, undefined);
	} finally {
		process.argv = argv;
		process.exitCode = exitCode;
		error.mockRestore();
		vi.resetModules();
	}
});
