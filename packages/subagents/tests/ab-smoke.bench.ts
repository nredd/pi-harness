/**
 * ab-smoke.bench.ts — one near-instant benchmark so the A/B CLI regression test
 * in `ab-tree.test.ts` can run a real round on both sides in about a second.
 */
import { describe } from "vitest";
import { bench } from "./fixtures/benchmark.ts";

describe("ab smoke", () => {
	bench("noop", () => {}, { time: 1, iterations: 1, warmupTime: 0, warmupIterations: 0 });
});
