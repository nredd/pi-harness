import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { forkAncestry } from "./lineage.ts";

const dir = mkdtempSync(join(tmpdir(), "todo-lineage-unit-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const session = (name: string, parentSession?: unknown): string => {
	const path = join(dir, name);
	writeFileSync(path, `${JSON.stringify({ type: "session", parentSession })}\n{"type":"message"}\n`);
	return path;
};
const forkOf = (parentSession?: string) => ({ getHeader: () => ({ parentSession }) });

describe("forkAncestry", () => {
	it("is empty for a session that is no fork, or whose manager has no header", () => {
		expect(forkAncestry(forkOf())).toEqual(new Set());
		expect(forkAncestry({})).toEqual(new Set());
		expect(forkAncestry({ getHeader: () => null })).toEqual(new Set());
	});

	it("walks the parent chain, nearest first", () => {
		const a = session("a.jsonl");
		const b = session("b.jsonl", a);
		const c = session("c.jsonl", b);
		expect([...forkAncestry(forkOf(c))]).toEqual([c, b, a]);
	});

	it("stops at a cycle", () => {
		const a = join(dir, "cyc-a.jsonl");
		const b = join(dir, "cyc-b.jsonl");
		writeFileSync(a, `${JSON.stringify({ type: "session", parentSession: b })}\n`);
		writeFileSync(b, `${JSON.stringify({ type: "session", parentSession: a })}\n`);
		expect([...forkAncestry(forkOf(a))]).toEqual([a, b]);
	});

	it("keeps an unreadable, malformed or parentless parent as the last link", () => {
		const junk = join(dir, "junk.jsonl");
		writeFileSync(junk, "not json\n");
		const missing = join(dir, "missing.jsonl");
		expect([...forkAncestry(forkOf(junk))]).toEqual([junk]);
		expect([...forkAncestry(forkOf(missing))]).toEqual([missing]);
	});

	it("never follows a parent that is not a path string", () => {
		const numeric = session("numeric.jsonl", 5);
		expect([...forkAncestry(forkOf(numeric))]).toEqual([numeric]);
	});

	it("bounds the walk on a very deep chain", () => {
		let parent = session("deep-0.jsonl");
		for (let i = 1; i <= 80; i++) parent = session(`deep-${i}.jsonl`, parent);
		expect(forkAncestry(forkOf(parent)).size).toBe(64);
	});
});
