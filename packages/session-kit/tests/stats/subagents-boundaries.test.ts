import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as jsonl from "../../src/stats/jsonl.ts";
import * as load from "../../src/stats/load.ts";
import { nth } from "../../src/stats/nth.ts";
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
		"null",
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

/** Run the report with `SessionParser.finish` rewriting each file's parsed calls. */
async function withMutatedCalls(mutate: (calls: load.CallTuple[]) => load.CallTuple[]) {
	const finish = load.SessionParser.prototype.finish;
	vi.spyOn(load.SessionParser.prototype, "finish").mockImplementation(function (this: load.SessionParser) {
		const out = finish.call(this);
		return { ...out, calls: mutate(out.calls) };
	});
	return reportSubagents(root);
}
async function seedTwoPrices(): Promise<void> {
	const parent = await file("parent.jsonl", [header("p")]);
	await file("child.jsonl", [
		header("c", parent),
		info("Explore#12345678"),
		call("one", { total: 1 }),
		call("five", { total: 5 }, { usage: { input: 20, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 5 } } }),
	]);
}

it("keeps each price on its own call when the parser reorders or drops calls", async () => {
	await seedTwoPrices();
	const reordered = await withMutatedCalls((calls) => [...calls].reverse());
	expect(reordered.totals).toMatchObject({ calls: 2, recordedCost: 6, pricedCalls: 2, unpricedCalls: 0 });
	vi.restoreAllMocks();
	const dropped = await withMutatedCalls((calls) => calls.slice(1));
	expect(dropped).toMatchObject({ priceFallbacks: 0, totals: { calls: 1, recordedCost: 5, pricedCalls: 1 } });
});

it("degrades to unpriced, never a wrong or zero price, when the parser adds or replaces a call", async () => {
	await seedTwoPrices();
	const replaced = await withMutatedCalls((calls) => calls.map((c) => [...c] as load.CallTuple));
	expect(replaced).toMatchObject({ complete: false, priceFallbacks: 2 });
	expect(replaced.totals).toMatchObject({ calls: 2, recordedCost: 0, pricedCalls: 0, unpricedCalls: 2 });
	expect(replaced.groups.every((g) => !g.costComplete)).toBe(true);
	expect(replaced.diagnostics.map((d) => d.reason)).toEqual(["price-fallback", "price-fallback"]);
	vi.restoreAllMocks();
	const added = await withMutatedCalls((calls) =>
		calls.length > 0 ? [...calls, [nth(calls, 0)[0] + 5, ...nth(calls, 0).slice(1)] as load.CallTuple] : calls,
	);
	expect(added.priceFallbacks).toBe(1);
	expect(added.totals).toMatchObject({ recordedCost: 6, pricedCalls: 2, unpricedCalls: 1 });
});

it("does not throw when a deduplicated call has no bound price", async () => {
	await seedTwoPrices();
	const actual = load.flatten;
	vi.spyOn(load, "flatten").mockImplementation((files) => {
		const out = actual(files);
		return Object.keys(files).length > 1 ? { ...out, calls: out.calls.map((c) => ({ ...c, ms: c.ms + 1 })) } : out;
	});
	const report = await reportSubagents(root);
	expect(report).toMatchObject({ complete: false, priceFallbacks: 2 });
	expect(report.totals).toMatchObject({ calls: 2, recordedCost: 0, unpricedCalls: 2 });
});
