/**
 * Scripted faux providers for the harness; loaded with `-e`, never installed.
 *
 * `HARNESS_SCRIPT` points at a JSON file:
 *   { "providers": { "<name>": { "models": ["id", ...], "steps": [Step, ...] } } }
 * Step: { "text": "..." } | { "tools": [{ "name": "bash", "args": {...} }] } | { "error": "..." }
 *       | { "report": true }  (reply with the previous turn's tool results, one per line)
 *       | { "listTools": true }  (reply with the sorted names of the tools offered to the model)
 *       | { "echoLast": true }  (reply `ECHO <text>` of the last non-assistant message the model got,
 *         e.g. a context-hook rewrite that is never persisted)
 *       | { "echoUsers": true }  (reply `USERS <a> | <b>`: every user message's text, oldest first;
 *         how a scenario sees a steer or a forced prompt)
 * A provider script may add "virtual": [{ "id": "default", "to": "<provider>/<model>" }]: virtual
 * models `<provider>/<id>` that route every request to that physical faux model (a router stand-in).
 * Any step may add "delayMs" (silence before the stream opens) or "openMs" (the stream opens with
 * `start` at once, then stays silent this long: a provider that accepted the call and is thinking).
 * A provider script may add "tokensPerSecond" and "tokenSize" ({min,max}) to pace streamed text in
 * deltas (passed to pi-ai's faux core); without them a reply lands as one burst.
 * Once a provider's steps run out it answers "DONE".
 * A "tools" step may add "text", sent as narration before the calls in the same message.
 * Any "text" or "tools" step may add "thinking", a thinking block sent before the rest of the message.
 * A "tools" step with "whileTools": true stays at the head of the queue and repeats while the
 * request offers the model any tool; the first tool-less request skips it and the next step
 * answers (how a scenario loops past a turn cap until a forced no-tools turn).
 * String tool args may contain `{{agentId}}`, replaced with the newest `ID: <id>` seen in a
 * tool result (how a background `Agent` reports its handle).
 */

import { readFileSync } from "node:fs";
import {
	type AssistantMessage,
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
	createFauxCore,
	fauxAssistantMessage,
	fauxText,
	fauxThinking,
	fauxToolCall,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface ToolStep {
	name: string;
	args: Record<string, unknown>;
}

interface Step {
	text?: string;
	thinking?: string;
	tools?: ToolStep[];
	error?: string;
	report?: boolean;
	listTools?: boolean;
	echoUsers?: boolean;
	whileTools?: boolean;
	echoLast?: boolean;
	delayMs?: number;
	openMs?: number;
}

interface ProviderScript {
	models: string[];
	virtual?: { id: string; to: string }[];
	steps?: Step[];
	contextWindow?: number;
	tokensPerSecond?: number;
	tokenSize?: { min?: number; max?: number };
}

interface Script {
	providers: Record<string, ProviderScript>;
}

interface ContextMessage {
	role: string;
	content?: unknown;
	toolsAdded?: readonly { name: string }[];
	toolsRemoved?: readonly ({ name: string } | string)[];
}

function loadScript(): Script {
	const path = process.env.HARNESS_SCRIPT;
	if (!path) return { providers: { faux: { models: ["main"] } } };
	return JSON.parse(readFileSync(path, "utf8")) as Script;
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => (block && typeof block === "object" && "text" in block ? String(block.text) : ""))
		.join("");
}

/** Text of every tool result after the last assistant message. */
function lastToolResults(messages: readonly ContextMessage[]): string[] {
	const results: string[] = [];
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i]!;
		if (message.role === "assistant") break;
		if (message.role === "toolResult") results.unshift(textOf(message.content).replace(/\s+/g, " ").slice(0, 300));
	}
	return results;
}

interface FauxContext {
	messages: readonly ContextMessage[];
	tools?: readonly { name: string }[];
}

/**
 * Tool names offered to the model. Older cores pass `context.tools`; 1.0 carries tool
 * declarations on system messages as `toolsAdded` / `toolsRemoved`.
 */
function activeTools(context: FauxContext): string[] {
	const names = new Set((context.tools ?? []).map((tool) => tool.name));
	for (const message of context.messages) {
		if (message.role !== "system") continue;
		for (const tool of message.toolsAdded ?? []) names.add(tool.name);
		for (const tool of message.toolsRemoved ?? []) names.delete(typeof tool === "string" ? tool : tool.name);
	}
	return [...names].sort();
}

const AGENT_ID = /ID: ([0-9a-f][0-9a-f-]+)/g;

/** The newest subagent handle any tool result has reported. */
function latestAgentId(messages: readonly ContextMessage[]): string | undefined {
	let latest: string | undefined;
	for (const message of messages) {
		if (message.role !== "toolResult") continue;
		for (const match of textOf(message.content).matchAll(AGENT_ID)) latest = match[1];
	}
	return latest;
}

function substitute(args: Record<string, unknown>, messages: readonly ContextMessage[]): Record<string, unknown> {
	const agentId = latestAgentId(messages) ?? "unknown-agent";
	return Object.fromEntries(
		Object.entries(args).map(([key, value]) => [
			key,
			typeof value === "string" ? value.replaceAll("{{agentId}}", agentId) : value,
		]),
	);
}

function respond(step: Step | undefined, context: FauxContext) {
	const messages = context.messages;
	if (!step) return fauxAssistantMessage("DONE");
	if (step.error) return fauxAssistantMessage("", { stopReason: "error", errorMessage: step.error });
	const thinking = step.thinking ? [fauxThinking(step.thinking)] : [];
	if (step.tools) {
		const calls = step.tools.map((tool) => fauxToolCall(tool.name, substitute(tool.args, messages)));
		const narration = step.text ? [fauxText(step.text)] : [];
		return fauxAssistantMessage([...thinking, ...narration, ...calls], { stopReason: "toolUse" });
	}
	if (step.report) return fauxAssistantMessage(`REPORT\n${lastToolResults(messages).join("\n")}`);
	if (step.listTools) return fauxAssistantMessage(`TOOLS ${activeTools(context).join(",")}`);
	if (step.echoUsers) {
		const users = messages.filter((message) => message.role === "user").map((message) => textOf(message.content));
		return fauxAssistantMessage(`USERS ${users.join(" | ")}`);
	}
	if (step.echoLast) {
		const last = [...messages].reverse().find((message) => message.role !== "assistant" && message.role !== "system");
		return fauxAssistantMessage(`ECHO ${textOf(last?.content)}`);
	}
	return fauxAssistantMessage([...thinking, fauxText(step.text ?? "DONE")]);
}

type StreamSimple = (
	model: Model<string>,
	context: never,
	options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener("abort", () => {
			clearTimeout(timer);
			resolve();
		});
	});
}

/**
 * Wrap a faux stream so a step with `openMs` emits `start` immediately, then nothing until the
 * delay passes, then the scripted reply (minus its own `start`). The next step is peeked, not
 * taken: the core's response queue still consumes it.
 */
function withOpenSilence(streamSimple: StreamSimple, steps: readonly Step[]): StreamSimple {
	return (model, context, options) => {
		const openMs = steps[0]?.openMs;
		if (!openMs) return streamSimple(model, context, options);
		const outer = createAssistantMessageEventStream();
		const partial: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "pending",
			timestamp: Date.now(),
		} as AssistantMessage;
		outer.push({ type: "start", partial });
		void (async () => {
			await sleep(openMs, options?.signal);
			const inner = streamSimple(model, context, options);
			for await (const event of inner) {
				if (event.type !== "start") outer.push(event);
			}
			outer.end(await inner.result());
		})();
		return outer;
	};
}

/** Take the step answering this request; a `whileTools` step repeats until a tool-less request. */
function nextStep(steps: Step[], context: FauxContext): Step | undefined {
	if (steps[0]?.whileTools && activeTools(context).length === 0) steps.shift();
	return steps[0]?.whileTools ? steps[0] : steps.shift();
}

export default function harnessFaux(pi: ExtensionAPI): void {
	for (const [provider, script] of Object.entries(loadScript().providers)) {
		for (const { id, to } of script.virtual ?? []) {
			pi.registerVirtualModel({
				provider,
				id,
				name: `${provider} ${id}`,
				thinkingLevels: ["off", "medium"],
				route: (request, ctx) => {
					const [targetProvider, targetId] = to.split("/", 2);
					const model = ctx.modelRegistry.find(targetProvider!, targetId!);
					if (!model) throw new Error(`faux virtual model ${provider}/${id}: no ${to}`);
					return { model, thinkingLevel: request.thinkingLevel };
				},
			});
		}
		const api = `${provider}-api`;
		const core = createFauxCore({
			api,
			provider,
			models: script.models.map((id) => ({ id })),
			...(script.tokensPerSecond ? { tokensPerSecond: script.tokensPerSecond } : {}),
			...(script.tokenSize ? { tokenSize: script.tokenSize } : {}),
		});
		const steps = [...(script.steps ?? [])];
		core.setResponses(
			Array.from({ length: steps.length + 64 }, () => async (context: FauxContext) => {
				const step = nextStep(steps, context);
				if (step?.delayMs) await new Promise((resolve) => setTimeout(resolve, step.delayMs));
				return respond(step, context);
			}),
		);
		pi.registerProvider(provider, {
			baseUrl: "http://127.0.0.1:9",
			apiKey: "faux",
			api,
			streamSimple: withOpenSilence(core.streamSimple as StreamSimple, steps),
			models: script.models.map((id) => ({
				id,
				name: id,
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: script.contextWindow ?? 200_000,
				maxTokens: 8_192,
			})),
		});
	}
}
