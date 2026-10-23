/** Two real Pi sessions share the production collector/cache while confirmations overlap. */
import {
	createHarness,
	fauxAssistantMessage,
	type Harness,
	registerFauxProvider,
} from "@earendil-works/pi-coding-agent/testing";
import { expect, it } from "vitest";
import { ExhaustionTracker } from "../../src/exhaustion.js";
import { createSubscriptionRouter } from "../../src/index.js";
import { UsageService } from "../../src/usage.js";

it.each([
	{ newerFails: false, olderFirst: true },
	{ newerFails: true, olderFirst: true },
	{ newerFails: true, olderFirst: false },
])("concurrent confirmation recovery without duplicate dispatches: %j", async ({ newerFails, olderFirst }) => {
	let now = Date.parse("2030-01-01T00:00:00Z");
	const pending: ((response: Response) => void)[] = [];
	const waitForReads = async (count: number) => {
		const deadline = Date.now() + 1000;
		while (pending.length < count && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 1));
		}
		expect(pending).toHaveLength(count);
	};
	const response = (used: number) =>
		new Response(
			JSON.stringify({
				five_hour: {
					utilization: used,
					resets_at: new Date(now + 3_600_000).toISOString(),
				},
			}),
		);
	const usage = new UsageService({
		now: () => now,
		getAccessToken: async () => "synthetic",
		fetch: () => new Promise<Response>((resolve) => pending.push(resolve)),
	});
	const warm = usage.get({} as never, "anthropic");
	await waitForReads(1);
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
		const a = providers[0];
		const b = providers[1];
		if (!a || !b || !sessions[0] || !sessions[1]) throw new Error("Missing session fixture");
		a.setResponses(
			[0, 1].map(
				() => () =>
					fauxAssistantMessage("", {
						stopReason: "error",
						errorMessage: "insufficient_quota",
						timestamp: now,
					}),
			),
		);
		b.setResponses([fauxAssistantMessage("recovered one"), fauxAssistantMessage("recovered two")]);
		now++;
		const first = sessions[0].session.prompt("one");
		await waitForReads(2);
		now++;
		const second = sessions[1].session.prompt("two");
		await waitForReads(3);
		if (olderFirst) {
			pending[1]?.(response(100));
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(b.state.callCount).toBe(0);
			expect(usage.peek("anthropic")?.windows[0]?.usedPercent).toBe(0);
		}
		pending[2]?.(newerFails ? new Response(null, { status: 500 }) : response(100));
		if (!olderFirst) {
			await second;
			pending[1]?.(response(100));
		}
		await Promise.all([first, second]);
		expect(a.state.callCount).toBe(2);
		expect(b.state.callCount).toBe(newerFails ? 1 : 2);
		if (newerFails) {
			expect(usage.peek("anthropic")).toMatchObject({ status: "stale", windows: [{ usedPercent: 0 }] });
			expect((await usage.get({} as never, "anthropic", { force: true })).message).toContain("Backing off");
		}
		expect(pending).toHaveLength(3);
		expect(tracker.active()).toHaveLength(1);
		for (const [index, harness] of sessions.entries()) {
			expect(
				harness
					.eventsOfType("message_end")
					.filter((event) => event.message.role === "assistant" && event.message.provider === "local"),
			).toHaveLength(newerFails && index === 1 ? 0 : 1);
		}
	} finally {
		for (const harness of sessions) harness.cleanup();
		for (const provider of providers) provider.unregister();
	}
});
