import { readFileSync } from "node:fs";
import { type FauxResponseFactory, fauxAssistantMessage } from "@earendil-works/pi-coding-agent/testing";
import { afterEach, expect, it } from "vitest";
import { configFor, ScenarioFixture, sessionFile, spoken } from "./support.ts";

let fixture: ScenarioFixture | undefined;
afterEach(() => fixture?.cleanup());

it("print binding skips preferred title model", async () => {
	fixture = new ScenarioFixture();
	const config = { ...configFor("titles"), titleModel: "faux/title" };
	const harness = await fixture.start(config, { models: [{ id: "main" }, { id: "title" }] });
	const titleQueue = [fauxAssistantMessage("Skipme Title Words")];
	const requested: string[] = [];
	const dispatch: FauxResponseFactory = (_context, _options, _state, model) => {
		requested.push(model.id);
		if (model.id === "main") return fauxAssistantMessage("OK");
		const title = titleQueue.shift();
		if (!title) throw new Error("Unexpected extra title request");
		return title;
	};
	harness.setResponses([dispatch, dispatch]);
	await harness.session.prompt("name this session please");
	expect(spoken(harness)).toEqual(["OK"]);
	expect(requested).toEqual(["main"]);
	expect(titleQueue).toHaveLength(1);
	expect(harness.getPendingResponseCount()).toBe(1);
	expect(harness.session.sessionName).toBeUndefined();
	const entries = harness.sessionManager.getEntries();
	expect(entries.length).toBeGreaterThan(0);
	expect(entries.filter((entry) => entry.type === "session_info")).toEqual([]);
	expect(readFileSync(sessionFile(harness), "utf8")).not.toContain("Skipme Title Words");
});
