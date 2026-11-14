/**
 * Drive dev-tools through a real `AgentSession`: the model's tool calls are faux, everything after
 * them (pi's schema validation, `tool_call` hooks, the real `bash` tool, result serialization) is pi.
 * Runs under Vitest on Node and Bun.
 */

import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import {
	createHarness,
	fauxAssistantMessage,
	fauxToolCall,
	type Harness,
} from "@earendil-works/pi-coding-agent/testing";

export interface ToolCallSpec {
	name: string;
	args: Parameters<typeof fauxToolCall>[1];
}

/** What one tool call returned through pi, as the model and programmatic callers see it. */
export interface ToolOutcome {
	name: string;
	isError: boolean;
	text: string;
	structured: unknown;
}

/** A started session running `extension` in `cwd`, with pi's default tools (including `bash`). */
export async function startSession(extension: ExtensionFactory, cwd: string): Promise<Harness> {
	const harness = await createHarness({ cwd, extensionFactories: [extension] });
	await harness.session.bindExtensions({ mode: "print" });
	return harness;
}

let nextCall = 0;

/** Issue `calls` as one model turn and return one outcome per call, in call order. */
export async function runTools<const Calls extends readonly ToolCallSpec[]>(
	harness: Harness,
	calls: Calls,
): Promise<{ [K in keyof Calls]: ToolOutcome }> {
	const ids = calls.map(() => `call-${++nextCall}`);
	harness.setResponses([
		fauxAssistantMessage(
			calls.map((call, i) => fauxToolCall(call.name, call.args, { id: ids[i] })),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("DONE"),
	]);
	await harness.session.prompt("go");
	const ends = new Map(harness.eventsOfType("tool_execution_end").map((event) => [event.toolCallId, event]));
	const outcomes = ids.map((id, i): ToolOutcome => {
		const end = ends.get(id);
		if (!end) throw new Error(`${calls[i]?.name} (${id}) never settled`);
		const result = end.result as { content?: { type: string; text?: string }[]; structuredContent?: unknown };
		return {
			name: end.toolName,
			isError: end.isError,
			text: (result.content ?? []).flatMap((part) => (part.type === "text" ? [part.text ?? ""] : [])).join("\n"),
			structured: result.structuredContent,
		};
	});
	return outcomes as { [K in keyof Calls]: ToolOutcome };
}
