/** Source-fixture physical dispatch arrays, now driven in-process rather than via the RPC CLI. */
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-coding-agent/testing";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { STALE_GRACE_MS } from "../../src/selection.js";
import { CachedUsage, Clock, prompt, type RouterScenario, startRouter } from "./support.js";

describe("balanced router through a real session", () => {
	let scenario: RouterScenario | undefined;
	afterEach(() => scenario?.cleanup());

	/** Source defaults are A/B/C 80/60/20 used; the real tool changes cached quota mid-turn. */
	async function setup(changeQuota: (usage: CachedUsage) => void = () => {}) {
		const usage = new CachedUsage(new Clock());
		usage.set("spike-a", 80);
		usage.set("spike-b", 60);
		usage.set("spike-c", 20);
		scenario = await startRouter(usage, "balanced", [
			(pi) => {
				pi.registerTool({
					name: "change_quota",
					label: "Change quota",
					description: "Change cached quota mid-turn",
					parameters: Type.Object({}),
					execute: async () => {
						changeQuota(usage);
						return { content: [{ type: "text", text: "quota changed" }], details: undefined };
					},
				});
			},
		]);
		for (const provider of scenario.providers)
			provider.setResponses(
				Array.from({ length: 10 }, () => fauxAssistantMessage(`ANSWER ${provider.getModel().provider}`)),
			);
		return { scenario, usage };
	}

	/** Assert every completion, including errors, and keep the selected model virtual. */
	async function dispatched(current: RouterScenario): Promise<string[]> {
		const messages = await prompt(current);
		for (const message of messages) expect(message.stopReason, message.errorMessage).not.toBe("error");
		expect(current.harness.session.model).toMatchObject({ provider: "router", id: "spike" });
		return messages.map((message) => message.provider);
	}

	/** Force exactly one physical tool turn, then answer on every later request. */
	function callQuotaTool(current: RouterScenario, index: number): void {
		const provider = current.providers[index];
		if (!provider) throw new Error(`Missing physical provider ${index}`);
		provider.setResponses([
			fauxAssistantMessage(fauxToolCall("change_quota", {}), { stopReason: "toolUse" }),
			...Array.from({ length: 9 }, () => fauxAssistantMessage(`ANSWER ${provider.getModel().provider}`)),
		]);
	}

	/** A quota-changing tool must actually have executed, not merely appeared in the faux transcript. */
	function changed(current: RouterScenario): void {
		expect(current.harness.eventsOfType("tool_execution_end")).toMatchObject([
			{ toolName: "change_quota", isError: false, result: { content: [{ type: "text", text: "quota changed" }] } },
		]);
	}

	it("balanced route picks C across three providers", async () => {
		const { scenario, usage } = await setup();
		expect(await dispatched(scenario)).toEqual(["spike-c"]);
		expect(usage.reads).toEqual([]);
	});

	it("balanced prompt hysteresis is strictly above twenty percent", async () => {
		const { scenario, usage } = await setup();
		const turns: string[][] = [];
		for (const used of [70, 40, 30]) {
			usage.set("spike-a", 50);
			usage.set("spike-b", used);
			usage.set("spike-c", 95);
			turns.push(await dispatched(scenario));
		}
		expect(turns).toEqual([["spike-a"], ["spike-a"], ["spike-b"]]);
		expect(usage.reads).toEqual([]);
	});

	it("balanced continuation stays sticky on C", async () => {
		const { scenario, usage } = await setup((usage) => {
			usage.set("spike-a", 0);
			usage.set("spike-c", 99);
		});
		callQuotaTool(scenario, 2);
		expect(await dispatched(scenario)).toEqual(["spike-c", "spike-c"]);
		changed(scenario);
		expect(usage.reads).toEqual([]);
	});

	it("blocked continuation leaves C for A", async () => {
		const { scenario, usage } = await setup((usage) => {
			usage.set("spike-a", 0);
			usage.set("spike-c", 100);
		});
		callQuotaTool(scenario, 2);
		expect(await dispatched(scenario)).toEqual(["spike-c", "spike-a"]);
		changed(scenario);
		expect(usage.reads).toEqual([]);
	});

	it("recently stale A (1% used) beats fresh measured B (60% used)", async () => {
		const { scenario, usage } = await setup();
		usage.set("spike-a", 1, "stale", 6 * 60_000);
		usage.snapshots.delete("spike-c");
		expect(await dispatched(scenario)).toEqual(["spike-a"]);
		expect(usage.reads).toEqual([]);
	});

	it("long-expired stale A is fallback and fresh measured B wins", async () => {
		const { scenario, usage } = await setup();
		usage.set("spike-a", 1, "stale", STALE_GRACE_MS + 1);
		usage.snapshots.delete("spike-c");
		expect(await dispatched(scenario)).toEqual(["spike-b"]);
		expect(usage.reads).toEqual([]);
	});

	it("unmeasured fallback remains usable after B exhausts", async () => {
		const { scenario, usage } = await setup((usage) => usage.set("spike-b", 100));
		usage.set("spike-a", 1, "stale", STALE_GRACE_MS + 1);
		usage.snapshots.delete("spike-c");
		callQuotaTool(scenario, 1);
		expect(await dispatched(scenario)).toEqual(["spike-b", "spike-a"]);
		changed(scenario);
		expect(usage.peek("spike-a")?.status).toBe("stale");
		expect(usage.peek("spike-c")).toBeUndefined();
		expect(usage.reads).toEqual([]);
	});
});
