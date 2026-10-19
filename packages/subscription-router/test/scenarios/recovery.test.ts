/** Ports terminal/retry/unconfirmed from e2e/run.sh through the real settle/retry machinery. */
import { fauxAssistantMessage, fauxToolCall, getAssistantTexts } from "@earendil-works/pi-coding-agent/testing";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { CachedUsage, Clock, prompt, type RouterScenario, startRouter } from "./support.js";

const TERMINAL = "insufficient_quota: You exceeded your current quota";
const RETRY = "429 Too Many Requests: rate_limit_error";

describe("router recovery through a real session", () => {
	let scenario: RouterScenario | undefined;
	afterEach(() => scenario?.cleanup());

	/** A's tool turn succeeds, its follow-up fails; a fresh read may confirm A exhausted. */
	async function exercise(errorMessage: string, confirm: boolean) {
		const clock = new Clock();
		const usage = new CachedUsage(clock);
		usage.set("spike-a", 0);
		usage.set("spike-b", 0);
		usage.onRefresh = (provider) => {
			if (provider === "spike-a" && confirm) usage.set(provider, 100);
		};
		scenario = await startRouter(usage, "ordered", [
			(pi) => {
				pi.registerTool({
					name: "probe",
					label: "Probe",
					description: "Record the tool turn before failure",
					parameters: Type.Object({}),
					execute: async () => ({ content: [{ type: "text", text: "tool-ran" }], details: undefined }),
				});
			},
		]);
		const [a, b] = scenario.providers;
		const roles: string[][] = [];
		a.setResponses([
			fauxAssistantMessage(fauxToolCall("probe", {}), { stopReason: "toolUse" }),
			...Array.from({ length: 8 }, () =>
				fauxAssistantMessage("", { stopReason: "error", errorMessage, timestamp: clock.now() }),
			),
		]);
		b.setResponses(
			Array.from({ length: 4 }, () => (context) => {
				roles.push(context.messages.map((message) => message.role));
				return fauxAssistantMessage("RECOVERED on spike-b/terra-b");
			}),
		);
		const messages = await prompt(scenario);
		const { harness, tracker, notifications } = scenario;
		expect(harness.eventsOfType("tool_execution_end")).toMatchObject([
			{ toolName: "probe", isError: false, result: { content: [{ type: "text", text: "tool-ran" }] } },
		]);
		expect(a.state.callCount).toBe(2);
		expect(usage.reads).toHaveLength(1);
		expect(usage.reads[0]).toMatchObject({ provider: "spike-a", options: { fresh: true, notBefore: clock.now() } });
		expect(harness.session.model).toMatchObject({ provider: "router", id: "spike" });
		return { harness, tracker, notifications, b, roles, messages, clock };
	}

	it("terminal quota error recovers to B", async () => {
		const { harness, tracker, notifications, b, roles, messages, clock } = await exercise(TERMINAL, true);
		expect(messages.map((message) => message.provider)).toEqual(["spike-a", "spike-a", "spike-b"]);
		expect(getAssistantTexts(harness)).toContain("RECOVERED on spike-b/terra-b");
		expect(b.state.callCount).toBe(1);
		expect(roles).toEqual([["system", "user", "assistant", "toolResult"]]);
		expect(notifications).toEqual([
			"subscription-router: spike-a/sonnet-a is out of quota, continuing on spike-b/terra-b",
		]);
		expect(harness.eventsOfType("auto_retry_start")).toHaveLength(0);
		expect(tracker.active()).toMatchObject([{ provider: "spike-a", until: clock.now() + 3_600_000 }]);
		clock.advance(3_600_000);
		expect(tracker.active()).toEqual([]);
	});

	it("retry quota error recovers to B", async () => {
		const { harness, tracker, b, roles, messages } = await exercise(RETRY, true);
		expect(messages.map((message) => message.provider)).toEqual(["spike-a", "spike-a", "spike-b"]);
		expect(harness.eventsOfType("auto_retry_start")).toMatchObject([{ attempt: 1, delayMs: 0, errorMessage: RETRY }]);
		expect(getAssistantTexts(harness)).toContain("RECOVERED on spike-b/terra-b");
		expect(b.state.callCount).toBe(1);
		expect(roles).toEqual([["system", "user", "assistant", "toolResult"]]);
		expect(tracker.active()).toMatchObject([{ provider: "spike-a" }]);
	});

	it("unconfirmed quota error does not recover", async () => {
		const { harness, tracker, b, roles, messages, notifications } = await exercise(TERMINAL, false);
		expect(messages.map((message) => message.provider)).toEqual(["spike-a", "spike-a"]);
		expect(messages.at(-1)).toMatchObject({ stopReason: "error", errorMessage: TERMINAL });
		expect(getAssistantTexts(harness).join("\n")).not.toContain("RECOVERED");
		expect(b.state.callCount).toBe(0);
		expect(b.getPendingResponseCount()).toBe(4);
		expect(roles).toEqual([]);
		expect(tracker.active()).toEqual([]);
		expect(notifications).toEqual([]);
		expect(harness.eventsOfType("auto_retry_start")).toHaveLength(0);
	});
});
