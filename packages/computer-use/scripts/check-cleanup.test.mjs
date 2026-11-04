import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { GROUP_KILL_WAIT_MS, GROUP_TERM_GRACE_MS, PS_TIMEOUT_MS, isOwnableGroup, listGroupStates, reapProcessGroup, runCancellable, zombieOnlyListing } from "./setup-helper.mjs";

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
				// A fixed listing (never seen, empty) keeps a loaded `ps` from turning EPERM into extra probes.
				reapProcessGroup(424242, () => {
					if (calls++ === failAt) throw error;
					return true;
				}, () => []),
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
// Registered before runCancellable, so it runs before the exit-time backstop.
let exiting = false;
process.on("exit", () => { exiting = true; });
const kill = (pid, signal) => {
  trace.push(signal);
  if (${JSON.stringify(policy)} === "exit-unexplained" && exiting && signal === 0)
    throw Object.assign(new Error("EPERM"), {code: "EPERM"});
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
// The exited command's group never lists; a fixed listing keeps a loaded ps out of the trace.
// At exit it fails, so exit-unexplained leaves the backstop's EPERM unexplained.
const running = runCancellable(process.execPath, ["-e", ${JSON.stringify(`process.exit(${commandCode})`)}], {kill, listStates: () => { if (exiting) throw new Error("ps timed out"); return []; }});
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
	// An exit-time EPERM no listing explains gets no KILL: it may be a credential boundary.
	const unexplained = await cleanupWrapper("exit-unexplained", 7);
	assert.equal(unexplained.code, 1);
	assert.deepEqual(unexplained.trace.filter((signal) => signal !== 0), ["SIGTERM", "SIGKILL"]);
	assert.equal(unexplained.trace.at(-1), 0, "the exit-time probe ran, then nothing was signalled");
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
	const zombies = () => ["Z", "Z+", "ZN"];
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
	for (const listStates of [() => ["Z", "S"], () => ["S"], () => []]) {
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

/**
 * @param {number} failures Listings that throw a `ps` timeout before `states` is returned.
 * @param {string[]} states Listing returned once `ps` recovers.
 * @returns {(pgid: number) => string[]} Listing seam that times out first, then answers.
 * @throws {never} Construction cannot fail.
 */
function listingAfterTimeouts(failures, states) {
	let calls = 0;
	return () => {
		if (calls++ < failures) throw Object.assign(new Error("spawnSync /bin/ps ETIMEDOUT"), { code: "ETIMEDOUT" });
		return states;
	};
}

/** @returns {Promise<void>} A failed listing is unknown, not a verdict: probe and re-list without signalling until one explains the EPERM. @throws {Error} On assertion failure. */
async function verifyUnknownListingKeepsDraining() {
	// Probe side: the snapshot and the first post-EPERM listing time out, the next shows the zombie, then ESRCH.
	const probe = scriptedKill([["EPERM", ""], ["EPERM", ""], ["ESRCH", ""]]);
	await reapProcessGroup(424242, probe.kill, listingAfterTimeouts(2, ["Z"]));
	assert.deepEqual(probe.calls, [[-424242, 0], [-424242, 0], [-424242, 0]], "only probes while the EPERM is unexplained");
	// Signal side: SIGTERM's EPERM meets a timed-out listing; the next probe's listing explains it.
	const signal = scriptedKill([["ok", ""], ["EPERM", ""], ["EPERM", ""], ["ESRCH", ""]]);
	await reapProcessGroup(424242, signal.kill, listingAfterTimeouts(2, ["ZN"]));
	assert.deepEqual(signal.calls, [[-424242, 0], [-424242, "SIGTERM"], [-424242, 0], [-424242, 0]]);
	// A listing that recovers to show a live member rejects at once with the first, unexplained EPERM.
	const first = Object.assign(new Error("EPERM"), { code: "EPERM" });
	const calls = [];
	await assert.rejects(
		reapProcessGroup(424242, (pid, sig) => {
			calls.push([pid, sig]);
			throw calls.length === 1 ? first : Object.assign(new Error("EPERM"), { code: "EPERM" });
		}, listingAfterTimeouts(3, ["S"])),
		(actual) => actual === first,
	);
	assert.deepEqual(calls, [[-424242, 0], [-424242, 0], [-424242, 0]], "the first successful listing decides");
	// A positive probe never explains an EPERM: with `ps` still failing, the EPERM surfaces after one budget.
	const unexplained = Object.assign(new Error("EPERM"), { code: "EPERM" });
	const mixed = [];
	await assert.rejects(
		reapProcessGroup(424242, (pid, sig) => {
			mixed.push([pid, sig]);
			if (mixed.length === 2) throw unexplained;
			return true;
		}, listingAfterTimeouts(Number.POSITIVE_INFINITY, [])),
		(actual) => actual === unexplained,
	);
	assert.deepEqual(mixed.slice(0, 2), [[-424242, 0], [-424242, "SIGTERM"]]);
	assert.ok(mixed.slice(2).every(([, sig]) => sig === 0), "no signal follows an unexplained EPERM");
	// A positive probe re-lists while an EPERM is pending, so a recovered listing with a live member decides at once.
	const pending = Object.assign(new Error("EPERM"), { code: "EPERM" });
	const relisted = [];
	await assert.rejects(
		reapProcessGroup(424242, (pid, sig) => {
			relisted.push([pid, sig]);
			if (relisted.length === 2) throw pending;
			return true;
		}, listingAfterTimeouts(2, ["S"])),
		(actual) => actual === pending,
	);
	assert.deepEqual(relisted, [[-424242, 0], [-424242, "SIGTERM"], [-424242, 0]]);
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

/** Wall-clock readiness budget for a real zombie group; the leader exits at once, so this is not a timeout. */
const ZOMBIE_READY_MS = 2000;

/**
 * Synchronously sleep, for the `listStates` seam, which `reapProcessGroup` calls synchronously.
 * @param {number} ms Milliseconds to block.
 * @returns {void}
 * @throws {never} Blocks only this thread.
 */
function sleepSync(ms) {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Read one process row for a premise or failure message.
 * @param {number} pid Process to describe.
 * @returns {string} The `pid ppid pgid stat` row, or why `ps` could not produce one.
 * @throws {never} Failures are described in the returned text.
 */
function processRow(pid) {
	try {
		return execFileSync("/bin/ps", ["-o", "pid=,ppid=,pgid=,stat=", "-p", String(pid)], { encoding: "utf8", timeout: 5000, killSignal: "SIGKILL" }).trim();
	} catch (error) {
		return `no row: ps -p ${pid} failed (${error.status ?? error.code ?? error.message})`;
	}
}

/**
 * Wrap a listing seam so every `ps` failure it throws is recorded before it propagates.
 * @param {(pgid: number) => string[]} [listStates] Listing to wrap.
 * @returns {{list: (pgid: number) => string[], failures: string[], describe: () => string}} Recording seam and its log.
 * @throws {never} Construction cannot fail.
 */
function trackedListStates(listStates = listGroupStates) {
	const failures = [];
	const list = (pgid) => {
		try {
			return listStates(pgid);
		} catch (error) {
			failures.push(error.message);
			throw error;
		}
	};
	const describe = () => `ps failures ${failures.length} (last: ${failures.at(-1) ?? "none"})`;
	return { list, failures, describe };
}

/**
 * Start a group holding only a zombie whose parent has not waited yet. `release` makes the parent reap it and
 * exit; the parent otherwise blocks on stdin, so it holds the zombie until released or this process exits.
 * Readiness uses the production rule (`zombieOnlyListing`), so a flagged zombie such as `ZN` counts.
 * @returns {Promise<{pgid: number, holder: import('node:child_process').ChildProcess, release: () => void, reaped: Promise<void>}>} Group and its reap trigger.
 * @throws {Error} When the holder fails or exits before reporting its group, or the group is not ours and zombie-only within `ZOMBIE_READY_MS`. The holder is released and awaited first.
 */
async function zombieOnlyGroup() {
	// perl forks a setpgrp'd leader that exits at once, then reaps it only on SIGUSR1. Stdin EOF also exits.
	const script = '$|=1; my $p=fork(); if(!$p){setpgrp(0,0); exit 0} $SIG{USR1}=sub{waitpid($p,0); exit 0}; print "$p\\n"; my $eof=<STDIN>; exit 3;';
	const holder = spawn("/usr/bin/perl", ["-e", script], { stdio: ["pipe", "pipe", "inherit"] });
	const reaped = new Promise((resolve) => holder.once("close", resolve));
	// ChildProcess.kill never signals once the holder has exited and been reaped, so release is idempotent.
	const release = () => holder.kill("SIGUSR1");
	try {
		const pgid = await new Promise((resolve, reject) => {
			holder.once("error", reject);
			holder.once("exit", (code, signal) => reject(new Error(`premise: holder exited (${code ?? signal}) before reporting its group`)));
			holder.stdout.once("data", (chunk) => resolve(Number(String(chunk).trim())));
		});
		assert.ok(Number.isInteger(pgid) && pgid > 1, `premise: holder reported no usable group: ${pgid}`);
		const tracked = trackedListStates();
		const deadline = Date.now() + ZOMBIE_READY_MS;
		let lastListing = [];
		for (;;) {
			try {
				const states = tracked.list(pgid);
				if (states.length > 0) lastListing = states;
				if (zombieOnlyListing(states)) break;
			} catch {
				// Recorded by `tracked`; readiness keeps polling inside its budget.
			}
			// Build the message only on failure: `processRow` is another synchronous `ps`.
			if (Date.now() >= deadline) {
				assert.fail(`premise: group ${pgid} not zombie-only within ${ZOMBIE_READY_MS}ms; last non-empty listing [${lastListing}], leader row "${processRow(pgid)}", ${tracked.describe()}`);
			}
			await delay(10);
		}
		// Ownership before any real group syscall: the zombie leads its own group and is the holder's child.
		const row = processRow(pgid);
		const [pid, ppid, group] = row.split(/\s+/).map(Number);
		assert.ok(pid === pgid && ppid === holder.pid && group === pgid, `premise: group ${pgid} is not the holder's (${holder.pid}) zombie leader: "${row}"`);
		return { pgid, holder, release, reaped };
	} catch (error) {
		release();
		await reaped;
		throw error;
	}
}

/**
 * Run `reapProcessGroup` against a real group through a recording listing. Production treats a failed `ps`
 * as unknown and keeps probing, but if no listing succeeds before the budget ends it rejects with the bare
 * `EPERM`; this test-only wrapper names the recorded `ps` failures in that rejection so a loaded runner's
 * miss is diagnosable. It adds no production guarantee.
 * @param {number} pgid Owned process-group ID, proven by `zombieOnlyGroup`.
 * @param {(pid: number, signal: number|string) => boolean} [kill] Syscall seam.
 * @param {(pgid: number) => string[]} [listStates] Listing seam.
 * @returns {Promise<void>} Settles as `reapProcessGroup` does.
 * @throws {Error} The reap failure, wrapped with the `ps` failures when any occurred.
 */
async function reapNamingPsFailures(pgid, kill = process.kill.bind(process), listStates = listGroupStates) {
	const tracked = trackedListStates(listStates);
	try {
		await reapProcessGroup(pgid, kill, tracked.list);
	} catch (error) {
		if (tracked.failures.length === 0) throw error;
		throw new Error(`${error.message}; ${tracked.describe()}: ${tracked.failures.join("; ")}`, { cause: error });
	}
}

/** @returns {Promise<void>} Reproduces Darwin's EPERM for a real zombie-only group and requires it to drain to ESRCH. @throws {Error} On assertion failure. */
async function verifyRealDarwinZombieGroup() {
	const { pgid, release, reaped } = await zombieOnlyGroup();
	try {
		assert.throws(() => process.kill(-pgid, 0), { code: "EPERM" }, "premise: Darwin refuses to signal a zombie-only group");
		let released = false;
		await reapNamingPsFailures(pgid, (pid, signal) => {
			try {
				return process.kill(pid, signal);
			} finally {
				// Let the parent reap right after the first EPERM observation, so draining is real.
				if (!released) {
					released = true;
					release();
				}
			}
		});
	} finally {
		release();
		await reaped;
	}
	assert.throws(() => process.kill(-pgid, 0), { code: "ESRCH" });
}

/** @returns {Promise<void>} The race the seen rule exists for: the zombie is reaped between the EPERM and the `ps` listing. @throws {Error} On assertion failure. */
async function verifyRealReapBeforeListing() {
	const { pgid, holder, release, reaped } = await zombieOnlyGroup();
	let listings = 0;
	try {
		await reapNamingPsFailures(pgid, process.kill.bind(process), (group) => {
			// First call is the up-front membership snapshot. The second is the post-EPERM listing: reap first.
			if (listings++ === 0) return listGroupStates(group);
			release();
			// The seam is synchronous, so wait for the drain with short blocking sleeps, bounded by wall clock.
			const deadline = Date.now() + ZOMBIE_READY_MS;
			for (;;) {
				try {
					process.kill(-group, 0);
				} catch (error) {
					if (error.code === "ESRCH") break;
					assert.equal(error.code, "EPERM", "premise: only EPERM or ESRCH while the zombie drains");
				}
				if (Date.now() >= deadline) {
					assert.fail(`premise: holder ${holder.pid} never reaped group ${group} within ${ZOMBIE_READY_MS}ms; leader row "${processRow(group)}"`);
				}
				sleepSync(1);
			}
			return listGroupStates(group);
		});
	} finally {
		release();
		await reaped;
	}
	assert.equal(listings, 2, "the empty post-EPERM listing was classified once, then ESRCH ended the reap");
	assert.equal(holder.exitCode, 0);
}

/** @returns {Promise<void>} A zombie-only group that never drains is reported unreaped, never resolved. @throws {Error} On assertion failure. */
async function verifyRealPersistentZombieGroup() {
	const { pgid, release, reaped } = await zombieOnlyGroup();
	try {
		await assert.rejects(reapNamingPsFailures(pgid), /remained non-empty after SIGKILL/);
	} finally {
		release();
		await reaped;
	}
}

/** @returns {Promise<void>} Pgid 1 would be `kill(-1, ...)`, a broadcast: reject it before any syscall. @throws {Error} On assertion failure. */
async function verifyBroadcastGroupRejected() {
	for (const pgid of [1, 0, -1]) {
		const calls = [];
		await assert.rejects(
			reapProcessGroup(pgid, (...call) => {
				calls.push(call);
				return true;
			}, () => assert.fail("listing must not run for an invalid group")),
			/owned positive process-group ID above 1/,
		);
		assert.deepEqual(calls, [], `pgid ${pgid} must make no kill call`);
	}
}

/** @returns {Promise<void>} Verifies EPERM stays fatal: after the budget when every listing fails, at once for a never-observed group. @throws {Error} On assertion failure. */
async function verifyInconclusiveListing() {
	// A listing that keeps timing out or being killed never explains the EPERM: probe and re-list, never
	// signal, then reject with the first EPERM once the budget ends. The cases share nothing, so their budgets overlap.
	const failures = [
		() => Object.assign(new Error("spawnSync /bin/ps ETIMEDOUT"), { code: "ETIMEDOUT" }),
		() => Object.assign(new Error("ps killed"), { code: "ETIMEDOUT", signal: "SIGKILL" }),
	];
	await Promise.all(failures.map(async (failure) => {
		const first = Object.assign(new Error("EPERM"), { code: "EPERM" });
		const calls = [];
		let listings = 0;
		await assert.rejects(
			reapProcessGroup(424242, (pid, signal) => {
				calls.push([pid, signal]);
				throw calls.length === 1 ? first : Object.assign(new Error("EPERM"), { code: "EPERM" });
			}, () => {
				listings++;
				throw failure();
			}),
			(actual) => actual === first,
		);
		assert.ok(calls.length > 1, "an unexplained EPERM keeps being probed until the budget ends");
		assert.ok(calls.every(([pid, signal]) => pid === -424242 && signal === 0), "no signal follows an unexplained EPERM");
		assert.equal(listings, calls.length + 1, "every probe re-lists, after the start-of-cleanup snapshot");
	}));
	// A never-observed empty listing is a verdict, not a failure: it rejects at once.
	const neverSeen = Object.assign(new Error("EPERM"), { code: "EPERM" });
	const calls = [];
	await assert.rejects(
		reapProcessGroup(424242, (pid, signal) => {
			calls.push([pid, signal]);
			throw neverSeen;
		}, () => []),
		(actual) => actual === neverSeen,
	);
	assert.deepEqual(calls, [[-424242, 0]]);
	// A successful syscall never counts as observation: EPERM plus an empty listing on a group the
	// start-of-cleanup listing never showed still rethrows, however the earlier probes answered.
	const error = Object.assign(new Error("EPERM"), { code: "EPERM" });
	let probes = 0;
	await assert.rejects(
		reapProcessGroup(424242, () => {
			if (probes++ >= 2) throw error;
			return true;
		}, () => []),
		(actual) => actual === error,
	);
	assert.equal(probes, 3);
}

/**
 * @param {import('node:test').TestContext} t Test context; its mock restores `Date.now`.
 * @returns {Promise<void>} Verifies slow listings cannot carry a stage past the overall budget. @throws {Error} On assertion failure.
 */
async function verifyStageBudgetCap(t) {
	// A virtual clock that only `ps` advances, by its full bound per run, so the result is independent of load.
	let clock = 0;
	t.mock.method(Date, "now", () => clock);
	const first = Object.assign(new Error("EPERM"), { code: "EPERM" });
	const calls = [];
	await assert.rejects(
		reapProcessGroup(424242, (pid, signal) => {
			calls.push([pid, signal]);
			throw calls.length === 1 ? first : Object.assign(new Error("EPERM"), { code: "EPERM" });
		}, () => {
			clock += PS_TIMEOUT_MS;
			throw Object.assign(new Error("spawnSync /bin/ps ETIMEDOUT"), { code: "ETIMEDOUT" });
		}),
		(actual) => actual === first,
	);
	const budget = GROUP_TERM_GRACE_MS + GROUP_KILL_WAIT_MS;
	assert.ok(clock >= budget, `the unexplained EPERM is probed through the whole budget (ended at ${clock}ms)`);
	// SIGKILL is withheld while the EPERM is pending, so only the TERM stage's last probe and the KILL stage's
	// first can run past the budget. An uncapped KILL stage would keep its own 500ms from wherever TERM ended.
	assert.ok(clock - budget <= 2 * PS_TIMEOUT_MS, `slow listings overran the ${budget}ms budget by ${clock - budget}ms`);
	assert.ok(calls.every(([pid, signal]) => pid === -424242 && signal === 0), "no signal follows an unexplained EPERM");
}

/**
 * @param {number|undefined} pid Pid the fake child reports.
 * @returns {EventEmitter & {pid: number|undefined}} A child that never runs anything, for the `spawnChild` seam.
 * @throws {never} Construction cannot fail.
 */
function fakeChild(pid) {
	return Object.assign(new EventEmitter(), { pid });
}

/** @returns {Promise<void>} Verifies `runCancellable` never reaps or probes a child pid that cannot be an owned group. @throws {Error} On assertion failure. */
async function verifyUnownableChild() {
	assert.deepEqual([undefined, Number.NaN, 1.5, -2, -1, 0, 1, 2].map(isOwnableGroup), [false, false, false, false, false, false, false, true]);
	const signals = ["SIGTERM", "SIGINT", "SIGHUP", "exit"];
	const before = signals.map((signal) => process.listenerCount(signal));
	for (const pid of [1, 0, -1]) {
		const child = fakeChild(pid);
		const calls = [];
		const running = runCancellable("pi-cleanup-fake", [], {
			kill: (...call) => {
				calls.push(call);
				return true;
			},
			listStates: () => assert.fail(`listing must not run for pid ${pid}`),
			spawnChild: () => child,
		});
		child.emit("close", 0, null);
		await assert.rejects(running, /owned positive process-group ID above 1/);
		assert.deepEqual(calls, [], `close-time cleanup of pid ${pid} must make no kill call`);
		assert.deepEqual(signals.map((signal) => process.listenerCount(signal)), before);
	}
}

/**
 * @param {number} pid Pid the fake child reports.
 * @returns {Promise<unknown[]>} Every `kill` call the exit-time backstop made, through a recording `kill`.
 * @throws {Error} On wrapper failure or malformed output.
 */
async function exitBackstopTrace(pid) {
	// The child never closes, so only the exit-time backstop can reach `kill`, and it only records.
	const program = `
import { EventEmitter } from "node:events";
import { runCancellable } from ${JSON.stringify(setupUrl)};
const trace = [];
const child = Object.assign(new EventEmitter(), { pid: ${pid} });
void runCancellable("pi-cleanup-fake", [], { kill: (pid, signal) => { trace.push([pid, signal]); return true; }, listStates: () => [], spawnChild: () => child });
process.on("exit", () => console.log(JSON.stringify(trace)));
process.exit(0);
`;
	const { stdout } = await execute(process.execPath, ["--input-type=module", "-e", program], { timeout: 5000 });
	return JSON.parse(stdout.trim());
}

/** @returns {Promise<void>} Verifies the exit-time backstop is live for an ownable pid and silent for 1, 0 and -1. @throws {Error} On assertion failure. */
async function verifyUnownableExitBackstop() {
	// Control first, so silence below is not vacuous: an ownable pid gets a probe, then the exit KILL.
	assert.deepEqual(await exitBackstopTrace(424242), [[-424242, 0], [-424242, "SIGKILL"]]);
	for (const pid of [1, 0, -1]) assert.deepEqual(await exitBackstopTrace(pid), [], `pid ${pid} must get no exit-time kill`);
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
test("a timed-out listing keeps a zombie-only group draining without signalling", verifyUnknownListingKeepsDraining);
test("listGroupStates reads live, reaped and absent members from ps", verifyListGroupStates);
test("real Darwin zombie-only group drains to ESRCH", { skip: process.platform !== "darwin" && "only Darwin answers EPERM for a zombie-only group" }, verifyRealDarwinZombieGroup);
test("real Darwin zombie-only group that never drains is not reaped", { skip: process.platform !== "darwin" && "only Darwin answers EPERM for a zombie-only group" }, verifyRealPersistentZombieGroup);
test("pgid 1 is rejected before any kill (injected kill only)", verifyBroadcastGroupRejected);
test("EPERM with a failing listing rejects after the budget; a never-observed group at once", verifyInconclusiveListing);
test("slow listings cannot carry a stage past the overall budget", verifyStageBudgetCap);
test("runCancellable never reaps an unownable child pid (injected kill only)", verifyUnownableChild);
test("runCancellable exit backstop skips an unownable child pid (recording kill only)", verifyUnownableExitBackstop);
test("real Darwin zombie reaped between EPERM and ps keeps draining", { skip: process.platform !== "darwin" && "only Darwin answers EPERM for a zombie-only group" }, verifyRealReapBeforeListing);
