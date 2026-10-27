#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptsDir, "..");
const [
	buildSource,
	setupSource,
	packageSource,
	helperSource,
	waylandSource,
	nativeSource,
] = await Promise.all([
	fs.readFile(path.join(scriptsDir, "build-native.mjs"), "utf8"),
	fs.readFile(path.join(scriptsDir, "setup-helper.mjs"), "utf8"),
	fs.readFile(path.join(rootDir, "package.json"), "utf8"),
	fs.readFile(
		path.join(rootDir, "src", "platform", "linux", "helper.ts"),
		"utf8",
	),
	fs.readFile(
		path.join(rootDir, "native", "linux", "bridge-rs", "src", "wayland.rs"),
		"utf8",
	),
	fs.readFile(
		path.join(rootDir, "native", "linux", "bridge-rs", "src", "main.rs"),
		"utf8",
	),
]);
const pkg = JSON.parse(packageSource);
assert.match(buildSource, /explicitPlatform === "linux"/);
assert.match(buildSource, /prebuilt", "linux", arch, "linux-bridge"/);
assert.match(buildSource, /x86_64-unknown-linux-gnu/);
assert.match(buildSource, /aarch64-unknown-linux-gnu/);
assert.match(setupSource, /PI_COMPUTER_USE_LINUX_HELPER_PATH/);
assert.match(setupSource, /prebuilt", "linux", arch, "linux-bridge"/);
assert.match(
	setupSource,
	/allowLinuxBuildFallback = args\.has\("--allow-build"\) \|\| process\.env\.PI_COMPUTER_USE_ALLOW_BUILD === "1"/,
);
assert.match(
	helperSource,
	/\.pi", "agent", "helpers", "pi-computer-use", "linux-bridge"/,
);
assert.match(waylandSource, /pub async fn probe/);
assert.doesNotMatch(
	waylandSource,
	/start_remote_desktop|ActivePortalSession|NotifyPointer/,
);
assert.doesNotMatch(nativeSource, /x11_window\.unwrap_or\(root\.pid/);
assert.match(
	nativeSource,
	/"readText": \{"requested":read_text,"executed":false\}/,
);
// Linux ships the locked crate source (exact files, never the directory) and no prebuilt.
assert.match(setupSource, /"cargo", \["build", "--locked", "--release"/);
assert.match(setupSource, /"--target-dir", linuxBuildTargetDir/);
assert.ok(!pkg.files.includes("native/linux/bridge-rs"));
assert.ok(!pkg.files.includes("prebuilt/linux"));
const crateDir = path.join(rootDir, "native", "linux", "bridge-rs");
const crateFiles = [];
for (const entry of await fs.readdir(crateDir, {
	recursive: true,
	withFileTypes: true,
})) {
	const relative = path
		.relative(crateDir, path.join(entry.parentPath, entry.name))
		.split(path.sep)
		.join("/");
	if (
		entry.isFile() &&
		!/^(target|tests)\//.test(relative) &&
		relative !== ".gitignore"
	)
		crateFiles.push(`native/linux/bridge-rs/${relative}`);
}
assert.deepEqual(
	pkg.files.filter((file) => file.startsWith("native/linux/")).sort(),
	crateFiles.sort(),
	"package.json `files` must list exactly the crate sources (no target/ or tests/)",
);
assert.ok(pkg.files.includes("docs/linux.md"));

// Rust and TypeScript must agree on the wire protocol and shared architecture contract.
const [protocolRs, architectureTs, linuxDoc] = await Promise.all([
	fs.readFile(path.join(crateDir, "src", "protocol.rs"), "utf8"),
	fs.readFile(path.join(rootDir, "src", "platform", "architecture.ts"), "utf8"),
	fs.readFile(path.join(rootDir, "docs", "linux.md"), "utf8"),
]);
assert.equal(
	protocolRs.match(/PROTOCOL_VERSION: u32 = (\d+)/)?.[1],
	helperSource.match(/LINUX_HELPER_PROTOCOL_VERSION = (\d+)/)?.[1],
	"Rust and TS protocol versions drifted",
);
assert.equal(
	nativeSource.match(/"architectureVersion": (\d+)/)?.[1],
	architectureTs.match(/PLATFORM_ARCHITECTURE_VERSION = (\d+)/)?.[1],
	"architecture versions drifted",
);
const rustInvariants = [
	...(nativeSource.match(/"invariants": \[([^\]]*)\]/)?.[1] ?? "").matchAll(
		/"([a-z-]+)"/g,
	),
].map((match) => match[1]);
const tsInvariants = [
	...(
		architectureTs.match(/REQUIRED_PLATFORM_INVARIANTS = \[([^\]]*)\]/)?.[1] ??
		""
	).matchAll(/"([a-z-]+)"/g),
].map((match) => match[1]);
assert.ok(tsInvariants.length > 0);
assert.deepEqual(
	rustInvariants,
	tsInvariants,
	"Rust and TS architecture invariants drifted",
);
assert.match(
	linuxDoc,
	/PI_COMPUTER_USE_ALLOW_BUILD=1/,
	"docs/linux.md must document the opt-in source build",
);
assert.match(linuxDoc, /cargo/);
assert.equal(
	pkg.scripts["build:linux"],
	"node scripts/build-native.mjs --platform linux",
);

const tempDir = await fs.mkdtemp(
	path.join(os.tmpdir(), "pi-computer-use-linux-scripts-"),
);
const helperDest = path.join(tempDir, "linux-bridge");
try {
	const fixtureScriptsDir = path.join(tempDir, "scripts");
	const fixtureHelperPathDir = path.join(tempDir, "src", "platform", "macos");
	await Promise.all([
		fs.mkdir(fixtureScriptsDir, { recursive: true }),
		fs.mkdir(fixtureHelperPathDir, { recursive: true }),
	]);
	await Promise.all([
		fs.copyFile(
			path.join(scriptsDir, "setup-helper.mjs"),
			path.join(fixtureScriptsDir, "setup-helper.mjs"),
		),
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
		const child = spawn(
			process.execPath,
			[fixtureEntry, "--platform", "linux"],
			{
				env: { ...process.env, PI_COMPUTER_USE_LINUX_HELPER_PATH: helperDest },
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		let output = "";
		child.stdout.on("data", (chunk) => {
			output += chunk;
		});
		child.stderr.on("data", (chunk) => {
			output += chunk;
		});
		child.on("close", (code) => resolve({ code, output }));
	});
	assert.equal(result.code, 1);
	assert.match(result.output, /No Linux prebuilt helper found for (x64|arm64)/);
	assert.equal(
		await fs.stat(helperDest).then(
			() => true,
			() => false,
		),
		false,
	);
} finally {
	await fs.rm(`${tempDir}-link`, { force: true });
	await fs.rm(tempDir, { recursive: true, force: true });
}

// ---- runCancellable reaps its whole process group, even descendants that ignore SIGTERM (POSIX) ----
if (process.platform !== "win32") {
	const groupDir = await fs.mkdtemp(
		path.join(os.tmpdir(), "pi-computer-use-cancel-"),
	);
	const setupUrl = pathToFileURL(
		path.join(scriptsDir, "setup-helper.mjs"),
	).href;
	const {
		GROUP_TERM_GRACE_MS,
		GROUP_KILL_WAIT_MS,
		reapProcessGroup,
		runCancellable,
	} = await import(setupUrl);
	const reapBudgetMs = GROUP_TERM_GRACE_MS + GROUP_KILL_WAIT_MS;
	assert.ok(
		reapBudgetMs < 2000,
		`reap budget ${reapBudgetMs}ms no longer fits the 2s outer backstop`,
	);
	const backstopMs = reapBudgetMs + 5000;
	const alive = (pid) => {
		try {
			process.kill(pid, 0);
			return true;
		} catch (error) {
			return error.code === "EPERM";
		}
	};
	const settled = async (pid) => {
		for (
			const deadline = Date.now() + 5000;
			alive(pid) && Date.now() < deadline;
		)
			await new Promise((resolve) => setTimeout(resolve, 20));
		return !alive(pid);
	};
	const waitForReady = async (file) => {
		for (const deadline = Date.now() + 10_000; Date.now() < deadline; ) {
			const pid = Number(await fs.readFile(file, "utf8").catch(() => ""));
			if (Number.isInteger(pid) && pid > 0) return pid;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		throw new Error(`Timed out waiting for fixture signal readiness: ${file}`);
	};
	const fixture = path.join(groupDir, "fixture.mjs");
	const wrapper = path.join(groupDir, "wrapper.mjs");
	// Every marker is written by the process it identifies AFTER its TERM disposition is installed.
	// The leader cannot exit first until the test acknowledges BOTH markers via the release file.
	await fs.writeFile(
		fixture,
		`import fs from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
const [role, base, behavior] = process.argv.slice(2);
process.on("SIGTERM", role === "desc" && behavior !== "responsive" ? () => {} : () => process.exit(0));
if (role === "leader" && behavior !== "reaped") spawn(process.execPath, [fileURLToPath(import.meta.url), "desc", base, behavior], { stdio: "ignore" });
fs.writeFileSync(base + "." + role, String(process.pid));
const deadline = Date.now() + 15000;
setInterval(() => {
  if (role === "leader" && behavior === "exits-first" && fs.existsSync(base + ".release")) process.exit(0);
  if (Date.now() > deadline) process.exit(99);
}, 20);
`,
	);
	await fs.writeFile(
		wrapper,
		`import fs from "node:fs";
import { runCancellable } from ${JSON.stringify(setupUrl)};
const [fixture, base, behavior] = process.argv.slice(2);
const kill = (pid, signal) => {
  fs.appendFileSync(base + ".trace", JSON.stringify({ pid, signal, at: performance.now() }) + "\\n");
  return process.kill(pid, signal);
};
await runCancellable(process.execPath, [fixture, "leader", base, behavior], { kill });
`,
	);
	const assertEscalated = (name, trace, leader) => {
		const signals = trace.filter((event) => event.signal !== 0);
		assert.deepEqual(
			signals.map((event) => [event.pid, event.signal]),
			[
				[-leader, "SIGTERM"],
				[-leader, "SIGKILL"],
			],
			`${name}: expected TERM then KILL escalation`,
		);
		// Date.now() in the reaper has millisecond precision; allow only its rounding, not scheduler guesses.
		assert.ok(
			signals[1].at - signals[0].at >= GROUP_TERM_GRACE_MS - 1,
			`${name}: SIGKILL preceded the TERM grace: ${JSON.stringify(signals)}`,
		);
	};
	const children = [];
	const pids = [];
	try {
		await assert.rejects(
			runCancellable("pi-cu-definitely-missing-tool", []),
			(error) => {
				assert.match(
					error.message,
					/'pi-cu-definitely-missing-tool' was not found on PATH\. Install the Rust toolchain/,
				);
				assert.doesNotMatch(error.message, /prebuilt\/linux/);
				return true;
			},
		);
		// EPERM is a pure injected syscall case: no process/trap exists to handshake with.
		const calls = [];
		await reapProcessGroup(424242, (pid, signal) => {
			calls.push([pid, signal]);
			throw Object.assign(new Error("EPERM"), { code: "EPERM" });
		});
		assert.deepEqual(
			calls,
			[[-424242, 0]],
			"a foreign (EPERM) group must only be probed",
		);

		for (const [name, behavior] of [
			["term-leader-waits", "waits"],
			["leader-exits-first", "exits-first"],
			["reaped-guard", "reaped"],
			["negative-control", "responsive"],
		]) {
			const base = path.join(groupDir, name);
			const child = spawn(
				process.execPath,
				[wrapper, fixture, base, behavior],
				{ stdio: ["ignore", "pipe", "pipe"] },
			);
			children.push(child);
			let output = "";
			child.stdout.on("data", (chunk) => {
				output += chunk;
			});
			child.stderr.on("data", (chunk) => {
				output += chunk;
			});
			const closed = new Promise((resolve, reject) => {
				child.once("error", reject);
				child.once("close", (code, signal) => resolve({ code, signal }));
			});
			const leader = await waitForReady(`${base}.leader`);
			pids.push(leader);
			const descendant =
				behavior === "reaped" ? undefined : await waitForReady(`${base}.desc`);
			if (descendant) pids.push(descendant);
			assert.ok(alive(leader), `${name}: ready leader must be alive`);
			if (descendant)
				assert.ok(alive(descendant), `${name}: ready descendant must be alive`);
			let timer;
			try {
				const bounded = Promise.race([
					closed,
					new Promise((_, reject) => {
						timer = setTimeout(
							() =>
								reject(
									new Error(
										`${name}: wrapper exceeded ${backstopMs}ms reap backstop`,
									),
								),
							backstopMs,
						);
					}),
				]);
				if (behavior === "exits-first")
					await fs.writeFile(`${base}.release`, "go");
				else
					assert.ok(
						child.kill("SIGTERM"),
						`${name}: wrapper must receive TERM`,
					);
				const result = await bounded;
				assert.equal(
					result.code,
					behavior === "exits-first" ? 0 : 143,
					`${name}: ${JSON.stringify(result)} ${output}`,
				);
			} finally {
				clearTimeout(timer);
			}
			const trace = (await fs.readFile(`${base}.trace`, "utf8"))
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
			if (behavior === "waits" || behavior === "exits-first")
				assertEscalated(name, trace, leader);
			else {
				assert.deepEqual(
					trace
						.filter((event) => event.signal !== 0)
						.map((event) => [event.pid, event.signal]),
					[[-leader, "SIGTERM"]],
					`${name}: empty/reaped group must never receive KILL`,
				);
				// A deliberately TERM-responsive descendant MUST fail the same escalation oracle.
				if (behavior === "responsive")
					assert.throws(
						() => assertEscalated(name, trace, leader),
						/expected TERM then KILL escalation/,
					);
			}
			if (descendant)
				assert.equal(
					await settled(descendant),
					true,
					`${name}: descendant ${descendant} survived the wrapper`,
				);
			assert.equal(
				await settled(leader),
				true,
				`${name}: leader ${leader} survived`,
			);
			assert.equal(
				alive(-leader),
				false,
				`${name}: process group ${leader} still has members`,
			);
		}
	} finally {
		for (const child of children) {
			try {
				child.kill("SIGKILL");
			} catch {
				/* already gone */
			}
		}
		for (const pid of pids) {
			try {
				process.kill(-pid, "SIGKILL");
			} catch {
				/* already gone */
			}
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				/* already gone */
			}
		}
		await fs.rm(groupDir, { recursive: true, force: true });
	}
}
console.log("Linux build/setup script checks passed");
