import { describe, expect, it } from "vitest";
import { classifyLines, parseUnifiedDiff } from "../src/diff/parse.ts";
import { sanitize } from "../src/diff/view.ts";
import { matchesRule } from "../src/rules/logic.ts";
import { planModeEnteredSince } from "../src/shared.ts";
import { niceStep } from "../src/stats/chart.ts";

describe("remaining render and pure boundaries", () => {
	it("keeps copy attribution and exact deletion counts after a patch is capped", () => {
		const copied = parseUnifiedDiff(
			"diff --git a/old b/new\ncopy from old\ncopy to new\n@@ -1 +1 @@\n-before\n+after\n",
		);
		expect(copied[0]).toMatchObject({ path: "new", oldPath: "old", status: "copied", additions: 1, deletions: 1 });
		const capped = parseUnifiedDiff(`diff --git a/a b/a\n@@ -2 +1 @@\n context\n-${"x".repeat(100)}\n-old\n+new\n`, 50);
		expect(capped[0]).toMatchObject({ additions: 1, deletions: 2, notice: expect.stringContaining("truncated") });
		const file = capped[0];
		if (!file) throw new Error("Expected capped patch");
		expect(classifyLines(file)).toEqual(["meta", "hunk", "context", "removed", "added"]);
	});

	it("turns C1 and Unicode line separators into harmless single-column markers", () => {
		expect(sanitize("a\u0080\u009fb\u2028\u2029c")).toBe("a??b??c");
	});

	it("ignores an unmatchable oversized glob but still accepts a later valid rule", () => {
		expect(matchesRule({ id: "bad", body: "ignored", globs: ["x".repeat(65_537)] }, "src/a.ts")).toBe(false);
		expect(matchesRule({ id: "fallback", body: "retained", globs: ["x".repeat(65_537), "src/**"] }, "src/a.ts")).toBe(
			true,
		);
	});

	it("reports no Plan excursion when history contains neither its state nor a goal marker", () => {
		expect(
			planModeEnteredSince(
				[{ type: "message" }, { type: "custom", customType: "unrelated", data: { enabled: true } }],
				"goal-marker",
			),
		).toBe(false);
	});

	it("returns infinite headroom rather than a finite undersized tick above the numeric chart range", () => {
		expect(niceStep(Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY);
		expect(niceStep(Number.MAX_VALUE)).toBe(Number.POSITIVE_INFINITY);
		expect(niceStep(9e307)).toBe(1e308);
	});
});
