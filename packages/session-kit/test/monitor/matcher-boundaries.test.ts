import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { BoundedMatcher } from "../../src/monitor/matcher.ts";

const workers = vi.hoisted(() => ({ instances: [] as (EventEmitter & { terminate: ReturnType<typeof vi.fn> })[] }));
vi.mock("node:worker_threads", () => ({
	Worker: class extends EventEmitter {
		readonly terminate = vi.fn(async () => 0);
		readonly postMessage = vi.fn();
		constructor() {
			super();
			workers.instances.push(this);
		}
	},
}));
afterEach(() => {
	vi.useRealTimers();
	workers.instances.length = 0;
});

it("a slow but responsive queue fails open at the total drain deadline rather than waiting forever", async () => {
	vi.useFakeTimers();
	const matcher = new BoundedMatcher("READY");
	const worker = workers.instances[0];
	if (!worker) throw new Error("Expected worker boundary");
	worker.emit("online");
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
	expect(worker.terminate).toHaveBeenCalledOnce();
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
	expect(workers.instances[0]?.terminate).toHaveBeenCalledOnce();
	expect(vi.getTimerCount()).toBe(0);
});
