import { expect, it } from "vitest";
import { freezeNativeTimers } from "./native-timers.ts";

it("freezes positive deadlines, preserves zero macrotasks and restores globals after failed teardown", async () => {
	const real = {
		setTimeout: globalThis.setTimeout,
		setInterval: globalThis.setInterval,
		clearTimeout: globalThis.clearTimeout,
		clearInterval: globalThis.clearInterval,
	};
	let fired = 0;
	let zeroFired = 0;
	const frozen = freezeNativeTimers();
	const failure = new Error("failed teardown");
	try {
		await expect(
			(async () => {
				try {
					const timeout = setTimeout(() => fired++, 1);
					const interval = setInterval(() => fired++, 1);
					expect(timeout.hasRef()).toBe(true);
					expect(timeout.unref()).toBe(timeout);
					expect(timeout.hasRef()).toBe(false);
					expect(timeout.ref().refresh()).toBe(timeout);
					expect(timeout.hasRef()).toBe(true);
					expect(Number(timeout)).toBeLessThan(0);
					await new Promise<void>((resolve) => setTimeout(resolve, 0));
					await new Promise<void>((resolve) => setTimeout(resolve));
					await new Promise<void>((resolve) => {
						const zero = setInterval(() => {
							zeroFired++;
							clearTimeout(zero);
							resolve();
						}, 0);
					});
					expect(zeroFired).toBe(1);
					expect(fired).toBe(0);
					expect(frozen.records).toMatchObject([
						{ kind: "timeout", delay: 1, cleared: false },
						{ kind: "interval", delay: 1, cleared: false },
					]);
					for (const record of frozen.records) expect(record.origin).toContain("native-timers.test.ts");
					// Both clear APIs accept either kind, including numeric coercions.
					clearInterval(Number(timeout));
					clearTimeout(interval);
					timeout.refresh();
					interval.refresh();
					await new Promise<void>((resolve) => setTimeout(resolve, 0));
					expect(fired).toBe(0);
					expect(frozen.records.every((record) => record.cleared)).toBe(true);
					throw failure;
				} finally {
					frozen.restore();
				}
			})(),
		).rejects.toBe(failure);
		for (const key of Object.keys(real) as (keyof typeof real)[]) expect(globalThis[key]).toBe(real[key]);
	} finally {
		frozen.restore();
	}
});

it("disposes an inert timer when its `using` scope exits", () => {
	const frozen = freezeNativeTimers();
	try {
		{
			using timeout = setTimeout(() => {}, 1);
			expect(timeout.hasRef()).toBe(true);
			expect(frozen.records).toMatchObject([{ kind: "timeout", delay: 1, cleared: false }]);
		}
		expect(frozen.records).toMatchObject([{ kind: "timeout", delay: 1, cleared: true }]);
	} finally {
		frozen.restore();
	}
});

it("clears a real zero-delay interval through the frozen clearInterval", async () => {
	const frozen = freezeNativeTimers();
	try {
		let fired = 0;
		const interval = setInterval(() => fired++, 0);
		clearInterval(interval);
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		expect(fired).toBe(0);
		expect(frozen.records).toEqual([]);
	} finally {
		frozen.restore();
	}
});

it("records an unknown origin when no stack frame names the caller", () => {
	const frozen = freezeNativeTimers();
	const limit = Error.stackTraceLimit;
	try {
		Error.stackTraceLimit = 0;
		setTimeout(() => {}, 1);
		expect(frozen.records).toEqual([{ kind: "timeout", delay: 1, origin: "unknown origin", cleared: false }]);
	} finally {
		Error.stackTraceLimit = limit;
		frozen.restore();
	}
});
