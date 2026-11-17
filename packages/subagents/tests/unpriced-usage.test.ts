/** Core-compatible unpriced accounting without introducing another estimator. */
import { expect, it } from "vitest";
import { addUsage, type LifetimeUsage, PendingUsagePool, toReportedUsage } from "../src/usage.ts";

it.each([
	[{ input: 1, output: 0, cacheWrite: 0, unpriced: true }, 0, 1],
	[{ input: 1, output: 0, cacheWrite: 0, unpriced: true, cost: 2 }, 1, 1],
	[{ input: 1, output: 0, cacheWrite: 0, unpriced: true, unpricedCalls: 3, pricedCalls: 2, cost: 2 }, 2, 3],
] satisfies [LifetimeUsage, number, number][])(
	"preserves aggregate counts: %j",
	(delta, pricedCalls, unpricedCalls) => {
		const u: LifetimeUsage = { input: 0, output: 0, cacheWrite: 0 };
		addUsage(u, delta);
		expect(toReportedUsage(u)?.cost).toMatchObject({ unpriced: true, pricedCalls, unpricedCalls });
	},
);

it.each([false, true])("keeps free priced usage distinct from empty failures, reverse=%s", (reverse) => {
	const unknown: LifetimeUsage = { input: 7, output: 0, cacheWrite: 0, unpriced: true };
	const free: LifetimeUsage = { input: 1, output: 0, cacheWrite: 0, cost: 0 };
	const pool = new PendingUsagePool();
	for (const delta of reverse ? [free, unknown] : [unknown, free]) pool.add(delta);
	pool.add({ input: 0, output: 0, cacheWrite: 0 });
	expect(pool.drain()?.cost).toMatchObject({ unpriced: true, unpricedCalls: 1, pricedCalls: 1 });
	expect(pool.drain()).toBeUndefined();
	pool.add(unknown);
	expect(pool.drain()?.cost).toMatchObject({ unpriced: true, unpricedCalls: 1, pricedCalls: 0 });
});

it("accumulates into a legacy marker without an aggregate count", () => {
	const into: LifetimeUsage = { input: 7, output: 0, cacheWrite: 0, unpriced: true };
	addUsage(into, { input: 0, output: 0, cacheWrite: 0 });
	expect(toReportedUsage(into)?.cost).toMatchObject({ unpricedCalls: 1, pricedCalls: 0 });
});

it("retains direct legacy markers and marker-only usage", () => {
	expect(toReportedUsage({ input: 0, output: 0, cacheWrite: 0, unpriced: true })?.cost).toMatchObject({
		unpriced: true,
		unpricedCalls: 1,
		pricedCalls: 0,
	});
});
