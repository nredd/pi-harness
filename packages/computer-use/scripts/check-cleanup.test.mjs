import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { promisify } from "node:util";
import { reapProcessGroup } from "./setup-helper.mjs";

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
	await assert.rejects(
		runCancellable("/nonexistent/pi-cleanup-tool", [], { kill: () => assert.fail("PID-less spawn must not signal") }),
		/not found on PATH/,
	);
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(
		signals.map((signal) => process.listenerCount(signal)),
		before,
	);
}

test("ESRCH is terminal, including signal-time disappearance", verifyTerminalAbsence);
test("EPERM and EIO preserve probe and delivery failures", verifySyscallErrors);
test("invalid group IDs never reach kill", verifyInvalidGroups);
test("wrapper errors revoke fallback ownership; ESRCH proves reaped", verifyWrapperOwnership);
test("persistent positive probes preserve primary error and guarded fallback", verifyPersistentGroup);
test("cancellation handles cleanup rejection without a foreign exit KILL", verifyCancelledCleanup);
test("PID-less spawn failure releases listeners without group syscalls", verifySpawnFailure);
