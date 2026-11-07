import { describe, expect, it } from "vitest";
import { clipNotice, clipResult, DEFAULT_NOTIFICATION_RESULT_CHARS, fairShares, NOTIFICATION_BATCH_AGENTS, previewResult, RESULT_FRAMING, renderNotice } from "../src/notification-result.js";

describe("clipResult", () => {
  it("keeps a result that fits whole", () => {
    expect(clipResult("abcdef", 6, "/t/a.output")).toEqual({ text: "abcdef", complete: true });
  });

  it("keeps head and tail around a marker naming the transcript and get_subagent_result", () => {
    expect(clipResult("abcdefghij", 5, "/t/a.output")).toEqual({
      text: "abc\n...(truncated: 5 of 10 chars omitted; full result in /t/a.output, or use get_subagent_result)...\nij",
      complete: false,
    });
  });

  it("points only at get_subagent_result without a transcript", () => {
    expect(clipResult("abcdefghij", 4).text).toBe("ab\n...(truncated: 6 of 10 chars omitted; use get_subagent_result for full output)...\nij");
  });

  it("keeps no tail when the share is a single char", () => {
    expect(clipResult("abc", 1).text).toBe("a\n...(truncated: 2 of 3 chars omitted; use get_subagent_result for full output)...\n");
  });
});

describe("previewResult", () => {
  it("is the head plus today's pointer past the preview, the text otherwise", () => {
    expect(previewResult("abcdef", 3)).toBe("abc\n...(truncated, use get_subagent_result for full output)");
    expect(previewResult("abc", 3)).toBe("abc");
  });
});

describe("fairShares", () => {
  it("gives every result what it needs when the batch fits", () => {
    expect(fairShares([10, 20, 30], 100)).toEqual([10, 20, 30]);
  });

  it("caps each result at the per-agent cap", () => {
    expect(fairShares([500, 50], 100)).toEqual([100, 50]);
  });

  it("splits an over-budget batch evenly, handing what short results leave to long ones", () => {
    // Budget 400: the short one keeps its 10, the five long ones split 390.
    expect(fairShares([1_000, 10, 1_000, 1_000, 1_000, 1_000], 100)).toEqual([78, 10, 78, 78, 78, 78]);
  });

  it("is empty for an empty batch", () => {
    expect(fairShares([], 100)).toEqual([]);
  });

  it("defaults to 16k per agent and four agents' worth per batch", () => {
    expect(DEFAULT_NOTIFICATION_RESULT_CHARS).toBe(16_000);
    expect(NOTIFICATION_BATCH_AGENTS).toBe(4);
  });
});

describe("renderNotice / clipNotice", () => {
  const frame = { head: "<task-notification>", tail: "</task-notification>" };

  it("escapes the result into a framed <result>", () => {
    expect(renderNotice(frame, "a<b")).toBe(`<task-notification>\n${RESULT_FRAMING}\n<result>a&lt;b</result>\n</task-notification>`);
  });

  it("counts the cap on the raw result, before escaping", () => {
    const parts = { ...frame, body: "<<<<", cap: 4, failed: false };
    expect(clipNotice(parts)).toEqual({ text: renderNotice(frame, "<<<<"), delivered: true, complete: true });
  });

  it("never exceeds the cap whatever share it is given, and leaves a failure unread", () => {
    const parts = { ...frame, body: "abcdef", cap: 4, failed: true };
    expect(clipNotice(parts, 100)).toEqual({ text: renderNotice(frame, clipResult("abcdef", 4).text), delivered: false, complete: false });
    expect(clipNotice({ ...parts, body: "abc" })).toEqual({ text: renderNotice(frame, "abc"), delivered: false, complete: true });
  });
});
