import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import {
	COMMAND_KILL_WAIT_MS,
	COMMAND_TERM_WAIT_MS,
	DEFAULT_CHECK_TIMEOUT_MS,
	deferred,
	finishCheckCleanup,
	runCheckCommand,
	SIGNAL_READINESS_POLL_MS,
	SIGNAL_READINESS_TIMEOUT_MS,
	stopCheckChild,
	within,
	writeSignalReadinessObserver,
} from "./check-async.mjs";

const NEGATIVE_CONTROL_TIMEOUT_MS = 1;
const COMMAND_TIMEOUT_CONTROL_MS = 25;
const HANGING_COMMAND_INTERVAL_MS = 1000;

test("deferred readiness resolves through a bounded completion wait", async () => {
	const gate = deferred();
	gate.resolve("ready");
	assert.equal(await within(gate.promise, "resolved readiness"), "ready");
});

test("completion watchdog preserves rejection and reports missing readiness context", async () => {
	const failure = new Error("fixture failed");
	await assert.rejects(
		within(Promise.reject(failure), "failed fixture"),
		(error) => error === failure,
	);
	await assert.rejects(
		within(
			new Promise(() => {}),
			"deliberately missing readiness",
			NEGATIVE_CONTROL_TIMEOUT_MS,
		),
		/Timed out waiting for deliberately missing readiness/,
	);
});

test("signal observer waits for registration in the actual wrapper process", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-signal-observer-"));
	const marker = path.join(dir, "wrapper.pid");
	const observer = path.join(dir, "observer.mjs");
	let child;
	let stopPolling = false;
	try {
		await writeSignalReadinessObserver(observer, marker);
		const entered = deferred();
		child = spawn(
			process.execPath,
			[
				"--import",
				pathToFileURL(observer).href,
				"-e",
				`
process.on("message", message => {
  if (message === "register") {
    for (const signal of ["SIGTERM", "SIGINT", "SIGHUP", "exit"]) process.on(signal, () => {});
  }
});
process.send("entered");
`,
			],
			{ stdio: ["ignore", "ignore", "inherit", "ipc"] },
		);
		const closed = new Promise((resolve, reject) => {
			child.once("error", reject);
			child.once("close", resolve);
		});
		child.once("message", (message) => entered.resolve(message));
		assert.equal(
			await within(
				Promise.race([
					entered.promise,
					closed.then(() => {
						throw new Error(
							"Observer fixture closed before entry acknowledgment",
						);
					}),
				]),
				"unregistered wrapper entry",
			),
			"entered",
		);
		assert.equal(
			await fs.stat(marker).then(
				() => true,
				() => false,
			),
			false,
			"entry alone must not publish handler readiness",
		);
		child.send("register");
		/**
		 * Poll the private marker until registration or fixture cleanup.
		 * @returns {Promise<number|undefined>} Acknowledged PID, or cleanup cancellation.
		 * @throws {never} Missing marker files are treated as not-ready.
		 */
		const observed = (async () => {
			while (!stopPolling) {
				const pid = Number(await fs.readFile(marker, "utf8").catch(() => ""));
				if (pid > 0) return pid;
				await new Promise((resolve) =>
					setTimeout(resolve, SIGNAL_READINESS_POLL_MS),
				);
			}
		})();
		assert.equal(
			await within(observed, "post-registration wrapper marker"),
			child.pid,
		);
		child.kill("SIGKILL");
		await within(closed, "observer fixture to close");
	} finally {
		stopPolling = true;
		child?.kill("SIGKILL");
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("signal observer fails contextually when wrapper handlers never register", async () => {
	const dir = await fs.mkdtemp(
		path.join(os.tmpdir(), "pi-signal-observer-missing-"),
	);
	const observer = path.join(dir, "observer.mjs");
	const marker = path.join(dir, "wrapper.pid");
	let child;
	try {
		await writeSignalReadinessObserver(observer, marker);
		child = spawn(
			process.execPath,
			[
				"--import",
				pathToFileURL(observer).href,
				"-e",
				`setInterval(() => {}, ${SIGNAL_READINESS_POLL_MS});`,
			],
			{ stdio: ["ignore", "ignore", "pipe"] },
		);
		let stderr = "";
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		const closed = new Promise((resolve, reject) => {
			child.once("error", reject);
			child.once("close", (code) => resolve(code));
		});
		assert.equal(
			await within(
				closed,
				"unregistered observer to report its deadline failure",
				SIGNAL_READINESS_TIMEOUT_MS + DEFAULT_CHECK_TIMEOUT_MS,
			),
			1,
		);
		assert.match(
			stderr,
			/Timed out observing wrapper signal-handler registration: SIGTERM, SIGINT, SIGHUP, exit/,
		);
		assert.equal(
			await fs.stat(marker).then(
				() => true,
				() => false,
			),
			false,
		);
	} finally {
		child?.kill("SIGKILL");
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("bounded check commands capture streams and contextual nonzero failures", async () => {
	const result = await runCheckCommand(
		process.execPath,
		["-e", 'process.stdout.write("out"); process.stderr.write("err");'],
		{ label: "capture control", timeoutMs: DEFAULT_CHECK_TIMEOUT_MS },
	);
	assert.deepEqual(result, { stdout: "out", stderr: "err" });
	await assert.rejects(
		runCheckCommand("pi-check-definitely-missing-command", [], {
			label: "spawn control",
			timeoutMs: DEFAULT_CHECK_TIMEOUT_MS,
		}),
		(error) => {
			assert.match(error.message, /spawn control/);
			assert.equal(error.cause.code, "ENOENT");
			return true;
		},
	);
	await assert.rejects(
		runCheckCommand(
			process.execPath,
			[
				"-e",
				`process.stdout.write("oversized"); setInterval(() => {}, ${HANGING_COMMAND_INTERVAL_MS});`,
			],
			{
				label: "buffer control",
				timeoutMs: DEFAULT_CHECK_TIMEOUT_MS,
				maxBuffer: 4,
			},
		),
		/buffer control.*stdout exceeded 4 bytes/s,
	);
	await assert.rejects(
		runCheckCommand(
			process.execPath,
			["-e", 'process.stderr.write("failure detail"); process.exitCode = 7;'],
			{ label: "nonzero control", timeoutMs: DEFAULT_CHECK_TIMEOUT_MS },
		),
		(error) => {
			assert.match(error.message, /nonzero control/);
			assert.equal(error.cause.stderr, "failure detail");
			return true;
		},
	);
});

test("command deadline closes its real child and reports operation context", async () => {
	await assert.rejects(
		runCheckCommand(
			process.execPath,
			["-e", `setInterval(() => {}, ${HANGING_COMMAND_INTERVAL_MS});`],
			{
				label: "hanging command control",
				timeoutMs: COMMAND_TIMEOUT_CONTROL_MS,
			},
		),
		(error) => {
			assert.match(error.message, /hanging command control.*Timed out/s);
			assert.equal(typeof error.pid, "number");
			try {
				assert.throws(() => process.kill(error.pid, 0), { code: "ESRCH" });
			} finally {
				try {
					process.kill(error.pid, 0);
					process.kill(error.pid, "SIGKILL");
				} catch {
					/* The successful path has already reaped this owned fixture. */
				}
			}
			return true;
		},
	);
});

test("failed and missing close attempts keep cleanup bounded", {
	timeout:
		COMMAND_TERM_WAIT_MS + COMMAND_KILL_WAIT_MS + DEFAULT_CHECK_TIMEOUT_MS,
}, async () => {
	const signals = [];
	let destroyed = 0;
	let unreferenced = false;
	const stream = {
		/**
		 * Record fixture pipe teardown.
		 * @returns {void} Completion of recording.
		 * @throws {never} The mock cannot fail.
		 */
		destroy: () => {
			destroyed += 1;
		},
	};
	const child = {
		pid: 424242,
		stdout: stream,
		stderr: stream,
		/**
		 * Record a simulated signal without contacting the kernel.
		 * @param {string} signal Requested cleanup signal.
		 * @returns {boolean} Simulated success.
		 * @throws {never} The mock cannot fail.
		 */
		kill: (signal) => {
			signals.push(signal);
			return true;
		},
		/**
		 * Record fixture handle release.
		 * @returns {void} Completion of recording.
		 * @throws {never} The mock cannot fail.
		 */
		unref: () => {
			unreferenced = true;
		},
	};
	await assert.rejects(
		stopCheckChild(
			child,
			Promise.reject(new Error("close failed")),
			"failed close control",
		),
		AggregateError,
	);
	assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
	assert.equal(destroyed, 2);
	assert.equal(unreferenced, true);
	signals.length = 0;
	destroyed = 0;
	unreferenced = false;
	await assert.rejects(
		stopCheckChild(child, new Promise(() => {}), "missing close control"),
		(error) => {
			assert(error instanceof AggregateError);
			assert.equal(error.errors.length, 2);
			assert.match(error.errors[0].message, /after SIGTERM/);
			assert.match(error.errors[1].message, /after SIGKILL/);
			return true;
		},
	);
	assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
	assert.equal(destroyed, 2);
	assert.equal(unreferenced, true);
});

test("cleanup attempts every action and retains primary plus cleanup errors", async () => {
	const primary = new Error("primary check failure");
	const permissions = new Error("permission restore failed");
	const removal = new Error("scratch removal failed");
	const calls = [];
	await assert.rejects(
		finishCheckCleanup(
			"cleanup control",
			[
				async () => {
					calls.push("permissions");
					throw permissions;
				},
				async () => {
					calls.push("removal");
					throw removal;
				},
			],
			primary,
		),
		(error) => {
			assert(error instanceof AggregateError);
			assert.deepEqual(error.errors, [primary, permissions, removal]);
			return true;
		},
	);
	assert.deepEqual(calls, ["permissions", "removal"]);
	await finishCheckCleanup("successful cleanup", [async () => {}], primary);
	await assert.rejects(
		finishCheckCleanup("cleanup-only failure", [
			async () => {
				throw removal;
			},
		]),
		(error) => {
			assert.deepEqual(error.errors, [removal]);
			return true;
		},
	);
});
