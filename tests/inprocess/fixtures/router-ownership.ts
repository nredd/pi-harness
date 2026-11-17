/** Concurrent real children share quota evidence, never selection epochs or recovery commitments. */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage } from "@earendil-works/pi-coding-agent/testing";
import { deferred } from "@nredd/pi-test-lib/deferred";
import { toolCalls } from "@nredd/pi-test-lib/faux";
import { expect } from "vitest";
import { answer, ScenarioSession, spawn } from "../../../packages/subagents/tests/fixtures/scenario-session.ts";
import { ExhaustionTracker } from "../../../packages/subscription-router/src/exhaustion.ts";
import {
	createSubscriptionRouter,
	type SubscriptionRouterOptions,
} from "../../../packages/subscription-router/src/index.ts";
import { CachedUsage, Clock } from "../../../packages/subscription-router/tests/fixtures/router.ts";

/** Invalidate one real child's pending confirmation without disturbing its sibling. */
export async function verifyConcurrentChildren(change: "pin" | "abort"): Promise<void> {
	const fixture = new ScenarioSession();
	const clock = new Clock();
	const usage = new CachedUsage(clock);
	usage.set("concurrent-a", 0);
	usage.set("concurrent-b", 0);
	const entered = deferred();
	const release = deferred();
	let waiting = 0;
	usage.onRefresh = async (provider) => {
		if (++waiting === 2) entered.resolve();
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
						{ provider: "concurrent-a", id: "first" },
						{ provider: "concurrent-b", id: "second" },
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
			extensions: [fileURLToPath(new URL("./tier-router.ts", import.meta.url))],
		}),
	);
	const a = fixture.physical(
		"concurrent-a",
		"first",
		Array.from({ length: 2 }, () =>
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "insufficient_quota", timestamp: clock.now() }),
		),
	);
	const b = fixture.physical("concurrent-b", "second", [answer("SIBLING RECOVERED")]);
	const h = await fixture.start({ noRouter: true, factories: [createSubscriptionRouter(options)] });
	h.setResponses([
		toolCalls(spawn("pin this child", { model: "router/deep" }), spawn("recover this child", { model: "router/deep" })),
		answer("SPAWNED"),
		answer("NOTED"),
		answer("NOTED"),
	]);
	await h.session.prompt("start two children");
	await entered.promise;
	const ids = h.session.messages.flatMap((message) =>
		message.role === "toolResult" && message.toolName === "Agent"
			? message.content.flatMap((part) => (part.type === "text" ? [part.text.match(/Agent ID: (\S+)/)?.[1]] : []))
			: [],
	);
	const [first, second] = ids;
	if (!first || !second) throw new Error("Missing concurrent children");
	const pinned = fixture.record(first);
	const sibling = fixture.record(second);
	const pinSession = pinned.session;
	const siblingSession = sibling.session;
	if (!pinSession || !siblingSession) throw new Error("Missing live child session");
	try {
		const cancellation = change === "abort" ? pinSession.abort() : pinSession.setModel(b.getModel());
		if (change === "pin") await cancellation;
		release.resolve();
		await Promise.all([pinned.promise, sibling.promise, cancellation]);
		expect([a.state.callCount, b.state.callCount]).toEqual([2, 1]);
		expect(pinned.session).toBe(pinSession);
		expect(sibling.session).toBe(siblingSession);
		expect(["error", "stopped"]).toContain(pinned.status);
		expect(sibling).toMatchObject({ status: "completed", result: "SIBLING RECOVERED" });
		expect(pinSession.sessionManager.getBranch().filter((entry) => entry.type === "context_edit")).toHaveLength(0);
		expect(siblingSession.sessionManager.getBranch().filter((entry) => entry.type === "context_edit")).toHaveLength(1);
		expect(tracker.active()).toMatchObject([{ provider: "concurrent-a" }]);
	} finally {
		release.resolve();
		await fixture.dispose();
		Reflect.deleteProperty(globalThis, Symbol.for("pi-harness:tier-router"));
		Reflect.deleteProperty(globalThis, Symbol.for("pi-subagents:manager"));
	}
}
