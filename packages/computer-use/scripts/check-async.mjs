import { spawn } from "node:child_process";
import fs from "node:fs/promises";

/** Default deadline for check-local readiness/completion promises, in milliseconds. */
export const DEFAULT_CHECK_TIMEOUT_MS = 5000;
/** Signal-handler registration must become observable within this startup budget. */
export const SIGNAL_READINESS_TIMEOUT_MS = 10_000;
/** Parent startup budget includes preload startup and child diagnostic headroom. */
export const PARENT_READINESS_TIMEOUT_MS = 15_000;
/** Grace for a timed-out check subprocess to close after TERM. */
export const COMMAND_TERM_WAIT_MS = 5000;
/** Hard cap for subprocess close after KILL. */
export const COMMAND_KILL_WAIT_MS = 5000;
/** Default per-stream output limit for disposable check commands. */
const COMMAND_MAX_OUTPUT_BYTES = 1024 * 1024;
/** Polling cadence for fixture-local signal-listener observation, in milliseconds. */
export const SIGNAL_READINESS_POLL_MS = 20;

/**
 * Create a fixture-owned readiness promise without introducing a startup delay.
 * @returns {{ promise: Promise<unknown>, resolve: (value?: unknown) => void }} The promise and its resolver.
 * @throws {Error} Propagates an unexpected Promise-construction failure.
 */
export function deferred() {
	let resolve;
	const promise = new Promise((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

/**
 * Bound an observable readiness/completion promise and always clear its watchdog.
 * @template T
 * @param {PromiseLike<T>} promise Observable operation, already started by the caller.
 * @param {string} label Context included in the deadline failure message.
 * @param {number} [timeoutMs=DEFAULT_CHECK_TIMEOUT_MS] Maximum wait, in milliseconds.
 * @returns {Promise<T>} The observable operation's result.
 * @throws {Error} If the deadline expires; propagates the operation's rejection unchanged.
 */
export async function within(
	promise,
	label,
	timeoutMs = DEFAULT_CHECK_TIMEOUT_MS,
) {
	let timer;
	try {
		return await Promise.race([
			promise,
			new Promise((_, reject) => {
				timer = setTimeout(
					() => reject(new Error(`Timed out waiting for ${label}`)),
					timeoutMs,
				);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Write a test-only Node preload that acknowledges real wrapper signal-handler registration.
 * The observer snapshots listeners before the entry point runs, never replaces them, and publishes
 * its PID only once all cancellation listeners and an exit listener have been added. Its timer is
 * unreferenced so observation cannot keep an otherwise completed wrapper alive.
 * @param {string} observerPath Destination module, loaded with Node's `--import` flag.
 * @param {string} markerPath PID marker to publish after observing handler registration.
 * @returns {Promise<void>} Completion of the observer-module write.
 * @throws {Error} Propagates filesystem errors. The generated preload fails contextually if registration times out.
 */
export async function writeSignalReadinessObserver(observerPath, markerPath) {
	await fs.writeFile(
		observerPath,
		`import fs from "node:fs";
const signals = ["SIGTERM", "SIGINT", "SIGHUP", "exit"];
const baseline = new Map(signals.map(signal => [signal, process.listenerCount(signal)]));
const deadline = Date.now() + ${SIGNAL_READINESS_TIMEOUT_MS};
const poll = setInterval(() => {
  const missing = signals.filter(signal => process.listenerCount(signal) <= baseline.get(signal));
  if (missing.length === 0) {
    fs.writeFileSync(${JSON.stringify(markerPath)}, String(process.pid));
    clearInterval(poll);
  } else if (Date.now() >= deadline) {
    clearInterval(poll);
    throw new Error("Timed out observing wrapper signal-handler registration: " + missing.join(", "));
  }
}, ${SIGNAL_READINESS_POLL_MS});
poll.unref();
`,
	);
}

/**
 * Terminate an owned check subprocess, bounding both TERM and KILL close waits.
 * @param {import('node:child_process').ChildProcess} child Subprocess owned by this check.
 * @param {PromiseLike<unknown>} closed Promise subscribed before termination can begin.
 * @param {string} label Operation name included in cleanup failures.
 * @param {boolean} [group=false] Signal the detached POSIX group rather than only its leader.
 * @returns {Promise<void>} Resolves once the subprocess closes.
 * @throws {AggregateError} If both bounded termination attempts fail.
 */
export async function stopCheckChild(child, closed, label, group = false) {
	const failures = [];
	for (const [signal, waitMs] of [
		["SIGTERM", COMMAND_TERM_WAIT_MS],
		["SIGKILL", COMMAND_KILL_WAIT_MS],
	]) {
		try {
			if (child.pid !== undefined) {
				try {
					if (group) process.kill(-child.pid, signal);
					else child.kill(signal);
				} catch (error) {
					if (error.code !== "ESRCH") throw error;
				}
			}
			await within(closed, `${label} to close after ${signal}`, waitMs);
			return;
		} catch (error) {
			failures.push(error);
		}
	}
	child.stdout?.destroy();
	child.stderr?.destroy();
	child.unref();
	throw new AggregateError(
		failures,
		`${label}: subprocess did not close after bounded TERM/KILL cleanup`,
	);
}

/**
 * Execute a no-shell check command with a contextual deadline and capped group cleanup.
 * @param {string} command Executable, never a shell command string.
 * @param {string[]} args Executable arguments.
 * @param {{label: string, timeoutMs: number, cwd?: string, env?: NodeJS.ProcessEnv, maxBuffer?: number}} options Explicit operation budget and capture options.
 * @returns {Promise<{stdout: string, stderr: string}>} UTF-8 output after successful close.
 * @throws {Error} On spawn/nonzero-exit/deadline failure; includes operation context and child PID.
 */
export async function runCheckCommand(
	command,
	args,
	{ label, timeoutMs, cwd, env, maxBuffer = COMMAND_MAX_OUTPUT_BYTES },
) {
	let child;
	let didClose = false;
	let markClosed;
	const closed = new Promise((resolve) => {
		markClosed = resolve;
	});
	const group = process.platform !== "win32";
	let stdout = "";
	let stderr = "";
	const sizes = { stdout: 0, stderr: 0 };
	const result = new Promise((resolve, reject) => {
		child = spawn(command, args, {
			cwd,
			env,
			detached: group,
			stdio: ["ignore", "pipe", "pipe"],
		});
		/**
		 * Capture bounded UTF-8 output without allowing a runaway command to exhaust memory.
		 * @param {"stdout"|"stderr"} stream Captured stream.
		 * @param {string} chunk Decoded stream data.
		 * @returns {void} Completion of capture or rejection.
		 * @throws {never} Over-limit output rejects the operation instead of throwing in an event callback.
		 */
		const capture = (stream, chunk) => {
			const bytes = Buffer.byteLength(chunk);
			const available = Math.max(0, maxBuffer - sizes[stream]);
			const kept =
				bytes <= available
					? chunk
					: Buffer.from(chunk).subarray(0, available).toString("utf8");
			if (stream === "stdout") stdout += kept;
			else stderr += kept;
			sizes[stream] += bytes;
			if (sizes[stream] > maxBuffer)
				reject(new Error(`${stream} exceeded ${maxBuffer} bytes`));
		};
		child.stdout
			?.setEncoding("utf8")
			.on("data", (chunk) => capture("stdout", chunk));
		child.stderr
			?.setEncoding("utf8")
			.on("data", (chunk) => capture("stderr", chunk));
		child.once("error", reject);
		child.once("close", (code, signal) => {
			didClose = true;
			markClosed();
			if (code === 0) resolve({ stdout, stderr });
			else reject(new Error(`exited with ${code ?? signal}`));
		});
	});
	try {
		return await within(result, `${label} (${command}) to complete`, timeoutMs);
	} catch (error) {
		Object.assign(error, { stdout, stderr });
		let cleanupFailure;
		if (child && !didClose) {
			try {
				await stopCheckChild(child, closed, label, group);
			} catch (failure) {
				cleanupFailure = failure;
			}
		}
		const failure = new Error(
			`${label} (${command}) failed: ${error.message}${cleanupFailure ? `; ${cleanupFailure.message}` : ""}`,
			{ cause: error },
		);
		failure.pid = child?.pid;
		if (cleanupFailure) failure.cleanupFailure = cleanupFailure;
		throw failure;
	}
}
