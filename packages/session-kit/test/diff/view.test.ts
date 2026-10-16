import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import {
	clampScroll,
	fitCols,
	fitPathLeft,
	layout,
	listTop,
	maxScroll,
	pageSize,
	sanitize,
	window,
} from "../../src/diff/view.ts";

describe("sanitize", () => {
	it("expands tabs to stops and neutralises control characters", () => {
		expect(sanitize("a\tb")).toBe("a   b");
		expect(sanitize("\tx")).toBe("    x");
		expect(sanitize("\u001b[31mred\u001b[0m")).toBe("^[[31mred^[[0m");
		expect(sanitize("a\rb\u007f\u0085")).toBe("a^Mb^??");
	});
	it("counts wide characters when placing tab stops", () => {
		expect(sanitize("\u4e2d\tx")).toBe("\u4e2d  x");
	});
});

describe("fitCols", () => {
	it.each([
		["short", 10],
		["exactly10!", 10],
		["a much longer line than ten", 10],
		["\u4e2d\u6587\u4e2d\u6587\u4e2d\u6587", 5],
		["emoji \ud83d\ude80\ud83d\ude80\ud83d\ude80", 9],
		["\u001b[32mgreen text that is long\u001b[0m", 8],
	])("%j fits exactly %d columns", (text, width) => {
		expect(visibleWidth(fitCols(text, width))).toBe(width);
	});
	it("returns empty for non-positive widths", () => {
		expect(fitCols("x", 0)).toBe("");
		expect(fitCols("x", -3)).toBe("");
	});
});

describe("window", () => {
	it("pans by columns and never splits a wide char", () => {
		expect(window("abcdef", 2, 3)).toBe("cde");
		expect(window("abc", 5, 4)).toBe("    ");
		for (let from = 0; from < 8; from++) expect(visibleWidth(window("\u4e2d\u6587\u4e2d\u6587abc", from, 5))).toBe(5);
	});
});

describe("fitPathLeft", () => {
	it("keeps the file name and marks the cut", () => {
		const out = fitPathLeft("src/very/deep/dir/file.ts", 14);
		expect(visibleWidth(out)).toBe(14);
		expect(out.startsWith("\u2026")).toBe(true);
		expect(out.trimEnd().endsWith("file.ts")).toBe(true);
		expect(visibleWidth(fitPathLeft("x", 1))).toBe(1);
		expect(fitPathLeft("anything", 0)).toBe("");
	});
});

describe("scroll math", () => {
	it("clamps to [0, total - viewport]", () => {
		expect(maxScroll(100, 20)).toBe(80);
		expect(maxScroll(10, 20)).toBe(0);
		expect(maxScroll(0, 0)).toBe(0);
		expect(clampScroll(-5, 100, 20)).toBe(0);
		expect(clampScroll(500, 100, 20)).toBe(80);
		expect(clampScroll(30, 100, 20)).toBe(30);
	});
	it("pages by a window minus one", () => {
		expect(pageSize(20)).toBe(19);
		expect(pageSize(1)).toBe(1);
		expect(pageSize(0)).toBe(1);
	});
	it("keeps the selected list row visible", () => {
		expect(listTop(0, 0, 50, 10)).toBe(0);
		expect(listTop(0, 15, 50, 10)).toBe(6);
		expect(listTop(20, 5, 50, 10)).toBe(5);
		expect(listTop(40, 49, 50, 10)).toBe(40);
		expect(listTop(99, 0, 5, 10)).toBe(0);
	});
});

describe("layout", () => {
	it("always sums to the width and keeps the patch pane usable from 60 to 320", () => {
		for (const w of [1, 10, 23, 24, 40, 60, 80, 120, 160, 200, 240, 320]) {
			const l = layout(w);
			expect(l.left + l.sep + l.right).toBe(w);
		}
		expect(layout(60).right).toBeGreaterThanOrEqual(40);
		expect(layout(320).left).toBe(44);
	});
});
