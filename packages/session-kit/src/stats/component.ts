/**
 * The `/stats` overlay: Claude Code's Stats pane rebuilt over pi sessions. Overview has the activity
 * heatmap, headline numbers and the token chart; Models has the chart and the per-model breakdown
 * grouped by provider. `r` cycles the date range, `m` / `M` the provider/model filter.
 */

import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { type Color, type Component, Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { sanitize } from "../diff/view.ts";
import {
	chartSeries,
	dailySeries,
	dailyTotals,
	type Filter,
	filterCycle,
	filterLabel,
	hourlySeries,
	inRange,
	isHourly,
	type ModelTotals,
	matches,
	modelName,
	modelTotals,
	overview,
	RANGE_LABEL,
	RANGES,
	type Range,
	rangeStart,
	TOKENS_NOTE,
	tokensOf,
} from "./aggregate.ts";
import { bucketize, GUTTER, plot, TICKS, xAxis } from "./chart.ts";
import { dayKey, shortDate } from "./days.ts";
import { duration, formatTokens, money, percent } from "./format.ts";
import { DAY_LABEL_WIDTH, heatmap, weeksFor, YEAR_WEEKS } from "./heatmap.ts";
import type { Call, Session } from "./load.ts";
import { seriesPalette } from "./palette.ts";

type ThemeLike = Pick<Theme, "fg" | "bg" | "bold" | "style" | "colors">;
export type Tab = "Overview" | "Models";
const TABS: readonly Tab[] = ["Overview", "Models"];
/** Chart lines, at most; their colours are shared by the chart, its legend and the model list. */
const SERIES = 3;
/** Narrowest plot `plot` can draw; only panes too narrow for a 6-week heatmap hit it. */
const MIN_PLOT_WIDTH = 2;
/** Share of the pane the heatmap and chart span. */
export const CONTENT_SHARE = 0.75;

/**
 * Columns the heatmap and the chart both span in a `paneWidth` pane (after the 1-column margin):
 * `CONTENT_SHARE` of it, but never narrower than a year of heatmap when that fits.
 */
export function contentWidth(paneWidth: number): number {
	const inner = Math.max(1, paneWidth - 1);
	return Math.min(inner, Math.max(Math.round(inner * CONTENT_SHARE), DAY_LABEL_WIDTH + YEAR_WEEKS));
}

/** Tallest chart, in rows above the zero line. */
const MAX_CHART_HEIGHT = 40;

/** Chart rows for `available` lines: whole tick steps (so every tick is a row), 5 to 40. */
export function chartHeight(available: number): number {
	const steps = Math.floor(available / TICKS) * TICKS;
	return Math.max(TICKS, Math.min(MAX_CHART_HEIGHT, steps));
}

/** Model list goes two-up from this width. */
const TWO_COLUMN_WIDTH = 80;

export interface StatsViewOptions {
	calls: readonly Call[];
	sessions: readonly Session[];
	theme: ThemeLike;
	rows: () => number;
	requestRender: () => void;
	onClose: () => void;
	/** Unparseable assistant lines found while loading. */
	badLines?: number;
	/** Injected for tests; defaults to the local today. */
	today?: string;
	now?: number;
	coverage?: string;
	tab?: Tab;
}

/** One scroll step of the model list: a provider header, or one or two models side by side. */
interface ListRow {
	lines: string[];
	/** Positions of its models in list order, for the `1-4 of N` hint. */
	models: number[];
}

export class StatsView implements Component {
	private tab: Tab;
	private range: Range = "all";
	private filterIndex = 0;
	private scroll = 0;
	private readonly palettes = new Map<number, Color[]>();
	private readonly filters: Filter[];
	private readonly today: string;
	private readonly now: number;

	constructor(private readonly o: StatsViewOptions) {
		this.tab = o.tab ?? "Overview";
		this.now = o.now ?? Date.now();
		this.filters = filterCycle(o.calls.filter((c) => c.ms <= this.now));
		this.today = o.today ?? dayKey(this.now);
	}

	invalidate(): void {
		// Nothing themed is cached: every render rebuilds colours from the live theme.
	}

	get state(): { tab: Tab; range: Range; filter: Filter; scroll: number } {
		return { tab: this.tab, range: this.range, filter: this.filter, scroll: this.scroll };
	}

	private get filter(): Filter {
		return this.filters[this.filterIndex] ?? { kind: "all" };
	}

	// --- input -------------------------------------------------------------------------------

	handleInput(data: string): void {
		if (data === "q" || matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.o.onClose();
			return;
		}
		if (matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab"))) {
			this.tab = this.tab === "Overview" ? "Models" : "Overview";
			this.scroll = 0;
		} else if (data === "r") {
			this.range = RANGES[(RANGES.indexOf(this.range) + 1) % RANGES.length] ?? "all";
			this.scroll = 0;
		} else if (data === "m") this.stepFilter(1);
		else if (data === "M" || matchesKey(data, Key.shift("m"))) this.stepFilter(-1);
		else if (data === "j" || matchesKey(data, Key.down)) this.scroll++;
		else if (data === "k" || matchesKey(data, Key.up)) this.scroll = Math.max(0, this.scroll - 1);
		else return;
		this.o.requestRender();
	}

	private stepFilter(delta: number): void {
		const n = this.filters.length;
		this.filterIndex = (((this.filterIndex + delta) % n) + n) % n;
		this.scroll = 0;
	}

	// --- render ------------------------------------------------------------------------------

	render(width: number): string[] {
		const w = Math.max(1, Math.floor(width));
		const rows = Math.max(4, Math.floor(this.o.rows()));
		const header = [this.tabsLine(), this.paint("muted", this.o.coverage ?? "local-only · never synced")];
		const room = Math.max(0, rows - header.length - 2);
		let body: string[];
		let hint = "";
		if (this.tab === "Overview") body = this.scrolled(this.overviewBody(w, room), room);
		else {
			const models = this.modelsBody(w, room);
			body = this.scrolled(models.lines, room);
			hint = this.modelHint(models.owners.slice(this.scroll, this.scroll + room), models.count);
		}
		while (body.length < room) body.push("");
		return [...header, ...body, "", this.help(hint)].map((line) => truncateToWidth(` ${line}`, w, ""));
	}

	/**
	 * `↑ ↓ 3-6 of 14 models` from the list positions on screen; arrows only where more models are.
	 * The list follows the chart, so a window with no model in it is always above the list. Empty when
	 * every model is visible. Lives in the help row, so it shows however short the pane.
	 */
	private modelHint(owners: readonly (readonly number[])[], count: number): string {
		const shown = owners.flat();
		if (count === 0 || new Set(shown).size === count) return "";
		if (shown.length === 0) return `  ↓ ${count} models below`;
		const first = Math.min(...shown) + 1;
		const last = Math.max(...shown) + 1;
		return `${first > 1 ? "↑" : " "} ${last < count ? "↓" : " "} ${first}-${last} of ${count} models`;
	}

	/** Clamp `scroll` and cut a `room`-line window out of `lines`. */
	private scrolled(lines: string[], room: number): string[] {
		this.scroll = Math.min(this.scroll, Math.max(0, lines.length - room));
		return lines.slice(this.scroll, this.scroll + room);
	}

	private paint(color: ThemeColor, text: string): string {
		return this.o.theme.fg(color, sanitize(text));
	}

	/**
	 * Paint in colour `index` of a `count`-colour series palette. Hues are spread evenly for the series
	 * actually drawn, so two providers get opposite hues (blue and orange on most themes).
	 */
	private paintSeries(index: number, count: number, text: string): string {
		let palette = this.palettes.get(count);
		if (!palette) {
			palette = seriesPalette(this.o.theme.colors.accent, count);
			this.palettes.set(count, palette);
		}
		const fg = palette[index];
		return fg ? this.o.theme.style(sanitize(text), { fg }) : this.paint("muted", text);
	}

	private tabsLine(): string {
		const t = this.o.theme;
		const tabs = TABS.map((tab) => (tab === this.tab ? t.bg("selectedBg", t.bold(` ${tab} `)) : ` ${tab} `)).join(" ");
		const bad = this.o.badLines ? `  ${this.paint("warning", `! ${this.o.badLines} unreadable lines`)}` : "";
		return `${t.bold(this.paint("accent", "/stats"))}  ${tabs}${bad}`;
	}

	private selectors(): string {
		const t = this.o.theme;
		const ranges = RANGES.map((r) =>
			r === this.range ? t.bold(this.paint("accent", RANGE_LABEL[r])) : this.paint("dim", RANGE_LABEL[r]),
		).join(this.paint("dim", " · "));
		return `${ranges}    ${this.paint("muted", "filter:")} ${t.bold(sanitize(filterLabel(this.filter)))}`;
	}

	private help(hint = ""): string {
		const keys = this.paint("dim", "tab tabs · r dates · m/M filter · ↑↓ scroll · q close");
		return hint ? `${this.paint("muted", hint)}  ${keys}` : keys;
	}

	private scoped(): { all: Call[]; ranged: Call[] } {
		const all = this.o.calls.filter((c) => matches(this.filter, c) && inRange("all", this.today, c.ms, this.now));
		return { all, ranged: all.filter((c) => inRange(this.range, this.today, c.ms, this.now)) };
	}

	private overviewBody(width: number, room: number): string[] {
		const { all, ranged } = this.scoped();
		const t = this.o.theme;
		const out: string[] = [];
		const daily = dailyTotals(all);
		if (!isHourly(this.range))
			out.push(
				...heatmap(daily, this.today, contentWidth(width), (color, text) =>
					color === "heat" ? this.paint("accent", text) : this.paint(color === "empty" ? "dim" : "muted", text),
				),
			);
		out.push("", this.selectors(), "");
		if (ranged.length === 0) {
			out.push(this.paint("muted", "No usage in this range."));
			return out;
		}
		const ov = overview(ranged, this.o.sessions, this.range, this.today, daily.keys());
		const v = (s: string) => this.paint("accent", s);
		const pairs: [string, string][] = [
			[
				`Favorite model: ${t.bold(v(ov.favorite ?? "-"))}`,
				`Total tokens: ${v(formatTokens(ov.totalTokens))} ${this.paint("muted", TOKENS_NOTE)}`,
			],
			[`Sessions: ${v(String(ov.sessions))}`, `Longest session: ${v(duration(ov.longestSessionMs))}`],
			[
				`Active days: ${v(String(ov.activeDays))}${this.paint("muted", `/${ov.rangeDays}`)}`,
				`Longest streak: ${t.bold(v(String(ov.longestStreak)))} ${ov.longestStreak === 1 ? "day" : "days"}`,
			],
			[
				`Most active day: ${v(ov.mostActiveDay ? shortDate(ov.mostActiveDay) : "-")}`,
				`Current streak: ${t.bold(v(String(ov.currentStreak)))} ${ov.currentStreak === 1 ? "day" : "days"}`,
			],
			[
				`Cache tokens: ${v(formatTokens(ov.cacheRead))} read · ${v(formatTokens(ov.cacheWrite))} write`,
				`Notional cost: ${v(money(ov.cost))}`,
			],
		];
		const col = Math.max(36, Math.min(48, Math.floor(width / 2)));
		const twoCol = width >= col * 2;
		for (const [left, right] of pairs) {
			if (twoCol) out.push(`${left}${" ".repeat(Math.max(2, col - visibleWidth(left)))}${right}`);
			else out.push(left, right);
		}
		// Grow the chart into whatever the pane has left, in whole tick steps.
		const smallest = this.chart(ranged, width, TICKS).lines;
		const height = chartHeight(room - out.length - 1 - smallest.length + TICKS);
		out.push("", ...(height === TICKS ? smallest : this.chart(ranged, width, height).lines));
		return out;
	}

	/**
	 * "Tokens per <bucket>", x-axis, peak/average caption and legend. One line per provider under
	 * the "all" filter, else one per model; top three.
	 */
	private chart(
		ranged: readonly Call[],
		width: number,
		height: number,
	): { lines: string[]; colors: Map<string, number> } {
		const t = this.o.theme;
		const out: string[] = [];
		const { by, keys: top } = chartSeries(this.filter, ranged, SERIES);
		const colors = new Map(top.map((k, i): [string, number] => [k.key, i]));
		if (isHourly(this.range)) {
			const series = hourlySeries(ranged, this.range, this.now, by === "provider" ? (c) => c.provider : modelName);
			const plotWidth = Math.max(MIN_PLOT_WIDTH, contentWidth(width) - GUTTER);
			const p = plot(
				top.map((k, i) => ({ values: series.map((s) => s.byKey.get(k.key) ?? 0), color: i })),
				{
					width: plotWidth,
					height,
					paint: (color, text) =>
						color === "axis" ? this.paint("muted", text) : this.paintSeries(color, top.length, text),
				},
			);
			out.push(t.bold("Tokens per hour") + this.paint("muted", `  ${TOKENS_NOTE} · by ${by}`), ...p.lines);
			out.push(this.paint("muted", `From: ${series[0]?.day}`), this.paint("muted", `To:   ${series.at(-1)?.day}`));
			// Repeated wall-clock hours get an explicit offset-bearing label, even between axis edges.
			const labels = new Map<string, string>();
			for (const point of series) {
				const local = point.day.split(" UTC")[0] ?? point.day;
				const prior = labels.get(local);
				if (prior)
					out.push(this.paint("muted", `Repeated hour: ${prior}`), this.paint("muted", `               ${point.day}`));
				labels.set(local, point.day);
			}
			const peak = Math.max(0, ...series.map((s) => s.total));
			const avg = series.reduce((n, s) => n + s.total, 0) / series.length;
			out.push(
				this.paint("muted", `total: peak ${formatTokens(peak)}/hour · avg ${formatTokens(avg)}/bucket · partial edges`),
			);
			out.push(
				...this.legend(
					top.map((k) => k.key),
					colors,
					width - 1,
				),
			);
			return { lines: out, colors };
		}
		const from = rangeStart(this.range, this.today) ?? dayKey(ranged[0]?.ms ?? Date.now());
		const series = dailySeries(ranged, from, this.today, by === "provider" ? (c) => c.provider : modelName);
		const byDay = new Map(series.map((p) => [p.day, top.map((k) => p.byKey.get(k.key) ?? 0)]));
		// Same total width as the heatmap above it: its day labels + weeks == the y gutter + plot.
		const plotWidth = Math.max(MIN_PLOT_WIDTH, DAY_LABEL_WIDTH + weeksFor(contentWidth(width)) - GUTTER);
		const bucketed = bucketize(from, this.today, (d) => byDay.get(d) ?? [], top.length, plotWidth + 1);
		out.push(t.bold(`Tokens per ${bucketed.unit}`) + this.paint("muted", `  ${TOKENS_NOTE} · by ${by}`));
		if (series.length < 2) {
			out.push(this.paint("muted", "Not enough data for a chart yet"));
		} else {
			const p = plot(
				top.map((k, i) => ({
					values: bucketed.buckets.map((b) => b.values[i] ?? 0),
					color: colors.get(k.key) ?? 0,
				})),
				{
					width: plotWidth,
					height,
					paint: (color, text) =>
						color === "axis" ? this.paint("muted", text) : this.paintSeries(color, top.length, text),
				},
			);
			out.push(...p.lines, this.paint("muted", xAxis(bucketed.buckets, plotWidth, p.gutter)));
			let peak = series[0];
			for (const point of series) if (point.total > (peak?.total ?? 0)) peak = point;
			const avg = series.reduce((n, point) => n + point.total, 0) / series.length;
			out.push(
				this.paint(
					"muted",
					`total: peak ${formatTokens(peak?.total ?? 0)} on ${shortDate(peak?.day ?? this.today)} · avg ${formatTokens(avg)}/day`,
				),
			);
		}
		out.push(
			...this.legend(
				top.map((k) => k.key),
				colors,
				width - 1,
			),
		);
		return { lines: out, colors };
	}

	/** `● a · ● b · ● c`, wrapped onto more lines rather than cutting a series name off. */
	private legend(keys: readonly string[], colors: ReadonlyMap<string, number>, width: number): string[] {
		const sepText = " · ";
		const lines: string[] = [];
		let line = "";
		let used = 0;
		for (const key of keys) {
			const cell = `${this.paintSeries(colors.get(key) ?? 0, colors.size, "●")} ${sanitize(key)}`;
			const cellWidth = 2 + visibleWidth(sanitize(key));
			if (used > 0 && used + sepText.length + cellWidth > width) {
				lines.push(line);
				line = "";
				used = 0;
			}
			line += used > 0 ? `${this.paint("dim", sepText)}${cell}` : cell;
			used += (used > 0 ? sepText.length : 0) + cellWidth;
		}
		if (line) lines.push(line);
		return lines;
	}

	/**
	 * Chart, range line and the model list, scrolled as one body like Overview so even a short pane
	 * reaches every model. `owners[i]` holds the list positions of the models drawn on line `i`.
	 */
	private modelsBody(width: number, room: number): { lines: string[]; owners: number[][]; count: number } {
		const { ranged } = this.scoped();
		const totals = modelTotals(ranged);
		if (totals.length === 0) {
			const lines = [this.selectors(), "", this.paint("muted", "No usage in this range.")];
			return { lines, owners: lines.map(() => []), count: 0 };
		}
		// The list scrolls under the chart, so the chart gets about half the pane.
		const chart = this.chart(ranged, width, chartHeight(Math.floor(room / 2) - 5));
		const head = [...chart.lines, "", this.selectors(), ""];
		const list = this.listRows(totals, width, chart.colors);
		return {
			lines: [...head, ...list.flatMap((row) => row.lines)],
			owners: [...head.map(() => []), ...list.flatMap((row) => row.lines.map(() => row.models))],
			count: totals.length,
		};
	}

	/**
	 * Provider headers, then that provider's models: two per row when the pane is `TWO_COLUMN_WIDTH`
	 * or wider, else one. Rows are indented two columns inside the overlay's one-column margin.
	 */
	private listRows(totals: readonly ModelTotals[], width: number, colors: ReadonlyMap<string, number>): ListRow[] {
		const t = this.o.theme;
		const grand = totals.reduce((n, m) => n + tokensOf(m), 0);
		const twoUp = width >= TWO_COLUMN_WIDTH;
		const inner = Math.max(1, width - 3);
		const colWidth = twoUp ? Math.floor(inner / 2) : inner;
		const bullet = (key: string) => {
			const index = colors.get(key);
			return index === undefined ? this.paint("muted", "•") : this.paintSeries(index, colors.size, "•");
		};
		const entry = (m: ModelTotals): string[] => [
			`${bullet(m.name)} ${t.bold(sanitize(m.model))} ${this.paint("muted", `(${percent(tokensOf(m), grand)})`)}`,
			this.paint("muted", `  In: ${formatTokens(m.input)} · Out: ${formatTokens(m.output)}`),
			this.paint(
				"muted",
				`  Cache: ${formatTokens(m.cacheRead)} read · ${formatTokens(m.cacheWrite)} write · ${money(m.cost)} notional`,
			),
		];
		const rows: ListRow[] = [];
		let position = 0;
		for (const provider of [...new Set(totals.map((m) => m.provider))]) {
			const models = totals.filter((m) => m.provider === provider).map((m) => ({ m, i: position++ }));
			const sum = models.reduce((n, { m }) => n + tokensOf(m), 0);
			rows.push({
				lines: [
					`${bullet(provider)} ${t.bold(sanitize(provider))}  ${formatTokens(sum)} ${this.paint("muted", `(${percent(sum, grand)})`)}`,
				],
				models: [],
			});
			const per = twoUp ? 2 : 1;
			for (let k = 0; k < models.length; k += per) {
				const group = models.slice(k, k + per);
				const blocks = group.map(({ m }) => entry(m));
				const lines = [0, 1, 2].map((line) =>
					blocks
						.map((b, col) => {
							const cell = truncateToWidth(
								b[line] ?? "",
								Math.max(1, colWidth - (col < blocks.length - 1 ? 2 : 0)),
								"…",
							);
							return col < blocks.length - 1 ? cell + " ".repeat(Math.max(0, colWidth - visibleWidth(cell))) : cell;
						})
						.join(""),
				);
				rows.push({ lines: lines.map((l) => `  ${l}`), models: group.map(({ i }) => i) });
			}
		}
		return rows;
	}
}

/** Plain-text per-model table for print/json/rpc modes, all time. */
export function summary(calls: readonly Call[]): string {
	const totals = modelTotals(calls);
	if (totals.length === 0) return "/stats: no usage recorded yet";
	const grand = totals.reduce((n, m) => n + tokensOf(m), 0);
	const head = ["provider", "model", "in", "out", "cache read", "cache write", "cost", "%"];
	const body = totals.map((m) => [
		sanitize(m.provider),
		sanitize(m.model),
		formatTokens(m.input),
		formatTokens(m.output),
		formatTokens(m.cacheRead),
		formatTokens(m.cacheWrite),
		money(m.cost),
		percent(tokensOf(m), grand),
	]);
	const widths = head.map((h, c) => Math.max(h.length, ...body.map((r) => (r[c] ?? "").length)));
	const fmt = (r: string[]) =>
		r
			.map((cell, c) => (c < 2 ? cell.padEnd(widths[c] ?? 0) : cell.padStart(widths[c] ?? 0)))
			.join("  ")
			.trimEnd();
	return [`/stats: ${formatTokens(grand)} tokens ${TOKENS_NOTE}, all time`, fmt(head), ...body.map(fmt)].join("\n");
}
