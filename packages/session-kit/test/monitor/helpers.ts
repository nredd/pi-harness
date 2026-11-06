import { type ChildProcess, execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
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

/** Test seams for `running`: the `ps` binary and its deadline. */
export interface RunningOptions {
	ps?: string;
	timeoutMs?: number;
}

/**
 * Whether `pid` is a live (non-zombie) process. `kill(pid, 0)` also succeeds for zombies, which
 * never get reaped on hosts whose PID 1 does not reap (some containers, WSL2). `ps` exiting
 * non-zero with no output means the pid is absent; a spawn failure or timeout rethrows, since a
 * broken probe must not read as "dead".
 */
export async function running(
	pid: number,
	{ ps = "/bin/ps", timeoutMs = 5_000 }: RunningOptions = {},
): Promise<boolean> {
	if (!alive(pid)) return false;
	try {
		const { stdout } = await execFileAsync(ps, ["-o", "stat=", "-p", String(pid)], {
			env: { ...process.env, LC_ALL: "C" },
			timeout: timeoutMs,
		});
		const stat = stdout.trim();
		return stat !== "" && !stat.startsWith("Z");
	} catch (error) {
		const { code, killed, stdout } = error as { code?: unknown; killed?: boolean; stdout?: string };
		if (typeof code === "number" && !killed && !stdout?.trim()) return false;
		throw error;
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

/**
 * Resolve once `child` publishes `path`, or reject with its exit status and stdout/stderr when it
 * closes first. Polls instead of using `fs.watch`: macOS FSEvents can deliver a directory event seconds
 * late under load, long enough for a waiting fixture to give up after it already published. The
 * child's lifecycle ends the wait, not a wall-clock budget; the caller's test timeout bounds it. Call it
 * right after spawning: it must observe `close`, and it keeps draining piped output afterwards.
 */
export async function published(path: string, child: ChildProcess): Promise<void> {
	let output = "";
	const collect = (chunk: Buffer) => {
		output += chunk.toString();
	};
	child.stdout?.on("data", collect);
	child.stderr?.on("data", collect);
	let status: string | undefined;
	const closed = (code: number | null, signal: NodeJS.Signals | null) => {
		status = String(code ?? signal);
	};
	child.once("close", closed);
	try {
		while (!existsSync(path)) {
			if (status !== undefined)
				throw new Error(`worker fixture exited before publishing readiness: ${status}\n${output}`);
			await new Promise((r) => setTimeout(r, 25));
		}
	} finally {
		child.off("close", closed);
	}
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
