/** Regression nredd/pi-harness#435/#593: resuming after a deferred promotion must not 400 on tool history. */
import { join } from "node:path";
import type { Model, TranscriptContext } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { fauxAssistantMessage, type Harness } from "@earendil-works/pi-coding-agent/testing";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { call, jsonFile } from "./agents-support.ts";
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

let home: Awaited<ReturnType<typeof isolateStackHome>>;
let restore: () => void;
let h: Harness;
beforeAll(async () => {
	home = await isolateStackHome();
	restore = isolateResearchPackages(home.root);
	vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
		throw new Error("Resume tool-history test must stay offline");
	});
	jsonFile(join(home.root, "agent/deferred-tools.json"), {
		promotionLifetime: "session",
		replaceAlwaysActive: true,
		alwaysActive: ["read", "search_tools", "demote_tools"],
	});
	h = await startStack({
		cwd: home.root,
		factories: [await loadThirdParty("web"), await loadThirdParty("deferred")],
	});
});
afterAll(async () => {
	try {
		if (h) {
			await h.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			h.cleanup();
		}
	} finally {
		vi.restoreAllMocks();
		restore?.();
		await home.cleanup();
	}
});

it("resume after a promoted deferred tool went inactive declares no orphan tool removal", async () => {
	h.setResponses([
		call("search_tools", { query: "web search capability", limit: 1, kind: "tool" }),
		fauxAssistantMessage("done"),
	]);
	await h.session.prompt("find a web tool");
	expect(h.session.getActiveToolNames()).toContain(PROMOTED);

	// session_start in a resumed child re-selects its tools and drops the promoted tool again.
	h.session.setActiveToolsByName(h.session.getActiveToolNames().filter((name) => name !== PROMOTED));
	let request: TranscriptContext | undefined;
	h.setResponses([
		(ctx) => {
			request = ctx;
			return fauxAssistantMessage("resumed");
		},
	]);
	await h.session.prompt("read it again");
	if (!request) throw new Error("expected the resumed request");
	expect(unresolved(await wirePayload(request))).toEqual([]);
});

it("continuing a run after demoting a promoted deferred tool declares no orphan tool removal", async () => {
	let request: TranscriptContext | undefined;
	h.setResponses([
		call("search_tools", { query: "web search capability", limit: 1, kind: "tool" }),
		call("demote_tools", { names: [PROMOTED] }),
		(ctx) => {
			request = ctx;
			return fauxAssistantMessage("done");
		},
	]);
	await h.session.prompt("promote, then demote");
	expect(h.session.getActiveToolNames()).not.toContain(PROMOTED);
	if (!request) throw new Error("expected the continuation request");
	expect(unresolved(await wirePayload(request))).toEqual([]);
});
