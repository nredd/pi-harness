import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	Model,
	SimpleStreamOptions,
	TranscriptContext,
} from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionVirtualModel,
	ProviderConfig,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, test, vi } from "vitest";
import harnessFaux from "./faux.ts";

let root = "";

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "faux-provider-"));
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
	rmSync(root, { recursive: true, force: true });
});

/** The model fields `faux.ts` sets; `ProviderModelConfig` is a union over model kinds. */
type ChatModel = { id: string; contextWindow?: number; maxTokens?: number };

interface Registered {
	providers: Map<string, ProviderConfig>;
	virtual: ExtensionVirtualModel[];
}

/** Load `faux.ts` with `script` as `HARNESS_SCRIPT` (none when undefined) against a recording API. */
function register(script?: unknown): Registered {
	if (script === undefined) vi.stubEnv("HARNESS_SCRIPT", "");
	else {
		const path = join(root, "script.json");
		writeFileSync(path, JSON.stringify(script));
		vi.stubEnv("HARNESS_SCRIPT", path);
	}
	const providers = new Map<string, ProviderConfig>();
	const virtual: ExtensionVirtualModel[] = [];
	const api = {
		registerProvider: (name: string, config: ProviderConfig) => providers.set(name, config),
		registerVirtualModel: (model: ExtensionVirtualModel) => virtual.push(model),
	} as unknown as ExtensionAPI;
	harnessFaux(api);
	return { providers, virtual };
}

function modelOf(provider: string, id = "main"): Model<Api> {
	return { id, api: `${provider}-api`, provider } as Model<Api>;
}

function blocks(text: string): { type: "text"; text: string }[] {
	return [{ type: "text", text }];
}

function toolResult(text: string): Record<string, unknown> {
	return { role: "toolResult", toolName: "bash", content: blocks(text) };
}

/** A transcript from loosely shaped messages: the faux reads only roles, content and tool declarations. */
function context(...messages: Record<string, unknown>[]): TranscriptContext {
	return { messages } as unknown as TranscriptContext;
}

/** Stream one request and collect every event plus the final message. */
function ask(
	registered: Registered,
	provider: string,
	transcript: TranscriptContext = context(),
	options?: SimpleStreamOptions,
): { events: AssistantMessageEvent[]; result: Promise<AssistantMessage> } {
	const config = registered.providers.get(provider);
	assert.ok(config?.streamSimple);
	const stream = config.streamSimple(modelOf(provider), transcript, options);
	const events: AssistantMessageEvent[] = [];
	const result = (async () => {
		for await (const event of stream) events.push(event);
		return stream.result();
	})();
	return { events, result };
}

function texts(message: AssistantMessage | undefined): string[] {
	assert.ok(message);
	return message.content.map((block) => {
		if (block.type === "text") return `text:${block.text}`;
		if (block.type === "thinking") return `thinking:${block.thinking}`;
		return `tool:${block.name}:${JSON.stringify(block.arguments)}`;
	});
}

test("without HARNESS_SCRIPT one provider `faux` serves model `main` and answers DONE", async () => {
	const registered = register();
	assert.deepEqual([...registered.providers.keys()], ["faux"]);
	assert.deepEqual(registered.virtual, []);
	const config = registered.providers.get("faux");
	assert.equal(config?.api, "faux-api");
	assert.equal(config?.baseUrl, "http://127.0.0.1:9");
	assert.deepEqual(
		(config?.models as ChatModel[] | undefined)?.map((model) => [model.id, model.contextWindow, model.maxTokens]),
		[["main", 200_000, 8_192]],
	);
	const { result } = ask(registered, "faux");
	const message = await result;
	assert.equal(message.stopReason, "stop");
	assert.deepEqual(texts(message), ["text:DONE"]);
});

test("each scripted step shape becomes the matching assistant message, then DONE once steps run out", async () => {
	const registered = register({
		providers: {
			alpha: {
				models: ["one", "two"],
				contextWindow: 1_000,
				steps: [
					{ text: "hello", thinking: "pondering" },
					{ thinking: "only thinking" },
					{ tools: [{ name: "bash", args: { command: "ls", timeout: 5 } }] },
					{ tools: [{ name: "read", args: { path: "x" } }], text: "narrating", thinking: "plan" },
					{ error: "scripted failure" },
				],
			},
		},
	});
	assert.deepEqual(
		(registered.providers.get("alpha")?.models as ChatModel[] | undefined)?.map((model) => [
			model.id,
			model.contextWindow,
		]),
		[
			["one", 1_000],
			["two", 1_000],
		],
	);
	const replies: AssistantMessage[] = [];
	for (let i = 0; i < 6; i++) replies.push(await ask(registered, "alpha").result);
	assert.deepEqual(texts(replies[0]), ["thinking:pondering", "text:hello"]);
	assert.deepEqual(texts(replies[1]), ["thinking:only thinking", "text:DONE"]);
	assert.equal(replies[2]?.stopReason, "toolUse");
	assert.deepEqual(texts(replies[2]), ['tool:bash:{"command":"ls","timeout":5}']);
	assert.deepEqual(texts(replies[3]), ["thinking:plan", "text:narrating", 'tool:read:{"path":"x"}']);
	assert.equal(replies[4]?.stopReason, "error");
	assert.equal(replies[4]?.errorMessage, "scripted failure");
	assert.deepEqual(texts(replies[5]), ["text:DONE"]);
});

test("report, listTools, echoUsers and echoLast read the transcript the request carries", async () => {
	const registered = register({
		providers: {
			faux: {
				models: ["main"],
				steps: [{ report: true }, { listTools: true }, { echoUsers: true }, { echoLast: true }, { echoLast: true }],
			},
		},
	});
	const transcript = context(
		{ role: "system", content: "base", toolsAdded: [{ name: "write" }, { name: "bash" }] },
		{ role: "user", content: "first" },
		toolResult("stale"),
		{ role: "assistant", content: blocks("calling") },
		{
			role: "toolResult",
			toolName: "read",
			content: [...blocks("line one\n  line   two"), { type: "image", mimeType: "image/png", data: "AAAA" }],
		},
		toolResult(`${"x".repeat(299)}  overflow`),
		{ role: "system", content: "later", toolsRemoved: ["write"], toolsAdded: [{ name: "read" }] },
		{ role: "user", content: blocks("second") },
	);
	const report = await ask(registered, "faux", transcript).result;
	assert.deepEqual(texts(report), [`text:REPORT\nline one line two\n${"x".repeat(299)} `]);
	const tools = await ask(registered, "faux", { ...transcript, tools: [{ name: "grep" }] } as TranscriptContext).result;
	assert.deepEqual(texts(tools), ["text:TOOLS bash,grep,read"]);
	const users = await ask(registered, "faux", transcript).result;
	assert.deepEqual(texts(users), ["text:USERS first | second"]);
	const last = await ask(registered, "faux", transcript).result;
	assert.deepEqual(texts(last), ["text:ECHO second"]);
	const empty = await ask(registered, "faux", context({ role: "assistant", content: blocks("only") })).result;
	assert.deepEqual(texts(empty), ["text:ECHO "]);
});

test("echoLast skips assistant and system messages, and a toolsRemoved object drops its tool", async () => {
	const registered = register({
		providers: { faux: { models: ["main"], steps: [{ echoLast: true }, { listTools: true }] } },
	});
	const transcript = context(
		{ role: "system", content: "base", toolsAdded: [{ name: "bash" }, { name: "edit" }] },
		{ role: "user", content: "rewritten by a context hook" },
		{ role: "assistant", content: blocks("reply") },
		{ role: "system", content: "later", toolsRemoved: [{ name: "edit" }] },
	);
	assert.deepEqual(texts(await ask(registered, "faux", transcript).result), ["text:ECHO rewritten by a context hook"]);
	assert.deepEqual(texts(await ask(registered, "faux", transcript).result), ["text:TOOLS bash"]);
});

test("{{agentId}} in string tool args becomes the newest reported handle, or unknown-agent", async () => {
	const step = { tools: [{ name: "Agent", args: { id: "{{agentId}}", note: "for {{agentId}}", wait: true } }] };
	const registered = register({ providers: { faux: { models: ["main"], steps: [step, step] } } });
	const transcript = context(
		{ role: "user", content: "ID: ffff-user-text-is-ignored" },
		toolResult("started ID: abc-1 then ID: def-2"),
		toolResult("ID: 0123-4567"),
	);
	const withHandle = await ask(registered, "faux", transcript).result;
	assert.deepEqual(texts(withHandle), ['tool:Agent:{"id":"0123-4567","note":"for 0123-4567","wait":true}']);
	const withoutHandle = await ask(registered, "faux").result;
	assert.deepEqual(texts(withoutHandle), ['tool:Agent:{"id":"unknown-agent","note":"for unknown-agent","wait":true}']);
});

test("a whileTools step repeats while tools are offered and is skipped by the first tool-less request", async () => {
	const registered = register({
		providers: {
			faux: {
				models: ["main"],
				steps: [{ whileTools: true, tools: [{ name: "bash", args: { command: "true" } }] }, { text: "final" }],
			},
		},
	});
	const withTools = context({ role: "system", content: "base", toolsAdded: [{ name: "bash" }] });
	for (let i = 0; i < 3; i++) {
		assert.deepEqual(texts(await ask(registered, "faux", withTools).result), ['tool:bash:{"command":"true"}']);
	}
	assert.deepEqual(texts(await ask(registered, "faux").result), ["text:final"]);
	assert.deepEqual(texts(await ask(registered, "faux").result), ["text:DONE"]);
});

test("delayMs holds the reply until the delay passes", async () => {
	const registered = register({ providers: { faux: { models: ["main"], steps: [{ text: "late", delayMs: 500 }] } } });
	const { events, result } = ask(registered, "faux");
	let settled = false;
	void result.then(() => {
		settled = true;
	});
	await vi.advanceTimersByTimeAsync(499);
	assert.equal(settled, false);
	assert.equal(events.length, 0);
	await vi.advanceTimersByTimeAsync(1);
	assert.deepEqual(texts(await result), ["text:late"]);
	assert.equal(events[0]?.type, "start");
});

test("openMs opens the stream with start at once, stays silent, then streams the reply without a second start", async () => {
	const registered = register({
		providers: { faux: { models: ["main"], steps: [{ text: "after silence", openMs: 1_000 }, { text: "next" }] } },
	});
	const { events, result } = ask(registered, "faux");
	await vi.advanceTimersByTimeAsync(0);
	assert.equal(events.length, 1);
	const [start] = events;
	assert.equal(start?.type, "start");
	assert.ok(start?.type === "start");
	assert.equal(start.partial.api, "faux-api");
	assert.equal(start.partial.provider, "faux");
	assert.equal(start.partial.model, "main");
	assert.equal(start.partial.stopReason, "pending");
	assert.deepEqual(start.partial.content, []);
	await vi.advanceTimersByTimeAsync(999);
	assert.equal(events.length, 1);
	await vi.advanceTimersByTimeAsync(1);
	assert.deepEqual(texts(await result), ["text:after silence"]);
	assert.equal(events.filter((event) => event.type === "start").length, 1);
	assert.equal(events.at(-1)?.type, "done");
	// The peeked step was consumed by the core's queue, so the next request gets the next step at once.
	assert.deepEqual(texts(await ask(registered, "faux").result), ["text:next"]);
});

test("aborting during openMs silence ends the wait early and the reply reports the abort", async () => {
	const registered = register({
		providers: { faux: { models: ["main"], steps: [{ text: "never", openMs: 60_000 }] } },
	});
	const controller = new AbortController();
	const { events, result } = ask(registered, "faux", context(), { signal: controller.signal });
	await vi.advanceTimersByTimeAsync(10);
	assert.deepEqual(
		events.map((event) => event.type),
		["start"],
	);
	controller.abort();
	const message = await result;
	assert.equal(message.stopReason, "aborted");
	assert.equal(vi.getTimerCount(), 0);
});

test("tokensPerSecond and tokenSize pace the reply into deltas", async () => {
	const registered = register({
		providers: {
			faux: { models: ["main"], tokensPerSecond: 1, tokenSize: { min: 1, max: 1 }, steps: [{ text: "abcdefgh" }] },
		},
	});
	const { events, result } = ask(registered, "faux");
	await vi.advanceTimersByTimeAsync(999);
	assert.deepEqual(
		events.filter((event) => event.type === "text_delta").map((event) => event.type === "text_delta" && event.delta),
		[],
	);
	await vi.advanceTimersByTimeAsync(1_001);
	assert.deepEqual(texts(await result), ["text:abcdefgh"]);
	assert.deepEqual(
		events.filter((event) => event.type === "text_delta").map((event) => event.type === "text_delta" && event.delta),
		["abcd", "efgh"],
	);
});

test("HARNESS_REQUEST_LOG gets one line per request naming the provider", async () => {
	const registered = register({
		providers: { alpha: { models: ["a"] }, beta: { models: ["b"], steps: [{ text: "b" }] } },
	});
	const log = join(root, "requests.jsonl");
	vi.stubEnv("HARNESS_REQUEST_LOG", log);
	await ask(registered, "beta").result;
	await ask(registered, "alpha").result;
	assert.deepEqual(
		readFileSync(log, "utf8")
			.trim()
			.split("\n")
			.map(JSON.parse as (line: string) => unknown),
		[{ provider: "beta" }, { provider: "alpha" }],
	);
});

test("virtual models route to their physical faux model and fail loudly on a missing target", async () => {
	const registered = register({
		providers: {
			router: {
				models: ["physical"],
				virtual: [
					{ id: "default", to: "router/physical" },
					{ id: "broken", to: "nowhere" },
				],
			},
		},
	});
	const [ok, broken] = registered.virtual;
	assert.ok(ok && broken);
	assert.equal(ok.provider, "router");
	assert.equal(ok.id, "default");
	assert.equal(ok.name, "router default");
	assert.deepEqual(ok.thinkingLevels, ["off", "medium"]);
	const lookups: [string, string][] = [];
	const physical = modelOf("router", "physical");
	const ctx = {
		modelRegistry: {
			find: (provider: string, id: string) => {
				lookups.push([provider, id]);
				return provider === "router" && id === "physical" ? physical : undefined;
			},
		},
	} as unknown as ExtensionContext;
	const request = { thinkingLevel: "medium" } as Parameters<typeof ok.route>[0];
	assert.deepEqual(await ok.route(request, ctx), { model: physical, thinkingLevel: "medium" });
	assert.throws(() => broken.route(request, ctx), /faux virtual model router\/broken: no nowhere/);
	assert.deepEqual(lookups, [
		["router", "physical"],
		["nowhere", ""],
	]);
});
