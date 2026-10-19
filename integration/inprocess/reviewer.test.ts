/** A real package agent's scope, not a stub parser's interpretation of its frontmatter. */
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Harness } from "@earendil-works/pi-coding-agent/testing";
import { afterAll, beforeAll, expect, it } from "vitest";
import { makeGitFixture } from "../../packages/dev-tools/test/scenarios/support.ts";
import { agentStack, ask, call, closeAgentStack, GIT_READS, listTools, READS, report } from "./agents-support.ts";
import { isolateStackHome } from "./support.ts";

let home: ReturnType<typeof isolateStackHome>;
let h: Harness;
let fixture: ReturnType<typeof makeGitFixture>;
beforeAll(async () => {
	home = isolateStackHome();
	fixture = makeGitFixture();
	h = await agentStack(home.root);
});
afterAll(async () => {
	if (h) await closeAgentStack(h);
	if (fixture) rmSync(dirname(fixture.repo), { recursive: true, force: true });
	home.cleanup();
});

it("reviewer exposes exactly seven reads plus the refusal helper", async () => {
	const answer = await ask(h, "code-reviewer", [listTools]);
	expect(answer.startsWith("TOOLS "), answer).toBe(true);
	expect(answer.slice(6).trim().split(",").sort()).toEqual([...READS, ...GIT_READS, "SubagentWorkflow"].sort());
});

it("reviewer executes each permitted read", async () => {
	// Shared TS equivalent of integration/harness/git_fixture.py, with a real bare remote.
	const { repo } = fixture;
	const calls: { name: string; args: Parameters<typeof call>[1]; expected: string }[] = [
		{ name: "git_diff", args: { cwd: repo }, expected: "+two" },
		{ name: "git_show", args: { cwd: repo, rev: "HEAD" }, expected: "Initial" },
		{ name: "git_log", args: { cwd: repo }, expected: "Initial" },
		{ name: "git_status", args: { cwd: repo }, expected: "main" },
		{ name: "read", args: { path: join(repo, "a.txt") }, expected: "one" },
		{ name: "grep", args: { pattern: "two", path: join(repo, "a.txt") }, expected: "two" },
		{ name: "find", args: { pattern: "a.txt", path: repo }, expected: "a.txt" },
	];
	for (const entry of calls) {
		const answer = await ask(h, "code-reviewer", [call(entry.name, entry.args), report]);
		expect(answer.startsWith("REPORT\n"), answer).toBe(true);
		expect(answer, entry.name).toContain(entry.expected);
		expect(answer.toLowerCase()).not.toContain("not found");
	}
});

it("reviewer rejects every explicit mutation", async () => {
	const path = join(home.root, "protected.txt");
	const original = "REVIEWER MUST NOT CHANGE THIS\n";
	writeFileSync(path, original);
	const calls: { name: string; args: Parameters<typeof call>[1] }[] = [
		{ name: "edit", args: { path, oldText: original, newText: "CORRUPTED" } },
		{ name: "write", args: { path, content: "CORRUPTED\n" } },
		{ name: "bash", args: { command: `printf CORRUPTED > ${path}` } },
		{ name: "git_commit", args: { subject: "Corrupt fixture", paths: [path], push: false } },
		{ name: "git_worktree_add", args: { branch: "reviewer-mutation" } },
		{ name: "git_worktree_remove", args: { path: home.root, force: true } },
		{ name: "git_worktree_prune", args: { dry_run: false } },
	];
	for (const { name, args } of calls) {
		const answer = await ask(h, "code-reviewer", [call(name, args), report]);
		expect(answer).toContain(`Tool ${name} not found`);
		expect(readFileSync(path, "utf8"), name).toBe(original);
	}
});
