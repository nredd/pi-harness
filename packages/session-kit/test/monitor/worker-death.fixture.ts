import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { afterEach, expect, it } from "vitest";
import { MonitorManager } from "../../src/monitor/manager.ts";
import { STAY } from "./stay.ts";

const readyPath = process.env.MONITOR_WORKER_READY;
const token = process.env.MONITOR_WORKER_TOKEN;
const targetPath = process.env.MONITOR_WORKER_TARGET;
if (!readyPath || !targetPath || !token)
	throw new Error("worker fixture requires readiness and target paths plus ownership token");

const manager = new MonitorManager({
	sessionId: "worker-killed",
	root: process.env.MONITOR_WORKER_ROOT,
	send() {},
});
afterEach(() => manager.dispose());

it("starts a monitor then fails or waits to be killed", async () => {
	const monitor = await manager.start(
		{
			argv: [
				process.execPath,
				"-e",
				`require("node:fs").writeFileSync(process.env.MONITOR_WORKER_TARGET, String(process.pid)); ${STAY} // ${token}`,
			],
			name: "worker-killed",
		},
		process.cwd(),
	);
	for (let attempt = 0; attempt < 100 && !existsSync(targetPath); attempt++)
		await new Promise((resolve) => setTimeout(resolve, 10));
	if (!existsSync(targetPath)) throw new Error("monitor target did not publish its PID");
	const targetPid = Number(readFileSync(targetPath, "utf8"));
	if (!Number.isInteger(targetPid) || targetPid <= 0) throw new Error("monitor target published an invalid PID");
	const tmp = `${readyPath}.${process.pid}.tmp`;
	writeFileSync(tmp, JSON.stringify({ workerPid: process.pid, monitorPid: monitor.pid, targetPid, token }), {
		mode: 0o600,
	});
	renameSync(tmp, readyPath);
	if (process.env.MONITOR_WORKER_FAIL === "1") expect("intentional failure").toBe("cleaned by afterEach");
	await new Promise<void>(() => {});
});
