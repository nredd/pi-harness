/** Saved history is diagnostic data, not a live record or a request to run a child. */

import { writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { makeTestTempDir } from "@nredd/pi-test-lib/temp-dir";
import { describe, expect, it, onTestFinished } from "vitest";
import { describeEvicted, describeEvictedResult } from "../src/agent-manager.ts";
import { savedAgentNote } from "../src/saved-agent-record.ts";
import { checkSavedChild, sameSavedChild } from "../src/saved-child-session.ts";

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
	it("keeps exact links to missing transcripts but rejects mismatches and path traversal aliases", () => {
		const root = makeTestTempDir("saved-child-", onTestFinished);
		const one = join(root, "one.jsonl");
		const two = join(root, "two.jsonl");
		expect(sameSavedChild(undefined, one)).toBe(false);
		expect(sameSavedChild(one, undefined)).toBe(false);
		expect(sameSavedChild(one, one)).toBe(true);
		expect(sameSavedChild(one, two)).toBe(false);
		writeFileSync(one, "");
		writeFileSync(two, "");
		expect(sameSavedChild(one, two)).toBe(false);
		const traversal = `${root}/../${basename(root)}/one.jsonl`;
		expect(sameSavedChild(traversal, one)).toBe(false);
		expect(sameSavedChild(one, traversal)).toBe(false);
	});

	it("names the missing parent path, whether it comes from the header or current session", () => {
		const root = makeTestTempDir("saved-child-", onTestFinished);
		const file = join(root, "child.jsonl");
		const recorded = join(root, "recorded.jsonl");
		const current = join(root, "current.jsonl");
		writeFileSync(file, `${JSON.stringify({ type: "session", parentSession: recorded })}\n`);
		const check = () => checkSavedChild(file, root, current, "completed", 0);
		expect(check()).toEqual({ refusal: `parent session is missing or unreadable: ${recorded}` });
		writeFileSync(recorded, "");
		expect(check()).toEqual({ refusal: `parent session is missing or unreadable: ${current}` });
	});
});
