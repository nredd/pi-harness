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

/**
 * Shell condition true while `ownerPid` exists, probed with `ps`, for guarding any other fixture loop. `ps` is
 * a seam for `stay.test.ts` to stub the probe's exit status; fixtures keep the default.
 */
export const aliveSh = (ownerPid: number, ps = "/bin/ps"): string => `${ps} -p ${ownerPid} >/dev/null 2>&1`;

/**
 * Shell loop for `sh -c` fixtures: runs until `ownerPid` is gone, probed with `ps` (never a signal), so a
 * `SIGKILL`ed worker cannot leave a `trap "" TERM` descendant running forever. Test fixtures only.
 *
 * procps `ps` installs its own SIGTERM handler, overriding an inherited `trap "" TERM`, and exits 143 when a
 * group SIGTERM lands mid-probe. That status means "probe interrupted", not "owner gone", so the loop keeps
 * going on 0 or 143 and stops on anything else (1: no such pid).
 */
export const stayWhileAlive = (ownerPid: number, ps?: string): string =>
	`while :; do ${aliveSh(ownerPid, ps)}; case $? in 0|143) sleep 1 ;; *) break ;; esac; done`;

/** `stayWhileAlive` bound to this worker. */
export const STAY_SH = stayWhileAlive(process.pid);

/** `aliveSh` bound to this worker. */
export const WORKER_ALIVE_SH = aliveSh(process.pid);
