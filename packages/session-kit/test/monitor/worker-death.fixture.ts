import { renameSync, writeFileSync } from "node:fs";
import { it } from "vitest";
import { MonitorManager } from "../../src/monitor/manager.ts";

const readyPath = process.env.MONITOR_WORKER_READY;
const token = process.env.MONITOR_WORKER_TOKEN;
if (!readyPath || !token) throw new Error("worker fixture requires readiness path and ownership token");

it("starts a monitor then waits to be killed", async () => {
	const manager = new MonitorManager({
		sessionId: "worker-killed",
		root: process.env.MONITOR_WORKER_ROOT,
		send() {},
	});
	const monitor = await manager.start(
		{ argv: [process.execPath, "-e", `setInterval(() => {}, 1000); // ${token}`], name: "worker-killed" },
		process.cwd(),
	);
	const tmp = `${readyPath}.${process.pid}.tmp`;
	writeFileSync(tmp, JSON.stringify({ workerPid: process.pid, monitorPid: monitor.pid, token }), { mode: 0o600 });
	renameSync(tmp, readyPath);
	await new Promise<void>(() => {});
});
