/** Real Pi quota confirmation keeps completed evidence at the collector's total deadline. */
import {
	createHarness,
	fauxAssistantMessage,
	type Harness,
	registerFauxProvider,
} from "@earendil-works/pi-coding-agent/testing";
import { expect, it, vi } from "vitest";
import { ExhaustionTracker } from "../src/exhaustion.js";
import { createSubscriptionRouter } from "../src/index.js";
import { UsageService } from "../src/usage.js";

it("recovers R1 at 20s with R2 still fetching until 24s", async () => {
	const epoch = Date.parse("2030-01-01T00:00:00Z");
	let now = epoch;
	let lookups = 0;
	const pending: ((response: Response) => void)[] = [];
	const response = (used: number) =>
		new Response(
			JSON.stringify({ five_hour: { utilization: used, resets_at: new Date(epoch + 3_600_000).toISOString() } }),
		);
	const usage = new UsageService({
		now: () => now,
		getAccessToken: async () => {
			if (++lookups === 3) await new Promise((resolve) => setTimeout(resolve, 9_000));
			return "synthetic";
		},
		fetch: (_url, opts) =>
			new Promise<Response>((resolve, reject) => {
				pending.push(resolve);
				opts.signal?.addEventListener("abort", () => reject(new DOMException("timeout", "AbortError")));
			}),
	});
	const warm = usage.get({} as never, "anthropic");
	await vi.waitFor(() => expect(pending).toHaveLength(1));
	pending[0]?.(response(0));
	await warm;
	const providers = [
		registerFauxProvider({ provider: "anthropic", models: [{ id: "test-a" }] }),
		registerFauxProvider({ provider: "local", models: [{ id: "test-b" }] }),
	];
	const tracker = new ExhaustionTracker(() => now);
	const sessions: Harness[] = [];
	try {
		for (let i = 0; i < 2; i++) {
			const harness = await createHarness({
				useModelRuntimeStream: true,
				extensionFactories: [
					createSubscriptionRouter({
						config: {
							ok: true,
							profiles: [
								{
									id: "shared",
									name: "Shared",
									chain: [
										{ provider: "anthropic", id: "test-a" },
										{ provider: "local", id: "test-b" },
									],
								},
							],
						},
						usage,
						tracker,
						now: () => now,
					}),
				],
			});
			sessions.push(harness);
			for (const provider of providers) {
				const model = provider.getModel();
				harness.session.modelRuntime.registerProvider(model.provider, {
					baseUrl: model.baseUrl,
					apiKey: "faux",
					api: provider.api,
					models: provider.models,
				});
			}
			await harness.session.bindExtensions({ mode: "rpc" });
			const model = harness.session.modelRuntime.getModel("router", "shared");
			if (!model) throw new Error("Missing router fixture");
			await harness.session.setModel(model);
		}
		const [a, b] = providers;
		const [one, two] = sessions;
		if (!a || !b || !one || !two) throw new Error("Missing session fixture");
		a.setResponses(
			[0, 1].map(
				() => () =>
					fauxAssistantMessage("", { stopReason: "error", errorMessage: "insufficient_quota", timestamp: now }),
			),
		);
		b.setResponses([fauxAssistantMessage("recovered one")]);
		vi.useFakeTimers();
		vi.setSystemTime(epoch + 1);
		now = Date.now();
		const advance = async (ms: number) => {
			now += ms;
			await vi.advanceTimersByTimeAsync(ms);
		};
		const first = one.session.prompt("one");
		await advance(0);
		expect(pending).toHaveLength(2);
		await advance(5_000);
		const second = two.session.prompt("two");
		await advance(0);
		expect(lookups).toBe(3);
		await advance(1_000);
		pending[1]?.(response(100));
		await advance(0);
		expect(b.state.callCount).toBe(0);
		await advance(13_999);
		expect(pending).toHaveLength(3);
		expect(b.state.callCount).toBe(0);
		await advance(1);
		await first;
		expect(b.state.callCount).toBe(1);
		expect(tracker.active()).toHaveLength(1);
		await advance(4_000);
		await second;
		expect(a.state.callCount).toBe(2);
		expect(b.state.callCount).toBe(1);
		expect(usage.peek("anthropic")).toMatchObject({ status: "stale", windows: [{ usedPercent: 0 }] });
		expect((await usage.get({} as never, "anthropic", { force: true })).message).toContain("Backing off");
		expect(pending).toHaveLength(3);
		expect(vi.getTimerCount()).toBe(0);
		for (const [index, harness] of sessions.entries()) {
			expect(
				harness
					.eventsOfType("message_end")
					.filter((event) => event.message.role === "assistant" && event.message.provider === "local"),
			).toHaveLength(index === 0 ? 1 : 0);
		}
	} finally {
		vi.useRealTimers();
		for (const harness of sessions) harness.cleanup();
		for (const provider of providers) provider.unregister();
	}
});
