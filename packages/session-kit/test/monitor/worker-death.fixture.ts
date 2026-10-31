import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { afterEach, expect, it } from "vitest";
import { MonitorManager } from "../../src/monitor/manager.ts";
import { waitFor } from "./helpers.ts";
import { STAY } from "./stay.ts";

const readyPath = process.env.MONITOR_WORKER_READY;
const token = process.env.MONITOR_WORKER_TOKEN;
const targetPath = process.env.MONITOR_WORKER_TARGET;
const childPath = process.env.MONITOR_WORKER_CHILD;
if (!readyPath || !targetPath || !childPath || !token)
	throw new Error("worker fixture requires readiness, target and child paths plus ownership token");

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
				// The target spawns an in-group descendant (published first) so group reaping is observable.
				`const fs = require("node:fs"); const child = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000) // ${token}"], { stdio: "ignore" }); fs.writeFileSync(process.env.MONITOR_WORKER_CHILD, String(child.pid)); fs.writeFileSync(process.env.MONITOR_WORKER_TARGET, String(process.pid)); ${STAY} // ${token}`,
			],
			name: "worker-killed",
		},
		process.cwd(),
	);
	await waitFor(() => existsSync(targetPath));
	const targetPid = Number(readFileSync(targetPath, "utf8"));
	if (!Number.isInteger(targetPid) || targetPid <= 0) throw new Error("monitor target published an invalid PID");
	const descendantPid = Number(readFileSync(childPath, "utf8"));
	if (!Number.isInteger(descendantPid) || descendantPid <= 0)
		throw new Error("monitor descendant published an invalid PID");
	const tmp = `${readyPath}.${process.pid}.tmp`;
	writeFileSync(
		tmp,
		JSON.stringify({ workerPid: process.pid, monitorPid: monitor.pid, targetPid, descendantPid, token }),
		{
			mode: 0o600,
		},
	);
	renameSync(tmp, readyPath);
	if (process.env.MONITOR_WORKER_FAIL === "1") expect("intentional failure").toBe("cleaned by afterEach");
	await new Promise<void>(() => {});
});
