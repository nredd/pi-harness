import { describe, expect, it } from "vitest";
import { RingBuffer } from "../../src/monitor/ring.ts";

describe("RingBuffer", () => {
	it("numbers lines from 1 and reads everything by default", () => {
		const r = new RingBuffer(5);
		expect(r.lastLine).toBe(0);
		r.push("a");
		r.push("b");
		expect(r.read().lines).toEqual([
			{ n: 1, text: "a" },
			{ n: 2, text: "b" },
		]);
		expect(r.firstLine).toBe(1);
	});

	it("keeps counting after eviction and reports what `since` missed", () => {
		const r = new RingBuffer(3);
		for (const t of ["1", "2", "3", "4", "5"]) r.push(t);
		expect(r.firstLine).toBe(3);
		expect(r.lastLine).toBe(5);
		const all = r.read();
		expect(all.lines.map((l) => l.n)).toEqual([3, 4, 5]);
		expect(all.missed).toBe(2);
		const fresh = r.read(3);
		expect(fresh.lines.map((l) => l.text)).toEqual(["4", "5"]);
		expect(fresh.missed).toBe(0);
		expect(r.read(1).missed).toBe(1);
	});

	it("returns nothing for a cursor at or past the end, and tolerates junk", () => {
		const r = new RingBuffer(3);
		r.push("x");
		expect(r.read(1).lines).toEqual([]);
		expect(r.read(99)).toEqual({ lines: [], missed: 0 });
		expect(r.read(-4).lines).toHaveLength(1);
		expect(r.read(Number.NaN).lines).toHaveLength(1);
	});

	it("handles the default 2000-line capacity", () => {
		const r = new RingBuffer();
		for (let i = 0; i < 2500; i++) r.push(String(i));
		expect(r.read().lines).toHaveLength(2000);
		expect(r.firstLine).toBe(501);
		expect(r.read().lines[0]).toEqual({ n: 501, text: "500" });
	});

	it("rejects a bad capacity", () => {
		expect(() => new RingBuffer(0)).toThrow(RangeError);
	});
});
