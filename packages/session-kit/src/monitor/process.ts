/**
 * No-shell monitor process: argv spawn, stdin ignored, own process group (`detached`), SIGTERM then
 * SIGKILL after a grace period, then a hard resolve so a grandchild holding the pipes open cannot
 * hang the caller. Same conventions as `pi-dev-tools` (`src/core/process.ts`), re-implemented here
 * because packages do not import each other. macOS and Linux only.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

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
	/** Unique launch marker retained in `ps` for recovery authentication. */
	identity: string;
	/** Resolves once the leader exited and its output drained (or the grace ran out). Never rejects. */
	exited: Promise<ExitInfo>;
	/** SIGTERM the group, SIGKILL after `graceMs`. Idempotent. */
	terminate(graceMs?: number): void;
	/** SIGKILL the group right now, synchronously. Safe from a `process.on("exit")` handler. */
	killNow(): void;
}

export interface SpawnOptions {
	cwd: string;
	/** Resolves when complete lines have been ingested, including matching. Real pipes need not await it. */
	onStdout: (chunk: Buffer) => void | Promise<void>;
	onStderr: (chunk: Buffer) => void | Promise<void>;
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

const SUPERVISOR_SOURCE = `
const { spawn } = require("node:child_process");
const { createWriteStream } = require("node:fs");
const [, encoded] = process.argv.slice(1);
const [cmd, ...args] = JSON.parse(encoded);
const parent = process.ppid;
let stopping = false;
const stop = () => {
	if (stopping) return;
	stopping = true;
	try { process.kill(-process.pid, "SIGKILL"); } catch { process.exit(1); }
};
process.stdin.once("end", stop);
process.stdin.once("error", stop);
process.stdin.resume();
const status = createWriteStream(null, { fd: 3 });
const report = (value, done) => status.end(JSON.stringify(value) + String.fromCharCode(10), done);
const child = spawn(cmd, args, { stdio: ["ignore", "inherit", "inherit"] });
let ready = false;
let exit;
const finish = () => {
	if (!ready || !exit) return;
	if (exit.signal) process.kill(process.pid, exit.signal);
	else process.exit(exit.code ?? 1);
};
child.once("error", (error) => report({ ok: false, error: error.message }, () => process.exit(1)));
child.once("spawn", () => report({ ok: true }, () => { ready = true; finish(); }));
child.once("exit", (code, signal) => { exit = { code, signal }; finish(); });
setInterval(() => { if (process.ppid !== parent) stop(); }, 100).unref();
`;

/** Spawn `argv` beneath an owning supervisor. Its parent-death guard kills the detached group if the host dies. */
export function spawnMonitor(argv: readonly string[], opts: SpawnOptions): Promise<MonitorProcess> {
	const [cmd] = argv;
	if (cmd === undefined || cmd.trim() === "") return Promise.reject(new Error("argv[0] must be non-empty"));
	const identity = randomUUID();
	return new Promise((resolve, reject) => {
		const child: ChildProcess = spawn(process.execPath, ["-e", SUPERVISOR_SOURCE, identity, JSON.stringify(argv)], {
			cwd: opts.cwd,
			stdio: ["pipe", "pipe", "pipe", "pipe"],
			detached: true,
			env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", BUN_BE_BUN: "1" },
		});
		let status = "";
		let completed = false;
		const complete = (fn: () => void) => {
			if (completed) return;
			completed = true;
			child.removeAllListeners("error");
			child.on("error", () => {
				// post-start errors (kill failures) are non-fatal; `exit`/`close` still fire
			});
			fn();
		};
		child.once("error", (error) => complete(() => reject(error)));
		child.once("exit", () => complete(() => reject(new Error("monitor supervisor exited before target start"))));
		const control = child.stdio[3];
		if (!control) {
			complete(() => reject(new Error("monitor supervisor control pipe is unavailable")));
			return;
		}
		control.on("data", (chunk: Buffer) => {
			status += chunk.toString("utf8");
			const newline = status.indexOf("\n");
			if (newline < 0) return;
			try {
				const message = JSON.parse(status.slice(0, newline)) as { ok?: boolean; error?: string };
				if (message.ok) complete(() => resolve(wrap(child, opts, identity)));
				else complete(() => reject(new Error(message.error ?? "monitor target failed to start")));
			} catch {
				complete(() => reject(new Error("monitor supervisor sent an invalid start response")));
			}
		});
	});
}

function wrap(child: ChildProcess, opts: SpawnOptions, identity: string): MonitorProcess {
	const pid = child.pid as number;
	const startedAt = Date.now();
	let settled = false;
	let termTimer: NodeJS.Timeout | undefined;
	let hardTimer: NodeJS.Timeout | undefined;
	let drainTimer: NodeJS.Timeout | undefined;
	let exit: ExitInfo | undefined;
	// The native Promise executor assigns this synchronously, before any child handlers register.
	let finish!: (info: ExitInfo) => void;
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
		identity,
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
