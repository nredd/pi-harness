import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

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
