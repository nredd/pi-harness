import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { collectSourceHashes, parseArgs, runCoverage, TOOL_VERSION } from "../scripts/rust-coverage.mjs";

test("hashes nested Windows fixture files, never their directory entries", () => {
	const crateRoot = fileURLToPath(new URL("../native/windows/bridge-rs/", import.meta.url));
	const hashes = collectSourceHashes(crateRoot);
	const nested = "tests/fixtures/disposable_windows_fixture.rs";
	assert.equal(
		hashes[nested],
		createHash("sha256")
			.update(readFileSync(path.join(crateRoot, nested)))
			.digest("hex"),
	);
	assert.equal(Object.hasOwn(hashes, "tests/fixtures"), false);
	assert.deepEqual(Object.keys(hashes), Object.keys(hashes).sort());
	assert.equal(
		hashes["Cargo.toml"],
		createHash("sha256")
			.update(readFileSync(path.join(crateRoot, "Cargo.toml")))
			.digest("hex"),
	);
});

test("source hashes include nested changes and reject linked inputs", () => {
	const crateRoot = mkdtempSync(path.join(os.tmpdir(), "cu-source-hashes-"));
	try {
		mkdirSync(path.join(crateRoot, "src", "empty"), { recursive: true });
		mkdirSync(path.join(crateRoot, "tests", "fixtures", "nested"), { recursive: true });
		for (const name of ["Cargo.toml", "Cargo.lock", "src/lib.rs", "tests/fixtures/nested/owned.rs"])
			writeFileSync(path.join(crateRoot, name), name);
		const before = collectSourceHashes(crateRoot);
		assert.deepEqual(Object.keys(before), ["Cargo.lock", "Cargo.toml", "src/lib.rs", "tests/fixtures/nested/owned.rs"]);
		writeFileSync(path.join(crateRoot, "tests/fixtures/nested/owned.rs"), "changed");
		assert.notEqual(
			collectSourceHashes(crateRoot)["tests/fixtures/nested/owned.rs"],
			before["tests/fixtures/nested/owned.rs"],
		);
		symlinkSync(path.join(crateRoot, "src"), path.join(crateRoot, "tests", "linked"), "junction");
		assert.throws(() => collectSourceHashes(crateRoot), /Unsupported native source input: tests\/linked/);
	} finally {
		rmSync(crateRoot, { recursive: true, force: true });
	}
});

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
	const result = spawnSync(
		process.execPath,
		[fileURLToPath(new URL("../scripts/rust-coverage.mjs", import.meta.url))],
		{
			env: { ...process.env, PATH: "" },
			encoding: "utf8",
		},
	);
	assert.equal(result.status, 1);
	assert.match(
		result.stderr,
		/Missing cargo-llvm-cov; install pinned cargo-llvm-cov and llvm-tools-preview per the package README/,
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
		const run = path.join(
			output,
			readdirSync(output).find((entry) => entry.startsWith("linux-") || entry.startsWith("windows-")),
		);
		assert.deepEqual(readFileSync(path.join(output, "coverage.json")), readFileSync(path.join(run, "coverage.json")));
		assert.ok(commands.slice(1).every(({ args }) => args.includes("--disable-default-ignore-filename-regex")));
		assert.match(readFileSync(path.join(run, "summary.txt"), "utf8"), /TOTAL/);
		const metadata = JSON.parse(readFileSync(path.join(run, "metadata.json"), "utf8"));
		assert.equal(metadata.arch, process.arch);
		assert.deepEqual(metadata.unmeasured, ["branches", "statements"]);
		const crate = process.platform === "win32" ? "windows" : "linux";
		const crateRoot = fileURLToPath(new URL(`../native/${crate}/bridge-rs/`, import.meta.url));
		const inputs = [
			"Cargo.lock",
			"Cargo.toml",
			...["src", "tests"].flatMap((directory) =>
				readdirSync(path.join(crateRoot, directory), { recursive: true })
					.filter((name) => statSync(path.join(crateRoot, directory, name)).isFile())
					.map((name) => `${directory}/${name}`.replaceAll("\\", "/")),
			),
		].sort();
		assert.deepEqual(Object.keys(metadata.sourceHashes), inputs);
		for (const name of inputs)
			assert.equal(
				metadata.sourceHashes[name],
				createHash("sha256")
					.update(readFileSync(path.join(crateRoot, name)))
					.digest("hex"),
			);
		assert.ok(metadata.elapsedSeconds >= 0);
		assert.equal(metadata.commandSeconds.length, 4);
		assert.ok(metadata.commandSeconds.every((seconds) => seconds >= 0));
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
