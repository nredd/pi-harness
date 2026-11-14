/** Saved history is diagnostic data, not a live record or a request to run a child. */

import { describe, expect, it } from "vitest";
import { describeEvicted, describeEvictedResult } from "../src/agent-manager.js";
import { savedAgentNote } from "../src/saved-agent-record.js";

const base = { id: "synthetic-child", type: "general-purpose", description: "synthetic job", status: "completed" };

describe("saved terminal lookup notes", () => {
  it.each([null, undefined, false, 1, "text", {}, { ...base, id: 1 }, { ...base, type: null }, { ...base, description: [] }])("ignores malformed history %j", data => {
    expect(savedAgentNote(data)).toBeUndefined();
  });

  it.each(["running", "queued", "unknown", null])("does not claim a saved %s child is alive or finished", status => {
    expect(savedAgentNote({ ...base, status })).toBeUndefined();
  });

  it.each(["completed", "steered", "error", "aborted", "stopped"])("recovers the recorded %s status without claiming TTL eviction", status => {
    const note = savedAgentNote({ ...base, status });
    expect(note).toEqual({ ...base, status, evictedAfterMin: 0, fromSavedSession: true });
    const diagnostic = describeEvicted(note!);
    expect(diagnostic).toContain(`${status}, recovered from saved parent session (no live registry record)`);
    expect(diagnostic).not.toContain("evicted after");
  });

  it("prefers the recorded output path and falls back to a saved child session", () => {
    expect(savedAgentNote({ ...base, outputFile: "/synthetic/child.output", sessionFile: "/synthetic/child.jsonl" })?.transcript).toBe("/synthetic/child.output");
    expect(savedAgentNote({ ...base, outputFile: false, sessionFile: "/synthetic/child.jsonl" })?.transcript).toBe("/synthetic/child.jsonl");
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
    expect(savedAgentNote({ ...base, result: 5, error: {} })).not.toHaveProperty("result");
  });
});
