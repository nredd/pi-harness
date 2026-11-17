/** Physical destination limits stay core-owned when terminal recovery changes provider. */
import { fauxAssistantMessage } from "@earendil-works/pi-coding-agent/testing";
import { afterEach, expect, it } from "vitest";
import { CachedUsage, Clock, type RouterScenario, startRouter } from "../fixtures/router.ts";

let scenario: RouterScenario | undefined;
afterEach(() => scenario?.cleanup());

it("retains complete input and fails explicitly when destination overflow cannot be compacted", async () => {
	const clock = new Clock();
	const usage = new CachedUsage(clock);
	usage.set("spike-a", 0);
	usage.set("spike-b", 0);
	usage.onRefresh = (provider) => usage.set(provider, 100);
	let compactions = 0;
	scenario = await startRouter(
		usage,
		"ordered",
		[
			(pi) => {
				pi.on("session_before_compact", () => {
					compactions++;
					return { cancel: true };
				});
			},
		],
		{ compaction: { enabled: true, reserveTokens: 0, keepRecentTokens: 1 } },
	);
	const [a, b] = scenario.providers;
	const model = b.getModel();
	scenario.harness.session.modelRuntime.registerProvider(model.provider, {
		apiKey: "faux",
		api: b.api,
		baseUrl: model.baseUrl,
		models: [{ ...model, contextWindow: 512, maxTokens: 64 }],
	});
	a.setResponses([
		fauxAssistantMessage("", {
			stopReason: "error",
			errorMessage: "insufficient_quota",
			timestamp: clock.now(),
		}),
	]);
	const original = "retain-this-input ".repeat(1000);
	b.setResponses([
		(context) => {
			expect(context.messages).toContainEqual(
				expect.objectContaining({
					role: "user",
					content: [{ type: "text", text: original }],
				}),
			);
			return fauxAssistantMessage("", { stopReason: "error", errorMessage: "prompt is too long" });
		},
	]);
	await scenario.harness.session.prompt(original);
	expect(compactions).toBe(2);
	expect([a.state.callCount, b.state.callCount]).toEqual([1, 1]);
	expect(scenario.harness.eventsOfType("message_end").at(-1)?.message).toMatchObject({
		role: "assistant",
		stopReason: "error",
		errorMessage: "prompt is too long",
	});
	expect(scenario.harness.session.isStreaming).toBe(false);
	expect(scenario.harness.session.messages).toContainEqual(
		expect.objectContaining({
			role: "user",
			content: [{ type: "text", text: original }],
		}),
	);
	expect(scenario.harness.session.model).toMatchObject({ provider: "router", id: "spike" });
});
