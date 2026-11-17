/**
 * #294: a child session shares its parent's model runtime and re-registers `router/*` into
 * it, so the registered route belongs to the last session that loaded. Real sessions on one
 * real runtime; only quota is a double.
 */
import { createHarness, fauxAssistantMessage, type Harness } from "@earendil-works/pi-coding-agent/testing";
import { deferred } from "@nredd/pi-test-lib/deferred";
import { afterEach, describe, expect, it } from "vitest";
import { createSubscriptionRouter } from "../../src/index.ts";
import { CachedUsage, Clock, prompt, type RouterScenario, startRouter } from "../fixtures/router.ts";

const PROFILE = {
	id: "spike",
	name: "Router spike",
	strategy: "ordered" as const,
	chain: [{ provider: "spike-a", id: "sonnet-a" }],
};

describe("router on a runtime shared with a child session", () => {
	let scenario: RouterScenario | undefined;
	const harnesses: Harness[] = [];
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
		scenario?.cleanup();
	});

	/** The parent, and a child whose load has rebound `router/spike`. */
	async function startChild(kind?: "strict-priority" | "remaining-balanced") {
		const clock = new Clock();
		const usage = new CachedUsage(clock);
		usage.set("spike-a", 0);
		scenario = await startRouter(usage, kind ? { version: 1, kind } : "ordered");
		const child = await createHarness({
			modelRuntime: scenario.harness.session.modelRuntime,
			useModelRuntimeStream: true,
			extensionFactories: [
				createSubscriptionRouter({
					config: {
						ok: true,
						profiles: [{ ...PROFILE, ...(kind ? { strategy: undefined, policy: { version: 1, kind } as const } : {}) }],
					},
					usage,
					tracker: scenario.tracker,
					now: clock.now,
				}),
			],
		});
		harnesses.push(child);
		return { scenario, child };
	}

	/** Route the profile directly, the way any session sharing the runtime does. */
	function route({ session }: Harness) {
		const model = session.modelRuntime.getModel("router", "spike");
		if (!model) throw new Error("router/spike is not registered");
		return session.modelRuntime.resolveModel(model, [], { reason: "direct", thinkingLevel: "off" });
	}

	it.each([false, true])(
		"invalidates a requester without its own router extension (away-and-back=%s)",
		async (awayAndBack) => {
			const clock = new Clock();
			const usage = new CachedUsage(clock);
			usage.set("spike-a", 0);
			usage.set("spike-b", 0);
			const entered = deferred();
			const release = deferred();
			usage.onRefresh = async (provider) => {
				entered.resolve();
				await release.promise;
				usage.set(provider, 100);
			};
			scenario = await startRouter(usage);
			const requester = await createHarness({
				modelRuntime: scenario.harness.session.modelRuntime,
				useModelRuntimeStream: true,
				settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 0 } },
			});
			harnesses.push(requester);
			await requester.session.bindExtensions({ mode: "rpc" });
			const selected = requester.session.modelRuntime.getModel("router", "spike");
			if (!selected) throw new Error("Missing shared route");
			await requester.session.setModel(selected);
			scenario.providers[0].setResponses([
				fauxAssistantMessage("", {
					stopReason: "error",
					errorMessage: "429 Too Many Requests: rate_limit_error",
					timestamp: clock.now(),
				}),
			]);
			scenario.providers[1].setResponses([fauxAssistantMessage("must not run")]);
			const run = requester.session.prompt("shared registrant");
			await entered.promise;
			try {
				await requester.session.setModel(scenario.providers[1].getModel());
				if (awayAndBack) await requester.session.setModel(selected);
			} finally {
				release.resolve();
			}
			await run;
			expect(scenario.providers.map((provider) => provider.state.callCount)).toEqual([1, 0, 0]);
			expect(scenario.tracker.active()).toMatchObject([{ provider: "spike-a" }]);
		},
	);

	it("routes through a child that has not started yet", async () => {
		const { child } = await startChild();
		await expect(route(child)).resolves.toMatchObject({ model: { provider: "spike-a" } });
	});

	it.each([undefined, "strict-priority", "remaining-balanced"] as const)(
		"keeps routing the parent after rebinding child disposal (%s)",
		async (kind) => {
			const { scenario, child } = await startChild(kind);
			await child.session.bindExtensions({ mode: "rpc" });
			child.session.dispose();
			scenario.providers[0].setResponses([fauxAssistantMessage("routed")]);
			const [message] = await prompt(scenario);
			expect(message).toMatchObject({ provider: "spike-a", stopReason: "stop" });
			expect(message?.errorMessage).toBeUndefined();
		},
	);
});
