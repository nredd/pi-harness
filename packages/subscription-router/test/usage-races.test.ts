/** Controlled completion order proves shared cache state follows read initiation, not network latency. */
import { describe, expect, it, vi } from "vitest";
import { UsageService } from "../src/usage.js";

const T0 = 1_700_000_000_000;
const ctx = {} as never;
const body = (used: number) => new Response(JSON.stringify({ five_hour: { utilization: used } }));

describe("usage read ownership", () => {
	it.each(["deadline", "timely", "abort", "too-old"] as const)(
		"handles overlapping lookup/fetch at the outer deadline: %s",
		async (ending) => {
			vi.useFakeTimers();
			vi.setSystemTime(T0);
			try {
				let lookups = 0;
				const pending: ((response: Response) => void)[] = [];
				const service = new UsageService({
					now: () => Date.now(),
					getAccessToken: async () => {
						if (++lookups === 2) await new Promise((resolve) => setTimeout(resolve, 9_000));
						return "synthetic";
					},
					fetch: (_url, options) =>
						new Promise<Response>((resolve, reject) => {
							pending.push(resolve);
							options.signal?.addEventListener("abort", () => reject(new DOMException("timeout", "AbortError")));
						}),
				});
				const controller = new AbortController();
				const addListener = vi.spyOn(controller.signal, "addEventListener");
				const removeListener = vi.spyOn(controller.signal, "removeEventListener");
				const early = service.get(ctx, "anthropic", {
					fresh: true,
					notBefore: ending === "too-old" ? T0 + 1 : T0,
					signal: controller.signal,
				});
				await vi.advanceTimersByTimeAsync(5_000);
				const late = service.get(ctx, "anthropic", { fresh: true, notBefore: Date.now() });
				await vi.advanceTimersByTimeAsync(1_000);
				expect(pending).toHaveLength(1);
				pending[0]?.(body(100)); // R2 already owns the read when R1 completes at t=6s.
				await vi.advanceTimersByTimeAsync(13_000);
				if (ending === "timely") pending[1]?.(body(25));
				if (ending === "abort") controller.abort();
				await vi.advanceTimersByTimeAsync(1_000);
				expect(Date.now() - T0).toBe(20_000);
				expect(pending).toHaveLength(2); // R2 fetch starts at t=14s and aborts at t=24s.
				if (ending === "abort" || ending === "too-old") {
					expect((await early).message).toBe(
						ending === "abort" ? "Usage request was cancelled." : "Usage request timed out.",
					);
				} else {
					expect(await early).toMatchObject({
						status: "available",
						retrievedAt: ending === "timely" ? T0 + 5_000 : T0,
						windows: [{ usedPercent: ending === "timely" ? 25 : 100 }],
					});
				}
				expect(addListener).toHaveBeenCalledTimes(1);
				expect(removeListener).toHaveBeenCalledTimes(1);
				await vi.advanceTimersByTimeAsync(4_000);
				if (ending === "timely") {
					expect((await late).status).toBe("available");
					expect(service.peek("anthropic")?.windows[0]?.usedPercent).toBe(25);
				} else {
					expect((await late).message).toBe("Usage request timed out.");
					expect(service.peek("anthropic")).toBeUndefined();
					expect((await service.get(ctx, "anthropic", { force: true })).message).toContain("Backing off");
				}
				expect(removeListener).toHaveBeenCalledTimes(1);
				expect(vi.getTimerCount()).toBe(0);
			} finally {
				vi.useRealTimers();
			}
		},
	);
	it("keeps each caller's deadline across a chain and uses its newest completed evidence", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(T0);
		try {
			let lookups = 0;
			const pending: ((response: Response) => void)[] = [];
			const service = new UsageService({
				now: () => Date.now(),
				getAccessToken: async () => {
					if (++lookups > 1) await new Promise((resolve) => setTimeout(resolve, 9_000));
					return "synthetic";
				},
				fetch: (_url, options) =>
					new Promise<Response>((resolve, reject) => {
						pending.push(resolve);
						options.signal?.addEventListener("abort", () => reject(new DOMException("timeout", "AbortError")));
					}),
			});
			const early = service.get(ctx, "anthropic", { fresh: true, notBefore: T0 });
			await vi.advanceTimersByTimeAsync(1_000);
			const joined = service.get(ctx, "anthropic", { fresh: true, notBefore: T0 });
			await vi.advanceTimersByTimeAsync(4_000);
			const middle = service.get(ctx, "anthropic", { fresh: true, notBefore: Date.now() });
			await vi.advanceTimersByTimeAsync(1_000);
			pending[0]?.(body(100));
			await vi.advanceTimersByTimeAsync(9_000);
			const latest = service.get(ctx, "anthropic", { fresh: true, notBefore: Date.now() });
			pending[1]?.(body(50)); // R2 completes at 15s, already superseded by R3.
			await vi.advanceTimersByTimeAsync(5_000);
			expect(Date.now() - T0).toBe(20_000);
			expect(await early).toMatchObject({
				status: "available",
				retrievedAt: T0 + 5_000,
				windows: [{ usedPercent: 50 }],
			});
			await vi.advanceTimersByTimeAsync(1_000);
			expect(await joined).toEqual(await early);
			await vi.advanceTimersByTimeAsync(4_000);
			expect(await middle).toEqual(await early);
			await vi.advanceTimersByTimeAsync(9_000);
			expect((await latest).message).toBe("Usage request timed out.");
			expect(pending).toHaveLength(3);
			expect(service.peek("anthropic")).toBeUndefined();
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it.each([false, true])("does not let a superseded read overwrite a newer success (old failure=%s)", async (fail) => {
		let now = T0;
		const pending: ((response: Response) => void)[] = [];
		const service = new UsageService({
			now: () => now,
			getAccessToken: async () => "synthetic",
			fetch: () => new Promise<Response>((resolve) => pending.push(resolve)),
		});
		const early = service.get(ctx, "anthropic");
		await vi.waitFor(() => expect(pending).toHaveLength(1));
		now++;
		const late = service.get(ctx, "anthropic", { fresh: true, notBefore: now });
		await vi.waitFor(() => expect(pending).toHaveLength(2));
		pending[1]?.(body(100));
		await late;
		pending[0]?.(fail ? new Response("private-response", { status: 429 }) : body(1));
		await early;
		expect(service.peek("anthropic")).toMatchObject({
			status: "available",
			retrievedAt: now,
			windows: [{ usedPercent: 100 }],
		});
		now++;
		const next = service.get(ctx, "anthropic", { fresh: true, notBefore: now });
		await vi.waitFor(() => expect(pending).toHaveLength(3));
		pending[2]?.(body(25));
		expect((await next).status).toBe("available");
	});

	it("does not downgrade a newer success with a superseded failed refresh's stale cache", async () => {
		let now = T0;
		const pending: ((response: Response) => void)[] = [];
		const service = new UsageService({
			now: () => now,
			getAccessToken: async () => "synthetic",
			fetch: () => new Promise<Response>((resolve) => pending.push(resolve)),
		});
		const warm = service.get(ctx, "anthropic");
		await vi.waitFor(() => expect(pending).toHaveLength(1));
		pending[0]?.(body(10));
		await warm;
		now += 300_000;
		const early = service.get(ctx, "anthropic");
		await vi.waitFor(() => expect(pending).toHaveLength(2));
		now++;
		const late = service.get(ctx, "anthropic", { fresh: true, notBefore: now });
		await vi.waitFor(() => expect(pending).toHaveLength(3));
		pending[2]?.(body(100));
		await late;
		pending[1]?.(new Response("private-response", { status: 500 }));
		await early;
		expect(service.peek("anthropic")).toMatchObject({
			status: "available",
			retrievedAt: now,
			windows: [{ usedPercent: 100 }],
		});
	});

	it.each([
		[false, 500],
		[true, 500],
		[false, 429],
		[true, 429],
	] as const)(
		"retains its own confirmation when the newer read fails (older first=%s, status=%s)",
		async (olderFirst, status) => {
			let now = T0;
			const pending: ((response: Response) => void)[] = [];
			const service = new UsageService({
				now: () => now,
				getAccessToken: async () => "synthetic",
				fetch: () => new Promise<Response>((resolve) => pending.push(resolve)),
			});
			const early = service.get(ctx, "anthropic", { fresh: true, notBefore: now });
			await vi.waitFor(() => expect(pending).toHaveLength(1));
			now++;
			const late = service.get(ctx, "anthropic", { fresh: true, notBefore: now });
			await vi.waitFor(() => expect(pending).toHaveLength(2));
			if (olderFirst) {
				pending[0]?.(body(100));
				await new Promise((resolve) => setTimeout(resolve, 0));
			}
			pending[1]?.(new Response("private-response", { status }));
			await late;
			if (!olderFirst) pending[0]?.(body(100));
			expect(await early).toMatchObject({ status: "available", retrievedAt: T0, windows: [{ usedPercent: 100 }] });
			expect(service.peek("anthropic")).toBeUndefined();
			expect((await service.get(ctx, "anthropic", { force: true })).message).toContain("Backing off");
			expect(pending).toHaveLength(2);
		},
	);

	it.each([false, true])("follows the newer confirming read (older finishes first=%s)", async (olderFirst) => {
		let now = T0;
		const pending: ((response: Response) => void)[] = [];
		const service = new UsageService({
			now: () => now,
			getAccessToken: async () => "synthetic",
			fetch: () => new Promise<Response>((resolve) => pending.push(resolve)),
		});
		const early = service.get(ctx, "anthropic", { fresh: true, notBefore: now });
		await vi.waitFor(() => expect(pending).toHaveLength(1));
		now++;
		const late = service.get(ctx, "anthropic", { fresh: true, notBefore: now });
		await vi.waitFor(() => expect(pending).toHaveLength(2));
		if (olderFirst) {
			pending[0]?.(body(100));
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(service.peek("anthropic")).toBeUndefined();
		}
		pending[1]?.(body(25));
		const newest = await late;
		if (!olderFirst) pending[0]?.(body(100));
		expect(await early).toBe(newest);
		expect(service.peek("anthropic")).toBe(newest);
		expect(pending).toHaveLength(2);
	});

	it.each(["abort", "timeout"] as const)(
		"bounds a superseded caller on %s without cancelling the newer read",
		async (ending) => {
			vi.useFakeTimers();
			try {
				let now = T0;
				const pending: ((response: Response) => void)[] = [];
				const service = new UsageService({
					now: () => now,
					getAccessToken: async () => "synthetic",
					fetch: () => new Promise<Response>((resolve) => pending.push(resolve)),
				});
				const controller = new AbortController();
				const early = service.get(ctx, "anthropic", { force: true, signal: controller.signal });
				await vi.advanceTimersByTimeAsync(0);
				now++;
				const late = service.get(ctx, "anthropic", { fresh: true, notBefore: now });
				await vi.advanceTimersByTimeAsync(0);
				pending[0]?.(body(100));
				await vi.advanceTimersByTimeAsync(0);
				if (ending === "abort") controller.abort();
				else await vi.advanceTimersByTimeAsync(20_000);
				if (ending === "abort") expect((await early).message).toContain("cancelled");
				else expect(await early).toMatchObject({ status: "available", windows: [{ usedPercent: 100 }] });
				pending[1]?.(body(25));
				await late;
				await vi.advanceTimersByTimeAsync(0);
				expect(service.peek("anthropic")?.windows[0]?.usedPercent).toBe(25);
				expect((await service.get(ctx, "anthropic", { force: true })).message).toContain("once per minute");
				expect(pending).toHaveLength(2);
			} finally {
				vi.useRealTimers();
			}
		},
	);

	it.each([false, true])("retains its confirmation after a newer timeout (older first=%s)", async (olderFirst) => {
		vi.useFakeTimers();
		try {
			let now = T0;
			const pending: ((response: Response) => void)[] = [];
			const service = new UsageService({
				now: () => now,
				getAccessToken: async () => "synthetic",
				fetch: (_url, options) =>
					new Promise<Response>((resolve, reject) => {
						pending.push(resolve);
						if (pending.length === 2) {
							options?.signal?.addEventListener("abort", () => reject(new DOMException("timeout", "AbortError")));
						}
					}),
			});
			const early = service.get(ctx, "anthropic", { fresh: true, notBefore: now });
			await vi.advanceTimersByTimeAsync(0);
			now++;
			const late = service.get(ctx, "anthropic", { fresh: true, notBefore: now });
			await vi.advanceTimersByTimeAsync(0);
			if (olderFirst) pending[0]?.(body(100));
			await vi.advanceTimersByTimeAsync(10_000);
			expect(await late).toMatchObject({ status: "error", message: "Usage request timed out." });
			if (!olderFirst) pending[0]?.(body(100));
			expect(await early).toMatchObject({ status: "available", retrievedAt: T0 });
			expect(service.peek("anthropic")).toBeUndefined();
			expect((await service.get(ctx, "anthropic", { force: true })).message).toContain("Backing off");
			expect(pending).toHaveLength(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not use its own response when it predates the requested freshness boundary", async () => {
		let now = T0;
		const pending: ((response: Response) => void)[] = [];
		const service = new UsageService({
			now: () => now,
			getAccessToken: async () => "synthetic",
			fetch: () => new Promise<Response>((resolve) => pending.push(resolve)),
		});
		const early = service.get(ctx, "anthropic", { fresh: true, notBefore: T0 + 1 });
		await vi.waitFor(() => expect(pending).toHaveLength(1));
		now++;
		const late = service.get(ctx, "anthropic", { fresh: true, notBefore: now });
		await vi.waitFor(() => expect(pending).toHaveLength(2));
		pending[1]?.(new Response(null, { status: 500 }));
		await late;
		pending[0]?.(body(100));
		expect((await early).status).toBe("error");
	});

	it("evaluates the exact returned snapshot even when a later cache read disagrees", async () => {
		let now = T0;
		let used = 0;
		const service = new UsageService({
			now: () => now,
			getAccessToken: async () => "synthetic",
			fetch: async () => body(used),
		});
		const first = await service.get(ctx, "anthropic");
		now++;
		used = 100;
		await service.get(ctx, "anthropic", { fresh: true, notBefore: now });
		const model = { provider: "anthropic", id: "sonnet" };
		expect(service.decisionFor(model).block).toBe(true);
		expect(service.decisionFor(model, first).block).toBe(false);
	});

	it("a pre-cancelled manual refresh neither reads credentials nor consumes the manual allowance", async () => {
		let calls = 0;
		const service = new UsageService({
			now: () => T0,
			getAccessToken: async () => {
				calls++;
				return "synthetic";
			},
			fetch: async () => body(1),
		});
		const signal = AbortSignal.abort();
		expect((await service.get(ctx, "anthropic", { force: true, signal })).message).toContain("cancelled");
		expect(calls).toBe(0);
		expect((await service.get(ctx, "anthropic", { force: true })).status).toBe("available");
		expect(calls).toBe(1);
		expect((await service.get(ctx, "anthropic", { signal })).message).toContain("cancelled");
	});
});
