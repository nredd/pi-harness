import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { spawnMonitor } from "../../src/monitor/process.ts";

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return { ...actual, spawn: vi.fn(actual.spawn) };
});

/** Event/pipe boundary only: no fake child is ever passed to a real signal capability. */
class Child extends EventEmitter {
	readonly pid = 900_001;
	readonly stdout = new PassThrough();
	readonly stderr = new PassThrough();
	exitCode: number | null = null;
	signalCode: NodeJS.Signals | null = null;
}

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.mocked(spawn).mockReset();
});

it("ignores post-spawn errors but still drains output, settles exit and reaps the owned group", async () => {
	vi.useFakeTimers();
	vi.setSystemTime(Date.parse("2026-10-18T12:00:00Z"));
	const child = new Child();
	vi.mocked(spawn).mockReturnValueOnce(child as unknown as ChildProcess);
	const kill = vi.spyOn(process, "kill").mockReturnValue(true);
	const stdout = vi.fn();
	const stderr = vi.fn();
	const starting = spawnMonitor(["fixture"], { cwd: "/fixture", onStdout: stdout, onStderr: stderr });
	child.emit("spawn");
	const monitor = await starting;
	expect(monitor.startedAt).toBe(Date.now());
	expect(() => child.emit("error", new Error("post-spawn capability failure"))).not.toThrow();
	child.stdout.write("retained stdout");
	child.stderr.write("retained stderr");
	child.exitCode = 4;
	child.emit("exit", 4, null);
	child.emit("close", 4, null);
	expect(await monitor.exited).toEqual({ exitCode: 4, signal: null });
	expect(stdout).toHaveBeenCalledExactlyOnceWith(Buffer.from("retained stdout"));
	expect(stderr).toHaveBeenCalledExactlyOnceWith(Buffer.from("retained stderr"));
	expect(kill).toHaveBeenCalledExactlyOnceWith(-child.pid, "SIGKILL");
	expect(child.stdout.destroyed).toBe(true);
	expect(child.stderr.destroyed).toBe(true);
	expect(vi.getTimerCount()).toBe(0);
});
