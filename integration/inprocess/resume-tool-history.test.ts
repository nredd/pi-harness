/**
 * Regression nredd/pi-harness#435/#593: resuming after a deferred promotion must not 400 on tool history.
 * Downstream guard only: core owns the fix (nredd/pi#16, `harness-435-orphan-tool-removal.test.ts`).
 * pi-subagents resumes with `session.prompt` on the same session, which is what test 1 drives.
 */
import { join } from "node:path";
import type { Model, TranscriptContext } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { fauxAssistantMessage } from "@earendil-works/pi-coding-agent/testing";
import { toolCall } from "@nredd/pi-test-lib/faux";
import type { Harness } from "@nredd/pi-test-lib/harness";
import { afterEach, expect, it, vi } from "vitest";
import { jsonFile } from "./agents-support.ts";
import { isolateResearchPackages, isolateStackHome, loadThirdParty, startStack } from "./support.ts";

/** The deferred tool `search_tools` promotes; the original reports named `web_enable`, but any promoted tool applies. */
const PROMOTED = "web_search";

const anthropic: Model<"anthropic-messages"> = {
	id: "claude-sonnet-5-5",
	name: "Claude Sonnet 5.5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "http://127.0.0.1:9",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100000,
	maxTokens: 1000,
	compat: { supportsMidConvoSystemMessages: true, supportsMidConvoToolChanges: true },
};

interface WireBlock {
	type: string;
	tool?: { name?: string; definition?: { name: string } };
}
interface WirePayload {
	betas?: string[];
	tools?: { name: string }[];
	messages: { role: string; content: string | WireBlock[] }[];
}
class PayloadCaptured extends Error {}

/** Build the Anthropic payload the session would send, without any network access. */
async function wirePayload(context: TranscriptContext): Promise<WirePayload> {
	let captured: WirePayload | undefined;
	await streamSimple(anthropic, context, {
		apiKey: "test-key",
		onPayload: (payload) => {
			captured = payload as WirePayload;
			throw new PayloadCaptured();
		},
	}).result();
	if (!captured) throw new Error("expected an Anthropic payload");
	return captured;
}

/** Tools the request's system messages remove; proves the scenario produced the history under test. */
function removedTools(context: TranscriptContext): string[] {
	return context.messages.flatMap((message) =>
		message.role === "system"
			? (message.toolsRemoved ?? []).map((tool) => (typeof tool === "string" ? tool : tool.name))
			: [],
	);
}

/**
 * Converter beta that marks native mid-conversation tool changes (pi-ai `INLINE_TOOLS_BETA`, unexported).
 * Without native mode the converter emits no `tool_removal` at all and `unresolved` would pass vacuously.
 */
const NATIVE_TOOL_CHANGES_BETA = "inline-tools-2026-09-15";

/** Wire payload, required to use native tool changes so `unresolved` cannot pass vacuously. */
async function nativePayload(request: TranscriptContext): Promise<WirePayload> {
	const payload = await wirePayload(request);
	expect(payload.betas ?? []).toContain(NATIVE_TOOL_CHANGES_BETA);
	return payload;
}

/** Names Anthropic rejects with `tool_reference_unresolved`: removals of tools the request never declared. */
function unresolved(payload: WirePayload): string[] {
	const declared = new Set(payload.tools?.map((tool) => tool.name));
	const bad: string[] = [];
	for (const message of payload.messages) {
		if (message.role !== "system" || typeof message.content === "string") continue;
		for (const block of message.content) {
			if (block.type === "tool_addition" && block.tool?.definition) declared.add(block.tool.definition.name);
			if (block.type === "tool_removal" && block.tool?.name && !declared.delete(block.tool.name)) {
				bad.push(block.tool.name);
			}
		}
	}
	return bad;
}

let home: Awaited<ReturnType<typeof isolateStackHome>> | undefined;
let restore: (() => void) | undefined;
let started: Harness | undefined;

/** Build a fresh stack per test so each runs alone; `promotionLifetime` is the engine setting under test. */
async function start(promotionLifetime: "run" | "session"): Promise<Harness> {
	home = await isolateStackHome();
	restore = isolateResearchPackages(home.root);
	vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
		throw new Error("Resume tool-history test must stay offline");
	});
	jsonFile(join(home.root, "agent/deferred-tools.json"), {
		promotionLifetime,
		replaceAlwaysActive: true,
		alwaysActive: ["read", "search_tools", "demote_tools"],
	});
	const h = await startStack({
		cwd: home.root,
		factories: [await loadThirdParty("web"), await loadThirdParty("deferred")],
	});
	started = h;
	return h;
}
afterEach(async () => {
	try {
		if (started) {
			await started.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			started.cleanup();
		}
	} finally {
		started = undefined;
		vi.restoreAllMocks();
		restore?.();
		restore = undefined;
		await home?.cleanup();
		home = undefined;
	}
});

it("resume after a promoted deferred tool went inactive declares no orphan tool removal", async () => {
	// Explicit `promotionLifetime: "run"` (the engine default): the engine's agent_settled handler resets promotions after the first run.
	const h = await start("run");
	h.setResponses([
		toolCall("search_tools", { query: "web search capability", limit: 1, kind: "tool" }),
		fauxAssistantMessage("done"),
	]);
	await h.session.prompt("find a web tool");

	// agent_settled -> synchronize({ resetPromotions: true }) deactivates the promoted tool; resume is a plain prompt.
	expect(h.session.getActiveToolNames()).not.toContain(PROMOTED);
	let request: TranscriptContext | undefined;
	h.setResponses([
		(ctx) => {
			request = ctx;
			return fauxAssistantMessage("resumed");
		},
	]);
	await h.session.prompt("read it again");
	if (!request) throw new Error("expected the resumed request");
	expect(removedTools(request)).toContain(PROMOTED);
	expect(unresolved(await nativePayload(request))).toEqual([]);
});

it("continuing a run after demoting a promoted deferred tool declares no orphan tool removal", async () => {
	const h = await start("session");
	let request: TranscriptContext | undefined;
	h.setResponses([
		toolCall("search_tools", { query: "web search capability", limit: 1, kind: "tool" }),
		toolCall("demote_tools", { names: [PROMOTED] }),
		(ctx) => {
			request = ctx;
			return fauxAssistantMessage("done");
		},
	]);
	await h.session.prompt("promote, then demote");
	expect(h.session.getActiveToolNames()).not.toContain(PROMOTED);
	if (!request) throw new Error("expected the continuation request");
	expect(removedTools(request)).toContain(PROMOTED);
	expect(unresolved(await nativePayload(request))).toEqual([]);
});
