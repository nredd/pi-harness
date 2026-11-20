import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { toolCall } from "@nredd/pi-test-lib/faux";
import { fauxAssistantMessage } from "@nredd/pi-test-lib/harness";
import { Type } from "typebox";
import { afterEach, expect, it } from "vitest";
import { createSessionKit } from "../../src/index.ts";
import { configFor, ScenarioFixture } from "../fixtures/session.ts";

let fixture: ScenarioFixture | undefined;
afterEach(() => fixture?.cleanup());

const registerSearch: ExtensionFactory = (pi) => {
	pi.registerTool({
		name: "search_tools",
		label: "Search tools",
		description: "Test search tool availability",
		parameters: Type.Object({}),
		async execute() {
			throw new Error("Handling a missing tool must not run search_tools");
		},
	});
};

const fallback = (name: string) =>
	`Tool ${name} is not available in this request: it is not active (deferred tools must be loaded first), not registered, or excluded by the active profile`;

async function startWithSearch(allowedToolNames = ["search_tools"], hintEnabled = true) {
	fixture = new ScenarioFixture();
	const config = hintEnabled ? configFor("unavailableToolHint") : configFor();
	return fixture.start(config, {
		allowedToolNames,
		extensionFactories: [createSessionKit({ config }), registerSearch],
	});
}

async function expectToolError(harness: Awaited<ReturnType<ScenarioFixture["start"]>>, name: string, text: string) {
	harness.setResponses([toolCall(name, {}), fauxAssistantMessage("done")]);
	await harness.session.prompt("Try the tool");
	expect(harness.session.messages.filter((message) => message.role === "toolResult")).toMatchObject([
		{ toolName: name, isError: true, content: [{ type: "text", text }] },
	]);
}

it.each([
	["unknown_tool", 'Tool "unknown_tool" not found. If it is a deferred tool, call search_tools to load it.'],
	["x".repeat(500), `Tool "${"x".repeat(61)}..." not found. If it is a deferred tool, call search_tools to load it.`],
])("gives a conditional hint and safely displays %j when search_tools is active", async (name, expected) => {
	const harness = await startWithSearch();
	expect(harness.session.getActiveToolNames()).toContain("search_tools");
	await expectToolError(harness, name, expected);
});

it.each(["", "\u200b\x00", "read\u200b", "line\n\x1b[31mred\x1b[0m\x00\u2028\u202e"])(
	"keeps the host default for an empty or altered name %j even with active search",
	async (name) => {
		const harness = await startWithSearch();
		expect(harness.session.getActiveToolNames()).toContain("search_tools");
		await expectToolError(harness, name, fallback(name));
	},
);

it("keeps the host default when the hint is disabled even with active search", async () => {
	const harness = await startWithSearch(["search_tools"], false);
	expect(harness.session.getActiveToolNames()).toContain("search_tools");
	await expectToolError(harness, "unknown_tool", fallback("unknown_tool"));
});

it("keeps the host default when the session allowlist excludes search_tools", async () => {
	const harness = await startWithSearch([]);
	expect(harness.session.getActiveToolNames()).not.toContain("search_tools");
	await expectToolError(harness, "unknown_tool", fallback("unknown_tool"));
});

it.each(["unknown_tool", "search_tools"])(
	"keeps the host default for %s when search_tools is inactive",
	async (name) => {
		const harness = await startWithSearch();
		harness.session.setActiveToolsByName([]);
		await expectToolError(harness, name, fallback(name));
	},
);

it.each<unknown>(["search_tools", undefined, 42])(
	"declines a hook event naming %j even with active search",
	async (name) => {
		const harness = await startWithSearch();
		expect(harness.session.getActiveToolNames()).toContain("search_tools");
		const message = await harness.session.extensionRunner.emitToolNotFound({
			type: "tool_not_found",
			toolName: name as string,
			toolCallId: "missing",
		});
		expect(message).toBeUndefined();
	},
);

it("preserves errors from a tool that was found and executed", async () => {
	fixture = new ScenarioFixture();
	const config = configFor("unavailableToolHint");
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
	await expectToolError(harness, "failing_tool", "Input not found");
});
