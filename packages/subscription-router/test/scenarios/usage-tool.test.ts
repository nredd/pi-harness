/** Execute the registered tool via real Pi dispatch, with only a synthetic usage transport. */
import {
	createHarness,
	fauxAssistantMessage,
	fauxToolCall,
	getToolResult,
	type Harness,
} from "@earendil-works/pi-coding-agent/testing";
import { afterEach, describe, expect, it } from "vitest";
import { createSubscriptionRouter } from "../../src/index.js";
import { UsageService } from "../../src/usage.js";

const PRIVATE = "synthetic-private-token-and-response";
const T0 = 1_700_000_000_000;

describe("subscription_usage tool", () => {
	let harness: Harness | undefined;
	afterEach(() => harness?.cleanup());

	it("cancels the tool caller without cancelling another caller's shared read", async () => {
		let announce!: () => void;
		const started = new Promise<void>((resolve) => {
			announce = resolve;
		});
		let release!: (value: Response) => void;
		const response = new Promise<Response>((resolve) => {
			release = resolve;
		});
		let requestSignal: AbortSignal | null | undefined;
		const usage = new UsageService({
			now: () => T0,
			getAccessToken: async () => PRIVATE,
			fetch: async (_url, init) => {
				requestSignal = init.signal;
				announce();
				return response;
			},
		});
		harness = await createHarness({
			extensionFactories: [createSubscriptionRouter({ config: { ok: true, profiles: [] }, usage })],
		});
		await harness.session.bindExtensions({ mode: "rpc" });
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("subscription_usage", { provider: "anthropic" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("must not continue"),
		]);
		const running = harness.session.prompt("inspect synthetic usage");
		await started;
		const other = usage.get({} as never, "anthropic");
		await harness.session.abort();
		await running;
		expect(requestSignal?.aborted).toBe(false);
		// Core invokes the continuation stream with an already-aborted signal;
		// the faux transport records that invocation but emits no answer tokens.
		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "aborted" });
		expect(
			harness.eventsOfType("message_update").filter((event) => event.assistantMessageEvent.type === "text_delta"),
		).toEqual([]);
		expect(JSON.stringify(getToolResult(harness, "subscription_usage"))).not.toContain(PRIVATE);
		release(new Response(JSON.stringify({ five_hour: { utilization: 42 } })));
		expect((await other).windows[0]?.usedPercent).toBe(42);
	});

	it.each(["malformed", "unavailable", "lookup-failure", "http-failure", "stale", "invalid-reset"])(
		"returns safe structured data for %s",
		async (mode) => {
			let now = T0;
			let requests = 0;
			const usage = new UsageService({
				now: () => now,
				getAccessToken: async () => {
					if (mode === "lookup-failure") throw new Error(PRIVATE);
					return mode === "unavailable" ? undefined : PRIVATE;
				},
				fetch: async () => {
					requests++;
					if (mode === "http-failure" || (mode === "stale" && requests > 1))
						return new Response(PRIVATE, { status: 401 });
					return new Response(
						JSON.stringify(
							mode === "malformed"
								? { secret: PRIVATE }
								: {
										five_hour: { utilization: 100, resets_at: mode === "invalid-reset" ? 1e100 : T0 / 1000 + 3600 },
										secret: PRIVATE,
									},
						),
					);
				},
			});
			if (mode === "stale") {
				await usage.get({} as never, "anthropic");
				now += 300_000;
			}
			harness = await createHarness({
				extensionFactories: [createSubscriptionRouter({ config: { ok: true, profiles: [] }, usage, now: () => now })],
			});
			await harness.session.bindExtensions({ mode: "rpc" });
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("subscription_usage", { provider: "anthropic", refresh: true }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("done"),
			]);
			await harness.session.prompt("inspect synthetic usage");
			const result = getToolResult(harness, "subscription_usage");
			expect(result.isError).toBe(false);
			expect(JSON.stringify(result)).not.toContain(PRIVATE);
			const statuses = {
				malformed: "error",
				unavailable: "unavailable",
				"lookup-failure": "error",
				"http-failure": "error",
				stale: "stale",
				"invalid-reset": "available",
			};
			expect(result.details).toMatchObject({
				snapshots: [{ provider: "anthropic", status: statuses[mode as keyof typeof statuses] }],
				blocks: [],
			});
			if (mode === "invalid-reset") {
				expect(usage.decisionFor({ provider: "anthropic", id: "sonnet" })).toMatchObject({
					block: true,
					resetAt: undefined,
				});
				expect(usage.formatForPrompt(usage.peek("anthropic"))).toBe("five_hour exhausted, reset unknown");
			}
			expect(harness.eventsOfType("tool_execution_end")).toHaveLength(1);
		},
	);
});
