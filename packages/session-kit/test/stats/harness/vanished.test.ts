import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readClaude } from "../../../src/stats/harness/claude.ts";
import { claudeRow, writeLines } from "./fixtures.ts";

const listing = vi.hoisted(() => ({ extra: [] as string[] }));
vi.mock("../../../src/stats/jsonl.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../src/stats/jsonl.ts")>();
	return {
		...actual,
		listJsonl: async (root: string) => {
			const listed = await actual.listJsonl(root);
			return { ...listed, paths: [...listed.paths, ...listing.extra] };
		},
	};
});

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "psk-vanished-"));
});
afterEach(() => {
	listing.extra = [];
	rmSync(root, { recursive: true, force: true });
});

it("treats a transcript pruned between listing and reading as gone, not as an unreadable file", async () => {
	const kept = join(root, "projects", "p", "kept.jsonl");
	const pruned = join(root, "projects", "p", "pruned.jsonl");
	writeLines(kept, [claudeRow({ id: "msg_1", requestId: "req_1" })]);
	writeLines(pruned, [claudeRow({ id: "msg_2", requestId: "req_2", sessionId: "sess-B" })]);
	const cache = {};
	expect((await readClaude(root, cache)).calls).toHaveLength(2);

	// Claude prunes old transcripts: listed, then ENOENT. Its cached usage stays, nothing is reported.
	rmSync(pruned);
	listing.extra = [pruned, join(root, "projects", "p", "never-seen.jsonl")];
	const scan = await readClaude(root, cache);
	expect(scan.problems).toEqual([]);
	expect(scan.calls).toHaveLength(2);
});
