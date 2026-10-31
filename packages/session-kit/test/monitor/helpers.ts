import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { signalGroup, spawnMonitor } from "../../src/monitor/process.ts";
import { STAY } from "./stay.ts";

export const SLEEPER = ["node", "-e", STAY];

export function tempDir(): { dir: string; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "psk-monitor-test-"));
	return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

const execFileAsync = promisify(execFile);

/**
 * Whether `pid` is a live (non-zombie) process. `kill(pid, 0)` also succeeds for zombies, which
 * never get reaped on hosts whose PID 1 does not reap (some containers, WSL2).
 */
export async function running(pid: number): Promise<boolean> {
	if (!alive(pid)) return false;
	try {
		const { stdout } = await execFileAsync("/bin/ps", ["-o", "stat=", "-p", String(pid)], {
			env: { ...process.env, LC_ALL: "C" },
			timeout: 5_000,
		});
		const stat = stdout.trim();
		return stat !== "" && !stat.startsWith("Z");
	} catch {
		return false;
	}
}

export async function waitFor(cond: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (await cond()) return;
		await new Promise((r) => setTimeout(r, 25));
	}
	throw new Error("waitFor timed out");
}

/** Spawn a long-lived group leader (killed by `cleanupProcs`). */
const spawned: number[] = [];
export async function spawnSleeper(): Promise<{ pid: number; startedAt: number }> {
	const proc = await spawnMonitor(SLEEPER, { cwd: process.cwd(), onStdout() {}, onStderr() {} });
	spawned.push(proc.pid);
	return { pid: proc.pid, startedAt: proc.startedAt };
}
export function cleanupProcs(): void {
	for (const pid of spawned.splice(0)) signalGroup(pid, "SIGKILL");
}

/** A pid that is guaranteed dead: a child that already exited and was reaped. */
export async function deadPid(): Promise<number> {
	const proc = await spawnMonitor(["node", "-e", ""], { cwd: process.cwd(), onStdout() {}, onStderr() {} });
	await proc.exited;
	await waitFor(() => !alive(proc.pid));
	return proc.pid;
}
