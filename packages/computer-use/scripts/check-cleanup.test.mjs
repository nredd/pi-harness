import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import test from "node:test";
import { promisify } from "node:util";
import { listGroupStates, reapProcessGroup } from "./setup-helper.mjs";

const execute = promisify(execFile);
const setupUrl = new URL("./setup-helper.mjs", import.meta.url).href;

/** @returns {Promise<void>} Verifies absence is terminal even if the ID is immediately recycled. @throws {Error} On assertion failure. */
async function verifyTerminalAbsence() {
	for (const absentAt of [0, 1, 2]) {
		const calls = [];
		await reapProcessGroup(424242, (pid, signal) => {
			calls.push([pid, signal]);
			if (calls.length - 1 === absentAt) throw Object.assign(new Error("gone"), { code: "ESRCH" });
			return true;
		});
		assert.equal(calls.length, absentAt + 1, "never re-probe or signal a released ID");
	}
}

/** @returns {Promise<void>} Verifies probe and signal failures retain their original error. @throws {Error} On assertion failure. */
async function verifySyscallErrors() {
	for (const code of ["EPERM", "EIO"]) {
		for (const failAt of [0, 1, 2]) {
			const error = Object.assign(new Error(code), { code });
			let calls = 0;
			await assert.rejects(
				reapProcessGroup(424242, () => {
					if (calls++ === failAt) throw error;
					return true;
				}),
				(actual) => actual === error,
			);
			assert.equal(calls, failAt + 1, "no syscall follows inconclusive ownership");
		}
	}
}

/** @returns {Promise<void>} Verifies invalid IDs never reach the syscall seam. @throws {Error} On assertion failure. */
async function verifyInvalidGroups() {
	for (const pgid of [undefined, NaN, 0, -1, 1.5]) {
		await assert.rejects(
			reapProcessGroup(pgid, () => assert.fail("invalid group syscall")),
			/owned positive/,
		);
	}
}

/**
 * @param {string} policy Injected syscall policy; never signals a real process group.
 * @param {number} commandCode Disposable direct child's exit code.
 * @param {boolean} terminate Whether to send the wrapper its cancellation signal.
 * @returns {Promise<{trace: unknown[], error?: {message: string, errors?: string[]}, code: number, stderr: string}>} Wrapper result.
 * @throws {Error} On wrapper timeout or malformed output.
 */
async function cleanupWrapper(policy, commandCode = 0, terminate = false) {
	const program = `
import { runCancellable } from ${JSON.stringify(setupUrl)};
const trace = [];
let error;
let suppressed = false;
const kill = (pid, signal) => {
  trace.push(signal);
  if (${JSON.stringify(policy)} === "gone" || (${JSON.stringify(policy)} === "fallback-gone" && suppressed))
    throw Object.assign(new Error("gone"), {code: "ESRCH"});
  const policy = ${JSON.stringify(policy)};
  if (policy === "EPERM" || policy === "EIO" || (policy.endsWith("-signal") && signal !== 0)) {
    const code = policy.split("-")[0];
    throw Object.assign(new Error(code), {code});
  }
  if (signal === "SIGKILL") suppressed = true;
  return true;
};
const running = runCancellable(process.execPath, ["-e", ${JSON.stringify(`process.exit(${commandCode})`)}], {kill});
process.on("exit", () => console.log(JSON.stringify({trace, error, code: process.exitCode ?? 0})));
if (${terminate}) process.kill(process.pid, "SIGTERM");
try { await running; }
catch (caught) { error = {message: caught.message, errors: caught.errors?.map(item => item.message)}; process.exitCode = 1; }
`;
	let stdout;
	let stderr;
	try {
		({ stdout, stderr } = await execute(process.execPath, ["--input-type=module", "-e", program], { timeout: 5000 }));
	} catch (error) {
		assert.equal(error.killed, false, "wrapper must finish within its cleanup budget");
		stdout = error.stdout;
		stderr = error.stderr;
	}
	return { ...JSON.parse(stdout.trim()), stderr };
}

/** @returns {Promise<void>} Verifies permission/errors revoke the exit fallback, and ESRCH resolves. @throws {Error} On assertion failure. */
async function verifyWrapperOwnership() {
	for (const policy of ["EPERM", "EIO", "EPERM-signal", "EIO-signal"]) {
		const result = await cleanupWrapper(policy);
		assert.equal(result.code, 1);
		assert.equal(result.error.message, policy.split("-")[0]);
		assert.deepEqual(
			result.trace,
			policy.endsWith("-signal") ? [0, "SIGTERM"] : [0],
			"inconclusive cleanup must not exit-KILL",
		);
	}
	const gone = await cleanupWrapper("gone");
	assert.equal(gone.code, 0);
	assert.deepEqual(gone.trace, [0]);
}

/** @returns {Promise<void>} Verifies persistent positives fail and retain a probed exit-time backstop. @throws {Error} On assertion failure. */
async function verifyPersistentGroup() {
	const result = await cleanupWrapper("persistent", 7);
	assert.equal(result.code, 1);
	assert.match(result.error.message, /Command failed \(7\)/);
	assert.match(result.error.errors[0], /Command failed \(7\)/);
	assert.match(result.error.errors[1], /remained non-empty/);
	assert.deepEqual(
		result.trace.filter((signal) => signal !== 0),
		["SIGTERM", "SIGKILL", "SIGKILL"],
	);
	assert.equal(result.trace.at(-2), 0, "exit-time KILL requires a fresh positive probe");
	const gone = await cleanupWrapper("fallback-gone");
	assert.equal(gone.code, 0);
	assert.deepEqual(
		gone.trace.filter((signal) => signal !== 0),
		["SIGTERM", "SIGKILL"],
	);
}

/** @returns {Promise<void>} Verifies cancellation surfaces probe failure without an unhandled rejection or foreign-group retry. @throws {Error} On assertion failure. */
async function verifyCancelledCleanup() {
	const result = await cleanupWrapper("EPERM", 0, true);
	assert.equal(result.code, 143);
	assert.deepEqual(result.trace, [0]);
	assert.match(result.stderr, /Process-group cleanup failed: EPERM/);
	assert.doesNotMatch(result.stderr, /unhandled/i);
}

/** @returns {Promise<void>} Verifies PID-less spawn failure removes every installed listener and never probes. @throws {Error} On assertion failure. */
async function verifySpawnFailure() {
	const { runCancellable } = await import("./setup-helper.mjs");
	const signals = ["SIGTERM", "SIGINT", "SIGHUP", "exit"];
	const before = signals.map((signal) => process.listenerCount(signal));
	const calls = [];
	await assert.rejects(
		runCancellable("/nonexistent/pi-cleanup-tool", [], {
			kill: (pid, signal) => {
				calls.push([pid, signal]);
				throw Object.assign(new Error("invalid group"), { code: "ESRCH" });
			},
		}),
		/not found on PATH/,
	);
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(calls, [], "PID-less close must not probe even when syscall errors would be swallowed");
	assert.deepEqual(
		signals.map((signal) => process.listenerCount(signal)),
		before,
	);
}

/**
 * @param {Array<[string, string]>} script Ordered `[code, op]` outcomes; `"ok"` returns, any other code throws it.
 * @returns {{kill: (pid: number, signal: number|string) => boolean, calls: Array<[number, number|string]>}} Scripted syscall seam.
 * @throws {never} Construction cannot fail.
 */
function scriptedKill(script) {
	const calls = [];
	const kill = (pid, signal) => {
		calls.push([pid, signal]);
		const [code] = script[Math.min(calls.length, script.length) - 1];
		if (code !== "ok") throw Object.assign(new Error(code), { code });
		return true;
	};
	return { kill, calls };
}

/** @returns {Promise<void>} Verifies a zombie-only EPERM group is waited on until ESRCH, probe or signal side. @throws {Error} On assertion failure. */
async function verifyDrainingZombieGroup() {
	const zombies = () => ["Z", "Z+"];
	for (const script of [
		[["EPERM"], ["EPERM"], ["ESRCH"]],
		[["ok"], ["EPERM"], ["EPERM"], ["ESRCH"]],
		[["ok"], ["ok"], ["EPERM"], ["EPERM"], ["ESRCH"]],
	]) {
		const { kill, calls } = scriptedKill(script.map(([code]) => [code, ""]));
		await reapProcessGroup(424242, kill, zombies);
		assert.equal(calls.at(-1)[1], 0, "the final observation is the ESRCH probe");
		assert.equal(calls.length, script.length);
	}
	// Members seen at the start that vanish before `ps` runs were reaped mid-probe: keep probing, to ESRCH.
	const listings = [["Z"], []];
	const vanished = scriptedKill([["EPERM", ""], ["ESRCH", ""]]);
	await reapProcessGroup(424242, vanished.kill, () => listings.shift() ?? []);
	assert.equal(vanished.calls.length, 2);
	const persistent = scriptedKill([["EPERM", ""]]);
	await assert.rejects(reapProcessGroup(424242, persistent.kill, zombies), /remained non-empty after SIGKILL/);
	const { kill, calls } = scriptedKill([["EPERM", ""]]);
	await assert.rejects(reapProcessGroup(424242, kill, zombies), /remained non-empty after SIGKILL/);
	assert.ok(calls.length > 2, "a persistent zombie-only group keeps being probed");
	assert.ok(calls.some(([, signal]) => signal === "SIGKILL"), "the budget escalates to SIGKILL before giving up");
}

/** @returns {Promise<void>} Verifies EPERM stays fatal unless the listing proves a non-empty all-zombie group. @throws {Error} On assertion failure. */
async function verifyRealPermissionFailure() {
	const failing = () => {
		throw new Error("ps unavailable");
	};
	for (const listStates of [() => ["Z", "S"], () => ["S"], () => [], failing]) {
		const error = Object.assign(new Error("EPERM"), { code: "EPERM" });
		const calls = [];
		await assert.rejects(
			reapProcessGroup(424242, (pid, signal) => {
				calls.push([pid, signal]);
				throw error;
			}, listStates),
			(actual) => actual === error,
		);
		assert.deepEqual(calls, [[-424242, 0]], "no signal follows an EPERM that is not a draining group");
	}
	const error = Object.assign(new Error("EPERM"), { code: "EPERM" });
	let calls = 0;
	await assert.rejects(
		reapProcessGroup(424242, () => {
			if (calls++ === 1) throw error;
			return true;
		}, () => ["S"]),
		(actual) => actual === error,
	);
	assert.equal(calls, 2, "a signal-time EPERM with a live member is a permission failure");
}

/** @returns {Promise<void>} Verifies the real `ps` listing: live members, zombies and absence. @throws {Error} On assertion failure. */
async function verifyListGroupStates() {
	const child = spawn("/bin/sleep", ["30"], { detached: true, stdio: "ignore" });
	try {
		const states = listGroupStates(child.pid);
		assert.equal(states.length, 1);
		assert.doesNotMatch(states[0], /^Z/);
	} finally {
		child.kill("SIGKILL");
		await new Promise((resolve) => child.once("close", resolve));
	}
	assert.deepEqual(listGroupStates(child.pid), [], "a reaped group has no members");
}

/**
 * Start a group holding only a zombie whose parent has not waited yet.
 * @returns {Promise<{pgid: number, holder: import('node:child_process').ChildProcess, reaped: Promise<void>}>} Group and its reap trigger.
 * @throws {Error} When the holder never reports its group.
 */
async function zombieOnlyGroup() {
	// perl forks a setpgrp'd leader that exits at once, then waits on stdin before reaping it.
	const script = '$|=1; my $p=fork(); if(!$p){setpgrp(0,0); exit 0} print "$p\\n"; <STDIN>; waitpid($p,0);';
	const holder = spawn("/usr/bin/perl", ["-e", script], { stdio: ["pipe", "pipe", "inherit"] });
	const pgid = await new Promise((resolve, reject) => {
		holder.once("error", reject);
		holder.stdout.once("data", (chunk) => resolve(Number(String(chunk).trim())));
	});
	const reaped = new Promise((resolve) => holder.once("close", resolve));
	// The leader is a zombie only after its exit; wait on the kernel's own view, not on a timer.
	while (listGroupStates(pgid).join() !== "Z") await new Promise((resolve) => setImmediate(resolve));
	return { pgid, holder, reaped };
}

/** @returns {Promise<void>} Reproduces Darwin's EPERM for a real zombie-only group and requires it to drain to ESRCH. @throws {Error} On assertion failure. */
async function verifyRealDarwinZombieGroup() {
	const { pgid, holder, reaped } = await zombieOnlyGroup();
	assert.throws(() => process.kill(-pgid, 0), { code: "EPERM" }, "premise: Darwin refuses to signal a zombie-only group");
	let released = false;
	await reapProcessGroup(pgid, (pid, signal) => {
		try {
			return process.kill(pid, signal);
		} finally {
			// Let the parent reap right after the first EPERM observation, so draining is real.
			if (!released) {
				released = true;
				holder.stdin.end("go\n");
			}
		}
	});
	await reaped;
	assert.throws(() => process.kill(-pgid, 0), { code: "ESRCH" });
}

/** @returns {Promise<void>} A zombie-only group that never drains is reported unreaped, never resolved. @throws {Error} On assertion failure. */
async function verifyRealPersistentZombieGroup() {
	const { pgid, holder, reaped } = await zombieOnlyGroup();
	try {
		await assert.rejects(reapProcessGroup(pgid), /remained non-empty after SIGKILL/);
	} finally {
		holder.stdin.end("go\n");
		await reaped;
	}
}

test("ESRCH is terminal, including signal-time disappearance", verifyTerminalAbsence);
test("EPERM and EIO preserve probe and delivery failures", verifySyscallErrors);
test("invalid group IDs never reach kill", verifyInvalidGroups);
test("wrapper errors revoke fallback ownership; ESRCH proves reaped", verifyWrapperOwnership);
test("persistent positive probes preserve primary error and guarded fallback", verifyPersistentGroup);
test("cancellation handles cleanup rejection without a foreign exit KILL", verifyCancelledCleanup);
test("PID-less spawn failure releases listeners without group syscalls", verifySpawnFailure);
test("a zombie-only EPERM group is waited on until ESRCH", verifyDrainingZombieGroup);
test("EPERM without a proven zombie-only group stays a permission failure", verifyRealPermissionFailure);
test("listGroupStates reads live, reaped and absent members from ps", verifyListGroupStates);
test("real Darwin zombie-only group drains to ESRCH", { skip: process.platform !== "darwin" && "only Darwin answers EPERM for a zombie-only group" }, verifyRealDarwinZombieGroup);
test("real Darwin zombie-only group that never drains is not reaped", { skip: process.platform !== "darwin" && "only Darwin answers EPERM for a zombie-only group" }, verifyRealPersistentZombieGroup);
