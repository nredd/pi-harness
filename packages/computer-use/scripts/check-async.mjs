import fs from "node:fs/promises";

/** Default deadline for check-local readiness/completion promises, in milliseconds. */
export const DEFAULT_CHECK_TIMEOUT_MS = 5000;
/** Signal-handler registration must become observable within this startup budget. */
export const SIGNAL_READINESS_TIMEOUT_MS = 10_000;
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
