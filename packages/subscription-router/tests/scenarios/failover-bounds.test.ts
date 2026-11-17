/** Failure transparency and finite recovery through real router/model-runtime boundaries. */
import { fauxAssistantMessage, fauxThinking, fauxToolCall } from "@earendil-works/pi-coding-agent/testing";
import { afterEach, expect, it } from "vitest";
import { CachedUsage, Clock, prompt, type RouterScenario, startRouter } from "../fixtures/router.ts";

let scenario: RouterScenario | undefined;
afterEach(() => scenario?.cleanup());

it.each([
	"invalid_api_key",
	"permission denied",
	"model_not_found",
	"billing account disabled",
	"network unreachable",
	"overloaded_error",
])("does not treat %s as subscription exhaustion without independent evidence", async (errorMessage) => {
	const clock = new Clock();
	const usage = new CachedUsage(clock);
	usage.set("spike-a", 0);
	usage.set("spike-b", 0);
	scenario = await startRouter(usage);
	scenario.providers[0].setResponses(
		Array.from({ length: 8 }, () =>
			fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage,
				timestamp: clock.now(),
			}),
		),
	);
	await prompt(scenario);
	expect(scenario.providers[1].state.callCount).toBe(0);
	expect(scenario.providers[0].state.callCount).toBeLessThanOrEqual(4);
	expect(usage.reads).toHaveLength(errorMessage.includes("billing") ? 1 : 0);
	expect(scenario.tracker.active()).toEqual([]);
});

for (const errorMessage of ["insufficient_quota", "429 Too Many Requests: rate_limit_error"]) {
	it.each([
		[{ type: "text" as const, text: "visible" }],
		[fauxThinking("visible reasoning")],
		[fauxToolCall("uncertain_mutation", {})],
	])(`never transparently replays partial output %j after ${errorMessage}`, async (content) => {
		const clock = new Clock();
		const usage = new CachedUsage(clock);
		usage.set("spike-a", 0);
		usage.set("spike-b", 0);
		usage.onRefresh = (provider) => usage.set(provider, 100);
		scenario = await startRouter(usage);
		scenario.providers[0].setResponses([
			fauxAssistantMessage(content, {
				stopReason: "error",
				errorMessage,
				timestamp: clock.now(),
			}),
		]);
		await prompt(scenario);
		expect(scenario.providers.map((provider) => provider.state.callCount)).toEqual([1, 0, 0]);
		expect(scenario.harness.eventsOfType("tool_execution_start")).toEqual([]);
		expect(scenario.notifications).toEqual([]);
	});
}

it("an already-running exhausted profile settles with error, not a parked or scheduled replacement", async () => {
	const clock = new Clock();
	const usage = new CachedUsage(clock);
	usage.set("spike-a", 0);
	usage.set("spike-b", 0);
	usage.onRefresh = (provider) => usage.set(provider, 100);
	scenario = await startRouter(usage);
	for (const provider of scenario.providers.slice(0, 2))
		provider.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "insufficient_quota", timestamp: clock.now() }),
		]);
	const session = scenario.harness.session;
	const messages = await prompt(scenario);
	expect(scenario.harness.session).toBe(session);
	expect(messages.at(-1)).toMatchObject({ stopReason: "error" });
	expect(scenario.providers.map((provider) => provider.state.callCount)).toEqual([1, 1, 0]);
	expect(scenario.notifications.at(-1)).toContain("exhausted");
	expect(session.isStreaming).toBe(false);
	expect(session.sessionManager.getBranch().filter((entry) => entry.type === "context_edit")).toHaveLength(1);
});

it("changing quota evidence and physical destinations never resets terminal recovery budgets", async () => {
	const clock = new Clock();
	const usage = new CachedUsage(clock);
	usage.set("spike-a", 0);
	usage.set("spike-b", 0);
	scenario = await startRouter(usage);
	const tracker = scenario.tracker;
	usage.onRefresh = (provider) => {
		tracker.clear();
		usage.set("spike-a", 0);
		usage.set("spike-b", 0);
		usage.set(provider, 100);
	};
	for (const provider of scenario.providers.slice(0, 2))
		provider.setResponses(
			Array.from({ length: 8 }, () =>
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "insufficient_quota", timestamp: clock.now() }),
			),
		);
	const messages = await prompt(scenario);
	expect(scenario.providers.map((provider) => provider.state.callCount)).toEqual([2, 1, 0]);
	expect(messages.at(-1)).toMatchObject({ provider: "spike-a", stopReason: "error" });
	expect(usage.reads).toHaveLength(2);
	expect(scenario.notifications).toHaveLength(2);
	expect(scenario.harness.eventsOfType("auto_retry_start")).toEqual([]);
});
