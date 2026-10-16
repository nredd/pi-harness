/**
 * Auto session titles: after the first `agent_end` of an unnamed TUI session, one nested model call
 * names it. One attempt, silent on any failure, never overwrites a name.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isChildSession } from "../child.ts";
import type { KitConfig } from "../config.ts";
import { loadModelAliases } from "./aliases.ts";
import {
	buildTitlePrompt,
	contentText,
	firstExchange,
	modelCandidates,
	planModeActive,
	sanitizeTitle,
	TITLE_SYSTEM_PROMPT,
} from "./logic.ts";

const TITLE_TIMEOUT_MS = 20_000;
const TITLE_MAX_TOKENS = 128;

/** First candidate the registry can resolve and has credentials for. */
function resolveModel(ctx: ExtensionContext, titleModel?: string) {
	for (const { provider, id } of modelCandidates(titleModel, loadModelAliases())) {
		const model = ctx.modelRegistry.find(provider, id);
		if (model && ctx.modelRegistry.hasConfiguredAuth(model)) return model;
	}
	return undefined;
}

/** Ask the model for a title; undefined on any failure. */
async function generateTitle(ctx: ExtensionContext, prompt: string, titleModel?: string): Promise<string | undefined> {
	try {
		const model = resolveModel(ctx, titleModel);
		if (!model) return undefined;
		const stream = ctx.modelRegistry.streamSimple(
			model,
			{
				systemPrompt: TITLE_SYSTEM_PROMPT,
				messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }],
			},
			{ maxTokens: TITLE_MAX_TOKENS, signal: AbortSignal.timeout(TITLE_TIMEOUT_MS) },
		);
		const message = await stream.result();
		if (message.stopReason === "error" || message.stopReason === "aborted") return undefined;
		return sanitizeTitle(contentText(message.content));
	} catch {
		return undefined;
	}
}

export function register(pi: ExtensionAPI, config: KitConfig): void {
	let attempted = false;
	let generation = 0;

	pi.on("session_start", () => {
		attempted = false;
		generation++;
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (attempted || ctx.mode !== "tui") return;
		if (ctx.sessionManager.getSessionFile() === undefined) return;
		if (pi.getSessionName()?.trim() || isChildSession(pi)) return;
		const branch = ctx.sessionManager.getBranch();
		// Planning keeps the title for the implementation turn, which names the session from the same prompt.
		if (planModeActive(branch)) return;
		const exchange = firstExchange(branch);
		if (!exchange) return;

		attempted = true;
		const started = generation;
		const title = await generateTitle(ctx, buildTitlePrompt(exchange), config.titleModel);
		if (!title || started !== generation || pi.getSessionName()?.trim()) return;
		try {
			pi.setSessionName(title);
		} catch {
			// The session may have been replaced while the model call ran.
		}
	});
}
