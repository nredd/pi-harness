/** Same-agent failover through the real Agent tool, routed tier and disk-loaded child router. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-coding-agent/testing";
import { deferred } from "@nredd/pi-test-lib/deferred";
import { toolCalls } from "@nredd/pi-test-lib/faux";
import { afterEach, expect, it } from "vitest";
import { answer, ScenarioSession, spawn } from "../../packages/subagents/tests/fixtures/scenario-session.ts";
import { ExhaustionTracker } from "../../packages/subscription-router/src/exhaustion.ts";
import {
	createSubscriptionRouter,
	type SubscriptionRouterOptions,
} from "../../packages/subscription-router/src/index.ts";
import { CachedUsage, Clock } from "../../packages/subscription-router/tests/fixtures/router.ts";

let fixture: ScenarioSession | undefined;
afterEach(async () => {
	await fixture?.dispose();
	Reflect.deleteProperty(globalThis, Symbol.for("pi-harness:tier-router"));
	Reflect.deleteProperty(globalThis, Symbol.for("pi-subagents:manager"));
	Reflect.deleteProperty(globalThis, "__routerMutation");
});

it("a routed @deep child mutates once and retains its result and identity when A exhausts and B answers", async () => {
	fixture = new ScenarioSession({
		modelTiers: { deep: ["router/deep"] },
		modelResolution: { onUnmapped: "error", onUnavailable: "error" },
	});
	const clock = new Clock();
	const usage = new CachedUsage(clock);
	usage.set("child-a", 0);
	usage.set("child-b", 0);
	const entered = deferred();
	const release = deferred();
	usage.onRefresh = async (provider) => {
		entered.resolve();
		await release.promise;
		usage.set(provider, 100);
	};
	const tracker = new ExhaustionTracker(clock.now);
	const options: SubscriptionRouterOptions = {
		config: {
			ok: true,
			profiles: [
				{
					id: "deep",
					name: "Deep",
					chain: [
						{ provider: "child-a", id: "first" },
						{ provider: "child-b", id: "second", thinking: "high" },
					],
				},
			],
		},
		usage,
		tracker,
		now: clock.now,
	};
	Reflect.set(globalThis, Symbol.for("pi-harness:tier-router"), options);
	writeFileSync(
		join(fixture.agentDir, "settings.json"),
		JSON.stringify({
			extensions: [fileURLToPath(new URL("./fixtures/tier-router.ts", import.meta.url))],
		}),
	);
	const target = join(fixture.root, "mutation.txt");
	let effects = 0;
	Reflect.set(globalThis, "__routerMutation", async () => {
		effects++;
		writeFileSync(target, `effect-${effects}`);
		return { content: [{ type: "text", text: "retained-mutation-result" }], details: undefined };
	});
	const extensions = join(fixture.cwd, ".pi", "extensions");
	mkdirSync(extensions, { recursive: true });
	writeFileSync(
		join(extensions, "mutate.ts"),
		'export default pi => pi.registerTool({ name: "mutate", label: "mutate", description: "Mutate a disposable file", parameters: { type: "object", properties: {} }, execute: globalThis.__routerMutation });\n',
	);
	const a = fixture.physical("child-a", "first", [
		fauxAssistantMessage(fauxToolCall("mutate", {}), { stopReason: "toolUse" }),
		fauxAssistantMessage("", { stopReason: "error", errorMessage: "insufficient_quota", timestamp: clock.now() }),
	]);
	const b = fixture.physical(
		"child-b",
		"second",
		[
			(context) => {
				expect(context.messages).toContainEqual(
					expect.objectContaining({
						role: "toolResult",
						toolName: "mutate",
						content: [{ type: "text", text: "retained-mutation-result" }],
					}),
				);
				return answer("B retained the result");
			},
		],
		true,
	);
	const h = await fixture.start({ noRouter: true, factories: [createSubscriptionRouter(options)] });
	h.setResponses([toolCalls(spawn("routed child", { model: "@deep" })), answer("SPAWNED"), answer("NOTED")]);
	await h.session.prompt("start one routed child");
	await entered.promise;
	const result = h.session.messages.find((message) => message.role === "toolResult" && message.toolName === "Agent");
	const id =
		result?.role === "toolResult"
			? result.content.find((part) => part.type === "text")?.text.match(/Agent ID: (\S+)/)?.[1]
			: undefined;
	if (!id) throw new Error("Missing real child ID");
	const record = fixture.record(id);
	const session = record.session;
	if (!session) throw new Error("Missing active child session");
	const sessionId = session.sessionId;
	const active = session.getActiveToolNames();
	expect(active).toContain("mutate");
	try {
		release.resolve();
		await record.promise;
		expect(fixture.record(id)).toBe(record);
		expect(record.session).toBe(session);
		expect(session.sessionId).toBe(sessionId);
		expect(session.model).toMatchObject({ provider: "router", id: "deep" });
		expect(session.getActiveToolNames()).toEqual(active);
		expect(record).toMatchObject({
			status: "completed",
			result: "B retained the result",
			invocation: { modelId: "child-b/second", thinking: "high" },
		});
		expect(effects).toBe(1);
		expect(readFileSync(target, "utf8")).toBe("effect-1");
		expect([a.state.callCount, b.state.callCount]).toEqual([2, 1]);
		expect(session.messages.at(-1)).toMatchObject({
			role: "assistant",
			provider: "child-b",
			model: "second",
			thinkingLevel: "high",
		});
		expect(session.sessionManager.getBranch().filter((entry) => entry.type === "model_change")).toHaveLength(1);
	} finally {
		release.resolve();
	}
});
