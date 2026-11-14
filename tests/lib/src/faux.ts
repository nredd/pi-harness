/** Scripted model turns and observations of the real host that executes them. */
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall, type Harness } from "@earendil-works/pi-coding-agent/testing";

/** One scripted tool request. */
export interface ToolCallSpec {
	name: string;
	args: Parameters<typeof fauxToolCall>[1];
}

/** A real model turn that requests every tool in `specs`; the host executes them. */
export function toolCalls(...specs: ToolCallSpec[]) {
	return fauxAssistantMessage(
		specs.map((spec) => fauxToolCall(spec.name, spec.args)),
		{ stopReason: "toolUse" },
	);
}

/** A real model turn that requests one tool. */
export function toolCall(name: string, args: ToolCallSpec["args"]) {
	return toolCalls({ name, args });
}

/** Text of a persisted message or tool result without assuming a single content block. */
export function text(message: unknown): string {
	if (!message || typeof message !== "object" || !("content" in message)) return "";
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part: { type?: string; text?: string }) => (part.type === "text" ? (part.text ?? "") : ""))
		.join("\n");
}

/**
 * Settled results of tool `name` from the host's own events, in request order: the end event plus its
 * `args` and joined `text`. A call that never settled is absent.
 */
export function settled(harness: Pick<Harness, "eventsOfType">, name: string) {
	const ended = new Map(harness.eventsOfType("tool_execution_end").map((event) => [event.toolCallId, event]));
	return harness
		.eventsOfType("tool_execution_start")
		.filter((start) => start.toolName === name)
		.flatMap((start) => {
			const end = ended.get(start.toolCallId);
			return end ? [{ ...end, args: start.args as Record<string, unknown>, text: text(end.result) }] : [];
		});
}

/** Just `{ text, isError }` of each settled result of tool `name`, for exact assertions. */
export function outcomes(harness: Pick<Harness, "eventsOfType">, name: string) {
	return settled(harness, name).map(({ text: body, isError }) => ({ text: body, isError }));
}

type SessionEvent<T extends AgentSessionEvent["type"]> = Extract<AgentSessionEvent, { type: T }>;

/**
 * Resolve with the next host event of a type, or the next event a predicate accepts. Subscribe BEFORE
 * the action that causes it; this is never a poll or an elapsed-clock wait.
 */
export function nextEvent<T extends AgentSessionEvent["type"]>(
	harness: Pick<Harness, "session">,
	type: T,
): Promise<SessionEvent<T>>;
export function nextEvent(
	harness: Pick<Harness, "session">,
	predicate: (event: AgentSessionEvent) => boolean,
): Promise<AgentSessionEvent>;
export function nextEvent(
	harness: Pick<Harness, "session">,
	match: AgentSessionEvent["type"] | ((event: AgentSessionEvent) => boolean),
): Promise<AgentSessionEvent> {
	const accepts = typeof match === "string" ? (event: AgentSessionEvent) => event.type === match : match;
	return new Promise((resolve) => {
		const off = harness.session.subscribe((event) => {
			if (!accepts(event)) return;
			off();
			resolve(event);
		});
	});
}
