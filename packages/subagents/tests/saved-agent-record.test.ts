/** Saved history is diagnostic data, not a live record or a request to run a child. */

import { mkdirSync, realpathSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { makeTestTempDir } from "@nredd/pi-test-lib/temp-dir";
import { describe, expect, it, onTestFinished } from "vitest";
import { describeEvicted, describeEvictedResult } from "../src/agent-manager.ts";
import { savedAgentNote } from "../src/saved-agent-record.ts";
import {
	canonicalChildPath,
	canonicalPaths,
	checkSavedChild,
	FUTURE_WRITE_WAIT_CAP_SECONDS,
	RECENT_CHILD_WRITE_SECONDS,
	sameSavedChild,
} from "../src/saved-child-session.ts";

/** A check long after every write in these tests, so none is recent. */
const CHECKED_LATER = Number.MAX_SAFE_INTEGER;
const base = { id: "synthetic-child", type: "general-purpose", description: "synthetic job", status: "completed" };

describe("saved agent lookup notes", () => {
	it.each([
		null,
		undefined,
		false,
		1,
		"text",
		{},
		{ ...base, id: 1 },
		{ ...base, type: null },
		{ ...base, description: [] },
	])("ignores malformed history %j", (data) => {
		expect(savedAgentNote(data)).toBeUndefined();
	});

	it.each(["queued", "unknown", null])("ignores an unsupported saved %s status", (status) => {
		expect(savedAgentNote({ ...base, status })).toBeUndefined();
	});

	it.each(["completed", "steered", "error", "aborted", "stopped"])(
		"recovers the recorded %s status without claiming TTL eviction",
		(status) => {
			const note = savedAgentNote({ ...base, status });
			expect(note).toMatchObject({ ...base, status, evictedAfterMin: 0, fromSavedSession: true, handle: base.id });
			const diagnostic = describeEvicted(note!);
			expect(diagnostic).toContain(`${status}, recovered from saved parent session (no live registry record)`);
			expect(diagnostic).not.toContain("evicted after");
		},
	);

	it("labels a possibly running refusal as a snapshot from session start", () => {
		const note = savedAgentNote({ ...base, status: "running" })!;
		const refusal =
			"may still be running in another process (last write 3s ago; retry in 117 s): /synthetic/child.jsonl";
		expect(describeEvicted({ ...note, possiblyRunning: true, reopenRefusal: refusal })).toBe(
			`Agent "${base.id}" (${base.description}) last recorded status: running, recovered from saved parent session (no live registry record); as of session start: ${refusal}`,
		);
	});

	it("does not append undefined when a possibly running note lacks a refusal", () => {
		const note = savedAgentNote({ ...base, status: "running" })!;
		expect(describeEvicted({ ...note, possiblyRunning: true })).toBe(
			`Agent "${base.id}" (${base.description}) last recorded status: running, recovered from saved parent session (no live registry record)`,
		);
	});

	it("prefers the recorded output path and falls back to a saved child session", () => {
		expect(
			savedAgentNote({ ...base, outputFile: "/synthetic/child.output", sessionFile: "/synthetic/child.jsonl" })
				?.transcript,
		).toBe("/synthetic/child.output");
		expect(savedAgentNote({ ...base, outputFile: false, sessionFile: "/synthetic/child.jsonl" })?.transcript).toBe(
			"/synthetic/child.jsonl",
		);
		expect(savedAgentNote({ ...base, sessionFile: 42 })?.transcript).toBeUndefined();
		expect(savedAgentNote({ ...base, outputFile: "" })?.transcript).toBeUndefined();
	});

	it("keeps the saved result and error, capped, so /resume or a restart still reads them (#372)", () => {
		const done = savedAgentNote({ ...base, result: "the saved answer", outputFile: "/synthetic/child.output" });
		expect(done?.result).toBe("the saved answer");
		expect(describeEvictedResult(done!)).toBe("the saved answer");
		const failed = savedAgentNote({ ...base, status: "error", error: "boom" });
		expect(describeEvictedResult(failed!)).toBe("Error: boom");
		const huge = savedAgentNote({ ...base, result: "x".repeat(500_000), outputFile: "/synthetic/child.output" });
		expect(huge!.result!.length).toBeLessThan(40_000);
		expect(huge!.result).toContain("full text in /synthetic/child.output");
		expect(describeEvictedResult(savedAgentNote({ ...base, status: "error" })!)).toBeUndefined();
		expect(describeEvictedResult(savedAgentNote({ ...base, result: "  " })!)).toBeUndefined();
		// A stopped or aborted run that only kept an error still has readable text.
		expect(describeEvictedResult(savedAgentNote({ ...base, status: "stopped", error: "runner died" })!)).toBe(
			"Error: runner died",
		);
		expect(describeEvictedResult(savedAgentNote({ ...base, status: "aborted", result: " ", error: "e" })!)).toBe(
			"Error: e",
		);
		expect(describeEvictedResult(savedAgentNote({ ...base, status: "stopped", error: "  " })!)).toBeUndefined();
		expect(savedAgentNote({ ...base, result: 5, error: {} })).not.toHaveProperty("result");
	});
});

describe("saved child transcript identity", () => {
	const row = (sessionFile?: string, canonicalSessionFile?: string) => ({ sessionFile, canonicalSessionFile });

	it("keeps exact links to missing transcripts but rejects mismatches and path traversal aliases", () => {
		const root = makeTestTempDir("saved-child-", onTestFinished);
		const one = join(root, "one.jsonl");
		const two = join(root, "two.jsonl");
		expect(sameSavedChild(row(), row(one))).toBe(false);
		expect(sameSavedChild(row(one), row())).toBe(false);
		expect(sameSavedChild(row(one), row(one))).toBe(true);
		expect(sameSavedChild(row(one), row(two))).toBe(false);
		writeFileSync(one, "");
		writeFileSync(two, "");
		expect(sameSavedChild(row(one), row(two))).toBe(false);
		const traversal = `${root}/../${basename(root)}/one.jsonl`;
		expect(sameSavedChild(row(traversal), row(one))).toBe(false);
		expect(sameSavedChild(row(one), row(traversal))).toBe(false);
	});

	it("links through the canonical form journaled at write time, after the file is gone", () => {
		const root = makeTestTempDir("saved-child-", onTestFinished);
		const real = join(root, "real");
		const alias = join(root, "alias");
		mkdirSync(real);
		symlinkSync(real, alias, "dir");
		const spelled = join(alias, "child.jsonl");
		const canonical = join(realpathSync(real), "child.jsonl");
		// Not flushed yet: the directory still resolves.
		expect(canonicalChildPath(spelled)).toBe(canonical);
		writeFileSync(canonical, "");
		expect(canonicalChildPath(spelled)).toBe(canonical);
		expect(canonicalChildPath("relative.jsonl")).toBeUndefined();
		expect(canonicalChildPath(join(root, "missing", "child.jsonl"))).toBeUndefined();
		// While the file exists, legacy rows still link by resolving both spellings.
		expect(sameSavedChild(row(spelled), row(canonical))).toBe(true);
		unlinkSync(canonical);
		expect(sameSavedChild(row(spelled), row(canonical))).toBe(false);
		expect(sameSavedChild(row(spelled, canonical), row(canonical))).toBe(true);
		expect(sameSavedChild(row(spelled, canonical), row(canonical, canonical))).toBe(true);
		expect(sameSavedChild(row(canonical), row(spelled, canonical))).toBe(true);
		expect(sameSavedChild(row(spelled, canonical), row(join(root, "other.jsonl")))).toBe(false);
	});

	it("treats conflicting recorded canonical paths as different transcripts, whatever the spelling", () => {
		const root = makeTestTempDir("saved-child-", onTestFinished);
		const first = join(root, "first");
		const second = join(root, "second");
		mkdirSync(first);
		mkdirSync(second);
		const link = join(root, "link");
		symlinkSync(first, link, "dir");
		const spelled = join(link, "child.jsonl");
		const inFirst = join(realpathSync(first), "child.jsonl");
		const inSecond = join(realpathSync(second), "child.jsonl");
		// One spelling, retargeted between rows: the recorded targets decide, not the spelling.
		expect(sameSavedChild(row(spelled, inFirst), row(spelled, inSecond))).toBe(false);
		expect(sameSavedChild(row(inFirst, inFirst), row(inFirst, inSecond))).toBe(false);
		expect(sameSavedChild(row(spelled, inFirst), row(spelled, inFirst))).toBe(true);
		// Without canonical evidence on a side, the spelling still links.
		expect(sameSavedChild(row(spelled), row(spelled, inSecond))).toBe(true);
		expect(sameSavedChild(row(spelled, inFirst), row(spelled))).toBe(true);
		// Live resolution never overrides conflicting recorded targets either.
		writeFileSync(inFirst, "");
		expect(sameSavedChild(row(spelled, inFirst), row(inFirst, inSecond))).toBe(false);
	});

	it("names the missing parent path, whether it comes from the header or current session", () => {
		const root = makeTestTempDir("saved-child-", onTestFinished);
		const file = join(root, "child.jsonl");
		const recorded = join(root, "recorded.jsonl");
		const current = join(root, "current.jsonl");
		writeFileSync(file, `${JSON.stringify({ type: "session", parentSession: recorded })}\n`);
		const check = () =>
			checkSavedChild({ file, directories: [root], parentFile: current, status: "completed", now: CHECKED_LATER });
		expect(check()).toEqual({ refusal: `parent session is missing or unreadable: ${recorded}` });
		writeFileSync(recorded, "");
		expect(check()).toEqual({ refusal: `parent session is missing or unreadable: ${current}` });
	});
});

describe("saved child validation", () => {
	function child(header: Record<string, unknown> = {}) {
		const root = makeTestTempDir("saved-child-", onTestFinished);
		const parentFile = join(root, "parent.jsonl");
		const directory = join(root, "sessions");
		const file = join(directory, "child.jsonl");
		mkdirSync(directory);
		writeFileSync(parentFile, "");
		writeFileSync(file, `${JSON.stringify({ type: "session", parentSession: parentFile, ...header })}\n`);
		return { root, parentFile, directory, file };
	}

	it("accepts the journaled creation directory when current settings give another", () => {
		const { root, parentFile, directory, file } = child();
		const elsewhere = join(root, "elsewhere");
		const options = { file, parentFile, status: "completed", now: CHECKED_LATER } as const;
		// A directory that does not resolve keeps the legacy wording.
		expect(checkSavedChild({ ...options, directories: [undefined, elsewhere] })).toEqual({
			refusal: `child session is missing or unreadable: ${file}`,
		});
		const other = join(root, "other");
		mkdirSync(other);
		expect(checkSavedChild({ ...options, directories: [other, elsewhere] })).toEqual({
			refusal: `child session is missing or unreadable: ${file}`,
		});
		expect(checkSavedChild({ ...options, directories: [undefined, other] })).toEqual({
			refusal: `child session is outside its configured directory: ${file}`,
		});
		expect(checkSavedChild({ ...options, directories: [directory, elsewhere] })).toEqual({
			file: realpathSync(file),
		});
		expect(checkSavedChild({ ...options, directories: [elsewhere, directory] })).toEqual({
			file: realpathSync(file),
		});
	});

	it("refuses a transcript written in the future as possibly running, with a finite wait", () => {
		const { directory, parentFile, file } = child();
		const mtime = 1_700_000_000_000;
		utimesSync(file, new Date(mtime), new Date(mtime));
		const check = (now: number) =>
			checkSavedChild({ file, directories: [directory], parentFile, status: "running", now });
		const refused = (why: string) => ({
			file: realpathSync(file),
			recent: true,
			refusal: `may still be running in another process (${why}): ${file}`,
		});
		// Skew and a live writer on a clock ahead of ours look the same: wait the skew out too.
		expect(check(mtime - 500)).toEqual(refused("last write 1s in the future, possibly clock skew; retry in 121 s"));
		expect(check(mtime - 6_000)).toEqual(refused("last write 6s in the future, possibly clock skew; retry in 126 s"));
		expect(check(mtime - 3_600_000)).toEqual(
			refused("last write 3600s in the future, possibly clock skew; retry in 3720 s"),
		);
		const cap = FUTURE_WRITE_WAIT_CAP_SECONDS;
		expect(check(mtime - (cap - RECENT_CHILD_WRITE_SECONDS) * 1000)).toEqual(
			refused(`last write ${cap - RECENT_CHILD_WRITE_SECONDS}s in the future, possibly clock skew; retry in ${cap} s`),
		);
		expect(check(mtime - cap * 1000)).toEqual(
			refused(
				`last write ${cap}s in the future, possibly clock skew; retry in more than ${cap} s, or reset its timestamp once no process writes it`,
			),
		);
		expect(check(mtime)).toEqual(refused("last write 0s ago; retry in 120 s"));
		expect(check(mtime + 30_000)).toEqual(refused("last write 30s ago; retry in 90 s"));
		expect(check(mtime + RECENT_CHILD_WRITE_SECONDS * 1000)).toEqual({ file: realpathSync(file) });
	});

	it("reads a header line past the first chunk and refuses one past the cap", () => {
		const { directory, parentFile, file } = child({ padding: "x".repeat(10_000) });
		const options = { directories: [directory], parentFile, status: "completed", now: CHECKED_LATER } as const;
		expect(checkSavedChild({ ...options, file })).toEqual({ file: realpathSync(file) });
		writeFileSync(file, `${JSON.stringify({ type: "session", parentSession: parentFile })}`);
		expect(checkSavedChild({ ...options, file })).toEqual({
			refusal: `child session has no readable header: ${file}`,
		});
		writeFileSync(file, "x".repeat(70_000));
		expect(checkSavedChild({ ...options, file })).toEqual({
			refusal: `child session has no readable header: ${file}`,
		});
	});

	it("resolves the shared directory and parent once across rows", () => {
		const { root, directory, parentFile, file } = child();
		const link = join(root, "link");
		symlinkSync(directory, link, "dir");
		const canonical = canonicalPaths();
		const options = {
			file,
			directories: [link],
			parentFile,
			status: "completed",
			now: CHECKED_LATER,
			canonical,
		} as const;
		expect(checkSavedChild(options)).toEqual({ file: realpathSync(file) });
		// A later row reuses the first resolution instead of resolving the link again.
		unlinkSync(link);
		expect(checkSavedChild(options)).toEqual({ file: realpathSync(file) });
		expect(checkSavedChild({ ...options, canonical: canonicalPaths() })).toEqual({
			refusal: `child session is missing or unreadable: ${file}`,
		});
		// A link retargeted between rows strands no child: a containment miss asks once more uncached.
		const moved = join(root, "moved");
		mkdirSync(moved);
		const later = join(moved, "later.jsonl");
		writeFileSync(later, `${JSON.stringify({ type: "session", parentSession: parentFile })}\n`);
		symlinkSync(moved, link, "dir");
		expect(checkSavedChild({ ...options, file: later })).toEqual({ file: realpathSync(later) });
		const missing = join(directory, "missing");
		expect(() => canonical(missing)).toThrow();
		mkdirSync(missing);
		// A failure is cached too: a missing directory costs one lookup per startup, not one per row.
		expect(() => canonical(missing)).toThrow();
		expect(canonicalPaths()(missing)).toBe(realpathSync(missing));
	});
});
