#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptsDir, "..");
const [buildSource, setupSource, packageSource, helperSource, waylandSource, nativeSource] = await Promise.all([
	fs.readFile(path.join(scriptsDir, "build-native.mjs"), "utf8"),
	fs.readFile(path.join(scriptsDir, "setup-helper.mjs"), "utf8"),
	fs.readFile(path.join(rootDir, "package.json"), "utf8"),
	fs.readFile(path.join(rootDir, "src", "platform", "linux", "helper.ts"), "utf8"),
	fs.readFile(path.join(rootDir, "native", "linux", "bridge-rs", "src", "wayland.rs"), "utf8"),
	fs.readFile(path.join(rootDir, "native", "linux", "bridge-rs", "src", "main.rs"), "utf8"),
]);
const pkg = JSON.parse(packageSource);
assert.match(buildSource, /explicitPlatform === "linux"/);
assert.match(buildSource, /prebuilt", "linux", arch, "linux-bridge"/);
assert.match(buildSource, /x86_64-unknown-linux-gnu/);
assert.match(buildSource, /aarch64-unknown-linux-gnu/);
assert.match(setupSource, /PI_COMPUTER_USE_LINUX_HELPER_PATH/);
assert.match(setupSource, /prebuilt", "linux", arch, "linux-bridge"/);
assert.match(setupSource, /allowLinuxBuildFallback = args\.has\("--allow-build"\) \|\| process\.env\.PI_COMPUTER_USE_ALLOW_BUILD === "1"/);
assert.match(helperSource, /\.pi", "agent", "helpers", "pi-computer-use", "linux-bridge"/);
assert.match(waylandSource, /pub async fn probe/);
assert.doesNotMatch(waylandSource, /start_remote_desktop|ActivePortalSession|NotifyPointer/);
assert.doesNotMatch(nativeSource, /x11_window\.unwrap_or\(root\.pid/);
assert.match(nativeSource, /"readText": \{"requested":read_text,"executed":false\}/);
// Linux ships the locked crate source (exact files, never the directory) and no prebuilt.
assert.match(setupSource, /"cargo", \["build", "--locked", "--release"/);
assert.match(setupSource, /"--target-dir", linuxBuildTargetDir/);
assert.ok(!pkg.files.includes("native/linux/bridge-rs"));
assert.ok(!pkg.files.includes("prebuilt/linux"));
const crateDir = path.join(rootDir, "native", "linux", "bridge-rs");
const crateFiles = [];
for (const entry of await fs.readdir(crateDir, { recursive: true, withFileTypes: true })) {
	const relative = path.relative(crateDir, path.join(entry.parentPath, entry.name)).split(path.sep).join("/");
	if (entry.isFile() && !/^(target|tests)\//.test(relative) && relative !== ".gitignore") crateFiles.push(`native/linux/bridge-rs/${relative}`);
}
assert.deepEqual(pkg.files.filter((file) => file.startsWith("native/linux/")).sort(), crateFiles.sort(), "package.json `files` must list exactly the crate sources (no target/ or tests/)");
assert.ok(pkg.files.includes("docs/linux.md"));

// Rust and TypeScript must agree on the wire protocol and shared architecture contract.
const [protocolRs, architectureTs, linuxDoc] = await Promise.all([
	fs.readFile(path.join(crateDir, "src", "protocol.rs"), "utf8"),
	fs.readFile(path.join(rootDir, "src", "platform", "architecture.ts"), "utf8"),
	fs.readFile(path.join(rootDir, "docs", "linux.md"), "utf8"),
]);
assert.equal(protocolRs.match(/PROTOCOL_VERSION: u32 = (\d+)/)?.[1], helperSource.match(/LINUX_HELPER_PROTOCOL_VERSION = (\d+)/)?.[1], "Rust and TS protocol versions drifted");
assert.equal(nativeSource.match(/"architectureVersion": (\d+)/)?.[1], architectureTs.match(/PLATFORM_ARCHITECTURE_VERSION = (\d+)/)?.[1], "architecture versions drifted");
const rustInvariants = [...(nativeSource.match(/"invariants": \[([^\]]*)\]/)?.[1] ?? "").matchAll(/"([a-z-]+)"/g)].map((match) => match[1]);
const tsInvariants = [...(architectureTs.match(/REQUIRED_PLATFORM_INVARIANTS = \[([^\]]*)\]/)?.[1] ?? "").matchAll(/"([a-z-]+)"/g)].map((match) => match[1]);
assert.ok(tsInvariants.length > 0);
assert.deepEqual(rustInvariants, tsInvariants, "Rust and TS architecture invariants drifted");
assert.match(linuxDoc, /PI_COMPUTER_USE_ALLOW_BUILD=1/, "docs/linux.md must document the opt-in source build");
assert.match(linuxDoc, /cargo/);
assert.equal(pkg.scripts["build:linux"], "node scripts/build-native.mjs --platform linux");

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-computer-use-linux-scripts-"));
const helperDest = path.join(tempDir, "linux-bridge");
try {
	const fixtureScriptsDir = path.join(tempDir, "scripts");
	const fixtureHelperPathDir = path.join(tempDir, "src", "platform", "macos");
	await Promise.all([
		fs.mkdir(fixtureScriptsDir, { recursive: true }),
		fs.mkdir(fixtureHelperPathDir, { recursive: true }),
	]);
	await Promise.all([
		fs.copyFile(path.join(scriptsDir, "setup-helper.mjs"), path.join(fixtureScriptsDir, "setup-helper.mjs")),
		fs.copyFile(
			path.join(rootDir, "src", "platform", "macos", "helper-path.mjs"),
			path.join(fixtureHelperPathDir, "helper-path.mjs"),
		),
	]);
	let fixtureEntry = path.join(fixtureScriptsDir, "setup-helper.mjs");
	const linkedTempDir = `${tempDir}-link`;
	if (process.platform !== "win32") {
		await fs.symlink(tempDir, linkedTempDir);
		fixtureEntry = path.join(linkedTempDir, "scripts", "setup-helper.mjs");
	}
	const result = await new Promise((resolve) => {
		const child = spawn(process.execPath, [fixtureEntry, "--platform", "linux"], { env: { ...process.env, PI_COMPUTER_USE_LINUX_HELPER_PATH: helperDest }, stdio: ["ignore", "pipe", "pipe"] });
		let output = "";
		child.stdout.on("data", (chunk) => { output += chunk; }); child.stderr.on("data", (chunk) => { output += chunk; });
		child.on("close", (code) => resolve({ code, output }));
	});
	assert.equal(result.code, 1);
	assert.match(result.output, /No Linux prebuilt helper found for (x64|arm64)/);
	assert.equal(await fs.stat(helperDest).then(() => true, () => false), false);
} finally {
	await fs.rm(`${tempDir}-link`, { force: true });
	await fs.rm(tempDir, { recursive: true, force: true });
}

// ---- runCancellable reaps its whole process group, even descendants that ignore SIGTERM (POSIX) ----
if (process.platform !== "win32") {
	const groupDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-computer-use-cancel-"));
	const setupUrl = pathToFileURL(path.join(scriptsDir, "setup-helper.mjs")).href;
	const wrapper = path.join(groupDir, "wrapper.mjs");
	await fs.writeFile(wrapper, `import { runCancellable } from ${JSON.stringify(setupUrl)};\nawait runCancellable("sh", [process.argv[2]]);\nconsole.log("wrapper-ok");\n`);
	const { GROUP_TERM_GRACE_MS, GROUP_KILL_WAIT_MS } = await import(setupUrl);
	// The reap budget must fit the caller's 2s SIGKILL backstop (`SETUP_KILL_GRACE_MS` in helper.ts), by construction.
	const reapBudgetMs = GROUP_TERM_GRACE_MS + GROUP_KILL_WAIT_MS;
	assert.ok(reapBudgetMs < 2000, `reap budget ${reapBudgetMs}ms no longer fits the 2s outer backstop`);
	const CI_HEADROOM_MS = 1500; // process spawn and scheduler jitter on loaded runners
	const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; } };
	const settled = async (pid, timeoutMs) => {
		for (const deadline = Date.now() + timeoutMs; alive(pid) && Date.now() < deadline;) await new Promise((r) => setTimeout(r, 20));
		return !alive(pid);
	};
	const waitFor = async (file) => {
		for (let i = 0; i < 200; i += 1) { const text = await fs.readFile(file, "utf8").catch(() => ""); if (text.trim()) return Number(text); await new Promise((r) => setTimeout(r, 25)); }
		throw new Error(`timed out waiting for ${file}`);
	};
	// The descendant ignores TERM (the disposition survives exec). The leader either waits (and dies on TERM) or exits first.
	const fakeCargo = (name, leaderWaits) => `#!/bin/sh\necho $$ > ${groupDir}/${name}.leader\n( trap '' TERM; exec sleep 300 ) &\necho $! > ${groupDir}/${name}.desc\n${leaderWaits ? "wait" : "exit 0"}\n`;
	const spawned = [];
	try {
		for (const [name, leaderWaits, terminate] of [["term-leader-waits", true, true], ["leader-exits-first", false, false]]) {
			const script = path.join(groupDir, `${name}.sh`);
			await fs.writeFile(script, fakeCargo(name, leaderWaits));
			const child = spawn(process.execPath, [wrapper, script], { stdio: ["ignore", "pipe", "pipe"] });
			let output = "";
			child.stdout.on("data", (chunk) => { output += chunk; });
			child.stderr.on("data", (chunk) => { output += chunk; });
			const closed = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
			const descendant = await waitFor(path.join(groupDir, `${name}.desc`));
			const leader = await waitFor(path.join(groupDir, `${name}.leader`));
			spawned.push(descendant);
			const started = Date.now();
			if (terminate) { assert.ok(alive(descendant), `${name}: descendant must be running before SIGTERM`); child.kill("SIGTERM"); }
			const result = await closed;
			const elapsed = Date.now() - started;
			// The TERM-ignoring descendant forces escalation: not before the TERM grace, and bounded by the reap budget.
			assert.ok(elapsed >= GROUP_TERM_GRACE_MS - 250, `${name}: wrapper returned after ${elapsed}ms, before the ${GROUP_TERM_GRACE_MS}ms TERM grace (no SIGKILL escalation?)`);
			assert.ok(elapsed < reapBudgetMs + CI_HEADROOM_MS, `${name}: wrapper took ${elapsed}ms, past the ${reapBudgetMs}ms reap budget`);
			if (terminate) assert.equal(result.code, 143, `${name}: ${JSON.stringify(result)} ${output}`);
			else assert.equal(result.code, 0, `${name}: ${output}`);
			assert.equal(await settled(descendant, 300), true, `${name}: TERM-ignoring descendant ${descendant} survived the wrapper (orphaned compiler)`);
			assert.equal(await settled(leader, 300), true, `${name}: leader ${leader} survived`);
			assert.equal(alive(-leader), false, `${name}: process group ${leader} still has members`);
		}
	} finally {
		for (const pid of spawned) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
		await fs.rm(groupDir, { recursive: true, force: true });
	}
}
console.log("Linux build/setup script checks passed");
