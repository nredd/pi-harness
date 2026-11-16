import { Bench, type BenchOptions, type Fn } from "tinybench";
import { it } from "vitest";

/** Run an opt-in benchmark with Vitest's module mocks and tinybench's sampling. */
export function bench(name: string, fn: Fn, options: BenchOptions = {}): void {
	it(name, async () => {
		const benchmark = new Bench(options);
		benchmark.add(name, fn);
		await benchmark.run();
		console.table(benchmark.table());
	}, 0);
}
