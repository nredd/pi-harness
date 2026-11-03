/**
 * Keep a fixture alive until its worker dies, even when SIGKILL bypasses afterEach. `STAY` signals
 * nothing: it only exits itself. This belongs only in test fixtures, not production spawn or
 * leader/descendant lifecycle probes.
 */
export const STAY = `setInterval(() => {
	if (process.ppid !== ${process.pid}) process.exit(1);
}, 100);`;

/**
 * `STAY` for the worker-death fixture only: its monitor is the detached group leader and owns a
 * descendant, so it SIGKILLs its own group, addressed by its own pid, never another value.
 */
export const STAY_GROUP = `setInterval(() => {
	if (process.ppid !== ${process.pid} && process.pid > 1) process.kill(-process.pid, "SIGKILL");
}, 100);`;
