/**
 * Keep a fixture alive until its worker dies, even when SIGKILL bypasses afterEach. The fixture is
 * itself the detached group leader, so signalling its own group cannot target a reused PID. This
 * belongs only in STAY fixtures, not production spawn or leader/descendant lifecycle probes.
 */
export const STAY = `setInterval(() => {
	if (process.ppid !== ${process.pid}) process.kill(-process.pid, "SIGKILL");
}, 100);`;
