import { readFileSync } from "node:fs";
import { type FauxResponseFactory, fauxAssistantMessage } from "@earendil-works/pi-coding-agent/testing";
import { afterEach, expect, it } from "vitest";
import { configFor, nextEvent, ScenarioFixture, sessionFile, spoken, TerminalFixture } from "./support.ts";

let fixture: ScenarioFixture | undefined;
let terminal: TerminalFixture | undefined;
afterEach(async () => {
	await terminal?.dispose();
	fixture?.cleanup();
});

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

it.each([undefined, "My Manual Review Name"])(
	"interactive auto-title runs once and never replaces manual name %s",
	async (manual) => {
		terminal = new TerminalFixture();
		const host = await terminal.startTerminal(
			{ ...configFor("titles"), titleModel: "faux/title" },
			{
				models: [{ id: "main" }, { id: "title" }],
			},
		);
		const requested: string[] = [];
		const dispatch: FauxResponseFactory = (_ctx, _opts, _state, model) => {
			requested.push(model.id);
			if (model.id === "title") return fauxAssistantMessage("Inspect Reviewer Capabilities");
			return fauxAssistantMessage(
				requested.filter((id) => id === "main").length === 1 ? "REVIEW TURN FINISHED" : "SECOND TURN FINISHED",
			);
		};
		host.harness.setResponses([dispatch, dispatch, dispatch]);
		/** Read names from persisted JSONL, never the session's in-memory name cache. */
		const names = (): string[] => {
			const file = host.harness.sessionManager.getSessionFile();
			if (!file) throw new Error("Expected file-backed TUI session");
			try {
				return readFileSync(file, "utf8")
					.split("\n")
					.filter(Boolean)
					.map((line) => JSON.parse(line))
					.filter((entry) => entry.type === "session_info" && "name" in entry)
					.map((entry) => entry.name);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
				throw error;
			}
		};
		expect(names()).toEqual([]);
		if (manual) {
			await terminal.key(`/name ${manual}`);
			await terminal.key("\r");
			expect(host.viewport().join("\n")).toContain(manual);
		}
		const first = nextEvent(host.harness, "agent_settled");
		await terminal.key("Inspect the code-reviewer capabilities");
		await terminal.key("\r");
		await first;
		await host.settle();
		const expected = manual ?? "Inspect Reviewer Capabilities";
		expect(host.viewport().join("\n")).toContain("REVIEW TURN FINISHED");
		expect(names()).toEqual([expected]);
		await terminal.key("/name");
		await terminal.key("\r");
		expect(host.viewport().join("\n")).toContain(expected);
		const second = nextEvent(host.harness, "agent_settled");
		await terminal.key("Continue reviewing");
		await terminal.key("\r");
		await second;
		await host.settle();
		expect(host.viewport().join("\n")).toContain("SECOND TURN FINISHED");
		expect(names()).toEqual([expected]);
		expect(requested).toEqual(manual ? ["main", "main"] : ["main", "title", "main"]);
	},
);
