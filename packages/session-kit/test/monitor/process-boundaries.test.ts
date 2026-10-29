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
	readonly control = new PassThrough();
	readonly stdio = [undefined, this.stdout, this.stderr, this.control];
	exitCode: number | null = null;
	signalCode: NodeJS.Signals | null = null;
}

/** Fire terminal events inline at handler registration, before wrap or spawnMonitor can return. */
class ImmediateChild extends Child {
	readonly failure = new Error("synchronous spawn failure");

	constructor(private readonly outcome: "close" | "error-close" | "exit-close" | "spawn-error") {
		super();
	}

	override once(...args: Parameters<EventEmitter["once"]>): this {
		super.once(...args);
		if (args[0] === "error" && this.outcome === "spawn-error") this.emit("error", this.failure);
		if (args[0] === "close") {
			this.exitCode = 7;
			if (this.outcome === "error-close") this.emit("error", new Error("synchronous post-spawn failure"));
			if (this.outcome === "exit-close") this.emit("exit", 7, null);
			this.emit("close", 7, null);
		}
		return this;
	}
}

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.mocked(spawn).mockReset();
});

it.each(["close", "error-close", "exit-close"] as const)(
	"initializes the exit resolver before a synchronous %s during handler registration",
	async (outcome) => {
		vi.useFakeTimers();
		vi.setSystemTime(Date.parse("2026-10-18T12:00:00Z"));
		const child = new ImmediateChild(outcome);
		vi.mocked(spawn).mockReturnValueOnce(child as unknown as ChildProcess);
		const kill = vi.spyOn(process, "kill").mockReturnValue(true);
		const starting = spawnMonitor(["fixture"], { cwd: "/fixture", onStdout: vi.fn(), onStderr: vi.fn() });
		expect(() => child.emit("spawn")).not.toThrow();
		child.control.write('{"ok":true}\n');
		const monitor = await starting;
		expect(await monitor.exited).toEqual({ exitCode: 7, signal: null });
		expect(kill).toHaveBeenCalledExactlyOnceWith(-child.pid, "SIGKILL");
		expect(child.stdout.destroyed).toBe(true);
		expect(child.stderr.destroyed).toBe(true);
		child.emit("close", 99, null);
		expect(await monitor.exited).toEqual({ exitCode: 7, signal: null });
		expect(kill).toHaveBeenCalledOnce();
		expect(vi.getTimerCount()).toBe(0);
	},
);

it("rejects a synchronous pre-spawn error without exposing a monitor or entering wrap", async () => {
	const child = new ImmediateChild("spawn-error");
	vi.mocked(spawn).mockReturnValueOnce(child as unknown as ChildProcess);
	const kill = vi.spyOn(process, "kill").mockReturnValue(true);
	await expect(spawnMonitor(["fixture"], { cwd: "/fixture", onStdout: vi.fn(), onStderr: vi.fn() })).rejects.toBe(
		child.failure,
	);
	expect(child.stdout.listenerCount("data")).toBe(0);
	expect(child.stderr.listenerCount("data")).toBe(0);
	expect(child.listenerCount("close")).toBe(0);
	expect(kill).not.toHaveBeenCalled();
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
	child.control.write('{"ok":true}\n');
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
