import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-coding-agent/testing";
import { createInteractiveHarness } from "@earendil-works/pi-coding-agent/testing/interactive";
import { VirtualTerminal } from "@earendil-works/pi-tui/testing";
import { commitState, setActiveRenderSession } from "../state/store.ts";
import { registerTodoTool } from "../todo.ts";

/** Mount a legacy settled result without a valid snapshot in the real cached TUI row. */
export async function settledRow(action: "update" | "delete") {
	const terminal = new VirtualTerminal(120, 40);
	const ui = await createInteractiveHarness({
		terminal,
		extensionFactories: [
			(pi) => {
				let definition: ToolDefinition<any, any, any> | undefined;
				registerTodoTool({
					registerTool: (tool) => {
						definition = tool;
					},
				} as ExtensionAPI);
				if (!definition) throw new Error("todo tool missing");
				pi.registerTool({
					...definition,
					// Old/error results may lack a replayable task snapshot.
					async execute() {
						return { content: [{ type: "text", text: "legacy result" }], details: undefined };
					},
				});
			},
		],
	});
	const id = ui.harness.sessionManager.getSessionId();
	setActiveRenderSession(id);
	const change = (subject: string) =>
		commitState(id, {
			tasks: [{ id: 1, subject, status: "pending" }],
			nextId: 2,
		});
	change("original subject");
	ui.harness.setResponses([
		fauxAssistantMessage(fauxToolCall("todo", { action, id: 1 })),
		fauxAssistantMessage("done"),
	]);
	await ui.harness.session.prompt("render legacy row");
	await ui.settle();
	return { ui, terminal, change, screen: () => ui.viewport().join("\n") };
}
