import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseArgs, runCoverage, TOOL_VERSION } from "./rust-coverage.mjs";

test("validates crate/arguments and resolves output paths without shell interpolation", () => {
	assert.deepEqual(parseArgs(["--crate", "linux", "--output", "space ; $dir"], "darwin"), {
		crate: "linux",
		output: path.resolve("space ; $dir"),
	});
	assert.equal(parseArgs([], "win32").crate, "windows");
	for (const args of [
		["--crate"],
		["--bogus", "x"],
		["--crate", "../linux"],
		["--output", "--crate"],
		["--crate", "linux", "--crate", "linux"],
	])
		assert.throws(() => parseArgs(args, "darwin"));
	assert.throws(() => parseArgs(["--crate", "windows"], "darwin"), /Windows runner/);
	assert.throws(() => parseArgs(["--crate", "windows"], "linux"), /Windows runner/);
});

test("missing cargo tool gives actionable pinned install documentation", () => {
	const result = spawnSync(process.execPath, [fileURLToPath(new URL("./rust-coverage.mjs", import.meta.url))], {
		env: { ...process.env, PATH: "" },
		encoding: "utf8",
	});
	assert.equal(result.status, 1);
	assert.match(
		result.stderr,
		/Missing cargo-llvm-cov; install pinned cargo-llvm-cov and llvm-tools-preview using docs\/rust-coverage.md/,
	);
});

test("collects tests once with locked manifests and renders all formats from isolated profiles", () => {
	const output = mkdtempSync(path.join(os.tmpdir(), "cu-coverage-test-"));
	const commands = [];
	try {
		runCoverage(["--output", output], (_command, args, options) => {
			if (args.includes("--version")) return { status: 0, stdout: `cargo-llvm-cov ${TOOL_VERSION}\n` };
			commands.push({ args, options });
			const index = args.indexOf("--output-path");
			if (index !== -1)
				writeFileSync(
					args[index + 1],
					args.includes("--json")
						? JSON.stringify({
								data: [
									{
										files: [{ filename: `${process.platform === "win32" ? "windows" : "linux"}/bridge-rs/src/lib.rs` }],
									},
								],
							})
						: `SF:${process.platform === "win32" ? "windows" : "linux"}/bridge-rs/src/lib.rs\nend_of_record\n`,
				);
			return { status: 0, stdout: "TOTAL summary\n" };
		});
		assert.equal(commands.length, 4);
		assert.ok(commands[0].args.includes("--locked"));
		assert.ok(commands[0].args.includes("--no-report"));
		assert.equal(commands.filter(({ args }) => args.includes("test")).length, 1);
		assert.equal(new Set(commands.map(({ options }) => options.env.CARGO_TARGET_DIR)).size, 1);
		assert.ok(commands.every(({ options }) => options.env.CARGO_TARGET_DIR.startsWith(output)));
		const run = path.join(output, readdirSync(output)[0]);
		assert.match(readFileSync(path.join(run, "summary.txt"), "utf8"), /TOTAL/);
		assert.ok(JSON.parse(readFileSync(path.join(run, "metadata.json"), "utf8")).elapsedSeconds >= 0);
		assert.throws(
			() => runCoverage([], () => ({ status: 0, stdout: "cargo-llvm-cov wrong" })),
			/Expected cargo-llvm-cov/,
		);
		assert.throws(
			() =>
				runCoverage(["--output", output], (_command, args) =>
					args.includes("--version")
						? { status: 0, stdout: `cargo-llvm-cov ${TOOL_VERSION}` }
						: { status: 1, stderr: "bad test" },
				),
			/cargo llvm-cov failed/,
		);
	} finally {
		rmSync(output, { recursive: true, force: true });
	}
});
