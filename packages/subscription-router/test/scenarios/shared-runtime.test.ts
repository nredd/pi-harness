/**
 * #294: a child session shares its parent's model runtime and re-registers `router/*` into
 * it, so the registered route belongs to the last session that loaded. Real sessions on one
 * real runtime; only quota is a double.
 */
import { createHarness, fauxAssistantMessage, type Harness } from "@earendil-works/pi-coding-agent/testing";
import { afterEach, describe, expect, it } from "vitest";
import { createSubscriptionRouter } from "../../src/index.js";
import { CachedUsage, Clock, prompt, type RouterScenario, startRouter } from "./support.js";

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
	async function startChild() {
		const clock = new Clock();
		const usage = new CachedUsage(clock);
		usage.set("spike-a", 0);
		scenario = await startRouter(usage);
		const child = await createHarness({
			modelRuntime: scenario.harness.session.modelRuntime,
			useModelRuntimeStream: true,
			extensionFactories: [
				createSubscriptionRouter({
					config: { ok: true, profiles: [PROFILE] },
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

	it("routes through a child that has not started yet", async () => {
		const { child } = await startChild();
		await expect(route(child)).resolves.toMatchObject({ model: { provider: "spike-a" } });
	});

	it("keeps routing the parent after the child that rebound the route is disposed", async () => {
		const { scenario, child } = await startChild();
		await child.session.bindExtensions({ mode: "rpc" });
		child.session.dispose();
		scenario.providers[0].setResponses([fauxAssistantMessage("routed")]);
		const [message] = await prompt(scenario);
		expect(message).toMatchObject({ provider: "spike-a", stopReason: "stop" });
		expect(message?.errorMessage).toBeUndefined();
	});
});
