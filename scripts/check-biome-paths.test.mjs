import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test, vi } from "vitest";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const biome = join(root, "node_modules/.bin/biome");
const checkPaths = join(root, "scripts/check-biome-paths.mjs");

function run(command, args, cwd) {
	return spawnSync(command, args, { cwd, encoding: "utf8" });
}

test("rejects a missing path that Biome accepts beside a valid path", () => {
	const fixture = mkdtempSync(join(tmpdir(), "pi-biome-paths-"));
	try {
		const valid = join(fixture, "valid.ts");
		const missing = join(fixture, "missing");
		writeFileSync(valid, "export const answer = 42;\n");

		const biomeResult = run(biome, ["check", valid, missing], fixture);
		assert.equal(biomeResult.status, 0, biomeResult.stderr);
		assert.match(biomeResult.stderr, /No such file or directory/);

		for (const args of [
			[valid, missing],
			["--write", valid, missing],
		]) {
			const result = run(process.execPath, [checkPaths, ...args], fixture);
			assert.equal(result.status, 1, result.stderr);
			assert.match(result.stderr, new RegExp(`Biome paths do not exist: .*${missing}`));
		}
	} finally {
		rmSync(fixture, { recursive: true, force: true });
	}
});

// The preflight is a CLI script: its body runs at import, reading `process.argv`. Each case below
// re-imports it in process (so V8 coverage sees it) with a fresh module registry and its own argv.
// `spawnSync` is faked only where real Biome cannot fail the way the case needs.
const argv = process.argv;

afterEach(() => {
	process.argv = argv;
	process.exitCode = undefined;
	vi.doUnmock("node:child_process");
	vi.restoreAllMocks();
});

/** Import the preflight once with `args`, returning its exit code and what it printed to stderr. */
async function runInProcess(args, spawnResult) {
	vi.resetModules();
	const calls = [];
	if (spawnResult)
		vi.doMock("node:child_process", () => ({
			spawnSync: (...call) => {
				calls.push(call);
				return spawnResult;
			},
		}));
	const errors = [];
	vi.spyOn(console, "error").mockImplementation((line) => errors.push(line));
	process.argv = [argv[0] ?? "node", checkPaths, ...args];
	await import(checkPaths);
	const exitCode = process.exitCode;
	process.exitCode = undefined;
	return { exitCode, stderr: errors.join("\n"), calls };
}

test("in process: existing paths run real Biome check, with and without --write", async () => {
	const fixture = mkdtempSync(join(tmpdir(), "pi-biome-paths-"));
	try {
		const valid = join(fixture, "valid.ts");
		writeFileSync(valid, "export const answer = 42;\n");
		assert.equal((await runInProcess([valid])).exitCode, 0);
		assert.equal((await runInProcess(["--write", valid])).exitCode, 0);
		writeFileSync(valid, "export const answer = 42\n");
		assert.equal((await runInProcess([valid])).exitCode, 1);
	} finally {
		rmSync(fixture, { recursive: true, force: true });
	}
});

test("in process: missing paths are reported without running Biome", async () => {
	const missing = join(tmpdir(), "pi-biome-paths-missing-does-not-exist");
	const result = await runInProcess(["--write", missing], { status: 0 });
	assert.equal(result.exitCode, 1);
	assert.equal(result.stderr, `Biome paths do not exist: ${missing}`);
	assert.deepEqual(result.calls, []);
});

test("in process: no path, with or without --write, is rejected", async () => {
	for (const args of [[], ["--write"]]) {
		await assert.rejects(runInProcess(args), /Expected one or more Biome paths/);
	}
});

test("in process: a spawn failure is rethrown and a signal-killed Biome exits 1", async () => {
	const failure = new Error("spawn biome ENOENT");
	await assert.rejects(runInProcess([checkPaths], { status: null, error: failure }), failure);
	const killed = await runInProcess(["--write", checkPaths], { status: null, signal: "SIGKILL" });
	assert.equal(killed.exitCode, 1);
	assert.deepEqual(killed.calls[0]?.[1], ["check", "--write", checkPaths]);
});
