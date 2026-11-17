import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { main } from "../../src/stats/cli.ts";
import { reportSubagents } from "../../src/stats/subagents.ts";

let root: string;
const timestamp = "2026-01-01T00:00:00.000Z";
const header = (id: string, parentSession?: string) => ({ type: "session", id, parentSession, timestamp });
const info = (name: string) => ({ type: "session_info", name, timestamp });
const call = (id: string, cost: unknown = { total: 2 }, extra = {}) => ({
	type: "message",
	id,
	timestamp,
	message: {
		role: "assistant",
		provider: "example",
		model: "model-a",
		timestamp,
		usage: { input: 10, output: 3, cacheRead: 7, cacheWrite: 4, cost },
		...extra,
	},
});
async function file(name: string, entries: unknown[]): Promise<string> {
	const path = join(root, name);
	await writeFile(path, entries.map((entry) => (typeof entry === "string" ? entry : JSON.stringify(entry))).join("\n"));
	return path;
}
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "agent-report-"));
});
afterEach(async () => {
	vi.restoreAllMocks();
	await rm(root, { recursive: true, force: true });
});

it("joins original child names, dedupes copies and parent usage, and preserves hand-computed prices/cache", async () => {
	const parent = await file("parent.jsonl", [
		header("parent"),
		call("parent-api"),
		{ type: "message", message: { role: "toolResult", toolName: "Agent", usage: { input: 9999 }, content: [] } },
	]);
	const entries = [
		header("child", parent),
		info("general-purpose#12345678"),
		call("a"),
		call("b", { total: 0, unpriced: true }),
		call("c", { total: 5, unpriced: true, unpricedCalls: 2, pricedCalls: 3 }),
	];
	const path = await file("child.jsonl", entries);
	await file("copied.jsonl", entries);
	await file("fork.jsonl", [header("fork", parent), call("a")]);
	const before = await readFile(path, "utf8");
	const result = await reportSubagents(root);
	expect(result.totals).toEqual({
		calls: 3,
		input: 30,
		output: 9,
		cacheRead: 21,
		cacheWrite: 12,
		recordedCost: 7,
		pricedCalls: 4,
		unpricedCalls: 3,
	});
	expect(result.groups).toEqual([
		{
			...result.totals,
			agentType: "general-purpose",
			provider: "example",
			model: "model-a",
			workflow: "unknown",
			traffic: "other",
			unmatchedSessions: 0,
			costComplete: false,
		},
	]);
	expect(result).toMatchObject({ complete: false, unmatchedSessions: 0, missingSessions: 0, errors: 0, badLines: 0 });
	expect(await readFile(path, "utf8")).toBe(before);
});

it("reports unknown types, missing/deleted children, malformed/truncated files and missing prices without inventing spend", async () => {
	const child = join(root, "child.jsonl");
	const parent = await file("parent.jsonl", [
		header("p"),
		{
			type: "custom",
			customType: "subagents:record",
			data: { id: "deadbeef-0000", type: "Explore", sessionFile: join(root, "deleted.jsonl") },
		},
	]);
	await file("child.jsonl", [
		header("c", parent),
		{ type: "custom", customType: "session-kit:child", data: { version: 1, sessionId: "c" } },
		call("unknown", undefined, { usage: { input: 1 } }),
		'{"truncated":',
		"[bad]",
		"{bad}",
	]);
	const result = await reportSubagents(root);
	expect(result).toMatchObject({ unmatchedSessions: 2, missingSessions: 1, badLines: 3, complete: false });
	expect(result.groups[0]).toMatchObject({
		agentType: "unknown",
		unmatchedSessions: 1,
		recordedCost: 0,
		unpricedCalls: 1,
	});
	expect(result.diagnostics.map((d) => d.path)).toEqual([child, child, child]);
});

it("uses persisted records for renamed children and workflow progress; identifies explicit review axes and repeat targets", async () => {
	const parent = join(root, "parent.jsonl");
	const sha = "a".repeat(40);
	const tool = (id: string, prompt: string, type = "code-reviewer") => ({
		type: "message",
		timestamp,
		message: {
			role: "assistant",
			content: [{ type: "toolCall", name: "Agent", id, arguments: { subagent_type: type, prompt } }],
		},
	});
	const result = (id: string, agentId: string, details = true) => ({
		type: "message",
		message: {
			role: "toolResult",
			toolName: "Agent",
			toolCallId: id,
			details: details ? { agentId } : {},
			content: [{ text: `Agent ID: ${agentId}` }],
		},
	});
	await file("parent.jsonl", [
		header("p"),
		tool("t1", `Axis: Standards ${sha}`),
		result("t1", "11111111"),
		tool("t2", `Axis: Spec ${sha}`),
		result("t2", "22222222", false),
		tool("t3", `Axis: Standards ${sha}`),
		result("t3", "33333333"),
		{
			type: "custom",
			customType: "subagents:workflow",
			data: { name: "audit", progress: [{ recordId: "22222222", type: "workflow_agent" }] },
		},
		{
			type: "custom",
			customType: "subagents:record",
			data: { id: "44444444", type: "critic", sessionFile: join(root, "d.jsonl") },
		},
	]);
	for (const [name, id] of [
		["a", "11111111"],
		["b", "22222222"],
		["c", "33333333"],
	])
		await file(`${name}.jsonl`, [header(name ?? "", parent), info(`code-reviewer#${id}`), call(name ?? "")]);
	await file("d.jsonl", [header("d", parent), info("renamed"), call("critic")]);
	const report = await reportSubagents(root);
	expect(report.groups.map((g) => [g.traffic, g.workflow, g.calls])).toEqual([
		["review-spec", "audit", 1],
		["retry-repeat", "unknown", 1],
		["review-standards", "unknown", 1],
		["review-critic", "unknown", 1],
	]);
	expect(report).toMatchObject({ complete: true, unmatchedSessions: 0, missingSessions: 0 });
});

it("reports unreadable directory errors without throwing, and missing roots as empty", async () => {
	const notDirectory = await file("not-a-dir", []);
	expect(await reportSubagents(notDirectory)).toMatchObject({
		errors: 1,
		complete: false,
		groups: [],
		diagnostics: [{ path: notDirectory, reason: "read-directory", line: 0 }],
	});
	expect(await reportSubagents(join(root, "absent"))).toMatchObject({ errors: 0, complete: true, groups: [] });
});

it("adds a local-only portable CLI mode and refuses export/input flags", async () => {
	const argv = process.argv;
	const log = vi.spyOn(console, "log").mockImplementation(() => {});
	try {
		await mkdir(join(root, "sessions"));
		process.argv = ["node", "stats", "subagents", "--agent-dir", root];
		await main();
		expect(JSON.parse(log.mock.calls[0]?.[0] as string)).toMatchObject({ groups: [], complete: true });
		process.argv = ["node", "stats", "subagents", "--sessions-dir", root];
		await main();
		process.argv.push("--output", join(root, "output"));
		await expect(main()).rejects.toThrow("usage:");
	} finally {
		process.argv = argv;
	}
});
