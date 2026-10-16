import { describe, expect, it } from "vitest";
import { BoundedMatcher, MATCH_QUEUE_BYTES } from "../../src/monitor/matcher.ts";

describe("BoundedMatcher", () => {
	it("preserves regex semantics and callback order through final draining", async () => {
		const matcher = new BoundedMatcher("^ERROR\\b");
		const matched: boolean[] = [];
		try {
			for (const text of ["fine", "ERROR bad", "ERRORS", "ERROR"]) matcher.test(text, (value) => matched.push(value));
			await matcher.drain();
			expect(matched).toEqual([false, true, false, true]);
		} finally {
			await matcher.close();
		}
	});

	it("fails open on queue overflow, including queued empty lines", async () => {
		const matcher = new BoundedMatcher("never");
		const matched: boolean[] = [];
		matcher.test("", (value) => matched.push(value));
		matcher.test("a".repeat(MATCH_QUEUE_BYTES), (value) => matched.push(value));
		matcher.test("future", (value) => matched.push(value));
		await matcher.close();
		expect(matched).toEqual([true, true, true]);
	});

	it("interrupts a stuck regex and awaits worker cleanup on close", async () => {
		const matcher = new BoundedMatcher("^(a+)+$");
		const matched: boolean[] = [];
		matcher.test(`${"a".repeat(4096)}!`, (value) => matched.push(value));
		await new Promise((resolve) => setTimeout(resolve, 60));
		const start = Date.now();
		await matcher.close();
		expect(Date.now() - start).toBeLessThan(500);
		expect(matched).toEqual([true]);
		await matcher.close();
	});

	it("disables matching after worker initialization fails", async () => {
		const matcher = new BoundedMatcher("[");
		const matched: boolean[] = [];
		matcher.test("anything", (value) => matched.push(value));
		await matcher.drain();
		await matcher.close();
		expect(matched).toEqual([true]);
	});
});
