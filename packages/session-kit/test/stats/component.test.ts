import { type Color, colorToRgb, parseColor, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { filterCycle } from "../../src/stats/aggregate.ts";
import { GUTTER, TICKS } from "../../src/stats/chart.ts";
import { chartHeight, contentWidth, StatsView, summary } from "../../src/stats/component.ts";
import { addDays } from "../../src/stats/days.ts";
import { DAY_LABEL_WIDTH, MAX_WEEKS } from "../../src/stats/heatmap.ts";
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
			expect(text).toMatch(/Total tokens +300/);
			expect(text).toContain("partial");
			expect(text).toContain("01:00 UTC-04:00");
			expect(text).toContain("01:00 UTC-05:00");
			expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
		}
		view.handleInput("\t");
		expect(strip(view.render(120).join("\n"))).toMatch(
			/Tokens +Share +In +Out[^\n]*\n[^\n]*\n[^\n]*300 +100\.0% +300 /,
		);
	} finally {
		if (saved === undefined) delete process.env.TZ;
		else process.env.TZ = saved;
	}
});
/** Plot rows of a rendered screen: the axis column (after the 1-col pad and the labels) is drawn. */
const plotRows = (lines: readonly string[]) => lines.filter((l) => /^[┤│]$/.test([...l][GUTTER] ?? ""));

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
		expect(text).toMatch(/Favorite model +anthropic\/claude-opus-5-5/);
		expect(text).toMatch(/Active days +\d+\/60/);
		// 60 days into a 75%-wide plot at 120 columns: one column per day
		expect(text).toContain("Tokens per day  (in + out + cache) · by provider");
		expect(text).toMatch(/total: peak \S+ on \w{3} \d+ · avg \S+\/day/);
		expect(text).toContain("● anthropic · ● openai-codex");
		expect(text).toContain("! 2 unreadable lines");
	});

	it("Tab switches to Models: chart, then a provider/model table from 100 columns", () => {
		const { view, requestRender } = make(60);
		view.handleInput("\t");
		expect(view.state.tab).toBe("Models");
		expect(requestRender).toHaveBeenCalled();
		const lines = view.render(120).map(strip);
		const header = lines.find((l) => l.includes("Cache read")) ?? "";
		expect(header).toMatch(/Tokens +Share +In +Out +Cache read +Cache write +Cost \(notional\)/);
		// provider subtotal, then its models, one aligned line each, every column ending on the same edge
		const provider = lines.find((l) => /• anthropic /.test(l)) ?? "";
		const model = lines.find((l) => l.includes("claude-opus-5-5") && /\d%/.test(l)) ?? "";
		expect(provider).toMatch(/• anthropic +\S+M +\d+\.\d% /);
		expect(model).toMatch(/claude-opus-5-5 +\S+M +\d+\.\d% /);
		expect(model).toMatch(/\$\d+\.\d\d$/);
		expect(visibleWidth(model)).toBe(visibleWidth(provider));
		expect(visibleWidth(model)).toBe(visibleWidth(header));
		// three-line cards under the table's width
		const cards = view.render(70).map(strip);
		expect(cards.join("\n")).toMatch(/• anthropic {2}\S+ \(\d+\.\d%\)/);
		expect(cards.join("\n")).toContain("In: ");
		expect(cards.join("\n")).toMatch(/Cache: \S+ read · \S+ write · \$\d+\.\d\d notional/);
		expect(cards.some((l) => l.includes("Cache read"))).toBe(false);
	});

	it("r cycles All -> 7d -> 30d -> 5h -> 24h -> All", () => {
		const { view } = make();
		expect(view.state.range).toBe("all");
		view.handleInput("r");
		expect(view.state.range).toBe("7d");
		expect(strip(view.render(120).join("\n"))).toMatch(/Active days +\d\/7/);
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
			const caption = lines.findIndex((l) => l.includes("total: peak"));
			expect(caption, lines.join("\n")).toBeGreaterThan(0);
			// rows between the caption and the help row: the spacer plus under one tick step of slack
			const blank = lines.slice(caption + 1, -1).filter((l) => l.trim() === "").length;
			// ... unless the chart is already at its 40-row cap
			if (plotRows(lines).length < 41) expect(blank, `${width}x${rows}\n${lines.join("\n")}`).toBeLessThan(6);
			else expect(plotRows(lines)).toHaveLength(41);
			const body = plotRows(lines).map((l) => [...l].slice(1 + GUTTER).join(""));
			expect(body.length).toBeGreaterThan(TICKS + 1);
			expect(danglingPorts(body), `${width}x${rows}\n${lines.join("\n")}`).toEqual([]);
		}
		// 130x38 is the pane from the bug report: 5 rows above zero before, 15 now that the numbers sit beside the heatmap
		expect(plotRows(make(38).view.render(130).map(strip))).toHaveLength(15 + 1);
	});

	it("spans the whole pane: blocks run to the right margin, and the heatmap stops at two years", () => {
		expect([12, 40, 57, 60, 80, 130, 200, 320].map(contentWidth)).toEqual([11, 39, 56, 59, 79, 129, 199, 319]);
		for (const width of [40, 80, 130, 200, 320]) {
			const lines = make(80).view.render(width).map(strip);
			const zero = lines.find((l) => /^ +0 ┤/.test(l)) ?? "";
			const base = lines.find((l) => /^ +└/.test(l)) ?? "";
			expect(visibleWidth(zero), `${width}`).toBe(width);
			expect(visibleWidth(base), `${width}`).toBe(width);
			const mon = lines.find((l) => l.startsWith(" Mon ")) ?? "";
			expect(visibleWidth(mon.trimEnd()), `${width}`).toBeLessThanOrEqual(width);
		}
		const mon = (width: number) =>
			make(80)
				.view.render(width)
				.map(strip)
				.find((l) => l.startsWith(" Mon "))
				?.split("  ")[0] ?? "";
		expect(visibleWidth(mon(320))).toBeLessThanOrEqual(1 + DAY_LABEL_WIDTH + MAX_WEEKS);
	});

	it("puts the numbers beside the heatmap once a year of it still fits next to them, else under it", () => {
		const beside = make(60).view.render(160).map(strip);
		const favorite = beside.findIndex((l) => l.includes("Favorite model"));
		expect(beside[favorite]).toContain("Nov"); // shares the heatmap's month row
		expect(beside.findIndex((l) => l.includes("Mon "))).toBeGreaterThan(favorite);
		const stacked = make(60).view.render(100).map(strip);
		expect(stacked.findIndex((l) => l.includes("Favorite model"))).toBeGreaterThan(
			stacked.findIndex((l) => l.includes("Less ░")),
		);
		// one column of cells, labels and values aligned
		const values = beside.filter((l) => /Total tokens|Sessions|Notional cost/.test(l)).map((l) => l.search(/\S+$/));
		expect(values.length).toBe(3);
	});

	it("never cuts a stat row it chose to lay out in several columns", () => {
		// Labels are padded to their column's longest, so a short label with a long value (`Favorite
		// model`) next to a long label with a short value must still fit the width the grid budgeted.
		const LABELS = ["Favorite model", "Total tokens", "Sessions", "Longest session", "Active days"];
		const LABELS2 = ["Longest streak", "Most active day", "Current streak", "Cache tokens", "Notional cost"];
		const { view } = make(60);
		for (let range = 0; range < 5; range++, view.handleInput("r"))
			for (let width = 40; width <= 200; width++) {
				const rows = view
					.render(width)
					.map(strip)
					.filter((l) => [...LABELS, ...LABELS2].filter((label) => l.includes(label)).length > 1);
				for (const row of rows) expect(row, `range ${range}, ${width} cols`).not.toContain("…");
			}
	});

	it("aligns the x axis to the chart: baseline marks over the labels, today's end inside the plot", () => {
		for (const width of [30, 40, 60, 80, 130]) {
			const { view } = make(80);
			view.handleInput("r");
			const lines = view.render(width).map(strip);
			const base = lines.find((l) => /^ +└/.test(l)) ?? "";
			const names = lines[lines.indexOf(base) + 1] ?? "";
			expect(names.trim().length, `${width}\n${lines.join("\n")}`).toBeGreaterThan(0);
			expect(visibleWidth(names)).toBeLessThanOrEqual(visibleWidth(base));
			// each label has a baseline mark inside the span it covers
			for (const m of names.matchAll(/\S+( \d+)?/g)) {
				const span = base.slice(m.index, m.index + m[0].length);
				expect(span, `${width}: ${m[0]}`).toContain("┬");
			}
			// 7d is Wed 7 .. Tue 13: today's label is the last one, whole
			expect(names.trimEnd()).toMatch(/(Tue( 13)?|Oct 13)$/);
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
					.filter((l) => /^[┤│]$/.test([...strip(l)][GUTTER] ?? ""))
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

	it("gives the Models chart half the pane, or what a short list leaves it", () => {
		// 55 rows of room, 9 table lines: the list leaves 46, minus 7 lines of furniture -> 35 rows
		const { view } = make(60);
		view.handleInput("\t");
		expect(plotRows(view.render(130).map(strip))).toHaveLength(chartHeight(55 - 9 - 7) + 1);
		expect(chartHeight(55 - 9 - 7)).toBe(35);
		// cards: 20 lines (2 headers, 6 models x 3), so 55 - 20 - 7 -> 25 rows
		expect(plotRows(view.render(60).map(strip))).toHaveLength(chartHeight(55 - 20 - 7) + 1);
		expect(chartHeight(55 - 20 - 7)).toBe(25);
	});

	it("shows the table at 100 columns and cards one column narrower", () => {
		const table = (width: number) => {
			const { view } = make(120);
			view.handleInput("\t");
			return view
				.render(width)
				.map(strip)
				.some((l) => l.includes("Cache write"));
		};
		expect(table(110)).toBe(true);
		expect(table(100)).toBe(true);
		expect(table(84)).toBe(false);
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
