/**
 * Regression nredd/pi-harness#582: a profile switch that removes tools from a resumed session must be
 * reported to the user and the model, and a later call to a removed tool must say it is unavailable.
 * Downstream guard only: core owns the behavior (nredd/pi#19 notice, nredd/pi#27 result wording).
 */
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { type ExtensionFactory, SessionManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall, type Harness } from "@earendil-works/pi-coding-agent/testing";
import { Type } from "typebox";
import { afterEach, beforeEach, expect, it } from "vitest";
import { isolateStackHome, loadThirdParty, startStack } from "./support.ts";

/** Tools only the "wide" profile registers; the narrow (enterprise-like) profile drops both. */
const WIDE_ONLY = ["ssh_exec", "monitor_start"];

const wideProfile: ExtensionFactory = (pi) => {
	for (const name of WIDE_ONLY) {
		pi.registerTool({
			name,
			label: name,
			description: name,
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "ran" }], details: {} }),
		});
	}
};

let home: Awaited<ReturnType<typeof isolateStackHome>> | undefined;
const started: Harness[] = [];

beforeEach(async () => {
	home = await isolateStackHome();
});
afterEach(async () => {
	for (const h of started.splice(0)) h.cleanup();
	await home?.cleanup();
	home = undefined;
});

/** Persist one session under the wide profile and copy its transcript, as a profile switch would reopen it. */
async function persistWideSession(root: string): Promise<string> {
	const wide = await startStack({
		cwd: root,
		sessionManager: SessionManager.create(root, root),
		factories: [wideProfile],
	});
	try {
		wide.setResponses([fauxAssistantMessage("initial")]);
		await wide.session.prompt("first");
		const file = wide.sessionManager.getSessionFile();
		if (!file) throw new Error("wide session was not persisted");
		const copy = join(mkdtempSync(join(tmpdir(), "pi-582-")), "source.jsonl");
		copyFileSync(file, copy);
		return copy;
	} finally {
		wide.cleanup();
	}
}

it("a profile switch that removes tools warns user and model, then explains an unavailable call", async () => {
	if (!home) throw new Error("home not isolated");
	const source = await persistWideSession(home.root);
	try {
		const narrow = await startStack({
			cwd: home.root,
			sessionManager: SessionManager.open(source),
			factories: [await loadThirdParty("deferred")],
		});
		started.push(narrow);
		narrow.session.agent.state.messages = narrow.sessionManager.buildSessionContext().messages;
		const requests: TranscriptContext[] = [];
		narrow.setResponses([
			(context) => {
				requests.push(structuredClone(context));
				return fauxAssistantMessage([fauxToolCall("monitor_start", {})], { stopReason: "toolUse" });
			},
			fauxAssistantMessage("done"),
		]);
		await narrow.session.prompt("second");

		// User: a displayed custom notice naming every removed tool.
		const notices = narrow.session.messages.flatMap((message) =>
			message.role === "custom" && message.customType === "unregistered-tools-notice" ? [message] : [],
		);
		expect(notices).toHaveLength(1);
		expect(notices[0]?.display).toBe(true);
		const notice = JSON.stringify(notices[0]?.content);
		for (const name of WIDE_ONLY) expect(notice).toContain(name);

		// Model: the very first request already carries the notice and the removals.
		const first = requests[0];
		if (!first) throw new Error("expected the first request");
		expect(JSON.stringify(first)).toContain("no longer available");
		const removed = first.messages.flatMap((message) =>
			message.role === "system" ? (message.toolsRemoved ?? []).map((tool) => tool.name) : [],
		);
		expect(removed).toEqual(expect.arrayContaining(WIDE_ONLY));

		// A later call is an error naming the tool. Core pins the exact wording (nredd/pi#27); the pinned
		// release may still say "not found", so this guard only requires an error that names the tool.
		const result = narrow.session.messages.find((message) => message.role === "toolResult");
		expect(result?.isError).toBe(true);
		expect(JSON.stringify(result?.content)).toContain("monitor_start");
	} finally {
		rmSync(source, { force: true });
	}
});
