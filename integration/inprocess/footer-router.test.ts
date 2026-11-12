/** Real quota admission/routing -> assistant metadata -> preset footer, without paid calls. */
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-coding-agent/testing";
import { expect, it } from "vitest";
import { FooterFixture } from "../../packages/preset/test/scenarios/support.ts";
import { createSubscriptionRouter } from "../../packages/subscription-router/src/index.ts";
import { CachedUsage, Clock } from "../../packages/subscription-router/test/scenarios/support.ts";

it("shows quota fallback/provider changes and never labels refused admission as dispatched", async () => {
	const usage = new CachedUsage(new Clock());
	usage.set("faux", 0);
	usage.set("fixture-b", 0);
	const fixture = new FooterFixture();
	let admit: (() => Promise<unknown>) | undefined;
	const fallback = registerFauxProvider({ provider: "fixture-b", models: [{ id: "beta", reasoning: true }] });
	try {
		const host = await fixture.start({
			columns: 240,
			models: [{ id: "alpha", reasoning: true }],
			useModelRuntimeStream: true,
			settings: { retry: { enabled: false } },
			extensionFactories: [
				createSubscriptionRouter({
					config: {
						ok: true,
						profiles: [
							{
								id: "deep",
								name: "Fixture",
								strategy: "ordered",
								exhaustion: { policy: "wait" },
								chain: [
									{ provider: "faux", id: "alpha", thinking: "low" },
									{ provider: "fixture-b", id: "beta", thinking: "high" },
								],
							},
						],
					},
					usage,
					now: usage.clock.now,
				}),
				(pi) => {
					admit = () =>
						new Promise((resolve) => {
							const off = pi.events.on("router:rpc:admit:reply:footer-fixture", (reply) => {
								off();
								resolve(reply);
							});
							pi.events.emit("router:rpc:admit", { requestId: "footer-fixture", model: "router/deep" });
						});
					pi.on("session_start", async (_event, ctx) => {
						const virtual = ctx.modelRegistry.find("router", "deep");
						if (!virtual) throw new Error("Missing fixture model");
						pi.registerProvider("fixture-b", { apiKey: "fixture", api: fallback.api, models: fallback.models });
						await pi.setModel(virtual);
						pi.setThinkingLevel("medium");
					});
				},
			],
		});
		const stats = () => {
			const rows = host.viewport().filter((row) => row.includes("(auto)"));
			expect(rows).toHaveLength(1);
			return rows[0] ?? "";
		};
		host.harness.setResponses([fauxAssistantMessage("first")]);
		fallback.setResponses([fauxAssistantMessage("fallback")]);
		await host.harness.session.prompt("first");
		await host.settle();
		expect(stats()).toContain("-> (faux) alpha • low");
		usage.set("faux", 100);
		await host.harness.session.prompt("second");
		await host.settle();
		expect(stats()).toContain("-> (fixture-b) beta • high");
		expect(stats()).not.toContain("alpha");
		usage.set("fixture-b", 100);
		await host.harness.session.prompt("no route");
		await host.settle();
		expect(stats()).toContain("deep • medium (unresolved)");
		expect(stats()).not.toContain("beta");
		if (!admit) throw new Error("Missing fixture admission RPC");
		expect(await admit()).toMatchObject({ success: true, data: { ok: false, wait: true } });
		expect(stats()).toContain("(unresolved)");
		expect(host.harness.faux.state.callCount).toBe(1);
		expect(fallback.state.callCount).toBe(1);
		expect(host.harness.session.model).toMatchObject({ provider: "router", id: "deep" });
	} finally {
		await fixture.dispose();
		fallback.unregister();
	}
});
