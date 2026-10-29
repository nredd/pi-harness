#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
// `setup-helper.mjs` builds the per-user macOS app from these arch-specific
// payloads at install time. The upstream release workflow also produces a signed
// universal app, but that release-only artifact is not source-controlled. Linux
// ships its locked Rust crate source (no target/ or tests/) for the opt-in cargo build.
const linuxCrate = ["Cargo.toml", "Cargo.lock", ...["atspi", "error", "lib", "main", "protocol", "state", "wayland", "x11"].map((name) => `src/${name}.rs`)];
const expected = [
	"package/docs/content/docs/how-to-guides/linux.mdx",
	"package/native/macos/activity_glow.swift",
	...linuxCrate.map((file) => `package/native/linux/bridge-rs/${file}`),
	"package/native/macos/agent_cursor.swift",
	"package/native/macos/agent_cursor_motion.swift",
	"package/native/macos/bridge.swift",
	"package/prebuilt/macos/arm64/bridge",
	"package/prebuilt/macos/x64/bridge",
];

const suppliedTarball = process.argv[2];
const tarball = suppliedTarball ?? await createTarball();
try {
	const { stdout } = await execFileAsync("tar", ["-tzf", tarball], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
	const files = new Set(stdout.split("\n").filter(Boolean));
	for (const file of expected) assert.ok(files.has(file), `npm package is missing ${file}`);
	const stray = [...files].filter((file) => /^package\/(native\/linux\/bridge-rs\/(target|tests)\/|prebuilt\/linux\/)/.test(file));
	assert.deepEqual(stray, [], "npm package must not ship Linux build output, crate tests or prebuilts");
} finally {
	if (!suppliedTarball) await rm(tarball, { force: true });
}
console.log("package assets passed");

async function createTarball() {
	const { stdout } = await execFileAsync("npm", ["pack", "--ignore-scripts", "--silent"], { encoding: "utf8", maxBuffer: 1024 * 1024 });
	const filename = stdout.trim().split("\n").reverse().find((line) => line.endsWith(".tgz"));
	assert.ok(filename, "npm pack did not produce a tarball");
	return filename;
}
