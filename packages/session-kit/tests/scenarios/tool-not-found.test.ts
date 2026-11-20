import { toolCall } from "@nredd/pi-test-lib/faux";
import { fauxAssistantMessage } from "@nredd/pi-test-lib/harness";
import { Type } from "typebox";
import { afterEach, expect, it } from "vitest";
import { createSessionKit } from "../../src/index.ts";
import { configFor, ScenarioFixture } from "../fixtures/session.ts";

let fixture: ScenarioFixture | undefined;
afterEach(() => fixture?.cleanup());

it("suggests search_tools without claiming the unknown name is deferred", async () => {
	fixture = new ScenarioFixture();
	const harness = await fixture.start(configFor());
	harness.setResponses([toolCall("unknown_tool", {}), fauxAssistantMessage("done")]);
	await harness.session.prompt("Try an unknown tool");

	const results = harness.session.messages.filter((message) => message.role === "toolResult");
	expect(results).toMatchObject([
		{
			toolName: "unknown_tool",
			isError: true,
			content: [
				{ type: "text", text: "Tool unknown_tool not found. If it is a deferred tool, call search_tools to load it." },
			],
		},
	]);
});

it("preserves errors from a tool that was found and executed", async () => {
	fixture = new ScenarioFixture();
	const config = configFor();
	const harness = await fixture.start(config, {
		extensionFactories: [
			createSessionKit({ config }),
			(pi) => {
				pi.registerTool({
					name: "failing_tool",
					label: "Failing tool",
					description: "Exercise an execution error",
					parameters: Type.Object({}),
					async execute() {
						throw new Error("Input not found");
					},
				});
			},
		],
	});
	harness.setResponses([toolCall("failing_tool", {}), fauxAssistantMessage("done")]);
	await harness.session.prompt("Try the failing tool");

	const results = harness.session.messages.filter((message) => message.role === "toolResult");
	expect(results).toMatchObject([
		{ toolName: "failing_tool", isError: true, content: [{ type: "text", text: "Input not found" }] },
	]);
});
