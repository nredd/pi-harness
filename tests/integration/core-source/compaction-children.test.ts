/** #751: genuine subagent sessions share candidate core policy, not parent settings state. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	createHarness,
	fauxAssistantMessage,
	fauxToolCall,
	getMessageText,
} from "@earendil-works/pi-coding-agent/testing";
import { loadFactory } from "../inprocess/support.ts";

const subagents = await loadFactory(new URL("../../packages/subagents/dist/index.ts", import.meta.url));

for (const routed of [false, true]) {
	test(`candidate core compacts ${routed ? "routed" : "direct"} children with child-local settings`, async () => {
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		const root = mkdtempSync(join(tmpdir(), "pi-policy-child-"));
		try {
			const agentDir = join(root, "agent");
			mkdirSync(join(agentDir, "agents"), { recursive: true });
			process.env.PI_CODING_AGENT_DIR = agentDir;
			const extension = join(root, "checkpoint.ts");
			writeFileSync(
				extension,
				`export default function(pi) {
			pi.on("session_before_compact", ({ preparation }) => ({ compaction: {
				summary: "CHILD CHECKPOINT", firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: preparation.tokensBefore
			} }));
		}`,
			);
			writeFileSync(
				join(agentDir, "agents/reader.md"),
				`---\nname: reader\ndescription: Policy fixture\ntools: read\nextensions: [${extension}]\nskills: false\n---\nRead the fixture and report.\n`,
			);
			writeFileSync(
				join(agentDir, "subagents.json"),
				JSON.stringify({ rememberAgents: false, outputTranscript: false, packageAgents: false }),
			);
			const fixture = join(root, "large.txt");
			writeFileSync(fixture, "fixture payload ".repeat(3000));
			const settingsPath = join(agentDir, "settings.json");
			const childSettings = (targetTokens: number | "auto") =>
				writeFileSync(
					settingsPath,
					JSON.stringify({ compaction: { targetTokens, reserveTokens: 2000, keepRecentTokens: 1 } }),
				);
			childSettings("auto");
			const h = await createHarness({
				cwd: root,
				models: [
					{ id: "parent", contextWindow: 1000000 },
					{ id: "physical", contextWindow: 20000 },
				],
				settings: { compaction: { targetTokens: 70000, reserveTokens: 2000, keepRecentTokens: 20000 } },
				extensionFactories: [
					subagents,
					(pi) => {
						pi.registerVirtualModel({
							provider: "router",
							id: "policy",
							name: "Policy",
							route(_request, ctx) {
								const model = ctx.modelRegistry.find("faux", "physical");
								assert.ok(model);
								return { model, thinkingLevel: "off" };
							},
						});
					},
				],
			});
			try {
				await h.session.bindExtensions({ mode: "print" });
				assert.equal(h.settingsManager.getCompactionTargetTokens(), 70000);
				for (const compacted of [true, false]) {
					childSettings(compacted ? "auto" : 70000);
					const model = routed ? "router/policy" : "faux/physical";
					h.setResponses([
						fauxAssistantMessage(
							fauxToolCall("Agent", {
								subagent_type: "reader",
								description: "Verify policy",
								prompt: "Read the file",
								model,
								run_in_background: false,
							}),
							{ stopReason: "toolUse" },
						),
						fauxAssistantMessage(fauxToolCall("read", { path: fixture }), { stopReason: "toolUse" }),
						(context) => {
							const checkpoint = JSON.stringify(context.messages).includes("CHILD CHECKPOINT");
							assert.equal(checkpoint, compacted, "child must use its own target, even on a shared runtime");
							return fauxAssistantMessage(checkpoint ? "COMPACTED" : "UNCHANGED");
						},
						fauxAssistantMessage("PARENT DONE"),
					]);
					await h.session.prompt("Run the reader");
					const result = h
						.eventsOfType("tool_execution_end")
						.filter((event) => event.toolName === "Agent")
						.at(-1);
					assert.ok(result);
					assert.equal(result.isError, false, getMessageText(result.result));
					assert.match(getMessageText(result.result), compacted ? /COMPACTED/ : /UNCHANGED/);
					assert.equal(h.getPendingResponseCount(), 0);
					assert.equal(h.settingsManager.getCompactionTargetTokens(), 70000);
					assert.equal(h.eventsOfType("compaction_start").length, 0, "child policy must not mutate parent policy");
				}
			} finally {
				try {
					await h.session.abort();
					await h.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
				} finally {
					h.cleanup();
				}
			}
		} finally {
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			rmSync(root, { recursive: true, force: true });
		}
	});
}
