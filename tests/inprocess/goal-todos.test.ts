/** The real todo settle handler owns continuation ahead of the real goal handler. */
import { fauxAssistantMessage, getMessageText } from "@earendil-works/pi-coding-agent/testing";
import { afterEach, describe, expect, it } from "vitest";
import { complete, GoalStack, goalStates, nudges, outcomes, spoken, tool } from "./goal-support.ts";
import { loadFork } from "./support.ts";

const PLAN = "# Ship widgets\n\n## Work\n- Add the `alpha` module\n- Wire `beta` into the CLI\n";

describe("goal and approved todos", () => {
	let stack: GoalStack;
	afterEach(async () => {
		await stack?.cleanup();
	});

	it("todo reminder and goal share one continuation", async () => {
		stack = await GoalStack.create();
		const h = await stack.start([await loadFork("pi-plan-mode"), await loadFork("rpiv-todo"), stack.kit()]);
		h.setResponses([tool("plan_mode_complete", { plan: PLAN })]);
		await h.session.prompt("/plan start");
		await h.session.prompt("plan it");
		h.setResponses([fauxAssistantMessage("implementing"), fauxAssistantMessage("reminded")]);
		await h.session.prompt("/plan implement");
		await h.session.waitForIdle();
		expect(spoken(h)).toEqual(["implementing", "reminded"]);
		const contexts: string[] = [];
		h.setResponses([
			fauxAssistantMessage("turn A"),
			(ctx) => {
				const users = ctx.messages
					.filter((m) => m.role === "user")
					.map(getMessageText)
					.join("\n");
				contexts.push(users);
				return fauxAssistantMessage(`USERS ${users}`);
			},
			tool("todo", { action: "update", id: 1, status: "completed" }),
			complete(),
			fauxAssistantMessage("end"),
		]);
		await h.session.prompt("/goal finish it --turns 10");
		await h.session.prompt("go");
		expect(contexts).toHaveLength(1);
		expect(contexts[0]).toContain("Plan check:");
		expect(contexts[0]).not.toContain("[goal 1/10 turns]");
		const texts = spoken(h);
		expect(texts[texts.indexOf("turn A") + 1]).toBe(`USERS ${contexts[0]}`);
		const branch = h.sessionManager.getBranch();
		const a = branch.findIndex(
			(e) => e.type === "message" && e.message.role === "assistant" && getMessageText(e.message) === "turn A",
		);
		expect(a).toBeGreaterThanOrEqual(0);
		const next = branch.findIndex((e, index) => index > a && e.type === "message" && e.message.role === "assistant");
		expect(next).toBeGreaterThan(a);
		const between = branch.slice(a + 1, next);
		expect(
			between.filter((e) => e.type === "custom_message" && e.customType === "rpiv-todo-plan-reminder"),
		).toHaveLength(1);
		expect(between.filter((e) => e.type === "custom_message" && e.customType === "session-kit:goal-nudge")).toEqual([]);
		expect(outcomes(h, "todo")).toHaveLength(1);
		expect(outcomes(h, "todo")[0]?.text).toContain("evidence required");
		expect(goalStates(h).at(-1)?.status).toBe("complete");
		expect(h.getPendingResponseCount()).toBe(0);
		expect(nudges(h).length).toBeGreaterThanOrEqual(1);
	});
});
