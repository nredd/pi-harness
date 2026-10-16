/**
 * No-shell monitor process: argv spawn, stdin ignored, own process group (`detached`), SIGTERM then
 * SIGKILL after a grace period, then a hard resolve so a grandchild holding the pipes open cannot
 * hang the caller. Same conventions as `pi-dev-tools` (`src/core/process.ts`), re-implemented here
 * because packages do not import each other. macOS and Linux only.
 */

import { type ChildProcess, spawn } from "node:child_process";

export const KILL_GRACE_MS = 2_000;
/** After SIGKILL, how long to wait for the pipes to close before resolving anyway. */
const CLOSE_GRACE_MS = 1_000;
/** After the leader exits, how long to wait for its pipes to drain before moving on. */
const DRAIN_GRACE_MS = 250;

export interface ExitInfo {
	exitCode: number | null;
	signal: NodeJS.Signals | null;
}

export interface MonitorProcess {
	pid: number;
	startedAt: number;
	/** Resolves once the leader exited and its output drained (or the grace ran out). Never rejects. */
	exited: Promise<ExitInfo>;
	/** SIGTERM the group, SIGKILL after `graceMs`. Idempotent. */
	terminate(graceMs?: number): void;
	/** SIGKILL the group right now, synchronously. Safe from a `process.on("exit")` handler. */
	killNow(): void;
}

export interface SpawnOptions {
	cwd: string;
	onStdout: (chunk: Buffer) => void;
	onStderr: (chunk: Buffer) => void;
}

/**
 * Signal a whole process group. `detached` makes the child a group leader (pgid == pid), so there is
 * deliberately no fallback to signalling the bare pid: once the leader is reaped that pid may belong
 * to an unrelated process.
 */
export function signalGroup(pgid: number, sig: NodeJS.Signals): void {
	try {
		process.kill(-pgid, sig);
	} catch {
		// group already gone
	}
}

/** Spawn `argv`. Rejects with the spawn error (e.g. ENOENT) when the process never started. */
export function spawnMonitor(argv: readonly string[], opts: SpawnOptions): Promise<MonitorProcess> {
	const [cmd, ...args] = argv;
	if (cmd === undefined || cmd.trim() === "") return Promise.reject(new Error("argv[0] must be non-empty"));
	return new Promise((resolve, reject) => {
		const child: ChildProcess = spawn(cmd, args, {
			cwd: opts.cwd,
			stdio: ["ignore", "pipe", "pipe"],
			detached: true,
		});
		child.once("error", (error) => reject(error));
		child.once("spawn", () => {
			child.removeAllListeners("error");
			child.on("error", () => {
				// post-spawn errors (kill failures) are non-fatal; `exit`/`close` still fire
			});
			resolve(wrap(child, opts));
		});
	});
}

function wrap(child: ChildProcess, opts: SpawnOptions): MonitorProcess {
	const pid = child.pid as number;
	const startedAt = Date.now();
	let settled = false;
	let termTimer: NodeJS.Timeout | undefined;
	let hardTimer: NodeJS.Timeout | undefined;
	let drainTimer: NodeJS.Timeout | undefined;
	let exit: ExitInfo | undefined;
	let finish: (info: ExitInfo) => void = () => {};
	const exited = new Promise<ExitInfo>((resolve) => {
		finish = resolve;
	});

	child.stdout?.on("data", opts.onStdout);
	child.stderr?.on("data", opts.onStderr);

	const settle = () => {
		if (settled) return;
		settled = true;
		for (const t of [termTimer, hardTimer, drainTimer]) if (t) clearTimeout(t);
		child.stdout?.destroy();
		child.stderr?.destroy();
		// The leader is gone; sweep any grandchildren it left in the group.
		signalGroup(pid, "SIGKILL");
		finish(exit ?? { exitCode: child.exitCode, signal: child.signalCode });
	};

	child.once("exit", (exitCode, signal) => {
		exit = { exitCode, signal };
		drainTimer = setTimeout(settle, DRAIN_GRACE_MS);
		drainTimer.unref();
	});
	child.once("close", settle);

	return {
		pid,
		startedAt,
		exited,
		terminate(graceMs = KILL_GRACE_MS) {
			if (settled || termTimer) return;
			signalGroup(pid, "SIGTERM");
			termTimer = setTimeout(() => {
				signalGroup(pid, "SIGKILL");
				hardTimer = setTimeout(settle, CLOSE_GRACE_MS);
				hardTimer.unref();
			}, graceMs);
			termTimer.unref();
		},
		killNow() {
			signalGroup(pid, "SIGKILL");
		},
	};
}
