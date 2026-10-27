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
/**
 * One-second recurring handles keep fixtures alive until explicit cancellation, not readiness.
 * The enclosing bounded test/command is the failure backstop; these handles never self-exit.
 */
const HANGING_COMMAND_INTERVAL_MS = 1000;

test("deferred readiness resolves through a bounded completion wait" /** @returns {Promise<void>} Verifies acknowledged readiness. @throws {Error} On timeout or assertion failure. */, async () => {
	const gate = deferred();
	gate.resolve("ready");
	assert.equal(await within(gate.promise, "resolved readiness"), "ready");
});

test("completion watchdog preserves rejection and reports missing readiness context" /** @returns {Promise<void>} Verifies rejection identity and timeout context. @throws {Error} On assertion failure. */, async () => {
	const failure = new Error("fixture failed");
	await assert.rejects(
		within(Promise.reject(failure), "failed fixture"),
		/** @returns {boolean} Whether rejection identity is preserved. @throws {never} No errors. */
		(error) => error === failure,
	);
	await assert.rejects(
		within(
			new Promise(
				/** @returns {void} Leaves readiness deliberately unresolved. @throws {never} No errors. */
				() => {},
			),
			"deliberately missing readiness",
			NEGATIVE_CONTROL_TIMEOUT_MS,
		),
		/Timed out waiting for deliberately missing readiness/,
	);
});

test("signal observer waits for registration in the actual wrapper process" /** @returns {Promise<void>} Verifies post-registration readiness. @throws {Error} On fixture or assertion failure. */, async () => {
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
		const closed = new Promise(
			/** @returns {void} Subscribes before fixture exit. @throws {never} Child errors reject the promise. */
			(resolve, reject) => {
				child.once("error", reject);
				child.once("close", resolve);
			},
		);
		child.once(
			"message",
			/** @returns {void} Acknowledges fixture entry. @throws {never} No errors. */
			(message) => entered.resolve(message),
		);
		assert.equal(
			await within(
				Promise.race([
					entered.promise,
					closed.then(
						/** @returns {never} Never returns. @throws {Error} If exit precedes acknowledgment. */
						() => {
							throw new Error(
								"Observer fixture closed before entry acknowledgment",
							);
						},
					),
				]),
				"unregistered wrapper entry",
			),
			"entered",
		);
		assert.equal(
			await fs.stat(marker).then(
				/** @returns {boolean} Records an existing marker. @throws {never} No errors. */
				() => true,
				/** @returns {boolean} Records an absent marker. @throws {never} No errors. */
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
				const pid = Number(
					await fs.readFile(marker, "utf8").catch(
						/** @returns {string} Missing markers are not ready. @throws {never} No errors. */
						() => "",
					),
				);
				if (pid > 0) return pid;
				await new Promise(
					/** @returns {NodeJS.Timeout} Schedules another bounded marker poll. @throws {never} No errors. */
					(resolve) => setTimeout(resolve, SIGNAL_READINESS_POLL_MS),
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

test("signal observer fails contextually when wrapper handlers never register" /** @returns {Promise<void>} Verifies missing-handler deadline diagnostics. @throws {Error} On fixture or assertion failure. */, async () => {
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
		child.stderr.on(
			"data",
			/** @returns {void} Captures observer diagnostics. @throws {never} No errors for stream buffers. */
			(chunk) => {
				stderr += chunk;
			},
		);
		const closed = new Promise(
			/** @returns {void} Registers observer closure. @throws {never} Spawn errors reject the promise. */
			(resolve, reject) => {
				child.once("error", reject);
				child.once(
					"close",
					/** @returns {void} Resolves the observer exit code. @throws {never} No errors. */
					(code) => resolve(code),
				);
			},
		);
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
				/** @returns {boolean} Records an existing marker. @throws {never} No errors. */
				() => true,
				/** @returns {boolean} Records an absent marker. @throws {never} No errors. */
				() => false,
			),
			false,
		);
	} finally {
		child?.kill("SIGKILL");
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("bounded check commands capture streams and contextual nonzero failures" /** @returns {Promise<void>} Verifies output, spawn and nonzero failures. @throws {Error} On command or assertion failure. */, async () => {
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
		/** @returns {boolean} Accepts contextual ENOENT. @throws {Error} On diagnostic mismatch. */
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
		/** @returns {boolean} Accepts preserved stderr. @throws {Error} On diagnostic mismatch. */
		(error) => {
			assert.match(error.message, /nonzero control/);
			assert.equal(error.cause.stderr, "failure detail");
			return true;
		},
	);
});

test("command deadline closes its real child and reports operation context" /** @returns {Promise<void>} Verifies timed-out child cleanup. @throws {Error} On missing failure or live-child assertion. */, async () => {
	await assert.rejects(
		runCheckCommand(
			process.execPath,
			["-e", `setInterval(() => {}, ${HANGING_COMMAND_INTERVAL_MS});`],
			{
				label: "hanging command control",
				timeoutMs: COMMAND_TIMEOUT_CONTROL_MS,
			},
		),
		/** @returns {boolean} Accepts a contextual deadline with a dead child. @throws {Error} On diagnostic or cleanup mismatch. */
		(error) => {
			assert.match(error.message, /hanging command control.*Timed out/s);
			assert.equal(typeof error.pid, "number");
			try {
				assert.throws(
					/** @returns {boolean} Probes the timed-out child. @throws {Error} ESRCH proves it exited. */
					() => process.kill(error.pid, 0),
					{ code: "ESRCH" },
				);
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

test("group cleanup kills a redirected TERM-ignoring descendant after its leader closes", {
	skip: process.platform === "win32",
	timeout:
		COMMAND_TERM_WAIT_MS + COMMAND_KILL_WAIT_MS + DEFAULT_CHECK_TIMEOUT_MS,
} /** @returns {Promise<void>} Verifies group escalation after leader closure. @throws {Error} On fixture or survivor assertion failure. */, async () => {
	const ready = deferred();
	const descendantSource = `
process.on("SIGTERM", /** @returns {void} Ignores TERM. @throws {never} No errors. */ () => {});
setInterval(/** @returns {void} Retains descendant liveness. @throws {never} No errors. */ () => {}, ${HANGING_COMMAND_INTERVAL_MS});
process.send(process.pid, /** @returns {void} Releases readiness IPC. @throws {Error} On disconnect failure. */ () => process.disconnect());
`;
	const child = spawn(
		process.execPath,
		[
			"-e",
			`
const { spawn } = require("node:child_process");
process.on("SIGTERM", /** @returns {never} Exits the responsive leader. @throws {never} Terminates the process. */ () => process.exit(0));
const descendant = spawn(process.execPath, ["-e", ${JSON.stringify(descendantSource)}], {
  stdio: ["ignore", "ignore", "ignore", "ipc"],
});
descendant.on("message", /** @returns {boolean} Publishes descendant readiness. @throws {Error} On output failure. */ pid => process.stdout.write(String(pid) + "\\n"));
setInterval(/** @returns {void} Retains leader liveness. @throws {never} No errors. */ () => {}, ${HANGING_COMMAND_INTERVAL_MS});
`,
		],
		{ detached: true, stdio: ["ignore", "pipe", "pipe"] },
	);
	const closed = new Promise(
		/** @returns {void} Subscribes to redirected-fixture closure. @throws {never} Spawn failures reject the promise. */
		(resolve, reject) => {
			child.once("error", reject);
			child.once("close", resolve);
		},
	);
	child.stdout.once(
		"data",
		/** @returns {void} Acknowledges the descendant's installed handler. @throws {never} No errors for a valid buffer. */
		(chunk) => ready.resolve(Number(String(chunk).trim())),
	);
	let reaped = false;
	try {
		const descendant = await within(
			ready.promise,
			"redirected descendant handler readiness",
		);
		assert.ok(Number.isInteger(descendant) && descendant > 0);
		await stopCheckChild(child, closed, "redirected descendant control", true);
		assert.throws(
			/** @returns {boolean} Probes the fixture group. @throws {Error} ESRCH proves group quiescence. */
			() => process.kill(-child.pid, 0),
			{ code: "ESRCH" },
		);
		assert.throws(
			/** @returns {boolean} Probes the redirected descendant. @throws {Error} ESRCH proves it exited. */
			() => process.kill(descendant, 0),
			{ code: "ESRCH" },
		);
		reaped = true;
	} finally {
		if (!reaped) {
			try {
				process.kill(-child.pid, "SIGKILL");
			} catch {
				/* Best-effort fallback must not replace the failed regression assertion. */
			}
		}
		await within(closed, "redirected descendant fixture to close");
	}
});

test("completed detached sessions only probe their former group" /** @returns {Promise<void>} Verifies probe-only cleanup despite an observable former PGID. @throws {Error} On any non-probe signal. */, async (context) => {
	const calls = [];
	context.mock.method(
		process,
		"kill",
		/** @returns {boolean} First observes a possibly recycled group. @throws {Error} On non-probe signals, then ESRCH on the next probe. */
		(pid, signal) => {
			calls.push([pid, signal]);
			assert.equal(
				signal,
				0,
				"a completed session must never signal a possibly recycled group",
			);
			if (calls.length === 1) return true;
			throw Object.assign(new Error("group gone"), { code: "ESRCH" });
		},
	);
	await stopCheckChild(
		{
			pid: 424242,
			exitCode: 0,
			signalCode: null,
			/** @returns {void} Completes mock handle release. @throws {never} No errors. */
			unref: () => {},
		},
		Promise.resolve(),
		"successful session control",
		true,
	);
	assert.deepEqual(calls, [
		[-424242, 0],
		[-424242, 0],
	]);
});

test("completed group cleanup bounds inherited stream lifetime" /** @returns {Promise<void>} Verifies probe-only cleanup also releases retained handles. @throws {Error} On missing deadline or handle release. */, async (context) => {
	let destroyed = 0;
	let unreferenced = false;
	context.mock.method(
		process,
		"kill",
		/** @returns {never} Never returns. @throws {Error} No signal is safe after completed-leader ownership release. */
		() => {
			throw new Error("must not signal completed fixture");
		},
	);
	const stream = {
		/** @returns {void} Records pipe release. @throws {never} No errors. */
		destroy: () => {
			destroyed += 1;
		},
	};
	await assert.rejects(
		stopCheckChild(
			{
				pid: 424242,
				exitCode: 0,
				signalCode: null,
				stdout: stream,
				stderr: stream,
				/** @returns {void} Records handle release. @throws {never} No errors. */
				unref: () => {
					unreferenced = true;
				},
			},
			new Promise(
				/** @returns {void} Simulates inherited streams that never close. @throws {never} No errors. */
				() => {},
			),
			"completed stream control",
			true,
		),
		/Timed out waiting for completed stream control completed leader streams/,
	);
	assert.equal(destroyed, 2);
	assert.equal(unreferenced, true);
});

test("failed and missing close attempts keep cleanup bounded", {
	timeout:
		COMMAND_TERM_WAIT_MS + COMMAND_KILL_WAIT_MS + DEFAULT_CHECK_TIMEOUT_MS,
} /** @returns {Promise<void>} Verifies failed and missing stream-close backstops. @throws {Error} On signal sequence or cleanup mismatch. */, async () => {
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
		stopCheckChild(
			child,
			new Promise(
				/** @returns {void} Deliberately never acknowledges stream closure. @throws {never} No errors. */
				() => {},
			),
			"missing close control",
		),
		/** @returns {boolean} Accepts both bounded cleanup failures. @throws {Error} On missing timeout context. */
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

test("cleanup attempts every action and retains primary plus cleanup errors" /** @returns {Promise<void>} Verifies cleanup aggregation and primary-error retention. @throws {Error} On ordering or error identity mismatch. */, async () => {
	const primary = new Error("primary check failure");
	const permissions = new Error("permission restore failed");
	const removal = new Error("scratch removal failed");
	const calls = [];
	await assert.rejects(
		finishCheckCleanup(
			"cleanup control",
			[
				/** @returns {Promise<never>} Never resolves. @throws {Error} Injects permission restoration failure. */
				async () => {
					calls.push("permissions");
					throw permissions;
				},
				/** @returns {Promise<never>} Never resolves. @throws {Error} Injects scratch removal failure. */
				async () => {
					calls.push("removal");
					throw removal;
				},
			],
			primary,
		),
		/** @returns {boolean} Accepts preserved primary and cleanup errors. @throws {Error} On lost errors or ordering mismatch. */
		(error) => {
			assert(error instanceof AggregateError);
			assert.deepEqual(error.errors, [primary, permissions, removal]);
			return true;
		},
	);
	assert.deepEqual(calls, ["permissions", "removal"]);
	await finishCheckCleanup(
		"successful cleanup",
		[
			/** @returns {Promise<void>} Completes successful cleanup. @throws {never} No errors. */
			async () => {},
		],
		primary,
	);
	await assert.rejects(
		finishCheckCleanup("cleanup-only failure", [
			/** @returns {Promise<never>} Never resolves. @throws {Error} Injects cleanup-only failure. */
			async () => {
				throw removal;
			},
		]),
		/** @returns {boolean} Accepts a cleanup-only aggregate. @throws {Error} On an unexpected error list. */
		(error) => {
			assert.deepEqual(error.errors, [removal]);
			return true;
		},
	);
});
