import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, test, vi } from "vitest";
import { deferred, runCheckCommand, stopCheckChild, within } from "../scripts/check-async.mjs";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

const platform = Object.getOwnPropertyDescriptor(process, "platform");
const gone = () => Object.assign(new Error("gone"), { code: "ESRCH" });
const denied = () => Object.assign(new Error("denied"), { code: "EPERM" });

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
	Object.defineProperty(process, "platform", platform);
	spawn.mockReset();
});

/** An owned child boundary, not a substitute implementation of cleanup policy. */
function child(overrides = {}) {
	return Object.assign(
		new EventEmitter(),
		{
			pid: 424242,
			exitCode: null,
			signalCode: null,
			stdout: new PassThrough(),
			stderr: new PassThrough(),
			kill: vi.fn(() => true),
			unref: vi.fn(),
		},
		overrides,
	);
}

/** Attach rejection observation before advancing watchdogs, avoiding unhandled rejections. */
const outcome = (promise) =>
	promise.then(
		(value) => ({ value }),
		(error) => ({ error }),
	);

test("within clears watchdogs on resolve, reject and deadline", async () => {
	assert.equal(await within(Promise.resolve(42), "ready"), 42);
	const primary = new Error("primary");
	assert.equal((await outcome(within(Promise.reject(primary), "failed"))).error, primary);
	const timed = outcome(within(deferred().promise, "missing", 3));
	await vi.advanceTimersByTimeAsync(3);
	assert.match((await timed).error.message, /Timed out waiting for missing/);
	assert.equal(vi.getTimerCount(), 0);
});

test("completed signal exits release pipes and never signal a former PID", async () => {
	const fixture = child({ signalCode: "SIGTERM", pid: undefined });
	const kill = vi.spyOn(process, "kill");
	await stopCheckChild(fixture, Promise.resolve(), "completed", true);
	assert.equal(fixture.kill.mock.calls.length, 0);
	assert.equal(kill.mock.calls.length, 0);
	assert.ok(fixture.stdout.destroyed && fixture.stderr.destroyed);
	assert.equal(fixture.unref.mock.calls.length, 1);
});

test("completed groups reject unexpected probe errors but always release handles", async () => {
	const fixture = child({ exitCode: 0, stdout: undefined, stderr: undefined });
	const failure = new Error("unexpected probe");
	vi.spyOn(process, "kill").mockImplementation(() => {
		throw failure;
	});
	assert.equal((await outcome(stopCheckChild(fixture, Promise.resolve(), "probe", true))).error, failure);
	assert.equal(fixture.unref.mock.calls.length, 1);
});

test("missing PID never signals and can acknowledge close", async () => {
	const fixture = child({ pid: undefined });
	await stopCheckChild(fixture, Promise.resolve(), "not spawned", true);
	assert.equal(fixture.kill.mock.calls.length, 0);
});

test.each(["ESRCH", "EPERM"])("group %s is not confused with quiescence", async (code) => {
	const fixture = child();
	const kill = vi.spyOn(process, "kill");
	if (code === "ESRCH") {
		kill.mockImplementation(() => {
			throw gone();
		});
		await stopCheckChild(fixture, Promise.resolve(), "setsid race", true);
		assert.deepEqual(fixture.kill.mock.calls, [["SIGTERM"]]);
	} else {
		kill.mockImplementation((_pid, signal) => {
			if (signal !== 0) return true;
			if (Date.now() < 40) throw denied();
			throw gone();
		});
		vi.setSystemTime(0);
		const stopped = outcome(stopCheckChild(fixture, Promise.resolve(), "transient EPERM", true));
		await vi.advanceTimersByTimeAsync(40);
		assert.equal((await stopped).error, undefined);
		assert.deepEqual(kill.mock.calls, [
			[-424242, "SIGTERM"],
			[-424242, 0],
			[-424242, 0],
			[-424242, 0],
		]);
	}
});

test("ESRCH fallback does not signal a leader whose ownership ended during the syscall", async () => {
	const fixture = child();
	vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
		if (signal !== 0) fixture.exitCode = 0;
		throw gone();
	});
	await stopCheckChild(fixture, Promise.resolve(), "exited during setsid", true);
	assert.equal(fixture.kill.mock.calls.length, 0);
});

test("persistent EPERM exhausts TERM and KILL budgets instead of reporting success", async () => {
	const fixture = child();
	const kill = vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
		if (signal === 0) throw denied();
		return true;
	});
	const stopped = outcome(stopCheckChild(fixture, Promise.resolve(), "denied group", true));
	await vi.advanceTimersByTimeAsync(10_000);
	const { error } = await stopped;
	assert.ok(error instanceof AggregateError);
	assert.equal(error.errors.length, 2);
	assert.match(error.errors[0].message, /after SIGTERM.*remains/);
	assert.match(error.errors[1].message, /after SIGKILL.*remains/);
	assert.deepEqual(
		kill.mock.calls.filter(([, signal]) => signal !== 0),
		[
			[-424242, "SIGTERM"],
			[-424242, "SIGKILL"],
		],
	);
	assert.ok(fixture.stdout.destroyed && fixture.stderr.destroyed);
	assert.equal(fixture.unref.mock.calls.length, 1);
	assert.equal(vi.getTimerCount(), 0);
});

test("TERM failure escalates to KILL; two syscall failures retain both causes", async () => {
	const term = new Error("TERM denied");
	const hard = new Error("KILL denied");
	const fixture = child();
	fixture.kill.mockImplementationOnce(() => {
		throw term;
	});
	await stopCheckChild(fixture, Promise.resolve(), "escalate");
	assert.deepEqual(fixture.kill.mock.calls, [["SIGTERM"], ["SIGKILL"]]);
	fixture.kill
		.mockReset()
		.mockImplementationOnce(() => {
			throw term;
		})
		.mockImplementationOnce(() => {
			throw hard;
		});
	fixture.stdout = undefined;
	fixture.stderr = undefined;
	const { error } = await outcome(stopCheckChild(fixture, Promise.resolve(), "both failed"));
	assert.deepEqual(error.errors, [term, hard]);
});

/** Start the actual command policy with only its spawn boundary replaced. */
function command(fixture, options = {}) {
	spawn.mockReturnValue(fixture);
	return outcome(
		runCheckCommand("fixture-executable", ["literal;not-a-shell"], {
			label: "command control",
			timeoutMs: 100,
			...options,
		}),
	);
}

test("no-shell spawn preserves argv and independent stdout/stderr exact byte caps", async () => {
	Object.defineProperty(process, "platform", { value: "win32" });
	const fixture = child();
	const result = command(fixture, { maxBuffer: 4, cwd: "/fixture", env: { FIXTURE: "1" } });
	fixture.stdout.write("éé");
	fixture.stderr.write("abcd");
	fixture.exitCode = 0;
	fixture.emit("close", 0, null);
	assert.deepEqual(await result, { value: { stdout: "éé", stderr: "abcd" } });
	assert.deepEqual(spawn.mock.calls, [
		[
			"fixture-executable",
			["literal;not-a-shell"],
			{
				cwd: "/fixture",
				env: { FIXTURE: "1" },
				detached: false,
				stdio: ["ignore", "pipe", "pipe"],
			},
		],
	]);
	assert.equal(vi.getTimerCount(), 0);
});

test.each(["stdout", "stderr"])("%s overflow is byte-counted and retains the bounded prefix", async (stream) => {
	Object.defineProperty(process, "platform", { value: "win32" });
	const fixture = child();
	const result = command(fixture, { maxBuffer: 3 });
	fixture[stream].write("éé");
	fixture[stream].write("more");
	fixture.exitCode = 1;
	fixture.emit("close", 1, null);
	const { error } = await result;
	assert.match(error.message, new RegExp(`${stream} exceeded 3 bytes`));
	assert.equal(error.cause[stream], Buffer.from("éé").subarray(0, 3).toString("utf8"));
	assert.equal(error.pid, 424242);
	assert.equal(fixture.kill.mock.calls.length, 0);
});

test("signal exits and absent streams preserve contextual failure", async () => {
	Object.defineProperty(process, "platform", { value: "win32" });
	const fixture = child({ stdout: undefined, stderr: undefined });
	const result = command(fixture);
	fixture.signalCode = "SIGINT";
	fixture.emit("close", null, "SIGINT");
	assert.match((await result).error.message, /command control.*exited with SIGINT/);
});

test("synchronous spawn errors need no cleanup and preserve the primary cause", async () => {
	const primary = new Error("spawn threw");
	spawn.mockImplementation(() => {
		throw primary;
	});
	const { error } = await outcome(runCheckCommand("bad", [], { label: "spawn", timeoutMs: 100 }));
	assert.equal(error.cause, primary);
	assert.equal(error.pid, undefined);
	assert.match(error.message, /spawn \(bad\) failed: spawn threw/);
});

test("spawn error plus cleanup failure keeps the primary and every cleanup cause", async () => {
	const fixture = child();
	const cleanup = new Error("signal denied");
	vi.spyOn(process, "kill").mockImplementation(() => {
		throw cleanup;
	});
	const result = command(fixture);
	const primary = new Error("spawn event failure");
	fixture.emit("error", primary);
	const { error } = await result;
	assert.equal(error.cause, primary);
	assert.deepEqual(error.cleanupFailure.errors, [cleanup, cleanup]);
	assert.match(error.message, /spawn event failure;.*bounded TERM\/KILL/);
	assert.ok(fixture.stdout.destroyed && fixture.stderr.destroyed);
});
