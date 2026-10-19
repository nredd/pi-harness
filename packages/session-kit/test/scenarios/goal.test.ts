import { getCurrentTools } from "@earendil-works/pi-ai/compat";
import { type FauxResponseFactory, fauxAssistantMessage } from "@earendil-works/pi-coding-agent/testing";
import { afterEach, describe, expect, it } from "vitest";
import { turnTokens } from "../../src/goal/index.ts";
import {
	complete,
	configFor,
	EVIDENCE,
	goalStates,
	nudges,
	outcomes,
	ScenarioFixture,
	spoken,
	tool,
} from "./support.ts";

describe("goals through a real session", () => {
	let fixture: ScenarioFixture | undefined;
	async function start() {
		fixture = new ScenarioFixture();
		return fixture.start(configFor("goal"));
	}
	afterEach(() => fixture?.cleanup());

	it("goal nudges until evidenced completion", async () => {
		const harness = await start();
		harness.setResponses([
			fauxAssistantMessage("step one"),
			fauxAssistantMessage("step two"),
			fauxAssistantMessage("step three"),
			complete(),
			fauxAssistantMessage("all done"),
		]);
		await harness.session.prompt("/goal ship the widget");
		await harness.session.prompt("go");
		expect(spoken(harness)).toEqual(["step one", "step two", "step three", "all done"]);
		const messages = nudges(harness);
		expect(messages).toHaveLength(3);
		expect(messages[0]).toMatchObject({ content: expect.stringContaining("ship the widget"), display: false });
		expect(goalStates(harness).at(-1)).toMatchObject({ status: "complete", evidence: EVIDENCE, turns: 3 });
		expect(harness.eventsOfType("tool_execution_end")).toHaveLength(1);
	});

	it("goal completion rejects empty evidence then accepts proof", async () => {
		const harness = await start();
		harness.setResponses([complete(""), complete("  "), complete(), fauxAssistantMessage("ok")]);
		await harness.session.prompt("/goal ship it");
		await harness.session.prompt("go");
		const results = outcomes(harness, "goal_update");
		expect(results).toHaveLength(3);
		for (const result of results.slice(0, 2)) {
			expect(result.isError).toBe(true);
			expect(result.text).toContain("evidence required");
		}
		expect(results[2]?.isError).toBe(false);
		expect(goalStates(harness).map((state) => state?.status)).toEqual(["active", "active", "active", "complete"]);
		expect(harness.eventsOfType("tool_execution_end").map((event) => event.isError)).toEqual([true, true, false]);
	});

	it("blocked goal settles without another nudge", async () => {
		const harness = await start();
		harness.setResponses([
			tool("goal_update", { status: "blocked", evidence: "no API key" }),
			fauxAssistantMessage("cannot go on"),
			fauxAssistantMessage("SHOULD NOT RUN"),
		]);
		await harness.session.prompt("/goal ship it");
		await harness.session.prompt("go");
		expect(spoken(harness)).toEqual(["cannot go on"]);
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(nudges(harness)).toEqual([]);
		expect(goalStates(harness).at(-1)).toMatchObject({ status: "blocked", reason: "no API key" });
	});

	it("parent turn cap stops at three", async () => {
		const harness = await start();
		harness.setResponses(Array.from({ length: 8 }, (_, index) => fauxAssistantMessage(`turn ${index + 1}`)));
		await harness.session.prompt("/goal never done --turns 3");
		await harness.session.prompt("go");
		expect(spoken(harness)).toEqual(["turn 1", "turn 2", "turn 3"]);
		expect(nudges(harness)).toHaveLength(2);
		expect(goalStates(harness).at(-1)).toMatchObject({ status: "budget", turns: 3 });
		expect(harness.getPendingResponseCount()).toBe(5);
	});

	it("parent usage exhausts token budget without another nudge", async () => {
		const harness = await start();
		const first = fauxAssistantMessage("turn 1");
		harness.setResponses([
			first,
			...Array.from({ length: 4 }, (_, index) => fauxAssistantMessage(`turn ${index + 2}`)),
		]);
		await harness.session.prompt("/goal never done --tokens 20000");
		// The core faux provider replaces scripted usage with its own estimate from the request.
		await harness.session.prompt(`go ${"token ".repeat(20_000)}`);
		expect(spoken(harness)).toEqual(["turn 1"]);
		expect(goalStates(harness).at(-1)).toMatchObject({
			status: "budget",
			reason: expect.stringContaining("tokens"),
		});
		expect(goalStates(harness).at(-1)?.tokens).toBeGreaterThanOrEqual(20_000);
		const response = harness.session.messages.find((message) => message.role === "assistant");
		expect(goalStates(harness).at(-1)?.tokens).toBe(turnTokens(response));
		expect(nudges(harness)).toEqual([]);
		expect(harness.getPendingResponseCount()).toBe(4);
		expect(turnTokens({ role: "toolResult", usage: { input: 30_000, output: 100 } })).toBe(0);
	});

	it("goal lifetime changes only goal_update exposure", async () => {
		const harness = await start();
		const offered: string[][] = [];
		const listTools: FauxResponseFactory = (context) => {
			offered.push(
				getCurrentTools(context.messages)
					.map((definition) => definition.name)
					.sort(),
			);
			return fauxAssistantMessage("TOOLS");
		};
		harness.setResponses([listTools, listTools, complete(), listTools, listTools]);
		await harness.session.prompt("plain prompt");
		await harness.session.prompt("/goal ship it");
		await harness.session.prompt("go");
		await harness.session.prompt("after");
		expect(offered).toHaveLength(4);
		const [before, during, afterComplete, after] = offered;
		expect(before).not.toContain("goal_update");
		expect(during).toContain("goal_update");
		expect(during?.filter((name) => name !== "goal_update")).toEqual(before);
		expect(afterComplete).toEqual(before);
		expect(after).toEqual(before);
	});

	it("pause suppresses nudges until explicit resume", async () => {
		const harness = await start();
		harness.setResponses([
			fauxAssistantMessage("a"),
			fauxAssistantMessage("b"),
			complete(),
			fauxAssistantMessage("end"),
		]);
		await harness.session.prompt("/goal ship it");
		await harness.session.prompt("/goal pause");
		await harness.session.prompt("one");
		expect(nudges(harness)).toEqual([]);
		await harness.session.prompt("/goal resume");
		await harness.session.prompt("two");
		expect(nudges(harness)).toHaveLength(1);
		expect(
			goalStates(harness)
				.slice(0, 2)
				.map((state) => state?.status),
		).toEqual(["active", "paused"]);
		expect(goalStates(harness).at(-1)?.status).toBe("complete");
		expect(spoken(harness)).toEqual(["a", "b", "end"]);
	});

	it("ordinary prompt leaves goal inert", async () => {
		const harness = await start();
		harness.setResponses([fauxAssistantMessage("plain"), fauxAssistantMessage("SHOULD NOT RUN")]);
		await harness.session.prompt("hello");
		expect(spoken(harness)).toEqual(["plain"]);
		expect(nudges(harness)).toEqual([]);
		expect(goalStates(harness)).toEqual([]);
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("provider error pauses goal at host settlement", async () => {
		const harness = await start();
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "boom: upstream exploded" }),
			fauxAssistantMessage("SHOULD NOT RUN"),
		]);
		await harness.session.prompt("/goal ship it");
		await harness.session.prompt("go");
		expect(spoken(harness)).not.toContain("SHOULD NOT RUN");
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(nudges(harness)).toEqual([]);
		expect(goalStates(harness).at(-1)).toMatchObject({ status: "paused", reason: "provider error" });
		expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
	});
});
