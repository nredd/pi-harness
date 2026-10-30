import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { psInfo } from "../../src/monitor/pidfiles.ts";
import { signalGroup } from "../../src/monitor/process.ts";
import { alive, tempDir, waitFor } from "./helpers.ts";

interface WorkerReady {
	workerPid: number;
	monitorPid: number;
	targetPid: number;
	token: string;
}

const config = join(import.meta.dirname, "worker-death.vitest.config.ts");
const vitest = join(import.meta.dirname, "../../../../node_modules/vitest/vitest.mjs");
let runner: ChildProcess | undefined;
let ready: WorkerReady | undefined;

async function stopOwnedMonitor(): Promise<void> {
	if (!ready) return;
	if (alive(ready.monitorPid)) {
		const info = await psInfo(ready.monitorPid);
		if (info?.pgid !== ready.monitorPid || !info.command.includes(ready.token))
			throw new Error(`refusing to kill unowned monitor group ${ready.monitorPid}`);
		signalGroup(ready.monitorPid, "SIGKILL");
		await waitFor(() => !alive(ready?.monitorPid ?? 0));
	}
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
			try {
				runner = spawn(process.execPath, [vitest, "run", "--config", config, "--coverage.enabled=false"], {
					cwd: join(import.meta.dirname, "../.."),
					env: {
						...process.env,
						MONITOR_WORKER_READY: readyPath,
						MONITOR_WORKER_ROOT: tmp.dir,
						MONITOR_WORKER_TARGET: targetPath,
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
					expect(alive(ready.monitorPid)).toBe(true);
					process.kill(ready.workerPid, "SIGKILL");
				}
				await waitFor(() => !alive(ready?.monitorPid ?? 0) && !alive(ready?.targetPid ?? 0));
			} finally {
				tmp.cleanup();
			}
		},
		15_000,
	);
});
