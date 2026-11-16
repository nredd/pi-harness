import { type BenchFn, type BenchRunOptions, it } from "vitest";

/** Preserve named benchmark cases using Vitest 5's native test-context benchmark fixture. */
export function bench(name: string, fn: BenchFn, options: BenchRunOptions = {}): void {
	it(name, async ({ bench }) => {
		await bench(name, fn).run(options);
	}, 0);
}
