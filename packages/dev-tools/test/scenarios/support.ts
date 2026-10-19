/**
 * Drive dev-tools through a real `AgentSession`: the model's tool calls are faux, everything after
 * them (pi's schema validation, `tool_call` hooks, the real `bash` tool, result serialization) is pi.
 * Runs under Vitest and `bun test`, so it uses no runner-specific API.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import {
	createHarness,
	fauxAssistantMessage,
	fauxToolCall,
	type Harness,
} from "@earendil-works/pi-coding-agent/testing";

export interface ToolCallSpec {
	name: string;
	args: Parameters<typeof fauxToolCall>[1];
}

/** What one tool call returned through pi, as the model and programmatic callers see it. */
export interface ToolOutcome {
	name: string;
	isError: boolean;
	text: string;
	structured: unknown;
}

/** A started session running `extension` in `cwd`, with pi's default tools (including `bash`). */
export async function startSession(extension: ExtensionFactory, cwd: string): Promise<Harness> {
	const harness = await createHarness({ cwd, extensionFactories: [extension] });
	await harness.session.bindExtensions({ mode: "print" });
	return harness;
}

let nextCall = 0;

/** Issue `calls` as one model turn and return one outcome per call, in call order. */
export async function runTools<const Calls extends readonly ToolCallSpec[]>(
	harness: Harness,
	calls: Calls,
): Promise<{ [K in keyof Calls]: ToolOutcome }> {
	const ids = calls.map(() => `call-${++nextCall}`);
	harness.setResponses([
		fauxAssistantMessage(
			calls.map((call, i) => fauxToolCall(call.name, call.args, { id: ids[i] })),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("DONE"),
	]);
	await harness.session.prompt("go");
	const ends = new Map(harness.eventsOfType("tool_execution_end").map((event) => [event.toolCallId, event]));
	const outcomes = ids.map((id, i): ToolOutcome => {
		const end = ends.get(id);
		if (!end) throw new Error(`${calls[i]?.name} (${id}) never settled`);
		const result = end.result as { content?: { type: string; text?: string }[]; structuredContent?: unknown };
		return {
			name: end.toolName,
			isError: end.isError,
			text: (result.content ?? []).flatMap((part) => (part.type === "text" ? [part.text ?? ""] : [])).join("\n"),
			structured: result.structuredContent,
		};
	});
	return outcomes as { [K in keyof Calls]: ToolOutcome };
}

const GIT_IDENTITY = ["-c", "user.name=h", "-c", "user.email=h@h", "-c", "commit.gpgsign=false"];

/** Run git in `cwd` with a fixed identity and no signing; returns stdout. */
export function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", [...GIT_IDENTITY, "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8" });
}

/**
 * A clone of a bare remote holding one of every working-tree state: an unstaged edit (`a.txt`), a
 * staged add (`c.txt`), a staged rename (`old.txt` -> `renamed.txt`) and an untracked file with a space.
 */
export function makeGitFixture(): { repo: string; remote: string } {
	const root = mkdtempSync(join(tmpdir(), "pi-dev-tools-scenario-"));
	const remote = join(root, "remote.git");
	const repo = join(root, "repo");
	execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
	git(root, "clone", "-q", remote, repo);
	for (const [key, value] of [
		["user.name", "h"],
		["user.email", "h@h"],
		["commit.gpgsign", "false"],
	] as const)
		git(repo, "config", key, value);
	writeFileSync(join(repo, "a.txt"), "one\n");
	writeFileSync(join(repo, "b.txt"), "b\n");
	writeFileSync(join(repo, "old.txt"), "same\n");
	git(repo, "add", "a.txt", "b.txt", "old.txt");
	git(repo, "commit", "-q", "-m", "Initial");
	git(repo, "push", "-q", "-u", "origin", "main");
	writeFileSync(join(repo, "a.txt"), "one\ntwo\n");
	writeFileSync(join(repo, "c.txt"), "c\n");
	writeFileSync(join(repo, "spaced name.txt"), "n\n");
	git(repo, "mv", "old.txt", "renamed.txt");
	git(repo, "add", "c.txt");
	return { repo, remote };
}
