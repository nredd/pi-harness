/** Nested calls meet both the independently owned workflow tool and subagents' scoped gate. */
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Harness } from "@earendil-works/pi-coding-agent/testing";
import { afterAll, beforeAll, expect, it } from "vitest";
import { agentStack, ask, call, closeAgentStack, jsonFile, report } from "./agents-support.ts";
import { isolateStackHome, loadThirdParty } from "./support.ts";

let home: ReturnType<typeof isolateStackHome>;
let h: Harness;
beforeAll(async () => {
	home = isolateStackHome();
	jsonFile(join(home.root, ".pi/workflows/settings.json"), { keywordTriggerEnabled: false });
	jsonFile(join(home.root, "agent/deferred-tools.json"), {
		alwaysActive: ["Agent", "read", "bash"],
		neverDefer: ["Agent"],
	});
	h = await agentStack(home.root, {
		factories: [await loadThirdParty("workflow"), await loadThirdParty("deferred")],
		packages: [
			fileURLToPath(new URL("../", import.meta.resolve("@quintinshaw/pi-dynamic-workflows"))),
			fileURLToPath(new URL("./", import.meta.resolve("pi-deferred-context-engine"))),
		],
	});
});
afterAll(async () => {
	if (h) await closeAgentStack(h);
	home.cleanup();
});

it("child refuses promoted workflow and background Agent with reasons", async () => {
	const answer = await ask(h, "general-purpose", [
		call("search_tools", { query: "workflow", kind: "tool" }),
		call("workflow", { script: "export const meta = { name: 'x', description: 'x' }" }),
		call("Agent", { subagent_type: "general-purpose", description: "inner", prompt: "x", run_in_background: true }),
		report,
	]);
	expect(answer).toContain("Workflows are not available inside a subagent");
	expect(answer).toContain("Background agents are not available inside a subagent");
});
