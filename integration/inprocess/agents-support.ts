/** Package-discovered preset agents and genuine child sessions sharing the parent's faux transport. */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import {
	fauxAssistantMessage,
	fauxToolCall,
	getMessageText,
	type Harness,
} from "@earendil-works/pi-coding-agent/testing";
import { expect } from "vitest";
import { loadFork, startStack } from "./support.ts";

export type Step = Parameters<Harness["setResponses"]>[0][number];
export const ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const READS = ["read", "grep", "find"];
export const GIT_READS = ["git_diff", "git_show", "git_log", "git_status"];
export const WEB = ["web_search", "fetch_content", "source_check", "get_search_content"];
export const MUTATIONS = [
	"edit",
	"write",
	"bash",
	"git_commit",
	"git_worktree_add",
	"git_worktree_remove",
	"git_worktree_prune",
];

/** Persist fixture configuration, ensuring no global install output is ever consulted. */
export function jsonFile(path: string, data: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(data));
}

/** One model call, with no test-side dispatch of tools. */
export function call(name: string, args: Parameters<typeof fauxToolCall>[1]): Step {
	return fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
}

/** Echo actual child results, including unavailable-tool errors, as its final report. */
export const report: Step = (ctx) =>
	fauxAssistantMessage(
		`REPORT\n${ctx.messages
			.filter((m) => m.role === "toolResult")
			.map((m) => getMessageText(m))
			.join("\n")}`,
	);

/** List only the schemas supplied to the child provider request. */
export const listTools: Step = (ctx) =>
	fauxAssistantMessage(
		`TOOLS ${getCurrentTools(ctx.messages)
			.map((t) => t.name)
			.sort()
			.join(",")}`,
	);

/** Actual subagents factory; its runner discovers the preset package and the real dev-tools entry. */
export async function agentStack(
	root: string,
	options: {
		first?: ExtensionFactory[];
		factories?: ExtensionFactory[];
		packages?: string[];
		subagents?: Record<string, unknown>;
	} = {},
): Promise<Harness> {
	const agentDir = join(root, "agent");
	jsonFile(join(agentDir, "settings.json"), {
		packages: [join(ROOT, "packages/preset"), join(ROOT, "packages/dev-tools"), ...(options.packages ?? [])],
	});
	jsonFile(join(agentDir, "subagents.json"), {
		rememberAgents: false,
		outputTranscript: false,
		maxSubagentDepth: 2,
		...options.subagents,
	});
	return startStack({
		cwd: root,
		factories: [...(options.first ?? []), await loadFork("pi-subagents"), ...(options.factories ?? [])],
	});
}

/** Foreground Agent entry, child turn(s), then parent completion, all on the real shared runtime. */
export async function ask(
	h: Harness,
	type: string,
	steps: Step[],
	extra: Record<string, unknown> = {},
): Promise<string> {
	const before = h.eventsOfType("tool_execution_end").length;
	h.setResponses([
		call("Agent", {
			subagent_type: type,
			description: `run ${type}`,
			prompt: "work",
			model: `${h.getModel().provider}/${h.getModel().id}`,
			run_in_background: false,
			...extra,
		}),
		...steps,
		fauxAssistantMessage("PARENT DONE"),
	]);
	await h.session.prompt(`run ${type}`);
	const ends = h
		.eventsOfType("tool_execution_end")
		.slice(before)
		.filter((e) => e.toolName === "Agent");
	expect(ends).toHaveLength(1);
	const end = ends[0];
	if (!end) throw new Error("Agent never settled");
	const text = getMessageText(end.result);
	expect(end.isError, text).toBe(false);
	expect(h.getPendingResponseCount(), text).toBe(0);
	const separator = text.indexOf("\n\n");
	expect(separator, text).toBeGreaterThanOrEqual(0);
	return text.slice(separator + 2);
}

/** Abort and drain unfinished turns before shutting down child resources and disposing the host. */
export async function closeAgentStack(h: Harness): Promise<void> {
	try {
		await h.session.abort();
		await h.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
	} finally {
		h.cleanup();
	}
}
