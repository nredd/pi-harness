/**
 * Keep a fixture alive until its worker dies, even when SIGKILL bypasses afterEach. `STAY` signals
 * nothing: it only exits itself. This belongs only in test fixtures, not production spawn or
 * leader/descendant lifecycle probes.
 */
export const STAY = stayFor(process.pid);

/**
 * `STAY` for a fixture whose parent is `ownerPid` rather than this worker, e.g. a script fixture run
 * with `vm.runInThisContext(stayFor(owner))`. Exits itself once `ownerPid` stops being its parent. Pass
 * the owner in from the spawner: read late, `process.ppid` may already be the reaper.
 */
export function stayFor(ownerPid: number): string {
	return `setInterval(() => {
	if (process.ppid !== ${ownerPid}) process.exit(1);
}, 100);`;
}

/**
 * `STAY` for the worker-death fixture only: its monitor is the detached group leader and owns a
 * descendant, so it SIGKILLs its own group, addressed by its own pid, never another value.
 */
export const STAY_GROUP = `setInterval(() => {
	if (process.ppid !== ${process.pid}) process.kill(-process.pid, "SIGKILL");
}, 100);`;

/** Shell condition true while `ownerPid` exists, probed with `ps`, for guarding any other fixture loop. */
export const aliveSh = (ownerPid: number): string => `/bin/ps -p ${ownerPid} >/dev/null 2>&1`;

/**
 * Shell loop for `sh -c` fixtures: runs until `ownerPid` is gone, probed with `ps` (never a signal), so a
 * `SIGKILL`ed worker cannot leave a `trap "" TERM` descendant running forever. Test fixtures only.
 */
export const stayWhileAlive = (ownerPid: number): string => `while ${aliveSh(ownerPid)}; do sleep 1; done`;

/** `stayWhileAlive` bound to this worker. */
export const STAY_SH = stayWhileAlive(process.pid);

/** `aliveSh` bound to this worker. */
export const WORKER_ALIVE_SH = aliveSh(process.pid);
