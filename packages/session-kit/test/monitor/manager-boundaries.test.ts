import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MonitorManager } from "../../src/monitor/manager.ts";
import type { MonitorProcess, SpawnOptions } from "../../src/monitor/process.ts";
import type { MonitorMessage } from "../../src/monitor/types.ts";
import { ControlledProcess, ControlledProcesses, deferred, FakeClock } from "../scenarios/support.ts";
import { tempDir } from "./helpers.ts";

const matcherFault = vi.hoisted(() => ({ fail: false }));
vi.mock("../../src/monitor/matcher.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/monitor/matcher.ts")>();
	return {
		...actual,
		BoundedMatcher: class extends actual.BoundedMatcher {
			constructor(source: string) {
				if (matcherFault.fail) throw new Error("worker unavailable");
				super(source);
			}
		},
	};
});

let tmp: ReturnType<typeof tempDir>;
let clock: FakeClock;
let processes: ControlledProcesses;
let managers: MonitorManager[];
let sent: MonitorMessage[];
beforeEach(() => {
	tmp = tempDir();
	clock = new FakeClock();
	processes = new ControlledProcesses(clock);
	managers = [];
	sent = [];
});
afterEach(async () => {
	matcherFault.fail = false;
	for (const manager of managers) await manager.dispose();
	vi.restoreAllMocks();
	tmp.cleanup();
});

/** Keep the production manager lifecycle and filesystem, controlling only child capabilities and time. */
function manager(overrides: Partial<ConstructorParameters<typeof MonitorManager>[0]> = {}): MonitorManager {
	const instance = new MonitorManager({
		sessionId: "boundaries",
		root: tmp.dir,
		clock,
		spawnMonitor: processes.spawn,
		send: (message) => sent.push(message),
		...overrides,
	});
	managers.push(instance);
	return instance;
}

/** Durable recovery location for this test's session and generated monitor ID. */
function pidfile(id = "m1", root = tmp.dir): string {
	return join(root, `boundaries.${process.pid}`, `${id}.json`);
}

describe("monitor manager spawn failure outcomes", () => {
	it("retains early stdout/stderr and flushes final fragments before reporting exit", async () => {
		let child: ControlledProcess | undefined;
		const mgr = manager({
			spawnMonitor: async (_argv, options) => {
				child = new ControlledProcess(900_001, clock.now(), options);
				await options.onStdout(Buffer.from("early stdout\nlast stdout"));
				await options.onStderr(Buffer.from("early stderr\nlast stderr"));
				return child;
			},
		});
		const info = await mgr.start({ argv: ["fixture"], name: "early" }, tmp.dir);
		expect(mgr.read(info.id)?.lines.map((line) => line.text)).toEqual(["early stdout", "early stderr"]);
		child?.exit(4);
		await mgr.find(info.id)?.done;
		expect(mgr.read(info.id)?.lines.map((line) => line.text)).toEqual([
			"early stdout",
			"early stderr",
			"last stdout",
			"last stderr",
		]);
		expect(mgr.info(info.id)).toMatchObject({ status: "exited", exitCode: 4, lines: 4, endedAt: clock.now() });
		expect(sent).toHaveLength(1);
		expect(sent[0]?.text).toContain("exited with code 4");
		expect(existsSync(pidfile())).toBe(false);
		expect(clock.pending).toBe(0);
	});

	it("kills a child whose pending spawn resolves after disposal without registering it", async () => {
		const entered = deferred<void>();
		const gate = deferred<MonitorProcess>();
		let options: SpawnOptions | undefined;
		const mgr = manager({
			spawnMonitor: async (_argv, value) => {
				options = value;
				entered.resolve();
				return gate.promise;
			},
		});
		const starting = mgr.start({ argv: ["fixture"], name: "pending" }, tmp.dir);
		const rejected = expect(starting).rejects.toThrow("this session is shutting down");
		await entered.promise;
		await mgr.dispose();
		if (!options) throw new Error("spawn did not provide callbacks");
		const child = new ControlledProcess(900_002, clock.now(), options);
		gate.resolve(child);
		await rejected;
		expect(child.kills).toBe(1);
		expect(child.alive).toBe(false);
		expect(mgr.list()).toEqual([]);
		expect(existsSync(pidfile())).toBe(false);
		expect(clock.pending).toBe(0);
		expect(sent).toEqual([]);
	});

	it("kills an unrecordable child, releases its name, and recovers with a valid root", async () => {
		const blocked = join(tmp.dir, "blocked");
		writeFileSync(blocked, "not a directory");
		const mgr = manager({ root: blocked });
		await expect(mgr.start({ argv: ["fixture"], name: "retry" }, tmp.dir)).rejects.toThrow(
			"cannot record monitor pidfile",
		);
		expect(processes.last.kills).toBe(1);
		expect(processes.last.alive).toBe(false);
		expect(mgr.list()).toEqual([]);
		expect(readFileSync(blocked, "utf8")).toBe("not a directory");
		expect(clock.pending).toBe(0);
		// A second attempt reaches the same filesystem failure, not a leaked name reservation.
		await expect(mgr.start({ argv: ["fixture"], name: "retry" }, tmp.dir)).rejects.toThrow(
			"cannot record monitor pidfile",
		);
		const recovered = manager();
		const info = await recovered.start({ argv: ["fixture"], name: "retry" }, tmp.dir);
		expect(recovered.info(info.id)?.status).toBe("running");
	});

	it("kills the child and removes recovery when matcher construction fails, then permits retry", async () => {
		const mgr = manager();
		matcherFault.fail = true;
		await expect(mgr.start({ argv: ["fixture"], name: "retry", match: "ERROR" }, tmp.dir)).rejects.toThrow(
			"cannot start match worker: worker unavailable",
		);
		expect(processes.last.kills).toBe(1);
		expect(processes.last.alive).toBe(false);
		expect(mgr.list()).toEqual([]);
		expect(existsSync(pidfile())).toBe(false);
		expect(clock.pending).toBe(0);
		expect(sent).toEqual([]);
		matcherFault.fail = false;
		const info = await mgr.start({ argv: ["fixture"], name: "retry", match: "ERROR" }, tmp.dir);
		await processes.last.stdout("ERROR recovered\n");
		processes.last.exit(0);
		await mgr.find(info.id)?.done;
		expect(mgr.info(info.id)).toMatchObject({ matches: 1, status: "exited" });
		expect(sent[0]?.details.matched).toEqual([1]);
	});

	it("exit backstop kills only running children and disposal unregisters it", async () => {
		const once = vi.spyOn(process, "once");
		const mgr = manager();
		const backstop = once.mock.calls.find(([event]) => event === "exit")?.[1];
		if (!backstop) throw new Error("manager did not register an exit backstop");
		const finished = await mgr.start({ argv: ["fixture"], name: "finished" }, tmp.dir);
		const finishedChild = processes.last;
		finishedChild.exit(0);
		await mgr.find(finished.id)?.done;
		const running = await mgr.start({ argv: ["fixture"], name: "running" }, tmp.dir);
		const runningChild = processes.last;
		// Invoke only this manager's registered callback, never emit a global process exit.
		backstop(0);
		await mgr.find(running.id)?.done;
		expect(finishedChild.kills).toBe(0);
		expect(runningChild.kills).toBe(1);
		expect(mgr.info(running.id)).toMatchObject({ status: "exited", signal: "SIGKILL" });
		await mgr.dispose();
		expect(process.listeners("exit")).not.toContain(backstop);
		expect(existsSync(pidfile(running.id))).toBe(false);
		expect(clock.pending).toBe(0);
	});
});
