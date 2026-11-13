#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
// `setup-helper.mjs` builds the per-user macOS app from these arch-specific
// payloads at install time. The upstream release workflow also produces a signed
// universal app, but that release-only artifact is not source-controlled. Linux
// ships its locked Rust crate source (no target/ or tests/) for the opt-in cargo build.
const linuxCrate = [
	"Cargo.toml",
	"Cargo.lock",
	...["atspi", "error", "lib", "main", "protocol", "state", "wayland", "x11"].map((name) => `src/${name}.rs`),
];
const expected = [
	"package/docs/content/docs/how-to-guides/linux.mdx",
	"package/native/macos/activity_glow.swift",
	...linuxCrate.map((file) => `package/native/linux/bridge-rs/${file}`),
	"package/native/macos/agent_cursor.swift",
	"package/native/macos/agent_cursor_motion.swift",
	"package/native/macos/bridge.swift",
	"package/native/macos/helper_entry.swift",
	"package/prebuilt/macos/arm64/bridge",
	"package/prebuilt/macos/x64/bridge",
];

/** Inspect the actual archive listing, cleaning up only an archive created by this invocation. */
export async function main(argv = process.argv.slice(2), deps = { exec: execFileAsync, remove: rm, log: console.log }) {
	const suppliedTarball = argv[0];
	const tarball = suppliedTarball ?? (await createTarball(deps.exec));
	try {
		const { stdout } = await deps.exec("tar", ["-tzf", tarball], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
		const files = new Set(stdout.split("\n").filter(Boolean));
		for (const file of expected) assert.ok(files.has(file), `npm package is missing ${file}`);
		const stray = [...files].filter((file) =>
			/^package\/(native\/linux\/bridge-rs\/(target|tests)\/|prebuilt\/linux\/)/.test(file),
		);
		assert.deepEqual(stray, [], "npm package must not ship Linux build output, crate tests or prebuilts");
	} finally {
		if (!suppliedTarball) await deps.remove(tarball, { force: true });
	}
	deps.log("package assets passed");
	return 0;
}

async function createTarball(exec) {
	const { stdout } = await exec("npm", ["pack", "--ignore-scripts", "--silent"], {
		encoding: "utf8",
		maxBuffer: 1024 * 1024,
	});
	const filename = stdout
		.trim()
		.split("\n")
		.reverse()
		.find((line) => line.endsWith(".tgz"));
	assert.ok(filename, "npm pack did not produce a tarball");
	return filename;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
