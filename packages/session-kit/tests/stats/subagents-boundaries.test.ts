import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as jsonl from "../../src/stats/jsonl.ts";
import * as load from "../../src/stats/load.ts";
import { nth } from "../../src/stats/nth.ts";
import { reportSubagents } from "../../src/stats/subagents.ts";

import { call, header, info, timestamp, writeSession } from "../fixtures/subagent-report.ts";

let root: string;
const file = (name: string, entries: unknown[]) => writeSession(root, name, entries);
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

it("bounds diagnostic paths and refuses ambiguous relocated session references", async () => {
	const parent = `/old/${"p".repeat(150)}.jsonl`;
	for (const dir of ["one", "two"]) {
		await mkdir(join(root, dir));
		await file(`${dir}/${"p".repeat(150)}.jsonl`, [header(dir)]);
	}
	await file("child.jsonl", [header("c", parent), info("Explore#12345678"), call("one")]);
	const report = await reportSubagents(root);
	expect(report).toMatchObject({ complete: false, errors: 1, diagnostics: [{ reason: "unmatched-session" }] });
	expect(report.diagnostics[0]?.path.length).toBeLessThanOrEqual(120);
});

it("resolves identical copies of a relocated parent and diagnoses missing parents", async () => {
	for (const dir of ["one", "two"]) {
		await mkdir(join(root, dir));
		await file(`${dir}/parent.jsonl`, [header("p")]);
	}
	await file("child.jsonl", [header("c", "/old/parent.jsonl"), info("Explore#12345678"), call("one")]);
	expect(await reportSubagents(root)).toMatchObject({ complete: true, errors: 0, totals: { calls: 1 } });
	await file("missing.jsonl", [header("m", "/old/absent-parent.jsonl"), info("Explore#87654321"), call("two")]);
	expect(await reportSubagents(root)).toMatchObject({
		complete: false,
		errors: 1,
		diagnostics: [{ reason: "unmatched-session", path: "/old/absent-parent.jsonl" }],
	});
});

it("reports real directory read failures and read races nonfatally", async () => {
	// ENOTDIR exercises the same readdir rejection as EACCES, including when tests run as root.
	const notDirectory = await file("not-directory", []);
	expect(await reportSubagents(notDirectory)).toMatchObject({
		errors: 1,
		complete: false,
		diagnostics: [{ reason: "read-directory" }],
	});
	await file("race.jsonl", [header("race")]);
	vi.spyOn(jsonl, "feedFile").mockRejectedValueOnce(new Error("read failed"));
	expect(await reportSubagents(root)).toMatchObject({
		errors: 1,
		complete: false,
		diagnostics: [{ reason: "read-file" }],
	});
});

it("counts distinct structural and semantic damaged lines once each", async () => {
	await file("damaged.jsonl", [
		header("damaged"),
		call("negative", {}, { usage: { input: -1 } }),
		'{"type":"custom","data":broken}',
		'{"message":{"role":"assistant"},broken}',
	]);
	const report = await reportSubagents(root);
	expect(report).toMatchObject({ badLines: 3, complete: false });
	expect(report.diagnostics.map((d) => d.line)).toEqual([2, 3, 4]);
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
		"null",
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

it("counts price fallbacks only for calls that reach the totals", async () => {
	const parent = await file("parent.jsonl", [header("p")]);
	const child = [header("c", parent), info("Explore#12345678"), call("one", { total: 1 })];
	await file("a-copy.jsonl", child);
	await file("b-copy.jsonl", child);
	await file("top.jsonl", [header("top"), call("top-call", { total: 4 })]);
	const clone = (calls: load.CallTuple[]) => calls.map((c) => [...c] as load.CallTuple);
	// Both copies lose their price binding, the top-level file is not a child: one counted call.
	const unbound = await withMutatedCalls(clone);
	expect(unbound).toMatchObject({ complete: false, priceFallbacks: 1, totals: { calls: 1, unpricedCalls: 1 } });
	vi.restoreAllMocks();
	// Paths sort, so `a-copy` scans first. Unbound first: the later bound copy supersedes it.
	let scanned = 0;
	const supersede = await withMutatedCalls((calls) => (scanned++ === 0 ? clone(calls) : calls));
	expect(supersede).toMatchObject({ priceFallbacks: 0, totals: { calls: 1, recordedCost: 1, pricedCalls: 1 } });
	expect(supersede.diagnostics.map((d) => d.reason)).toEqual(["price-fallback"]);
	vi.restoreAllMocks();
	// Bound first: the later unbound copy never replaces it.
	scanned = 0;
	const kept = await withMutatedCalls((calls) => (scanned++ === 1 ? clone(calls) : calls));
	expect(kept).toMatchObject({ priceFallbacks: 0, totals: { calls: 1, recordedCost: 1, pricedCalls: 1 } });
});

it("ignores session records /stats ignores, so a mid-file session and late header never make a child", async () => {
	const parent = await file("parent.jsonl", [header("p")]);
	const lines = [
		{ type: "label", timestamp },
		{ type: "session", id: "late", parentSession: parent, timestamp },
		info("Explore#12345678"),
		call("odd", { total: 1 }),
	];
	await file("odd.jsonl", lines);
	const stats = load.parseSession(lines.map((l) => JSON.stringify(l)).join("\n"));
	expect(stats.child).toBe(false);
	expect(stats.sessionId).toBeUndefined();
	const report = await reportSubagents(root);
	expect(report.groups).toEqual([]);
	expect(report.totals.calls).toBe(0);
});

it("still counts a result whose agent id matches no child, even when a fork copies it", async () => {
	const parent = await file("parent.jsonl", [header("p")]);
	const lost = {
		type: "message",
		message: { role: "toolResult", toolName: "Agent", toolCallId: "t", details: { agentId: "deadbeef" } },
	};
	await file("fork.jsonl", [header("f", parent), lost]);
	await file("fork2.jsonl", [header("f2", parent), lost]);
	expect(await reportSubagents(root)).toMatchObject({ missingSessions: 1, unmatchedSessions: 1, complete: false });
});
