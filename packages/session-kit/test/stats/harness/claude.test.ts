import { chmodSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readClaude } from "../../../src/stats/harness/claude.ts";
import { entryHash, sessionHash } from "../../../src/stats/harness/common.ts";
import type { HarnessCache } from "../../../src/stats/harness/scan.ts";
import { CANARY, claudeRow, claudeUser, writeLines } from "./fixtures.ts";

let root: string;
const proj = (name = `-Users-${CANARY}-work`) => join(root, "projects", name);
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "psk-claude-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("readClaude", () => {
	it("reports a missing root as not installed, silently", async () => {
		const scan = await readClaude(join(root, "nope"), {});
		expect(scan).toMatchObject({ found: false, calls: [], problems: [] });
	});

	it("collapses per-content-block duplicates by (message.id, requestId)", async () => {
		const grow = (output: number) => ({
			input_tokens: 10,
			output_tokens: output,
			cache_read_input_tokens: 30,
			cache_creation_input_tokens: 40,
		});
		writeLines(join(proj(), "a.jsonl"), [
			claudeUser(),
			claudeRow({ usage: grow(5) }),
			claudeRow({ usage: grow(20), block: "tool" }),
			claudeRow({ usage: grow(12), block: "tool" }),
			claudeRow({ id: "msg_2", requestId: "req_2", ts: "2026-10-01T12:05:00.000Z" }),
			// same message id, different request: a distinct API response
			claudeRow({ id: "msg_2", requestId: "req_3", ts: "2026-10-01T12:06:00.000Z" }),
		]);
		const scan = await readClaude(root, {});
		expect(scan.found).toBe(true);
		expect(scan.problems).toEqual([]);
		expect(scan.calls).toHaveLength(3);
		const first = scan.calls[0];
		expect(first).toMatchObject({
			harness: "claude",
			provider: "anthropic",
			model: "claude-opus-5-5",
			input: 10,
			output: 20,
			cacheRead: 30,
			cacheWrite: 40,
			cost: 0,
			entryId: entryHash("claude", JSON.stringify(["msg_1", "req_1"])),
			session: sessionHash("claude", "sess-A"),
		});
		expect(scan.sessions).toEqual([
			{
				path: sessionHash("claude", "sess-A"),
				startMs: Date.parse("2026-10-01T12:00:00Z"),
				endMs: Date.parse("2026-10-01T12:06:00Z"),
				child: false,
			},
		]);
	});

	it("collapses a resumed session's copied history across files, keeping the oldest on a tie", async () => {
		writeLines(join(proj(), "a.jsonl"), [claudeRow()]);
		writeLines(join(proj(), "b.jsonl"), [claudeRow({ sessionId: "sess-B" })]);
		const scan = await readClaude(root, {});
		expect(scan.calls).toHaveLength(1);
		expect(scan.calls[0]?.session).toBe(sessionHash("claude", "sess-A"));
		expect(scan.sessions.map((s) => s.path)).toEqual([sessionHash("claude", "sess-A")]);
	});

	it("counts subagent files toward tokens but not Sessions", async () => {
		writeLines(join(proj(), "sess-A.jsonl"), [claudeRow()]);
		writeLines(join(proj(), "sess-A", "subagents", "agent-9.jsonl"), [
			claudeRow({ id: "msg_s", requestId: "req_s", isSidechain: true, ts: "2026-10-01T12:30:00.000Z" }),
		]);
		const scan = await readClaude(root, {});
		expect(scan.calls).toHaveLength(2);
		expect(scan.sessionMetadata).toHaveLength(2);
		expect(scan.sessionMetadata.filter((s) => s.child)).toHaveLength(1);
		expect(scan.sessions).toHaveLength(1);
		expect(scan.sessions[0]?.path).toBe(sessionHash("claude", "sess-A"));
		expect(scan.calls.reduce((n, c) => n + c.output, 0)).toBe(40);
	});

	it("counts sidechain rows in a main file under the parent session", async () => {
		writeLines(join(proj(), "a.jsonl"), [claudeRow(), claudeRow({ id: "m2", requestId: "r2", isSidechain: true })]);
		const scan = await readClaude(root, {});
		expect(scan.calls).toHaveLength(2);
		expect(scan.sessions).toHaveLength(1);
	});

	it("skips what is not a billable assistant call and counts the unreadable", async () => {
		writeLines(join(proj(), "a.jsonl"), [
			claudeUser(),
			claudeRow({ model: "<synthetic>" }),
			claudeRow({ id: "z", requestId: "z", usage: { input_tokens: 0, output_tokens: 0 } }),
			{ type: "assistant", message: { role: "assistant" } },
			{ type: "system", note: "assistant" },
			// usage fields absent count as zero; this one still has output
			claudeRow({ id: "ok", requestId: "ok", usage: { output_tokens: 7 } }),
			// unreadable: bad counter, missing ids, missing time, broken JSON, non-object, damaged non-candidate
			claudeRow({ id: "b1", requestId: "b1", usage: { input_tokens: -1 } }),
			claudeRow({ id: "", requestId: "b2" }),
			claudeRow({ id: "b3", requestId: "", usage: { input_tokens: 1 } }),
			claudeRow({ id: "b4", requestId: "b4", sessionId: "" }),
			claudeRow({ id: "b5", requestId: "b5", ts: "garbage" }),
			// renamed counter fields: schema drift, not zero usage
			claudeRow({ id: "b6", requestId: "b6", usage: { inputTokens: 5 } }),
			'{"type":"assistant", broken',
			'["assistant"]',
			"truncated {",
			"\0\0\0",
			"",
		]);
		const scan = await readClaude(root, {});
		expect(scan.calls.map((c) => c.output)).toEqual([7]);
		expect(scan.calls[0]).toMatchObject({ input: 0, cacheRead: 0, cacheWrite: 0 });
		expect(scan.problems).toEqual(["claude: ! 9 unreadable lines"]);
	});

	it("never lets project directory names, content, cwd, branch or native IDs reach the scan or its cache", async () => {
		writeLines(join(proj(), "a.jsonl"), [claudeUser(), claudeRow({ block: "tool" })]);
		writeLines(join(proj(`-Users-${CANARY}-other`), "b.jsonl"), [
			claudeRow({ id: "m9", requestId: "r9", model: "claude-haiku-5" }),
			"damaged",
		]);
		const cache: HarnessCache = {};
		const scan = await readClaude(root, cache);
		const out = JSON.stringify(scan);
		const kept = JSON.stringify(Object.values(cache.claude ?? {}));
		for (const text of [out, kept]) {
			expect(text).not.toContain(CANARY);
			for (const native of ["msg_1", "req_1", "sess-A", "projects", "Users"]) expect(text).not.toContain(native);
		}
		// the paths live only as local cache keys
		expect(Object.keys(cache.claude ?? {}).every((k) => k.startsWith(root))).toBe(true);
	});

	it("re-parses only changed files, keeps history for deleted ones and ignores other roots", async () => {
		const a = join(proj(), "a.jsonl");
		const b = join(proj(), "b.jsonl");
		writeLines(a, [claudeRow({ usage: { output_tokens: 11 } })]);
		writeLines(b, [claudeRow({ id: "m2", requestId: "r2", usage: { output_tokens: 22 } })]);
		// Whole-second mtimes survive a `utimes` round trip exactly.
		utimesSync(a, 1_790_000_000, 1_790_000_000);
		const cache: HarnessCache = {};
		expect((await readClaude(root, cache)).calls.map((c) => c.output)).toEqual([11, 22]);

		// Same size and mtime, different bytes: a cache hit must not re-read it.
		const { size } = statSync(a);
		writeFileSync(a, `${" ".repeat(size - 1)}\n`);
		utimesSync(a, 1_790_000_000, 1_790_000_000);
		expect((await readClaude(root, cache)).calls.map((c) => c.output)).toEqual([11, 22]);

		// Changed size: re-parsed, and now holds nothing.
		writeFileSync(a, "\n\n");
		expect((await readClaude(root, cache)).calls.map((c) => c.output)).toEqual([22]);

		// Deleted transcripts keep their history.
		rmSync(b);
		expect((await readClaude(root, cache)).calls.map((c) => c.output)).toEqual([22]);

		// A record cached for a path outside this root is not reported.
		const other = mkdtempSync(join(tmpdir(), "psk-claude-other-"));
		try {
			expect((await readClaude(other, cache)).found).toBe(true);
			expect((await readClaude(other, cache)).calls).toEqual([]);
		} finally {
			rmSync(other, { recursive: true, force: true });
		}
	});

	it("counts an unreadable file and keeps the rest", async () => {
		writeLines(join(proj(), "a.jsonl"), [claudeRow()]);
		const locked = join(proj(), "locked.jsonl");
		writeLines(locked, [claudeRow({ id: "x", requestId: "x" })]);
		chmodSync(locked, 0o000);
		try {
			const scan = await readClaude(root, {});
			expect(scan.calls).toHaveLength(1);
			expect(scan.problems).toEqual(["claude: 1 unreadable files"]);
		} finally {
			chmodSync(locked, 0o600);
		}
	});
});
