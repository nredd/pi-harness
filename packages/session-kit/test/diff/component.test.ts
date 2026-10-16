import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { DiffView } from "../../src/diff/component.ts";
import { type DiffFile, parseUnifiedDiff } from "../../src/diff/parse.ts";

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

/** Emits real ANSI so width checks are ANSI-aware. */
const theme = {
	fg: (c: string, s: string) => `\u001b[3${c.length % 8}m${s}\u001b[39m`,
	bg: (c: string, s: string) => `\u001b[4${c.length % 8}m${s}\u001b[49m`,
	bold: (s: string) => `\u001b[1m${s}\u001b[22m`,
};

function sample(): DiffFile[] {
	const long = "x".repeat(500);
	const text = [
		"diff --git a/src/a.ts b/src/a.ts",
		"--- a/src/a.ts",
		"+++ b/src/a.ts",
		"@@ -1,3 +1,3 @@",
		" context",
		`-removed ${long}`,
		`+added \u4e2d\u6587\u5b57 \ud83d\ude80 ${long}`,
		"+\tTabbed\u001b[31m escape",
		...Array.from({ length: 80 }, (_, i) => `+line ${i}`),
		"diff --git a/a/very/long/path/that/keeps/going/on/and/on/file.ts b/a/very/long/path/that/keeps/going/on/and/on/file.ts",
		"--- a/a/very/long/path/that/keeps/going/on/and/on/file.ts",
		"+++ b/a/very/long/path/that/keeps/going/on/and/on/file.ts",
		"@@ -1 +1 @@",
		"-a",
		"+b",
		"diff --git a/\u4e2d\u6587.txt b/\u4e2d\u6587.txt",
		"new file mode 100644",
		"--- /dev/null",
		"+++ b/\u4e2d\u6587.txt",
		"@@ -0,0 +1 @@",
		"+hello",
	].join("\n");
	return parseUnifiedDiff(text);
}

function make(rows = 24, files = sample()) {
	const onClose = vi.fn();
	const requestRender = vi.fn();
	const view = new DiffView({ files, label: "HEAD", theme: theme as never, rows: () => rows, requestRender, onClose });
	return { view, onClose, requestRender, files };
}

describe("DiffView", () => {
	it("renders exactly `rows` lines, none wider than the pane, at every width from 60 to 320", () => {
		for (const width of [1, 5, 20, 40, 59, 60, 61, 80, 99, 120, 160, 200, 240, 319, 320]) {
			for (const rows of [3, 10, 24, 60]) {
				const { view } = make(rows);
				const lines = view.render(width);
				expect(lines).toHaveLength(Math.max(3, rows));
				for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
		}
	});

	it("fills every body row to the full width (no ragged right edge) from 60 up", () => {
		for (const width of [60, 80, 120, 160, 200, 240, 320]) {
			const lines = make(24).view.render(width);
			for (const line of lines) expect(visibleWidth(line)).toBe(width);
		}
	});

	it("keeps rendering correct after panning, scrolling and file changes at narrow and wide widths", () => {
		const { view } = make(12);
		for (const key of ["l", "l", "j", "j", "n", "l", "p", "G", "l", "n", "n", "h", "g"]) {
			view.handleInput(key);
			for (const width of [60, 61, 320])
				for (const line of view.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("shows file names, status letters, counts and position", () => {
		const text = make(24).view.render(120).join("\n").replace(ANSI, "");
		expect(text).toContain("/diff HEAD  3 files");
		expect(text).toContain("+84 -2");
		expect(text).toContain("M src/a.ts");
		expect(text).toContain("A \u4e2d\u6587.txt");
		expect(text).toContain("1/3");
	});

	it("neutralises raw escapes from file content", () => {
		const rendered = make(40).view.render(200).join("\n");
		expect(rendered).toContain("^[[31m");
		// every ESC left is one of the theme's own SGR sequences
		expect(rendered.replace(ANSI, "")).not.toContain("\u001b");
	});

	it("scrolls with j/k/arrows/PgUp/PgDn/g/G and clamps at both ends", () => {
		const { view, requestRender } = make(12); // body = 10
		view.render(100);
		const total = 4 + 1 + 1 + 1 + 1 + 80; // header(3)+hunk+ctx/-/+/+tab+80
		view.handleInput("j");
		view.handleInput("\u001b[B");
		expect(view.scrollOffset).toBe(2);
		view.handleInput("k");
		expect(view.scrollOffset).toBe(1);
		view.handleInput("g");
		view.handleInput("k");
		expect(view.scrollOffset).toBe(0);
		view.handleInput("\u001b[6~");
		expect(view.scrollOffset).toBe(9);
		view.handleInput("\u001b[5~");
		expect(view.scrollOffset).toBe(0);
		view.handleInput("G");
		const last = view.scrollOffset;
		expect(last).toBeGreaterThan(50);
		view.handleInput("j");
		expect(view.scrollOffset).toBe(last);
		expect(requestRender).toHaveBeenCalled();
		expect(total).toBeGreaterThan(0);
	});

	it("navigates files with n/p, clamped, and remembers each file's scroll", () => {
		const { view } = make(12);
		view.render(100);
		view.handleInput("j");
		view.handleInput("j");
		view.handleInput("n");
		expect(view.selectedIndex).toBe(1);
		expect(view.scrollOffset).toBe(0);
		view.handleInput("n");
		view.handleInput("n");
		expect(view.selectedIndex).toBe(2);
		view.handleInput("p");
		view.handleInput("p");
		view.handleInput("p");
		expect(view.selectedIndex).toBe(0);
		expect(view.scrollOffset).toBe(2);
	});

	it("closes on q, Escape and Ctrl+C, and ignores other keys without a render", () => {
		for (const key of ["q", "\u001b", "\u0003"]) {
			const { view, onClose } = make();
			view.handleInput(key);
			expect(onClose).toHaveBeenCalledTimes(1);
		}
		const { view, onClose, requestRender } = make();
		view.handleInput("z");
		expect(onClose).not.toHaveBeenCalled();
		expect(requestRender).not.toHaveBeenCalled();
	});

	it("shows the truncation notice as the last patch line", () => {
		const files = sample();
		(files[0] as DiffFile).notice = "patch truncated: 5 more lines not shown";
		const { view } = make(200, files);
		view.handleInput("G");
		const text = view.render(160).join("\n").replace(ANSI, "");
		expect(text).toContain("... patch truncated: 5 more lines not shown");
	});

	it("handles an empty file list without throwing", () => {
		const { view } = make(10, []);
		view.handleInput("n");
		view.handleInput("j");
		expect(view.render(80)).toHaveLength(10);
	});
});
