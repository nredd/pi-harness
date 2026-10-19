/** Quota settlement/retry competes with goal continuation in the actual router/kit stack. */
import { fauxAssistantMessage } from "@earendil-works/pi-coding-agent/testing";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { GoalStack, goalStates, nudges, spoken, tool } from "./goal-support.ts";

const QUOTA = "insufficient_quota: You exceeded your current quota";
const RETRY = "429 Too Many Requests: rate_limit_error";
const CHAIN = [
	{ provider: "spike-a", id: "sonnet-a" },
	{ provider: "spike-b", id: "terra-b" },
];

describe("router quota and goal settlement", () => {
	let stack: GoalStack;
	afterEach(async () => {
		await stack?.cleanup();
	});

	/** Register physical scripted providers in the real runtime, preserving router dispatch. */
	async function start(kitFirst = false, exhausted = false) {
		stack = new GoalStack();
		const providers = stack.registerPhysical(CHAIN);
		stack.usage.onRefresh = (provider) => {
			if (provider === "spike-a") stack.usage.set(provider, 100);
		};
		const kit = stack.kit();
		const router = stack.router(exhausted ? CHAIN.slice(0, 1) : CHAIN, {
			exhaustion: { policy: exhausted ? "fail" : "wait" },
		});
		const h = await stack.start(
			[
				(pi) => {
					pi.registerTool({
						name: "probe",
						label: "Probe",
						description: "Exercise a tool turn before quota failure",
						parameters: Type.Object({}),
						execute: async () => ({ content: [{ type: "text", text: "tool-ran" }], details: undefined }),
					});
				},
				...(kitFirst ? [kit, router] : [router, kit]),
			],
			{
				useModelRuntimeStream: true,
				settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 0 }, compaction: { enabled: false } },
			},
		);
		const model = h.session.modelRuntime.getModel("router", "spike");
		if (!model) throw new Error("Missing real router/spike model");
		await h.session.setModel(model);
		const a = providers[0];
		const b = providers[1];
		if (!a || !b) throw new Error("Missing physical providers");
		return { h, a, b };
	}

	for (const kitFirst of [false, true]) {
		it(`exhausted chain pauses goal without spin in either order (${kitFirst ? "kit-first" : "router-first"})`, async () => {
			const { h, a, b } = await start(kitFirst, true);
			a.setResponses([
				tool("probe", {}),
				...Array.from({ length: 8 }, () =>
					fauxAssistantMessage("", { stopReason: "error", errorMessage: QUOTA, timestamp: stack.clock.now() }),
				),
			]);
			await h.session.prompt("/goal finish quota work --turns 10");
			await h.session.prompt("go");
			const messages = h
				.eventsOfType("message_end")
				.flatMap((e) => (e.message.role === "assistant" ? [e.message] : []));
			expect(messages.map((m) => m.provider)).toEqual(["spike-a", "spike-a"]);
			expect(messages.at(-1)?.errorMessage).toBe(QUOTA);
			expect(a.state.callCount).toBe(2);
			expect(b.state.callCount).toBe(0);
			expect(stack.usage.reads).toMatchObject([
				{ provider: "spike-a", options: { fresh: true, notBefore: stack.clock.now() } },
			]);
			expect(stack.usage.peek("spike-a")?.windows[0]?.usedPercent).toBe(100);
			expect(h.eventsOfType("agent_settled")).toHaveLength(1);
			expect(nudges(h)).toEqual([]);
			expect(goalStates(h).at(-1)).toMatchObject({ status: "paused", reason: "provider error", turns: 2 });
		});
	}

	for (const errorMessage of [QUOTA, RETRY]) {
		it(`router owns terminal and retry recovery before goal (${errorMessage === RETRY ? "retry" : "terminal"})`, async () => {
			const { h, a, b } = await start();
			a.setResponses([
				tool("probe", {}),
				...Array.from({ length: 8 }, () =>
					fauxAssistantMessage("", { stopReason: "error", errorMessage, timestamp: stack.clock.now() }),
				),
			]);
			const users: number[] = [];
			b.setResponses(
				Array.from({ length: 4 }, () => (ctx) => {
					users.push(ctx.messages.filter((m) => m.role === "user").length);
					return fauxAssistantMessage("RECOVERED on spike-b/terra-b");
				}),
			);
			await h.session.prompt("/goal finish quota work --turns 4");
			await h.session.prompt("go");
			const messages = h
				.eventsOfType("message_end")
				.flatMap((e) => (e.message.role === "assistant" ? [e.message] : []));
			expect(messages.map((m) => m.provider)).toEqual(["spike-a", "spike-a", "spike-b", "spike-b"]);
			expect(messages[1]?.errorMessage).toBe(errorMessage);
			expect(stack.usage.reads).toMatchObject([{ provider: "spike-a", options: { fresh: true } }]);
			expect(stack.usage.peek("spike-a")?.windows[0]?.usedPercent).toBe(100);
			expect(h.eventsOfType("auto_retry_start")).toHaveLength(errorMessage === RETRY ? 1 : 0);
			expect(users).toEqual([1, 2]);
			expect(nudges(h)).toHaveLength(1);
			expect(goalStates(h).at(-1)).toMatchObject({ status: "budget", turns: 4 });
			expect(a.state.callCount).toBe(2);
			expect(b.state.callCount).toBe(2);
		});
	}

	it("bound loop and goal remain paused after exhaustion", async () => {
		const { h, a, b } = await start(false, true);
		a.setResponses([
			tool("probe", {}),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: QUOTA, timestamp: stack.clock.now() }),
			fauxAssistantMessage("SHOULD NOT RUN"),
		]);
		await h.session.prompt("/loop 30s quota-loop --max 10");
		await h.session.prompt("/goal finish quota work --turns 10");
		await h.session.prompt("go");
		stack.clock.advance(150_000);
		await h.session.waitForIdle();
		await h.session.prompt("/loop list");
		expect(stack.notifications.at(-1)).toContain("0/10 runs");
		expect(stack.notifications.at(-1)).toContain("paused: provider error");
		expect(h.eventsOfType("agent_start")).toHaveLength(1);
		expect(nudges(h)).toEqual([]);
		expect(goalStates(h).at(-1)).toMatchObject({ status: "paused", reason: "provider error" });
		expect(a.state.callCount).toBe(2);
		expect(b.state.callCount).toBe(0);
		expect(spoken(h)).not.toContain("SHOULD NOT RUN");
		expect(stack.usage.reads).toMatchObject([{ provider: "spike-a", options: { fresh: true } }]);
	});
});
