#!/usr/bin/env node
// Generate/check docs under both registration platforms without launching any helper or GUI tool.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const generators = ["generate-tool-reference.mjs", "generate-source-references.mjs"].map(
	(name) => new URL(`./docs-generators/${name}`, import.meta.url).href,
);
const root = fileURLToPath(new URL("..", import.meta.url));
/** Run both real generator subprocesses, refusing launch errors and divergent checked-in output. */
export function main(_argv = process.argv.slice(2), deps = { spawn: spawnSync, log: console.log }) {
	for (const platform of ["linux", "darwin"]) {
		const source = `Object.defineProperty(process, "platform", { value: ${JSON.stringify(platform)} });
for (const generator of ${JSON.stringify(generators)}) {
	const { main } = await import(generator);
	const code = main(["--check"]);
	if (code !== 0) process.exit(code);
}`;
		const result = deps.spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", source], {
			cwd: root,
			encoding: "utf8",
			timeout: 30_000,
		});
		assert.ifError(result.error);
		assert.equal(
			result.status,
			0,
			`generated references must be identical on ${platform}: ${result.stdout}\n${result.stderr}`,
		);
	}
	deps.log("Tool and configuration/source documentation is host-independent on linux and darwin.");
	return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
