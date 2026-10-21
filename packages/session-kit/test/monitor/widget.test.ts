import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import type { MonitorInfo } from "../../src/monitor/types.ts";
import {
	MonitorWidget,
	monitorState,
	renderWidget,
	WIDGET_KEY,
	type WidgetView,
	windowFor,
} from "../../src/monitor/widget.ts";

const theme = { fg: (_color: string, text: string) => text };
const colorTheme = { fg: (color: string, text: string) => `<${color}>${text}</>` };
const NOW = 7 * 60_000;
const monitor = (over: Partial<MonitorInfo> = {}): MonitorInfo => ({
	id: "m1",
	name: "ci-56",
	argv: ["make"],
	pid: 1,
	status: "running",
	startedAt: 0,
	exitCode: null,
	signal: null,
	lines: 4,
	matches: 0,
	lastLine: "pass=6 pending=3",
	wake: false,
	timeoutMs: 3_600_000,
	...over,
});
const view = (over: Partial<WidgetView> = {}): WidgetView => ({
	collapsed: false,
	offset: 0,
	maxLines: 12,
	collapseKey: "ctrl+shift+m",
	...over,
});
const many = (n: number): MonitorInfo[] =>
	Array.from({ length: n }, (_, i) => monitor({ id: `m${i}`, name: `w${i}`, lastLine: `line ${i}` }));

describe("monitorState", () => {
	it("maps status, matches and exit to a state", () => {
		expect(monitorState(monitor())).toBe("running");
		expect(monitorState(monitor({ matches: 2 }))).toBe("matched");
		expect(monitorState(monitor({ status: "exited", exitCode: 0 }))).toBe("exited");
		expect(monitorState(monitor({ status: "exited", exitCode: 2 }))).toBe("failed");
		expect(monitorState(monitor({ status: "exited", signal: "SIGKILL" }))).toBe("failed");
		expect(monitorState(monitor({ status: "timeout" }))).toBe("failed");
		expect(monitorState(monitor({ status: "stopped" }))).toBe("exited");
	});

	it("colors each bullet by state", () => {
		const rows = [
			monitor({ name: "a" }),
			monitor({ name: "b", matches: 1 }),
			monitor({ name: "c", status: "exited", exitCode: 1 }),
			monitor({ name: "d", status: "exited", exitCode: 0 }),
		];
		const { lines } = renderWidget(rows, NOW, 80, colorTheme, view());
		expect(lines[1]).toContain("<success>●</>");
		expect(lines[2]).toContain("<warning>●</>");
		expect(lines[3]).toContain("<error>●</>");
		expect(lines[4]).toContain("<dim>●</>");
	});
});

describe("renderWidget", () => {
	const infos = [
		monitor({ name: "ci94b", startedAt: NOW - 164_000, lines: 2, lastLine: "pass=2 fail=0 pending=8" }),
		monitor({ id: "m2", name: "tail", startedAt: 0, lines: 1, lastLine: "ready", matches: 1 }),
		monitor({ id: "m3", name: "build", status: "exited", exitCode: 0, endedAt: 60_000, lines: 9, lastLine: "ok" }),
	];

	it("expands to a heading and one row per monitor with flush-right stats", () => {
		const out = renderWidget(infos, NOW, 60, theme, view());
		expect(out.lines).toEqual([
			"▾ ● Monitors (2 running · 1 done)",
			"├─ ● ci94b  pass=2 fail=0 pending=8          2m44s · 2 lines",
			"├─ ● tail  ready                              7m00s · 1 line",
			"└─ ● build  ok                               1m00s · 9 lines",
			"",
		]);
		for (const line of out.lines) expect(visibleWidth(line)).toBeLessThanOrEqual(60);
	});

	it("collapses to the heading with a flush-right hint and the spacer", () => {
		const out = renderWidget(infos, NOW, 60, theme, view({ collapsed: true }));
		expect(out.lines).toEqual(["▸ ● Monitors (2 running · 1 done)     ctrl+shift+m to expand", ""]);
	});

	it("shows a static label when the shortcut is off and counts failures", () => {
		const failed = [monitor({ status: "exited", exitCode: 1 }), monitor({ id: "m2" })];
		const out = renderWidget(failed, NOW, 60, theme, view({ collapsed: true, collapseKey: "off" }));
		expect(out.lines[0]).toBe("▸ ● Monitors (1 running · 1 failed)                collapsed");
	});

	it("prioritizes the collapsed heading over its optional hint at narrow widths", () => {
		for (const width of [20, 30, 40, 80]) {
			const line = renderWidget(infos, NOW, width, theme, view({ collapsed: true })).lines[0] ?? "";
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			expect(line).toContain("Monitors (2");
			if (width < 80) expect(line).not.toContain("ctrl+shift+m to expand");
			else {
				expect(line).toContain("▸ ● Monitors (2 running · 1 done)");
				expect(line).toContain("ctrl+shift+m to expand");
			}
		}
	});

	it("keeps the expanded heading at narrow widths", () => {
		for (const width of [20, 30, 40, 80]) {
			const line = renderWidget(infos, NOW, width, theme, view()).lines[0] ?? "";
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			expect(line).toContain("Monitors (2");
		}
	});

	it("dims the heading once nothing runs, and renders nothing for no monitors", () => {
		const done = [monitor({ status: "exited", exitCode: 0 })];
		expect(renderWidget(done, NOW, 60, colorTheme, view()).lines[0]).toContain("<dim>○</>");
		expect(renderWidget([], NOW, 60, theme, view()).lines).toEqual([]);
	});

	it("labels an empty last line", () => {
		const out = renderWidget([monitor({ lastLine: undefined, lines: 0 })], NOW, 60, theme, view());
		expect(out.lines[1]).toContain("(no output)");
	});

	it("truncates the last line before the stats, at any narrow width", () => {
		const wide = [monitor({ lastLine: "進捗=".repeat(30) })];
		for (const width of [60, 40, 28, 20, 12, 6, 3]) {
			const { lines } = renderWidget(wide, NOW, width, theme, view());
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
		const [, row] = renderWidget(wide, NOW, 40, theme, view()).lines;
		expect(row).toContain("…");
		expect(row).toMatch(/7m00s · 4 lines$/);
	});

	it("keeps a constant height at every scroll offset and reports hidden rows", () => {
		const rows = many(9);
		const heights = new Set<number>();
		const texts = new Set<string>();
		for (let offset = 0; offset <= 12; offset++) {
			const out = renderWidget(rows, NOW, 70, theme, view({ maxLines: 6, offset }));
			heights.add(out.lines.length);
			texts.add(out.lines.filter((l) => /more$/.test(l)).join("|"));
		}
		expect([...heights]).toEqual([7]);
		const top = renderWidget(rows, NOW, 70, theme, view({ maxLines: 6 }));
		expect(top.lines.filter((l) => l.includes("more"))).toEqual(["└─ ↓ 5 more"]);
		const middle = renderWidget(rows, NOW, 70, theme, view({ maxLines: 6, offset: 2 }));
		expect(middle.lines.filter((l) => l.includes("more"))).toEqual(["├─ ↑ 2 more", "└─ ↓ 4 more"]);
		const bottom = renderWidget(rows, NOW, 70, theme, view({ maxLines: 6, offset: 99 }));
		expect(bottom.lines.filter((l) => l.includes("more"))).toEqual(["├─ ↑ 5 more"]);
		expect(bottom.offset).toBe(bottom.maxOffset);
	});

	it("shows every row when the budget is lifted by tool-output expansion", () => {
		expect(renderWidget(many(9), NOW, 70, theme, view({ maxLines: 6, showAll: true })).lines).toHaveLength(11);
	});
});

describe("windowFor", () => {
	it("is exactly `budget` rows tall for every offset when overflowing, and reaches every monitor", () => {
		for (const budget of [3, 4, 7]) {
			const seen = new Set<number>();
			for (let offset = -1; offset < 30; offset++) {
				const w = windowFor(12, budget, offset);
				expect(w.end - w.start + Number(w.above) + Number(w.below)).toBe(budget);
				for (let i = w.start; i < w.end; i++) seen.add(i);
			}
			expect(seen.size).toBe(12);
		}
	});

	it("does not window a list that fits", () => {
		expect(windowFor(3, 5, 4)).toEqual({ start: 0, end: 3, above: false, below: false, maxOffset: 0 });
	});
});

describe("MonitorWidget", () => {
	function setup(initial: MonitorInfo[], maxLines = 12) {
		let infos = initial;
		const setWidget = vi.fn();
		const requestRender = vi.fn();
		const widget = new MonitorWidget(() => infos, { maxLines, collapseKey: "ctrl+shift+m", now: () => NOW });
		widget.attach({ mode: "tui", ui: { setWidget, getToolsExpanded: () => false } } as never);
		const mount = () => {
			const factory = setWidget.mock.calls[0]?.[1];
			return factory({ requestRender }, theme) as {
				render(width: number): string[];
				handleMouse(event: unknown): unknown;
			};
		};
		return { widget, setWidget, requestRender, mount, set: (next: MonitorInfo[]) => (infos = next) };
	}

	it("registers above the editor while a monitor runs and clears when none do", () => {
		const t = setup([monitor()]);
		t.widget.refresh();
		expect(t.setWidget).toHaveBeenCalledWith(WIDGET_KEY, expect.any(Function), { placement: "aboveEditor" });
		t.set([monitor({ status: "exited", exitCode: 0 })]);
		t.widget.refresh();
		expect(t.setWidget).toHaveBeenLastCalledWith(WIDGET_KEY, undefined);
		t.widget.dispose();
	});

	it("toggles collapse with a forced redraw and again on a heading click only", () => {
		const t = setup([monitor()]);
		t.widget.refresh();
		const component = t.mount();
		expect(component.render(60)).toHaveLength(3);
		t.widget.toggle();
		expect(t.requestRender).toHaveBeenLastCalledWith(true);
		expect(component.render(60)).toHaveLength(2);
		expect(component.handleMouse({ type: "click", button: "left", y: 1 })).toBeUndefined();
		expect(component.handleMouse({ type: "click", button: "right", y: 0 })).toBeUndefined();
		expect(component.handleMouse({ type: "click", button: "left", y: 0 })).toEqual({ handled: true });
		expect(t.widget.isCollapsed()).toBe(false);
		t.widget.dispose();
	});

	it("scrolls with the wheel only when the window moves", () => {
		const t = setup(many(15));
		t.widget.refresh();
		const component = t.mount();
		expect(component.handleMouse({ type: "wheel", wheelDelta: -1 })).toBeUndefined();
		component.render(60);
		expect(component.handleMouse({ type: "wheel", wheelDelta: 2 })).toEqual({ handled: true });
		expect(component.render(60).some((l) => l.includes("↑ 2 more"))).toBe(true);
		t.widget.toggle();
		expect(component.handleMouse({ type: "wheel", wheelDelta: 2 })).toBeUndefined();
		t.widget.dispose();
	});

	it("keeps content rows at the cap as the mutable list crosses it", () => {
		const t = setup(many(5), 6);
		t.widget.refresh();
		const component = t.mount();
		for (const count of [5, 6, 5]) {
			t.set(many(count));
			const lines = component.render(80);
			expect(lines.at(-1)).toBe("");
			expect(lines.slice(0, -1)).toHaveLength(6);
		}
		expect(component.render(80).some((line) => line.includes("more"))).toBe(false);
		t.set(many(6));
		expect(component.render(80).filter((line) => line.includes("more"))).toEqual(["└─ ↓ 2 more"]);
		t.widget.dispose();
	});
});
