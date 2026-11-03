import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, watch, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { psInfo } from "../../src/monitor/pidfiles.ts";
import { signalGroup } from "../../src/monitor/process.ts";
import { running, tempDir, waitFor } from "./helpers.ts";

interface WorkerReady {
	workerPid: number;
	monitorPid: number;
	targetPid: number;
	descendantPid: number;
	token: string;
}

const config = join(import.meta.dirname, "worker-death.vitest.config.ts");
const vitest = join(import.meta.dirname, "../../../../node_modules/vitest/vitest.mjs");
let runner: ChildProcess | undefined;
let ready: WorkerReady | undefined;

/** SIGKILL a still-running group member only if its group and command prove this test owns it. */
async function killOwned(pid: number, pgid: number, token: string): Promise<void> {
	if (!(await running(pid))) return;
	const info = await psInfo(pid);
	if (info?.pgid !== pgid || !info.command.includes(token))
		throw new Error(`refusing to kill unowned process ${pid} in group ${pgid}`);
	signalGroup(pgid, "SIGKILL");
	await waitFor(async () => !(await running(pid)));
}

/**
 * Resolve once the nested run publishes `path` (an atomic rename into its directory), or reject when
 * that run exits first. Its cold Vitest start takes seconds under load, so the run's own lifecycle,
 * not a wall-clock budget, ends the wait; the test's timeout still bounds it.
 */
function published(path: string, child: ChildProcess): Promise<void> {
	return new Promise((resolve, reject) => {
		let settled = false;
		const watcher = watch(dirname(path), () => {
			if (existsSync(path)) settle();
		});
		const exited = (code: number | null, signal: NodeJS.Signals | null) =>
			settle(new Error(`worker fixture exited before publishing readiness: ${code ?? signal}`));
		function settle(error?: Error): void {
			if (settled) return;
			settled = true;
			watcher.close();
			child.off("exit", exited);
			if (error) reject(error);
			else resolve();
		}
		child.once("exit", exited);
		if (existsSync(path)) settle();
		else if (child.exitCode !== null || child.signalCode !== null) exited(child.exitCode, child.signalCode);
	});
}

async function stopOwnedMonitor(): Promise<void> {
	if (!ready) return;
	await killOwned(ready.monitorPid, ready.monitorPid, ready.token);
	await killOwned(ready.descendantPid, ready.monitorPid, ready.token);
}

afterEach(async () => {
	try {
		await stopOwnedMonitor();
	} finally {
		runner?.kill("SIGKILL");
		runner = undefined;
		ready = undefined;
	}
});

describe("monitor worker death", () => {
	it.each(["SIGKILL", "assertion failure"])(
		"reaps an owned monitor after worker %s",
		async (failure) => {
			const tmp = tempDir();
			const token = randomUUID();
			const readyPath = join(tmp.dir, "ready.json");
			const targetPath = join(tmp.dir, "target.pid");
			const childPath = join(tmp.dir, "child.pid");
			const ackPath = join(tmp.dir, "ack");
			// The nested Vitest bypasses `scripts/run-vitest.ts`, so it gets the same isolated home here.
			const home = join(tmp.dir, "home");
			mkdirSync(home);
			try {
				runner = spawn(process.execPath, [vitest, "run", "--config", config, "--coverage.enabled=false"], {
					cwd: join(import.meta.dirname, "../.."),
					env: {
						...process.env,
						HOME: home,
						USERPROFILE: home,
						XDG_CONFIG_HOME: join(home, ".config"),
						PI_CODING_AGENT_DIR: join(home, ".pi", "agent"),
						PI_SUBAGENTS_CONFIG_DIR: join(home, ".pi", "agent"),
						MONITOR_WORKER_READY: readyPath,
						MONITOR_WORKER_ROOT: tmp.dir,
						MONITOR_WORKER_TARGET: targetPath,
						MONITOR_WORKER_CHILD: childPath,
						MONITOR_WORKER_ACK: ackPath,
						MONITOR_WORKER_TOKEN: token,
						MONITOR_WORKER_FAIL: failure === "assertion failure" ? "1" : "0",
					},
					stdio: "ignore",
				});
				await published(readyPath, runner);
				ready = JSON.parse(readFileSync(readyPath, "utf8")) as WorkerReady;
				expect(ready.token).toBe(token);
				expect(ready.targetPid).toBe(ready.monitorPid);
				expect(await running(ready.monitorPid)).toBe(true);
				expect(await running(ready.descendantPid)).toBe(true);
				writeFileSync(ackPath, "");
				if (failure === "SIGKILL") {
					process.kill(ready.workerPid, "SIGKILL");
				}
				const { monitorPid, descendantPid } = ready;
				await waitFor(async () => !(await running(monitorPid)) && !(await running(descendantPid)));
			} finally {
				tmp.cleanup();
			}
		},
		15_000,
	);
});
