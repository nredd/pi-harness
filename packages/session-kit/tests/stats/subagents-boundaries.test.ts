import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as jsonl from "../../src/stats/jsonl.ts";
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
	root = await mkdtemp(join(tmpdir(), "agent-report-boundaries-"));
});
afterEach(async () => {
	vi.restoreAllMocks();
	await rm(root, { recursive: true, force: true });
});

it("keeps initial review spend separate from a resumed run", async () => {
	const parent = join(root, "parent.jsonl");
	const later = "2026-01-02T00:00:00.000Z";
	const dispatch = (id: string, at: string, resume?: string) => ({
		type: "message",
		timestamp: at,
		message: {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					name: "Agent",
					id,
					arguments: { subagent_type: "code-reviewer", prompt: `Axis: Standards ${"b".repeat(40)}`, resume },
				},
			],
		},
	});
	const result = (id: string) => ({
		type: "message",
		message: { role: "toolResult", toolName: "Agent", toolCallId: id, details: { agentId: "12345678" } },
	});
	await file("parent.jsonl", [
		header("p"),
		dispatch("first", timestamp),
		result("first"),
		dispatch("second", later, "12345678"),
		result("second"),
	]);
	await file("child.jsonl", [
		header("c", parent),
		info("code-reviewer#12345678"),
		call("first"),
		call("second", { total: 3 }, { timestamp: later }),
	]);
	const report = await reportSubagents(root);
	expect(report.groups.map((g) => [g.traffic, g.recordedCost])).toEqual([
		["retry-repeat", 3],
		["review-standards", 2],
	]);
	expect(report.totals.calls).toBe(2);
});

it("bounds diagnostics and groups, and counts all hidden rows in totals", async () => {
	const parent = await file("parent.jsonl", [header("p")]);
	const rows = Array.from({ length: 202 }, (_, i) => call(`event-${i}`, 1, { model: `model-${i}` }));
	await file("child.jsonl", [
		header("c", parent),
		info(`${"x".repeat(121)}\u0001#12345678`),
		...rows,
		...Array.from({ length: 25 }, () => "broken"),
		"",
		"\u0000\u0000",
		"",
	]);
	const report = await reportSubagents(root);
	expect(report.groups).toHaveLength(200);
	expect(report).toMatchObject({ omittedGroups: 2, totals: { calls: 202, recordedCost: 202 }, badLines: 25 });
	expect(report.diagnostics).toHaveLength(20);
	expect(report.groups[0]?.agentType.length).toBeLessThanOrEqual(120);
	expect(report.groups[0]?.agentType).not.toContain("\u0001");
});

it("reports genuine permission failures and read races nonfatally", async () => {
	const locked = join(root, "locked");
	await mkdir(locked);
	await chmod(locked, 0);
	try {
		expect(await reportSubagents(root)).toMatchObject({ errors: 1, complete: false });
	} finally {
		await chmod(locked, 0o700);
	}
	await file("race.jsonl", [header("race")]);
	vi.spyOn(jsonl, "feedFile").mockRejectedValueOnce(new Error("read failed"));
	expect(await reportSubagents(root)).toMatchObject({
		errors: 1,
		complete: false,
		diagnostics: [{ reason: "read-file" }],
	});
});

it("handles legacy identity, scalar costs, missing metadata, invalid metadata, and zero-price coverage", async () => {
	const parent = join(root, "parent.jsonl");
	const child = join(root, "child.jsonl");
	await file("parent.jsonl", [
		header("p"),
		{ type: "custom", customType: "subagents:record", data: {} },
		{ type: "custom", customType: "subagents:record", data: { id: "12345678" } },
		{
			type: "message",
			message: {
				role: "assistant",
				content: [
					{ type: "text" },
					{ type: "toolCall", name: "other" },
					{ type: "toolCall", name: "Agent" },
					{ type: "toolCall", name: "Agent", id: "no-prompt", arguments: { subagent_type: "" } },
				],
			},
		},
		{ type: "message", message: { role: "toolResult", toolName: "Agent", toolCallId: "no-prompt", content: [] } },
		{
			type: "message",
			message: { role: "toolResult", toolName: "Agent", toolCallId: "absent-call", details: { agentId: "deleted" } },
		},
		{ type: "message", message: { role: "toolResult", toolName: "Agent", toolCallId: "unlinked" } },
		{
			type: "custom",
			customType: "subagents:workflow",
			data: { progress: [{ recordId: 3 }, { recordId: "12345678" }] },
		},
	]);
	await file("child.jsonl", [
		header("c", parent),
		info("Explore#12345678"),
		call("number", 0),
		call("subtotal", { total: 1, unpriced: true }),
		call("invalid", { total: "bad", unpriced: true, pricedCalls: -1, unpricedCalls: "bad" }),
		call("missing-cost", {}),
	]);
	await file("legacy.jsonl", [
		{ type: "session", parentSession: parent },
		info("Explore#87654321"),
		{ type: "session_info", name: "ignored" },
		{ type: "custom", customType: "subagents:record", data: { id: "87654321", sessionFile: child } },
		call("legacy", 1),
	]);
	const report = await reportSubagents(root);
	expect(report.totals).toMatchObject({ calls: 5, recordedCost: 2, pricedCalls: 3, unpricedCalls: 3 });
	expect(report.missingSessions).toBe(1);
});
