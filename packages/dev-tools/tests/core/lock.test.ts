import { describe, expect, it } from "vitest";
import { withLock } from "../../src/core/lock.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("withLock", () => {
	it("serializes same-key work and reports waiting", async () => {
		const order: string[] = [];
		let waited = 0;
		const a = withLock("k", async () => {
			order.push("a-start");
			await sleep(50);
			order.push("a-end");
		});
		const b = withLock(
			"k",
			async () => {
				order.push("b-start");
			},
			{ onWait: () => waited++ },
		);
		await Promise.all([a, b]);
		expect(order).toEqual(["a-start", "a-end", "b-start"]);
		expect(waited).toBe(1);
	});

	it("does not block different keys", async () => {
		const order: string[] = [];
		const a = withLock("x", async () => {
			await sleep(50);
			order.push("a");
		});
		const b = withLock("y", async () => {
			order.push("b");
		});
		await Promise.all([a, b]);
		expect(order).toEqual(["b", "a"]);
	});

	it("releases the lock when work throws", async () => {
		await expect(withLock("z", async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
		const r = await withLock("z", async () => "ok");
		expect(r).toBe("ok");
	});
});

describe("withLock abort", () => {
	it("rejects a queued waiter on abort without running it", async () => {
		const { LockAbortedError } = await import("../../src/core/lock.ts");
		let ran = false;
		const ac = new AbortController();
		const holder = withLock("q", () => sleep(100));
		const waiter = withLock(
			"q",
			async () => {
				ran = true;
			},
			{ signal: ac.signal },
		);
		ac.abort();
		await expect(waiter).rejects.toBeInstanceOf(LockAbortedError);
		await holder;
		expect(ran).toBe(false);
		// the key is released for the next caller
		expect(await withLock("q", async () => "next")).toBe("next");
	});

	it("does not fire onWait on a free lock and orders three waiters", async () => {
		const order: number[] = [];
		let waits = 0;
		const ps = [0, 1, 2].map((i) =>
			withLock(
				"three",
				async () => {
					await sleep(10);
					order.push(i);
				},
				{ onWait: () => waits++ },
			),
		);
		await Promise.all(ps);
		expect(order).toEqual([0, 1, 2]);
		expect(waits).toBe(2);
	});
});
