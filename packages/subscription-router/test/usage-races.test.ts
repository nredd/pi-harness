/** Controlled completion order proves shared cache state follows read initiation, not network latency. */
import { describe, expect, it, vi } from "vitest";
import { UsageService } from "../src/usage.js";

const T0 = 1_700_000_000_000;
const ctx = {} as never;
const body = (used: number) => new Response(JSON.stringify({ five_hour: { utilization: used } }));

describe("usage read ownership", () => {
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

	it("never certifies a superseded response as live against a different shared snapshot", async () => {
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
		pending[1]?.(new Response("private-response", { status: 500 }));
		await late;
		pending[0]?.(body(100));
		expect(await early).toMatchObject({ status: "error", message: "Usage request was superseded by a newer read." });
		expect(service.peek("anthropic")).toBeUndefined();
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
