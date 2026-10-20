import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Coalescer } from "../../src/monitor/coalescer.ts";

describe("Coalescer", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("batches everything added within the window after the first item", () => {
		const batches: number[][] = [];
		const c = new Coalescer<number>(2000, (b) => batches.push(b.items));
		c.add(1);
		vi.advanceTimersByTime(1500);
		c.add(2);
		vi.advanceTimersByTime(499);
		expect(batches).toEqual([]);
		vi.advanceTimersByTime(1);
		expect(batches).toEqual([[1, 2]]);
		c.add(3);
		vi.advanceTimersByTime(2000);
		expect(batches).toEqual([[1, 2], [3]]);
	});

	it("flush emits at once, take returns without emitting, cancel drops", () => {
		const batches: number[][] = [];
		const c = new Coalescer<number>(2000, (b) => batches.push(b.items));
		c.add(1);
		c.flush();
		expect(batches).toEqual([[1]]);
		c.flush();
		expect(batches).toHaveLength(1);
		c.add(2);
		expect(c.take().items).toEqual([2]);
		c.add(3);
		c.cancel();
		vi.advanceTimersByTime(5000);
		expect(batches).toHaveLength(1);
	});

	it("bounds a flood and retains whether a dropped item matched", () => {
		const batches: Array<{ items: number[]; dropped: number; droppedMatched: boolean; droppedMatches: number[] }> = [];
		const c = new Coalescer<number>(2000, (batch) => batches.push(batch), {
			maxItems: 2,
			matched: (item) => item === 4,
		});
		for (let item = 1; item <= 5; item++) c.add(item);
		vi.advanceTimersByTime(2000);
		expect(batches).toEqual([{ items: [1, 2], dropped: 3, droppedMatched: true, droppedMatches: [4] }]);
	});

	it("never holds the process open", () => {
		const c = new Coalescer<number>(2000, () => {});
		c.add(1);
		expect(vi.getTimerCount()).toBe(1);
	});
});
