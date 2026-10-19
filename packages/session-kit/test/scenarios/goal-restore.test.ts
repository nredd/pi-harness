import { readFileSync, writeFileSync } from "node:fs";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage } from "@earendil-works/pi-coding-agent/testing";
import { afterEach, expect, it } from "vitest";
import { complete, configFor, goalStates, nudges, ScenarioFixture, sessionFile, spoken } from "./support.ts";

let fixture: ScenarioFixture | undefined;
afterEach(() => fixture?.cleanup());

it("active disk snapshot restores paused", async () => {
	fixture = new ScenarioFixture();
	const config = configFor("goal");
	const original = await fixture.start(config);
	original.setResponses([fauxAssistantMessage("a")]);
	await original.session.prompt("/goal ship it");
	await original.session.prompt("/goal pause");
	await original.session.prompt("go");
	const file = sessionFile(original);
	original.cleanup();
	const entries = readFileSync(file, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	const lastGoal = entries.reverse().find((entry) => entry.customType === "session-kit:goal");
	entries.reverse();
	expect(lastGoal.data.goal.status).toBe("paused");
	lastGoal.data.goal.status = "active";
	writeFileSync(file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);

	const restored = await fixture.start(config, { sessionManager: SessionManager.open(file) });
	restored.setResponses([fauxAssistantMessage("after restore"), fauxAssistantMessage("SHOULD NOT NUDGE")]);
	await restored.session.prompt("again");
	expect(spoken(restored)).toEqual(["after restore"]);
	expect(restored.getPendingResponseCount()).toBe(1);
	expect(nudges(restored)).toEqual([]);
	expect(restored.session.getActiveToolNames()).not.toContain("goal_update");
	restored.cleanup();

	const resumed = await fixture.start(config, { sessionManager: SessionManager.open(file) });
	resumed.setResponses([fauxAssistantMessage("resumed work"), complete(), fauxAssistantMessage("finished")]);
	await resumed.session.prompt("/goal resume");
	await resumed.session.prompt("go on");
	expect(spoken(resumed)).toEqual(["resumed work", "finished"]);
	expect(nudges(resumed)).toHaveLength(1);
	expect(goalStates(resumed).at(-1)?.status).toBe("complete");
});
