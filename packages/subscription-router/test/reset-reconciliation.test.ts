import { expect, it, vi } from "vitest";
import { ExhaustionTracker } from "../src/exhaustion.js";
import type { RegistryContext, UsageSnapshot } from "../src/usage.js";
import { UsageService } from "../src/usage.js";
import { NOW } from "./fixtures/codex.js";

it("reconciles only fresh exactly matching provider/window/family evidence, never unrelated blocks", () => {
	const tracker = new ExhaustionTracker(() => NOW);
	const provider = { provider: "example", id: "sample" };
	const mark = () => tracker.mark(provider, { block: true, window: "weekly" });
	const snapshot: UsageSnapshot = {
		provider: "example",
		status: "available",
		retrievedAt: NOW,
		expiresAt: NOW + 1000,
		windows: [{ name: "weekly", usedPercent: 10, scope: "provider" }],
	};
	mark();
	tracker.reconcile({ ...snapshot, status: "stale" });
	tracker.reconcile({ ...snapshot, expiresAt: NOW });
	tracker.reconcile({ ...snapshot, provider: "other" });
	tracker.reconcile({ ...snapshot, windows: [{ name: "other", usedPercent: 10, scope: "provider" }] });
	tracker.reconcile({ ...snapshot, windows: [{ name: "weekly", usedPercent: 100, scope: "provider" }] });
	expect(tracker.active()).toHaveLength(1);
	tracker.reconcile(snapshot);
	expect(tracker.active()).toHaveLength(0);
	tracker.mark(provider, { block: true, window: "weekly", scope: "model", families: ["sample"] });
	tracker.reconcile(snapshot);
	expect(tracker.active()).toHaveLength(1);
	tracker.reconcile({ ...snapshot, windows: [{ name: "weekly", usedPercent: 0, scope: "model" }] });
	expect(tracker.active()).toHaveLength(1);
	tracker.reconcile({
		...snapshot,
		windows: [{ name: "weekly", usedPercent: 0, scope: "model", families: ["sample"] }],
	});
	expect(tracker.active()).toHaveLength(0);
});

it("invalidates pre-reset in-flight evidence without fabricating capacity or overriding caller cancellation", async () => {
	for (const result of ["absent", "current", "current-no-boundary", "too-old", "stale", "cancelled"]) {
		let finish: (response: Response) => void = () => {};
		let started: () => void = () => {};
		const ready = new Promise<void>((resolve) => {
			started = resolve;
		});
		const fetch = vi.fn(async () => {
			started();
			return new Promise<Response>((resolve) => {
				finish = resolve;
			});
		});
		let now = NOW;
		const usage = new UsageService({ now: () => now, getAccessToken: async () => "synthetic", fetch });
		const ctx = {} as RegistryContext;
		const controller = new AbortController();
		const prior = usage.get(ctx, "anthropic", {
			signal: result === "current-no-boundary" ? undefined : controller.signal,
			notBefore: result === "current-no-boundary" ? undefined : NOW,
		});
		await ready;
		usage.invalidate("anthropic");
		usage.invalidate("anthropic");
		if (result === "current" || result === "current-no-boundary" || result === "too-old" || result === "stale") {
			now = result === "too-old" ? NOW - 1 : NOW + 1;
			fetch.mockImplementationOnce(async () => new Response(JSON.stringify({ five_hour: { utilization: 0 } })));
			await usage.get(ctx, "anthropic");
			if (result === "stale") now += 600_000;
		}
		if (result === "cancelled") controller.abort();
		finish(new Response(JSON.stringify({ five_hour: { utilization: 100 } })));
		const evidence = await prior;
		if (result === "current" || result === "current-no-boundary") expect(evidence.windows[0]?.usedPercent).toBe(0);
		else expect(evidence.status).toBe("error");
		if (result === "cancelled") expect(evidence.message).toContain("cancelled");
		if (result === "absent") expect(usage.peek("anthropic")).toBeUndefined();
	}
});
