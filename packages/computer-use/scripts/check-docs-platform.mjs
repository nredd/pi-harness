#!/usr/bin/env node
// Generate/check docs under both registration platforms without launching any helper or GUI tool.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const generator = new URL("./docs-generators/generate-tool-reference.mjs", import.meta.url).href;
const root = fileURLToPath(new URL("..", import.meta.url));
for (const platform of ["linux", "darwin"]) {
	const source = `Object.defineProperty(process, "platform", { value: ${JSON.stringify(platform)} });
process.argv.push("--check");
await import(${JSON.stringify(generator)});`;
	const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", source], {
		cwd: root,
		encoding: "utf8",
		timeout: 30_000,
	});
	assert.ifError(result.error);
	assert.equal(result.status, 0, `tool reference must be identical on ${platform}: ${result.stdout}\n${result.stderr}`);
}
console.log("Tool documentation is host-independent on linux and darwin.");
