/** Writer claims (#1247) as another process on this host and PID namespace would leave them. */
import { writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { onTestFinished, vi } from "vitest";
import { claimHost } from "../../src/transcript-claim.ts";

/** A claim body naming `pid`, by default on this host and in this PID domain. */
export function holderBody(pid: number, overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({ pid, host: hostname(), domain: claimHost.pidDomain(), ...overrides });
}

/** Write a claim body (or raw text) at `claimPath`. */
export function writeHolder(claimPath: string, pid: number, overrides: Record<string, unknown> = {}): void {
	writeFileSync(claimPath, holderBody(pid, overrides));
}

/** Above any `pid_max`, so never a real process; `stubExited` makes it read as gone. */
export const EXITED_PID = 2 ** 30;

/**
 * Make `kill(pid, 0)` report `ESRCH` for `EXITED_PID` (a writer that crashed)
 * and `EPERM` for `foreignPid` when given, passing every other call through,
 * for the rest of the test. No real exited pid, which the host may reuse.
 */
export function stubExited(foreignPid?: number): void {
	const kill = process.kill.bind(process);
	const spy = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
		const code = pid === EXITED_PID ? "ESRCH" : pid === foreignPid ? "EPERM" : undefined;
		if (code !== undefined) throw Object.assign(new Error(`kill ${code}`), { code });
		return kill(pid, signal);
	});
	onTestFinished(() => spy.mockRestore());
}
