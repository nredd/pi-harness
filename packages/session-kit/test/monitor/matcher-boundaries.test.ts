import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import type { Clock } from "../../src/clock.ts";
import { BoundedMatcher } from "../../src/monitor/matcher.ts";

const workers = vi.hoisted(() => ({
	instances: [] as (EventEmitter & { kill: ReturnType<typeof vi.fn>; send: ReturnType<typeof vi.fn> })[],
}));
vi.mock("node:child_process", () => ({
	spawn: vi.fn(
		() =>
			new (class extends EventEmitter {
				readonly kill = vi.fn(() => {
					this.emit("close");
					return true;
				});
				readonly send = vi.fn();
				constructor() {
					super();
					workers.instances.push(this);
				}
			})(),
	),
}));
afterEach(() => {
	vi.useRealTimers();
	workers.instances.length = 0;
});

it("fails open on process errors and awaits actual process close", async () => {
	const matcher = new BoundedMatcher("READY");
	const worker = workers.instances[0];
	if (!worker) throw new Error("Expected process boundary");
	worker.kill.mockImplementationOnce(() => true);
	const outcomes: boolean[] = [];
	matcher.test("pending", (matched) => outcomes.push(matched));
	worker.emit("error", new Error("spawn failed"));
	let closed = false;
	const closing = matcher.close().then(() => (closed = true));
	await Promise.resolve();
	expect(closed).toBe(false);
	expect(outcomes).toEqual([true]);
	worker.emit("close");
	await closing;
	expect(closed).toBe(true);
	expect(worker.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
});

it("settles cleanup on reaped exit even when IPC disconnect omits close", async () => {
	const matcher = new BoundedMatcher("READY");
	const worker = workers.instances[0];
	if (!worker) throw new Error("Expected process boundary");
	worker.kill.mockImplementationOnce(() => true);
	const closing = matcher.close();
	worker.emit("exit", null, "SIGKILL");
	await closing;
	expect(worker.kill).toHaveBeenCalledOnce();
});

it("a slow but responsive queue fails open at the total drain deadline rather than waiting forever", async () => {
	vi.useFakeTimers();
	const matcher = new BoundedMatcher("READY");
	const worker = workers.instances[0];
	if (!worker) throw new Error("Expected worker boundary");
	worker.emit("message", "ready");
	const outcomes: [number, boolean][] = [];
	for (let index = 0; index < 12; index++) matcher.test(`line ${index}`, (matched) => outcomes.push([index, matched]));
	const draining = matcher.drain();
	for (let index = 0; index < 11; index++) {
		await vi.advanceTimersByTimeAsync(90);
		worker.emit("message", false);
	}
	await vi.advanceTimersByTimeAsync(9);
	expect(outcomes).toEqual(Array.from({ length: 11 }, (_, index) => [index, false]));
	await vi.advanceTimersByTimeAsync(1);
	expect(outcomes).toEqual([...Array.from({ length: 11 }, (_, index) => [index, false]), [11, true]]);
	await draining;
	await matcher.close();
	expect(worker.kill).toHaveBeenCalledOnce();
	expect(vi.getTimerCount()).toBe(0);
});

it("a worker that never comes online fails open at its startup deadline and releases an active drain", async () => {
	vi.useFakeTimers();
	const matcher = new BoundedMatcher("READY");
	const outcomes: [string, boolean][] = [];
	matcher.test("pending", (matched) => outcomes.push(["pending", matched]));
	await vi.advanceTimersByTimeAsync(500);
	const draining = matcher.drain();
	await vi.advanceTimersByTimeAsync(499);
	expect(outcomes).toEqual([]);
	await vi.advanceTimersByTimeAsync(1);
	expect(outcomes).toEqual([["pending", true]]);
	await draining;
	matcher.test("future", (matched) => outcomes.push(["future", matched]));
	expect(outcomes).toEqual([
		["pending", true],
		["future", true],
	]);
	await matcher.close();
	expect(workers.instances[0]?.kill).toHaveBeenCalledOnce();
	expect(vi.getTimerCount()).toBe(0);
});

it("runs every deadline on the injected clock, so host time alone never fails a responsive worker open", async () => {
	vi.useFakeTimers();
	const timers: { ms: number; fire: () => void; cancelled: boolean }[] = [];
	const clock: Clock = {
		now: () => 0,
		setTimeout(fire, ms) {
			const timer = { ms, fire, cancelled: false };
			timers.push(timer);
			return { cancel: () => (timer.cancelled = true) };
		},
		setInterval: () => {
			throw new Error("BoundedMatcher schedules no intervals");
		},
	};
	const matcher = new BoundedMatcher("READY", clock);
	const worker = workers.instances[0];
	if (!worker) throw new Error("Expected worker boundary");
	const outcomes: [string, boolean][] = [];
	matcher.test("slow", (matched) => outcomes.push(["slow", matched]));
	expect(timers.map(({ ms, cancelled }) => [ms, cancelled])).toEqual([[1000, false]]);
	await vi.advanceTimersByTimeAsync(60_000);
	worker.emit("message", "ready");
	expect(timers.map(({ ms, cancelled }) => [ms, cancelled])).toEqual([
		[1000, true],
		[100, false],
	]);
	expect(worker.send).toHaveBeenCalledWith("slow");
	const draining = matcher.drain();
	expect(timers.map(({ ms, cancelled }) => [ms, cancelled])).toEqual([
		[1000, true],
		[100, false],
		[1000, false],
	]);
	await vi.advanceTimersByTimeAsync(60_000);
	expect(outcomes).toEqual([]);
	timers[1]?.fire();
	expect(outcomes).toEqual([["slow", true]]);
	await draining;
	expect(timers.map(({ cancelled }) => cancelled)).toEqual([true, true, true]);
	await matcher.close();
	expect(worker.kill).toHaveBeenCalledOnce();
	expect(vi.getTimerCount()).toBe(0);
});

it("ignores a late online or answer from a worker it already gave up on", async () => {
	vi.useFakeTimers();
	const matcher = new BoundedMatcher("READY");
	const worker = workers.instances[0];
	if (!worker) throw new Error("Expected worker boundary");
	const outcomes: boolean[] = [];
	matcher.test("first", (matched) => outcomes.push(matched));
	await matcher.close();
	expect(outcomes).toEqual([true]);
	worker.emit("message", "ready");
	worker.emit("message", false);
	expect(worker.send).not.toHaveBeenCalled();
	expect(outcomes).toEqual([true]);
	expect(vi.getTimerCount()).toBe(0);
});

it("ignores an unsolicited answer while no line is in flight", () => {
	vi.useFakeTimers();
	const matcher = new BoundedMatcher("READY");
	const worker = workers.instances[0];
	if (!worker) throw new Error("Expected worker boundary");
	worker.emit("message", "ready");
	worker.emit("message", true);
	const outcomes: boolean[] = [];
	matcher.test("line", (matched) => outcomes.push(matched));
	expect(worker.send).toHaveBeenCalledExactlyOnceWith("line");
	worker.emit("message", false);
	expect(outcomes).toEqual([false]);
	void matcher.close();
});
