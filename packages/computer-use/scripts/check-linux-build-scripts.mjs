#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	SIGNAL_READINESS_POLL_MS as POLL_INTERVAL_MS,
	PARENT_READINESS_TIMEOUT_MS as READINESS_TIMEOUT_MS,
	within,
	writeSignalReadinessObserver,
} from "./check-async.mjs";

const SETUP_COMPLETION_TIMEOUT_MS = 30_000;
const PROCESS_SETTLE_TIMEOUT_MS = 5000;
const WRAPPER_BACKSTOP_HEADROOM_MS = 5000;
const FIXTURE_LIFETIME_MS = 60_000;
const OUTER_SETUP_BACKSTOP_MS = 2000;
const TERM_GRACE_ROUNDING_ALLOWANCE_MS = 1;

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
let setupChild;
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
	const result = await within(
		new Promise((resolve, reject) => {
			const child = spawn(
				process.execPath,
				[fixtureEntry, "--platform", "linux"],
				{
					env: {
						...process.env,
						PI_COMPUTER_USE_LINUX_HELPER_PATH: helperDest,
					},
					stdio: ["ignore", "pipe", "pipe"],
				},
			);
			setupChild = child;
			let output = "";
			child.stdout.on("data", (chunk) => {
				output += chunk;
			});
			child.stderr.on("data", (chunk) => {
				output += chunk;
			});
			child.once("error", reject);
			child.once("close", (code) => resolve({ code, output }));
		}),
		"initial Linux setup CLI to close without a prebuilt",
		SETUP_COMPLETION_TIMEOUT_MS,
	);
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
	setupChild?.kill("SIGKILL");
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
		reapBudgetMs < OUTER_SETUP_BACKSTOP_MS,
		`reap budget ${reapBudgetMs}ms no longer fits the ${OUTER_SETUP_BACKSTOP_MS}ms outer backstop`,
	);
	const backstopMs = reapBudgetMs + WRAPPER_BACKSTOP_HEADROOM_MS;
	/**
	 * Probe fixture liveness without delivering a signal.
	 * @param {number} pid Owned PID, or negative PGID for a group probe.
	 * @returns {boolean} Whether the process/group exists or is permission-protected.
	 * @throws {never} Probe errors are classified into the Boolean result.
	 */
	const alive = (pid) => {
		try {
			process.kill(pid, 0);
			return true;
		} catch (error) {
			return error.code === "EPERM";
		}
	};
	/**
	 * Await observable fixture death within the named settle budget.
	 * @param {number} pid Owned fixture PID.
	 * @returns {Promise<boolean>} Whether the fixture is gone after bounded polling.
	 * @throws {never} Probe errors are classified by `alive`.
	 */
	const settled = async (pid) => {
		for (
			const deadline = Date.now() + PROCESS_SETTLE_TIMEOUT_MS;
			alive(pid) && Date.now() < deadline;
		)
			await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
		return !alive(pid);
	};
	/**
	 * Read a process-owned readiness marker with preload diagnostic headroom.
	 * @param {string} file Private PID marker written after signal registration.
	 * @returns {Promise<number>} Positive PID acknowledged by the fixture.
	 * @throws {Error} If no valid marker is readable before the parent deadline.
	 */
	const waitForReady = async (file) => {
		for (
			const deadline = Date.now() + READINESS_TIMEOUT_MS;
			Date.now() < deadline;
		) {
			const pid = Number(await fs.readFile(file, "utf8").catch(() => ""));
			if (Number.isInteger(pid) && pid > 0) return pid;
			await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
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
const deadline = Date.now() + ${FIXTURE_LIFETIME_MS};
setInterval(() => {
  if (role === "leader" && behavior === "exits-first" && fs.existsSync(base + ".release")) process.exit(0);
  if (Date.now() > deadline) process.exit(99);
}, ${POLL_INTERVAL_MS});
`,
	);
	await fs.writeFile(
		wrapper,
		`import fs from "node:fs";
import { runCancellable } from ${JSON.stringify(setupUrl)};
const [fixture, base, behavior] = process.argv.slice(2);
const trace = [];
/**
 * Trace an actual signal attempt, timestamping only after successful delivery.
 * @param {number} pid Owned process/group target.
 * @param {NodeJS.Signals|0} signal Signal or null-signal probe.
 * @returns {boolean} Actual syscall result.
 * @throws {Error} Preserves syscall failures after recording their codes.
 */
const kill = (pid, signal) => {
  let result;
  try { result = process.kill(pid, signal); }
  catch (error) { trace.push({ pid, signal, error: error.code }); throw error; }
  const at = performance.now(); // Successful syscall first, with no trace I/O before delivery.
  trace.push({ pid, signal, at });
  return result;
};
const running = runCancellable(process.execPath, [fixture, "leader", base, behavior], { kill });
// Register AFTER runCancellable's exit hook so a late exit-hook signal is captured too.
process.on("exit", () => fs.writeFileSync(base + ".trace", JSON.stringify(trace)));
await running;
`,
	);
	/**
	 * Enforce delivered TERM/KILL ordering and the exported grace contract.
	 * @param {string} name Fixture scenario label.
	 * @param {Array<{pid: number, signal: string|number, at?: number, error?: string}>} trace Recorded syscall outcomes.
	 * @param {number} leader Owned process-group leader PID.
	 * @returns {void} Successful validation.
	 * @throws {Error} If signals, successful delivery or grace timing violate the contract.
	 */
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
		for (const event of signals)
			assert.equal(event.error, undefined, `${name}: signal syscall failed`);
		// Date.now() in the reaper has millisecond precision; allow only its rounding, not scheduler guesses.
		assert.ok(
			signals[1].at - signals[0].at >=
				GROUP_TERM_GRACE_MS - TERM_GRACE_ROUNDING_ALLOWANCE_MS,
			`${name}: SIGKILL preceded the TERM grace: ${JSON.stringify(signals)}`,
		);
	};
	const children = [];
	const pids = new Set();
	const groups = new Set();
	try {
		await within(
			assert.rejects(
				runCancellable("pi-cu-definitely-missing-tool", []),
				(error) => {
					assert.match(
						error.message,
						/'pi-cu-definitely-missing-tool' was not found on PATH\. Install the Rust toolchain/,
					);
					assert.doesNotMatch(error.message, /prebuilt\/linux/);
					return true;
				},
			),
			"missing build tool to reject with its install hint",
			SETUP_COMPLETION_TIMEOUT_MS,
		);
		// Preserve today's EPERM policy without claiming it proves PGID reuse (follow-up #167).
		// This pure injected syscall case has no process/trap to handshake with.
		const calls = [];
		await reapProcessGroup(424242, (pid, signal) => {
			calls.push([pid, signal]);
			throw Object.assign(new Error("EPERM"), { code: "EPERM" });
		});
		assert.deepEqual(
			calls,
			[[-424242, 0]],
			"the current EPERM policy must only probe without signalling",
		);

		for (const [name, behavior] of [
			["term-leader-waits", "waits"],
			["leader-exits-first", "exits-first"],
			["reaped-guard", "reaped"],
			["negative-control", "responsive"],
		]) {
			const base = path.join(groupDir, name);
			const observer = `${base}.observer.mjs`;
			const wrapperReady = `${base}.wrapper`;
			await writeSignalReadinessObserver(observer, wrapperReady);
			const child = spawn(
				process.execPath,
				["--import", observer, wrapper, fixture, base, behavior],
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
			let leader;
			let descendant;
			try {
				leader = await waitForReady(`${base}.leader`);
				pids.add(leader);
				groups.add(leader);
				descendant =
					behavior === "reaped"
						? undefined
						: await waitForReady(`${base}.desc`);
				if (descendant) pids.add(descendant);
				assert.equal(
					await waitForReady(wrapperReady),
					child.pid,
					`${name}: wrapper handlers must be live before cancellation`,
				);
			} catch (error) {
				throw new Error(`${name}: ${error.message}\n${output}`, {
					cause: error,
				});
			}
			assert.ok(alive(leader), `${name}: ready leader must be alive`);
			if (descendant)
				assert.ok(alive(descendant), `${name}: ready descendant must be alive`);
			/**
			 * Trigger the acknowledged fixture boundary and await its close event.
			 * @returns {Promise<object>} Wrapper exit status.
			 * @throws {Error} On release-file, signal-delivery or child-process failure.
			 */
			const completion = (async () => {
				if (behavior === "exits-first")
					await fs.writeFile(`${base}.release`, "go");
				else
					assert.ok(
						child.kill("SIGTERM"),
						`${name}: wrapper must receive TERM`,
					);
				return await closed;
			})();
			const result = await within(
				completion,
				`${name}: wrapper to close inside its ${backstopMs}ms reap backstop`,
				backstopMs,
			);
			assert.equal(
				result.code,
				behavior === "exits-first" ? 0 : 143,
				`${name}: ${JSON.stringify(result)} ${output}`,
			);
			const trace = JSON.parse(await fs.readFile(`${base}.trace`, "utf8"));
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
			if (descendant) {
				assert.equal(
					await settled(descendant),
					true,
					`${name}: descendant ${descendant} survived the wrapper`,
				);
				pids.delete(descendant);
			}
			assert.equal(
				await settled(leader),
				true,
				`${name}: leader ${leader} survived`,
			);
			pids.delete(leader);
			assert.equal(
				alive(-leader),
				false,
				`${name}: process group ${leader} still has members`,
			);
			groups.delete(leader);
		}
	} finally {
		for (const child of children) {
			try {
				child.kill("SIGKILL");
			} catch {
				/* already gone */
			}
		}
		// Forget verified-empty groups and dead PIDs before cleanup: their IDs may be reused.
		for (const pgid of groups) {
			try {
				process.kill(-pgid, "SIGKILL");
			} catch {
				/* already gone */
			}
		}
		for (const pid of pids) {
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
