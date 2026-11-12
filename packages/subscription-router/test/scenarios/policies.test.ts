/** New policies traverse real Pi prompts, tool continuations, retry and settle recovery. */
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-coding-agent/testing";
import { Type } from "typebox";
import { afterEach, expect, it } from "vitest";
import type { PolicyV1 } from "../../src/policy.js";
import { STALE_GRACE_MS } from "../../src/selection.js";
import { CachedUsage, Clock, prompt, type RouterScenario, startRouter } from "./support.js";

let scenario: RouterScenario | undefined;
afterEach(() => scenario?.cleanup());
const remaining: PolicyV1 = { version: 1, kind: "remaining-balanced" };

it.each(["strict-priority", "remaining-balanced"] as const)(
	"%s handles A recovery during B's actual tool continuation",
	async (kind) => {
		const usage = new CachedUsage(new Clock());
		usage.set("spike-a", 100);
		usage.set("spike-b", 10);
		usage.set("spike-c", 90);
		scenario = await startRouter(usage, { version: 1, kind }, [
			(pi) => {
				pi.registerTool({
					name: "recover",
					label: "Recover",
					description: "Recover cached A",
					parameters: Type.Object({}),
					execute: async () => {
						usage.set("spike-a", 0);
						usage.set("spike-b", 95);
						return { content: [{ type: "text", text: "recovered" }], details: undefined };
					},
				});
			},
		]);
		scenario.providers[0].setResponses([fauxAssistantMessage("A recovered")]);
		scenario.providers[1].setResponses([
			fauxAssistantMessage(fauxToolCall("recover", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("sticky B"),
		]);
		expect((await prompt(scenario)).map((m) => m.provider)).toEqual([
			"spike-b",
			kind === "strict-priority" ? "spike-a" : "spike-b",
		]);
		expect(usage.reads).toEqual([]);
		await scenario.harness.session.prompt("/router explain spike --json");
		const explanation = JSON.parse(scenario.notifications.at(-1) ?? "null");
		expect(explanation).toMatchObject({
			forecast: true,
			previous: null,
			chosen: "spike-a/sonnet-a",
			caller: "unknown",
		});
		expect(explanation.members).toHaveLength(3);
		expect(usage.reads).toEqual([]);
	},
);

it("raw remaining diverges from reset-aware legacy, applies family caps and uses old/missing fallback", async () => {
	const usage = new CachedUsage(new Clock());
	usage.set("spike-a", 60);
	usage.set("spike-b", 20);
	usage.set("spike-c", 90);
	const a = usage.peek("spike-a");
	if (!a?.windows[0]) throw new Error("missing fixture");
	a.windows[0].resetAt = usage.clock.now() + 360_000;
	scenario = await startRouter(usage, remaining);
	for (const p of scenario.providers) p.setResponses(Array.from({ length: 5 }, () => fauxAssistantMessage("answer")));
	expect((await prompt(scenario)).map((m) => m.provider)).toEqual(["spike-b"]);
	const b = usage.peek("spike-b");
	if (!b) throw new Error("missing fixture");
	b.windows.push({ name: "family-cap", scope: "model", families: ["terra"], usedPercent: 99 });
	expect((await prompt(scenario)).map((m) => m.provider)).toEqual(["spike-a"]);
	usage.set("spike-a", 1, "stale", STALE_GRACE_MS + 1);
	usage.snapshots.delete("spike-c");
	expect((await prompt(scenario)).map((m) => m.provider)).toEqual(["spike-b"]);
	usage.set("spike-b", 100);
	expect((await prompt(scenario)).map((m) => m.provider)).toEqual(["spike-a"]);
	// Explain stays cached and excludes provider error text/balances.
	usage.reads.length = 0;
	await scenario.harness.session.prompt("/router explain spike");
	expect(scenario.notifications.at(-1)).toContain("Cached fresh-dispatch forecast");
	expect(usage.reads).toEqual([]);
});

it.each(["retry", "terminal"] as const)(
	"confirmed empty-output %s switches within the requested profile",
	async (failure) => {
		const usage = new CachedUsage(new Clock());
		for (const provider of ["spike-a", "spike-b", "spike-c"]) usage.set(provider, 0);
		usage.onRefresh = (provider) => usage.set(provider, 100);
		scenario = await startRouter(usage, remaining);
		scenario.providers[0].setResponses([
			fauxAssistantMessage([], {
				stopReason: "error",
				errorMessage: failure === "retry" ? "429" : "insufficient_quota",
				timestamp: usage.clock.now(),
			}),
		]);
		scenario.providers[1].setResponses([fauxAssistantMessage("B answered")]);
		expect((await prompt(scenario)).map((m) => m.provider)).toEqual(["spike-a", "spike-b"]);
		expect(usage.reads.map((read) => read.provider)).toEqual(["spike-a"]);
	},
);

it("new policy trace records unconfirmed retry affinity and fallback scores without raw errors", async () => {
	const usage = new CachedUsage(new Clock());
	for (const provider of ["spike-a", "spike-b", "spike-c"]) usage.set(provider, 0);
	scenario = await startRouter(usage, { version: 1, kind: "strict-priority" });
	scenario.providers[0].setResponses([
		fauxAssistantMessage([], { stopReason: "error", errorMessage: "429", timestamp: usage.clock.now() }),
		fauxAssistantMessage("same model"),
	]);
	expect((await prompt(scenario)).map((m) => m.provider)).toEqual(["spike-a", "spike-a"]);
	await scenario.harness.session.prompt("/router status");
	expect(scenario.notifications.at(-1)).toContain("retry -> spike-a/sonnet-a (strict-priority)");
});

it.each(["retry", "terminal"] as const)("partial-output %s still refuses cross-provider replay", async (failure) => {
	const usage = new CachedUsage(new Clock());
	for (const provider of ["spike-a", "spike-b", "spike-c"]) usage.set(provider, 0);
	usage.onRefresh = (provider) => usage.set(provider, 100);
	scenario = await startRouter(usage, remaining);
	scenario.providers[0].setResponses([
		fauxAssistantMessage("already emitted", {
			stopReason: "error",
			errorMessage: failure === "retry" ? "429" : "insufficient_quota",
			timestamp: usage.clock.now(),
		}),
	]);
	await prompt(scenario);
	expect(scenario.providers[1].state.callCount).toBe(0);
	expect(scenario.providers[2].state.callCount).toBe(0);
});
