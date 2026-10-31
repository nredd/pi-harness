import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
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
			try {
				runner = spawn(process.execPath, [vitest, "run", "--config", config, "--coverage.enabled=false"], {
					cwd: join(import.meta.dirname, "../.."),
					env: {
						...process.env,
						MONITOR_WORKER_READY: readyPath,
						MONITOR_WORKER_ROOT: tmp.dir,
						MONITOR_WORKER_TARGET: targetPath,
						MONITOR_WORKER_CHILD: childPath,
						MONITOR_WORKER_TOKEN: token,
						MONITOR_WORKER_FAIL: failure === "assertion failure" ? "1" : "0",
					},
					stdio: "ignore",
				});
				await waitFor(() => existsSync(readyPath));
				ready = JSON.parse(readFileSync(readyPath, "utf8")) as WorkerReady;
				expect(ready.token).toBe(token);
				expect(ready.targetPid).toBe(ready.monitorPid);
				if (failure === "SIGKILL") {
					expect(await running(ready.monitorPid)).toBe(true);
					expect(await running(ready.descendantPid)).toBe(true);
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
