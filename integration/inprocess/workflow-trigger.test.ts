/** Pinned third-party workflow input hook with caller-owned settings, not live state. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	createTestUiContext,
	fauxAssistantMessage,
	getAssistantTexts,
	getUserTexts,
	type Harness,
} from "@earendil-works/pi-coding-agent/testing";
import { afterAll, beforeAll, expect, it } from "vitest";
import { isolateStackHome, loadThirdParty, startStack } from "./support.ts";

let home: ReturnType<typeof isolateStackHome>;
let h: Harness;
beforeAll(async () => {
	home = isolateStackHome();
	const settings = join(home.root, ".pi", "workflows");
	mkdirSync(settings, { recursive: true });
	writeFileSync(join(settings, "settings.json"), JSON.stringify({ keywordTriggerEnabled: false }));
	h = await startStack({
		cwd: home.root,
		mode: "rpc",
		ui: createTestUiContext(),
		factories: [await loadThirdParty("workflow")],
	});
});
afterAll(async () => {
	if (h) {
		await h.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		h.cleanup();
	}
	home.cleanup();
});

it("workflow mentions do not rewrite prompts when keyword triggering is disabled", async () => {
	const prompt = "check .github/workflows and the dynamic workflows docs";
	let request = "";
	h.setResponses([
		(ctx) => {
			request = JSON.stringify(ctx.messages);
			return fauxAssistantMessage("OK");
		},
	]);
	await h.session.prompt(prompt);
	expect(getUserTexts(h)).toEqual([prompt]);
	expect(getAssistantTexts(h)).toEqual(["OK"]);
	expect(request).not.toContain("you typed the workflow trigger word");
});
