import { type Color, colorToRgb, parseColor, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { filterCycle } from "../../src/stats/aggregate.ts";
import { GUTTER, TICKS } from "../../src/stats/chart.ts";
import { CONTENT_SHARE, chartHeight, contentWidth, StatsView, summary } from "../../src/stats/component.ts";
import { addDays } from "../../src/stats/days.ts";
import type { Call } from "../../src/stats/load.ts";
import { at, call } from "./fixtures.ts";
import { danglingPorts } from "./ports.ts";

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const strip = (s: string) => s.replace(ANSI, "");
/** Emits real ANSI so width checks are ANSI-aware. */
const theme = {
	fg: (c: string, s: string) => `\u001b[3${c.length % 8}m${s}\u001b[39m`,
	bg: (c: string, s: string) => `\u001b[4${c.length % 8}m${s}\u001b[49m`,
	bold: (s: string) => `\u001b[1m${s}\u001b[22m`,
	/** Series colours as real truecolor SGR, so tests can see which colour drew what. */
	style: (s: string, o: { fg?: Color }) => {
		const { r, g, b } = colorToRgb(o.fg ?? parseColor("#000000"));
		return `\u001b[38;2;${r};${g};${b}m${s}\u001b[39m`;
	},
	colors: { accent: parseColor("#426a79") },
};
const SERIES_SGR = new RegExp(`${String.fromCharCode(27)}\\[38;2;(\\d+;\\d+;\\d+)m`, "g");
const TODAY = "2026-10-13";

it("hourly views preserve total/filter scope, partial and repeated-hour labels across 60..320 columns", () => {
	const saved = process.env.TZ;
	try {
		process.env.TZ = "America/New_York";
		const now = Date.parse("2026-11-01T06:30:00Z");
		const calls = [
			call(TODAY, "p", "m", 100, 0, { ms: now - 90 * 60000 }),
			call(TODAY, "p", "m", 200, 0, { ms: now - 30 * 60000 }),
			call(TODAY, "p", "m", 9999, 0, { ms: now + 1 }),
		];
		const view = new StatsView({
			calls,
			sessions: [],
			now,
			theme: theme as never,
			rows: () => 80,
			requestRender() {},
			onClose() {},
		});
		for (let i = 0; i < 3; i++) view.handleInput("r");
		expect(view.state.range).toBe("5h");
		for (const width of [60, 80, 120, 180, 240, 320]) {
			const lines = view.render(width);
			const text = strip(lines.join("\n"));
			expect(text).toContain("Tokens per hour");
			expect(text).toContain("Total tokens: 300");
			expect(text).toContain("partial");
			expect(text).toContain("01:00 UTC-04:00");
			expect(text).toContain("01:00 UTC-05:00");
			expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
		}
		view.handleInput("\t");
		expect(strip(view.render(120).join("\n"))).toContain("In: 300");
	} finally {
		if (saved === undefined) delete process.env.TZ;
		else process.env.TZ = saved;
	}
});
/** Plot rows of a rendered screen: the axis column (after the 1-col pad and the labels) is drawn. */
const plotRows = (lines: readonly string[]) => lines.filter((l) => /^[┤│┼]$/.test([...l][GUTTER] ?? ""));

function sampleCalls(): Call[] {
	const out: Call[] = [];
	const models: [string, string, number][] = [
		["anthropic", "claude-opus-5-5", 9],
		["anthropic", "claude-sonnet-5-5", 5],
		["anthropic", "claude-haiku-4-5", 1],
		["openai-codex", "gpt-6.1-sol", 7],
		["openai-codex", "gpt-6-astra", 3],
		["openai-codex", "gpt-5.6-terra", 2],
	];
	for (let d = 0; d < 60; d++) {
		const day = addDays(TODAY, -d);
		for (const [provider, model, weight] of models) {
			if ((d + weight) % 3 === 0) continue;
			out.push(
				call(day, provider, model, weight * 1000 * (1 + (d % 5)), weight * 100, {
					cacheWrite: weight * 50_000,
					cacheRead: 1e6,
					cost: weight / 10,
				}),
			);
		}
	}
	return out.sort((a, b) => a.ms - b.ms);
}

function make(rows = 44, calls = sampleCalls()) {
	const onClose = vi.fn();
	const requestRender = vi.fn();
	const sessions = [{ path: "/a", startMs: at(TODAY, 9), endMs: at(TODAY, 10) }];
	const view = new StatsView({
		calls,
		sessions,
		theme: theme as never,
		rows: () => rows,
		requestRender,
		onClose,
		today: TODAY,
		badLines: 2,
	});
	return { view, onClose, requestRender };
}

describe("StatsView", () => {
	it("renders exactly `rows` lines, none wider than the pane, on both tabs at every width", () => {
		for (const width of [1, 20, 40, 59, 60, 61, 80, 99, 120, 160, 200, 240, 319, 320]) {
			for (const rows of [4, 10, 24, 44, 80]) {
				for (const tab of ["Overview", "Models"] as const) {
					const { view } = make(rows);
					if (tab === "Models") view.handleInput("\t");
					for (const step of ["", "m", "r", "j"]) {
						if (step) view.handleInput(step);
						const lines = view.render(width);
						expect(lines).toHaveLength(Math.max(4, rows));
						for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
					}
				}
			}
		}
	});

	it("shows the heatmap, the numbers, the chart and the warning on Overview", () => {
		const text = make(60).view.render(120).map(strip).join("\n");
		expect(text).toContain("Mon ");
		expect(text).toContain("Less ░ ▒ ▓ █ More");
		expect(text).toContain("Favorite model: anthropic/claude-opus-5-5");
		expect(text).toMatch(/Active days: \d+\/60/);
		// 60 days into a 75%-wide plot at 120 columns: one column per day
		expect(text).toContain("Tokens per day  (in + out + cache) · by provider");
		expect(text).toMatch(/total: peak \S+ on \w{3} \d+ · avg \S+\/day/);
		expect(text).toContain("● anthropic · ● openai-codex");
		expect(text).toContain("! 2 unreadable lines");
	});

	it("Tab switches to Models: chart, provider headers and two-up model entries", () => {
		const { view, requestRender } = make(60);
		view.handleInput("\t");
		expect(view.state.tab).toBe("Models");
		expect(requestRender).toHaveBeenCalled();
		const lines = view.render(120).map(strip);
		const text = lines.join("\n");
		expect(text).toMatch(/• anthropic {2}\S+ \(\d+\.\d%\)/);
		expect(text).toContain("In: ");
		expect(text).toMatch(/Cache: \S+ read · \S+ write · \$\d+\.\d\d notional/);
		// two models side by side on one line at 120 columns
		expect(lines.some((l) => (l.match(/• claude-/g) ?? []).length === 2)).toBe(true);
		// one per line under 80
		expect(
			view
				.render(70)
				.map(strip)
				.some((l) => (l.match(/• claude-/g) ?? []).length === 2),
		).toBe(false);
	});

	it("r cycles All -> 7d -> 30d -> 5h -> 24h -> All", () => {
		const { view } = make();
		expect(view.state.range).toBe("all");
		view.handleInput("r");
		expect(view.state.range).toBe("7d");
		expect(strip(view.render(120).join("\n"))).toMatch(/Active days: \d\/7/);
		view.handleInput("r");
		expect(view.state.range).toBe("30d");
		view.handleInput("r");
		expect(view.state.range).toBe("5h");
		view.handleInput("r");
		expect(view.state.range).toBe("24h");
		view.handleInput("r");
		expect(view.state.range).toBe("all");
	});

	it("m/M walk All -> providers -> models and back, changing what is charted", () => {
		const { view } = make();
		view.handleInput("\t");
		view.handleInput("m");
		expect(view.state.filter).toEqual({ kind: "provider", provider: "anthropic" });
		let text = strip(view.render(120).join("\n"));
		expect(text).toContain("· by model");
		expect(text).toContain(
			"● anthropic/claude-opus-5-5 · ● anthropic/claude-sonnet-5-5 · ● anthropic/claude-haiku-4-5",
		);
		expect(text).not.toContain("gpt-6.1-sol");
		view.handleInput("m");
		view.handleInput("m");
		expect(view.state.filter).toEqual({ kind: "model", name: "anthropic/claude-opus-5-5" });
		text = strip(view.render(120).join("\n"));
		expect(text).toContain("filter: anthropic/claude-opus-5-5");
		expect(text).not.toContain("claude-sonnet");
		view.handleInput("M");
		view.handleInput("M");
		view.handleInput("M");
		expect(view.state.filter).toEqual({ kind: "all" });
		// wraps backwards to the smallest model
		view.handleInput("M");
		expect(view.state.filter).toEqual(filterCycle(sampleCalls()).at(-1));
		expect(view.state.filter.kind).toBe("model");
	});

	it("reaches every model by scrolling, even in a pane too short for the chart", () => {
		for (const rows of [12, 20, 36]) {
			const { view } = make(rows);
			view.handleInput("\t");
			const seen = new Set<string>();
			const hints: string[] = [];
			for (let i = 0; i < 120; i++) {
				const lines = view.render(70).map(strip);
				for (const m of lines.join("\n").matchAll(/• (claude-[\w-]+|gpt-[\w.-]+) \(/g)) seen.add(m[1] ?? "");
				hints.push(lines.at(-1) ?? "");
				view.handleInput("j");
			}
			expect(seen.size, `rows=${rows}`).toBe(6);
			for (const hint of hints) expect(hint).not.toMatch(/Infinity|NaN/);
			// at the bottom: the last model is on screen and nothing is below it (or everything fits)
			expect(hints.at(-1)).toMatch(/^ (↑ {3}\d+-6 of 6 models {2})?tab tabs/);
			for (let i = 0; i < 200; i++) view.handleInput("k");
			expect(view.state.scroll).toBe(0);
		}
		// at the top of a short pane the list has not started yet
		const { view } = make(12);
		view.handleInput("\t");
		expect(strip(view.render(70).at(-1) ?? "")).toContain("↓ 6 models below");
		// tall enough for everything: no hint at all
		const tall = make(120).view;
		tall.handleInput("\t");
		expect(strip(tall.render(120).at(-1) ?? "")).toMatch(/^ tab tabs/);
	});

	it("wraps the legend instead of cutting a series name off", () => {
		const { view } = make(60);
		view.handleInput("\t");
		view.handleInput("m");
		const lines = view.render(60).map(strip);
		for (const name of ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-4-5"])
			expect(lines.some((l) => l.includes(`● anthropic/${name}`))).toBe(true);
	});

	it("fills a fullscreen pane: the chart grows instead of leaving empty rows (regression, 130x38)", () => {
		for (const [width, rows] of [
			[130, 38],
			[120, 44],
			[200, 60],
		] as const) {
			const lines = make(rows).view.render(width).map(strip);
			const legend = lines.findIndex((l) => l.includes("● anthropic"));
			expect(legend, lines.join("\n")).toBeGreaterThan(0);
			// rows between the legend and the help row: under one tick step of slack
			const blank = lines.slice(legend + 1, -1).filter((l) => l.trim() === "").length;
			expect(blank, `${width}x${rows}\n${lines.join("\n")}`).toBeLessThan(5);
			const body = plotRows(lines).map((l) => [...l].slice(1 + GUTTER).join(""));
			expect(body.length).toBeGreaterThan(TICKS + 1);
			expect(danglingPorts(body), `${width}x${rows}\n${lines.join("\n")}`).toEqual([]);
		}
		// 130x38 is the pane from the bug report: 5 rows above zero before, 10 now
		expect(plotRows(make(38).view.render(130).map(strip))).toHaveLength(10 + 1);
	});

	it("spans 75% of the pane, never under a year of heatmap when it fits (regression: stuck at 56 cols)", () => {
		expect([12, 40, 57, 60, 80, 130, 200, 320].map(contentWidth)).toEqual([11, 39, 56, 56, 59, 97, 149, 239]);
		for (const width of [80, 130, 200, 320]) {
			const lines = make(80).view.render(width).map(strip);
			const mon = lines.find((l) => l.startsWith(" Mon ")) ?? "";
			const zero = lines.find((l) => /^ +0 ┼/.test(l)) ?? "";
			const share = (visibleWidth(mon) - 1) / (width - 1);
			expect(share, `${width}`).toBeCloseTo(CONTENT_SHARE, 1);
			expect(visibleWidth(zero)).toBe(visibleWidth(mon));
		}
	});

	it("draws the chart exactly as wide as the heatmap above it (regression: chart ran to the pane edge)", () => {
		for (const width of [12, 20, 25, 29, 40, 60, 80, 100, 130, 200, 320]) {
			const lines = make(80).view.render(width).map(strip);
			const mon = lines.find((l) => l.startsWith(" Mon "));
			const zero = lines.find((l) => /^ +0 ┼/.test(l));
			expect(mon, `${width}`).toBeDefined();
			expect(zero, `${width}`).toBeDefined();
			expect(visibleWidth(zero ?? ""), `${width}\n${mon}\n${zero}`).toBe(visibleWidth(mon ?? ""));
		}
		// The pane clips at its edge, so equal widths alone could hide an overflowing chart: on the
		// 7-day range the x axis must end with today's full date inside the heatmap's width.
		for (const width of [20, 25, 29, 40, 80, 130]) {
			const { view } = make(80);
			view.handleInput("r");
			const lines = view.render(width).map(strip);
			const mon = lines.find((l) => l.startsWith(" Mon ")) ?? "";
			const axis = lines.find((l) => /\d\s*$/.test(l) && /^ {9}/.test(l) && /[A-Z][a-z]{2} \d/.test(l)) ?? "";
			expect(axis.trimEnd(), `${width}\n${lines.join("\n")}`).toMatch(/Oct 13$/);
			expect(visibleWidth(axis.trimEnd())).toBeLessThanOrEqual(visibleWidth(mon));
		}
	});

	it("colours every series line in its legend colour, distinct per series, on every tab and filter", () => {
		const check = (view: StatsView, series: number) => {
			const raw = view.render(130);
			const legend = raw.filter((l) => strip(l).includes("● ")).join("");
			const legendColors = [...legend.matchAll(SERIES_SGR)].map((m) => m[1]);
			expect(legendColors).toHaveLength(series);
			expect(new Set(legendColors).size).toBe(series);
			// only the plot rows: the legend must not vouch for itself
			const plotColors = new Set(
				raw
					.filter((l) => /^[┤│┼]$/.test([...strip(l)][GUTTER] ?? ""))
					.flatMap((l) => [...l.matchAll(SERIES_SGR)].map((m) => m[1])),
			);
			for (const color of legendColors) expect(plotColors.has(color), `${color} not drawn`).toBe(true);
		};
		const { view } = make(80);
		check(view, 2);
		view.handleInput("\t");
		check(view, 2);
		view.handleInput("m");
		check(view, 3);
		view.handleInput("m");
		view.handleInput("m");
		view.handleInput("m");
		check(view, 1);
	});

	it("gives the Models chart about half the pane", () => {
		const { view } = make(60);
		view.handleInput("\t");
		const lines = view.render(130).map(strip);
		// 56 rows of room: half is 28, minus the chart's 5 lines of furniture -> 20 rows above zero
		expect(plotRows(lines)).toHaveLength(chartHeight(28 - 5) + 1);
		expect(chartHeight(28 - 5)).toBe(20);
	});

	it("goes two-up at exactly 80 columns, one-up at 79", () => {
		const twoUp = (width: number) => {
			const { view } = make(120);
			view.handleInput("\t");
			return view
				.render(width)
				.map(strip)
				.some((l) => (l.match(/• (claude|gpt)-/g) ?? []).length === 2);
		};
		expect(twoUp(80)).toBe(true);
		expect(twoUp(79)).toBe(false);
	});

	it("q, Escape and Ctrl+C close; other keys are ignored", () => {
		for (const key of ["q", "\u001b", "\u0003"]) {
			const { view, onClose } = make();
			view.handleInput(key);
			expect(onClose).toHaveBeenCalledTimes(1);
		}
		const { view, requestRender } = make();
		view.handleInput("x");
		expect(requestRender).not.toHaveBeenCalled();
	});

	it("handles an empty range and a single day of data", () => {
		const old = [call("2026-01-01", "anthropic", "opus", 10, 10)];
		const { view } = make(44, old);
		view.handleInput("r");
		expect(strip(view.render(100).join("\n"))).toContain("No usage in this range.");
		const today = [call(TODAY, "anthropic", "opus", 10, 10)];
		const single = make(44, today).view;
		expect(strip(single.render(100).join("\n"))).toContain("Not enough data for a chart yet");
	});
});

describe("chartHeight", () => {
	it("uses whole tick steps between 5 and 40 rows", () => {
		expect([-3, 0, 4, 5, 9, 10, 14, 23, 99].map(chartHeight)).toEqual([5, 5, 5, 5, 5, 10, 10, 20, 40]);
	});
});

describe("summary", () => {
	it("prints an aligned per-model table", () => {
		const text = summary([
			call(TODAY, "anthropic", "opus", 1000, 2000, { cacheRead: 5e6, cacheWrite: 7000, cost: 1.25 }),
			call(TODAY, "openai-codex", "sol", 10, 0),
		]);
		expect(text.split("\n")).toEqual([
			"/stats: 5M tokens (in + out + cache), all time",
			"provider      model  in  out  cache read  cache write   cost       %",
			"anthropic     opus   1k   2k          5M           7k  $1.25  100.0%",
			"openai-codex  sol    10    0           0            0  $0.00    0.0%",
		]);
		expect(summary([])).toBe("/stats: no usage recorded yet");
	});
});
