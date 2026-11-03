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

/**
 * Shell loop for `sh -c` fixtures: runs until `ownerPid` is gone, probed with `ps` (never a signal), so a
 * `SIGKILL`ed worker cannot leave a `trap "" TERM` descendant running forever. Test fixtures only.
 */
export const stayWhileAlive = (ownerPid: number): string =>
	`while /bin/ps -p ${ownerPid} >/dev/null 2>&1; do sleep 1; done`;

/** `stayWhileAlive` bound to this worker. */
export const STAY_SH = stayWhileAlive(process.pid);
